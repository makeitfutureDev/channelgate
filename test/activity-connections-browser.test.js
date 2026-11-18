import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

test("Connections controller runs in a real browser with SDK authorization and personal-token display", { skip: !process.env.CG_BROWSER_MODULE, timeout: 40_000 }, async t => {
  const app = express(); app.use(express.json());
  let mode = "sdk", ended = false; const posts = [], catalogRequests = [];
  app.get("/activity/fixture/api/settings", (_req, res) => res.json({ connections: { composioMode: mode, composio: { configured: true, last4: "1234", label: "My account" }, toolbox: { configured: false }, email: [] } }));
  app.get("/activity/fixture/api/connections", (_req, res) => ended ? res.status(401).json({}) : res.json({ mode, canAdd: mode === "sdk", accounts: [{ app: "gmail", alias: "work", account: "<img src=x onerror=alert(1)>", status: "ACTIVE" }], policy: { multiAccount: true, maxAccountsPerToolkit: 5 } }));
  app.get("/activity/fixture/api/connections/apps", (req, res) => {
    catalogRequests.push(req.query);
    res.json({ apps: [{ slug: "gmail", name: "Gmail", description: "Connect your email account", canConnect: true }, { slug: "slack", name: "Slack", canConnect: false, reason: "Account limit reached" }], nextCursor: null });
  });
  app.post("/activity/fixture/api/connections", (req, res) => { posts.push({ body: req.body, csrf: req.get("X-CG-CSRF") }); res.json({ redirectUrl: "https://connect.composio.dev/link/browser-fixture" }); });
  app.get(/^\/activity\/fixture\/settings\/connections(?:\/new)?$/, (req, res) => {
    const page = activityPage({ sessionId: "fixture", csrf: "browser-csrf", view: "settings", connectionsPage: true, connectionsNew: req.path.endsWith("/new") });
    res.type("html").send(page.html);
  });
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}/activity/fixture/settings/connections`;
  await page.goto(base);
  await page.getByText("<img src=x onerror=alert(1)>", { exact: true }).waitFor();
  assert.equal(await page.locator(".connections-card img").count(), 0);
  await page.getByRole("link", { name: "Add connection", exact: true }).click();
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Connect Slack", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await page.getByLabel("Account alias", { exact: false }).fill("personal");
  await page.getByRole("button", { name: "Create connection link", exact: true }).click();
  const authorize = page.getByRole("link", { name: "Continue to Gmail", exact: true }); await authorize.waitFor();
  assert.equal(await authorize.getAttribute("target"), "_blank"); assert.equal(await authorize.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(posts, [{ body: { app: "gmail", alias: "personal" }, csrf: "browser-csrf" }]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  }
  mode = "personal"; const before = catalogRequests.length; await page.reload();
  await page.getByText(/Your personal Composio token provides/).waitFor();
  assert.equal(catalogRequests.length, before); assert.equal(await page.getByRole("button", { name: "Connect Gmail", exact: true }).count(), 0);
  ended = true; await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText(/Your Activity session has ended/).waitFor();
  assert.equal(await page.getByText("<img src=x onerror=alert(1)>", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
