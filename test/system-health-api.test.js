import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
delete process.env.CG_API_KEY;
process.env.CG_BIND_HOST = "127.0.0.1";
const { saveSettings } = await import("../src/config/settings.js");
const { createWebApp } = await import("../src/web/app.js");
const { stopSystemHealth } = await import("../src/gateway/system-health.js");
const app = createWebApp({ slack: { snapshot: () => ({ connected: false }), getClient: () => null } });
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await stopSystemHealth(); server.close(); });
const paths = ["current", "history?range=24h", "storage", "hardware"];

test("system metrics refuse passwordless, unauthenticated and run-key callers", async () => {
  saveSettings({ adminPassword: "", apiKey: "health-test-run-key" });
  for (const path of paths) {
    assert.equal((await fetch(`${base}/api/system-health/${path}`)).status, 403);
  }
  saveSettings({ adminPassword: "health-test-password" });
  for (const path of paths) {
    for (const headers of [{}, { "x-api-key": "health-test-run-key" }]) {
      const response = await fetch(`${base}/api/system-health/${path}`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
  }
  assert.equal((await fetch(`${base}/api/system-health/hardware/refresh`, { method: "POST" })).status, 401);
});

test("admin metrics return honest empty history and preserve CSRF and Origin guards", async () => {
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "health-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const headers = { cookie };
  const current = await fetch(`${base}/api/system-health/current`, { headers });
  assert.equal(current.status, 200);
  const state = await current.json();
  assert.equal(state.sample, null, "the router must not invent or start collecting samples");
  assert.equal(state.collection.sampleIntervalMs, 5000);
  const history = await fetch(`${base}/api/system-health/history?range=30d`, { headers });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).points, []);
  const storage = await fetch(`${base}/api/system-health/storage`, { headers });
  assert.equal(storage.status, 200);
  const disk = await storage.json();
  assert.deepEqual(disk.points, []);
  assert.equal(disk.forecast.status, "insufficient_history");
  assert.equal((await fetch(`${base}/api/system-health/history?range=forever`, { headers })).status, 400);
  const refresh = `${base}/api/system-health/hardware/refresh`;
  assert.equal((await fetch(refresh, { method: "POST", headers })).status, 403);
  assert.equal((await fetch(refresh, { method: "POST", headers: { ...headers, "x-cg-request": "1", Origin: "https://untrusted.invalid" } })).status, 403);
  const refreshed = await fetch(refresh, { method: "POST", headers: { ...headers, "x-cg-request": "1" } });
  assert.equal(refreshed.status, 200);
  const hardware = await refreshed.json();
  assert.ok(hardware.snapshot);
  assert.ok(Number.isFinite(hardware.collectedAt));
  assert.doesNotMatch(JSON.stringify(hardware), /serialNumber|machineId|product_uuid|macAddress/);
  const liveness = await (await fetch(`${base}/api/health`)).json();
  assert.equal(liveness.hardware, undefined);
  assert.equal(liveness.systemHealth, undefined);
});
