import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { authMiddleware, noPasswordLockdown, handleLogin, invalidateAllSessions } = await import("../src/web/auth.js");
const { saveSettings } = await import("../src/config/settings.js");
const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
saveSettings({ adminPassword: "vpn-web-test-password", apiKey: "vpn-web-run-api-key" });
const calls = [];
const statuses = new Map();
const off = { configured: true, enabled: false, running: false, state: "off", message: "VPN is off.", missingSecrets: [], busy: false, allowNetwork: true };
let controlFailure = false;
let revokeOnControl = false;
const app = express();
app.use(express.json());
app.post("/api/login", handleLogin);
app.use(noPasswordLockdown, authMiddleware);
app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
app.get("/api/channels/:channelId/members", (_req, res) => res.json({ members: [] }));
app.use("/api", createChannelsRouter({
  getVpnStatus: async (channelId) => {
    calls.push({ read: channelId });
    if (channelId === "UNKNOWN") throw Object.assign(new Error("Unknown channel."), { statusCode: 404 });
    return statuses.get(channelId) || off;
  },
  setVpnEnabled: async (channelId, enabled, options) => {
    calls.push({ channelId, enabled, actor: options.actor, source: options.source });
    if (revokeOnControl) invalidateAllSessions();
    if (!await options.authorize()) throw Object.assign(new Error("Admin session expired."), { statusCode: 403 });
    if (controlFailure) throw Object.assign(new Error("VPN server certificate verification failed."), { statusCode: 409 });
    const result = { ...off, enabled, state: enabled ? "starting" : "off", message: enabled ? "Connecting…" : "VPN is off." };
    statuses.set(channelId, result);
    return result;
  },
}));
app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } }));
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
app.use(express.static(publicDir, { dotfiles: "allow" }));
app.get("/conversations/channel/:channelId", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });
async function login() {
  const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "vpn-web-test-password" }) });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}
const request = (cookie, body, channelId = "C_VPN_WEB") => fetch(`${base}/api/channels/${channelId}/vpn`, {
  method: body === undefined ? "GET" : "PUT",
  headers: { cookie, "content-type": "application/json", "x-cg-request": "1" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("VPN API requires an admin session; run API tokens and missing CSRF header grant no control", async () => {
  calls.length = 0;
  for (const method of ["GET", "PUT"]) {
    const response = await fetch(`${base}/api/channels/C_VPN_WEB/vpn`, { method, headers: { authorization: "Bearer vpn-web-run-api-key", "content-type": "application/json" }, ...(method === "PUT" ? { body: '{"enabled":true}' } : {}) });
    assert.equal(response.status, 401);
  }
  const cookie = await login();
  const response = await fetch(`${base}/api/channels/C_VPN_WEB/vpn`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: '{"enabled":true}' });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test("VPN API accepts only a boolean switch and never forwards injected service configuration", async () => {
  const cookie = await login();
  calls.length = 0;
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: true, profile: "/tmp/evil.ovpn" }, { enabled: true, command: "reboot" }, { enabled: true, channelId: "OTHER" }]) {
    assert.equal((await request(cookie, body)).status, 400);
  }
  assert.deepEqual(calls, []);
  const response = await request(cookie, { enabled: true }, "C_EXACT_TARGET");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "starting", "accepted start does not claim a connected tunnel");
  assert.deepEqual(calls, [{ channelId: "C_EXACT_TARGET", enabled: true, actor: "admin-ui", source: "admin_ui" }]);
  assert.equal((await request(cookie, { enabled: false }, "C_EXACT_TARGET")).status, 200);
});

test("VPN API reports safe control and unknown-channel failures", async () => {
  const cookie = await login();
  assert.equal((await request(cookie, undefined, "UNKNOWN")).status, 404);
  controlFailure = true;
  try {
    const response = await request(cookie, { enabled: true });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "VPN server certificate verification failed." });
  } finally { controlFailure = false; }
});

test("queued VPN control rechecks the live admin session", async () => {
  const cookie = await login();
  revokeOnControl = true;
  try { assert.equal((await request(cookie, { enabled: true })).status, 403); }
  finally { revokeOnControl = false; }
});

test("browser VPN switch applies immediately, polls connection state, and shows setup/error states", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  for (const id of ["C_VPN_BROWSER", "C_VPN_SETUP"]) {
    const entry = await upsertChannelEntry(id, { name: id.toLowerCase(), type: "channel", isDM: false, platform: "slack" });
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name: id.toLowerCase(), type: "channel", isDM: false }), allowNetwork: true });
  }
  statuses.set("C_VPN_SETUP", { ...off, configured: false, state: "unconfigured", message: "VPN is not configured. An administrator must import the profile and prepare the service first." });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.request.post(`${base}/api/login`, { data: { password: "vpn-web-test-password" } });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(globalThis, "EventSource", { value: undefined }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !(controlFailure && message.text().includes("409"))) errors.push(message.text());
  });
  calls.length = 0;
  await page.goto(`${base}/conversations/channel/C_VPN_BROWSER`);
  const toggle = page.locator("#channel-detail .ch-vpn-enabled");
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-enabled")?.disabled === false);
  assert.deepEqual(calls.filter((c) => c.read).map((c) => c.read), ["C_VPN_BROWSER"], "only selected channel is probed");
  await page.locator("#channel-detail .ch-vpn-controls .togglerow").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.includes("Starting"));
  assert.equal(await page.locator("#channel-detail .detail-savebar").isHidden(), true);
  assert.equal(await toggle.isDisabled(), false, "stop stays accessible while the VPN negotiates its connection");
  statuses.set("C_VPN_BROWSER", { ...off, enabled: true, state: "on", message: "Tunnel is connected." });
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.includes("Connected"));
  await page.locator("#channel-detail .ch-vpn-controls .togglerow").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.startsWith("Off"));
  controlFailure = true;
  try {
    await page.locator("#channel-detail .ch-vpn-controls .togglerow").click();
    await page.locator("#channel-detail .ch-vpn-error").waitFor();
    assert.match(await page.locator("#channel-detail .ch-vpn-error").textContent(), /certificate verification failed/);
    assert.equal(await toggle.isChecked(), false);
  } finally { controlFailure = false; }
  statuses.set("C_VPN_BROWSER", { ...off, missingSecrets: ["VPN_PASSWORD"] });
  await page.locator("#channel-detail .ch-vpn-refresh").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.includes("VPN_PASSWORD"));
  assert.equal(await toggle.isDisabled(), true);
  statuses.set("C_VPN_BROWSER", { ...off, enabled: true, state: "on", allowNetwork: false, missingSecrets: ["VPN_PASSWORD"] });
  await page.locator("#channel-detail .ch-vpn-refresh").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-enabled")?.disabled === false);
  assert.equal(await toggle.isChecked(), true, "network off or missing credentials must never prevent stopping a running VPN");
  await page.locator("#channel-detail .ch-vpn-controls .togglerow").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.startsWith("Off"));
  statuses.set("C_VPN_BROWSER", { ...off, enabled: false, running: true, state: "failed", allowNetwork: false, missingSecrets: ["VPN_PASSWORD"], message: "VPN service needs attention." });
  await page.locator("#channel-detail .ch-vpn-refresh").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.startsWith("Failed"));
  assert.equal(await toggle.isChecked(), true, "manually started containers remain stoppable even when systemd is disabled");
  assert.equal(await toggle.isDisabled(), false);
  await page.locator("#channel-detail .ch-vpn-controls .togglerow").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.startsWith("Off"));
  assert.equal(calls.filter((call) => Object.hasOwn(call, "enabled")).at(-1).enabled, false);
  await page.goto(`${base}/conversations/channel/C_VPN_SETUP`);
  await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .ch-vpn-state")?.textContent.includes("Not configured"));
  assert.equal(await page.locator("#channel-detail .ch-vpn-enabled").isDisabled(), true);
  const setupText = await page.locator("#channel-detail .ch-vpn-state").textContent();
  assert.match(setupText, /administrator must import/);
  // QA-0925: the server's own "VPN is not configured. …" used to be appended to the hint below,
  // saying the same thing twice.
  assert.equal(setupText.includes("VPN is not configured"), false, "an unconfigured VPN is explained once");
  assert.deepEqual(errors, []);
});
