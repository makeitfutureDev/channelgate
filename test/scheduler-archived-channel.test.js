import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const store = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");
const { listScheduleRuns } = await import("../src/gateway/schedule-runs.js");
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const MIN = 60_000;
const base = new Date(2026, 10, 12, 9, 0).getTime();
let posts;
let timer;
const saved = (id) => store.getSchedules().find((row) => row.id === id);
const cronAt = (ms) => `${new Date(ms).getMinutes()} ${new Date(ms).getHours()} * * *`;
const events = (name) => getDb().prepare("SELECT count(*) AS c FROM events WHERE event = ?").get(name).c;
let channelCount = 0;
async function channel({ archived = false } = {}) {
  const id = `C_SCHED_ARCH_${++channelCount}`;
  const entry = await upsertChannelEntry(id, { name: `sched-arch-${channelCount}`, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, type: "channel", isDM: false }),
    ...(archived ? { archived: true, archivedAt: new Date().toISOString(), archivedReason: "bot_removed", botMembership: "absent" } : {}) });
  return { id, slug: entry.slug };
}
function fixture(ch, patch = {}) {
  const row = store.addSchedule({ channelId: ch.id, slug: ch.slug, kind: "task", delivery: "channel",
    cron: cronAt(base), prompt: "weekly check", notify: "none", ...patch });
  return store.updateSchedule(row.id, { createdAt: new Date(base - 24 * 60 * MIN).toISOString() });
}
function slack() {
  return { snapshot: () => ({ connected: true }), getClient: () => ({ chat: {
    postMessage: async (payload) => { posts.push(payload); return { ts: "1794000000.000001", ok: true }; },
  } }) };
}
beforeEach(() => {
  getDb().exec("DELETE FROM schedules");
  store.saveSchedulerCursor(0);
  scheduler.resetSchedulerState();
  posts = [];
  timer = scheduler.startScheduler({ slack: slack(), immediate: false });
});
afterEach(() => clearInterval(timer));

test("a saved result for an archived channel is retired once instead of retried every minute", async () => {
  // Atlas, int-management-ro: the bot was removed, the weekly task's saved result failed delivery
  // with channel_not_found, and recovery re-tried it every minute for five weeks.
  const ch = await channel({ archived: true });
  const row = fixture(ch);
  store.updateSchedule(row.id, { lastCronFireMs: base - 7 * 24 * 60 * MIN, executionState: "completed", pendingDelivery: { content: "saved" } });
  let delivered = 0;
  const runsBefore = listScheduleRuns({ scheduleId: row.id }).length;
  const pausedBefore = events("schedule_paused");
  await scheduler.tick(base + MIN, { runner: async () => assert.fail("must not execute"), deliver: async () => { delivered++; } });
  assert.equal(delivered, 0);
  const after = saved(row.id);
  assert.equal(after.pendingDelivery, null);
  assert.equal(after.executionState, "undeliverable");
  assert.equal(after.enabled, true, "the row stays armed for a re-invite");
  assert.match(after.lastStatus, /paused: channel archived/);
  assert.equal(events("schedule_paused"), pausedBefore + 1);
  // Later minutes: nothing to recover, nothing delivered, nothing logged again, no run rows minted.
  await scheduler.tick(base + 2 * MIN, { runner: async () => assert.fail("must not execute"), deliver: async () => { delivered++; } });
  await scheduler.tick(base + 3 * MIN, { runner: async () => assert.fail("must not execute"), deliver: async () => { delivered++; } });
  assert.equal(delivered, 0);
  assert.equal(events("schedule_paused"), pausedBefore + 1);
  assert.equal(listScheduleRuns({ scheduleId: row.id }).length, runsBefore);
  assert.equal(posts.length, 0);
});

test("a due cron in an archived channel neither runs nor posts, and resumes after the bot is re-invited", async () => {
  const ch = await channel({ archived: true });
  const row = fixture(ch);
  let executions = 0;
  const runner = async () => { executions++; return { content: "done", engine: "codex" }; };
  await scheduler.tick(base, { runner });
  assert.equal(executions, 0);
  assert.equal(posts.length, 0);
  assert.match(saved(row.id).lastStatus, /paused: channel archived/);
  await patchChannelMeta(ch.slug, { archived: false, archivedAt: null, archivedReason: null, botMembership: "member" });
  await scheduler.tick(base + 24 * 60 * MIN, { runner, deliver: async () => {} });
  assert.equal(executions, 1, "the same row runs again once the channel is live");
});

test("a permanent Slack delivery error retires the saved result while a transient one keeps retrying", async () => {
  const live = await channel();
  const permanent = fixture(live);
  store.updateSchedule(permanent.id, { lastCronFireMs: base - 24 * 60 * MIN, executionState: "completed", pendingDelivery: { content: "saved" } });
  let attempts = 0;
  const deliver = async () => { attempts++; throw new Error("An API error occurred: channel_not_found"); };
  await scheduler.tick(base + MIN, { runner: async () => assert.fail("must not execute"), deliver });
  assert.equal(attempts, 1);
  assert.equal(saved(permanent.id).pendingDelivery, null);
  assert.equal(saved(permanent.id).executionState, "undeliverable");
  assert.match(saved(permanent.id).lastStatus, /^undeliverable: .*channel_not_found/);
  const run = listScheduleRuns({ scheduleId: permanent.id })[0];
  assert.equal(run.deliveryStatus, "failed");
  assert.equal(run.errorKind, "delivery");
  await scheduler.tick(base + 2 * MIN, { runner: async () => assert.fail("must not execute"), deliver });
  assert.equal(attempts, 1, "no further delivery attempts");

  const transient = fixture(live, { cron: cronAt(base + 30 * MIN) });
  store.updateSchedule(transient.id, { lastCronFireMs: base - 24 * 60 * MIN, executionState: "completed", pendingDelivery: { content: "saved" } });
  let transientAttempts = 0;
  const flaky = async () => { transientAttempts++; throw new Error("An API error occurred: ratelimited"); };
  await scheduler.tick(base + 3 * MIN, { runner: async () => assert.fail("must not execute"), deliver: flaky });
  await scheduler.tick(base + 4 * MIN, { runner: async () => assert.fail("must not execute"), deliver: flaky });
  assert.equal(transientAttempts, 2, "a transient failure is retried on the next minute");
  assert.ok(saved(transient.id).pendingDelivery, "the saved result is kept for retry");
});
