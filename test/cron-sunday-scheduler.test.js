import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { addSchedule, updateSchedule, deleteSchedule, getSchedules } = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");

test("Sunday 7 scheduler fixture fires once on Sunday, not Saturday or Monday", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (body) => {
    posts.push(body);
    return { ok: true, ts: String(posts.length), channel: body.channel };
  } } };
  const timer = scheduler.startScheduler({ immediate: false,
    slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  const ids = [];
  try {
    for (const cron of ["0 9 * * 7", "0 9 * * 0,7"]) {
      const row = addSchedule({ channelId: "C_SUNDAY", slug: "sunday-fixture", createdBy: "U_TEST",
        cron, kind: "reminder", prompt: `Sunday fixture ${cron}`, notify: "none" });
      ids.push(row.id);
      updateSchedule(row.id, { createdAt: new Date(2026, 10, 6).toISOString(),
        cronEligibleSince: new Date(2026, 10, 6).toISOString() });
    }
    await scheduler.tick(new Date(2026, 10, 7, 9, 0).getTime());
    assert.equal(posts.length, 0);
    await scheduler.tick(new Date(2026, 10, 8, 9, 0).getTime());
    assert.equal(posts.length, 2, "each reminder fires once, including duplicate Sunday aliases");
    for (const id of ids) assert.equal(getSchedules().find((row) => row.id === id).lastCronFireMs, new Date(2026, 10, 8, 9, 0).getTime());
    await scheduler.tick(new Date(2026, 10, 8, 9, 0, 30).getTime());
    await scheduler.tick(new Date(2026, 10, 9, 9, 0).getTime());
    assert.equal(posts.length, 2, "same-minute repeats and Monday do not fire");
  } finally {
    clearInterval(timer);
    scheduler.resetSchedulerState();
    for (const id of ids) deleteSchedule(id);
  }
});
