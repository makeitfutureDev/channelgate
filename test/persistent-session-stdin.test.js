// H11(b): the warm session's stdin is its own EventEmitter — a write racing the process dying
// (EPIPE) surfaces as an async 'error' on the stdin stream, NOT on the child. Without a listener
// that is an uncaught EventEmitter error that takes the whole daemon down. These tests spawn a
// real child (a stub `claude` on a shimmed PATH, mirroring the e2e fixtures) and fire the exact
// stream error to prove it is routed through the normal death path: the in-flight turn rejects,
// the session dies, and the pool-eviction hook (onDead) runs.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PersistentClaudeSession } from "../src/engines/persistent-session.js";

// Stub `claude` that consumes stdin forever, so the warm process stays alive until we kill it.
const stubDir = mkdtempSync(path.join(os.tmpdir(), "cg-warm-stub-"));
const stubPath = path.join(stubDir, "claude");
writeFileSync(stubPath, "#!/bin/sh\ncat > /dev/null\n");
chmodSync(stubPath, 0o755);
const env = { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH || ""}` };

const posixTest = process.platform === "win32" ? test.skip : test;

function startSession() {
  const s = new PersistentClaudeSession({ cwd: stubDir, args: [], env });
  s.start();
  return s;
}

posixTest("a stdin EPIPE mid-turn rejects only that turn and evicts the session", async () => {
  const s = startSession();
  let evicted = 0;
  s.onDead = () => {
    evicted += 1;
  };

  const turn = s.send("hello", {});
  assert.equal(s.state, "busy");

  // The exact race: the write completed but the pipe broke — Node emits 'error' on stdin. With
  // no listener this emit() would THROW (the daemon-killing uncaught error this fix prevents).
  s.child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

  await assert.rejects(turn, (err) => {
    assert.equal(err.details?.engine, "claude");
    assert.equal(err.details?.processEnded, false);
    return true;
  });
  assert.equal(s.alive, false, "only this warm session died");
  assert.equal(evicted, 1, "the pool eviction hook ran");
});

posixTest("a stdin error with no turn in flight kills the session quietly", async () => {
  const s = startSession();
  let evicted = 0;
  s.onDead = () => {
    evicted += 1;
  };

  assert.doesNotThrow(() => {
    s.child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  });
  assert.equal(s.alive, false);
  assert.equal(evicted, 1);

  // A later send() fails cleanly instead of writing into a broken pipe.
  await assert.rejects(s.send("follow-up", {}), /session is dead/);
});
