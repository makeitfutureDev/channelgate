import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { addSchedule, getSchedules, updateSchedule, deleteSchedule } = await import("../src/config/schedules.js");
const { register } = await import("../src/mcp/tools/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");

function slackFixture() {
  const posts = [];
  const client = {
    chat: { postMessage: async (body) => { posts.push(body); return { ok: true, ts: String(posts.length), channel: body.channel }; } },
    conversations: { open: async ({ users }) => ({ channel: { id: `D_${users}` } }) },
  };
  const timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
  return { posts, timer };
}

after(() => scheduler.resetSchedulerState());

test("a fixed interval stays silent until a matching result and then DMs only its creator", async () => {
  const now = Date.now();
  const sched = addSchedule({ channelId: "C_QUIET", slug: "quiet", createdBy: "U_CREATOR",
    intervalDays: 14, runAt: new Date(now - 60_000).toISOString(), delivery: "dm-on-match",
    matchPrefix: "FOUND:", prompt: "Check official docs", description: "Huddle API check" });
  updateSchedule(sched.id, { createdAt: new Date(now - 120_000).toISOString() });
  const { posts, timer } = slackFixture();
  try {
    let calls = 0;
    await scheduler.tick(now, { runner: async () => { calls++; return { content: "NO_UPDATE", engine: "claude" }; } });
    assert.equal(calls, 1);
    assert.deepEqual(posts, [], "no announcement or result is posted for an ordinary check");
    const next = getSchedules().find((row) => row.id === sched.id).runAt;
    assert.ok(Date.parse(next) > now + 13 * 24 * 60 * 60_000);
    await scheduler.tick(now + 60_000, { runner: async () => { calls++; return { content: "unexpected" }; } });
    assert.equal(calls, 1, "the interval does not fire on the next minute");

    updateSchedule(sched.id, { runAt: new Date(now + 90_000).toISOString() });
    await scheduler.tick(now + 120_000, { runner: async () => ({ content: "FOUND: https://docs.slack.dev/new-huddle-api", engine: "claude" }) });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, "D_U_CREATOR");
    assert.match(posts[0].text, /^FOUND:/);
    assert.equal(getSchedules().find((row) => row.id === sched.id).enabled, false, "a finding stops future checks and repeat DMs");
  } finally {
    clearInterval(timer);
    deleteSchedule(sched.id);
  }
});

test("interval dates advance from the planned date without replaying missed periods", () => {
  const day = 24 * 60 * 60_000;
  const start = Date.parse("2026-10-05T10:00:00Z");
  assert.equal(scheduler.nextIntervalRun({ intervalDays: 14, runAt: new Date(start).toISOString() }, start + 29 * day),
    "2026-11-16T10:00:00.000Z");
});

test("create_schedule accepts a 14-day conditional DM task", async () => {
  const tools = new Map();
  register({ registerTool: (name, _spec, handler) => tools.set(name, handler) },
    { channelId: "C_QUIET_TOOL", slug: "quiet-tool", createdBy: "U_CREATOR", text: (s) => ({ content: [{ type: "text", text: s }] }) });
  const result = await tools.get("create_schedule")({ interval_days: 14, delivery: "dm-on-match",
    match_prefix: "FOUND:", prompt: "Check official docs", description: "Huddle API check" });
  const reply = result.content[0].text;
  assert.match(reply, /every 14 days/);
  assert.match(reply, /only results beginning with "FOUND:" are DM'd/);
  const id = reply.match(/id (\S+?)\)/)[1];
  const stored = getSchedules().find((row) => row.id === id);
  assert.equal(stored.intervalDays, 14);
  assert.equal(stored.delivery, "dm-on-match");
  deleteSchedule(id);
});
