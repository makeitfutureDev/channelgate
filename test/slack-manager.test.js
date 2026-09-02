// H10: the Slack lifecycle manager serializes connect/disconnect transitions and generation-guards
// in-flight connects. Two racing connects must end with exactly ONE live Socket Mode app (the
// later one) — never a loser left running untracked, processing every event twice or staying live
// on rotated credentials after a "Disconnect".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackManager } from "../src/slack/manager.js";

// Let every queued transition that can run, run. The chain hops microtasks; setImmediate drains
// all of them, so after a tick the manager has done everything it can without more input.
const tick = () => new Promise((r) => setImmediate(r));

function makeApp(name) {
  return {
    name,
    stopped: 0,
    client: { name },
    async stop() {
      this.stopped += 1;
    },
  };
}

// A controllable startSlack: each call parks until the test resolves it with a connection.
function makeStart() {
  const calls = [];
  const start = (config) =>
    new Promise((resolve, reject) => {
      calls.push({ config, resolve, reject });
    });
  return { start, calls };
}

function connection(app, botUserId = "UBOT") {
  return { app, botUserId, user: "gateway", team: "Team", teamId: "T1" };
}

test("two racing connects → only the latest ever starts an app", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const first = mgr.connect({ n: 1 });
  const second = mgr.connect({ n: 2 });
  await tick();

  // The first connect was superseded before it was scheduled, so it never spawned an app that
  // would have had to be torn down again.
  assert.equal(calls.length, 1, "the superseded connect never called startSlack");
  assert.deepEqual(calls[0].config, { n: 2 });

  const appB = makeApp("B");
  calls[0].resolve(connection(appB));
  await first;
  const snap = await second;

  assert.equal(snap.connected, true);
  assert.equal(appB.stopped, 0, "the winning app is live");
  assert.equal(mgr.getClient(), appB.client);
});

test("a connect superseded mid-start stops the app IT started", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const first = mgr.connect({ n: 1 });
  await tick();
  assert.equal(calls.length, 1, "the first connect is in flight");

  // Rotated credentials: a second connect is requested while startSlack is still running.
  const second = mgr.connect({ n: 2 });
  const appA = makeApp("A");
  calls[0].resolve(connection(appA)); // arrives too late to be published
  await first;
  await tick();

  assert.equal(appA.stopped, 1, "the superseded connect stopped its own app — no orphan");
  assert.equal(mgr.getClient(), null, "the stale app was never published as current");

  const appB = makeApp("B");
  assert.equal(calls.length, 2);
  calls[1].resolve(connection(appB));
  const snap = await second;

  assert.equal(snap.connected, true);
  assert.equal(appA.stopped, 1);
  assert.equal(appB.stopped, 0);
  assert.equal(mgr.getClient(), appB.client);
});

test("disconnect racing an in-flight connect leaves nothing running", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const connecting = mgr.connect({ n: 1 });
  await tick();
  const disconnecting = mgr.disconnect(); // supersedes the in-flight connect

  const appA = makeApp("A");
  calls[0].resolve(connection(appA));
  await connecting;
  await disconnecting;

  assert.equal(appA.stopped, 1, "the app that finished starting was stopped, not left live");
  assert.equal(mgr.snapshot().status, "disconnected");
  assert.equal(mgr.snapshot().error, null);
  assert.equal(mgr.getClient(), null);
});

test("connect tears down the previous connection before starting a new one", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const first = mgr.connect({ n: 1 });
  await tick();
  const appA = makeApp("A");
  calls[0].resolve(connection(appA));
  await first;
  assert.equal(mgr.getClient(), appA.client);

  const second = mgr.connect({ n: 2 });
  await tick();
  assert.equal(appA.stopped, 1, "old app stopped before the replacement started");
  assert.equal(calls.length, 2);

  const appB = makeApp("B");
  calls[1].resolve(connection(appB));
  const snap = await second;
  assert.equal(snap.connected, true);
  assert.equal(mgr.getClient(), appB.client);
});

test("a failed connect reports the error and never wedges later transitions", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const failing = mgr.connect({ n: 1 });
  await tick();
  calls[0].reject(new Error("bad token"));
  const snapErr = await failing;
  assert.equal(snapErr.status, "error");
  assert.equal(snapErr.error, "bad token");
  assert.equal(mgr.getClient(), null);

  const retry = mgr.connect({ n: 2 });
  await tick();
  const appB = makeApp("B");
  calls[1].resolve(connection(appB));
  const snapOk = await retry;
  assert.equal(snapOk.connected, true);
  assert.equal(snapOk.error, null, "the previous failure was cleared");
  assert.equal(mgr.getClient(), appB.client);
});

test("an app whose stop() throws still gets replaced", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  const first = mgr.connect({ n: 1 });
  await tick();
  const appA = { ...makeApp("A"), stop: async () => { throw new Error("already stopped"); } };
  calls[0].resolve(connection(appA));
  await first;

  const second = mgr.connect({ n: 2 });
  await tick();
  const appB = makeApp("B");
  calls[1].resolve(connection(appB));
  const snap = await second;

  assert.equal(snap.connected, true);
  assert.equal(mgr.getClient(), appB.client);
});

test("a fresh manager reports disconnected and disconnect() is a clean no-op", async () => {
  const { start, calls } = makeStart();
  const mgr = createSlackManager({ start });

  assert.deepEqual(mgr.snapshot(), {
    status: "disconnected",
    connected: false,
    user: null,
    team: null,
    teamId: null,
    botUserId: null,
    error: null,
  });
  await mgr.disconnect();
  assert.equal(calls.length, 0);
  assert.equal(mgr.getClient(), null);
});
