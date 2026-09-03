import test from "node:test";
import assert from "node:assert/strict";
import {
  conciseProcessDiagnostic,
  describeProcessOutcome,
  processFailureMessage,
} from "../src/util/process-outcome.js";

test("process outcomes explain success and portable shell failures without raw numeric codes", () => {
  assert.deepEqual(describeProcessOutcome({ code: 0 }), {
    ok: true,
    kind: "success",
    summary: "completed successfully",
  });
  assert.equal(describeProcessOutcome({ code: 1 }).summary, "failed because it reported a general error");
  assert.equal(describeProcessOutcome({ code: 2 }).summary, "failed because it rejected its input or options");
  assert.match(describeProcessOutcome({ code: 126 }).summary, /not executable|permission was denied/);
  assert.match(describeProcessOutcome({ code: 127 }).summary, /command was not found/);
  assert.equal(describeProcessOutcome({ code: 37 }).summary, "failed before it completed");
  for (const code of [0, 1, 2, 37, 126, 127]) {
    assert.doesNotMatch(describeProcessOutcome({ code }).summary, /\b(?:code|exit)\s*\d+/i);
  }
});

test("process outcomes translate direct and shell-encoded operating-system stops", () => {
  assert.match(describeProcessOutcome({ signal: "SIGTERM" }).summary, /asked to stop/);
  assert.match(describeProcessOutcome({ signal: "SIGKILL" }).summary, /forcibly stopped/);
  assert.match(describeProcessOutcome({ signal: "SIGSEGV" }).summary, /invalid memory access/);
  assert.match(describeProcessOutcome({ signal: "SIGUNKNOWN" }).summary, /operating system/);
  assert.equal(describeProcessOutcome({ code: 130 }).summary, describeProcessOutcome({ signal: "SIGINT" }).summary);
  assert.equal(describeProcessOutcome({ code: 137 }).summary, describeProcessOutcome({ signal: "SIGKILL" }).summary);
  assert.equal(describeProcessOutcome({ code: 143 }).summary, describeProcessOutcome({ signal: "SIGTERM" }).summary);
});

test("process outcomes explain startup failures and time limits", () => {
  assert.match(describeProcessOutcome({ spawnError: { code: "ENOENT" } }).summary, /executable was not found/);
  assert.match(describeProcessOutcome({ spawnError: { code: "EACCES" } }).summary, /denied permission/);
  assert.match(describeProcessOutcome({ spawnError: new Error("socket unavailable") }).summary, /couldn't start/);
  assert.equal(
    describeProcessOutcome({ timedOut: true, timeout: "15-minute" }).summary,
    "stopped after reaching the 15-minute time limit",
  );
  assert.equal(describeProcessOutcome({}).ok, null);
});

test("formatted failures keep concise diagnostics but never use the numeric status as the explanation", () => {
  const message = processFailureMessage("Voice transcription", {
    code: 1,
    diagnostic: "\u001b[31mfirst line\u001b[0m\nActionable detail\n",
  });
  assert.equal(
    message,
    "Voice transcription failed because it reported a general error: first line · Actionable detail",
  );
  assert.doesNotMatch(message, /exit code|code 1/i);
  assert.equal(conciseProcessDiagnostic("one\u0000two", 20), "one two");
  assert.equal(
    conciseProcessDiagnostic("Authorization: Bearer super-secret-value"),
    "Authorization: Bearer [REDACTED]",
    "actionable diagnostics must pass through the shared secret redactor before reaching a user",
  );
});
