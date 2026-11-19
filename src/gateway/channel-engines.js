// Managed harness policy belongs to the conversation, independently of the current license.
// Enterprise admits changes; a downgrade must never silently widen an existing restriction.
import { ENGINE_IDS, adapterFor, engineLabel, isEngineId } from "../engines/registry.js";
import { RETIRED_ENGINE_IDS, isRetiredEngineId } from "../engines/retired.js";
import { getLicenseStatus } from "../ee/license.js";

// A stored policy may still name a harness an earlier release shipped (engines/retired.js). That
// id approves nothing and is not a malformed entry either: the policy keeps its remaining
// harnesses, so retiring an engine neither refuses every turn in the channel nor makes every
// later save of its settings fail. A policy that named ONLY retired harnesses is kept exactly as
// stored — it still approves nothing, because dropping it would silently widen a restriction —
// until an entitled administrator picks the harnesses this channel may use.
export function normalizeApprovedEngines(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== "string" || !(isEngineId(id) || isRetiredEngineId(id)))) {
    throw Object.assign(new Error(`Approved harnesses must be null (all) or a nonempty list of: ${ENGINE_IDS.join(", ")}.`), { status: 400, statusCode: 400, code: "invalid_approved_engines" });
  }
  const current = ENGINE_IDS.filter(id => value.includes(id));
  return current.length ? current : RETIRED_ENGINE_IDS.filter(id => value.includes(id));
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
  return Array.isArray(policy) && policy.length > 0 && policy.every(id => isEngineId(id) || isRetiredEngineId(id)) && policy.includes(engine);
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
