import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { acquireRunSlot, resetRunSlots, runSlotStats } = await import("../src/gateway/run.js");

// One global cap used to serve every run, so a Slack turn queued behind whatever was already in
// it. Background work — schedules, background agents, their continuations, recovery, diagnosis —
// legitimately holds a slot for hours, and there is no bound on how much of it can pile up: enough
// agent jobs took every slot and a live user's message waited for work that might run for days.
// The cap is now two lanes over one pool: background runs must clear a smaller lane semaphore
// first, so the remainder of the pool is reachable only by interactive turns.

// Let queued acquires settle: a background acquire crosses two semaphores, so a single microtask
// turn is not enough.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function withCaps(total, reserved) {
  process.env.MAX_CONCURRENT_RUNS = String(total);
  process.env.RESERVED_INTERACTIVE_RUNS = String(reserved);
  resetRunSlots();
}

test.afterEach(() => {
  delete process.env.MAX_CONCURRENT_RUNS;
  delete process.env.RESERVED_INTERACTIVE_RUNS;
  resetRunSlots();
});

test("a background backlog cannot consume the capacity reserved for live turns", async () => {
  withCaps(4, 2);

  // Six background jobs arrive at once — more than the whole pool, which is the shape that used to
  // starve users.
  const background = Array.from({ length: 6 }, () => acquireRunSlot({ origin: "background_agent" }));
  await settle();

  const parked = runSlotStats();
  assert.equal(parked.backgroundActive, 2, "only total − reserved background runs may hold a slot");
  assert.equal(parked.active, 2, "so half the pool is still free");
  assert.equal(parked.backgroundPending, 4, "the rest wait in their own lane");

  // Two live turns arrive into that backlog. Both must start immediately — onWait fires ONLY when
  // an acquire genuinely queues, so it is the honest witness that neither one waited.
  const live = [];
  for (const label of ["first", "second"]) {
    let queued = false;
    live.push(await acquireRunSlot({ origin: "slack_foreground", onWait: () => { queued = true; } }));
    assert.equal(queued, false, `the ${label} live turn must not queue behind background work`);
  }
  assert.equal(runSlotStats().active, 4, "the pool is now full — 2 background, 2 interactive");

  // A third live turn legitimately waits (the pool really is full), but it waits on runs that are
  // RUNNING, never on the background backlog: the next freed slot goes to it, not to lane waiters.
  let thirdQueued = false;
  const third = acquireRunSlot({ origin: "slack_foreground", onWait: () => { thirdQueued = true; } });
  await settle();
  assert.equal(thirdQueued, true, "precondition — the pool is full, so this one does queue");

  live.shift()();
  const releaseThird = await third;
  assert.equal(runSlotStats().backgroundActive, 2, "the freed slot went to the waiting live turn, not the backlog");

  releaseThird();
  for (const held of live) held();
  for (const pending of background) (await pending)();
  assert.equal(runSlotStats().active, 0);
});

test("the reservation is env-configurable and always leaves the background lane at least one slot", async () => {
  // An operator who reserves more than the pool holds must not deadlock every background job.
  withCaps(2, 5);

  const first = await acquireRunSlot({ origin: "schedule" });
  let secondQueued = false;
  const second = acquireRunSlot({ origin: "schedule", onWait: () => { secondQueued = true; } });
  await settle();
  assert.equal(secondQueued, true, "the lane floors at one background run, not zero");
  assert.equal(runSlotStats().backgroundActive, 1);

  let liveQueued = false;
  const live = await acquireRunSlot({ origin: "slack_foreground", onWait: () => { liveQueued = true; } });
  assert.equal(liveQueued, false, "an interactive turn still gets the rest of the pool");

  first();
  (await second)();
  live();
});

test("the default reserve keeps live capacity without configuration", async () => {
  // Defaults: 8 concurrent runs, 2 of them reserved.
  delete process.env.MAX_CONCURRENT_RUNS;
  delete process.env.RESERVED_INTERACTIVE_RUNS;
  resetRunSlots();

  const background = Array.from({ length: 8 }, () => acquireRunSlot({ origin: "continuation" }));
  await settle();
  assert.equal(runSlotStats().backgroundActive, 6);

  let queued = false;
  const live = await acquireRunSlot({ origin: "slack_foreground", onWait: () => { queued = true; } });
  assert.equal(queued, false);

  live();
  for (const pending of background) (await pending)();
});

test("a background run aborted while waiting for the pool releases its lane slot", async () => {
  // The two-stage acquire has a window between the lane and the pool. Stranding a lane slot there
  // would permanently shrink background capacity, one cancelled schedule at a time.
  withCaps(1, 0);

  const live = await acquireRunSlot({ origin: "slack_foreground" });
  const controller = new AbortController();
  const parked = acquireRunSlot({ origin: "schedule", signal: controller.signal });
  await settle();
  assert.equal(runSlotStats().backgroundActive, 1, "precondition — it holds the lane while waiting for the pool");

  controller.abort();
  await assert.rejects(parked, { name: "AbortError" });
  assert.equal(runSlotStats().backgroundActive, 0, "the lane slot must not be stranded");

  live();
});

test("an unknown origin is treated as background, never as a reserved live turn", async () => {
  // Fail closed: runMessage already refuses an unknown origin, and the lane must not be the place
  // where a future origin quietly inherits the users' reserve.
  withCaps(2, 1);

  const first = await acquireRunSlot({ origin: "" });
  let queued = false;
  const second = acquireRunSlot({ origin: "", onWait: () => { queued = true; } });
  await settle();
  assert.equal(queued, true, "an unnamed origin queues in the background lane");

  first();
  (await second)();
});
