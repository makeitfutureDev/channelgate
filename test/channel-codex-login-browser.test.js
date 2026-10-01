import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("channel ChatGPT sign-in starts from the visible button and shows its device code", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta } = await import("../src/config/store.js");
  const id = "C_CODEX_BROWSER";
  const entry = await upsertChannelEntry(id, { name: "codex-browser", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: id, name: entry.name, type: "channel", isDM: false }));
  const app = express();
  app.use(express.json());
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
  await page.route(`**/api/channels/${id}/codex-login`, async (route) => {
    calls.push(route.request().method());
    const pending = calls.includes("POST");
    await route.fulfill({ status: pending && route.request().method() === "POST" ? 202 : 200, contentType: "application/json", body: JSON.stringify({ authenticated: false, phase: pending ? "pending" : "idle", code: pending ? "ABCD-EFGH5" : "", url: pending ? "https://auth.openai.com/codex/device" : "" }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${id}`);
  await page.locator('[data-pane="runtime"].subtab').click();
  await page.locator(".ch-codex-auth-source").selectOption("channel");
  const button = page.locator(".ch-auth-channel-panel .ch-codex-device-start");
  const keyButton = page.locator(".ch-auth-channel-panel .ch-codex-key-save");
  const [signInBox, keyBox] = await Promise.all([button.boundingBox(), keyButton.boundingBox()]);
  assert.equal(signInBox.x, keyBox.x, "both actions begin in the same column");
  assert.equal(signInBox.width, keyBox.width, "both actions have the same width");
  assert.equal(signInBox.height, keyBox.height, "sign-in text stays on one line");
  await button.click();
  await page.locator(".ch-auth-channel-panel .ch-codex-device-value").filter({ hasText: "ABCD-EFGH5" }).waitFor();
  assert.ok(calls.includes("POST"));
  assert.deepEqual(errors, []);
});
