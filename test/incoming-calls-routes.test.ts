import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");
const { createIncomingCalls } = await import("../src/gateway/voice/incoming.ts");
const { getDb } = await import("../src/db/index.js");
const { setUser } = await import("../src/config/store.js");
test("Activity incoming routes require the owning session, same origin and CSRF; accept uses the recorded thread", async () => {
  await setUser("U_MINE", { approved: true }); await setUser("U_OTHER", { approved: true });
  getDb().exec("DELETE FROM user_devices; DELETE FROM incoming_calls;");
  let base = "", pushed = "";
  const incoming = createIncomingCalls({ config: () => ({ enabled: true, teamId: "ABCDE12345", keyId: "FGHIJ67890", bundleId: "com.example.calls", privateKey: "fixture" }),
    voiceEnabled: () => true, authorize: async () => true,
    send: async (_c, _d, payload) => { pushed = String(payload.token); return { status: 200, reason: "" }; }, notify: async () => {} });
  const started: unknown[] = [];
  const client = { chat: { postMessage: async () => ({ ts: "1.1" }) } };
  const app = express();
  const calls = { start: async (value: unknown) => { started.push(value); return { id: "ACCEPTED", bound: null }; } };
  const routerOptions = { getClient: () => client, getTeamId: () => "T_TEST", getBaseUrl: () => base,
    incoming, calls, voiceAvailable: () => true, snapshot: async () => ({ rows: [], total: 0, search: "", pageSize: 100, page: 1, pages: 1, unavailable: false, truncated: false, filter: "all" }), readSubscriptions: async () => ({ subscriptions: [], refreshAfterSeconds: 60 }) };
  app.use("/activity", createActivityRouter(routerOptions));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: "manual" });
  async function login(ownerId: string) {
    const url = createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "T_TEST" });
    const exchange = await request("/activity/exchange", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    assert.equal(exchange.status, 200);
    const { url: sessionBase } = await exchange.json() as {url:string};
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
    const html = await (await request(sessionBase, { headers: { cookie } })).text();
    const csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(html)?.[1]; assert.ok(csrf);
    return { sessionBase, headers: { cookie, Origin: base, "X-CG-CSRF": csrf, "Content-Type": "application/json" } };
  }
  try {
    const mine = await login("U_MINE"), other = await login("U_OTHER");
    const path = mine.sessionBase + "/api/devices";
    const device = { platform: "ios", kind: "voip", token: "ab".repeat(32), bundleId: "com.example.calls", environment: "sandbox", name: "Phone" };
    assert.equal((await request(path, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(device) })).status, 401);
    assert.equal((await request(path, { method: "POST", headers: { ...mine.headers, "X-CG-CSRF": "wrong" }, body: JSON.stringify(device) })).status, 403);
    assert.equal((await request(path, { method: "POST", headers: { ...mine.headers, Origin: "https://other.example" }, body: JSON.stringify(device) })).status, 403);
    assert.equal((await request(path, { method: "POST", headers: mine.headers, body: JSON.stringify(device) })).status, 200);
    const listing = await (await request(path, { headers: mine.headers })).json() as {devices:{id:string}[]};
    assert.equal(listing.devices.length, 1); assert.doesNotMatch(JSON.stringify(listing), new RegExp(device.token));
    assert.deepEqual(await (await request(other.sessionBase + "/api/devices", { headers: other.headers })).json(), { devices: [] });
    const target = { ownerId: "U_MINE", channelId: "C_TEST", threadTs: "1700000000.000001" };
    await incoming.request(target, "Review");
    const body = JSON.stringify({ token: pushed, channelId: "C_FORGED", threadTs: "1.1" });
    assert.equal((await request(other.sessionBase + "/call/accept", { method: "POST", headers: other.headers, body })).status, 404);
    assert.equal((await request(mine.sessionBase + "/call/accept", { method: "POST", headers: mine.headers, body })).status, 200);
    assert.equal(started.length, 1);
    assert.equal((started[0] as {channelId:string}).channelId, "C_TEST");
    assert.equal((await request(mine.sessionBase + "/call/accept", { method: "POST", headers: mine.headers, body })).status, 404);
    assert.equal((await request(other.sessionBase + "/api/devices/" + listing.devices[0].id, { method: "DELETE", headers: other.headers })).status, 200);
    assert.equal(incoming.listDevices("U_MINE").length, 1);
    await request(path + "/" + listing.devices[0].id, { method: "DELETE", headers: mine.headers });
    assert.equal(incoming.listDevices("U_MINE").length, 0);
  } finally { resetActivityStateForTests(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
