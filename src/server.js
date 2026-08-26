// Entry point. Boots the gateway: load env, ensure the runtime root, start the admin web
// server, and (if Slack tokens are present) start the Socket Mode gateway. Built up across
// slices — Slice 1 wires the root + web server; Slack is wired in Slice 4.

// Refuse to boot below the node:sqlite floor. The AUTHORITATIVE gate lives in src/start.js
// (the real entry point): ESM hoisting evaluates this module's static imports before this
// statement, so on a runtime without node:sqlite (< 22.5) the import graph explodes before this
// check can run. It stays here as a second line for direct `node src/server.js` invocations on
// 22.5–22.12, where the imports load but db/index.js suppresses the sqlite Experimental warning
// — silently-running-anyway would be extra misleading there.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`ChannelGate requires Node >= 22.13 (node:sqlite); running on ${process.versions.node}. Upgrade Node and restart.`);
  process.exit(1);
}

import { ensureRoot } from "./config/store.js";
import { createWebApp } from "./web/app.js";
import { getEngineHealth } from "./engines/engine-health.js";
import { assessLinuxUserns } from "./engines/linux-userns.js";
import { applySettingsToEnv, resolveSlackConfig, hasSlackConfig, getAdminPassword, saveSettings } from "./config/settings.js";
import { getBindHost, hashPassword } from "./web/security.js";
import { createSlackManager } from "./slack/manager.js";
import { startScheduler } from "./gateway/scheduler.js";
import { BackgroundJobs, setActiveBackgroundJobs } from "./gateway/background.js";
import { requestApproval, setDurableApprovalExecutor } from "./slack/approvals.js";
import { pruneTerminalApprovalRequests, recoverInterruptedApprovalExecutions } from "./gateway/approval-requests.js";
import { takeStaleRuns, recoverRuns } from "./gateway/active-runs.js";
import { recoverApiRuns } from "./gateway/api-runs.js";
import { startNudgeSweep } from "./gateway/nudges.js";
import { startFollowupDigest } from "./gateway/followups.js";
import { startDriveSync } from "./gateway/drivesync.js";
import { configDir, settingsFile } from "./config/paths.js";
import { hardenRuntimeFiles, ensureAdminPasswordOnFirstBoot, assertRuntimeHardening } from "./config/harden.js";
import { acquireSingletonLock } from "./util/singleton.js";
import { requestShutdown } from "./gateway/shutdown.js";
import { RestartCoordinator } from "./gateway/restart.js";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { installConsoleRedaction } from "./util/redact.js";
import { autoRepairCodexUsageHistory } from "./gateway/usage-repair.js";
import { postNotice } from "./platforms/notify.js";
import { startLicenseVerification } from "./ee/license.js";
import { startUsageReporting } from "./ee/limits.js";

installConsoleRedaction();

// Load .env without a dependency (Node ≥ 20.6). Missing file is fine.
try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the ambient environment */
}

// Per-process secret for the /internal/approval IPC (the gateway MCP server presents it).
// Permission approvals can wait for a human, so raise the MCP tool timeout (Claude treats a hung
// permission tool as deny) above the approval window.
process.env.CG_APPROVAL_SECRET ||= randomUUID();
process.env.MCP_TOOL_TIMEOUT ||= "300000";
process.env.MCP_TIMEOUT ||= "30000";

const slack = createSlackManager();

// A long-running gateway must survive a bad integration (e.g. an invalid Slack token producing
// an async error). Log and keep running rather than exiting on these.
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err?.message || err);
});

async function main() {
  // The ChannelGate rename migration runs FIRST — before ensureRoot() opens the database and long
  // before Slack connects — because it may move the runtime root that every path below resolves
  // against. It never throws: a refusal or a failure pins the process back onto the pre-rename
  // roots and the daemon serves from there (see scripts/migrate-channelgate.mjs).
  const { migrateChannelGateAtBoot } = await import("../scripts/migrate-channelgate.mjs");
  await migrateChannelGateAtBoot();

  const root = await ensureRoot();
  const lock = acquireSingletonLock(root);
  pruneTerminalApprovalRequests();
  applySettingsToEnv(); // UI-managed settings.json overrides .env
  // Every boot: 0700 the runtime root and 0600 the credential files (settings.json, users.json,
  // gateway.db + its WAL). They predate this hardening on existing installs, so chmod rather than
  // relying on create-time modes.
  const { failed: hardenFailed } = hardenRuntimeFiles();
  assertRuntimeHardening({ failed: hardenFailed });

  // Brand-new install (no settings file at all) → mint an admin password rather than leaving the
  // whole API open. Printed once here because it is stored hashed and can't be read back. An
  // existing install is never touched: generating one there would lock the operator out.
  const generated = await ensureAdminPasswordOnFirstBoot({
    settingsExist: existsSync(settingsFile()),
    hasPassword: Boolean(getAdminPassword()),
    generate: () => randomBytes(12).toString("base64url"),
    save: async (pw) => saveSettings({ adminPassword: await hashPassword(pw) }),
  });
  if (generated) {
    console.log("\n[gateway] ─── first boot ────────────────────────────────────────────");
    console.log(`[gateway] Admin password generated: ${generated}`);
    console.log("[gateway] Save it now — it is stored hashed and cannot be shown again.");
    console.log("[gateway] Change it any time in the admin UI under Settings.");
    console.log("[gateway] ────────────────────────────────────────────────────────────\n");
  }
  console.log(`[gateway] runtime root: ${root}`);
  console.log(`[gateway] singleton lock: ${lock.file}`);

  const engineHealth = await getEngineHealth();
  for (const [id, check] of Object.entries(engineHealth)) {
    if (check.available) console.log(`[gateway] ${id} CLI: ${check.version}`);
    else console.warn(`[gateway] WARNING: ${id} CLI not available — ${check.reason}`);
    // An installed-but-signed-out CLI passes the version probe and then fails (or stalls) on every
    // turn. Say it at boot, where an operator can act on it, instead of leaving it to be inferred
    // from turns that quietly fail over to the other harness.
    if (check.available && check.auth?.known && !check.auth.authenticated) {
      console.warn(`[gateway] WARNING: ${id} CLI is not signed in — ${check.auth.detail}`);
    }
  }
  // Ubuntu's AppArmor userns restriction kills every sandboxed Bash call while Read/MCP keep
  // working, and the only symptom is inside the model's turn. Name it here, next to the engine
  // warnings, with the remedy (scripts/apparmor/) — see src/engines/linux-userns.js.
  const userns = assessLinuxUserns();
  if (userns.applies && userns.broken) console.warn(`[gateway] WARNING: ${userns.reason} — ${userns.hint}`);

  const PORT = Number(process.env.PORT ?? 4747);
  // Bind loopback by default — the admin surface can flip users to admin and point channel
  // folders anywhere, so LAN exposure must be a deliberate act: set CG_BIND_HOST (or `bindHost`
  // in settings.json) to "0.0.0.0". The bind is defence in depth only: without an admin password
  // the privileged API is refused on EVERY bind, loopback included, because that is also what a
  // reverse proxy or tunnel looks like (see noPasswordLockdown in src/web/auth.js).
  const HOST = getBindHost();
  // The gateway MCP server child needs the secret + daemon port for its /internal IPC calls. On the
  // Claude path they ride the --mcp-config env; on the Codex path config crosses via argv-visible
  // `-c` overrides where a secret must never appear — so persist both to a 0600 file the MCP server
  // falls back to (env wins there when present). Rewritten every boot (the secret is per-process);
  // unlink first because writeFileSync's `mode` only applies when it CREATES the file.
  try {
    const authFile = path.join(configDir(), "internal-auth.json");
    mkdirSync(configDir(), { recursive: true });
    rmSync(authFile, { force: true });
    writeFileSync(authFile, JSON.stringify({ port: PORT, secret: process.env.CG_APPROVAL_SECRET }) + "\n", { mode: 0o600 });
  } catch (e) {
    console.warn(`[gateway] couldn't write internal-auth.json — Codex-path background jobs/approvals may be unavailable: ${e.message}`);
  }

  // Daemon-owned background jobs: the run_in_background MCP tool hands long shell work here; on
  // completion we re-inject a turn into the originating thread so the agent continues on its own.
  // Shell jobs run unsandboxed on the daemon. Auto mode requires an independent admin click;
  // Admin mode may start them directly only for the admin author who already has sandbox-off.
  const backgroundJobs = new BackgroundJobs({ slack, requestShellApproval: (req) => requestApproval(slack, req) });
  // The HTTP listener below opens long before recover() runs. Hold new starts until the persisted
  // job rows have been re-tracked, or the first API/approval-triggered job would rewrite bg_jobs
  // from a still-empty map and wipe every unrecovered row.
  backgroundJobs.armRecovery();
  setDurableApprovalExecutor((record) => backgroundJobs.startApproved(record));
  const recoveredApprovals = recoverInterruptedApprovalExecutions();
  if (recoveredApprovals.consumed || recoveredApprovals.failed) {
    console.log(`[gateway] recovered durable approvals: ${recoveredApprovals.consumed} already started, ${recoveredApprovals.failed} failed closed`);
  }
  setActiveBackgroundJobs(backgroundJobs); // expose to the Slack /status command
  const restartCoordinator = new RestartCoordinator({
    restart: ({ reason }) => requestShutdown({ slack, code: 0, reason }),
    notify: async ({ channelId, threadKey, text }) => {
      if (!channelId || !threadKey || !slack.snapshot?.().connected) return;
      await postNotice(slack.getClient?.(), { conversationId: channelId, threadKey, text });
    },
  });
  const app = createWebApp({ slack, backgroundJobs, restartCoordinator });
  const server = app.listen(PORT, HOST);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`[gateway] admin + health on http://${shown}:${PORT} (bound to ${HOST})`);
  // Not a bind-shape warning any more: the lockdown refuses the privileged API on every bind
  // without a password, so this says the admin surface is simply unusable until one exists.
  if (!getAdminPassword())
    console.warn("[gateway] WARNING: no admin password — every privileged admin route is refused until ADMIN_PASSWORD (or settings adminPassword) is set.");

  // Snapshot any interactive turns that were mid-run when the daemon last stopped, BEFORE Slack
  // reconnects — any active_runs row present now belongs to the previous instance (only one gateway
  // binds the port), so it was interrupted. Taking it up front means turns started by messages
  // arriving after reconnect get fresh rows and aren't mistaken for stale ones.
  const staleRuns = takeStaleRuns();

  // License verification (src/ee/license.js). Deliberately started here and NOT awaited: the
  // ChannelGate platform is a remote HTTP service and the daemon must come up whether or not it
  // answers. The run gate reads the CACHED state until this lands, and "never verified yet" is the
  // grace state, not a lockout. Usage reporting is counts-only and equally fire-and-forget.
  startLicenseVerification();
  startUsageReporting();

  // Connect Slack if tokens are configured (settings.json or .env). Can also be (re)connected
  // at runtime from the admin Settings page.
  if (hasSlackConfig()) await slack.connect(resolveSlackConfig());
  else console.log("[gateway] Slack tokens not set — set them in the admin Settings page (admin UI still available).");

  // Recover background jobs that were in-flight when the daemon last stopped: re-attach to ones
  // still running, or post an "interrupted by restart" continuation for ones that already exited.
  await backgroundJobs.recover().catch((e) => console.error("[gateway] bg recover failed:", e?.message || e));

  // Auto re-run interactive Slack turns that were interrupted mid-flight by the restart — resumes
  // the same thread/session and posts the answer. Runs after Slack is connected so it can post.
  if (staleRuns.length) console.log(`[gateway] recovering ${staleRuns.length} interrupted turn(s)…`);
  await recoverRuns(staleRuns, { slack }).catch((e) => console.error("[gateway] run recover failed:", e?.message || e));

  // Auto re-run API jobs that were queued/running when the daemon restarted. Slack-backed API jobs
  // resume in their original thread; headless jobs resume silently and finish through status/webhook.
  await recoverApiRuns({ slack }).catch((e) => console.error("[gateway] API run recover failed:", e?.message || e));

  // Cron scheduler: fires saved per-channel jobs (posts results to the channel via Slack).
  startScheduler({ slack });

  // Opt-in no-response thread nudges (per-channel meta.nudges).
  startNudgeSweep({ slack });

  // Personal pending-response follow-up digests (DM each approved user at 08:00 & 14:00).
  startFollowupDigest({ slack });

  // Scheduled two-way Google Drive ↔ channel-folder sync (dormant unless enabled + configured).
  startDriveSync();

  // One-shot Codex usage-history repair. After an update introduces accounting schema v10 (which
  // marks pre-existing codex rows legacy-unverified), reconstruct per-turn + subagent usage from
  // surviving rollouts — the same idempotent path as `npm run usage:repair -- --apply`, with a DB
  // backup first. Fire-and-forget: rollout scanning can take a while and must not delay Slack.
  // Records a batch even when nothing matches, so later boots see nothing pending and skip.
  autoRepairCodexUsageHistory()
    .then((r) => { if (!r.applied) return; console.log(`[gateway] usage history auto-repair done (batch ${r.batchId})`); })
    .catch((e) => console.error("[gateway] usage auto-repair failed:", e?.message || e));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    requestShutdown({ slack, code: 0, reason: sig });
  });
}

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
