// Gateway control MCP server. Injected into every gated run, scoped to the current principal by a
// daemon-signed, expiring capability. Exposes scheduling tools (anyone allowed in the channel) and
// channel-admin tools to manage the channel's MCP allowlist (admins only). Tool registrations live
// in ./tools/* — one module per group, each exporting register(server, ctx).
//
// TWO ENTRIES, ONE SERVER (v0.8). `createGatewayMcpServer(ctx)` is the shared factory:
//   • host backend — this file run as a stdio CHILD of the engine (the entry at the bottom). It
//     builds its ctx from the environment exactly as before (CG_GATEWAY_CAPABILITY, CG_ENGINE,
//     CG_TOOLSET, CG_PROGRESS_REPORT) and talks to the daemon over 127.0.0.1/internal/* with the
//     shared secret. Wire format unchanged.
//   • container backend — the daemon itself serves one instance per connection on its unix socket
//     (src/mcp/socket-server.js). There is no DB, no config dir and no daemon port inside a
//     container, so that path passes the daemon's own handlers in `ctx.daemon` and the identity
//     comes from the bearer alone (ctxFromClaims).
// Everything a tool needs therefore travels in `ctx` — including `ctx.threadKey`, which used to be
// smuggled through `process.env.CG_THREAD_KEY`. A per-connection server cannot own process env.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { canManage } from "../gateway/modes.js";
import { getEngine as getDefaultEngine } from "../config/settings.js";
import { gatewayRoot } from "../config/paths.js";
import { verifyGatewayCapability } from "../gateway/mcp-capability.js";
import { register as registerSchedules } from "./tools/schedules.js";
import { register as registerBackground } from "./tools/background.js";
import { register as registerChannelAdmin, registerMemoryTool } from "./tools/channel-admin.js";
import { register as registerTokens } from "./tools/tokens.js";
import { register as registerSlackNative } from "./tools/slack-native.js";
import { register as registerLicense } from "./tools/license.js";
import { register as registerWorkspaceRead } from "./tools/workspace-read.js";

export const text = (t) => ({ content: [{ type: "text", text: t }] });

// ── Daemon IPC ────────────────────────────────────────────────────────────────────────────────
// Three daemon-side effects a tool can ask for: start background work, ask a human in Slack, queue
// a safe restart. `kind` is also the /internal/<kind> route name, so the two transports stay in
// lockstep. A tool never learns which one it is using.
export const DAEMON_IPC_KINDS = Object.freeze(["background", "approval", "restart"]);

// Daemon-IPC credentials for the CHILD-PROCESS transport (the /internal/* endpoints). The Claude
// path forwards CG_APPROVAL_SECRET/CG_PORT via the --mcp-config env; the Codex path can't — its
// MCP config crosses via argv-visible `-c` overrides where a secret must never ride — so the
// daemon writes both to a 0600 internal-auth.json at boot. Env wins when present; the file is the
// lazy-cached fallback for both values (CHANNELGATE_DIR is forwarded on both engine paths).
let internalAuthCache; // undefined = not read yet; null = missing/unreadable
function internalAuth() {
  if (internalAuthCache === undefined) {
    try {
      internalAuthCache = JSON.parse(readFileSync(path.join(gatewayRoot(), "config", "internal-auth.json"), "utf8"));
    } catch {
      internalAuthCache = null;
    }
  }
  return internalAuthCache || {};
}
export const hostApprovalSecret = () => process.env.CG_APPROVAL_SECRET || String(internalAuth().secret || "");
export const hostApprovalPort = () => process.env.CG_PORT || String(internalAuth().port || "") || "4747";

// Child-process transport: loopback HTTP + the shared secret (today's behaviour, byte for byte).
export function createHttpDaemonIpc({ secret = hostApprovalSecret, port = hostApprovalPort } = {}) {
  return {
    mode: "http",
    available: () => Boolean(secret()),
    async call(kind, body, { timeoutMs = 15_000 } = {}) {
      if (!DAEMON_IPC_KINDS.includes(kind)) throw new Error(`unknown daemon IPC "${kind}"`);
      const res = await fetch(`http://127.0.0.1:${port()}/internal/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cg-secret": secret() },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (await res.json().catch(() => ({}))) || {};
    },
  };
}

// In-process transport: the daemon calls its OWN handlers. No port, no shared secret, no loopback
// check — which is the point: a container must never hold CG_APPROVAL_SECRET or CG_PORT, and
// there is no route for it to reach even if it did.
export function createDirectDaemonIpc(handlers = {}) {
  return {
    mode: "direct",
    available: (kind) => typeof handlers?.[kind] === "function",
    async call(kind, body) {
      if (!DAEMON_IPC_KINDS.includes(kind)) throw new Error(`unknown daemon IPC "${kind}"`);
      if (typeof handlers?.[kind] !== "function") throw new Error(`${kind} is unavailable`);
      return (await handlers[kind](body || {})) || {};
    },
  };
}

// ── The per-run context ───────────────────────────────────────────────────────────────────────
// A4: CG_* identity strings are not authority. The daemon signs the complete run identity and the
// MCP server derives every principal field from that grant. Validation is repeated at the tool-call
// chokepoint so an expired/tampered capability cannot retain a live session.
const ENGINE_CLAIMS = ["claude", "codex"];

// Only the exact "full" value (or no value at all) exposes the whole control plane; anything else
// is the reduced set, so a typo can never widen a helper. The background memory review
// (gateway/memory-review.js) exists only to save what a finished conversation taught, so it gets
// the save tool and nothing else — no schedules, no admin switches, no Slack writes.
export function normalizeToolset(value) {
  return String(value || "full");
}

/**
 * Build the shared tool ctx from VERIFIED capability claims.
 * `engine` / `toolset` / `progressReport` are the reader's own environment values; the signed
 * claim wins whenever it is present, so a bearer alone fixes the tool surface.
 */
export function ctxFromClaims(claims = {}, { engine = "", toolset = "", progressReport = false, daemon = null, verifyCapability = null } = {}) {
  const channelId = claims.channelId || "";
  const slug = claims.slug || "";
  const createdBy = claims.authorId || "";
  const threadKey = claims.threadKey || "";
  const origin = claims.origin || "";
  const principalTrusted = claims.principalTrusted === true;
  const claimedEngine = ENGINE_CLAIMS.includes(claims.engine) ? claims.engine : "";
  const activeEngine = claimedEngine || (ENGINE_CLAIMS.includes(engine) ? engine : getDefaultEngine());

  const loadMeta = async () => (slug ? await getChannelMeta(slug) : null);
  // requireAdmin: gateway admins only — for the DANGEROUS escalations (admin mode, network,
  // work-dir, host browse, gateway update). requireManage: the SAFE settings (MCP allowlist, bash,
  // auto) — an admin OR, when the channel opts in (manageAccess "members"/"custom"), an approved
  // member / listed manager. The author comes only from the verified run capability.
  const requireAdmin = async () => principalTrusted && Boolean(createdBy) && (await isAdmin(createdBy));
  const requireManage = async () => {
    if (!principalTrusted || !createdBy) return false;
    const meta = await loadMeta();
    return canManage(meta || {}, {
      authorId: createdBy,
      isAdminUser: await isAdmin(createdBy),
      isApprovedUser: await isApproved(createdBy),
    });
  };

  return {
    channelId,
    slug,
    createdBy,
    threadKey,
    origin,
    activeEngine,
    principalTrusted,
    // A NON-EMPTY signed toolset wins (only the daemon can mint one, and every value but "full"
    // reduces); a blank/absent one falls back to the reader's own environment, which is how the
    // stdio entry has always learned it. Neither direction can widen: "full" IS the default.
    toolset: normalizeToolset(claims.toolset || toolset),
    // Either source may switch the ack-only report_progress tool ON — the claim (new tokens) or
    // CG_PROGRESS_REPORT (the Codex path, which sets it as an argv-visible `-c` override rather
    // than through the capability). It grants no authority: the handler acknowledges a snapshot
    // the daemon has already validated, and rendering is decided daemon-side either way.
    progressReport: claims.progressReport === true || progressReport === true,
    daemon: daemon || createDirectDaemonIpc({}),
    // Re-checked at every tool call. Defaults to "the claims we were built from are still valid",
    // which is only correct for a caller that has no token to re-verify (tests).
    verifyCapability: verifyCapability || (() => ({ ok: true, claims })),
    text,
    requireAdmin,
    requireManage,
    loadMeta,
  };
}

// ── Control-plane approval gate (the 2026-08 update plan (internal repo) A3) ───────────────────────
// A tool that changes FUTURE privileges or persistent state — channel modes/network/workdir/runtime,
// the MCP allowlist, standing instructions, connector tokens, schedules, updater/guide operations —
// must never run on the model's authority alone: during a legitimately authorized turn, injected
// content can spend the caller's authority. Every tool listed here additionally requires a human
// click in Slack, via the "agent" approval type, which is NEVER auto-approved. Read-only tools and
// writes that land visibly in the current thread (charts, tables, snippets, lists) stay un-gated.
// Channel memory is also deliberately un-gated in every workdir: it is a routine, bounded write to
// MEMORY.md / memory/<topic>.md with its own signed-principal, path, action, and budget checks.
// Schedules (`create_schedule` / `delete_schedule`) are un-gated too — operator decision
// 2026-08-19: "remind me" / "check every hour" is the most ordinary request a Slack channel gets,
// and stalling every one of them on a click made the feature unusable. A schedule cannot escalate
// (it fires with origin "schedule" — A2 — in THIS channel, as its creator, no more often than the
// configured minimum interval), it posts visibly here when it runs, and list_schedules /
// delete_schedule make it inspectable and reversible. Accepted residual risk: injected content can
// create or drop a schedule inside an already-authorized turn.
// `update_gateway` has one explicit operator-selected exception: an admin author may start it
// without the extra click when the channel is already in Auto or Admin mode. `authz` mirrors the
// handler's own check so an unauthorized caller gets the handler refusal instead of an approval
// card (no approval spam). `details(args)` builds the human-readable card; returning null skips the
// gate for that call.
const summarize = (v, n = 200) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const onOff = (v) => (v ? "ON" : "OFF");

export function buildControlPlane({ loadMeta }) {
  return new Map([
    ["set_channel_admin_mode", { authz: "admin", details: ({ enabled }) => `Turn ADMIN MODE (no sandbox, no prompts for admin authors) ${onOff(enabled)} for this channel.` }],
    ["set_channel_network", { authz: "admin", details: ({ enabled }) => `Turn network access ${onOff(enabled)} for this channel.` }],
    ["set_channel_bash", { authz: "manage", details: ({ enabled }) => `Turn shell access (Bash + file edits) ${onOff(enabled)} for this channel.` }],
    ["set_channel_auto_mode", { authz: "manage", details: ({ enabled }) => `Turn AUTO MODE (tools auto-approved) ${onOff(enabled)} for this channel.` }],
    ["set_channel_workdir", { authz: "admin", details: ({ path: p }) => `Point this channel's working folder at: ${summarize(p)}` }],
    ["clear_channel_workdir", { authz: "admin", details: () => "Revert this channel to its default gateway working folder." }],
    ["set_channel_drive_folder", { authz: "admin", details: ({ link }) => `Link a Google Drive folder for two-way sync: ${summarize(link)}` }],
    ["clear_channel_drive_folder", { authz: "admin", details: () => "Unlink this channel's Google Drive sync folder (sync off)." }],
    ["add_channel_mcps", { authz: "manage", details: ({ names }) => `Allow MCP server(s) in this channel: ${summarize((names || []).join(", "))}` }],
    ["remove_channel_mcps", { authz: "manage", details: ({ names }) => `Remove MCP server(s) from this channel: ${summarize((names || []).join(", "))}` }],
    ["update_channel_instructions", { authz: "any", details: ({ mode, text: t }) => `${mode === "replace" ? "REPLACE" : "Append to"} this channel's standing instructions:\n${summarize(t, 600)}` }],
    ["update_gateway", {
      authz: "admin",
      details: async () => {
        const meta = (await loadMeta()) || {};
        return meta.adminMode || meta.autoMode
          ? null
          : "Update the gateway daemon (git pull + deps + restart; brief downtime).";
      },
    }],
    ["restart_gateway", {
      authz: "admin",
      details: async () => {
        const meta = (await loadMeta()) || {};
        return meta.adminMode
          ? null
          : "Safely restart the gateway after ongoing work drains (brief downtime).";
      },
    }],
    ["update_gateway_guide", { authz: "admin", details: ({ file }) => `Overwrite gateway-usage guide file ${file || "SKILL.md"} for EVERY channel.` }],
    ["reset_gateway_guide", { authz: "admin", details: ({ file }) => `Reset the gateway-usage guide ${file ? `file ${file}` : "(all files)"} to the built-in default.` }],
    // Connector identity: changing whose account future runs act as. Never echo the token value.
    ["set_my_composio_token", { authz: "any", details: () => "Set YOUR Composio token (value hidden) — future runs use this account." }],
    ["clear_my_composio_token", { authz: "any", details: () => "Remove YOUR Composio token." }],
    ["set_my_skills_token", { authz: "any", details: () => "Set YOUR Skills Manager token (value hidden)." }],
    ["clear_my_skills_token", { authz: "any", details: () => "Remove YOUR Skills Manager token." }],
    ["set_my_toolbox_token", { authz: "any", details: () => "Set YOUR Toolbox token (value hidden)." }],
    ["clear_my_toolbox_token", { authz: "any", details: () => "Remove YOUR Toolbox token." }],
    // The deployment's license key: gateway-wide, persistent, and the thing that decides how many
    // conversations and messages this install may serve. `get_license_status` is read-only and stays
    // un-gated. Never echo the key value in the card.
    ["set_license_key", { authz: "admin", details: () => "Set this deployment's ChannelGate LICENSE KEY (value hidden) — it changes the tier and the usage limits for every conversation." }],
    ["clear_license_key", { authz: "admin", details: () => "Remove this deployment's ChannelGate license key — every conversation falls back to the no-key limits (1 conversation, 500 AI messages/month)." }],
  ]);
}

/**
 * The shared factory. One McpServer per run (host) or per socket connection (container), with the
 * capability chokepoint and the control-plane approval gate wrapped around every registration.
 */
export function createGatewayMcpServer(ctx) {
  const server = new McpServer({ name: "channelgate", version: "1.0.0" });
  const CONTROL_PLANE = buildControlPlane(ctx);

  async function passesAuthzPrecheck(authz) {
    if (authz === "admin") return ctx.requireAdmin();
    if (authz === "manage") return ctx.requireManage();
    return true;
  }

  // Ask the daemon to post Slack Approve/Deny buttons and block for the click. Fail closed: no
  // reachable daemon, no secret, or an error means NOT approved.
  async function requireToolApproval(toolName, details, requiredTier = "") {
    if (!ctx.daemon.available("approval")) return { allow: false, reason: "approvals are unavailable right now" };
    try {
      const data = await ctx.daemon.call("approval", {
        approvalType: "agent",
        channelId: ctx.channelId,
        slug: ctx.slug,
        authorId: ctx.createdBy,
        threadKey: ctx.threadKey,
        toolName,
        toolInput: { details },
        approveText: "Approve",
        denyText: "Deny",
        requiredTier,
      }, { timeoutMs: 280_000 });
      return { allow: Boolean(data.allow), reason: data.comment || data.reason || "" };
    } catch (e) {
      return { allow: false, reason: e.message };
    }
  }

  // Chokepoint: authenticate every tool invocation, then apply the additional human-approval gate
  // to CONTROL_PLANE calls between the handler's authz check and its effect.
  const realRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name, def, handler) => {
    const gate = CONTROL_PLANE.get(name);
    return realRegisterTool(name, def, async (args, extra) => {
      const capability = ctx.verifyCapability();
      if (!capability.ok) {
        return text(`🚫 Gateway capability rejected (${capability.reason}). Start a fresh run and try again.`);
      }
      // The HTTP run API authenticates a daemon key, not the caller-supplied Slack author id. Its
      // signed capability deliberately retains that id only for attribution; it must never become
      // authority inside this user/channel control plane (including read-only admin tools).
      if (capability.claims.principalTrusted !== true) {
        return text("🚫 Gateway tools require a trusted Slack principal; this run was authenticated only as a daemon/API caller.");
      }
      if (gate) {
        // Fail CLOSED at the chokepoint. The precheck mirrors the handler's own authz so an
        // unauthorized caller gets one refusal and no approval spam — but if the two ever drift
        // (a handler check relaxed below its gate tier), falling through to the handler would
        // execute a gated change with NO approval at all. Refuse here instead.
        if (!(await passesAuthzPrecheck(gate.authz))) {
          return text(gate.authz === "admin"
            ? `🚫 Only admins can run \`${name}\`. Nothing was changed.`
            : `🚫 Only this channel's managers (or an admin) can run \`${name}\`. Nothing was changed.`);
        }
        const details = await gate.details(args ?? {});
        if (details !== null) {
          // The clicker must independently hold the gate's own tier ("any" needs no extra rank):
          // the human factor for an admin-tier change must come from an admin, never a bystander.
          const d = await requireToolApproval(name, details, gate.authz === "any" ? "" : gate.authz);
          if (!d.allow) {
            return text(`🚫 \`${name}\` changes persistent gateway state, so it needs a human Approve click in Slack — and it was not approved${d.reason ? ` (${d.reason})` : ""}. Nothing was changed.`);
          }
        }
      }
      return handler(args, extra);
    });
  };

  // Registration order is stable within each group; the tool names/descriptions/schemas/handlers
  // are unchanged by the two-entry split.
  if (ctx.toolset === "full") {
    registerWorkspaceRead(server, ctx);
    registerSchedules(server, ctx);
    registerBackground(server, ctx);
    registerChannelAdmin(server, ctx);
    registerTokens(server, ctx);
    registerSlackNative(server, ctx);
    registerLicense(server, ctx);
  } else {
    registerMemoryTool(server, ctx);
  }
  return server;
}

// ── Host-backend entry: this file spawned as the engine's stdio MCP child ──────────────────────
// Identity and the reduced-surface switches come from the environment the daemon put on this
// process; the signed capability is still the only authority (the CG_* strings are hints the
// claims override). Nothing here runs when the module is merely imported — the daemon's socket
// listener imports the factory above in-process.
export function createGatewayMcpServerFromEnv(env = process.env) {
  const token = env.CG_GATEWAY_CAPABILITY || "";
  const verifyCapability = () => verifyGatewayCapability(token, { secret: hostApprovalSecret() });
  const initial = verifyCapability();
  const ctx = ctxFromClaims(initial.ok ? initial.claims : {}, {
    engine: env.CG_ENGINE || "",
    toolset: env.CG_TOOLSET || "",
    progressReport: env.CG_PROGRESS_REPORT === "1",
    daemon: createHttpDaemonIpc(),
    verifyCapability,
  });
  return createGatewayMcpServer(ctx);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await createGatewayMcpServerFromEnv().connect(new StdioServerTransport());
}
