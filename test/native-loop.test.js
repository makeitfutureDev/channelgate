// Native `/loop` support: the harness's own pacing tools, adopted by the daemon.
//
// Two halves are covered here. The NORMALIZER decides what the model actually asked for (and, just
// as importantly, refuses to arm anything from a half-streamed or malformed call). The STORE half
// turns that into a durable, bounded, thread-bound schedule row — the part that has to survive the
// turn, because the harness's own timer never does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createStreamConsumer } = await import("../src/engines/stream.js");
const {
  isLoopTool,
  normalizeLoopWakeup,
  AUTONOMOUS_LOOP_PROMPT,
  MIN_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
} = await import("../src/engines/loop-wakeup.js");
const { armLoop, threadLoops, stopLoops, stopThreadLoops, consumeTick, DEFAULT_MAX_TICKS } = await import("../src/gateway/loops.js");
const { addSchedule, getSchedules, deleteSchedule } = await import("../src/config/schedules.js");

// ── Normalization ─────────────────────────────────────────────────────────────

test("the loop bridge recognizes the harness's pacing tools and nothing else", () => {
  assert.equal(isLoopTool("ScheduleWakeup"), true);
  assert.equal(isLoopTool("CronCreate"), true);
  assert.equal(isLoopTool("CronDelete"), true);
  assert.equal(isLoopTool("CronList"), false); // a read — there is nothing to arm
  assert.equal(isLoopTool("mcp__gateway__create_schedule"), false);
  assert.equal(isLoopTool(""), false);
});

test("a dynamic wakeup carries its prompt and clamps the delay to the harness's own window", () => {
  const event = normalizeLoopWakeup("ScheduleWakeup", { delaySeconds: 1200, prompt: "/loop check the deploy", reason: "watching CI", noop: false });
  assert.deepEqual(event, {
    kind: "loop_wakeup",
    mode: "dynamic",
    delaySeconds: 1200,
    prompt: "/loop check the deploy",
    reason: "watching CI",
    noop: false,
  });

  assert.equal(normalizeLoopWakeup("ScheduleWakeup", { delaySeconds: 5, prompt: "x" }).delaySeconds, MIN_DELAY_SECONDS);
  assert.equal(normalizeLoopWakeup("ScheduleWakeup", { delaySeconds: 99_999, prompt: "x" }).delaySeconds, MAX_DELAY_SECONDS);
});

test("the autonomous-loop sentinel is replaced, never replayed as a prompt", () => {
  // The sentinel resolves against loop instructions that only exist inside an interactive session.
  // Firing it verbatim would hand the model a literal "<<autonomous-loop-dynamic>>" turn.
  for (const sentinel of ["<<autonomous-loop-dynamic>>", "<<autonomous-loop>>"]) {
    const event = normalizeLoopWakeup("ScheduleWakeup", { delaySeconds: 600, prompt: sentinel });
    assert.equal(event.prompt, AUTONOMOUS_LOOP_PROMPT);
  }
});

test("stopping is recognized from both tools", () => {
  assert.deepEqual(normalizeLoopWakeup("ScheduleWakeup", { stop: true }), { kind: "loop_wakeup", mode: "stop" });
  // A stop wins even when the model also passes pacing fields alongside it.
  assert.equal(normalizeLoopWakeup("ScheduleWakeup", { stop: true, delaySeconds: 600, prompt: "x" }).mode, "stop");
  // CronDelete's job id is the harness's own in-memory one and can never match a gateway row, so
  // it is honored at thread granularity — the input is irrelevant, including when it is missing.
  assert.deepEqual(normalizeLoopWakeup("CronDelete", { id: "job_7" }), { kind: "loop_wakeup", mode: "stop" });
  assert.deepEqual(normalizeLoopWakeup("CronDelete", null), { kind: "loop_wakeup", mode: "stop" });
});

test("a malformed or half-streamed call never arms a loop", () => {
  const bad = [
    ["ScheduleWakeup", null],
    ["ScheduleWakeup", "{\"delaySeconds\": 60, \"prom"], // truncated partial JSON
    ["ScheduleWakeup", { prompt: "x" }], // no delay
    ["ScheduleWakeup", { delaySeconds: 0, prompt: "x" }],
    ["ScheduleWakeup", { delaySeconds: -60, prompt: "x" }],
    ["ScheduleWakeup", { delaySeconds: "soon", prompt: "x" }],
    ["ScheduleWakeup", { delaySeconds: 600 }], // no prompt
    ["ScheduleWakeup", { delaySeconds: 600, prompt: "   " }],
    ["CronCreate", { prompt: "x" }], // no cron
    ["CronCreate", { cron: "*/5 * * *", prompt: "x" }], // 4 fields
    ["CronCreate", { cron: "*/5 * * * *" }], // no prompt
    ["Bash", { command: "ls" }],
  ];
  for (const [name, input] of bad) {
    assert.equal(normalizeLoopWakeup(name, input), null, `${name} ${JSON.stringify(input)} must not arm`);
  }
});

test("an interval loop keeps its cron and defaults to recurring", () => {
  assert.deepEqual(normalizeLoopWakeup("CronCreate", { cron: "*/5 * * * *", prompt: "/loop status" }), {
    kind: "loop_wakeup",
    mode: "interval",
    cron: "*/5 * * * *",
    recurring: true,
    prompt: "/loop status",
    reason: "",
    noop: false,
  });
  assert.equal(normalizeLoopWakeup("CronCreate", { cron: "0 9 * * *", prompt: "x", recurring: false }).recurring, false);
});

test("a JSON-string input parses exactly like an object", () => {
  const asObject = normalizeLoopWakeup("ScheduleWakeup", { delaySeconds: 900, prompt: "go" });
  const asString = normalizeLoopWakeup("ScheduleWakeup", JSON.stringify({ delaySeconds: 900, prompt: "go" }));
  assert.deepEqual(asString, asObject);
});

test("the Claude stream surfaces a wakeup as a loop event, not a generic tool row", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  const input = JSON.stringify({ delaySeconds: 1800, prompt: "/loop watch the queue", reason: "queue drains slowly" });

  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "ScheduleWakeup" } },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input.slice(0, 30) } },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input.slice(30) } },
  });
  consumer.consume({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "loop_wakeup");
  assert.equal(events[0].delaySeconds, 1800);
  assert.equal(events[0].prompt, "/loop watch the queue");
  assert.equal(events.some((event) => event.kind === "tool_use"), false);
});

// ── Arming ────────────────────────────────────────────────────────────────────

const CHANNEL = "C_LOOP_TEST";
const THREAD = "1700000000.000100";

function reset() {
  for (const row of getSchedules()) deleteSchedule(row.id);
}

function dynamic(overrides = {}) {
  return { kind: "loop_wakeup", mode: "dynamic", delaySeconds: 600, prompt: "next tick", reason: "", noop: false, ...overrides };
}

test("a dynamic wakeup arms one thread-bound, quiet, one-time tick", () => {
  reset();
  const before = Date.now();
  const outcome = armLoop({ channelId: CHANNEL, slug: "loop-test", threadTs: THREAD, authorId: "U1", wakeup: dynamic({ reason: "watching CI" }) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "armed");
  const row = outcome.schedule;
  assert.equal(row.loop, true);
  assert.equal(row.threadTs, THREAD);
  assert.equal(row.resumeThread, true); // the tick must resume the thread, not open a new one
  assert.equal(row.once, true);
  assert.equal(row.cron, "");
  assert.equal(row.notify, "none"); // a watched thread must not be @channel-pinged every tick
  assert.equal(row.prompt, "next tick");
  assert.equal(row.ticksRemaining, DEFAULT_MAX_TICKS);
  const runAt = Date.parse(row.runAt);
  assert.ok(runAt >= before + 600_000 && runAt <= Date.now() + 600_000, "runAt should be ~delaySeconds out");
});

test("re-arming replaces the pending tick instead of stacking a second one", () => {
  reset();
  armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic({ delaySeconds: 1200 }) });

  const rows = threadLoops(CHANNEL, THREAD);
  assert.equal(rows.length, 1, "a thread ticks once per period, however often the model re-arms");
});

test("the tick budget carries across re-arms and finally stops the loop", () => {
  reset();
  const first = armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  assert.equal(first.schedule.ticksRemaining, DEFAULT_MAX_TICKS);
  const loopId = first.loopId;

  // Each fire spends a tick; the re-arm must inherit the REMAINING count, not reset to the max —
  // otherwise the cap is one the model clears simply by scheduling again.
  let row = threadLoops(CHANNEL, THREAD)[0];
  assert.equal(consumeTick(row), DEFAULT_MAX_TICKS - 1);
  const second = armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  assert.equal(second.schedule.ticksRemaining, DEFAULT_MAX_TICKS - 1);
  assert.equal(second.loopId, loopId, "the loop id is stable across re-arms");

  // Drain the budget and confirm the loop refuses to re-arm rather than running forever.
  row = threadLoops(CHANNEL, THREAD)[0];
  for (let i = DEFAULT_MAX_TICKS - 1; i > 0; i -= 1) consumeTick({ ...row, ticksRemaining: i });
  const exhausted = armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.action, "stopped");
  assert.match(exhausted.reason, /budget/);
  assert.equal(threadLoops(CHANNEL, THREAD).length, 0);
});

test("a stop cancels the thread's ticks and says how many it dropped", () => {
  reset();
  armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  const stopped = armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: { kind: "loop_wakeup", mode: "stop" } });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.action, "stopped");
  assert.equal(stopped.dropped, 1);
  assert.equal(threadLoops(CHANNEL, THREAD).length, 0);

  // Stopping a thread that never looped is a no-op, not an error — nothing should be announced.
  const again = armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: { kind: "loop_wakeup", mode: "stop" } });
  assert.equal(again.action, "none");
});

test("loops are scoped to their own thread and never touch ordinary schedules", () => {
  reset();
  const ordinary = addSchedule({ channelId: CHANNEL, slug: "loop-test", cron: "0 9 * * *", prompt: "daily report", createdBy: "U1" });
  armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  armLoop({ channelId: CHANNEL, threadTs: "1700000000.000200", wakeup: dynamic() });

  assert.equal(threadLoops(CHANNEL, THREAD).length, 1);
  assert.equal(threadLoops(CHANNEL, "1700000000.000200").length, 1);

  stopThreadLoops(CHANNEL, THREAD);
  assert.equal(threadLoops(CHANNEL, THREAD).length, 0);
  assert.equal(threadLoops(CHANNEL, "1700000000.000200").length, 1, "one thread's stop must not end another's loop");
  assert.ok(getSchedules().some((row) => row.id === ordinary.id), "a user's own schedule is not a loop and must survive");
});

test("an interval loop is stored as a recurring, thread-bound cron", () => {
  reset();
  const outcome = armLoop({
    channelId: CHANNEL,
    threadTs: THREAD,
    wakeup: { kind: "loop_wakeup", mode: "interval", cron: "*/5 * * * *", recurring: true, prompt: "poll", reason: "", noop: false },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.schedule.cron, "*/5 * * * *");
  assert.equal(outcome.schedule.once, false);
  assert.equal(outcome.schedule.resumeThread, true);
  // A 5-minute loop is the archetypal `/loop 5m`, so it must clear the loop floor even though it
  // is far below the ordinary unattended-cron minimum interval.
  assert.equal(threadLoops(CHANNEL, THREAD).length, 1);
});

test("arming refuses without a thread to post into", () => {
  reset();
  assert.equal(armLoop({ channelId: CHANNEL, threadTs: "", wakeup: dynamic() }).ok, false);
  assert.equal(armLoop({ channelId: "", threadTs: THREAD, wakeup: dynamic() }).ok, false);
  assert.equal(armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: null }).ok, false);
  assert.equal(getSchedules().length, 0);
});

// ── The injected guide ────────────────────────────────────────────────────────

test("the gateway guide routes looping work to the native tools and states the real limits", () => {
  const loops = readFileSync(new URL("../src/gateway/gateway-usage/references/loops.md", import.meta.url), "utf8");
  // The whole point of the bridge is that the model keeps using the NATIVE skill; a guide that
  // invented a gateway-specific loop tool would defeat it.
  assert.match(loops, /ScheduleWakeup/);
  assert.match(loops, /CronCreate/);
  // The three things a model cannot discover on its own and would otherwise get wrong.
  assert.match(loops, /CronList/, "must warn that the harness's own cron listing is not bridged");
  assert.match(loops, /budget/i, "must state that a loop is finite");
  assert.match(loops, /stop/i, "must say how the loop ends");
  // And it must not be confused with the two neighbouring mechanisms.
  assert.match(loops, /create_schedule/);
  assert.match(loops, /run_in_background/);

  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /references\/loops\.md/, "the capability map must route looping work to the reference");

  const reminders = readFileSync(new URL("../src/gateway/gateway-usage/references/reminders.md", import.meta.url), "utf8");
  assert.match(reminders, /references\/loops\.md/, "scheduling must point at loops for in-thread iteration");

  // A model with no bridged pacing tool reached for sequential sleeps instead and narrated a loop
  // it was not running (live QA, CTO-04). Sleeping inside the turn is not a loop: the process ends
  // with the reply either way.
  assert.match(loops, /Never fake a loop inside one turn/i);
  assert.match(loops, /run_in_background: true/, "the harness's own backgrounding is named as a dead end");
  assert.match(loops, /dies with\s+it/i);
  assert.match(loops, /I'll keep checking and let you know/, "the exact promise to never make");
});

test("a channel-wide stop ends every loop in the channel and names their threads", () => {
  reset();
  const other = "1700000000.000300";
  const ordinary = addSchedule({ channelId: CHANNEL, slug: "loop-test", cron: "0 9 * * *", prompt: "daily", createdBy: "U1" });
  armLoop({ channelId: CHANNEL, threadTs: THREAD, wakeup: dynamic() });
  armLoop({ channelId: CHANNEL, threadTs: other, wakeup: dynamic() });

  // No threadTs = the `/stop` channel sweep. It must return the rows, not just a count, so each
  // affected thread can be told its loop ended rather than silently going quiet.
  const dropped = stopLoops(CHANNEL);
  assert.equal(dropped.length, 2);
  assert.deepEqual(new Set(dropped.map((row) => row.threadTs)), new Set([THREAD, other]));
  assert.ok(getSchedules().some((row) => row.id === ordinary.id), "a sweep of loops must not delete real schedules");
  assert.deepEqual(stopLoops(CHANNEL), [], "a second sweep has nothing left to drop");
});
