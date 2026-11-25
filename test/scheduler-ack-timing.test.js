import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { addSchedule } = await import("../src/config/schedules.js");
const { addAck, deleteAck, getAcks } = await import("../src/config/acks.js");
const { resetSchedulerState, startScheduler } = await import("../src/gateway/scheduler.js");

const minute = 60_000;
const start = Date.parse("2026-05-05T10:12:43Z");

for (const [firstPostMs, waitMinutes] of [[250, 2], [minute + 250, 1]]) {
  test(`second notice follows a ${firstPostMs} ms post with a ${waitMinutes}-minute window`, async (t) => {
    const clock = t.mock.timers;
    clock.enable({ apis: ["Date", "setInterval", "setTimeout"], now: start });
    const posts = [];
    const firstReceipt = Promise.withResolvers();
    const secondReceipt = Promise.withResolvers();
    const client = {
      chat: { postMessage: async ({ channel }) => {
        posts.push({ at: Date.now() - start, channel });
        if (posts.length === 1) await firstReceipt.promise;
        if (posts.length === 2) await secondReceipt.promise;
        return { ts: `1700000000.00000${posts.length}` };
      } },
      conversations: { open: async () => ({ channel: { id: "D_CREATOR" } }) },
    };
    addSchedule({ kind: "reminder", channelId: "C_REMINDER", slug: "timing", prompt: "check",
      once: true, runAt: new Date(start).toISOString(), ack: true, escalateAfterMin: waitMinutes,
      dmAfterMin: 1, createdBy: "U_CREATOR" });
    const timer = startScheduler({ slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
    t.after(() => {
      clearInterval(timer);
      resetSchedulerState();
      for (const ack of getAcks()) deleteAck(ack.id);
    });
    async function advance(ms) {
      // MockTimers sets Date.now() to the end of each jump. Visit each real interval boundary
      // so a minute scan sees the same wall clock it would see in the daemon.
      const target = Date.now() + ms;
      while (Date.now() < target) {
        const untilTick = minute - (Date.now() - start) % minute;
        clock.tick(Math.min(untilTick, target - Date.now()));
        await setImmediate();
      }
    }
    await setImmediate();
    assert.deepEqual(posts, [{ at: 0, channel: "C_REMINDER" }]);
    await advance(firstPostMs);
    assert.equal(getAcks().length, 0);
    firstReceipt.resolve();
    await setImmediate();
    const secondDue = firstPostMs + waitMinutes * minute;
    assert.equal(Date.parse(getAcks()[0].nextAt), start + secondDue);
    await advance(waitMinutes * minute - 1);
    assert.equal(posts.length, 1, "the full acknowledgement window is available");
    await advance(1);
    assert.deepEqual(posts[1], { at: secondDue, channel: "C_REMINDER" }, "deadline between cron ticks");

    await advance(minute + 500);
    secondReceipt.resolve();
    await setImmediate();
    await advance(minute - 1);
    assert.equal(posts.length, 2, "the creator DM also waits a full window from delivery");
    await advance(1);
    assert.deepEqual(posts[2], { at: secondDue + 2 * minute + 500, channel: "D_CREATOR" });
    await advance(2 * minute);
    assert.equal(posts.length, 3);
    assert.deepEqual(getAcks(), []);
  });
}

test("restart restores off-tick deadlines and a checkmark cancels an armed notice", async (t) => {
  const clock = t.mock.timers;
  clock.enable({ apis: ["Date", "setInterval", "setTimeout"], now: start });
  const rows = [100, 250, 500].map((delay, i) => addAck({
    channelId: "C_REMINDER", messageTs: `1700000000.00000${i}`,
    nextAt: new Date(start + delay).toISOString(),
  }));
  const threads = [];
  const slowPost = Promise.withResolvers();
  const client = { chat: { postMessage: async ({ thread_ts }) => {
    threads.push(thread_ts);
    if (threads.length === 1) await slowPost.promise;
    return { ts: "1700000001.000001" };
  } } };
  const timer = startScheduler({ slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  t.after(() => {
    clearInterval(timer);
    resetSchedulerState();
  });
  deleteAck(rows[0].id);
  clock.tick(100);
  await setImmediate();
  assert.deepEqual(threads, []);
  clock.tick(150);
  await setImmediate();
  assert.deepEqual(threads, [rows[1].messageTs]);
  clock.tick(250);
  await setImmediate();
  slowPost.resolve();
  await setImmediate();
  assert.deepEqual(threads, [rows[1].messageTs, rows[2].messageTs]);
});
