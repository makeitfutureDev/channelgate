import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { trackEngineChild, shutdownEngineChildren, forceKillEngineChildren, engineProcessStats } from "../src/engines/process-registry.js";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
  }
}

test("shutdownEngineChildren terminates tracked process groups and escalates", async () => {
  const child = trackEngineChild(new FakeChild(424242), { engine: "codex" });
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return true;
  };
  try {
    assert.equal(shutdownEngineChildren({ killAfterMs: 5 }), 1);
    await delay(20);
    assert.deepEqual(calls, [
      { pid: -424242, signal: "SIGTERM" },
      { pid: -424242, signal: "SIGKILL" },
    ]);
  } finally {
    process.kill = realKill;
    child.emit("close", 0);
  }
});

test("tracked children are removed when they close", () => {
  const child = trackEngineChild(new FakeChild(424243), { engine: "claude" });
  assert.equal(engineProcessStats().some((p) => p.pid === 424243), true);
  child.emit("close", 0);
  assert.equal(engineProcessStats().some((p) => p.pid === 424243), false);
});

test("absolute shutdown sweep synchronously SIGKILLs every tracked process group", () => {
  const child = trackEngineChild(new FakeChild(424244), { engine: "opencode" });
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return true;
  };
  try {
    assert.equal(forceKillEngineChildren(), 1);
    assert.deepEqual(calls, [{ pid: -424244, signal: "SIGKILL" }]);
  } finally {
    process.kill = realKill;
    child.emit("close", 0);
  }
});
