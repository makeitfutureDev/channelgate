// Unit tests for interrupt-steer at the persistent-session state-machine level (no spawned CLI).
// The live end-to-end behavior (real `claude` cuts the turn, keeps the warm process, resumes with
// context) was verified out-of-band; these lock in the wrapper's contract:
//   - interrupt() only acts on a turn that's actually in flight,
//   - it writes the SDK control_request interrupt frame to stdin, and
//   - the interrupted turn's result carries `interrupted: true` (so run.js doesn't mistake the
//     empty/cut-short result for a broken session and the Slack layer hands off quietly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PersistentClaudeSession } from "../src/engines/persistent-session.js";

// Build a session with a fake child so nothing spawns; capture what gets written to stdin.
function fakeSession() {
  const writes = [];
  const s = new PersistentClaudeSession({ cwd: "/tmp", args: [] });
  s.child = { stdin: { write: (m) => (writes.push(m), true) }, stdout: {}, stderr: {} };
  s.state = "ready";
  return { s, writes };
}

test("interrupt(): no-op when no turn is in flight", () => {
  const { s, writes } = fakeSession();
  assert.equal(s.interrupt(), false); // state is "ready", nothing to steer
  assert.equal(writes.length, 0);
});

test("interrupt(): writes the control_request frame and flags the turn", () => {
  const { s, writes } = fakeSession();
  const p = s.send("do a long thing", {}); // → state busy, turn created, user frame written
  assert.equal(s.state, "busy");
  const userFrames = writes.filter((w) => w.includes('"type":"user"'));
  assert.equal(userFrames.length, 1);

  assert.equal(s.interrupt(), true);
  const ctrl = writes.map((w) => JSON.parse(w)).find((m) => m.type === "control_request");
  assert.ok(ctrl, "an interrupt control_request was written");
  assert.equal(ctrl.request.subtype, "interrupt");
  assert.ok(ctrl.request_id, "interrupt carries a request_id");
  assert.equal(s.turn.interrupted, true);

  // The result line that follows must resolve the turn with interrupted:true.
  s._onStdout(JSON.stringify({ type: "result", subtype: "error_during_execution", result: "", session_id: "sid-1" }) + "\n");
  return p.then((r) => {
    assert.equal(r.interrupted, true);
    assert.equal(r.sessionId, "sid-1");
    assert.equal(s.state, "ready"); // session stays warm for the follow-up turn
    s.terminate();
  });
});

test("interrupt(): a normal (un-interrupted) turn resolves interrupted:false", () => {
  const { s } = fakeSession();
  const p = s.send("quick thing", {});
  s._onStdout(JSON.stringify({ type: "result", subtype: "success", result: "hi", session_id: "sid-2" }) + "\n");
  return p.then((r) => {
    assert.equal(r.interrupted, false);
    assert.equal(r.content, "hi");
    s.terminate();
  });
});
