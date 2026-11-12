import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { indexSlackThread, setSlackThreadDone } = await import("../src/gateway/slack-threads.js");
const { recordActiveRun, clearActiveRun } = await import("../src/gateway/active-runs.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, ACTIVITY_GRANT_TTL_MS, ACTIVITY_SESSION_TTL_MS } = await import("../src/web/activity.js");

function serveBrandAssets(app) {
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.get("/favicon.svg", (_req, res) => res.sendFile("favicon.svg", { root: fileURLToPath(new URL("../public", import.meta.url)) }));
}

test("browser reopens the same launch within ten minutes and uses its session for twelve hours", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  await setUser("UACTIVITYBROWSER", { approved: true, isAdmin: false });
  let currentTime = Date.now(), base;
  const issuedAt = currentTime;
  const app = express();
  serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "TFIXTURE", getBaseUrl: () => base,
    now: () => currentTime, pollMs: 25, snapshot: async () => ({ rows: [], total: 0 }), refreshKey: () => "fixture" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const link = createActivityGrantUrl({ baseUrl: base, ownerId: "UACTIVITYBROWSER", teamId: "TFIXTURE", now: currentTime });
  await page.goto(link);
  await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
  const firstSession = page.url();
  assert.equal(await page.title(), "My Activity · ChannelGate");
  await page.goto(link);
  await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
  assert.notEqual(page.url(), firstSession);
  currentTime = issuedAt + ACTIVITY_GRANT_TTL_MS;
  await page.goto(link);
  await page.locator("#status").filter({ hasText: /expired or is unavailable/ }).waitFor();
  assert.doesNotMatch(await page.locator("#status").innerText(), /already used/);
  currentTime = issuedAt + ACTIVITY_SESSION_TTL_MS - 1;
  const stillValid = await page.goto(firstSession);
  assert.equal(stillValid.status(), 200);
  await page.locator("#connection-text").filter({ hasText: "Live updates" }).waitFor();
  currentTime = issuedAt + ACTIVITY_SESSION_TTL_MS;
  const expired = await page.reload();
  assert.equal(expired.status(), 401);
  assert.deepEqual(errors, []);
});

test("Activity group order works on desktop and mobile and persists for only its viewer", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  await setUser("UACTIVITYORDER", { approved: true, activityGroupOrder: null });
  await setUser("UACTIVITYORDEROTHER", { approved: true, activityGroupOrder: null });
  let base;
  const rows = ["idle", "working", "waiting", "error", "error", "done"].map((status, i) => ({
    channel_id: "C_ORDER", thread_ts: String(100 + i), title: status + i,
    channelName: "Activity fixture", status, last_message_ms: Date.now() - i * 1000,
  }));
  const app = express(); serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "TORDER", getBaseUrl: () => base,
    snapshot: async () => ({ rows, total: rows.length }), refreshKey: () => "fixture" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await setUser("UACTIVITYORDER", { activityGroupOrder: null });
    const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId: "UACTIVITYORDER", teamId: "TORDER" }));
    await page.locator("#result-count").filter({ hasText: "5 conversations" }).waitFor();
    const titles = () => page.locator(".thread-title").allTextContents();
    assert.deepEqual(await titles(), ["error3", "error4", "waiting2", "working1", "idle0"]);
    await page.getByRole("button", { name: "Group order" }).click();
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Move Idle up" }).click();
    assert.deepEqual(await page.locator(".order-label").allTextContents(), ["Idle", "Error", "Waiting", "Working"]);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await titles(), ["error3", "error4", "waiting2", "working1", "idle0"]);
    await page.getByRole("button", { name: "Group order" }).click();
    await page.getByRole("button", { name: "Move Error down" }).click();
    await page.getByRole("button", { name: "Save order" }).click();
    await page.locator("#order-dialog").waitFor({ state: "hidden" });
    assert.deepEqual(await titles(), ["waiting2", "error3", "error4", "working1", "idle0"]);
    await page.reload(); await page.locator("#result-count").filter({ hasText: "5 conversations" }).waitFor();
    assert.deepEqual(await titles(), ["waiting2", "error3", "error4", "working1", "idle0"]);
    await page.getByRole("button", { name: "Group order" }).click();
    if (process.env.CG_ACTIVITY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.CG_ACTIVITY_SCREENSHOT_DIR}/activity-order-${viewport.width}.png` });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    await page.getByRole("button", { name: "Reset to default" }).click();
    await page.getByRole("button", { name: "Save order" }).click();
    await page.locator("#order-dialog").waitFor({ state: "hidden" });
    assert.deepEqual(await titles(), ["error3", "error4", "waiting2", "working1", "idle0"]);
    await page.locator("#search").fill("error");
    assert.deepEqual(await titles(), ["error3", "error4"]);
    await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId: "UACTIVITYORDEROTHER", teamId: "TORDER" }));
    await page.locator("#result-count").filter({ hasText: "5 conversations" }).waitFor();
    assert.deepEqual(await titles(), ["error3", "error4", "waiting2", "working1", "idle0"]);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("mobile Activity counts reflect durable worker events on completed roots without reload", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  await setUser("UACTIVITYBROWSER", { approved: true, isAdmin: false });
  await upsertChannelEntry("C_ACTIVITY", { name: "Activity fixture", type: "channel" });
  const entry = await getChannelEntry("C_ACTIVITY");
  await saveChannelMeta(entry.slug, { access: "approved" });
  const root = { ts: "100.000001", user: "UACTIVITYBROWSER", text: "Resumed completed task" };
  indexSlackThread({ channelId: "C_ACTIVITY", slug: entry.slug, root, agentEngaged: true });
  setSlackThreadDone("C_ACTIVITY", root.ts, root.user, true);
  let base;
  const app = express();
  serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "TFIXTURE", getBaseUrl: () => base,
    pollMs: 60_000, accessRefreshMs: 60_000 }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId: root.user, teamId: "TFIXTURE" }));
  await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
  await page.locator("#connection-text").filter({ hasText: "Live updates" }).waitFor();
  const sessionUrl = page.url();
  assert.equal(await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    return globalThis.document.fonts.check("14px Poppins");
  }), true);
  for (const engine of ["claude", "codex"]) {
    const run = { channelId: "C_ACTIVITY", slug: entry.slug, threadKey: root.ts, engine, authorId: root.user };
    recordActiveRun("mobile-worker", run);
    await page.locator("#summary").filter({ hasText: "1 open · 1 working · 0 waiting" }).waitFor();
    assert.equal(await page.locator("tbody tr .pill").innerText(), "Working");
    if (engine === "claude" && process.env.CG_ACTIVITY_SCREENSHOT) {
      await page.screenshot({ path: process.env.CG_ACTIVITY_SCREENSHOT, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: process.env.CG_ACTIVITY_SCREENSHOT.replace(/\.png$/, "-desktop.png"), fullPage: true });
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    recordActiveRun("mobile-worker", { ...run, awaitingChoice: true });
    await page.locator("#summary").filter({ hasText: "1 open · 0 working · 1 waiting" }).waitFor();
    assert.equal(await page.locator("tbody tr .pill").innerText(), "Waiting");
    clearActiveRun("mobile-worker");
    await page.locator("#summary").filter({ hasText: "0 open · 0 working · 0 waiting" }).waitFor();
    assert.equal(page.url(), sessionUrl);
  }
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.deepEqual(errors, []);
});
