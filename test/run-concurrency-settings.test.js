import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getRunConcurrency, getContainerRuntime, saveSettings } = await import("../src/config/settings.js");
const { acquireRunSlot, resetRunSlots, runSlotStats } = await import("../src/gateway/run.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections(); server.close(); });
test.afterEach(() => {
  saveSettings({ maxConcurrentRuns: null, reservedInteractiveRuns: null });
  delete process.env.MAX_CONCURRENT_RUNS;
  delete process.env.RESERVED_INTERACTIVE_RUNS;
  resetRunSlots();
});
async function put(body, expected = 200) {
  const r = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, connectSlack: false }) });
  const data = await r.json();
  assert.equal(r.status, expected, JSON.stringify(data));
  return data;
}

test("settings API reports effective legacy limits, saves numeric zero and wins over env", async () => {
  process.env.MAX_CONCURRENT_RUNS = "16";
  process.env.RESERVED_INTERACTIVE_RUNS = "3";
  let payload = await (await fetch(`${base}/settings`)).json();
  assert.equal(payload.maxConcurrentRuns, 16);
  assert.equal(payload.reservedInteractiveRuns, 3);
  await put({ maxConcurrentRuns: 32, reservedInteractiveRuns: 0 });
  assert.deepEqual(getRunConcurrency(), { maxConcurrentRuns: 32, reservedInteractiveRuns: 0 });
  payload = await (await fetch(`${base}/settings`)).json();
  assert.equal(payload.maxConcurrentRuns, 32);
  assert.equal(payload.reservedInteractiveRuns, 0);
});

test("invalid or stale saves do not mutate limits, unrelated settings or existing queues", async () => {
  await put({ maxConcurrentRuns: 1, reservedInteractiveRuns: 0 });
  const held = await acquireRunSlot({ origin: "slack_foreground" });
  let admitted = false;
  const queued = acquireRunSlot({ origin: "slack_foreground" }).then((release) => { admitted = true; return release; });
  for (const value of [0, 501, 1.5, null, false, "32", ""]) await put({ maxConcurrentRuns: value, reservedInteractiveRuns: 0, containerMaxRunning: 22 }, 400);
  for (const value of [-1, 500, 0.5, null, false, "0", ""]) await put({ reservedInteractiveRuns: value }, 400);
  await put({ reservedInteractiveRuns: 1 }, 400);
  await put({ maxConcurrentRuns: 2, reservedInteractiveRuns: 2 }, 400);
  const version = (await (await fetch(`${base}/settings`)).json()).settingsVersion;
  await put({ showMessageCost: false });
  await put({ settingsVersion: version, maxConcurrentRuns: 3 }, 409);
  assert.deepEqual(getRunConcurrency(), { maxConcurrentRuns: 1, reservedInteractiveRuns: 0 });
  assert.equal(getContainerRuntime().maxRunning, 8, "rejected saves do not persist unrelated fields");
  assert.equal(admitted, false);
  assert.equal(runSlotStats().active, 1);
  held(); (await queued)();
});

test("a successful settings save wakes queued runs without another incoming request", async () => {
  await put({ maxConcurrentRuns: 1, reservedInteractiveRuns: 0 });
  const held = await acquireRunSlot({ origin: "slack_foreground" });
  const queued = acquireRunSlot({ origin: "slack_foreground" });
  await put({ maxConcurrentRuns: 2 });
  const second = await queued;
  assert.equal(runSlotStats().active, 2);
  await put({ maxConcurrentRuns: 1 });
  assert.equal(runSlotStats().active, 2);
  assert.deepEqual(getRunConcurrency(), { maxConcurrentRuns: 1, reservedInteractiveRuns: 0 });
  held(); second();
});

test("lowering only the total leaves a background slot and reports the effective reservation", async () => {
  await put({ maxConcurrentRuns: 4, reservedInteractiveRuns: 2 });
  await put({ maxConcurrentRuns: 1 });
  assert.deepEqual(getRunConcurrency(), { maxConcurrentRuns: 1, reservedInteractiveRuns: 0 });
  const release = await acquireRunSlot({ origin: "background_agent" });
  release();
  await put({ maxConcurrentRuns: 4 });
  assert.deepEqual(getRunConcurrency(), { maxConcurrentRuns: 4, reservedInteractiveRuns: 0 }, "raising the total must not resurrect a hidden reservation");
});
