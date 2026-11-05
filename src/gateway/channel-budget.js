// Channel budgets use recorded USD spend, including estimated costs and all task kinds.
// This is admission control: active runs may overshoot; unpriced runs cannot be valued.
import { getChannelMeta } from "../config/store.js";
import { channelMonthSpend } from "./usage.js";

export function validateMonthlyBudget(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw Object.assign(new Error("Monthly budget must be null (unlimited) or a non-negative USD amount with at most two decimal places."), { statusCode: 400 });
  }
  return value;
}

export function channelBudgetStatus(channelId, meta = {}, now = new Date()) {
  const limitUSD = meta?.monthlyBudgetUSD ?? null;
  if (limitUSD !== null) validateMonthlyBudget(limitUSD); // corrupt policy fails closed
  const spend = channelMonthSpend(channelId, now);
  return { ...spend, limitUSD, remainingUSD: limitUSD === null ? null : Math.max(0, limitUSD - spend.spentUSD),
    exhausted: limitUSD !== null && spend.spentUSD >= limitUSD };
}

export function budgetRefusal(status, { slug = "", engine = "" } = {}) {
  return { slug, cwd: "", model: "", engine, budgetRefused: true, budget: status,
    content: `This channel has reached its monthly USD budget ($${status.spentUSD.toFixed(2)} recorded / $${status.limitUSD.toFixed(2)} limit for ${status.month}, UTC). New agent runs are paused until ${status.resetsAt.slice(0, 10)} UTC or an admin raises or removes the budget in the admin UI.`,
    sessionId: null, isNew: false, usage: {}, costUSD: 0, durationMs: 0 };
}

export async function assertChannelBudget(channelId, slug) {
  const meta = (await getChannelMeta(slug)) || {};
  if (meta.monthlyBudgetUSD == null) return;
  const status = channelBudgetStatus(channelId, meta);
  if (status.exhausted) throw Object.assign(new Error(budgetRefusal(status).content), {
    code: "channel_budget_exhausted", budget: status,
    details: { replaySafe: false, providerError: false },
  });
}
