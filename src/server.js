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
import { refreshEngineModels } from "./engines/registry.js";
import { applySettingsToEnv, resolveSlackConfig, hasSlackConfig, getAdminPassword, getSettings, saveSettings, getContainerRuntime } from "./config/settings.js";
import { getBindHost, hashPassword } from "./web/security.js";
import { createSlackManager } from "./slack/manager.js";
import { createPlatformTransports, connectConfiguredPlatforms } from "./platforms/boot.js";
import { startScheduler } from "./gateway/scheduler.js";
import { BackgroundJobs, setActiveBackgroundJobs } from "./gateway/background.js";
import { requestApproval, setDurableApprovalExecutor } from "./slack/approvals.js";
import { executeInstructionApproval, INSTRUCTION_ACTION } from "./gateway/instruction-approvals.js";
import { startMcpSocketServer, stopMcpSocketServer, mcpSocketStatus } from "./mcp/socket-server.js";
import { pruneTerminalApprovalRequests, recoverInterruptedApprovalExecutions } from "./gateway/approval-requests.js";
import { pruneApprovalLinkTokens } from "./gateway/approval-link-tokens.js";
import { takeStaleRuns, createRunRecovery } from "./gateway/active-runs.js";
import { recoverApiRuns } from "./gateway/api-runs.js";
import { startNudgeSweep } from "./gateway/nudges.js";
import { startClaudeLoginWatch } from "./gateway/login-watch.js";
import { startFollowupDigest } from "./gateway/followups.js";
import { startDriveSync } from "./gateway/drivesync.js";
import { configDir } from "./config/paths.js";
import { hardenRuntimeFiles, ensureAdminPasswordOnFirstBoot, isOperatorConfigured, assertRuntimeHardening } from "./config/harden.js";
import { acquireSingletonLock } from "./util/singleton.js";
import { requestShutdown } from "./gateway/shutdown.js";
import { RestartCoordinator } from "./gateway/restart.js";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const slack = createSlackManager();
// Google Chat + Teams. Created at module scope alongside Slack so the managers exist (and are
// registered as the platforms' live-connector source) before anything can ask for a connector.
const transports = createPlatformTransports();

// A long-running gateway must survive a bad integration (e.g. an invalid Slack token producing
// an async error). Log and keep running rather than exiting on these.
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err?.message || err);
});

// The container backend is loaded lazily so a load failure is reported with its cause instead of
// exploding the import graph at boot; the boot then stops, because there is no other runtime.
async function containerRuntimeModule() {
  try {
    return await import("./runtimes/container/index.js");
  } catch (e) {
    return { __loadError: e?.message || String(e) };
  }
}
const CONTAINER_REMEDY = "install rootless Podman (docs/OPERATIONS.md → Container runtime) and restart the gateway";
async function bootContainerRuntimeOrDie() {
  const mod = await containerRuntimeModule();
  if (typeof mod.bootContainerRuntime !== "function") {
    console.error(`[gateway] FATAL: the container runtime backend did not load — ${mod.__loadError || "not available in this build"}; ${CONTAINER_REMEDY}`);
    process.exit(1);
  }
  let status;
  try {
    status = await mod.bootContainerRuntime({ settings: getContainerRuntime(), log: (m) => console.log(m) });
  } catch (e) {
    console.error(`[gateway] FATAL: container runtime boot failed — ${e?.message || e}; ${CONTAINER_REMEDY}`);
    process.exit(1);
  }
  if (!status?.cli?.ok) {
    console.error(`[gateway] FATAL: no usable container CLI — ${status?.cli?.reason || "unknown"}; ${CONTAINER_REMEDY}`);
    process.exit(1);
  }
}
// What /api/health reports. Always answers, even when the backend never loaded, so the admin UI can
// say WHY container channels are not running rather than showing an empty card. `socket` is the
// gateway control socket: a container without it would run with no gateway tools at all.
async function containerRuntimeHealth() {
  const settings = getContainerRuntime();
  const base = { socket: mcpSocketStatus() };
  const unavailable = (reason) => ({ ...base, cli: { ok: false, reason }, image: { ref: settings.image, present: false, reason: "" }, running: 0, containers: [] });
  const mod = await containerRuntimeModule();
  if (typeof mod.containerRuntimeStatus !== "function") return unavailable(mod.__loadError || "container runtime backend is not available in this build");
  try {
    return { ...base, ...(await mod.containerRuntimeStatus(settings)) };
  } catch (e) {
    return unavailable(e?.message || String(e));
  }
}
// The Claude login expiry watch (src/gateway/login-watch.js). Held at module scope so shutdown can
// stop its timers alongside the other runtime services.
let claudeLoginWatch = null;

async function stopRuntimeServices(reason) {
  try {
    claudeLoginWatch?.stop();
  } catch {
    /* best effort */
  }
  claudeLoginWatch = null;
  try {
    await stopMcpSocketServer();
  } catch {
    /* best effort */
  }
  try {
    const mod = await containerRuntimeModule();
    await mod.stopContainerRuntime?.({ reason });
  } catch {
    /* best effort */
  }
}

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
  pruneApprovalLinkTokens(); // spent/expired approval-link nonces
  applySettingsToEnv(); // UI-managed settings.json overrides .env
  // Skills platform (src/gateway/skills): fill the local catalog from the bundled starter library
  // and the host's skill folders, and seed the built-in channel templates. Never fatal — a turn
  // runs without a catalog exactly as it did before, on host-folder copies.
  const { bootSkillsPlatform, startSkillsSync } = await import("./gateway/skills/index.js");
  await bootSkillsPlatform({ log: (m) => console.log(m) }).catch((e) => console.error("[skills] catalog boot failed (continuing):", e?.message || e));
  // Every boot: 0700 the runtime root and 0600 the credential files (settings.json, users.json,
  // gateway.db + its WAL). They predate this hardening on existing installs, so chmod rather than
  // relying on create-time modes.
  const { failed: hardenFailed } = hardenRuntimeFiles();
  assertRuntimeHardening({ failed: hardenFailed });

  // Brand-new install (nothing an operator wrote in settings.json — the installer's own
  // pre-boot keys don't count) → mint an admin password rather than leaving the whole API open.
  // Printed once here because it is stored hashed and can't be read back. An existing install is
  // never touched: generating one there would lock the operator out.
  const generated = await ensureAdminPasswordOnFirstBoot({
    configured: isOperatorConfigured(getSettings()),
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
    // WHICH login answers this harness's turns. For Claude that is normally the host user's own
    // `claude` sign-in (src/gateway/claude-login.js), and its session dies every few weeks — so the
    // source and that date are said out loud at boot, and warned about three days ahead.
    if (check.auth?.login?.summary) console.log(`[gateway] ${id} login: ${check.auth.login.summary}`);
    if (check.auth?.expiring) console.warn(`[gateway] WARNING: ${check.auth.expiring}`);
  }
  // Prime the shared picker/admin catalog from each harness before chat connects. Discovery is
  // best-effort and self-contained: an unavailable/old CLI leaves the bundled fallback intact.
  await refreshEngineModels();
  // Container backend — the only runtime: probe the CLI, reconcile containers left by the previous
  // daemon, start the idle reaper. A host with no usable container CLI cannot run a single turn,
  // so the boot stops here with the remedy instead of coming up as a daemon that answers every
  // message with an error.
  await bootContainerRuntimeOrDie();

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

  // The gateway control MCP over a unix socket (src/mcp/socket-server.js). A containerized run has
  // no database, no config dir and no route to 127.0.0.1:<port>, so the daemon serves the control
  // plane itself and calls these handlers DIRECTLY — which is why CG_APPROVAL_SECRET and CG_PORT
  // never have to cross into a container. Started here, beside internal-auth.json, because the two
  // are the same decision made for the two transports. The handler bag is filled in a few lines
  // below (a container cannot connect before its first run, long after boot).
  const daemonHandlers = {};
  await startMcpSocketServer({ handlers: daemonHandlers, log: console });

  // Daemon-owned background jobs: the run_in_background MCP tool hands long shell work here; on
  // completion we re-inject a turn into the originating thread so the agent continues on its own.
  // Shell jobs run inside the channel's container with no engine permission gate in front of the
  // command. Auto mode requires an independent admin click; Admin mode may start them directly
  // only for the admin author who already holds the permission bypass.
  const backgroundJobs = new BackgroundJobs({ slack, requestShellApproval: (req) => requestApproval(slack, req) });
  // The HTTP listener below opens long before recover() runs. Hold new starts until the persisted
  // job rows have been re-tracked, or the first API/approval-triggered job would rewrite bg_jobs
  // from a still-empty map and wipe every unrecovered row.
  backgroundJobs.armRecovery();
  setDurableApprovalExecutor((record) => record.action?.kind === INSTRUCTION_ACTION
    ? executeInstructionApproval(record)
    : backgroundJobs.startApproved(record));
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
  Object.assign(daemonHandlers, {
    background: (body) => backgroundJobs.start(body),
    approval: (body) => requestApproval(slack, body),
    restart: (body) => restartCoordinator.request(body),
  });
  const app = createWebApp({ slack, transports, backgroundJobs, restartCoordinator, containerRuntimeStatus: containerRuntimeHealth });
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
  const runRecovery = createRunRecovery(staleRuns, { slack });

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

  // The other surfaces, on the same terms: connect what is configured, and never let a bad
  // credential stop the daemon from coming up.
  await connectConfiguredPlatforms(transports).catch((e) => console.error("[gateway] platform connect failed:", e?.message || e));

  // Recover background jobs that were in-flight when the daemon last stopped: re-attach to ones
  // still running, or post an "interrupted by restart" continuation for ones that already exited.
  await backgroundJobs.recover().catch((e) => console.error("[gateway] bg recover failed:", e?.message || e));

  // Auto re-run interactive Slack turns that were interrupted mid-flight by the restart — resumes
  // the same thread/session and posts the answer. Runs after Slack is connected so it can post.
  if (staleRuns.length) console.log(`[gateway] recovering ${staleRuns.length} interrupted turn(s)…`);
  await runRecovery.start().catch((e) => console.error("[gateway] run recover failed:", e?.message || e));

  // Auto re-run API jobs that were queued/running when the daemon restarted. Slack-backed API jobs
  // resume in their original thread; headless jobs resume silently and finish through status/webhook.
  await recoverApiRuns({ slack }).catch((e) => console.error("[gateway] API run recover failed:", e?.message || e));

  // Cron scheduler: fires saved per-channel jobs (posts results to the channel via Slack).
  startScheduler({ slack });

  // Git skill sources: periodic sync (settings: skillsSyncIntervalMinutes; 0 = off).
  startSkillsSync({ log: (m) => console.log(m) });

  // Opt-in no-response thread nudges (per-channel meta.nudges).
  startNudgeSweep({ slack });

  // Hourly watch on the Claude login the gateway authenticates with: it hard-expires every few
  // weeks and only a new interactive `claude` sign-in moves the date, so the three-day warning has
  // to reach an admin in Slack instead of waiting for the next boot log.
  claudeLoginWatch = startClaudeLoginWatch({ slack });

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
    // Release the runtime services first: unlink the control socket (and drop any container
    // connections still holding it open) and stop the container reaper's timers. Both are fast and
    // best-effort — deliberately NOT awaited, so they can never delay or block the real drain.
    void stopRuntimeServices(sig);
    requestShutdown({ slack, code: 0, reason: sig });
  });
}

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
