// Admission for the canonical Enterprise channel spending policy. Rechecked at each spawn.
import { getChannelMeta } from "../config/store.js";
import { monthlyChannelSpend } from "./usage.js";
import { channelSpendingAdmission } from "../ee/channel-spending.js";

export function channelBudgetStatus(channelId, meta = {}, now = new Date()) {
  const date = new Date(now);
  const limitUSD = meta?.monthlySpendingLimitUSD ?? null;
  const spend = monthlyChannelSpend(channelId, date.getTime());
  const admission = channelSpendingAdmission({ channelId, meta, now: date.getTime() });
  return { ...spend, limitUSD,
    resetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    remainingUSD: limitUSD === null ? null : Math.max(0, limitUSD - spend.spentUSD),
    exhausted: limitUSD !== null && spend.spentUSD >= limitUSD,
    allowed: admission.allowed, notice: admission.notice || "" };
}

export function budgetRefusal(status, { slug = "", engine = "", engineStarted = false } = {}) {
  return { slug, cwd: "", model: "", engine, engineStarted, budgetRefused: true, spendingRefused: true, budget: status,
    content: status.notice,
    sessionId: null, isNew: false, usage: {}, costUSD: 0, durationMs: 0 };
}

export async function assertChannelBudget(channelId, slug) {
  const meta = (await getChannelMeta(slug)) || {};
  if (meta.monthlySpendingLimitUSD == null) return;
  const status = channelBudgetStatus(channelId, meta);
  if (!status.allowed) throw Object.assign(new Error(status.notice), {
    code: "channel_spending_limit", budget: status,
    details: { replaySafe: false, providerError: false },
  });
}
