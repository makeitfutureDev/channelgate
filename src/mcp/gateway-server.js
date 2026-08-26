// Gateway control MCP server (stdio). Injected into every gated run, scoped to the current
// principal by a daemon-signed, expiring capability. Runs as
// the gateway's own subprocess — outside the run's filesystem sandbox — so it can read/write the
// gateway config. Exposes scheduling tools (anyone allowed in the channel) and channel-admin
// tools to manage the channel's MCP allowlist (admins only).
// Tool registrations live in ./tools/* — one module per group, each exporting register(server, ctx).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { canManage } from "../gateway/modes.js";
import { getEngine as getDefaultEngine, getEffectiveNetworkDomains } from "../config/settings.js";
import { normalizeRequestedDomain, normalizeStoredDomains } from "../util/network-domains.js";
import { gatewayRoot } from "../config/paths.js";
import { verifyGatewayCapability } from "../gateway/mcp-capability.js";
import { register as registerSchedules } from "./tools/schedules.js";
import { register as registerBackground } from "./tools/background.js";
import { register as registerChannelAdmin, registerMemoryTool } from "./tools/channel-admin.js";
import { register as registerTokens } from "./tools/tokens.js";
import { register as registerSlackNative } from "./tools/slack-native.js";
import { register as registerLicense } from "./tools/license.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });

// Daemon-IPC credentials (the /internal/approval + /internal/background endpoints). The Claude
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
const approvalSecret = () => process.env.CG_APPROVAL_SECRET || String(internalAuth().secret || "");
const approvalPort = () => process.env.CG_PORT || String(internalAuth().port || "") || "4747";

// A4: CG_* identity strings are not authority. The daemon signs the complete run identity and
// the MCP server derives every principal field from that grant. Validation is repeated at the
// tool-call chokepoint so an expired/tampered capability cannot retain a live stdio session.
const capabilityToken = process.env.CG_GATEWAY_CAPABILITY || "";
const currentCapability = () => verifyGatewayCapability(capabilityToken, { secret: approvalSecret() });
const initialCapability = currentCapability();
const identity = initialCapability.ok ? initialCapability.claims : {};
const channelId = identity.channelId || "";
const slug = identity.slug || "";
const createdBy = identity.authorId || "";
const threadKey = identity.threadKey || "";
const origin = identity.origin || "";
const principalTrusted = identity.principalTrusted === true;
const activeEngine = ["claude", "codex"].includes(identity.engine) ? identity.engine : getDefaultEngine();
if (threadKey) process.env.CG_THREAD_KEY = threadKey;

// Repo root + the update script, resolved from this file's location (src/mcp/gateway-server.js).

const server = new McpServer({ name: "channelgate", version: "1.0.0" });

// ── Channel management authorization ────────────────────────────────────────────
// requireAdmin: gateway admins only — for the DANGEROUS escalations (admin mode, network, work-dir,
// host browse, gateway update). requireManage: the SAFE settings (MCP allowlist, bash, auto) — an
// admin OR, when the channel opts in (manageAccess "members"/"custom"), an approved member / listed
// manager. The author comes only from the verified run capability.
async function requireAdmin() {
  return principalTrusted && createdBy && (await isAdmin(createdBy));
}
async function requireManage() {
  if (!principalTrusted || !createdBy) return false;
  const meta = await loadMeta();
  return canManage(meta || {}, {
    authorId: createdBy,
    isAdminUser: await isAdmin(createdBy),
    isApprovedUser: await isApproved(createdBy),
  });
}
async function loadMeta() {
  return slug ? await getChannelMeta(slug) : null;
}

// ── Control-plane approval gate (the 2026-08 update plan (internal repo) A3) ───────────────────────
// A tool that changes FUTURE privileges or persistent state — channel modes/network/workdir, the
// MCP allowlist, standing instructions, connector tokens, schedules, updater/guide operations —
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
const CONTROL_PLANE = new Map([
  ["set_channel_admin_mode", { authz: "admin", details: ({ enabled }) => `Turn ADMIN MODE (no sandbox, no prompts for admin authors) ${onOff(enabled)} for this channel.` }],
  ["set_channel_network", { authz: "admin", details: ({ enabled }) => `Turn network access ${onOff(enabled)} for this channel.` }],
  // Human-in-the-loop egress widening: any authorized user's click may approve ONE named domain
  // for THIS channel. authz "any" + tier "" is deliberate (an admin click is not required — the
  // human factor is the point, since injected content can request but never click). details()
  // returns null (skip the card) when the domain is invalid or already allowed — the handler then
  // refuses/no-ops without approval spam.
  ["request_network_domain", {
    authz: "any",
    details: async ({ domain }) => {
      let d;
      try { d = normalizeRequestedDomain(domain); } catch { return null; }
      const meta = (await loadMeta()) || {};
      const allowed = new Set([...getEffectiveNetworkDomains(), ...normalizeStoredDomains(meta.extraNetworkDomains)]);
      if (!meta.allowNetwork || allowed.has(d)) return null;
      return `Allow this channel's sandboxed commands NETWORK access to: ${d}\nStays on this channel's allow-list until removed. Any file in this folder could then be sent to that domain — approve only if you trust it.`;
    },
  }],
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

async function passesAuthzPrecheck(authz) {
  if (authz === "admin") return requireAdmin();
  if (authz === "manage") return requireManage();
  return true;
}

// Ask the daemon to post Slack Approve/Deny buttons and block for the click. Fail closed: no
// reachable daemon, no secret, or an error means NOT approved.
async function requireToolApproval(toolName, details, requiredTier = "") {
  const secret = approvalSecret();
  const port = approvalPort();
  if (!secret) return { allow: false, reason: "approvals are unavailable right now" };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cg-secret": secret },
      body: JSON.stringify({ approvalType: "agent", channelId, slug, authorId: createdBy, threadKey: process.env.CG_THREAD_KEY || "", toolName, toolInput: { details }, approveText: "Approve", denyText: "Deny", requiredTier }),
      signal: AbortSignal.timeout(280_000),
    });
    const data = await res.json().catch(() => ({}));
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
    const capability = currentCapability();
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

// One shared ctx for every tool module: channel/author identity, the reply helper, the
// authorization gates, and the daemon-IPC credentials. Registration order is stable within
// each group; the tool names/descriptions/schemas/handlers are unchanged by the split.
const ctx = { channelId, slug, createdBy, threadKey, origin, activeEngine, principalTrusted, text, requireAdmin, requireManage, loadMeta, approvalSecret, approvalPort };
// CG_TOOLSET narrows the control plane for daemon-spawned helpers. The background memory review
// (gateway/memory-review.js) exists only to save what a finished conversation taught, so it gets
// the save tool and nothing else — no schedules, no admin switches, no Slack writes. Only the
// exact "full" value (or no value: every ordinary run) exposes the whole set; anything else is
// treated as the reduced set, so a typo can never widen a helper.
const toolset = String(process.env.CG_TOOLSET || "full");
if (toolset === "full") {
  registerSchedules(server, ctx);
  registerBackground(server, ctx);
  registerChannelAdmin(server, ctx);
  registerTokens(server, ctx);
  registerSlackNative(server, ctx);
  registerLicense(server, ctx);
} else {
  registerMemoryTool(server, ctx);
}

await server.connect(new StdioServerTransport());
