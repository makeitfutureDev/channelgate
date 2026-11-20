import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

test("the Skills page lists a conversation's requests waiting for approval", { skip: !process.env.CG_BROWSER_MODULE, timeout: 45_000 }, async (t) => {
  const app = express();
  const skills = [{ key: "deploy-helper", name: "Deploy Helper", description: "ships", selected: false, locked: false, source: "" }];
  const pending = [{ id: 7, kind: "change", action: "Edit an organization skill", skill: "Org Policy", key: "org-policy", target: "", note: "<b>Tighten</b> the wording", by: "Other", createdAt: "2026-11-19T10:00:00.000Z" }];
  app.get("/activity/fixture/api/skills", (_req, res) => res.json({ channels: [
    { channelId: "me", name: "Only me — every conversation", personal: true, count: 0, linked: false, pending: 0 },
    { channelId: "C1", name: "#team", personal: false, count: 1, linked: false, pending: 1 },
  ] }));
  app.get("/activity/fixture/api/skills/me", (_req, res) => res.json({ kind: "personal", editable: true, linked: null, notLoaded: [], pending: [], skills }));
  app.get("/activity/fixture/api/skills/C1", (_req, res) => res.json({ kind: "channel", editable: true, linked: null, notLoaded: [], pending, skills }));
  app.get("/activity/fixture/skills", (_req, res) => res.type("html").send(activityPage({ sessionId: "fixture", csrf: "csrf", view: "skills" }).html));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/activity/fixture/skills`);
  await page.locator(".skills-row").first().waitFor();
  const box = page.locator("#skills-pending");
  assert.equal(await box.isVisible(), false, "nothing waiting under Only me");
  assert.match(await page.locator("#skills-channel option").nth(1).textContent(), /#team · 1 skill · 1 waiting for approval/);
  await page.selectOption("#skills-channel", "C1");
  await box.locator("li").waitFor();
  const text = await box.innerText();
  assert.match(text, /Waiting for approval · 1/);
  assert.match(text, /Org Policy/);
  assert.match(text, /Edit an organization skill/);
  assert.match(text, /Request #7 · by Other · /);
  assert.match(text, /<b>Tighten<\/b> the wording/, "the note is text, never markup");
  assert.equal(await box.locator("b").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at phone width");
  await page.selectOption("#skills-channel", "me");
  await page.locator(".skills-row").first().waitFor();
  assert.equal(await box.isVisible(), false);
  assert.deepEqual(errors, []);
});
