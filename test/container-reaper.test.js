// Leases, the idle sweep, and the max-running cap. The idle clock is injected so the assertions
// are exact; the interval wiring is proved separately with node:test's fake timers.
import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function fakeTarget(name, { idleMinutes = 10 } = {}) {
  return { slug: name, platform: "slack", settings: { idleMinutes, maxRunning: 8 }, container: { name } };
}

function makeReaper(overrides = {}) {
  const stopped = [];
  const logs = [];
  const c = overrides.clock || clock();
  const reaper = createContainerReaper({
    now: c.now,
    log: (m) => logs.push(m),
    stopContainer: async (name) => {
      if (overrides.failStop?.includes(name)) throw new Error("busy");
      stopped.push(name);
    },
    sleep: overrides.sleep || (async () => { c.advance(overrides.sleepAdvance ?? 2_000); }),
    slotWaitMs: overrides.slotWaitMs,
    ...overrides.reaper,
  });
  return { reaper, stopped, logs, clock: c };
}

test("idle sweep: a container past its idle window with no leases is stopped, not removed", async () => {
  const { reaper, stopped, clock: c } = makeReaper();
  const t = fakeTarget("cg-idle", { idleMinutes: 10 });
  reaper.markRunning("cg-idle", t);
  c.advance(9 * 60_000);
  assert.deepEqual(await reaper.tick(), [], "still inside the idle window");
  c.advance(2 * 60_000);
  assert.deepEqual(await reaper.tick(), ["cg-idle"]);
  assert.deepEqual(stopped, ["cg-idle"]);
  assert.deepEqual(await reaper.tick(), [], "a stopped container is not stopped twice");
});

test("a lease blocks the sweep, and releasing it restarts the idle clock", async () => {
  const { reaper, stopped, clock: c } = makeReaper();
  const t = fakeTarget("cg-leased");
  reaper.markRunning("cg-leased", t);
  const lease = reaper.acquireLease(t, { kind: "job", id: "j1" });
  assert.equal(reaper.leaseCount("cg-leased"), 1);
  c.advance(60 * 60_000);
  assert.deepEqual(await reaper.tick(), [], "a leased container is never stopped, however quiet");
  lease.release();
  assert.equal(reaper.leaseCount("cg-leased"), 0);
  assert.deepEqual(await reaper.tick(), [], "release() counts as activity — the idle clock starts now");
  c.advance(11 * 60_000);
  assert.deepEqual(await reaper.tick(), ["cg-leased"]);
  assert.deepEqual(stopped, ["cg-leased"]);
  lease.release(); // idempotent
  assert.equal(reaper.leaseCount("cg-leased"), 0);
});

test("max running: the least-recently-used IDLE container is stopped to make room", async () => {
  const { reaper, stopped, clock: c } = makeReaper();
  const names = ["cg-1", "cg-2", "cg-3"];
  for (const name of names) {
    reaper.markRunning(name, fakeTarget(name));
    c.advance(1_000);
  }
  reaper.touch("cg-1"); // cg-1 is now the most recent; cg-2 is the LRU
  const result = await reaper.reserveSlot("cg-new", { maxRunning: 3 });
  assert.deepEqual(result.stopped, ["cg-2"]);
  assert.deepEqual(stopped, ["cg-2"]);
  assert.equal(result.waitedMs, 0, "stopping an idle container needs no wait");
});

test("max running: a fully leased fleet waits, says so once, then fails with an actionable error", async () => {
  const { reaper, logs, clock: c } = makeReaper({ slotWaitMs: 10_000, sleepAdvance: 3_000 });
  const held = [];
  for (const name of ["cg-a", "cg-b"]) {
    const t = fakeTarget(name);
    reaper.markRunning(name, t);
    held.push(reaper.acquireLease(t, { kind: "run", id: name }));
  }
  const announced = [];
  await assert.rejects(
    reaper.reserveSlot("cg-c", { maxRunning: 2, announce: (m) => announced.push(m) }),
    /all 2 container slots are busy with active runs/,
  );
  assert.equal(logs.filter((m) => /waiting for a container slot/.test(m)).length, 1, "the wait is announced exactly once");
  assert.equal(announced.length, 1);
  assert.match(announced[0], /Waiting for a container slot/);

  // Freeing a lease lets the next attempt through by stopping the now-idle container.
  held[0].release();
  c.advance(1_000);
  const ok = await reaper.reserveSlot("cg-c", { maxRunning: 2 });
  assert.deepEqual(ok.stopped, ["cg-a"]);
});

test("the sweep interval is created once and can be stopped twice", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reaper = createContainerReaper({ sweepMs: 60_000, stopContainer: async () => {} });
  const timer = reaper.startTimer();
  assert.ok(timer, "startTimer returns the interval");
  assert.equal(reaper.startTimer(), timer, "startTimer is idempotent — a second boot must not double-sweep");
  reaper.stopTimer();
  reaper.stopTimer();
  assert.equal(reaper.startTimer() === timer, false, "after stopping, a fresh interval is created");
  reaper.stopTimer();
});

test("fake timers: an idle container is stopped by the interval itself", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const stopped = [];
  const reaper = createContainerReaper({ sweepMs: 60_000, stopContainer: async (name) => { stopped.push(name); } });
  reaper.markRunning("cg-timer", fakeTarget("cg-timer", { idleMinutes: 1 }));
  reaper.startTimer();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(stopped, [], "not idle yet");
  t.mock.timers.tick(61_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stopped, ["cg-timer"]);
  reaper.stopTimer();
});

test("snapshot reports what /api/health shows, and forget drops a destroyed container", () => {
  const { reaper, clock: c } = makeReaper();
  const t = fakeTarget("cg-snap");
  reaper.markRunning("cg-snap", t);
  const lease = reaper.acquireLease(t, { kind: "review", id: "r1" });
  c.advance(5_000);
  const [row] = reaper.snapshot();
  assert.equal(row.name, "cg-snap");
  assert.equal(row.running, true);
  assert.equal(row.leases, 1);
  assert.equal(row.idleMs, 5_000);
  assert.equal(row.slug, "cg-snap");
  lease.release();
  reaper.forget("cg-snap");
  assert.equal(reaper.size, 0);
  assert.deepEqual(reaper.snapshot(), []);
});

test("a lease on a target with no container name is a harmless no-op", () => {
  const { reaper } = makeReaper();
  const lease = reaper.acquireLease({ slug: "host-chan" }, { kind: "run", id: "x" });
  assert.equal(typeof lease.release, "function");
  lease.release();
  assert.equal(reaper.size, 0);
});
