// Managed harness policy belongs to the conversation, independently of the current license.
// Enterprise admits changes; a downgrade must never silently widen an existing restriction.
import { ENGINE_IDS, adapterFor, engineLabel, harnessOf, isEngineId } from "../engines/registry.js";
import { RETIRED_ENGINE_IDS, isRetiredEngineId } from "../engines/retired.js";
import { HARNESS_IDS, harnessLabel, isLicenseShapedId, licenseChannelOf } from "../engines/license-state.js";
import { getLicenseStatus } from "../ee/license.js";
import { enterpriseFeatureEnabled } from "../ee/feature-entitlements.js";

// A policy entry is a LICENSE (an engine id: only that credential may run here) or a whole
// HARNESS, written `harness:claude` / `harness:codex`: every license of that harness, including
// ones an administrator adds later. A plain `claude` or `codex` keeps meaning exactly what it
// always did — that harness's default sign-in and nothing else — so no stored policy widens.
export const HARNESS_POLICY_PREFIX = "harness:";
export const harnessPolicyEntry = (harness) => `${HARNESS_POLICY_PREFIX}${harness}`;
const harnessOfEntry = (id) => (typeof id === "string" && id.startsWith(HARNESS_POLICY_PREFIX) && HARNESS_IDS.includes(id.slice(HARNESS_POLICY_PREFIX.length)) ? id.slice(HARNESS_POLICY_PREFIX.length) : "");
// Stored ids that name nothing runnable any more: a harness an earlier release shipped
// (engines/retired.js), or a license an administrator has since removed. Both are stored data to
// step over, never malformed input.
const isGoneEngineId = (id) => isRetiredEngineId(id) || (isLicenseShapedId(id) && !isEngineId(id));
const isPolicyEntry = (id) => typeof id === "string" && (isEngineId(id) || Boolean(harnessOfEntry(id)) || isGoneEngineId(id));

// A stored policy may still name a harness an earlier release shipped (engines/retired.js) or a
// license that was removed. That id approves nothing and is not a malformed entry either: the
// policy keeps its remaining entries, so retiring an engine or deleting a license neither refuses
// every turn in the channel nor makes every later save of its settings fail. A policy that named
// ONLY such ids is kept exactly as stored — it still approves nothing, because dropping it would
// silently widen a restriction — until an entitled administrator picks what this channel may use.
export function normalizeApprovedEngines(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.some(id => !isPolicyEntry(id))) {
    throw Object.assign(new Error(`Approved harnesses must be null (all) or a nonempty list of harnesses (${HARNESS_IDS.map(harnessPolicyEntry).join(", ")}) and licenses (${ENGINE_IDS.join(", ")}).`), { status: 400, statusCode: 400, code: "invalid_approved_engines" });
  }
  const current = [...HARNESS_IDS.map(harnessPolicyEntry).filter(id => value.includes(id)), ...ENGINE_IDS.filter(id => value.includes(id))];
  if (current.length) return current;
  return [...RETIRED_ENGINE_IDS.filter(id => value.includes(id)), ...[...new Set(value)].filter(id => !isRetiredEngineId(id) && isGoneEngineId(id)).sort()];
}

export function assertApprovedEnginesUpdate(meta, value, { enterprise = getLicenseStatus().features.channelHarnessPolicy } = {}) {
  const next = normalizeApprovedEngines(value);
  // Compare membership, not presentation order. Unknown legacy policy remains fail-closed and
  // can only be repaired by an entitled administrator.
  let current;
  try { current = normalizeApprovedEngines(meta?.approvedEngines); } catch { current = meta?.approvedEngines; }
  if (JSON.stringify(current) !== JSON.stringify(next) && !enterprise) {
    throw Object.assign(new Error("Changing a channel's approved harnesses requires an active Enterprise license."), { status: 403, statusCode: 403, code: "enterprise_required" });
  }
  return next;
}

// ── Licenses limited to one conversation (src/engines/license-state.js) ─────────────────────
// The conversations a channel record stands for: its own id and, for a code channel, the channel it
// was opened from — a code channel runs on its origin's policy, secrets and files, so it is the
// same conversation as far as "whose account is this" goes. A workspace link shares a folder, not
// an account, and admits nothing.
const conversationIdsOf = (meta) => [meta?.channelId, meta?.codeChannel?.originChannelId].filter((id) => typeof id === "string" && id);

// A license nobody limited fits everywhere. A limited one fits its own conversation only; a record
// with no conversation id (a template, a gateway-wide question) is never that conversation.
export const licenseFitsConversation = (meta, engine) => {
  const limit = licenseChannelOf(engine);
  return !limit || conversationIdsOf(meta).includes(limit);
};

// Limiting a license to a conversation is the Enterprise capability a channel's own sign-in always
// was. Asked only for a license that IS limited, and it never widens one: without the entitlement
// a limited license runs nowhere, not everywhere.
const channelLicensesEntitled = () => enterpriseFeatureEnabled("channelCodexLogin");

// Why a limit stops `engine` in this conversation: "" (it does not), "elsewhere" or "enterprise".
export function licenseLimitRefusal(meta, engine, { enterprise } = {}) {
  if (!licenseChannelOf(engine)) return "";
  if (!licenseFitsConversation(meta, engine)) return "elsewhere";
  return (enterprise ?? channelLicensesEntitled()) ? "" : "enterprise";
}

const LIMIT_REFUSALS = Object.freeze({
  elsewhere: (engine) => `${engineLabel(engine)} is limited to another conversation and cannot be used in this one.`,
  enterprise: (engine) => `${engineLabel(engine)} is limited to this conversation, and licenses limited to one conversation need an active Enterprise license.`,
});

// Writers: setting a limit (src/config/engine-licenses.js) is refused without the entitlement.
// Clearing one is always allowed — it is the way out after a downgrade.
export function assertChannelLimitedLicensesEntitled({ enterprise } = {}) {
  if (enterprise ?? channelLicensesEntitled()) return;
  throw Object.assign(new Error("Limiting a license to one conversation requires an active Enterprise license."), { status: 403, statusCode: 403, code: "enterprise_required" });
}

export function isChannelEngineApproved(meta, engine) {
  if (!isEngineId(engine)) return false;
  // First, and whatever the approved list says: a license limited to one conversation exists
  // nowhere else. Every run, fallback, pin, job, SSH session and credential swap asks here.
  if (licenseLimitRefusal(meta, engine)) return false;
  const policy = meta?.approvedEngines;
  if (policy == null) return true;
  // Malformed persisted policies are never interpreted as unrestricted. A retired harness in one
  // is stepped over (see normalizeApprovedEngines); it never approves anything by itself.
  if (!Array.isArray(policy) || !policy.length || !policy.every(isPolicyEntry)) return false;
  return policy.includes(engine) || policy.includes(harnessPolicyEntry(harnessOf(engine)));
}

// How a stored policy reads to a person: "Claude Code (any license), Work ChatGPT".
export function describeApprovedEngines(policy) {
  if (!Array.isArray(policy)) return "";
  return policy.filter(id => harnessOfEntry(id) || isEngineId(id)).map(id => harnessOfEntry(id) ? `${harnessLabel(harnessOfEntry(id))} (any license)` : engineLabel(id)).join(", ");
}

export function assertChannelEngineApproved(meta, engine) {
  if (isChannelEngineApproved(meta, engine)) return;
  const limited = isEngineId(engine) ? licenseLimitRefusal(meta, engine) : "";
  if (limited) {
    throw Object.assign(new Error(`${LIMIT_REFUSALS[limited](engine)} Select another license in channel or thread settings.`), {
      status: 403, statusCode: 403, code: "channel_engine_not_approved", details: { channelEngineRefused: true, engine, licenseLimit: limited },
    });
  }
  throw Object.assign(new Error(`${engineLabel(engine)} is not an approved harness for this channel. Select an approved harness in channel or thread settings, or ask an Enterprise administrator to update Approved harnesses.`), {
    status: 403, statusCode: 403, code: "channel_engine_not_approved", details: { channelEngineRefused: true, engine },
  });
}

// What a person is told when the pick they typed is outside this conversation's allow list ("" when
// the pick is allowed): what was refused, then what the conversation may use instead. Anyone who
// may talk here may pick a license or model, so the refusal has to be an answer, not a log line.
export function channelEngineRefusal(meta, engine) {
  if (isChannelEngineApproved(meta, engine)) return "";
  const limited = isEngineId(engine) ? licenseLimitRefusal(meta, engine) : "";
  if (limited) return `${LIMIT_REFUSALS[limited](engine)} Pick another license for this conversation.`;
  const approved = describeApprovedEngines(meta?.approvedEngines);
  return `${engineLabel(engine)} is not approved for this conversation. ${approved
    ? `Approved here: ${approved}. Pick one of those, or ask an Enterprise administrator to change Approved harnesses in the channel settings.`
    : "Ask an Enterprise administrator to review Approved harnesses in the channel settings."}`;
}

// Channel account harnesses belong only in this conversation's picker, never gateway/user defaults.
// The same goes for a license an administrator limited to one conversation.
export function engineAvailableForChannel(meta, engine) {
  const adapter = adapterFor(engine);
  return Boolean(adapter && (!adapter.channelScoped || (meta?.channelId && meta?.codexAuthSource === "channel")) && licenseFitsConversation(meta, engine));
}
