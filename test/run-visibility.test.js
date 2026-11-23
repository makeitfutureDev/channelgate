// Visibility of unattended work in chat: schedules' "only when it fails" result policy and the HTTP
// run API's `visibility` (visible / hidden / on-failure).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "run-visibility-workspaces");

const { suppressScheduleResult, needsAttention } = await import("../src/gateway/schedule-outcome.js");
const { validateScheduleOptions } = await import("../src/config/schedule-options.js");
const { startApiRun, getApiJob, failureAlertText } = await import("../src/gateway/api-runs.js");

const outcome = (status) => ({ automationOutcome: { status } });

test("result policy on-failure posts only runs that need attention", () => {
  const sched = { resultPolicy: "on-failure" };
  for (const s of ["succeeded", "no-op"]) assert.equal(suppressScheduleResult(sched, outcome(s)), true, s);
  for (const s of ["failed", "blocked", "interrupted", "unreported"]) assert.equal(suppressScheduleResult(sched, outcome(s)), false, s);
  assert.equal(suppressScheduleResult({ resultPolicy: "on-result" }, outcome("succeeded")), false, "on-result is unchanged");
  assert.equal(needsAttention(undefined), true, "a missing outcome is never healthy");
  assert.match(validateScheduleOptions({ resultPolicy: "on-failure", failureNotify: false }), /needs failure notifications on/);
  assert.match(validateScheduleOptions({ kind: "reminder", resultPolicy: "on-failure" }), /not reminders/);
  assert.equal(validateScheduleOptions({ resultPolicy: "on-failure", executionVisibility: "silent" }), "");
});

test("API visibility is validated, defaults to visible, and on-failure asks for the outcome report", async () => {
  const driver = () => {};
  const bad = await startApiRun({ message: "x", visibility: "sometimes", driver });
  assert.equal(bad.code, 400);
  assert.match(bad.error, /visible, hidden, on-failure/);

  const plain = getApiJob((await startApiRun({ message: "x", driver })).jobId);
  assert.equal(plain.visibility, "visible");
  assert.equal(plain.reportOutcome, false);

  const hidden = getApiJob((await startApiRun({ message: "x", visibility: "hidden", driver })).jobId);
  assert.equal(hidden.visibility, "hidden");
  assert.equal(hidden.slackThread, false);

  const onFailure = getApiJob((await startApiRun({ message: "x", visibility: "on-failure", driver })).jobId);
  assert.equal(onFailure.reportOutcome, true, "detecting a failed task needs the agent's report");
  assert.match(onFailure.textForRun, /Automation outcome reporting/);
});

test("the failure alert names the run, request, reason and broken connections", () => {
  const text = failureAlertText({ id: "job1", taskStatus: "blocked", message: "Draft replies to unread mail",
    outcome: { summary: "Gmail token expired", connections: [{ name: "composio-agent/gmail", status: "unavailable" }, { name: "x", status: "available" }] } });
  assert.match(text, /API run `job1` was blocked/);
  assert.match(text, /Draft replies to unread mail/);
  assert.match(text, /Gmail token expired/);
  assert.match(text, /composio-agent\/gmail unavailable/);
  assert.doesNotMatch(text, /x available/);
  assert.match(failureAlertText({ id: "j2", taskStatus: "failed", error: "boom" }), /`j2` failed[^]*boom/);
});
