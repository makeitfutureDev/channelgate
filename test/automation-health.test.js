import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const schedules = await import("../src/config/schedules.js");
const scheduler = await import("../src/gateway/scheduler.js");
const { classifyScheduleResult } = await import("../src/gateway/schedule-outcome.js");
const runs = await import("../src/gateway/schedule-runs.js");
const { register } = await import("../src/mcp/tools/schedules.js");

const report = (status, summary = "Checked the inbox", connections = [{ name: "Gmail", status: "available" }]) =>
  `\`\`\`automation-result\n${JSON.stringify({ status, summary, connections })}\n\`\`\``;
const stored = (id) => schedules.getSchedules().find((row) => row.id === id);
const history = (scheduleId) => runs.listScheduleRuns({ scheduleId });
let posts, timer;

beforeEach(() => {
  getDb().exec("DELETE FROM schedules");
  schedules.saveSchedulerCursor(0);
  scheduler.resetSchedulerState();
  posts = [];
  const client = { chat: { postMessage: async (payload) => {
    posts.push(payload);
    return { ok: true, ts: `1791000000.${String(posts.length).padStart(6, "0")}` };
  } } };
  timer = scheduler.startScheduler({ immediate: false, slack: {
    snapshot: () => ({ connected: true }), getClient: () => client,
  } });
});
afterEach(() => clearInterval(timer));

function fixture(patch = {}) {
  return schedules.addSchedule({ channelId: "C_HEALTH", slug: "health", createdBy: "U_HEALTH",
    cron: "0 * * * *", prompt: "Check email", description: "Inbox check", notify: "none",
    executionVisibility: "silent", resultPolicy: "on-result", ...patch });
}

test("an explicit empty inbox is healthy and silent, with connection evidence retained", async () => {
  const sched = fixture();
  let delivered = 0;
  await scheduler.runSchedule(sched, {
    runner: async () => ({ engine: "claude", content: report("no-op", "No new email"), toolUseCount: 1 }),
    deliver: async () => { delivered++; },
  });
  assert.equal(posts.length, 0, "silent runs create no start announcement");
  assert.equal(delivered, 0, "an explicitly successful empty check creates no report");
  const [run] = history(sched.id);
  assert.equal(run.engineStatus, "completed");
  assert.equal(run.taskStatus, "no-op");
  assert.equal(run.deliveryStatus, "suppressed");
  assert.deepEqual(run.connections, [{ name: "Gmail", status: "available" }]);
});

test("a conversational connection failure is never counted as successful task completion", async () => {
  const sched = fixture();
  let delivered = 0;
  await scheduler.runSchedule(sched, {
    runner: async () => ({ engine: "codex", content: "I could not check email because the Gmail token expired." }),
    deliver: async () => { delivered++; },
  });
  const [run] = history(sched.id);
  assert.equal(run.engineStatus, "completed", "a completed conversation is separate from completing the work");
  assert.equal(run.taskStatus, "unreported");
  assert.equal(delivered, 1, "unverified results remain visible by default");
});

test("only one valid explicit outcome can suppress a check", () => {
  for (const content of [
    "No new emails today.",
    "```automation-result\n{bad json}\n```",
    `${report("no-op")}\n${report("failed")}`,
    "```automation-result\n{\"status\":\"no-op\",\"summary\":\"Empty\",\"connections\":[{\"name\":\"Gmail\",\"status\":\"connected\"}]}\n```",
  ]) {
    const result = classifyScheduleResult({ content });
    assert.equal(result.automationOutcome.status, "unreported", content);
    assert.equal(result.content, content, "invalid evidence remains available for inspection");
  }
});

test("a gateway refusal overrides even a claimed successful outcome", () => {
  for (const refusal of [{ licenseRefused: true }, { accessRefused: true }, { engineRefused: true }, { engineError: true }, { interrupted: true }, { completed: false }, { answerless: true }]) {
    const result = classifyScheduleResult({ content: report("no-op"), ...refusal });
    assert.notEqual(result.automationOutcome.status, "no-op");
    assert.notEqual(result.automationOutcome.status, "succeeded");
  }
});

test("an unavailable or unverified required connection cannot be a healthy empty check", () => {
  for (const status of ["unavailable", "unknown"]) {
    const result = classifyScheduleResult({ content: report("no-op", "Could not verify email", [{ name: "Gmail", status }]) });
    assert.notEqual(result.automationOutcome.status, "no-op");
    assert.notEqual(result.automationOutcome.status, "succeeded");
    assert.equal(result.automationOutcome.connections[0].status, status);
  }
});

test("saved output delivery retries preserve one execution and one history row", async () => {
  const sched = fixture({ delivery: "channel" });
  let executions = 0;
  const runner = async () => { executions++; return { engine: "claude", content: `Three new emails.\n${report("succeeded")}` }; };
  await scheduler.runSchedule(sched, { runner, deliver: async () => { throw new Error("transport unavailable"); } });
  const checkpoint = stored(sched.id);
  assert.ok(checkpoint.pendingDelivery, "completed work is durable before delivery");
  const first = history(sched.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].taskStatus, "succeeded", "delivery failure does not rewrite the completed task outcome");
  let delivered = 0;
  await scheduler.runSchedule(checkpoint, { runner, deliver: async (_client, { result }) => {
    delivered++;
    assert.equal(result.content.trim(), "Three new emails.");
  } });
  assert.equal(executions, 1, "retrying delivery cannot repeat email side effects");
  assert.equal(delivered, 1);
  assert.equal(history(sched.id).length, 1);
  assert.equal(history(sched.id)[0].id, first[0].id);
  assert.equal(history(sched.id)[0].deliveryStatus, "delivered");
  assert.ok(!history(sched.id)[0].error, "a successful retry clears the current delivery error; prior failure stays in the event log");
});

test("a one-time empty check retires but its health history remains queryable", async () => {
  const sched = fixture({ cron: "", once: true, runAt: new Date().toISOString() });
  await scheduler.runSchedule(sched, { runner: async () => ({ engine: "claude", content: report("no-op") }),
    deliver: async () => assert.fail("empty output should be suppressed") });
  assert.equal(stored(sched.id), undefined);
  assert.equal(history(sched.id).length, 1);
  assert.equal(history(sched.id)[0].taskStatus, "no-op");
});

test("fixed delivery threads keep independent fresh engine sessions across fires", async () => {
  const sched = fixture({ delivery: "thread", deliveryThread: "1791000010.123456" });
  const keys = [], targets = [];
  const options = {
    runner: async ({ threadKey, origin }) => {
      keys.push(threadKey);
      assert.equal(origin, "schedule");
      return { engine: "claude", content: `One email.\n${report("succeeded")}` };
    },
    deliver: async (_client, { threadKey }) => { targets.push(threadKey); },
  };
  await scheduler.runSchedule(sched, options);
  await scheduler.runSchedule(stored(sched.id), options);
  assert.deepEqual(targets, [sched.deliveryThread, sched.deliveryThread]);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every((key) => key.startsWith(`sched-${sched.id}-`) && key !== sched.deliveryThread));
  assert.equal(posts.length, 0);
});

test("failure notification preference suppresses failed and interrupted notices without erasing status", async () => {
  const sched = fixture({ failureNotify: false });
  await scheduler.runSchedule(sched, { runner: async () => { throw new Error("model unavailable"); } });
  assert.equal(posts.length, 0);
  assert.notEqual(history(sched.id)[0].taskStatus, "succeeded");
  const interrupted = fixture({ failureNotify: false });
  schedules.updateSchedule(interrupted.id, { executionState: "running", runAttempts: 1 });
  await scheduler.runSchedule(stored(interrupted.id), { runner: async () => assert.fail("unknown effects cannot replay") });
  assert.equal(posts.length, 0);
  assert.equal(stored(interrupted.id).enabled, false);
  assert.equal(history(interrupted.id)[0].taskStatus, "interrupted");
});

test("history reads can be scoped to the originating channel", async () => {
  const sched = fixture();
  await scheduler.runSchedule(sched, { runner: async () => ({ content: report("no-op"), engine: "claude" }) });
  const [run] = history(sched.id);
  assert.equal(runs.getScheduleRun(run.id, "C_OTHER"), null);
  assert.deepEqual(runs.listScheduleRuns({ scheduleId: sched.id, channelId: "C_OTHER" }), []);
  assert.ok(runs.getScheduleRun(run.id, sched.channelId));
});

test("automation logs retain bounded activity names and exclude tool payloads and provider secrets", () => {
  const sched = fixture();
  const run = runs.createScheduleRun(sched);
  runs.appendScheduleRunEvent(run.id, { kind: "tool_use", name: "mcp__gmail__list_messages",
    target: "https://mail.example/?token=private-target", path: "/private/account",
    arguments: { password: "private-argument" }, output: "private-output", text: "private-event-text" });
  const activity = runs.getScheduleRun(run.id).events.at(-1);
  assert.equal(activity.name, "mcp__gmail__list_messages");
  assert.deepEqual(Object.keys(activity).sort(), ["at", "kind", "name"]);
  for (let i = 0; i < 210; i++) runs.appendScheduleRunEvent(run.id, { kind: "thinking", text: `private-thought-${i}` });
  runs.updateScheduleRun(run.id, { error: "Authorization: Bearer abcDEF123456789-token", summary: "key=sk-proj-abcdefghijklmnopqrstuvwxyz" });
  const saved = runs.getScheduleRun(run.id);
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /private-target|private-account|private-argument|private-output|private-event-text|private-thought|abcDEF123456789-token|sk-proj-abcdefghijklmnopqrstuvwxyz/);
  assert.ok(saved.events.length <= 200, "chatty engines do not produce an unbounded ledger row");
  assert.ok(saved.eventsDropped > 0, "truncation is recorded instead of appearing to be a complete log");
});

test("success KPI counts explicit completed work and healthy no-op, excluding unfinished runs", () => {
  const sched = fixture();
  for (const status of ["succeeded", "no-op", "unreported", "blocked", "failed", "interrupted", "skipped", "running"]) {
    const run = runs.createScheduleRun(sched);
    runs.updateScheduleRun(run.id, { status, taskStatus: status,
      engineStatus: ["succeeded", "no-op", "unreported"].includes(status) ? "completed" : "not-started",
      deliveryStatus: status === "failed" ? "failed" : "suppressed" });
  }
  const summary = runs.scheduleRunSummary(sched.id, sched.channelId);
  assert.equal(summary.total, 8);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.noOp, 1);
  assert.equal(summary.engineCompleted, 3);
  assert.equal(summary.deliveryFailed, 1);
  assert.equal(summary.successRate, 2 / 6, "unknown and failed outcomes count against success; skipped/running are separate");
});

test("silent daily delivery creates no empty anchor and reuses one thread for meaningful reports", async () => {
  const sched = fixture({ delivery: "daily-thread" });
  const targets = [], keys = [];
  for (const status of ["no-op", "succeeded", "no-op", "succeeded"]) {
    await scheduler.runSchedule(stored(sched.id), {
      runner: async ({ threadKey }) => { keys.push(threadKey); return {
        engine: "claude", content: `${status === "succeeded" ? "New email.\n" : ""}${report(status)}`,
      }; },
      deliver: async (_client, { threadKey }) => { targets.push(threadKey); },
    });
    assert.equal(posts.length, status === "no-op" && keys.length === 1 ? 0 : 1);
  }
  assert.equal(targets.length, 2);
  assert.deepEqual(targets, [posts[0].ts || "1791000000.000001", posts[0].ts || "1791000000.000001"]);
  assert.match(posts[0].text, /Automation reports/);
  assert.doesNotMatch(posts[0].text, /Running:/);
  assert.equal(new Set(keys).size, 4, "daily grouping never joins engine sessions");
});

test("each recurring scheduler claim records a new immutable run rather than overwriting previous health", async () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
  const sched = fixture({ cron: "* * * * *" });
  schedules.updateSchedule(sched.id, { createdAt: new Date(now - 1000).toISOString() });
  const options = { runner: async () => ({ engine: "claude", content: report("no-op") }) };
  await scheduler.tick(now, options);
  const [first] = history(sched.id);
  assert.ok(first);
  await scheduler.tick(now + 60_000, options);
  const recorded = history(sched.id);
  assert.equal(recorded.length, 2);
  assert.ok(recorded.some((run) => run.id === first.id));
  assert.equal(new Set(recorded.map((run) => run.id)).size, 2);
});

test("retiring a preexisting delivered checkpoint creates no phantom queued execution", async () => {
  const sched = fixture({ once: true, cron: "", runAt: new Date().toISOString() });
  const previous = runs.createScheduleRun(sched);
  runs.updateScheduleRun(previous.id, { status: "succeeded", taskStatus: "succeeded", engineStatus: "completed", deliveryStatus: "delivered" });
  schedules.updateSchedule(sched.id, { executionState: "delivered", activeRunId: previous.id });
  await scheduler.runSchedule(stored(sched.id), { runner: async () => assert.fail("already delivered") });
  assert.equal(stored(sched.id), undefined);
  assert.equal(history(sched.id).length, 1);
  assert.equal(history(sched.id)[0].id, previous.id);
});

test("transport disconnect while retrying a saved result preserves the completed task outcome", async () => {
  const sched = fixture({ delivery: "channel" });
  await scheduler.runSchedule(sched, { runner: async () => ({ content: `New emails.\n${report("succeeded")}`, engine: "claude" }),
    deliver: async () => { throw new Error("temporary delivery failure"); } });
  clearInterval(timer);
  timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: false }) } });
  await scheduler.runSchedule(stored(sched.id), { runner: async () => assert.fail("saved work cannot replay") });
  const [run] = history(sched.id);
  assert.equal(run.status, "succeeded", "a later delivery outage does not retroactively skip completed work");
  assert.equal(run.taskStatus, "succeeded");
  assert.equal(run.engineStatus, "completed");
  assert.equal(run.deliveryStatus, "failed");
});

test("a fixed-thread schedule rejects impossible Slack targets instead of silently posting top-level", async () => {
  const tools = new Map();
  register({ registerTool: (name, _schema, handler) => tools.set(name, handler) }, {
    channelId: "C_HEALTH", slug: "health", createdBy: "U_HEALTH", threadKey: "1791000010.123456",
    text: (value) => ({ content: [{ type: "text", text: value }] }),
  });
  const result = await tools.get("create_schedule")({ in_minutes: 1, prompt: "Check inbox", delivery: "thread", delivery_thread: "not-a-real-thread" });
  assert.doesNotMatch(result.content[0].text, /✅/);
  assert.equal(schedules.listForChannel("C_HEALTH").length, 0);
});

test("MCP creation can bind silent result-only automation to its current real thread", async () => {
  const tools = new Map();
  register({ registerTool: (name, _schema, handler) => tools.set(name, handler) }, {
    channelId: "C_HEALTH", slug: "health", createdBy: "U_HEALTH", threadKey: "1791000010.123456",
    text: (value) => ({ content: [{ type: "text", text: value }] }),
  });
  const result = await tools.get("create_schedule")({ in_minutes: 1, prompt: "Check inbox", delivery: "thread",
    execution_visibility: "silent", result_policy: "on-result", failure_notify: false });
  assert.match(result.content[0].text, /✅/);
  const [saved] = schedules.listForChannel("C_HEALTH");
  assert.equal(saved.deliveryThread, "1791000010.123456");
  assert.equal(saved.delivery, "thread");
  assert.equal(saved.executionVisibility, "silent");
  assert.equal(saved.resultPolicy, "on-result");
  assert.equal(saved.failureNotify, false);
});

test("an exhausted one-time execution budget records a terminal failure and respects silent errors", async () => {
  const sched = fixture({ once: true, cron: "", runAt: new Date().toISOString(), failureNotify: false });
  schedules.updateSchedule(sched.id, { runAttempts: 2, executionState: "interrupted" });
  await scheduler.runSchedule(stored(sched.id), { runner: async () => assert.fail("budget exhausted") });
  assert.equal(stored(sched.id), undefined);
  assert.equal(posts.length, 0);
  const [run] = history(sched.id);
  assert.equal(run.status, "failed");
  assert.equal(run.engineStatus, "not-started");
  assert.ok(run.completedAt);
});

test("only an explicitly replay-safe provider failure remains eligible for automatic retry", async () => {
  for (const replaySafe of [true, false]) {
    const sched = fixture({ failureNotify: false });
    await scheduler.runSchedule(sched, { runner: async () => { throw Object.assign(new Error("provider unavailable"), {
      details: { replaySafe, providerKind: "model_unavailable", engine: "codex", toolUseCount: replaySafe ? 0 : 1 },
    }); } });
    assert.equal(stored(sched.id).enabled, replaySafe);
    assert.equal(stored(sched.id).executionState, replaySafe ? "failed" : "interrupted");
    assert.equal(history(sched.id)[0].effectsUnknown, !replaySafe);
  }
});

test("a disconnected recurring fire records one deferred attempt and still catches up without replay", async () => {
  const due = Math.floor(Date.now() / 60_000) * 60_000;
  const at = new Date(due);
  const sched = fixture({ cron: `${at.getMinutes()} ${at.getHours()} * * *` });
  schedules.updateSchedule(sched.id, { createdAt: new Date(due - 60_000).toISOString() });
  clearInterval(timer);
  timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: false }) } });
  const options = { runner: async () => ({ content: report("no-op"), engine: "claude" }) };
  await scheduler.tick(due + 1000, options);
  await scheduler.tick(due + 2000, options);
  assert.equal(stored(sched.id).lastCronFireMs, undefined, "deferral does not consume the due fire");
  assert.equal(history(sched.id).length, 1, "repeated wakeups record one deferral per due minute and cause");
  assert.equal(history(sched.id)[0].status, "skipped");
  assert.equal(history(sched.id)[0].engineStatus, "not-started");
  clearInterval(timer);
  timer = scheduler.startScheduler({ immediate: false, slack: {
    snapshot: () => ({ connected: true }), getClient: () => ({ chat: {
      postMessage: async (payload) => { posts.push(payload); return { ok: true, ts: "1791000000.000001" }; },
    } }),
  } });
  let executions = 0;
  await scheduler.tick(due + 3000, { runner: async () => { executions++; return options.runner(); } });
  await scheduler.tick(due + 4000, { runner: async () => assert.fail("due work already caught up") });
  assert.equal(executions, 1);
  assert.equal(stored(sched.id).lastCronFireMs, due);
  assert.equal(history(sched.id).length, 2);
  assert.equal(history(sched.id).filter((run) => run.status === "no-op").length, 1);
  assert.equal(posts.length, 0, "silent no-op stays silent during recovery");
});

test("a telemetry write failure before execution releases the schedule's in-flight guard", async () => {
  const sched = fixture({ failureNotify: false });
  const db = getDb();
  const prepare = db.prepare;
  let executions = 0;
  const options = { runner: async () => { executions++; return { content: report("no-op"), engine: "claude" }; } };
  db.prepare = function (sql) {
    if (/INSERT INTO schedule_runs/.test(sql)) throw new Error("fixture telemetry write unavailable");
    return prepare.call(this, sql);
  };
  try {
    await scheduler.runSchedule(sched, options);
    assert.equal(executions, 0, "execution must not start without its durable record");
  } finally { db.prepare = prepare; }
  await scheduler.runSchedule(stored(sched.id), options);
  assert.equal(executions, 1, "recovering storage restores execution without restarting the daemon");
  assert.equal(history(sched.id).length, 1);
});
