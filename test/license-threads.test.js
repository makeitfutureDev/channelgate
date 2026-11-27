import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";
ensureTestEnv();
const { licenseAdmission, resetLicenseUsage, usageTotals, conversationUsage, buildUsageReport } = await import("../src/ee/limits.js");
const { normalizeLimits, NO_KEY_LIMITS } = await import("../src/ee/tiers.js");
const { getDb } = await import("../src/db/index.js");
const admit = (channel, thread, options = {}) => licenseAdmission({ conversationId: channel, threadKey: thread, ...options });
function reset(tier = "free", limits) {
  resetLicenseUsage();
  if (tier === "none") clearTestLicense(); else testLicenseEnv({ tier, limits: { ...(tier === "free" ? { messagesPerConversationPerMonth: 500 } : {}), ...limits } });
}

test("100 threads in each channel, retries, equal IDs in other channels, and refusal counters", () => {
  reset();
  for (const channel of ["A", "B"]) {
    for (let i = 0; i < 100; i++) assert.equal(admit(channel, `thread-${i}`).allowed, true);
    const refused = admit(channel, "thread-101");
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, "channel_conversation_limit");
    assert.match(refused.notice, /channel.*100 active conversation threads/);
    assert.equal(refused.runs, 100);
    assert.equal(admit(channel, "thread-0").allowed, true);
  }
  assert.equal(usageTotals().activeConversations, 200);
  assert.equal(usageTotals().runs, 202);
  for (const channel of conversationUsage()) {
    assert.equal(channel.activeConversations, 100);
    assert.equal(channel.runs, 101);
  }
  assert.equal(buildUsageReport().conversations.reduce((sum, row) => sum + row.count, 0), 202);
});

test("500 channel runs is checked before a new thread can consume a slot", () => {
  reset();
  for (let i = 0; i < 500; i++) assert.equal(admit("A", "existing").allowed, true);
  assert.equal(admit("A", "new").reason, "monthly_cap");
  assert.equal(usageTotals().runs, 500);
  assert.equal(usageTotals().activeConversations, 1);
  assert.equal(admit("B", "existing").allowed, true);
});

test("missing thread identity is stable and memory-review touches neither ledger", () => {
  reset();
  for (const options of [{ origin: "memory_review" }, { toolset: "memory-review" }]) {
    assert.equal(admit("exempt", "never", options).exempt, true);
  }
  assert.equal(usageTotals().conversations, 0);
  assert.equal(usageTotals().activeConversations, 0);
  for (let i = 0; i < 3; i++) assert.equal(admit("A").allowed, true);
  assert.equal(admit("A", null).allowed, true);
  assert.equal(usageTotals().activeConversations, 1);
});

test("thread allowance resets at UTC rollover and reset can clear one month or all months", () => {
  reset("free", { conversationsPerChannelPerMonth: 1 });
  const june = Date.UTC(2026, 5, 30, 23, 59, 59);
  const july = Date.UTC(2026, 6, 1);
  assert.equal(admit("A", "first", { now: june }).allowed, true);
  assert.equal(admit("A", "second", { now: june }).allowed, false);
  assert.equal(admit("A", "second", { now: july }).allowed, true);
  assert.equal(usageTotals({ month: "2026-06" }).activeConversations, 1);
  resetLicenseUsage({ month: "2026-06" });
  assert.equal(usageTotals({ month: "2026-06" }).activeConversations, 0);
  assert.equal(usageTotals({ month: "2026-07" }).activeConversations, 1);
  resetLicenseUsage();
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM license_thread_usage").get().n, 0);
});

test("Enterprise threads are tracked and grandfathered after a stricter signed Free allowance", () => {
  reset("enterprise");
  for (let i = 0; i < 101; i++) assert.equal(admit("A", String(i)).allowed, true);
  testLicenseEnv({ tier: "free", limits: { conversationsPerChannelPerMonth: 1 } });
  assert.equal(admit("A", "100").allowed, true);
  assert.equal(admit("A", "new").reason, "channel_conversation_limit");
  assert.equal(admit("B", "0").allowed, true);
  assert.equal(admit("B", "1").allowed, false);
  assert.equal(usageTotals().activeConversations, 102);
});

test("legacy signed fields cannot enlarge thread allowance; stricter values and no-key evaluation work", () => {
  for (const value of [undefined, null, 1000, "100", -1, NaN]) {
    assert.equal(normalizeLimits({ conversationsPerChannelPerMonth: value }, "free").conversationsPerChannelPerMonth, 100);
  }
  assert.equal(normalizeLimits({}, "free").conversationsPerChannelPerMonth, 100);
  assert.equal(normalizeLimits({ conversationsPerChannelPerMonth: 2 }, "free").conversationsPerChannelPerMonth, 2);
  assert.equal(normalizeLimits({}, "enterprise").conversationsPerChannelPerMonth, null);
  assert.equal(normalizeLimits({ conversationsPerChannelPerMonth: 2 }, "enterprise").conversationsPerChannelPerMonth, 2);
  assert.equal(NO_KEY_LIMITS.conversationsPerChannelPerMonth, 100);
  reset("none");
  for (let i = 0; i < 100; i++) assert.equal(admit("A", String(i)).allowed, true);
  assert.equal(admit("A", "101").reason, "channel_conversation_limit");
  assert.equal(admit("B", "first").reason, "conversation_limit");
  reset("free", { conversationsPerChannelPerMonth: 0 });
  assert.equal(admit("A", "first").allowed, false);
  assert.equal(usageTotals().activeConversations, 0);
});

function childAdmission(thread) {
  const script = `const {licenseAdmission}=await import('./src/ee/limits.js'); console.log(JSON.stringify(licenseAdmission({conversationId:'A',threadKey:${JSON.stringify(thread)}})));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: process.env });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.once("error", reject);
    child.once("close", code => code ? reject(new Error(err)) : resolve(JSON.parse(out.trim().split("\n").at(-1))));
  });
}

test("two processes racing the last thread slot admit exactly one new thread", async () => {
  reset();
  for (let i = 0; i < 99; i++) admit("A", String(i));
  const results = await Promise.all([childAdmission("race-a"), childAdmission("race-b")]);
  assert.equal(results.filter(r => r.allowed).length, 1);
  assert.equal(results.filter(r => r.reason === "channel_conversation_limit").length, 1);
  assert.equal(usageTotals().activeConversations, 100);
  assert.equal(usageTotals().runs, 100);
});
