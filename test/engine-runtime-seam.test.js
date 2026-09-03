// The runtime seam, from the ENGINE side (v0.8 P1). Every engine process the daemon starts now
// goes through a RuntimeBackend: spawn, liveness probe and signals cross that surface instead of
// calling child_process / process.kill directly. These tests drive the real runners against a fake
// backend (test/fixtures/fake-runtime-backend.js) and assert the crossing itself — the spawn spec,
// that liveness asks the backend rather than the pid, that a stop reaches the backend's signal, and
// that WHERE a warm process runs is part of the pool's launch identity.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

ensureTestEnv();

const { runClaude } = await import("../src/engines/claude.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const { createSessionPool } = await import("../src/engines/session-pool.js");
const { trackEngineChild, shutdownEngineChildren, engineProcessStats } = await import("../src/engines/process-registry.js");
const { resumeCommandFor } = await import("../src/engines/registry.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { localRuntime } = await import("../src/runtimes/local.js");
const { isRuntimeChild, runIdKind } = await import("../src/runtimes/contract.js");

// Wait for the thing itself, not for a wall-clock guess: the suite runs files in parallel, and a
// fixed sleep around a 25ms watchdog window is exactly the kind of flake that erodes trust in it.
async function waitUntil(predicate, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the runner");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const resultLine = (text) => `${JSON.stringify({ type: "result", subtype: "success", result: text, session_id: "s-1" })}\n`;

test("a cold Claude turn is spawned BY the backend, with the spec the contract describes", async () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const pending = runClaude({
    cwd: target.cwd,
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    target,
    timeoutMs: 60_000,
  });

  assert.equal(rt.spawns.length, 1, "spawn is synchronous, exactly like child_process.spawn");
  const spec = rt.spawns[0];
  assert.equal(spec.cmd, "claude");
  assert.equal(spec.cwd, target.cwd);
  assert.deepEqual(spec.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spec.detached, true, "the engine stays the leader of its own group");
  assert.equal(spec.kind, "turn");
  assert.equal(runIdKind(spec.runId), "run", "a cold turn's group handle is a run- id");
  assert.ok(spec.args.includes("--session-id") && spec.args.includes("s-1"));

  const child = rt.children[0];
  assert.equal(isRuntimeChild(child), true, "the child carries its runtime, so probe/signal can find it");
  assert.equal(child.runtime.backend, "container");
  assert.equal(child.runtime.target, target);

  child.stdout.write(resultLine("done"));
  child.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.content, "done");
});

test("liveness asks the BACKEND, not the pid — and an unprovable probe keeps the turn waiting", async () => {
  const rt = createFakeRuntime();
  // "I could not tell": the container daemon is wedged, the exec throws. A pid probe would have
  // said "gone" (that pid does not exist on this host) and killed a healthy turn.
  rt.setProbe(() => {
    throw new Error("container daemon did not answer");
  });
  const target = rt.target();
  const quiet = [];
  const pending = runClaude({
    cwd: target.cwd,
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    target,
    timeoutMs: 25,
    maxSilenceMs: 100_000,
    onEvent: (event) => {
      if (event.kind === "quiet") quiet.push(event);
    },
  });

  await waitUntil(() => rt.probes.length >= 1 && quiet.length >= 1);
  assert.ok(rt.probes.length >= 1, "the watchdog probed through the backend");
  assert.ok(quiet.length >= 1, "an unprovable probe is reported as a quiet wait");
  assert.equal(rt.signals.length, 0, "…and never ends the turn");

  const child = rt.children[0];
  child.stdout.write(resultLine("still here"));
  child.emit("close", 0, null);
  assert.equal((await pending).content, "still here");
});

test("a definite `false` from the backend ends the turn, and the kill goes back through it", async () => {
  const rt = createFakeRuntime();
  rt.setProbe(() => false);
  const target = rt.target();
  const pending = runClaude({
    cwd: target.cwd,
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    target,
    timeoutMs: 25,
    maxSilenceMs: 100_000,
  });

  await waitUntil(() => rt.signals.length >= 1);
  assert.deepEqual(rt.signals.map((s) => s.signal), ["SIGTERM"], "the process group is signalled by the backend");
  assert.equal(rt.signals[0].via, "backend");
  assert.equal(rt.signals[0].runId, rt.spawns[0].runId, "…addressed by the run's own id");

  rt.children[0].emit("close", null, "SIGTERM");
  await assert.rejects(pending, /produced no output/);
});

test("a user stop signals the backend instead of the host pid", async () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const controller = new AbortController();
  const pending = runClaude({
    cwd: target.cwd,
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    target,
    signal: controller.signal,
    timeoutMs: 60_000,
  });

  controller.abort();
  assert.deepEqual(rt.signals.map((s) => `${s.via}:${s.signal}`), ["backend:SIGTERM"]);
  rt.children[0].emit("close", null, "SIGTERM");
  await assert.rejects(pending, /stopped before it finished/);
});

test("a warm session spawns as a warm- group, steers on stdin, and dies through the backend", async () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const session = new PersistentClaudeSession({ cwd: target.cwd, args: ["-p"], env: { PATH: "/usr/bin" }, target, idleMs: 60_000 });
  session.start();

  const spec = rt.spawns[0];
  assert.equal(spec.cmd, "claude");
  assert.equal(spec.kind, "warm");
  assert.equal(runIdKind(spec.runId), "warm", "the boot sweep filters warm processes by this prefix");
  assert.deepEqual(spec.stdio, ["pipe", "pipe", "pipe"]);

  const child = rt.children[0];
  const written = [];
  child.stdin.on("data", (chunk) => written.push(String(chunk)));

  const turn = session.send("first");
  await waitUntil(() => written.join("").includes('"type":"user"'));
  assert.match(written.join(""), /"type":"user"/, "the prompt still rides stdin — steering is unchanged");
  assert.equal(session.interrupt(), true);
  await waitUntil(() => written.join("").includes('"subtype":"interrupt"'));
  assert.match(written.join(""), /"subtype":"interrupt"/);

  child.stdout.write(resultLine("warm answer"));
  assert.equal((await turn).content, "warm answer");

  session.terminate();
  assert.deepEqual(rt.signals.map((s) => `${s.via}:${s.signal}`), ["backend:SIGKILL"]);
});

test("a warm process whose container stopped dies like any other dead process", async () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const session = new PersistentClaudeSession({ cwd: target.cwd, args: ["-p"], env: {}, target, idleMs: 60_000 });
  let evicted = 0;
  session.onDead = () => {
    evicted += 1;
  };
  session.start();
  const turn = session.send("first");

  // The container was stopped under it (reaper, image upgrade, operator): the exec client exits,
  // which is the same "close" every crashed warm process produces — no special case needed.
  rt.children[0].emit("close", 137, null);
  await assert.rejects(turn, (error) => {
    assert.equal(error.details?.engine, "claude");
    assert.equal(error.details?.processEnded, true);
    return true;
  });
  assert.equal(session.alive, false);
  assert.equal(evicted, 1, "the pool evicts it, and the next message relaunches");
});

test("the warm pool treats WHERE a process runs as part of its launch identity", async () => {
  const created = [];
  class FakeSession {
    constructor(options) {
      this.options = options;
      this.state = "ready";
      this.alive = true;
      created.push(options);
    }
    start() {
      return this;
    }
    async send() {
      return { content: "ok" };
    }
    terminate() {
      this.state = "dead";
      this.alive = false;
    }
  }
  const pool = createSessionPool({ createSession: (options) => new FakeSession(options), maxSessions: () => 8 });
  const rtA = createFakeRuntime({ fingerprint: "container:image-a" });
  const rtB = createFakeRuntime({ fingerprint: "container:image-b" });
  const base = { key: "chan::thread", cwd: "/work/rt-channel", args: [], env: {}, idleMs: 1, mcpConfigJson: "cfg", dangerouslySkip: false, text: "hi" };

  await pool.runPooled({ ...base, target: rtA.target() });
  await pool.runPooled({ ...base, target: rtA.target() });
  assert.equal(created.length, 1, "the same runtime keeps the warm process");
  assert.equal(created[0].target.backend, "container", "the session is told where to run");

  // Same container NAME, recreated with a new image: the backend's create-time digest changed, so
  // the warm process that belonged to the old one must not answer the next turn.
  await pool.runPooled({ ...base, target: rtB.target() });
  assert.equal(created.length, 2);

  // And the daemon's OWN local turn (no container) never reuses a container's warm process.
  await pool.runPooled({ ...base, target: localRuntimeTarget("/work/rt-channel") });
  assert.equal(created.length, 3);
  await pool.runPooled({ ...base, target: localRuntimeTarget("/work/rt-channel") });
  assert.equal(created.length, 3, "…and the local fingerprint is itself stable");
  pool.shutdownPool();
});

test("the daemon's shutdown sweep signals container children through their backend", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const child = rt.backend.spawn(target, { cmd: "claude", args: [], env: {}, runId: "run-shutdown-1", kind: "turn" });
  trackEngineChild(child, { engine: "claude", kind: "cold" });

  const stats = engineProcessStats().filter((row) => row.pid === child.pid);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].backend, "container", "status can say where a live run is running");
  assert.equal(stats[0].runId, "run-shutdown-1");

  shutdownEngineChildren({ killAfterMs: 5_000 });
  assert.deepEqual(rt.signals.map((s) => `${s.via}:${s.signal}`), ["backend:SIGTERM"]);
  child.emit("close", 0, null); // untrack, so later tests in this file start clean
});

test("resumeCommandFor wraps the engine's own command in the runtime's", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  assert.equal(resumeCommandFor("claude", "abc"), "claude --resume abc", "the 2-arg form is untouched");
  assert.equal(resumeCommandFor("claude", "abc", {}), "claude --resume abc");
  assert.equal(
    resumeCommandFor("claude", "abc", { target }),
    "podman exec -it -w /work/rt-channel cg-test-channel claude --resume abc",
  );
  assert.equal(
    resumeCommandFor("codex", "xyz", { target }),
    "podman exec -it -w /work/rt-channel cg-test-channel codex exec resume xyz",
  );
  assert.equal(resumeCommandFor("codex", "xyz", { target: localRuntimeTarget("/work") }), "codex exec resume xyz", "the local spawner wraps nothing");
});

test("no target = the daemon's own local spawner, which is not a channel runtime", () => {
  // Only the daemon's own turns (the update smoke probe, direct-runner tests) pass no target; a
  // channel turn always resolves a container target in run.js before it reaches a runner.
  const target = localRuntimeTarget("/work/rt-channel");
  assert.equal(target.backend, "local");
  assert.equal(target.runtime, localRuntime);
  assert.equal(target.artifactDir, null, "nothing is mounted: a local child sees the daemon's filesystem as it is");
  assert.equal(target.runtime.fingerprint(target), "local");
  assert.equal(target.runtime.capabilities.isolated, false, "no container boundary — a runner that needs one refuses it");
});
