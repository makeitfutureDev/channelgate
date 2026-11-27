import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const { saveSettings } = await import("../src/config/settings.js");
const { setUser } = await import("../src/config/store.js");
const { ensureUserAdminAccount } = await import("../src/config/admin-accounts.js");
const { createAdminSession } = await import("../src/web/auth.js");
const { createWebApp } = await import("../src/web/app.js");

// Real app/router/assets and synthetic provider replies: no live provider or login changes.
test("subscription page supports direct entry, refresh, history and a narrow viewport", { skip: !process.env.CG_BROWSER_MODULE, timeout: 45_000 }, async (t) => {
  saveSettings({ publicUrl: "", adminPassword: "disposable-subscriptions-fixture", apiKey: "" });
  await setUser("USUBSADMIN", { name: "Fixture administrator", isAdmin: true });
  let cookie;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { cookie = value.split(";")[0]; } }, ensureUserAdminAccount("USUBSADMIN"));
  const app = createWebApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  const denied = await fetch(`${base}/api/subscriptions`);
  assert.equal(denied.status, 401);
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([{ name: "cg_session", value: cookie.split("=")[1], url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let reads = 0;
  await page.route("**/api/subscriptions", (route) => {
    reads += 1;
    return route.fulfill({ json: { refreshAfterSeconds: 600, subscriptions: [
      { provider: "claude", name: "Claude", account: { email: "claude@example.com", workspace: "Claude workspace" }, plan: "Max", status: "ok", windows: [{ label: "Current session (5 hours)", usedPercent: 42, resetsAt: new Date(Date.now() + 3600_000).toISOString() }], updatedAt: new Date().toISOString() },
      { provider: "codex", name: "Codex", account: { email: "codex@example.com", workspace: "Codex workspace" }, plan: "Pro", status: "ok", windows: [{ label: "Weekly", usedPercent: 91, resetsAt: new Date(Date.now() + 86400_000).toISOString() }], updatedAt: new Date().toISOString() },
      { provider: "codex-eu", name: "Codex EU", account: { email: "eu@example.com", workspace: "EU workspace" }, plan: "Pro Lite", status: "ok", windows: [{ label: "EU weekly", usedPercent: 24, resetsAt: new Date(Date.now() + 86400_000).toISOString() }] },
      { provider: "claude-lic-00000001", name: "Claude · Second seat", account: {}, kind: "none", plan: "", status: "not-connected", windows: [], message: "No subscription login is available." },
      { provider: "codex-channel", name: "Codex (channel account)", kind: "unsupported", status: "unsupported", windows: [], message: "Each channel signs in with its own account." },
      { provider: "codex-api-00000001", name: "Codex · Azure", kind: "api-key", status: "api-key", windows: [], message: "Billed per use by its provider." },
    ] } });
  });
  await page.goto(`${base}/subscriptions`);
  await page.locator(".subscription-card").nth(1).waitFor();
  assert.equal(await page.title(), "Subscriptions — ChannelGate");
  assert.equal(await page.locator(".subscription-card").count(), 4, "a card per license that can have a quota, connected or not");
  // Licenses with no account-wide quota are one line each under the cards, never an empty card.
  assert.deepEqual(await page.locator(".subscription-notes li strong").allTextContents(), ["Codex (channel account)", "Codex · Azure"]);
  assert.match(await page.locator(".subscription-notes").innerText(), /Each channel signs in with its own account/);
  assert.equal(await page.locator(".subscription-plan").evaluateAll((els) => els.every((el) => globalThis.getComputedStyle(el).whiteSpace === "nowrap")), true, "a status badge never wraps");
  assert.equal(await page.locator('progress[aria-label="Weekly usage"]').getAttribute("value"), "91");
  assert.match(await page.locator("#subscriptions-cards").innerText(), /42%/);
  assert.deepEqual(await page.locator(".subscription-account").allTextContents(), ["claude@example.comClaude workspace", "codex@example.comCodex workspace", "eu@example.comEU workspace"]);
  await page.locator("#subscriptions-refresh").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#subscriptions-refresh").textContent === "Refresh");
  assert.equal(reads, 2);
  await page.locator('[data-view="dashboard"]').click();
  await page.goBack();
  await page.locator(".subscription-card").nth(1).waitFor();
  assert.match(page.url(), /\/subscriptions$/);
  await page.reload();
  await page.locator(".subscription-card").nth(1).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.equal(await page.locator("progress").count(), 3);
  assert.equal(await page.locator('progress[aria-label="EU weekly usage"]').getAttribute("value"), "24");
  assert.match(await page.locator("#subscriptions-cards").innerText(), /Codex EU/);
  assert.match(await page.locator("#subscriptions-cards").innerText(), /Not connected/);
  assert.doesNotMatch(await page.locator("#subscriptions-cards").innerText(), /Not supported/);
  if (process.env.CG_SUBSCRIPTIONS_SCREENSHOT) await page.screenshot({ path: process.env.CG_SUBSCRIPTIONS_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
});
