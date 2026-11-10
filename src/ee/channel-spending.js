import { enterpriseFeatureEnabled, requireEnterpriseFeature } from "./feature-entitlements.js";
import { monthlyChannelSpend } from "../gateway/usage.js";

export function normalizeSpendingLimit(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    const error = new Error("monthlySpendingLimitUSD must be a positive finite USD amount, or null for no limit.");
    error.status = error.statusCode = 400;
    throw error;
  }
  return value;
}

export function assertSpendingLimitUpdate(current, value) {
  const limit = normalizeSpendingLimit(value);
  if (limit !== null && limit !== current?.monthlySpendingLimitUSD) requireEnterpriseFeature("channelSpendingLimits");
  return limit;
}

export function channelSpendingAdmission({ channelId, meta, now = Date.now() }) {
  const limit = meta?.monthlySpendingLimitUSD;
  if (limit == null || limit === "") return { allowed: true };
  // Retain an operator's saved safety restriction on downgrade: refuse rather than silently
  // running without its budget. Clearing the restriction remains available on every tier.
  if (!enterpriseFeatureEnabled("channelSpendingLimits", now)) {
    return { allowed: false, notice: "This channel has a saved spending limit that requires Enterprise. Restore the Enterprise license or have an administrator clear the limit before starting new runs." };
  }
  try {
    normalizeSpendingLimit(limit);
    const usage = monthlyChannelSpend(channelId, now);
    if (usage.unpricedRuns > 0) return { allowed: false, ...usage, notice: `This channel's ${usage.month} spending cannot be verified because ${usage.unpricedRuns} recorded run(s) have no price. Repair usage pricing or have an administrator clear the spending limit before starting new runs.` };
    if (usage.spentUSD >= limit) return { allowed: false, ...usage, notice: `This channel has reached its $${limit.toFixed(2)} spending limit for ${usage.month} (UTC), with $${usage.spentUSD.toFixed(2)} recorded. New runs resume next UTC month, or an administrator can raise or clear the limit. Runs already underway may add further cost.` };
    return { allowed: true, ...usage, limitUSD: limit };
  } catch {
    return { allowed: false, notice: "This channel's spending limit could not be verified. Ask an administrator to check the limit and usage ledger before starting new runs." };
  }
}
