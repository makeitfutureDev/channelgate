import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

test("compact logo catalog paginates without accumulating cards and Email has its own page", { skip: !process.env.CG_BROWSER_MODULE, timeout: 45_000 }, async t => {
  const app = express(), calls = [];
  const first = [{ slug: "gmail", name: "Gmail", logo: "https://logos.composio.dev/api/gmail", canConnect: true }, { slug: "slack", name: "Slack", canConnect: true }, ...Array.from({ length: 22 }, (_, i) => ({ slug: `fixture_${i}`, name: `Application ${i + 1}`, canConnect: true }))];
  const second = [{ slug: "linear", name: "Linear", canConnect: true }];
  app.get("/activity/fixture/api/settings", (_req, res) => res.json({ connections: { composioMode: "sdk", composio: {}, email: [] } }));
  app.get("/activity/fixture/api/connections", (_req, res) => { calls.push("inventory"); res.json({ mode: "sdk", state: "ready", canAdd: true, accounts: [{ app: "gmail", id: "ca_mine", account: "work@example.test", status: "ACTIVE" }] }); });
  app.get("/activity/fixture/api/connections/apps", (req, res) => {
    calls.push({ query: req.query.query, cursor: req.query.cursor });
    const apps = req.query.query ? first.filter(a => a.name.toLowerCase().includes(String(req.query.query).toLowerCase())) : req.query.cursor ? second : first;
    res.json({ apps, nextCursor: !req.query.query && !req.query.cursor ? "second" : null });
  });
  app.get(/^\/activity\/fixture\/settings\/(?:email|connections(?:\/new)?)$/, (req, res) => {
    const page = activityPage({ sessionId: "fixture", csrf: "csrf", view: "settings", emailPage: req.path.endsWith("/email"), connectionsPage: req.path.includes("/connections"), connectionsNew: req.path.endsWith("/new") });
    res.type("html").send(page.html);
  });
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = [], logoRequests = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("https://logos.composio.dev/**", async route => {
    logoRequests.push(route.request().url());
    if (route.request().url().endsWith("/slack")) return route.abort();
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect x="2" y="2" rx="5" width="24" height="24" fill="#4285f4"/></svg>' });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + "/activity/fixture/settings/connections/new");
  await page.getByRole("button", { name: "View Gmail connections", exact: true }).waitFor();
  const cards = page.locator(".connection-app-card"); assert.equal(await cards.count(), 24);
  assert.equal(calls.filter(c => typeof c === "object").length, 1, "no eager next-page request");
  assert.equal(await page.getByRole("heading", { name: "Email accounts", exact: true }).count(), 0);
  const gmail = page.getByRole("button", { name: "View Gmail connections", exact: true });
  const logo = gmail.locator("img"); await logo.waitFor();
  assert.equal(await logo.getAttribute("src"), "https://logos.composio.dev/api/gmail");
  assert.equal(await logo.getAttribute("loading"), "lazy"); assert.equal(await logo.getAttribute("referrerpolicy"), "no-referrer");
  await page.getByRole("button", { name: "View Slack connections", exact: true }).locator("img").waitFor({ state: "detached" });
  assert.match(await page.getByRole("button", { name: "View Slack connections", exact: true }).locator(".connection-app-icon").innerText(), /S/);
  for (const theme of ["light", "dark"]) for (const [width, minimum] of [[390, 1], [768, 2], [1024, 3], [1440, 5], [1920, 7]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => globalThis.document.documentElement.setAttribute("data-theme", value), theme);
    const columns = await page.locator(".connections-grid").evaluate(el => globalThis.getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.ok(columns >= minimum, `${width}px fits ${minimum}+ columns, actual ${columns}`);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    assert.ok((await cards.first().boundingBox()).height < 100, "cards remain compact");
    if (process.env.CG_BROWSER_EVIDENCE_DIR) { await mkdir(process.env.CG_BROWSER_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.CG_BROWSER_EVIDENCE_DIR, `catalog-${theme}-${width}.png`), fullPage: true }); }
  }
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "View Linear connections", exact: true }).waitFor();
  assert.equal(await cards.count(), 1); assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "View Linear connections", exact: true }).click();
  const beforeBack = calls.length; await page.getByRole("button", { name: "Back to apps", exact: true }).click();
  await page.getByText("Page 2", { exact: true }).waitFor(); assert.equal(calls.length, beforeBack);
  await page.getByRole("button", { name: "Previous", exact: true }).click(); await gmail.waitFor(); assert.equal(await cards.count(), 24);
  await page.getByLabel("Search applications", { exact: true }).fill("gmail");
  await page.waitForFunction(() => globalThis.document.querySelectorAll(".connection-app-card").length === 1);
  assert.equal(await cards.count(), 1); assert.equal(await page.locator(".connections-pagination").isVisible(), false); assert.equal(calls.at(-1).query, "gmail"); assert.equal(calls.at(-1).cursor, undefined);
  await page.getByRole("button", { name: "Connected (1)", exact: true }).click();
  assert.equal(await page.locator(".connections-pagination").isVisible(), false);
  await page.getByRole("button", { name: "Email accounts", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/activity/fixture/settings/email");
  await page.getByRole("heading", { name: "Email accounts", exact: true }).waitFor();
  assert.equal(await cards.count(), 0);
  const beforeEmail = calls.length; await page.reload(); await page.getByRole("heading", { name: "Email accounts", exact: true }).waitFor();
  assert.equal(calls.length, beforeEmail, "direct Email page does not fetch Composio inventory/catalog");
  await page.getByText("Add an email account", { exact: true }).click();
  await page.getByLabel("IMAP host", { exact: true }).waitFor(); await page.getByLabel("SMTP host", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("IMAP password", { exact: true }).inputValue(), "");
  assert.ok(logoRequests.length); assert.deepEqual(errors, []);
});
