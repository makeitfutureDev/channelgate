import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("channel login offers a separate harness, preserves switching, and copies the ChatGPT code", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  const id = "C_CODEX_BROWSER";
  const entry = await upsertChannelEntry(id, { name: "codex-browser", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: id, name: entry.name, type: "channel", isDM: false }));
  const app = express();
  app.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected" }) } }));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get(`/conversations/channel/${id}`, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1150, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const calls = [];
  let pending = false;
  let authenticated = false;
  await page.route(`**/api/channels/${id}/codex-login`, async (route) => {
    calls.push(route.request().method());
    if (route.request().method() === "POST") {
      if (route.request().postDataJSON().method === "api-key") { authenticated = true; pending = false; }
      else pending = true;
    }
    if (route.request().method() === "DELETE") pending = false;
    await route.fulfill({ status: pending && route.request().method() === "POST" ? 202 : 200, contentType: "application/json", body: JSON.stringify({ authenticated, phase: authenticated ? "complete" : pending ? "pending" : "idle", code: pending ? "ABCD-EFGH5" : "", url: pending ? "https://auth.openai.com/codex/device" : "" }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${id}`);
  await page.locator('[data-pane="runtime"].subtab').click();
  assert.equal(await page.locator(".ch-auth-gateway-panel").count(), 0);
  assert.equal(await page.locator(".ch-auth-channel-panel").isVisible(), false);
  assert.equal(await page.locator(".ch-engine-field").isVisible(), true);
  await page.locator(".ch-codex-auth-source").selectOption("channel");
  assert.equal(await page.locator(".ch-engine-field").isVisible(), true);
  assert.ok(await page.locator('.ch-engine option[value="codex-channel"]').count());
  assert.equal(await page.locator('#set-engine option[value="codex-channel"]').count(), 0);
  assert.equal(await page.locator(".ch-auth-channel-panel .ch-codex-api-section").isVisible(), false);
  await page.locator(".ch-auth-channel-panel .ch-codex-login-method").selectOption("device");
  await page.locator(".ch-auth-channel-panel .ch-codex-device-value").filter({ hasText: "ABCD-EFGH5" }).waitFor();
  assert.ok(calls.includes("POST"));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator(".ch-auth-channel-panel .ch-codex-device-value").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "ABCD-EFGH5");
  await page.locator(".ch-auth-channel-panel .ch-codex-login-method").selectOption("api-key");
  assert.equal(await page.locator(".ch-auth-channel-panel .ch-codex-api-section").isVisible(), true);
  assert.equal(await page.locator(".ch-auth-channel-panel .ch-codex-device-section").isVisible(), false);
  await page.locator(".ch-auth-channel-panel .ch-codex-api-key").fill("sk-BROWSER-ACCOUNT-FIXTURE-12345");
  await page.locator(".ch-auth-channel-panel .ch-codex-key-save").click();
  await page.locator('.ch-engine option[value="codex-channel"]:checked').waitFor({ state: "attached" });
  assert.equal(await page.locator(".ch-engine-field").isVisible(), true);
  await page.locator(".ch-engine").selectOption("codex");
  assert.equal(await page.locator(".ch-engine").inputValue(), "codex");
  await page.locator(".ch-engine").selectOption("claude");
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/channels/${id}/meta`) && response.request().method() === "PUT");
  await page.locator(".save-channel").click();
  assert.equal((await saved).status(), 200);
  assert.equal((await getChannelMeta(entry.slug)).engine, "claude");
  assert.equal((await getChannelMeta(entry.slug)).codexAuthSource, "channel");
  assert.deepEqual(errors, []);
});
