// Disposable real API + browser state. Set CG_BROWSER_MODULE to the installed Playwright module.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ADMIN_CONVERSATION_PATH_RE } from "../public/admin-routes.js";
import { openSetting } from "./settings-navigation-helper.js";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("conversation templates and Settings can each save while the other has a draft", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const settings = await import("../src/config/settings.js");
  const app = express();
  app.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get(["/settings", ADMIN_CONVERSATION_PATH_RE], (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/settings`);
  const nav = (view) => page.locator(`.nav-item[data-view="${view}"]`).click();
  const field = page.locator("#set-max-concurrent-runs");
  const card = page.locator(".conversation-template");
  const lean = card.locator(".cfg-clean");
  const chooseTemplate = () => page.locator('[data-seg="templates"]').click();
  const saveTemplate = async () => {
    await card.locator(".save-changes").click();
    await page.waitForFunction(() => globalThis.document.querySelector(".conversation-template .detail-savebar .msg")?.textContent === "Saved");
  };
  const saveSettings = async () => {
    await page.locator("#save-settings").click();
    await page.waitForFunction(() => globalThis.document.getElementById("settings-dirty-msg").textContent === "All changes saved");
  };
  await page.waitForFunction(() => globalThis.document.getElementById("set-max-concurrent-runs").value === "8");
  await openSetting(page, field);
  await field.fill("9");
  await nav("channels");
  await chooseTemplate();
  await lean.waitFor({ state: "attached" });
  assert.equal(new URL(page.url()).pathname, "/conversations/template/channel");
  assert.equal(await page.locator("#conv-source").isVisible(), false);
  await page.locator('a[href="/conversations/template/user"]').click();
  await lean.waitFor({ state: "attached" });
  const userLean = await lean.isChecked();
  await lean.locator("..").click();
  await saveTemplate();
  assert.equal(settings.getDmTemplates().user.cleanMode, !userLean);
  await nav("settings");
  assert.equal(await field.inputValue(), "9");
  await saveSettings();
  assert.equal(settings.getSettings().maxConcurrentRuns, 9);
  assert.equal(settings.getDmTemplates().user.cleanMode, !userLean);

  // Returning from Settings restores the dirty template. Its save retries the unrelated new version.
  await nav("channels");
  await chooseTemplate();
  await lean.waitFor({ state: "attached" });
  const channelLean = await lean.isChecked();
  await lean.locator("..").click();
  await nav("settings");
  await openSetting(page, field);
  await field.fill("10");
  await saveSettings();
  await nav("channels");
  assert.equal(new URL(page.url()).pathname, "/conversations/template/channel");
  assert.equal(await lean.isChecked(), !channelLean);
  await saveTemplate();
  assert.equal(settings.getChannelTemplate().cleanMode, !channelLean);
  assert.equal(settings.getSettings().maxConcurrentRuns, 10);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL("/conversations/template/admin", page.url()).href);
  await lean.waitFor({ state: "attached" });
  assert.equal(await card.locator("h2").innerText(), "Admin DM template");
  assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
  assert.deepEqual(errors, []);
});
