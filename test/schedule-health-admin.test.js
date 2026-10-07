import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
import { automationRunMarkup, automationSummaryMarkup, automationStatusLabel, automationStatusTone } from "../public/admin-schedules.js";
ensureTestEnv();
const { createSchedulesRouter } = await import("../src/web/routes/schedules.js");
const { addSchedule, getSchedules, deleteSchedule } = await import("../src/config/schedules.js");
const { createScheduleRun, updateScheduleRun, appendScheduleRunEvent } = await import("../src/gateway/schedule-runs.js");
const { setUser, upsertChannelEntry } = await import("../src/config/store.js");
const app = express();
app.use(express.json());
app.use(createSchedulesRouter());
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
function fixture(extra = {}) { return addSchedule({ channelId: "CHEALTH", slug: "health", cron: "0 9 * * *", prompt: "Check inbox", createdBy: "UHEALTH", notify: "none", ...extra }); }
async function patch(id, body) {
  return fetch(`${base}/schedules/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("admin atomically configures silent conditional reporting and explicit thread delivery", async () => {
  const schedule = fixture();
  const response = await patch(schedule.id, { executionVisibility: "silent", resultPolicy: "on-result", failureNotify: true, delivery: "thread", deliveryThread: "1790355659.378439" });
  assert.equal(response.status, 200);
  const { schedule: stored } = await response.json();
  assert.equal(stored.executionVisibility, "silent");
  assert.equal(stored.resultPolicy, "on-result");
  assert.equal(stored.failureNotify, true);
  assert.equal(stored.delivery, "thread");
  assert.equal(stored.deliveryThread, "1790355659.378439");
  const second = await patch(schedule.id, { failureNotify: false });
  assert.equal((await second.json()).schedule.failureNotify, false);
});

test("invalid health controls and missing thread reject the whole edit", async () => {
  const schedule = fixture();
  for (const fields of [{ executionVisibility: "hidden" }, { resultPolicy: "skip" }, { failureNotify: "false" }, { delivery: "thread" }, { delivery: "thread", deliveryThread: "bad\nthread" }, { delivery: "thread", deliveryThread: "sched-not-a-platform-thread" }, { delivery: "thread", deliveryThread: "not a thread" }]) {
    assert.equal((await patch(schedule.id, { description: "Must not save", ...fields })).status, 400);
    assert.equal(getSchedules().find((s) => s.id === schedule.id).description, "");
  }
});

test("reminders reject silent and conditional task policies atomically", async () => {
  const schedule = fixture({ kind: "reminder" });
  for (const fields of [{ executionVisibility: "silent" }, { resultPolicy: "on-result" }, { failureNotify: false }, { delivery: "thread", deliveryThread: "1790355659.378439" }]) {
    assert.equal((await patch(schedule.id, { description: "Must not save", ...fields })).status, 400);
    assert.equal(getSchedules().find((s) => s.id === schedule.id).description, "");
  }
});

test("history survives deletion, paginates by run ID, and separates engine success from missing outcome", async () => {
  await setUser("UHEALTH", { name: "Ada Test", approved: true });
  await upsertChannelEntry("DHEALTH", { name: "dm-UHEALTH", isDM: true });
  const schedule = fixture({ channelId: "DHEALTH", slug: "dm-UHEALTH", description: "Email check" });
  const first = createScheduleRun(schedule);
  updateScheduleRun(first.id, { status: "no-op", engineStatus: "completed", taskStatus: "no-op", deliveryStatus: "suppressed", completedAt: new Date().toISOString(), summary: "No new email" });
  const second = createScheduleRun(schedule);
  updateScheduleRun(second.id, { status: "unreported", engineStatus: "completed", taskStatus: "unreported", deliveryStatus: "delivered", completedAt: new Date().toISOString() });
  appendScheduleRunEvent(second.id, { kind: "tool_use", name: "gmail.search" });
  deleteSchedule(schedule.id);
  const response = await fetch(`${base}/schedules/${schedule.id}/runs?limit=1`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.runs[0].id, second.id);
  assert.equal(body.runs[0].channelName, "DM · Ada Test");
  assert.equal(body.summary.noOp, 1);
  assert.equal(body.summary.unreported, 1);
  assert.equal(body.summary.engineCompleted, 2);
  assert.equal(body.summary.successRate, 0.5);
  const older = await (await fetch(`${base}/schedule-runs?scheduleId=${schedule.id}&before=${body.nextBefore}`)).json();
  assert.deepEqual(older.runs.map((run) => run.id), [first.id]);
  const detail = await (await fetch(`${base}/schedule-runs/${second.id}`)).json();
  assert.equal(detail.run.events.at(-1).name, "gmail.search");
  assert.equal(detail.run.taskStatus, "unreported");
  assert.ok((await (await fetch(`${base}/schedule-runs`)).json()).runs.some((run) => run.id === second.id));
});

test("history endpoints reject malformed limits and unknown run IDs", async () => {
  for (const query of ["limit=0", "limit=101", "limit=NaN", "limit=1.5", "scheduleId=a&scheduleId=b", "before=a&before=b"]) {
    assert.equal((await fetch(`${base}/schedule-runs?${query}`)).status, 400);
  }
  assert.equal((await fetch(`${base}/schedule-runs/unknown-run`)).status, 404);
});

test("run presentation preserves unavailable, unreported and delivery failure evidence, and escapes agent text", () => {
  const markup = automationRunMarkup({ description: "<script>bad</script>", channelName: "DM · Ada", status: "unreported", engineStatus: "completed", taskStatus: "unreported", deliveryStatus: "failed", lastActivityAt: new Date().toISOString(), schedulingDelayMs: 1500, connections: [{ name: "Gmail <unsafe>", status: "unavailable" }], events: [{ kind: "tool_use", name: "gmail.search", at: new Date().toISOString() }], summary: "<img onerror=bad>", error: "<unsafe>", eventsDropped: 4 });
  assert.match(markup, /Outcome not reported/);
  assert.match(markup, /Task outcome \(agent-reported\)/);
  assert.match(markup, /Unavailable/);
  assert.match(markup, /gmail.search/);
  assert.match(markup, /4 earlier events omitted/);
  assert.match(markup, /Run requested/);
  assert.match(markup, /Last activity/);
  assert.match(markup, /Scheduling delay[\s\S]*1.5s/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>|<img onerror/);
  assert.equal(automationStatusTone("unreported"), "warn");
  assert.equal(automationStatusLabel("unknown"), "Not checked");
  const summary = automationSummaryMarkup({ total: 3, noOp: 1, succeeded: 1, unreported: 1, engineCompleted: 3, totalCostUsd: null });
  assert.match(summary, /67% of finished runs/);
  assert.match(summary, /Task outcomes and connection checks are reported by the agent/);
  assert.doesNotMatch(summary, /\$0.0000/);
});
