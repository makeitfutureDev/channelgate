import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { licenseAdmission, resetLicenseUsage, usageTotals } = await import("../src/ee/limits.js");
const { BackgroundJobs } = await import("../src/gateway/background.js");
const { createQuestion, updateQuestion } = await import("../src/gateway/questions.js");
const { addSchedule, updateSchedule } = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");

async function fixture() {
  resetLicenseUsage();
  testLicenseEnv({ tier: "free", limits: { messagesPerConversationPerMonth: 500 } });
  saveSettings({ engine: "claude", engineFallback: false, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal" });
  await setUser("UAUTO", { approved: true });
  const entry = await upsertChannelEntry("CAUTO", { name: "auto", type: "channel", platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId: "CAUTO", name: "auto", type: "channel", template: "custom", engine: "claude", cleanMode: true, allowNetwork: false });
  return { channelId: "CAUTO", authorId: "UAUTO", slug: entry.slug };
}

test("background agents at 100 threads reuse parent identity and nested signed context cannot override it", async () => {
  const context = await fixture();
  const parent = "1900000000.000001";
  for (let i = 0; i < 100; i++) licenseAdmission({ conversationId: context.channelId, threadKey: i === 0 ? parent : `thread-${i}` });
  const jobs = new BackgroundJobs();
  const done = new Promise(resolve => { jobs._finish = rec => { resolve(rec.result); }; });
  jobs._runAgent({ ...context, id: "background-unit", threadKey: parent, task: "Say done", maxMs: 30000, startedAt: Date.now() }, null, () => {});
  const result = await done;
  assert.ok(result);
  assert.equal(result.licenseRefused, undefined);
  assert.match(result.content, /resume=no/);
  assert.equal(usageTotals().activeConversations, 100);
  assert.equal(usageTotals().runs, 101);

  const secret = "automation-capability-secret";
  const token = mintGatewayCapability({ ...context, secret, threadKey: `${parent}::agent-background-unit`, admissionThreadKey: parent, origin: "background_agent" });
  const verified = verifyGatewayCapability(token, { secret });
  assert.equal(verified.ok, true);
  let payload;
  const ctx = ctxFromClaims(verified.claims, { daemon: { available: () => true, call: async (_kind, body) => { payload = body; } } });
  await ctx.daemon.call("background", { admissionThreadKey: "attacker-new-thread" });
  assert.equal(payload.admissionThreadKey, parent);
  const nestedDone = new Promise(resolve => { jobs._finish = rec => { resolve(rec.result); }; });
  jobs._runAgent({ ...context, id: "nested-unit", threadKey: `${parent}::agent-background-unit`, admissionThreadKey: payload.admissionThreadKey,
    task: "Say nested done", maxMs: 30000, startedAt: Date.now() }, null, () => {});
  assert.match((await nestedDone).content, /resume=no/);
  assert.equal(usageTotals().activeConversations, 100);
  assert.equal(usageTotals().runs, 102);
});

test("repeated schedule fires sharing a known delivery thread consume one slot and keep fresh sessions", async t => {
  const context = await fixture();
  const client = { chat: { postMessage: async body => ({ ok: true, ts: "1900000000.000002", channel: body.channel }) } };
  const timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  t.after(() => { clearInterval(timer); scheduler.resetSchedulerState(); });
  const schedule = addSchedule({ channelId: context.channelId, slug: context.slug, createdBy: context.authorId, cron: "0 * * * *", prompt: "Say done", delivery: "daily-thread", dailyThreadDate: scheduler.scheduleDayKey(), dailyThreadTs: "1900000000.000002" });
  const keys = [];
  for (let i = 0; i < 2; i++) {
    updateSchedule(schedule.id, { executionState: "idle", pendingDelivery: null });
    await scheduler.runSchedule({ ...schedule }, { runner: async args => {
      keys.push(args.threadKey);
      const admission = licenseAdmission({ conversationId: args.channelId, threadKey: args.admissionThreadKey });
      assert.equal(admission.allowed, true);
      return { content: "done", engine: "claude" };
    }, deliver: async () => {} });
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(usageTotals().activeConversations, 1);
  assert.equal(usageTotals().runs, 2);
});

test("scheduled question continuation bills original visible thread while resuming synthetic session", async () => {
  const context = await fixture();
  const visible = "1900000000.000003";
  licenseAdmission({ conversationId: context.channelId, threadKey: visible });
  const question = createQuestion({ ...context, threadKey: visible, sessionThreadKey: "sched-question-per-fire" }, { title: "Continue", questions: [{ id: "choice", prompt: "Continue?", type: "single", options: [{ label: "Yes", value: "yes" }] }] });
  updateQuestion(question.id, question.revision, { status: "submitted" });
  const result = await runMessage({ ...context, threadKey: visible, questionSubmissionId: question.id, origin: "slack_foreground", text: "Continue", preferCold: true });
  assert.match(result.content, /resume=no/);
  assert.equal(usageTotals().activeConversations, 1);
  assert.equal(usageTotals().runs, 2);
});

test("admission capability metadata rejects invalid types and oversized identities", () => {
  const identity = { secret: "cap-secret", channelId: "C", slug: "c", authorId: "U", threadKey: "session", origin: "background_agent" };
  for (const admissionThreadKey of [null, {}, [], 1, "x".repeat(2049)]) {
    assert.throws(() => mintGatewayCapability({ ...identity, admissionThreadKey }), /admission thread/);
    const valid = mintGatewayCapability(identity);
    const claims = JSON.parse(Buffer.from(valid.split(".")[0], "base64url").toString());
    claims.admissionThreadKey = admissionThreadKey;
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", identity.secret).update(payload).digest("base64url");
    assert.equal(verifyGatewayCapability(`${payload}.${signature}`, { secret: identity.secret }).ok, false);
  }
});
