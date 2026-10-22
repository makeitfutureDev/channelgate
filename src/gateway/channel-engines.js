// Managed harness policy belongs to the conversation, independently of the current license.
// Enterprise admits changes; a downgrade must never silently widen an existing restriction.
import { ENGINE_IDS, engineLabel, isEngineId } from "../engines/registry.js";
import { getLicenseStatus } from "../ee/license.js";

export function normalizeApprovedEngines(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== "string" || !isEngineId(id))) {
    throw Object.assign(new Error(`Approved harnesses must be null (all) or a nonempty list of: ${ENGINE_IDS.join(", ")}.`), { status: 400, statusCode: 400, code: "invalid_approved_engines" });
  }
  return ENGINE_IDS.filter(id => value.includes(id));
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
  // Malformed persisted policies are never interpreted as unrestricted.
  return Array.isArray(policy) && policy.length > 0 && policy.every(isEngineId) && policy.includes(engine);
}

export function assertChannelEngineApproved(meta, engine) {
  if (isChannelEngineApproved(meta, engine)) return;
  throw Object.assign(new Error(`${engineLabel(engine)} is not an approved harness for this channel. Select an approved harness in channel or thread settings, or ask an Enterprise administrator to update Approved harnesses.`), {
    status: 403, statusCode: 403, code: "channel_engine_not_approved", details: { channelEngineRefused: true, engine },
  });
}
