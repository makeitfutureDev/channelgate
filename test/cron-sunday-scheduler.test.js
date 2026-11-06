import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

process.env.TZ = "Europe/Bucharest";
ensureTestEnv();
const { addSchedule, updateSchedule, deleteSchedule, getSchedules } = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");

test("Sunday aliases and stepped ranges fire on their expected days without duplicate claims", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (body) => {
    posts.push(body);
    return { ok: true, ts: String(posts.length), channel: body.channel };
  } } };
  const timer = scheduler.startScheduler({ immediate: false,
    slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  const ids = [];
  const expressions = ["0 9 * * 7", "0 9 * * 0,7", "0 9 * * 5-7/2", "0 9 * * 0-7/2"];
  try {
    for (const cron of expressions) {
      const row = addSchedule({ channelId: "C_SUNDAY", slug: "sunday-fixture", createdBy: "U_TEST",
        cron, kind: "reminder", prompt: `Sunday fixture ${cron}`, notify: "none" });
      ids.push(row.id);
      updateSchedule(row.id, { createdAt: new Date(2026, 10, 5).toISOString(),
        cronEligibleSince: new Date(2026, 10, 5).toISOString() });
    }
    await scheduler.tick(new Date(2026, 10, 7, 9, 0).getTime());
    assert.equal(posts.length, 1, "Saturday fires only the 0-7/2 schedule");
    assert.equal(posts[0].text, "⏰ *Reminder:* Sunday fixture 0 9 * * 0-7/2");
    await scheduler.tick(new Date(2026, 10, 8, 9, 0).getTime());
    assert.equal(posts.length, 5, "all four reminders fire once on Sunday, including ranges and duplicate aliases");
    for (const cron of expressions) assert.equal(posts.slice(1).filter(p => p.text === `⏰ *Reminder:* Sunday fixture ${cron}`).length, 1);
    for (const id of ids) assert.equal(getSchedules().find((row) => row.id === id).lastCronFireMs, new Date(2026, 10, 8, 9, 0).getTime());
    await scheduler.tick(new Date(2026, 10, 8, 9, 0, 30).getTime());
    await scheduler.tick(new Date(2026, 10, 9, 9, 0).getTime());
    assert.equal(posts.length, 5, "same-minute repeats and Monday do not fire");
    await scheduler.tick(new Date(2026, 10, 13, 9, 0).getTime());
    assert.equal(posts.length, 6, "Friday fires only the 5-7/2 schedule");
    assert.equal(posts[5].text, "⏰ *Reminder:* Sunday fixture 0 9 * * 5-7/2");
  } finally {
    clearInterval(timer);
    scheduler.resetSchedulerState();
    for (const id of ids) deleteSchedule(id);
  }
});
