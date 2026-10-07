// Durable control-plane approvals: the few gateway tool calls that still need a human click are
// saved as an EXACT action (tool + arguments + requester) and applied by the daemon when the card
// is clicked — minutes or days later, after a restart, with no engine process waiting. Same shape
// as the channel-instruction and secret-host approvals; this module is the generic form.
//
// Operator decision 2026-10-07 (minimum second-approval cards): a card survives only where one
// unasked call would silently hand attacker-controlled content or a secret to OTHER channels and a
// later admin message could not undo it — the gateway guide, admitting a skill source, granting a
// skill organization-wide (directly, through a template, or by approving a proposal), approving a
// server for a hidden secret, making a secret readable, and Admin mode on/off. Every other
// control-plane change is automatic for the author who holds its authority.
import { getChannelEntry, getChannelMeta, isAdminPrincipal, isApproved } from "../config/store.js";
import { canManage, isAuthorized } from "./modes.js";

export const CONTROL_PLANE_ACTION = "control_plane";
// Who may click Approve: a gateway admin, a channel manager, the requester themself (a personal
// secret's owner), or anyone authorized to work in the channel ("").
export const CONTROL_PLANE_TIERS = Object.freeze(["admin", "manage", "owner", ""]);

// Arguments that must never be persisted with the saved action. They are held in daemon memory
// under the approval id until the click; a restart in between loses them, and the executor then
// says so instead of applying a half-formed call.
const SECRET_ARGS = Object.freeze({ add_skill_source: ["token"] });
const secretStash = new Map();
let invoker = null;

export function buildControlPlaneAction(ctx, { tool, args = {}, tier = "" } = {}) {
  if (!CONTROL_PLANE_TIERS.includes(tier)) throw new Error(`Unknown approval tier "${tier}".`);
  return {
    kind: CONTROL_PLANE_ACTION,
    tool: String(tool || ""),
    args: { ...(args || {}) },
    tier,
    channelId: ctx.channelId || "",
    slug: ctx.slug || "",
    authorId: ctx.createdBy || "",
    threadKey: ctx.threadKey || "",
  };
}

// Split the arguments the row may hold from the ones it must not. `secretArgNames` records which
// were given, so a click after a restart can tell "not kept" from "never passed".
export function splitControlPlaneSecrets(action) {
  const names = SECRET_ARGS[action?.tool] || [];
  const args = { ...(action?.args || {}) };
  const secrets = {};
  const secretArgNames = [];
  for (const name of names) {
    if (args[name] === undefined || args[name] === "") { delete args[name]; continue; }
    secrets[name] = args[name];
    secretArgNames.push(name);
    delete args[name];
  }
  return { action: { ...action, args, secretArgNames }, secrets: secretArgNames.length ? secrets : null };
}

export function stashControlPlaneSecrets(approvalId, secrets) {
  if (approvalId && secrets) secretStash.set(approvalId, { ...secrets });
}

export function takeControlPlaneSecrets(approvalId) {
  const held = secretStash.get(approvalId) || null;
  secretStash.delete(approvalId);
  return held;
}

// Registered at boot: runs a saved tool call as its original requester (server.js builds the tool
// context and invokes the handler directly, with the gate already satisfied).
export function setControlPlaneInvoker(fn) {
  invoker = typeof fn === "function" ? fn : null;
}

export function describeControlPlaneTier(tier = "") {
  if (tier === "admin") return "a gateway admin";
  if (tier === "manage") return "one of this channel's managers (or an admin)";
  if (tier === "owner") return "you (the requester)";
  return "anyone working in this channel";
}

async function rank(userId, meta, isDM) {
  const admin = await isAdminPrincipal(userId);
  const approved = await isApproved(userId);
  return {
    admin,
    approved,
    member: Boolean(meta) && isAuthorized(meta, userId, Boolean(isDM), { isAdminUser: admin, isApprovedUser: approved }),
    manager: admin || canManage(meta || {}, { authorId: userId, isAdminUser: admin, isApprovedUser: approved }),
  };
}

// The durable executor (server.js setDurableApprovalExecutor) for a CONTROL_PLANE_ACTION row.
export async function executeControlPlaneApproval(record) {
  const action = record?.action;
  try {
    if (record?.status !== "executing" || action?.kind !== CONTROL_PLANE_ACTION || !action.tool || typeof action.args !== "object"
        || !CONTROL_PLANE_TIERS.includes(action.tier || "")
        || action.channelId !== record.channelId || action.slug !== record.slug || action.authorId !== record.authorId) {
      throw new Error("Invalid saved control-plane approval.");
    }
    if (typeof invoker !== "function") throw new Error("The gateway cannot apply saved control-plane approvals right now.");
    const entry = await getChannelEntry(action.channelId);
    const meta = await getChannelMeta(action.slug);
    if (!entry || entry.slug !== action.slug || !meta || (meta.channelId && meta.channelId !== action.channelId)) {
      throw new Error("The approval's channel no longer matches its original destination.");
    }
    // The requester's authority TODAY: an admin tool needs an admin requester, a manager tool a
    // manager, anything else someone still allowed to work here. Being eligible when the card was
    // posted is not evidence of holding the authority now.
    const requester = await rank(action.authorId, meta, entry.isDM);
    const tier = action.tier || "";
    if (tier === "admin" && !requester.admin) throw new Error("The requester is no longer an admin.");
    if (tier === "manage" && !requester.manager) throw new Error("The requester no longer manages this channel.");
    if (!requester.admin && !requester.member) throw new Error("The requester is no longer authorized in this channel.");
    // The human factor: the admin UI's session IS an admin; a decision link is bound to the
    // requester and its route re-validates them on every POST; a chat click is checked here.
    if (record.decidedBy !== "admin UI" && record.decidedBy !== "link") {
      const clicker = await rank(record.decidedBy, meta, entry.isDM);
      const meets = tier === "admin" ? clicker.admin
        : tier === "manage" ? clicker.manager
          : tier === "owner" ? clicker.admin || record.decidedBy === action.authorId
            : clicker.admin || clicker.member;
      if (!meets) throw new Error(`Only ${describeControlPlaneTier(tier)} can approve this.`);
    }
    const secrets = takeControlPlaneSecrets(record.id) || {};
    for (const name of action.secretArgNames || []) {
      if (secrets[name] === undefined) {
        throw new Error(`The \`${name}\` given with this request was not kept across a gateway restart. Call ${action.tool} again.`);
      }
    }
    const outcome = await invoker({
      tool: action.tool,
      args: { ...action.args, ...secrets },
      channelId: action.channelId,
      slug: action.slug,
      authorId: action.authorId,
      threadKey: action.threadKey,
    });
    const message = String(outcome?.text ?? outcome ?? "").trim();
    if (outcome?.ok === false || /^(🚫|❌|Only |Couldn't|Could not|Channel isn't|No channel)/u.test(message)) {
      throw new Error(message || `${action.tool} refused the saved call.`);
    }
    return { ok: true, completed: true, label: action.tool, message: message || "Applied." };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function __resetControlPlaneApprovals() {
  secretStash.clear();
  invoker = null;
}
