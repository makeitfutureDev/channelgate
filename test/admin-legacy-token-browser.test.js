// Disposable admin shell, settings and Chromium. Exercise the public pages, including a stale revoke.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("API shows only an existing organization token, masks it and revokes the displayed version", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { saveSettings, getApiKey } = await import("../src/config/settings.js");
  delete process.env.CG_API_KEY;
  const app = express();
  app.use(express.json());
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: true, user: "atlas-fixture" }, engines: {} }));
  let reveals = 0;
  app.post("/api/secrets/reveal", (_req, _res, next) => { reveals++; next(); });
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ connected: true, user: "atlas-fixture" }) } }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { dotfiles: "allow" }));
  app.get("/api-docs", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/index.html", import.meta.url)), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/api-docs`);
  const card = page.locator("#api-legacy-token");
  const field = card.locator("input");
  await page.getByText("No channel tokens yet.", { exact: false }).waitFor();
  assert.equal(await card.isVisible(), false);
  assert.equal(await page.locator("#view-api").getByText(/organization-wide/i).count(), 0);
  assert.equal(await page.locator("#view-settings").getByText(/deprecated organization-wide key/i).count(), 0);

  const stored = "mock-gateway-token-7129";
  saveSettings({ apiKey: stored });
  await page.locator('.nav-item[data-view="system-health"]').click();
  await page.locator("#sh-slack-status").getByText(/Connected as @atlas-fixture/).waitFor();
  assert.doesNotMatch(await page.locator(".sidebar-foot").innerText(), /Slack|atlas-fixture/);
  await page.locator('.nav-item[data-view="api"]').click();
  await field.waitFor();
  assert.equal(await field.inputValue(), "••••••••7129");
  assert.equal(reveals, 0);
  await card.getByRole("button", { name: "Copy token" }).click();
  await card.getByText("Token copied.").waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), stored);
  await card.getByRole("button", { name: "Reveal" }).click();
  await page.waitForFunction((value) => globalThis.document.querySelector("#api-legacy-token input")?.value === value, stored);
  assert.equal(reveals, 2);

  const replacement = "replacement-gateway-token-2571";
  saveSettings({ apiKey: replacement });
  await card.getByRole("button", { name: "Revoke token" }).click();
  await page.locator("#confirm-ok").click();
  await page.getByText("Settings changed", { exact: true }).waitFor();
  await page.locator("#confirm-ok").click();
  assert.equal(getApiKey(), replacement);
  assert.equal(await field.inputValue(), "••••••••2571");

  process.env.CG_API_KEY = "environment-only-fixture-6054";
  await card.getByRole("button", { name: "Revoke token" }).click();
  await page.locator("#confirm-ok").click();
  await card.getByText(/remove CG_API_KEY/).waitFor();
  assert.equal(await card.getByRole("button").count(), 0);
  assert.equal((await card.textContent()).includes(process.env.CG_API_KEY), false);
  delete process.env.CG_API_KEY;
  await page.locator('.nav-item[data-view="system-health"]').click();
  assert.equal(await card.textContent(), "");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/api-tokens")),
    page.locator('.nav-item[data-view="api"]').click(),
  ]);
  assert.equal(await card.isVisible(), false);
  assert.deepEqual(pageErrors, []);
});
