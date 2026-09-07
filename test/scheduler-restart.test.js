import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const store = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");
const MIN = 60_000;
const base = new Date(2026, 8, 7, 9, 0).getTime();
let posts;
let timer;
const saved = (id) => store.getSchedules().find((row) => row.id === id);
const cronAt = (ms) => `${new Date(ms).getMinutes()} ${new Date(ms).getHours()} * * *`;
function fixture(patch = {}) {
  const row = store.addSchedule({ channelId: "C_RESTART", slug: "restart", kind: "reminder",
    cron: cronAt(base), prompt: "restart marker", notify: "none", ...patch });
  return store.updateSchedule(row.id, { createdAt: new Date(base - 24 * 60 * MIN).toISOString() });
}
function slack() {
  return { snapshot: () => ({ connected: true }), getClient: () => ({ chat: {
    postMessage: async (payload) => { posts.push(payload); return { ts: "1788771600.000001", ok: true }; },
  } }) };
}
function restart() {
  scheduler.resetSchedulerState();
}
beforeEach(() => {
  getDb().exec("DELETE FROM schedules");
  store.saveSchedulerCursor(0);
  scheduler.resetSchedulerState();
  posts = [];
  timer = scheduler.startScheduler({ slack: slack(), immediate: false });
});
afterEach(() => clearInterval(timer));

test("restart across the due minute catches up once and a fresh process cannot replay it", async () => {
  const row = fixture();
  await scheduler.tick(base - 10_000);
  restart();
  await scheduler.tick(base + MIN + 2_000);
  assert.equal(posts.length, 1);
  assert.equal(saved(row.id).lastCronFireMs, base);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const scheduler = await import('./src/gateway/scheduler.js');
    const timer = scheduler.startScheduler({ immediate:false, slack: {
      snapshot: () => ({ connected:true }), getClient: () => ({ chat: {
        postMessage: async () => { throw new Error('DUPLICATE_REPLAY'); }
      } })
    } });
    await scheduler.tick(${base + MIN + 3_000});
    clearInterval(timer);
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /DUPLICATE_REPLAY|schedule_run/);
});

test("cold upgraded boot catches recent cron only, excluding ancient and newly created rows", async () => {
  const recent = fixture();
  const ancient = fixture({ cron: cronAt(base - 10 * MIN), prompt: "ancient" });
  const newborn = fixture({ prompt: "newborn" });
  store.updateSchedule(newborn.id, { createdAt: new Date(base + MIN).toISOString() });
  await scheduler.tick(base + 2 * MIN);
  assert.deepEqual(posts.map((p) => p.text), ["⏰ *Reminder:* restart marker"]);
  assert.equal(saved(recent.id).lastCronFireMs, base);
  assert.equal(saved(ancient.id).lastCronFireMs, undefined);
  assert.equal(saved(newborn.id).lastCronFireMs, undefined);
});

test("enabling or changing a cron cannot backfill minutes from the former configuration", async () => {
  const enabled = fixture();
  store.updateSchedule(enabled.id, { enabled: false });
  store.updateSchedule(enabled.id, { enabled: true });
  const changed = fixture({ cron: cronAt(base - MIN) });
  store.updateSchedule(changed.id, { cron: cronAt(base) });
  // Normalize the test clock; the real store stamps the mutation's wall-clock timestamp.
  for (const row of [enabled, changed]) {
    assert.ok(saved(row.id).cronEligibleSince);
    store.updateSchedule(row.id, { cronEligibleSince: new Date(base + MIN).toISOString() });
  }
  await scheduler.tick(base + 2 * MIN);
  assert.equal(posts.length, 0);
});

test("legacy execution markers survive the first upgrade catch-up", async () => {
  const row = fixture();
  store.updateSchedule(row.id, { lastRun: new Date(base + 20_000).toISOString(), lastStatus: "ok" });
  await scheduler.tick(base + 2 * MIN);
  assert.equal(posts.length, 0);
});

test("claims are durable and monotonic, including distinct epoch minutes with the same local label", () => {
  const row = fixture();
  assert.ok(store.claimScheduleMinute(row.id, base, "fold-minute"));
  assert.equal(store.claimScheduleMinute(row.id, base, "fold-minute"), null);
  assert.equal(store.claimScheduleMinute(row.id, base - MIN, "older"), null);
  assert.ok(store.claimScheduleMinute(row.id, base + 60 * MIN, "fold-minute"));
});

test("a cron or eligibility edit after a tick snapshot invalidates that snapshot's claim", () => {
  const row = fixture();
  store.updateSchedule(row.id, { cron: cronAt(base + MIN) });
  assert.equal(store.claimScheduleMinute(row.id, base, "edited", row), null);
  const snapshot = saved(row.id);
  store.updateSchedule(row.id, { enabled: false });
  store.updateSchedule(row.id, { enabled: true, cronEligibleSince: "old" });
  // A deterministic distinct boundary avoids depending on millisecond clock advancement.
  store.updateSchedule(row.id, { cronEligibleSince: new Date(base + 2 * MIN).toISOString() });
  assert.equal(store.claimScheduleMinute(row.id, base + MIN, "reenabled", snapshot), null);
});

test("a task claimed before a crash executes once; a running checkpoint is paused without replay", async () => {
  const queued = fixture({ kind: "task", delivery: "channel" });
  store.claimScheduleMinute(queued.id, base, "queued");
  const unknown = fixture({ kind: "task" });
  store.updateSchedule(unknown.id, { executionState: "running" });
  let executions = 0;
  await scheduler.tick(base + MIN, { runner: async () => { executions++; return { content: "done", engine: "claude" }; }, deliver: async () => {} });
  assert.equal(executions, 1);
  assert.equal(saved(queued.id).executionState, "delivered");
  assert.equal(saved(unknown.id).enabled, false);
  assert.equal(saved(unknown.id).executionState, "interrupted");
  restart();
  await scheduler.tick(base + MIN + 2_000, { runner: async () => { executions++; } });
  assert.equal(executions, 1);
});

test("saved results retry delivery without executing tools or consuming a new cron minute", async () => {
  const row = fixture({ kind: "task", delivery: "channel" });
  store.updateSchedule(row.id, { lastCronFireMs: base, executionState: "completed", pendingDelivery: { content: "saved" } });
  let delivered = 0;
  await scheduler.tick(base + MIN, { runner: async () => assert.fail("must not execute"), deliver: async () => { delivered++; } });
  assert.equal(delivered, 1);
  assert.equal(saved(row.id).lastCronFireMs, base);
});

test("brief transport outage leaves recurring fire unclaimed and recovers after restart", async () => {
  const row = fixture();
  clearInterval(timer);
  timer = scheduler.startScheduler({ slack: { snapshot: () => ({ connected: false }) }, immediate: false });
  await scheduler.tick(base);
  assert.equal(saved(row.id).lastCronFireMs, undefined);
  restart();
  clearInterval(timer);
  timer = scheduler.startScheduler({ slack: slack(), immediate: false });
  await scheduler.tick(base + MIN);
  assert.equal(posts.length, 1);
});

test("busy tasks never claim a future fire that did not execute", async () => {
  const row = fixture({ kind: "task", cron: "* * * * *", delivery: "channel" });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = scheduler.tick(base, { runner: async () => { await blocked; return { content: "done" }; }, deliver: async () => {} });
  // Admission is synchronous and owns the running set before awaiting the engine.
  const claimed = saved(row.id).lastCronFireMs;
  await scheduler.tick(base + MIN);
  assert.equal(saved(row.id).lastCronFireMs, claimed);
  release();
  await first;
});

test("startup evaluates overdue work immediately instead of waiting sixty seconds", async () => {
  clearInterval(timer);
  const now = Date.now();
  const row = fixture({ cron: cronAt(now - MIN) });
  store.updateSchedule(row.id, { createdAt: new Date(now - 10 * MIN).toISOString() });
  let posted;
  const delivered = new Promise((resolve) => { posted = resolve; });
  timer = scheduler.startScheduler({ slack: { snapshot: () => ({ connected: true }), getClient: () => ({
    chat: { postMessage: async () => { posted(); return { ts: "1788771600.000001", ok: true }; } },
  }) } });
  await delivered;
  assert.equal(saved(row.id).lastCronFireMs, Math.floor((now - MIN) / MIN) * MIN);
});

test("scheduler failure notification unwraps provider JSON into a sentence", async () => {
  const row = fixture({ kind: "task", delivery: "channel" });
  await scheduler.tick(base, { runner: async () => { throw new Error('{"error":{"message":"The selected model is unavailable."}}'); } });
  const message = posts.find((p) => /Scheduled run failed/.test(p.text));
  assert.equal(message.text, "⏰ Scheduled run failed: The selected model is unavailable.");
  assert.equal(saved(row.id).enabled, false);
});
