import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { RestartCoordinator, gatewayWorkActivity, describeGatewayWork } = await import("../src/gateway/restart.js");

test("gateway work snapshot includes engine, background, API, and update activity", () => {
  const activity = gatewayWorkActivity({
    getRuntime: () => ({ total: 2 }),
    getBackground: () => ({ count: () => 1 }),
    getApiJobs: () => [{ status: "running" }, { status: "queued" }, { status: "completed" }],
    getUpdate: () => true,
  });
  assert.deepEqual(activity, { engine: 2, background: 1, api: 2, update: 1, total: 6 });
  assert.match(describeGatewayWork(activity), /engine signals/);
  assert.match(describeGatewayWork(activity), /background job/);
  assert.match(describeGatewayWork(activity), /API runs/);
  assert.match(describeGatewayWork(activity), /update transaction/);
});

test("safe restart rechecks busy work, restarts only when idle, and coalesces requests", async () => {
  let clock = 0;
  const snapshots = [
    { total: 1, engine: 1, background: 0, api: 0, update: 0 },
    { total: 1, engine: 0, background: 1, api: 0, update: 0 },
    { total: 0, engine: 0, background: 0, api: 0, update: 0 },
  ];
  const notifications = [];
  const restarts = [];
  const coordinator = new RestartCoordinator({
    getActivity: () => snapshots.shift() || { total: 0 },
    restart: async (input) => restarts.push(input),
    notify: async (notice) => notifications.push(notice.text),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    settleMs: 0,
    waitMs: 120,
    pollMs: 50,
  });

  const first = coordinator.request({ channelId: "C1", threadKey: "1.0", reason: "test restart" });
  const duplicate = coordinator.request({ channelId: "C1", threadKey: "1.0" });
  assert.equal(first.ok, true);
  assert.equal(duplicate.conflict, true);

  const result = await coordinator.whenSettled();
  assert.equal(result.restarted, true);
  assert.deepEqual(restarts, [{ reason: "test restart" }]);
  assert.equal(notifications.length, 2);
  assert.match(notifications[0], /waiting/i);
  assert.match(notifications[1], /finished.*restarting/i);
  assert.equal(coordinator.status(first.id).phase, "restarted");
});

test("safe restart rechecks after its final notification before shutdown", async () => {
  let checks = 0;
  const restarts = [];
  const coordinator = new RestartCoordinator({
    getActivity: () => {
      checks += 1;
      if (checks === 1) return { total: 0, engine: 0, background: 0, api: 0, update: 0 };
      if (checks === 2) return { total: 1, engine: 1, background: 0, api: 0, update: 0 };
      return { total: 0, engine: 0, background: 0, api: 0, update: 0 };
    },
    restart: async (input) => restarts.push(input),
    sleep: async () => {},
    settleMs: 0,
    waitMs: 100,
    pollMs: 10,
  });

  coordinator.request({ reason: "race-safe restart" });
  const result = await coordinator.whenSettled();
  assert.equal(result.restarted, true);
  assert.equal(checks, 4, "idle must be observed again after each pre-restart notification");
  assert.deepEqual(restarts, [{ reason: "race-safe restart" }]);
});

test("safe restart cancels after its deadline while work remains active", async () => {
  let clock = 0;
  const notifications = [];
  let restarted = false;
  const coordinator = new RestartCoordinator({
    getActivity: () => ({ total: 1, engine: 0, background: 0, api: 1, update: 0 }),
    restart: async () => { restarted = true; },
    notify: async (notice) => notifications.push(notice.text),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    settleMs: 0,
    waitMs: 100,
    pollMs: 60,
  });

  coordinator.request({ channelId: "C1", threadKey: "1.0" });
  const result = await coordinator.whenSettled();
  assert.equal(result.restarted, false);
  assert.equal(result.reason, "busy");
  assert.equal(restarted, false);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1], /cancelled/i);
  assert.match(notifications[1], /API run/i);
  assert.equal(coordinator.status().phase, "cancelled");
  assert.match(coordinator.status().message, /API run/i);
  assert.equal(coordinator.status("wrong-id").ok, false);
});

test("force restart bypasses busy engine, background, API, and updater activity", async () => {
  const restarts = [];
  const sleeps = [];
  const coordinator = new RestartCoordinator({
    getActivity: () => ({ total: 4, engine: 1, background: 1, api: 1, update: 1 }),
    restart: async (input) => restarts.push(input),
    sleep: async (ms) => sleeps.push(ms),
    settleMs: 2,
  });
  const request = coordinator.request({ force: true, reason: "explicit force" });
  assert.equal(request.force, true);
  assert.equal(request.waitMs, 0);
  assert.equal((await coordinator.whenSettled()).restarted, true);
  assert.deepEqual(sleeps, [2], "only the HTTP response settle remains; no activity polling");
  assert.deepEqual(restarts, [{ reason: "explicit force", force: true }]);
  assert.equal(coordinator.status(request.id).force, true);
});

test("force upgrades a pending safe restart promptly and aborts its poll without duplicate shutdown", async () => {
  let pollStarted;
  const polling = new Promise((resolve) => { pollStarted = resolve; });
  let signal;
  const restarts = [];
  const coordinator = new RestartCoordinator({
    getActivity: () => ({ total: 1, engine: 1 }),
    restart: async (input) => restarts.push(input),
    sleep: (_ms, _value, options) => {
      signal = options.signal;
      pollStarted();
      return new Promise(() => {}); // advancing the long poll is deliberately impossible
    },
    settleMs: 0,
    pollMs: 30_000,
  });
  const first = coordinator.request({ reason: "pending wait" });
  await polling;
  const forced = coordinator.request({ force: true });
  const duplicate = coordinator.request({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.id, first.id);
  assert.equal(forced.upgraded, true);
  assert.equal(duplicate.conflict, true);
  assert.equal((await coordinator.whenSettled()).restarted, true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(restarts, [{ reason: "pending wait", force: true }]);
});

test("force upgrade is not delayed by a pending busy notification", async () => {
  let notified;
  const noticeStarted = new Promise((resolve) => { notified = resolve; });
  let restarts = 0;
  const coordinator = new RestartCoordinator({
    getActivity: () => ({ total: 1, api: 1 }),
    restart: async ({ force }) => { assert.equal(force, true); restarts++; },
    notify: () => { notified(); return new Promise(() => {}); },
    settleMs: 0,
  });
  coordinator.request();
  await noticeStarted;
  coordinator.request({ force: true });
  await coordinator.whenSettled();
  assert.equal(restarts, 1);
});
