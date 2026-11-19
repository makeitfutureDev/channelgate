// Managed harness policy belongs to the conversation, independently of the current license.
// Enterprise admits changes; a downgrade must never silently widen an existing restriction.
import { ENGINE_IDS, adapterFor, engineLabel, harnessOf, isEngineId } from "../engines/registry.js";
import { RETIRED_ENGINE_IDS, isRetiredEngineId } from "../engines/retired.js";
import { HARNESS_IDS, harnessLabel, isLicenseShapedId } from "../engines/license-state.js";
import { getLicenseStatus } from "../ee/license.js";

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

export function isChannelEngineApproved(meta, engine) {
  if (!isEngineId(engine)) return false;
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
  throw Object.assign(new Error(`${engineLabel(engine)} is not an approved harness for this channel. Select an approved harness in channel or thread settings, or ask an Enterprise administrator to update Approved harnesses.`), {
    status: 403, statusCode: 403, code: "channel_engine_not_approved", details: { channelEngineRefused: true, engine },
  });
}

// Channel account harnesses belong only in this conversation's picker, never gateway/user defaults.
export function engineAvailableForChannel(meta, engine) {
  const adapter = adapterFor(engine);
  return Boolean(adapter && (!adapter.channelScoped || (meta?.channelId && meta?.codexAuthSource === "channel")));
}
