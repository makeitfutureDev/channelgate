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
