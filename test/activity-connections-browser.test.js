import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

test("Connections app overview/detail and confirmed account deletion work in Chromium", { skip: !process.env.CG_BROWSER_MODULE, timeout: 50_000 }, async t => {
  const app = express(); app.use(express.json());
  let mode = "sdk", ended = false, refuseDelete = true;
  let accounts = [
    { id: "ca_work", app: "gmail", alias: "work", account: "<img src=x onerror=alert(1)>", status: "ACTIVE", canDelete: true },
    { id: "ca_shared", app: "gmail", alias: "Team shared", account: "shared@example.test", status: "ACTIVE", canDelete: false },
    { id: "ca_slack", app: "slack", alias: "work", account: "Workspace", status: "ACTIVE", canDelete: true },
  ];
  const posts = [], deletions = [], catalogRequests = [];
  app.get("/activity/fixture/api/settings", (_req, res) => res.json({ connections: { composioMode: mode, composio: { configured: true, last4: "1234", label: "My account" }, email: [] } }));
  app.get("/activity/fixture/api/connections", (_req, res) => ended ? res.status(401).json({}) : res.json({ mode, state: "ready", canAdd: mode === "sdk", accounts, policy: { multiAccount: true, maxAccountsPerToolkit: 5 } }));
  app.get("/activity/fixture/api/connections/apps", (req, res) => {
    catalogRequests.push(req.query);
    res.json({ apps: [{ slug: "gmail", name: "Gmail", description: "Connect your email account", canConnect: true }, { slug: "slack", name: "Slack", canConnect: false, reason: "Account limit reached" }], nextCursor: null });
  });
  app.post("/activity/fixture/api/connections", (req, res) => { posts.push({ body: req.body, csrf: req.get("X-CG-CSRF") }); res.json({ redirectUrl: "https://connect.composio.dev/link/browser-fixture" }); });
  app.delete("/activity/fixture/api/connections/:accountId", (req, res) => {
    deletions.push({ id: req.params.accountId, csrf: req.get("X-CG-CSRF") });
    if (refuseDelete) return res.status(503).json({ error: "Provider temporarily unavailable" });
    assert.ok(accounts.find(account => account.id === req.params.accountId && account.canDelete));
    accounts = accounts.filter(account => account.id !== req.params.accountId); return res.json({ deleted: true });
  });
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
  await page.route("https://logos.composio.dev/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="#4285f4"/></svg>' }));
  const base = `http://127.0.0.1:${server.address().port}/activity/fixture/settings/connections`;
  await page.goto(base);
  await page.getByRole("button", { name: "Connected (2)", exact: true }).waitFor();
  const gmail = () => page.getByRole("button", { name: "View Gmail connections", exact: true });
  assert.equal(await page.getByText(/<img src=x onerror=alert\(1\)>/).count(), 0, "app overview hides account details");
  assert.match(await gmail().innerText(), /2 accounts.*2 active/);
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => globalThis.document.documentElement.setAttribute("data-theme", value), theme);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    if (process.env.CG_BROWSER_EVIDENCE_DIR) { await mkdir(process.env.CG_BROWSER_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.CG_BROWSER_EVIDENCE_DIR, `apps-${theme}-${width}.png`), fullPage: true }); }
  }
  await page.getByLabel("Search applications", { exact: true }).fill("Gmail");
  assert.equal(await page.getByRole("button", { name: "View Slack connections", exact: true }).count(), 0);
  await gmail().click();
  await page.getByText(/<img src=x onerror=alert\(1\)>/).waitFor();
  assert.equal(await page.locator(".connections-card img[src=x]").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delete connection", exact: true }).count(), 1, "shared account has no delete action");
  if (process.env.CG_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.CG_BROWSER_EVIDENCE_DIR, "gmail-detail-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete connection", exact: true }).click();
  await page.getByRole("button", { name: "Cancel deletion", exact: true }).click(); assert.equal(deletions.length, 0);
  await page.getByRole("button", { name: "Delete connection", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page.getByText("Provider temporarily unavailable", { exact: true }).waitFor();
  refuseDelete = false;
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page.getByText(/<img src=x onerror=alert\(1\)>/).waitFor({ state: "detached" });
  await page.getByText(/shared@example.test/).waitFor();
  assert.deepEqual(deletions, [{ id: "ca_work", csrf: "browser-csrf" }, { id: "ca_work", csrf: "browser-csrf" }]);
  await page.getByRole("button", { name: "Back to apps", exact: true }).click();
  await page.getByRole("link", { name: "Add connection", exact: true }).click();
  await gmail().click(); assert.equal(await page.getByRole("button", { name: "Connect new", exact: true }).isDisabled(), false);
  await page.getByRole("button", { name: "Connect new", exact: true }).click();
  await page.getByLabel("Account alias", { exact: false }).fill("personal");
  await page.getByRole("button", { name: "Create connection link", exact: true }).click();
  const authorize = page.getByRole("link", { name: "Continue to Gmail", exact: true }); await authorize.waitFor();
  assert.equal(await authorize.getAttribute("target"), "_blank"); assert.equal(await authorize.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(posts, [{ body: { app: "gmail", alias: "personal" }, csrf: "browser-csrf" }]);
  mode = "personal"; const before = catalogRequests.length;
  accounts = [{ id: "gmail_private", app: "gmail", alias: "Personal", account: "private@example.test", status: "ACTIVE", canDelete: true }];
  await page.reload(); await page.getByText(/Your personal Composio token provides/).waitFor();
  assert.equal(catalogRequests.length, before); assert.equal(await page.getByRole("button", { name: "All apps", exact: true }).count(), 0);
  await gmail().click(); assert.equal(await page.getByRole("button", { name: "Connect new", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Delete connection", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page.getByText(/private@example.test/).waitFor({ state: "detached" });
  assert.equal(deletions.at(-1).id, "gmail_private");
  await page.getByRole("button", { name: "Back to apps", exact: true }).click();
  ended = true; await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText(/Your Activity session has ended/).waitFor();
  assert.equal(await page.getByRole("button", { name: "View Gmail connections", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
