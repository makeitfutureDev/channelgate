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
// and host, a click (even after a restart) executes it, and only an admin's decision counts —
// never the run's own author (requiredTier "admin").
import { isAdminPrincipal } from "../config/store.js";
import { patchSecretEntry } from "../config/scoped-env.js";
import { engineHostsFor } from "./egress/engine-hosts.js";
import { hostMatches, normalizeHost } from "./egress/rules.js";
import { isValidRuleHost } from "./egress/catalog-rules.js";
import { liveTurnIn } from "./egress/liveness.js";

export const SECRET_HOST_ACTION = "secret_host";
const SCOPES = new Set(["organization", "channel", "personal"]);
// One card per secret and server at a time is the approval table's job (a pending row with the same
// action key is reused); this only stops a retry loop from re-querying it on every request.
const RECENT_MS = 60_000;
const recent = new Map();
let requester = null;

// server.js wires the Slack approval surface in: (request) → Promise<{ allow, pending, reason }>.
export function setSecretHostApprovalRequester(fn) {
  requester = typeof fn === "function" ? fn : null;
}

function neverApprovable(host) {
  return engineHostsFor().some((pattern) => hostMatches(pattern, host));
}

export function buildSecretHostAction({ channelId, slug, authorId = "", threadKey = "", secretName, scope, ownerId = "", host }) {
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
  };
}

function describe(action) {
  const where = action.scope === "organization" ? "organization-wide secret"
    : action.scope === "personal" ? `personal secret of <@${action.ownerId}>`
      : "this channel's secret";
  return `Allow the ${where} \`${action.secretName}\` to be sent to \`${action.host}\`?\n\n`
    + `A program in this channel's container just tried to use it there. Approving remembers ${action.host} for this secret: `
    + "every later run, schedule and SSH session may use it on that server (and only the servers approved so far). "
    + "Deny if you do not recognise the server — the request was refused and nothing was sent.";
}

// The proxy's onApprovalNeeded hook (via egress/service.js): refusals of one request, the channel
// context and the destination. Posts one durable card per secret+server in the live turn's thread.
export async function requestSecretHostApprovals(refusals, { channelId, slug, hostname } = {}) {
  const host = normalizeHost(hostname);
  if (!requester || !channelId || !slug || !isValidRuleHost(host) || neverApprovable(host)) return [];
  const turn = liveTurnIn(channelId);
  // No live turn (an SSH session or a background job alone): there is no thread to ask in. The 403
  // still says approval is needed; an admin can approve with allow_secret_host.
  if (!turn?.threadKey) return [];
  const out = [];
  for (const refusal of refusals) {
    if (!refusal?.secretName || !SCOPES.has(refusal.scope)) continue;
    const action = buildSecretHostAction({
      channelId, slug, authorId: turn.ownerId, threadKey: turn.threadKey,
      secretName: refusal.secretName, scope: refusal.scope, ownerId: refusal.owner || "", host,
    });
    const key = `${action.scope}\0${action.scope === "organization" ? "" : action.scope === "personal" ? action.ownerId : channelId}\0${action.secretName}\0${host}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < RECENT_MS) continue;
    recent.set(key, now);
    out.push(await requester({
      channelId, slug, authorId: turn.ownerId, threadKey: turn.threadKey,
      toolName: `Use secret ${action.secretName} on ${host}`,
      toolInput: { details: describe(action) },
      approvalType: "agent",
      requiredTier: "admin",
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
    if (neverApprovable(host)) throw new Error(`${host} is an engine API: a secret is never swapped there.`);
    // The human factor again, at execution time: the admin UI and a decision link re-check their
    // own authority on their routes; a Slack click must still be an admin's today.
    if (record.decidedBy !== "admin UI" && record.decidedBy !== "link" && !(await isAdminPrincipal(record.decidedBy))) {
      throw new Error("Only an admin can approve where a secret may be sent.");
    }
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
