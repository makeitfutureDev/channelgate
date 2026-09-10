import test from "node:test";
import assert from "node:assert/strict";
import { createHealthPoller, forecastCopy, healthBytes, healthChart, storageSeverity } from "../public/admin-system-health.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(request) {
  const calls = [], updates = [], timers = new Map();
  let timerId = 0, isVisible = true;
  const controller = createHealthPoller({
    request: (url, options) => { calls.push({ url, options }); return request?.(url, options) ?? Promise.resolve({ url }); },
    onUpdate: (state) => updates.push(structuredClone(state)),
    visible: () => isVisible,
    schedule: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    unschedule: (id) => timers.delete(id),
  });
  return { controller, calls, updates, timers, setVisible(value) { isVisible = value; controller.visibilityChanged(); }, tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); } };
}

test("health polling stops off-page/hidden/paused, and manual refresh scans hardware while paused", async () => {
  const h = harness();
  h.controller.enter(); await settle();
  assert.equal(h.calls.length, 4);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.ms), [5000]);
  h.tick(); await settle();
  assert.equal(h.calls.length, 5);
  h.controller.togglePause();
  assert.equal(h.timers.size, 0);
  h.controller.refresh(); await settle();
  assert.equal(h.calls.length, 9);
  assert.equal(h.calls.at(-1).url, "/api/system-health/hardware/refresh");
  assert.equal(h.calls.at(-1).options.method, "POST");
  assert.equal(h.timers.size, 0);
  h.controller.togglePause(); await settle();
  h.setVisible(false); assert.equal(h.timers.size, 0);
  const count = h.calls.length;
  h.setVisible(true); await settle(); assert.equal(h.calls.length, count + 4);
  h.controller.leave(); assert.equal(h.timers.size, 0);
  h.setVisible(false); h.setVisible(true); await settle();
  assert.equal(h.calls.length, count + 4);
});

test("range change never overlaps requests or accepts an outdated response", async () => {
  const releases = [];
  const h = harness((url) => new Promise((resolve) => releases.push(() => resolve({ url, marker: "old" }))));
  h.controller.enter(); await settle();
  assert.equal(h.calls.length, 4);
  h.controller.setRange("24h"); await settle();
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every((call) => call.options.signal.aborted));
  releases.splice(0).forEach((release) => release()); await settle();
  assert.equal(h.calls.length, 8);
  assert.match(h.calls[5].url, /range=24h/);
  assert.equal(h.updates.at(-1).current, null);
  assert.equal(h.updates.at(-1).history, null);
  releases.splice(0).forEach((release) => release()); await settle();
  assert.match(h.updates.at(-1).history.url, /range=24h/);
  h.controller.leave();
});

test("pausing an in-flight request discards late results and restores refresh", async () => {
  const releases = [];
  const h = harness(() => new Promise((resolve) => releases.push(() => resolve({ sample: "late" }))));
  h.controller.enter(); await settle();
  h.controller.togglePause();
  releases.forEach((release) => release()); await settle();
  assert.equal(h.updates.at(-1).current, null);
  assert.equal(h.updates.at(-1).loading, false);
  assert.equal(h.updates.at(-1).paused, true);
  assert.equal(h.timers.size, 0);
  h.controller.leave();
});

test("one failed section does not hide successful data and is retried", async () => {
  let failing = true;
  const h = harness((url) => failing && url.endsWith("/storage") ? Promise.reject(new Error("storage unavailable")) : Promise.resolve({ url }));
  h.controller.enter(); await settle();
  assert.equal(h.updates.at(-1).errors.storage, "storage unavailable");
  assert.ok(h.updates.at(-1).current);
  failing = false;
  h.tick(); await settle();
  assert.equal(h.updates.at(-1).errors.storage, undefined);
  assert.ok(h.updates.at(-1).storage);
  h.controller.leave();
});

test("hourly minute observations connect, missing values break lines, tooltip input is escaped", () => {
  const start = Date.UTC(2026, 0, 1), end = start + 3_600_000;
  const html = healthChart([
    { timestamp: start, cpuPercent: 10, memoryPercent: 30 },
    { timestamp: start + 60_000, cpuPercent: 20, memoryPercent: 31 },
    { timestamp: start + 120_000, cpuPercent: null, memoryPercent: 32 },
    { timestamp: start + 180_000, cpuPercent: 15, memoryPercent: 33 },
  ], { start, end });
  const cpu = html.match(/class="sh-line sh-cpu" d="([^"]+)"/)[1];
  assert.equal((cpu.match(/M/g) || []).length, 2);
  assert.equal((cpu.match(/L/g) || []).length, 1);
  assert.match(html, /CPU 10\.0%/);
  assert.doesNotMatch(healthChart([{ timestamp: start, cpuPercent: '<script>alert(1)</script>' }]), /<script>/);
  assert.match(healthChart([]), /No observations/);
});

test("storage thresholds and forecast distinguish missing evidence from zero", () => {
  assert.equal(storageSeverity(null), "unknown");
  assert.equal(storageSeverity(84.99), "normal");
  assert.equal(storageSeverity(85), "warning");
  assert.equal(storageSeverity(95), "critical");
  assert.equal(healthBytes(null), "—");
  assert.equal(healthBytes(0), "0.0 B");
  assert.match(forecastCopy({ status: "insufficient_history", observedDays: 1 }).detail, /Not enough/);
  assert.match(forecastCopy({ status: "growing", daysToFull: 10, bytesPerDay: 1024 ** 3, observedDays: 8 }).title, /10 days/);
  assert.match(forecastCopy({ status: "stable", observedDays: 8 }).title, /No projected/);
});
