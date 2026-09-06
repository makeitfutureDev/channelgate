// `delivery:"daily-thread"` groups a day's runs under ONE anchor message. The anchor is a
// DELIVERY decision — it must never become a SESSION decision.
//
// It did. The per-fire session key was built from the delivery thread
// (`sched-<id>-<threadTs || Date.now()>`), which looks per-fire only because `standard` delivery
// announces every run and therefore brings a new ts each time. A daily-thread schedule reuses one
// anchor all day, so every later fire of the same server-local day landed on the SAME key and
// RESUMED the previous fire's engine session — fire 1 new, fire 2 a resume, on one key
// (QA AUT-DAILY-THREAD-01, reproduced across two restarts). Both the shipped contract
// (`gateway-usage/references/reminders.md`, the `create_schedule` tool description) and
// FEATURES.md promise a fresh, context-less session per run.
//
// This is the end-to-end proof: two fires of one daily-thread schedule on the same day, through
// the real scheduler → run orchestrator → stub engine path. The stub echoes whether the spawned
// argv carried a resume (`-r`), which is the observable behind "isNewSession".
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { addSchedule, getSchedules } = await import("../src/config/schedules.js");
const { getSessionMap } = await import("../src/gateway/sessions.js");
const scheduler = await import("../src/gateway/scheduler.js");

function fakeSlack() {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: {
      postMessage: async (message) => {
        const ts = `17886500${String(++seq).padStart(2, "0")}.000100`;
        posted.push({ ...message, ts });
        return { ok: true, ts };
      },
      update: ok,
      postEphemeral: ok,
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Sched User" } }),
      list: async () => ({ members: [], response_metadata: {} }),
    },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
    apiCall: ok,
  };
  return { client, slack: { snapshot: () => ({ connected: true }), getClient: () => client } };
}

test("two fires of a daily-thread schedule on one day get separate sessions under one anchor", async () => {
  await setUser("U_DAILY", { name: "Sched User", approved: true });
  const entry = await upsertChannelEntry("C_DAILY_SESSION", { name: "daily-session", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, {
    channelId: "C_DAILY_SESSION", name: entry.name, type: "channel", isDM: false,
    allowedUsers: ["U_DAILY"], access: "approved", template: "custom",
    engine: "claude", cleanMode: true, allowNetwork: false,
  });
  const sched = addSchedule({
    channelId: "C_DAILY_SESSION", slug: entry.slug, kind: "task", cron: "0 * * * *", notify: "none",
    delivery: "daily-thread", prompt: "check the SLA board", description: "Monitor SLA",
    createdBy: "U_DAILY",
  });

  const { client, slack } = fakeSlack();
  scheduler.resetSchedulerState();
  scheduler.startScheduler({ slack });

  // Two fires an hour apart — the same server-local day, so the anchor is reused by design.
  const nine = new Date(2026, 8, 1, 9, 0, 5).getTime();
  await scheduler.tick(nine);
  await scheduler.tick(nine + 60 * 60_000);

  assert.equal(
    client.posted.some((m) => /Scheduled run failed/.test(m.text || "")),
    false,
    `no fire may error: ${JSON.stringify(client.posted.map((m) => m.text))}`,
  );

  // Delivery: ONE anchor for the day, both answers threaded beneath it.
  const anchors = client.posted.filter((m) => !m.thread_ts && /Running:/.test(m.text || ""));
  assert.equal(anchors.length, 1, "the day gets exactly one top-level anchor");
  const replies = client.posted.filter((m) => /Stub engine reply/.test(m.text || ""));
  assert.equal(replies.length, 2, "both fires delivered an answer");
  for (const reply of replies) assert.equal(reply.thread_ts, anchors[0].ts, "…both under the day's anchor");
  assert.equal(getSchedules().find((s) => s.id === sched.id).dailyThreadTs, anchors[0].ts);

  // Sessions: a distinct synthetic key per fire, and therefore no resume. `resume=no` twice is the
  // spawned-argv form of the QA observation (fire 2 used to report isNewSession:false).
  for (const reply of replies) assert.match(reply.text, /resume=no/, "every fire starts a fresh engine session");
  const keys = Object.keys(await getSessionMap(entry.slug));
  assert.equal(keys.length, 2, `two fires, two session keys — got ${JSON.stringify(keys)}`);
  for (const key of keys) {
    assert.match(key, new RegExp(`^sched-${sched.id}-`), "each key is the schedule's own synthetic key");
    assert.notEqual(key, `sched-${sched.id}-${anchors[0].ts}`, "and none of them is derived from the reused anchor");
  }
});

test("the session key is per-fire and never derived from the delivery thread", () => {
  const sched = { id: "abc12345" };
  const anchor = "1788650891.264819"; // the reused daily anchor from the QA report
  const first = scheduler.scheduleSessionKey(sched);
  const second = scheduler.scheduleSessionKey(sched);
  assert.notEqual(first, second, "two fires of one schedule never share a key");
  for (const key of [first, second]) {
    assert.ok(key.startsWith(`sched-${sched.id}-`), "the synthetic shape is unchanged");
    assert.ok(!key.includes(anchor), "the delivery anchor is not part of the session key");
  }

  // Same millisecond (one tick catching up several minutes) still yields distinct keys.
  const now = Date.now();
  assert.notEqual(scheduler.scheduleSessionKey(sched, now), scheduler.scheduleSessionKey(sched, now));
});
