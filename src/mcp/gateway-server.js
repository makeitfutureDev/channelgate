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
import { API_PRINCIPAL, canManage, isApiPrincipal, isAuthorized } from "../gateway/modes.js";
import { getEngine as getDefaultEngine } from "../config/settings.js";
import { gatewayRoot } from "../config/paths.js";
import { verifyGatewayCapability } from "../gateway/mcp-capability.js";
import { register as registerSchedules } from "./tools/schedules.js";
import { register as registerBackground } from "./tools/background.js";
import { register as registerChannelAdmin, registerMemoryTool } from "./tools/channel-admin.js";
import { register as registerTokens } from "./tools/tokens.js";
import { register as registerSlackNative } from "./tools/slack-native.js";
import { register as registerLicense } from "./tools/license.js";
import { register as registerChannelDatabase } from "./tools/channel-database.js";
import { register as registerWorkspaceRead } from "./tools/workspace-read.js";
import { register as registerSkills } from "./tools/skills.js";
import { register as registerQuestions } from "./tools/questions.js";
import { register as registerSshAccess } from "./tools/ssh-access.js";
import { sshRequestTarget } from "../gateway/ssh-access.js";
import { register as registerFileSharing, describeDuration } from "./tools/file-sharing.js";
import { prepareInstructionApproval } from "../gateway/instruction-approvals.js";
import { buildControlPlaneAction, describeControlPlaneTier } from "../gateway/control-plane-approvals.js";

export const text = (t) => ({ content: [{ type: "text", text: t }] });

// ── Daemon IPC ────────────────────────────────────────────────────────────────────────────────
// Four daemon-side effects a tool can ask for: start background work, ask a human in Slack, queue
// a safe restart, start/inspect a channel's Google Drive sync pass (the pass must run in the daemon
// so it shares the per-channel in-flight guard and outlives the turn). `kind` is also the /internal/<kind> route name, so the two transports stay in
// lockstep. A tool never learns which one it is using.
export const DAEMON_IPC_KINDS = Object.freeze(["background", "approval", "restart", "drivesync"]);

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
// is a reduced set, so a typo can never widen a helper. "ssh" is an interactive SSH session's
// surface (gateway/ssh-session.js): everything a turn has EXCEPT the tools that report into, or
// wait on, the chat thread a turn belongs to — background jobs, progress, approval cards — because
// a session has no thread; the developer answers Claude's own prompts in their terminal. The
// background memory review (gateway/memory-review.js) exists only to save what a finished
// conversation taught, so it gets the save tool and nothing else — no schedules, no admin
// switches, no Slack writes.
export const SSH_TOOLSET = "ssh";
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
  const claimedAuthor = claims.authorId || "";
  const threadKey = claims.threadKey || "";
  const origin = claims.origin || "";
  // A verified human (a Slack-authenticated author) versus the HTTP run API's admin key. Every tool
  // in an API run acts as the fixed API principal (config/api-principal.js): an admin of this
  // channel with no personal scope. A capability that names any other author without vouching for
  // it (principalTrusted false) maps there too, so a named id is never authority. Runs that API
  // work later spawns (a schedule, a background agent) carry the principal as their author.
  const apiPrincipal = claims.principalTrusted !== true || isApiPrincipal(claimedAuthor);
  const principalTrusted = !apiPrincipal;
  const createdBy = apiPrincipal ? (claimedAuthor ? API_PRINCIPAL : "") : claimedAuthor;
  const claimedEngine = ENGINE_CLAIMS.includes(claims.engine) ? claims.engine : "";
  const activeEngine = claimedEngine || (ENGINE_CLAIMS.includes(engine) ? engine : getDefaultEngine());

  const loadMeta = async () => (slug ? await getChannelMeta(slug) : null);
  // requireAdmin: gateway admins only — for the DANGEROUS escalations (admin mode, network,
  // work-dir, host browse, gateway update). requireManage: the SAFE settings (MCP allowlist, bash,
  // auto) — an admin OR, when the channel opts in (manageAccess "members"/"custom"), an approved
  // member / listed manager. The author comes only from the verified run capability.
  // The HTTP run API principal ranks as an admin: its key is an admin credential. Control-plane
  // changes still need a human click on their approval card, exactly as for an admin's message.
  const requireAdmin = async () => Boolean(createdBy) && (apiPrincipal || (await isAdmin(createdBy)));
  const requireManage = async () => {
    if (!createdBy) return false;
    if (apiPrincipal) return true;
    const meta = await loadMeta();
    return canManage(meta || {}, {
      authorId: createdBy,
      isAdminUser: await isAdmin(createdBy),
      isApprovedUser: await isApproved(createdBy),
    });
  };

  const requireChannelAccess = async () => {
    if (!createdBy) return false;
    // The API key was accepted as this channel's caller; the capability is scoped to it.
    if (apiPrincipal) return Boolean(await loadMeta());
    const meta = await loadMeta();
    return Boolean(meta) && isAuthorized(meta, createdBy, meta.isDM, {
      isAdminUser: await isAdmin(createdBy), isApprovedUser: await isApproved(createdBy),
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
    apiPrincipal,
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
    requireChannelAccess,
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

// `set_secret` / `remove_secret` take the scope as an argument; the organization scope is the
// admin tier, everything else the author's own.
export function secretScopeTier(scope) {
  const s = String(scope || "personal").trim().toLowerCase();
  return s === "organization" || s === "org" ? "admin" : "any";
}

// set_secret_mode: who may CALL it — the organization's secrets need an admin, a conversation's
// its managers, a personal one its owner.
export function secretModeTier(scope) {
  const s = String(scope || "personal").trim().toLowerCase();
  if (s === "organization" || s === "org") return "admin";
  if (s === "conversation" || s === "channel") return "manage";
  return "any";
}
// Who may APPROVE the card a secret still posts (making it readable, approving a server for it):
// an admin for the organization's, anyone working in the channel for the conversation's, the owner
// for a personal one — the same tiers the proxy's first-use card carries
// (gateway/secret-host-approvals.js secretHostTier).
export function secretCardTier(scope) {
  const s = String(scope || "personal").trim().toLowerCase();
  if (s === "organization" || s === "org") return "admin";
  if (s === "conversation" || s === "channel") return "";
  return "owner";
}
function secretModeLabel(scope) {
  const tier = secretModeTier(scope);
  return tier === "admin" ? "ORGANIZATION-WIDE" : tier === "manage" ? "this conversation's" : "YOUR personal";
}

/** A gate's tier: a string, or a function of the call's arguments (see set_secret). */
export function gateAuthz(gate, args = {}) {
  return typeof gate?.authz === "function" ? gate.authz(args ?? {}) : gate?.authz;
}

/** Who must click a gate's card: the gate's own `tier` (string or function of the arguments), else its authz. */
export function gateCardTier(gate, args = {}) {
  const own = typeof gate?.tier === "function" ? gate.tier(args ?? {}) : gate?.tier;
  if (typeof own === "string") return own;
  const authz = gateAuthz(gate, args);
  return authz === "any" ? "" : authz;
}

// What the table says per tool: `authz` is who may CALL it (checked first; a caller without it is
// refused with no card), `details(args)` is the card text — or null, which means the change is
// AUTOMATIC for that caller — and `tier` is who must click the card (defaults to the authz).
//
// Operator decision 2026-10-07 (minimum second-approval cards). A card survives only where one
// unasked call would silently hand attacker-controlled content or a secret to OTHER channels and a
// later admin message could not undo it. Everything that is channel-scoped, visible in the thread
// and reversible — modes, network, folders, MCP servers, sources' settings, grants' removal, the
// license key, the guide's reset, updates and restarts — is automatic for the author who holds its
// authority; it is still refused for anyone else, still audited, and the model still announces it.
// A surviving card is DURABLE: the exact call is saved and applied on the click, with no deadline.
const AUTOMATIC = () => null;

export function buildControlPlane({ loadMeta, createdBy, principalTrusted }) {
  const ownSsh = ({ user }) => principalTrusted === true && Boolean(createdBy) && sshRequestTarget(user, createdBy) === createdBy;
  return new Map([
    // ── Channel settings: automatic for an admin (or the channel's managers), announced in the thread.
    // Admin mode is the one exception: it turns the engine's own permission prompts off for admin
    // authors in this channel, which is the posture every other card relies on — so it keeps its card.
    ["set_channel_admin_mode", { authz: "admin", details: ({ enabled }) => `Turn ADMIN MODE (no sandbox, no prompts for admin authors) ${onOff(enabled)} for this channel.` }],
    ["set_channel_vpn", { authz: "manage", details: AUTOMATIC }],
    ["set_channel_network", { authz: "admin", details: AUTOMATIC }],
    ["set_channel_bash", { authz: "manage", details: AUTOMATIC }],
    ["set_channel_auto_mode", { authz: "manage", details: AUTOMATIC }],
    // The folder is contained to the allowlisted root (web/security.js), so it cannot point at
    // the operator home, the gateway root or another channel; a wrong change is one message away.
    ["set_channel_workdir", { authz: "admin", details: AUTOMATIC }],
    ["clear_channel_workdir", { authz: "admin", details: AUTOMATIC }],
    // With network on the agent can already upload the same files anywhere; a Drive link adds no
    // reach a card would withhold.
    ["set_channel_drive_folder", { authz: "admin", details: AUTOMATIC }],
    ["clear_channel_drive_folder", { authz: "admin", details: AUTOMATIC }],
    ["add_channel_mcps", { authz: "manage", details: AUTOMATIC }],
    ["remove_channel_mcps", { authz: "manage", details: AUTOMATIC }],
    // ── Skills. Personal and channel skills are their author's / the channel members' and never
    // wait for anyone (create_skill, update_skill, delete_skill, add_/remove_channel_skills,
    // set_channel_skill_template are OPEN; their handlers enforce the tier). The organization tier
    // keeps a card ONLY where content enters every conversation: admitting a source, granting a
    // skill organization-wide directly or through a template, approving a member's proposal.
    // Reductions, settings and syncs are automatic.
    ["update_skill_template", { authz: "admin", details: ({ template, add = [], remove = [] }) => add.length
      ? `Add to the "${summarize(template)}" skill template — every conversation following it gets ${summarize(add.join(", "))}.${remove.length ? ` Also remove: ${summarize(remove.join(", "))}.` : ""}`
      : null }],
    ["decide_skill_proposal", { authz: "admin", details: ({ id, decision }) => decision === "approve" ? `APPROVE skill proposal #${Number(id) || "?"} — its change becomes part of the shared catalog.` : null }],
    ["sync_skill_sources", { authz: "admin", details: AUTOMATIC }],
    ["publish_skill", { authz: "manage", details: AUTOMATIC }],
    ["set_skill_scope", { authz: "admin", details: AUTOMATIC }],
    ["add_org_skills", { authz: "admin", details: ({ slugs }) => `Grant skill(s) ORGANIZATION-WIDE (every conversation): ${summarize((slugs || []).join(", "))}` }],
    ["remove_org_skills", { authz: "admin", details: AUTOMATIC }],
    ["add_skill_source", { authz: "admin", details: ({ kind, url }) => `Add a ${summarize(kind)} skill source and sync it: ${summarize(url)}` }],
    ["set_skill_source", { authz: "admin", details: AUTOMATIC }],
    ["remove_skill_source", { authz: "admin", details: AUTOMATIC }],
    ["set_skill_excluded", { authz: "admin", details: AUTOMATIC }],
    ["set_skill_governance", { authz: "admin", details: AUTOMATIC }],
    // Publishing bytes: `create_public_file_link` with purpose "share" puts a channel file at an
    // unauthenticated URL for up to 48 hours, which is outward-facing and cannot be taken back
    // once fetched — so it carries a card naming the file and the duration, answered inline by
    // anyone working in the channel (the model needs the minted URL in the same turn). The
    // "upload" purpose returns null (no card): it lives minutes, is spent by the machine the turn
    // is already talking to, and gating it would stall the very step the user asked for.
    ["create_public_file_link", { authz: "any", details: ({ path: p, purpose, minutes }) => {
      if (purpose !== "share") return null;
      const value = Number(minutes);
      const duration = Number.isFinite(value) && value > 0 ? describeDuration(Math.ceil(value)) : "an unspecified duration (the call will be rejected)";
      return `Publish \`${summarize(p)}\` at a PUBLIC download URL for ${duration}. Anyone holding the link can download the file with no login, from anywhere.`;
    } }],
    // Appending a standing rule is a durable card anyone working in the channel approves — rules
    // shape every member's turns, so a second pair of eyes sees them land. Replacing the whole
    // section is an admin's call (the handler enforces it) and is automatic: the handler makes
    // the model quote the complete new text in its reply, so the thread shows what changed.
    ["update_channel_instructions", { authz: "any", details: ({ mode, text: t }) => mode === "replace" ? null : `Append to this channel's standing instructions:\n${t}` }],
    ["update_gateway", { authz: "admin", details: AUTOMATIC }],
    ["restart_gateway", { authz: "admin", details: AUTOMATIC }],
    // The guide is model-written text that becomes standing instructions in EVERY channel, read by
    // nobody afterwards: the one tool where a wrong call is both silent and global. Reset is safe.
    ["update_gateway_guide", { authz: "admin", details: ({ file }) => `Overwrite gateway-usage guide file ${file || "SKILL.md"} for EVERY channel.` }],
    ["reset_gateway_guide", { authz: "admin", details: AUTOMATIC }],
    // Connector identity and environment secrets: the caller's own accounts (or, for the
    // organization scope, an admin's). The value is in the caller's own message; a card would
    // only echo its name back. Never a value in a card or a listing.
    ["set_my_composio_token", { authz: "any", details: AUTOMATIC }],
    ["clear_my_composio_token", { authz: "any", details: AUTOMATIC }],
    ["set_my_toolbox_token", { authz: "any", details: AUTOMATIC }],
    ["clear_my_toolbox_token", { authz: "any", details: AUTOMATIC }],
    ["set_secret", { authz: ({ scope }) => secretScopeTier(scope), details: AUTOMATIC }],
    ["remove_secret", { authz: ({ scope }) => secretScopeTier(scope), details: AUTOMATIC }],
    // Making a secret READABLE puts its raw value in containers where people can read it; once
    // read it is out. Hiding one again (or `auto`) is automatic. The card is approved by the
    // organization's admin, anyone working in the conversation, or the personal secret's owner.
    ["set_secret_mode", { authz: ({ scope }) => secretModeTier(scope), tier: ({ scope }) => secretCardTier(scope), details: ({ name, mode, scope }) => mode === "readable"
      ? `Make the ${secretModeLabel(scope)} secret ${summarize(name)} READABLE — containers will receive its RAW value.`
      : null }],
    // An approved server is where a hidden secret's real value may go: the exfiltration guard
    // itself. Same tiers as the proxy's first-use card; the handler enforces who may ask per scope.
    ["allow_secret_host", { authz: ({ scope }) => secretCardTier(scope) === "admin" ? "admin" : "any", tier: ({ scope }) => secretCardTier(scope), details: ({ name, host, scope }) =>
      `Allow the ${secretModeLabel(scope)} secret ${summarize(name)} to be sent to ${summarize(host)} — the egress proxy will swap in its real value on that server.` }],
    // Personal keys and a trusted user's own SSH grant are self-service; grants for OTHER people
    // are a manager's call and automatic for them.
    ["grant_channel_ssh", { authz: args => ownSsh(args) ? "any" : "manage", details: AUTOMATIC }],
    ["revoke_channel_ssh", { authz: args => ownSsh(args) ? "any" : "manage", details: AUTOMATIC }],
    // The license key is in the admin's own message, the admin UI sets it with no second step,
    // and the worst unasked outcome (the no-key limits) is undone by setting it again.
    ["set_license_key", { authz: "admin", details: AUTOMATIC }],
    ["clear_license_key", { authz: "admin", details: AUTOMATIC }],
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
  async function requireToolApproval(toolName, details, requiredTier = "", durableAction = null) {
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
        ...(durableAction ? { durableAction } : {}),
      }, { timeoutMs: 280_000 });
      return { allow: Boolean(data.allow), pending: Boolean(data.pending), approvalId: data.approvalId || "", reason: data.comment || data.reason || "" };
    } catch (e) {
      return { allow: false, reason: e.message };
    }
  }

  // Chokepoint: authenticate every tool invocation, then apply the additional human-approval gate
  // to CONTROL_PLANE calls between the handler's authz check and its effect.
  const realRegisterTool = server.registerTool.bind(server);
  // The handlers behind the gate, for a saved control-plane approval the daemon applies on the
  // click (gateway/control-plane-approvals.js): the card WAS the human factor, so the executor
  // runs the handler directly — the handler's own authz check still runs, as the requester.
  const rawHandlers = new Map();
  server.invokeApproved = async (name, args) => {
    const handler = rawHandlers.get(name);
    if (!handler) throw new Error(`unknown gateway tool "${name}"`);
    if (!CONTROL_PLANE.has(name)) throw new Error(`"${name}" is not a control-plane tool`);
    const capability = ctx.verifyCapability();
    if (!capability.ok) throw new Error(`gateway capability rejected (${capability.reason})`);
    const result = await handler(args ?? {}, {});
    const message = (result?.content || []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    return { ok: result?.isError !== true, text: message };
  };
  server.registerTool = (name, def, handler) => {
    const gate = CONTROL_PLANE.get(name);
    rawHandlers.set(name, handler);
    return realRegisterTool(name, def, async (args, extra) => {
      // Claude Code parses permission_prompt's reply as an allow/deny decision, so a refusal
      // there must keep that shape — plain text reads as "invalid permission result" to the CLI.
      const refuse = (message) => name === "permission_prompt" ? text(JSON.stringify({ behavior: "deny", message })) : text(message);
      const capability = ctx.verifyCapability();
      if (!capability.ok) {
        return refuse(`🚫 Gateway capability rejected (${capability.reason}). Start a fresh run and try again.`);
      }
      // An HTTP run API capability is honoured like a channel member's: ctxFromClaims already
      // mapped it to the API principal, so the author it names never becomes authority here —
      // personal tools refuse it, admin tools refuse it, and approvals never auto-pass as an admin.
      let humanApproved = false;
      if (gate) {
        // Fail CLOSED at the chokepoint. The precheck mirrors the handler's own authz so an
        // unauthorized caller gets one refusal and no approval spam — but if the two ever drift
        // (a handler check relaxed below its gate tier), falling through to the handler would
        // execute a gated change with NO approval at all. Refuse here instead.
        const authz = gateAuthz(gate, args);
        if (!(await passesAuthzPrecheck(authz))) {
          return text(authz === "admin"
            ? `🚫 Only admins can run \`${name}\`. Nothing was changed.`
            : `🚫 Only this channel's managers (or an admin) can run \`${name}\`. Nothing was changed.`);
        }
        let details = await gate.details(args ?? {});
        if (details !== null) {
          // The clicker must independently hold the card's tier ("" needs no extra rank): the
          // human factor for an admin-tier change must come from an admin, never a bystander.
          const tier = gateCardTier(gate, args);
          let durableAction = null;
          if (name === "update_channel_instructions") {
            try {
              durableAction = await prepareInstructionApproval(ctx, args);
              details = await gate.details(durableAction);
            } catch (error) {
              return text(`Couldn't request the instruction update: ${error.message}`);
            }
          } else if (name !== "create_public_file_link") {
            // Every other surviving card is durable: the exact call is saved and applied on the
            // click by the daemon, so no engine waits and no card expires. The public-link card
            // stays inline because the model needs the minted URL in the same turn.
            durableAction = buildControlPlaneAction(ctx, { tool: name, args: args ?? {}, tier });
          }
          const d = await requireToolApproval(name, details, tier, durableAction);
          if (d.pending) {
            return text(`⏳ \`${name}\` is awaiting approval (request ${d.approvalId}). The exact change is saved with no deadline and survives gateway restarts. End your turn; the gateway applies it when ${describeControlPlaneTier(tier)} clicks Approve, and posts the outcome on the card. Deny or Comment cancels it. Nothing has changed yet.`);
          }
          // Durable actions are applied only by the daemon's single-use executor. An unexpected
          // transport response must never also run the live handler and duplicate the write.
          if (durableAction) return text(`Couldn't save the approval for \`${name}\`: ${d.reason || "the gateway did not return a pending request"}. Nothing was changed.`);
          if (!d.allow) {
            return text(`🚫 \`${name}\` needs a human Approve click — and it was not approved${d.reason ? ` (${d.reason})` : ""}. Nothing was changed.`);
          }
          humanApproved = true;
        }
      }
      const result = await handler(args, extra);
      if (!humanApproved) return result;
      // The model does not see the gateway's approval UI while awaiting this tool. Keep the
      // decision visible without conflating it with the handler outcome or naming a UI/actor.
      return {
        ...result,
        content: [...(result.content || []), {
          type: "text",
          text: "Human approval was received before this tool executed. This receipt records an explicit human decision; channel Auto mode did not supply it. The gateway handles the approval UI outside the model transcript; receiving the tool result does not mean approval was bypassed. Approval does not establish whether the requested change succeeded; use the tool outcome above.",
        }],
      };
    });
  };

  // Registration order is stable within each group; the tool names/descriptions/schemas/handlers
  // are unchanged by the two-entry split.
  if (ctx.toolset === "full" || ctx.toolset === SSH_TOOLSET) {
    registerWorkspaceRead(server, ctx);
    registerSchedules(server, ctx);
    if (ctx.toolset === "full") registerBackground(server, ctx);
    registerChannelAdmin(server, ctx);
    registerChannelDatabase(server, ctx);
    registerTokens(server, ctx);
    registerSlackNative(server, ctx);
    registerLicense(server, ctx);
    registerSkills(server, ctx);
    registerQuestions(server, ctx);
    registerSshAccess(server, ctx);
    registerFileSharing(server, ctx);
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
