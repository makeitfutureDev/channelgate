// The Activity dashboard's Settings → API tokens section in Chromium: pick a conversation, mint a
// token (shown once, with CSRF), list without a value, revoke after a confirm, refusals stay
// beside the form, and the value is gone after leaving the section.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

test("Settings → API tokens creates, shows once, lists and revokes in Chromium", { skip: !process.env.CG_BROWSER_MODULE, timeout: 50_000 }, async t => {
  const app = express(); app.use(express.json());
  const VALUE = "cgk_browserFixtureValue0123456789abcd";
  let tokens = { CMAIN: [{ id: 1, name: "<b>Make</b> flow", prefix: "cgk_aaaa", last4: "1111", createdBy: "U_ME", createdAt: "2026-11-03T10:00:00.000Z", lastUsedAt: "", mine: true }], DMINE: [] };
  const posts = [];
  app.get("/activity/fixture/api/settings", (_req, res) => res.json({ account: { id: "U_ME", name: "Me", role: "member" }, general: {}, connections: { composioMode: "personal", composio: { configured: false }, email: [] }, ssh: { max: 5, keys: [] } }));
  app.get("/activity/fixture/api/api-tokens", (_req, res) => res.json({ channels: [{ channelId: "DMINE", name: "Your direct messages", personal: true, count: tokens.DMINE.length }, { channelId: "CMAIN", name: "#team", personal: false, count: tokens.CMAIN.length }] }));
  app.get("/activity/fixture/api/api-tokens/:channelId", (req, res) => res.json({ manager: false, tokens: tokens[req.params.channelId] || [], example: "curl …" }));
  app.post("/activity/fixture/api/api-tokens/:channelId", (req, res) => {
    posts.push({ channelId: req.params.channelId, body: req.body, csrf: req.get("X-CG-CSRF") });
    if (!String(req.body?.name || "").trim()) return res.status(400).json({ error: "a token needs a name" });
    const record = { id: 9, name: req.body.name, prefix: VALUE.slice(0, 8), last4: VALUE.slice(-4), createdBy: "U_ME", createdAt: "2026-11-22T10:00:00.000Z", lastUsedAt: "", mine: true };
    tokens[req.params.channelId].push(record);
    res.json({ token: VALUE, record, example: `curl -H "X-API-Key: ${VALUE}" …` });
  });
  app.post("/activity/fixture/api/api-tokens/:channelId/:id/revoke", (req, res) => {
    posts.push({ revoke: req.params.id, channelId: req.params.channelId, csrf: req.get("X-CG-CSRF") });
    tokens[req.params.channelId] = tokens[req.params.channelId].filter((x) => String(x.id) !== req.params.id);
    res.json({ token: { id: Number(req.params.id), revoked: true } });
  });
  app.get("/activity/fixture/settings", (_req, res) => res.type("html").send(activityPage({ sessionId: "fixture", csrf: "browser-csrf", view: "settings" }).html));
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}/activity/fixture/settings#api`);
  await page.getByRole("heading", { name: "API tokens", exact: true }).waitFor();
  await page.getByText("You have no tokens in this conversation.").waitFor(); // the own DM is picked first

  await page.getByLabel("Conversation").selectOption("CMAIN");
  await page.getByText("<b>Make</b> flow", { exact: true }).waitFor();
  assert.equal(await page.locator(".settings-row b").count(), 0, "names render as text");

  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.getByText("a token needs a name", { exact: true }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill("CI deploy");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.getByRole("heading", { name: "Copy your new token now", exact: true }).waitFor();
  assert.equal(await page.locator('input[name="token-value"]').inputValue(), VALUE);
  await page.getByText("CI deploy", { exact: true }).first().waitFor();
  assert.deepEqual(posts.filter((p) => p.body).map((p) => [p.channelId, p.body.name, p.csrf]), [["CMAIN", "", "browser-csrf"], ["CMAIN", "CI deploy", "browser-csrf"]]);
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => globalThis.document.documentElement.setAttribute("data-theme", value), theme);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `${theme} ${width} fits`);
    if (process.env.CG_BROWSER_EVIDENCE_DIR) { await mkdir(process.env.CG_BROWSER_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.CG_BROWSER_EVIDENCE_DIR, `api-tokens-${theme}-${width}.png`), fullPage: true }); }
  }

  // Revoke the original token (confirm accepted).
  await page.locator(".settings-row", { hasText: "<b>Make</b> flow" }).getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByText("<b>Make</b> flow", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(posts.filter((p) => p.revoke).map((p) => [p.channelId, p.revoke, p.csrf]), [["CMAIN", "1", "browser-csrf"]]);

  // Leaving the section drops the revealed value for good.
  await page.getByRole("button", { name: "SSH keys", exact: true }).click();
  await page.getByRole("button", { name: "API tokens", exact: true }).click();
  await page.getByText("CI deploy", { exact: true }).waitFor();
  assert.equal(await page.locator('input[name="token-value"]').count(), 0);
  assert.equal(await page.content().then((html) => html.includes(VALUE)), false);
  assert.deepEqual(errors, []);
});
