// A successful process exit and streamed narration are not proof of a completed turn.
// In-memory runtime fixtures exercise both real runner parsers without a real engine process.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { runClaude } = await import("../src/engines/claude.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const narration = "I am applying the update and will verify it next.";
const progress = [
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: narration } } },
  { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "write-1", name: "Bash", input: {} } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
];
const usage = { input_tokens: 900, output_tokens: 120 };
function terminal(overrides = {}) {
  return { type: "result", subtype: "error_during_execution", is_error: true, session_id: "partial-session", usage, total_cost_usd: 0.02, ...overrides };
}
async function cold(events) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const target = { backend: "test", runtime: { capabilities: {}, spawn() {
    queueMicrotask(() => {
      child.stderr.write("Execution interrupted before verification");
      child.stdout.write(events.map(JSON.stringify).join("\n") + "\n");
      child.emit("close", 0, null);
    });
    return child;
  } } };
  return runClaude({ cwd: process.cwd(), prompt: "Apply and verify the update.", target, timeoutMs: 1000 });
}
async function warm(events, steer = false) {
  const session = new PersistentClaudeSession({ cwd: process.cwd(), args: [] });
  session.child = { stdin: { write() { return true; } } };
  session.state = "ready";
  session.stderr = "";
  const turn = session.send("Apply and verify the update.", { timeoutMs: 1000 });
  session.stderr = "Execution interrupted before verification";
  if (steer) assert.equal(session.interrupt(), true);
  for (const event of events) session._handleLine(JSON.stringify(event));
  const result = await turn;
  session._clearIdle();
  assert.equal(session.alive, true, "terminal harness results keep the resumable warm session");
  return result;
}

for (const [mode, run] of [["cold", cold], ["warm", warm]]) {
  for (const verdict of [terminal(), terminal({ is_error: undefined })]) {
    test(`${mode}: error result overrides prior narration (${verdict.is_error === true ? "flag" : "subtype only"})`, async () => {
      const result = await run([...progress, verdict]);
      assert.equal(result.engineError, true);
      assert.equal(result.completed, false);
      assert.equal(result.endReason, "error_during_execution");
      assert.equal(result.content, narration, "partial output remains available to the orchestrator");
      assert.equal(result.toolUseCount, 1, "a possibly executed write is not silently replay-safe");
      assert.deepEqual(result.usage, usage);
      assert.equal(result.costUSD, 0.02);
      assert.equal(result.sessionId, "partial-session");
      assert.match(result.diagnostic, /interrupted before verification/);
    });
  }
  test(`${mode}: terminal success preserves the answer and accounting`, async () => {
    const result = await run([...progress, terminal({ subtype: "success", is_error: false })]);
    assert.equal(result.completed, true);
    assert.equal(result.engineError, false);
    assert.equal(result.content, narration);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.diagnostic, undefined);
  });
}

test("cold: clean exit with narration but no terminal event is incomplete", async () => {
  const result = await cold(progress);
  assert.equal(result.completed, false);
  assert.equal(result.engineError, true);
  assert.equal(result.endReason, "missing_terminal_result");
  assert.equal(result.content, narration);
  assert.equal(result.toolUseCount, 1);
});

test("warm: deliberate steering remains distinguishable from a harness failure", async () => {
  const result = await warm([...progress, terminal()], true);
  assert.equal(result.interrupted, true);
  assert.equal(result.completed, false);
  assert.equal(result.content, narration);
  assert.deepEqual(result.usage, usage);
});
