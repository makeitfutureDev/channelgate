import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { channelSpendingAdmission, assertSpendingLimitUpdate, normalizeSpendingLimit } = await import("../src/ee/channel-spending.js");
const { monthlyChannelSpend } = await import("../src/gateway/usage.js");
const { saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const now = Date.parse("2026-11-06T12:00:00Z");
const db = getDb();
function usage(channelId, date, cost) {
  return Number(db.prepare(`INSERT INTO usage(ts, channel_id, slug, author_id, engine, model,
    task_kind, tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms)
    VALUES(?, ?, 'spending', 'U', 'claude', 'test', 'interactive', 1, 1, ?, 0, 1)`).run(date, channelId, cost).lastInsertRowid);
}
test.beforeEach(() => { testLicenseEnv(); db.exec("DELETE FROM usage_components; DELETE FROM usage"); });

test("positive finite limits and explicit clearing; reject malformed amounts", () => {
  for (const bad of [-1, 0, NaN, Infinity, "2", {}, true, undefined]) assert.throws(() => normalizeSpendingLimit(bad), /positive finite/);
  assert.equal(normalizeSpendingLimit(0.01), 0.01);
  assert.equal(normalizeSpendingLimit(null), null);
});
test("admission counts only this channel and UTC month, then resets next month", () => {
  usage("C_BUDGET", "2026-10-31T23:59:59Z", 50);
  usage("OTHER", "2026-11-01T00:00:00Z", 50);
  usage("C_BUDGET", "2026-11-01T00:00:00Z", 3);
  const args = { channelId: "C_BUDGET", meta: { monthlySpendingLimitUSD: 5 }, now };
  assert.equal(channelSpendingAdmission(args).allowed, true);
  usage("C_BUDGET", "2026-11-06T01:00:00Z", 2);
  const refused = channelSpendingAdmission(args);
  assert.equal(refused.allowed, false);
  assert.match(refused.notice, /\$5.00.*2026-11/);
  assert.equal(channelSpendingAdmission({ ...args, now: Date.parse("2026-12-01T00:00:00Z") }).allowed, true);
});
test("native components replace raw cumulative cost without double counting", () => {
  const id = usage("COMPONENT", "2026-11-01T00:00:00Z", 99);
  db.prepare(`INSERT INTO usage_components(usage_id, source_key, source_kind, model, cost_usd)
    VALUES(?, 'component-budget', 'root', 'test', 2)`).run(id);
  assert.equal(monthlyChannelSpend("COMPONENT", now).spentUSD, 2);
});
test("unpriced current usage refuses instead of treating unknown cost as zero", () => {
  usage("UNKNOWN", "2026-11-01T00:00:00Z", null);
  const args = { channelId: "UNKNOWN", meta: { monthlySpendingLimitUSD: 5 }, now };
  assert.match(channelSpendingAdmission(args).notice, /no price/);
  assert.equal(channelSpendingAdmission({ ...args, meta: {} }).allowed, true);
});
test("Free cannot create a limit; existing safety cap blocks until cleared; Enterprise restoration keeps cap", async () => {
  await saveChannelMeta("budget-store", { channelId: "BUDGET_STORE", monthlySpendingLimitUSD: 5 });
  await saveChannelMeta("budget-store", { channelId: "BUDGET_STORE", name: "Unrelated whole-record edit" });
  assert.equal((await getChannelMeta("budget-store")).monthlySpendingLimitUSD, 5);
  clearTestLicense();
  assert.throws(() => assertSpendingLimitUpdate({}, 5), /Enterprise/);
  await assert.rejects(saveChannelMeta("budget-store", { monthlySpendingLimitUSD: 6 }), /Enterprise/);
  const meta = await getChannelMeta("budget-store");
  assert.equal(meta.monthlySpendingLimitUSD, 5);
  assert.equal(channelSpendingAdmission({ channelId: "BUDGET_STORE", meta, now }).allowed, false);
  assert.equal(assertSpendingLimitUpdate(meta, null), null);
  testLicenseEnv();
  assert.equal(channelSpendingAdmission({ channelId: "BUDGET_STORE", meta, now }).allowed, true);
});
