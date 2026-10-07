// "May this hidden secret be sent to this server?" — the durable approval a hidden secret with no
// declared destination raises the first time a container presents it to a new server.
//
// Why: a placeholder the proxy swaps on ANY server would let a tricked agent hand the real value to
// whoever it likes. A hidden secret with no known destination (egress/catalog-rules.js, an
// "approval" rule) therefore swaps only on the servers an admin approved, and the first request to
// any other server is refused with a 403 while this card asks. Approving records the server on the
// secret's own entry (approvedHosts), so every later run, schedule and SSH session just works.
//
// A closed, exact action like the channel-instruction approval: the row holds secret, scope, owner
// and host, and a click (even after a restart) executes it. Who may click follows the secret's
// scope (secretHostTier): an admin for the organization's, anyone working in the channel for the
// conversation's, the owner for a personal one — operator decision 2026-10-07, so a member's work
// no longer waits on an admin for a credential that is theirs or their channel's.
import { getChannelEntry, getChannelMeta, isAdminPrincipal, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { getSecretEntry, patchSecretEntry } from "../config/scoped-env.js";
import { listPendingApprovalRequests } from "./approval-requests.js";
import { engineHostsFor } from "./egress/engine-hosts.js";
import { hostMatches, normalizeHost } from "./egress/rules.js";
import { isValidRuleHost } from "./egress/catalog-rules.js";
import { liveTurnIn } from "./egress/liveness.js";

export const SECRET_HOST_ACTION = "secret_host";
// The approval tier a secret's scope carries (mirrored by gateway-server.js secretCardTier).
export function secretHostTier(scope) {
  return scope === "organization" ? "admin" : scope === "personal" ? "owner" : "";
}
const SCOPES = new Set(["organization", "channel", "personal"]);
// One card per secret and server at a time is the approval table's job (a pending row with the same
// action key is reused). This window also keeps a DENIED request, or an agent looping over new
// hosts, from posting again at once; and a channel never holds more than a few pending cards.
const RECENT_MS = 10 * 60_000;
export const MAX_PENDING_PER_CHANNEL = 5;
const recent = new Map();
let requester = null;

// server.js wires the Slack approval surface in: (request) → Promise<{ allow, pending, reason }>.
export function setSecretHostApprovalRequester(fn) {
  requester = typeof fn === "function" ? fn : null;
}

// The engines' APIs and any configured Qwen endpoint (egress/service.js modelApiHosts; lazy — the
// service module is not needed to decide an approval in tests).
async function neverApprovable(host) {
  let hosts = engineHostsFor();
  try { hosts = (await import("./egress/service.js")).modelApiHosts(); } catch { /* the fixed engine list */ }
  return hosts.some((pattern) => hostMatches(pattern, host));
}

function pendingCardsIn(channelId) {
  try {
    return listPendingApprovalRequests(500).filter((row) => row.action?.kind === SECRET_HOST_ACTION && row.channelId === channelId).length;
  } catch {
    return 0;
  }
}

export function buildSecretHostAction({ channelId, slug, authorId = "", threadKey = "", secretName, scope, ownerId = "", host, entrySetAt = 0 }) {
  return {
    kind: SECRET_HOST_ACTION,
    channelId: String(channelId || ""),
    slug: String(slug || ""),
    authorId: String(authorId || ""),
    threadKey: String(threadKey || ""),
    secretName: String(secretName || ""),
    scope: String(scope || ""),
    ownerId: String(ownerId || ""),
    host: normalizeHost(host),
    // Which VERSION of the secret was asked about: a card approved after the secret was deleted and
    // re-created (or re-set) under the same name must not bless the new credential.
    entrySetAt: Number(entrySetAt) || 0,
  };
}

function describe(action) {
  const where = action.scope === "organization" ? "the organization-wide variable"
    : action.scope === "personal" ? `<@${action.ownerId}>'s personal variable`
      : "this conversation's variable";
  const reach = action.scope === "organization" ? " It is shared by every conversation, so approving applies in all of them." : "";
  return `Allow ${where} \`${action.secretName}\` to be sent to \`${action.host}\`?${reach}\n\n`
    + `A program in this channel's container (a turn in this thread, a background job or an SSH session) just tried to use it there. Approving remembers ${action.host} for this variable: `
    + "every later run, schedule and SSH session may use it on that server (and only the servers approved so far). "
    + "Deny if you do not recognise the server — the request was refused and nothing was sent.";
}

// The proxy's onApprovalNeeded hook (via egress/service.js): refusals of one request, the channel
// context and the destination. Posts one durable card per secret+server in the live turn's thread.
export async function requestSecretHostApprovals(refusals, { channelId, slug, hostname } = {}) {
  const host = normalizeHost(hostname);
  if (!requester || !channelId || !slug || !isValidRuleHost(host) || (await neverApprovable(host))) return [];
  const now = Date.now();
  for (const [key, at] of recent) if (now - at >= RECENT_MS) recent.delete(key);
  const turn = liveTurnIn(channelId);
  // No live turn (an SSH session or a background job alone): there is no thread to ask in. The 403
  // still says approval is needed; an admin can approve with allow_secret_host.
  if (!turn?.threadKey) return [];
  const out = [];
  for (const refusal of refusals) {
    if (!refusal?.secretName || !SCOPES.has(refusal.scope)) continue;
    const key = `${refusal.scope}\0${refusal.scope === "organization" ? "" : refusal.scope === "personal" ? refusal.owner || "" : channelId}\0${refusal.secretName}\0${host}`;
    if (now - (recent.get(key) || 0) < RECENT_MS) continue;
    if (pendingCardsIn(channelId) >= MAX_PENDING_PER_CHANNEL) break;
    recent.set(key, now);
    const entry = await getSecretEntry({ scope: refusal.scope, slug, userId: refusal.owner || "", name: refusal.secretName }).catch(() => null);
    if (!entry) continue;
    const action = buildSecretHostAction({
      channelId, slug, authorId: turn.ownerId, threadKey: turn.threadKey,
      secretName: refusal.secretName, scope: refusal.scope, ownerId: refusal.owner || "", host, entrySetAt: entry.setAt,
    });
    out.push(await requester({
      channelId, slug, authorId: turn.ownerId, threadKey: turn.threadKey,
      toolName: `Use variable ${action.secretName} on ${host}`,
      toolInput: { details: describe(action) },
      approvalType: "agent",
      requiredTier: secretHostTier(refusal.scope),
      approveText: `Allow on ${host}`,
      denyText: "Deny",
      durableAction: action,
    }));
  }
  return out;
}

// The durable executor (server.js setDurableApprovalExecutor) for a SECRET_HOST_ACTION row.
export async function executeSecretHostApproval(record) {
  const action = record?.action;
  try {
    if (record?.status !== "executing" || action?.kind !== SECRET_HOST_ACTION || action.channelId !== record.channelId || action.slug !== record.slug
        || !action.secretName || !SCOPES.has(action.scope) || (action.scope === "personal" && !action.ownerId)) {
      throw new Error("Invalid saved secret approval.");
    }
    const host = normalizeHost(action.host);
    if (!isValidRuleHost(host) || host.startsWith("*.")) throw new Error("The saved server is not a host name.");
    if (await neverApprovable(host)) throw new Error(`${host} is a model API: a secret is never swapped there.`);
    // The human factor again, at execution time: the admin UI and a decision link re-check their
    // own authority on their routes; a chat click must still hold the secret's tier today.
    if (record.decidedBy !== "admin UI" && record.decidedBy !== "link") {
      const clicker = String(record.decidedBy || "");
      const admin = await isAdminPrincipal(clicker);
      if (action.scope === "organization" && !admin) throw new Error("Only an admin can approve where an organization secret may be sent.");
      if (action.scope === "personal" && !admin && clicker !== action.ownerId) throw new Error("Only the owner of a personal secret (or an admin) can approve where it may be sent.");
      if (action.scope === "channel" && !admin) {
        const entry = await getChannelEntry(action.channelId);
        const meta = await getChannelMeta(action.slug);
        const member = Boolean(entry && meta) && isAuthorized(meta, clicker, Boolean(entry.isDM), { isAdminUser: false, isApprovedUser: await isApproved(clicker) });
        if (!member) throw new Error("Only someone working in this channel (or an admin) can approve where its secret may be sent.");
      }
    }
    const entry = await getSecretEntry({ scope: action.scope, slug: action.slug, userId: action.ownerId, name: action.secretName });
    if (!entry) throw new Error(`${action.secretName} no longer exists.`);
    if ((Number(entry.setAt) || 0) !== action.entrySetAt) throw new Error(`${action.secretName} was changed after this approval was requested. Retry the request to get a fresh card.`);
    await patchSecretEntry({ scope: action.scope, slug: action.slug, userId: action.ownerId, name: action.secretName, addApprovedHost: host });
    return { ok: true, completed: true, label: "secret server approval", message: `${action.secretName} may now be used on ${host}. Retry the request.` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function __resetSecretHostApprovals() {
  recent.clear();
  requester = null;
}
