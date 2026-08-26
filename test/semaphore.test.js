// Unit tests for the run-concurrency semaphore (M2). Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "../src/util/semaphore.js";

const tick = () => new Promise((r) => setImmediate(r));

test("caps concurrency and queues FIFO", async () => {
  const sem = createSemaphore(2);
  const order = [];
  const releases = [];

  for (const id of ["a", "b", "c", "d"]) {
    sem.acquire().then((release) => {
      order.push(id);
      releases.push(release);
    });
  }
  await tick();
  assert.deepEqual(order, ["a", "b"]); // only 2 slots
  assert.equal(sem.active, 2);
  assert.equal(sem.pending, 2);

  releases.shift()(); // a releases → c enters
  await tick();
  assert.deepEqual(order, ["a", "b", "c"]);

  releases.shift()(); // b releases → d enters
  await tick();
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(sem.pending, 0);
});

test("release is idempotent (double release frees one slot only)", async () => {
  const sem = createSemaphore(1);
  const r1 = await sem.acquire();
  r1();
  r1(); // no-op
  assert.equal(sem.active, 0);
  const r2 = await sem.acquire();
  assert.equal(sem.active, 1);
  r2();
});

test("nonsense max clamps to at least 1", async () => {
  for (const bad of [0, -3, NaN, "x", undefined]) {
    const sem = createSemaphore(bad);
    assert.equal(sem.max, 1);
    const release = await sem.acquire();
    release();
  }
});

// The run orchestrator depends on two properties a bare counter gets wrong. Both are about the
// runner being trustworthy: the status a user sees must be true, and a stopped run must not go on
// consuming capacity a live run is waiting for.

test("onWait fires only when a call ACTUALLY queues", async () => {
  const sem = createSemaphore(2);
  const waited = [];
  const onWait = (info) => waited.push(info);

  // Both fit — neither may claim it queued.
  const r1 = await sem.acquire({ onWait });
  const r2 = await sem.acquire({ onWait });
  assert.deepEqual(waited, [], "a run that starts immediately must never report a wait");

  // Third has to queue.
  const pending = sem.acquire({ onWait });
  await new Promise((r) => setImmediate(r));
  assert.equal(waited.length, 1, "a genuinely queued run reports once");
  assert.equal(waited[0].position, 1, "it is first in line");
  assert.equal(waited[0].max, 2);

  r1();
  const r3 = await pending;
  r2();
  r3();
});

test("queue position reflects arrival order", async () => {
  const sem = createSemaphore(1);
  const positions = [];
  const hold = await sem.acquire();

  const a = sem.acquire({ onWait: (i) => positions.push(i.position) });
  await new Promise((r) => setImmediate(r));
  const b = sem.acquire({ onWait: (i) => positions.push(i.position) });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(positions, [1, 2], "the second arrival must know it is behind the first");
  hold();
  (await a)();
  (await b)();
});

test("aborting while queued LEAVES the queue instead of consuming a slot later", async () => {
  const sem = createSemaphore(1);
  const hold = await sem.acquire();

  const ac = new AbortController();
  const queued = sem.acquire({ signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.pending, 1);

  ac.abort();
  await assert.rejects(() => queued, (e) => e.name === "AbortError");
  assert.equal(sem.pending, 0, "the cancelled waiter must be gone, not still holding a place");

  // The freed slot goes to a LIVE run, not to the abandoned one.
  hold();
  const next = await sem.acquire();
  assert.equal(sem.active, 1);
  next();
});

test("an already-aborted signal never takes a slot at all", async () => {
  const sem = createSemaphore(1);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => sem.acquire({ signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(sem.active, 0, "a stopped run must not consume capacity");
  assert.equal(sem.pending, 0);
});

test("a granted waiter's abort listener does not corrupt the queue", async () => {
  // Abort arriving AFTER the slot was granted is the run's problem, not the queue's — the
  // semaphore must not double-reject or drop someone else's entry.
  const sem = createSemaphore(1);
  const ac = new AbortController();
  const first = await sem.acquire({ signal: ac.signal });
  const behind = sem.acquire();
  await new Promise((r) => setImmediate(r));

  ac.abort();
  assert.equal(sem.pending, 1, "the unrelated waiter behind us must still be queued");
  first();
  (await behind)();
  assert.equal(sem.active, 0);
});

test("a throwing onWait callback cannot break an acquire", async () => {
  const sem = createSemaphore(1);
  const hold = await sem.acquire();
  const queued = sem.acquire({ onWait: () => { throw new Error("status reporting blew up"); } });
  hold();
  const release = await queued;
  assert.equal(typeof release, "function", "reporting is best-effort; the run still gets its slot");
  release();
});

test("FIFO is preserved — a late arrival cannot jump a formed queue", async () => {
  const sem = createSemaphore(1);
  const order = [];
  const hold = await sem.acquire();

  const a = sem.acquire().then((r) => { order.push("a"); return r; });
  await new Promise((r) => setImmediate(r));
  const b = sem.acquire().then((r) => { order.push("b"); return r; });
  await new Promise((r) => setImmediate(r));

  hold();
  (await a)();
  (await b)();
  assert.deepEqual(order, ["a", "b"]);
});
