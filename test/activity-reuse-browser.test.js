import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { indexSlackThread, getSlackThread, setSlackThreadDone } = await import("../src/gateway/slack-threads.js");
const { recordActiveRun, clearActiveRun } = await import("../src/gateway/active-runs.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, ACTIVITY_GRANT_TTL_MS, ACTIVITY_SESSION_TTL_MS } = await import("../src/web/activity.js");

function serveBrandAssets(app) {
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.get("/favicon.svg", (_req, res) => res.sendFile("favicon.svg", { root: fileURLToPath(new URL("../public", import.meta.url)) }));
}

test("Activity hands off to native Slack without a new tab and keeps a browser alternative", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  const ownerId = "UACTIVITYAPP", channelId = "C_ACTIVITY_APP";
  await setUser(ownerId, { approved: true });
  await upsertChannelEntry(channelId, { name: "Activity app fixture", type: "channel" });
  const entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  const root = { ts: "100.000001", user: ownerId, text: "App handoff fixture", reply_count: 1, latest_reply: "101.123456" };
  indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  const client = { conversations: { replies: async () => ({ messages: [root] }) },
    chat: { getPermalink: async () => ({ permalink: "https://example.slack.com/archives/C_ACTIVITY_APP/p101123456" }) } };
  let base;
  const app = express(); serveBrandAssets(app);
  let onHandoff;
  app.use((req, res, next) => {
    res.on("finish", () => { if (req.path.includes("/open/C_ACTIVITY_APP/")) onHandoff?.({ status: res.statusCode, location: res.getHeader("Location") }); });
    next();
  });
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "TAPP", getBaseUrl: () => base,
    snapshot: async () => ({ rows: [{ channel_id: channelId, thread_ts: root.ts, title: root.text,
      channelName: "App fixture", status: "idle", last_message_ms: Date.now() }], total: 1 }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(5000);
  // No native handler exists in headless Chromium. Verify the actual HTTP/protocol handoff
  // and surviving dashboard, separately from the live installed-Slack acceptance gate.
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TAPP" }));
  await page.getByRole("link", { name: "Open in Slack", exact: true }).waitFor();
  const dashboard = page.url();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    for (const name of ["Open in Slack", root.text]) {
      assert.equal(await page.getByRole("link", { name, exact: true }).getAttribute("target"), "_self");
    }
    const web = page.getByRole("link", { name: "Open in browser: " + root.text, exact: true });
    assert.equal(await web.getAttribute("target"), "_blank");
    assert.equal(new URL(await web.getAttribute("href"), base).searchParams.get("browser"), "1");
  }
  // Exercise the native handoff last: a missing OS handler leaves a pending navigation.
  const response = new Promise((resolve) => { onHandoff = resolve; });
  await page.getByRole("link", { name: "Open in Slack", exact: true }).click();
  const handoff = await response;
  assert.equal(handoff.status, 303);
  const target = new URL(handoff.location);
  assert.equal(target.protocol, "slack:");
  assert.equal(target.searchParams.get("team"), "TAPP");
  assert.equal(target.searchParams.get("message"), root.latest_reply);
  assert.equal(target.searchParams.get("thread_ts"), root.ts);
  assert.equal(context.pages().length, 1);
  assert.equal(page.url(), dashboard);

});

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
  assert.equal(await page.title(), "Activity · ChannelGate");
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
    await page.locator("#summary").filter({ hasText: "1 active · 0 later · 1 working · 0 waiting" }).waitFor();
    assert.equal(await page.locator("tbody tr .pill").innerText(), "Working");
    if (engine === "claude" && process.env.CG_ACTIVITY_SCREENSHOT) {
      await page.screenshot({ path: process.env.CG_ACTIVITY_SCREENSHOT, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: process.env.CG_ACTIVITY_SCREENSHOT.replace(/\.png$/, "-desktop.png"), fullPage: true });
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    recordActiveRun("mobile-worker", { ...run, awaitingChoice: true });
    await page.locator("#summary").filter({ hasText: "1 active · 0 later · 0 working · 1 waiting" }).waitFor();
    assert.equal(await page.locator("tbody tr .pill").innerText(), "Waiting");
    clearActiveRun("mobile-worker");
    await page.locator("#summary").filter({ hasText: "0 active · 0 later · 0 working · 0 waiting" }).waitFor();
    assert.equal(page.url(), sessionUrl);
  }
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.deepEqual(errors, []);
});


test("Activity Mark All Done confirms on desktop and mobile and completes owned threads outside the search", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  const ownerId = "U_ACTIVITY_BULK", otherId = "U_ACTIVITY_BULK_OTHER";
  await setUser(ownerId, { approved: true, isAdmin: false });
  await setUser(otherId, { approved: true, isAdmin: false });
  const roots = new Map(), owned = [];
  for (const channelId of ["C_ACTIVITY_BULK_A", "C_ACTIVITY_BULK_B"]) {
    await upsertChannelEntry(channelId, { name: channelId, type: "channel" });
    const entry = await getChannelEntry(channelId);
    await saveChannelMeta(entry.slug, { access: "approved" });
    for (let index = 0; index < 7; index++) {
      const root = { ts: `200.00000${index}`, user: ownerId, text: `${index === 0 ? "Visible" : "Hidden"} bulk fixture ${index}` };
      roots.set(`${channelId}:${root.ts}`, root); owned.push({ channelId, root });
      indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
    }
    const root = { ts: "201.000001", user: otherId, text: "Other viewer fixture" };
    roots.set(`${channelId}:${root.ts}`, root);
    indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  }
  let base, releaseRead;
  const client = { conversations: { replies: async ({ channel, ts }) => {
    if (releaseRead) await releaseRead.promise;
    return { messages: [roots.get(`${channel}:${ts}`)].filter(Boolean) };
  } } };
  const app = express(); serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "TBULK", getBaseUrl: () => base }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const { channelId, root } of owned) setSlackThreadDone(channelId, root.ts, ownerId, false);
    const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [], mutations = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (request.url().endsWith("/api/completion-all")) mutations.push(request); });
    await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TBULK" }));
    await page.locator("#result-count").filter({ hasText: "14 conversations" }).waitFor();
    await page.locator("#search").fill("Visible");
    await page.locator("#result-count").filter({ hasText: "2 conversations" }).waitFor();
    await page.locator("#mark-all-done").click();
    const dialog = page.getByRole("dialog", { name: "Mark all your threads done?" });
    assert.match(await dialog.innerText(), /outside the current filter, search, or page/);
    assert.equal(await page.evaluate(() => globalThis.document.activeElement.id), "all-done-cancel");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("#mark-all-done").click(); await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(mutations.length, 0);
    assert.equal(owned.some(({ channelId, root }) => getSlackThread(channelId, root.ts).done_ms > 0), false);
    await page.locator("#mark-all-done").click();
    let release; const promise = new Promise((resolve) => { release = resolve; }); releaseRead = { promise };
    const mutation = page.waitForRequest((request) => request.url().endsWith("/api/completion-all"));
    await page.locator("#all-done-confirm").evaluate((button) => { button.click(); button.click(); });
    await mutation;
    assert.equal(await page.locator("#all-done-confirm").isDisabled(), true);
    await page.keyboard.press("Escape"); assert.equal(await dialog.isVisible(), true);
    assert.equal(mutations.length, 1);
    if (process.env.CG_ACTIVITY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.CG_ACTIVITY_SCREENSHOT_DIR}/activity-mark-all-done-${viewport.width}.png` });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    releaseRead = null; release();
    await page.locator("#notice").filter({ hasText: "Marked 14 threads done. 0 skipped. 0 failed." }).waitFor();
    await dialog.waitFor({ state: "hidden" });
    for (const { channelId, root } of owned) assert.ok(getSlackThread(channelId, root.ts).done_ms > 0);
    for (const channelId of ["C_ACTIVITY_BULK_A", "C_ACTIVITY_BULK_B"]) assert.equal(getSlackThread(channelId, "201.000001").done_ms, 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("Activity viewers see only subscription quick bars and can navigate to full quota cards", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  await setUser("USUBSUSER", { approved: true, isAdmin: false });
  let base, reads = 0, currentTime = Date.now();
  const app = express(); serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "TSUBS", getBaseUrl: () => base,
    now: () => currentTime, snapshot: async () => ({ rows: [], total: 0 }), refreshKey: () => "fixture",
    readSubscriptions: async () => {
      reads++;
      return { refreshAfterSeconds: 300, subscriptions: [
        { name: "Claude", account: { email: "claude@example.com", workspace: "Claude workspace" }, kind: "subscription", status: "ok", plan: "Max", windows: [{ label: "5-hour session", usedPercent: 0 }, { label: "Weekly · Fable", usedPercent: 63, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] },
        { name: "Codex EU", account: { email: "eu@example.com", workspace: "EU workspace" }, kind: "subscription", status: "ok", plan: "Pro", windows: [{ label: "Weekly", usedPercent: 10 }], resetCredits: { available: 2, resets: [{ label: "Full reset", expiresAt: "2099-01-01T00:00:00Z" }] } },
        { name: "API fixture", kind: "api-key", status: "api-key", windows: [] },
        { name: "Missing fixture", kind: "none", status: "not-connected", windows: [] },
      ] };
    } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId: "USUBSUSER", teamId: "TSUBS" }));
  await page.locator(".subscription-quick").nth(1).waitFor();
  assert.equal(await page.locator("h1").count(), 0);
  assert.equal(await page.locator(".subscription-quick").count(), 2);
  assert.match(await page.locator("#subscription-quick").innerText(), /63%/);
  assert.doesNotMatch(await page.locator("#subscription-quick").innerText(), /API fixture|Missing fixture/);
  const activityUrl = page.url();
  await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
  await page.locator(".subscription-card").nth(1).waitFor();
  assert.equal(page.url(), activityUrl + "/subscriptions");
  assert.equal(await page.title(), "Subscriptions · ChannelGate");
  assert.equal(await page.locator(".subscription-card").count(), 2);
  assert.match(await page.locator("#subscriptions-cards").innerText(), /Weekly · Fable/);
  assert.deepEqual(await page.locator(".subscription-account").allTextContents(), ["claude@example.comClaude workspace", "eu@example.comEU workspace"]);
  assert.match(await page.locator("#subscriptions-cards").innerText(), /Resets in/);
  assert.match(await page.locator("#subscriptions-cards").innerText(), /2 available/);
  assert.match(await page.locator("#subscriptions-cards").innerText(), /Full reset expires in/);
  const before = reads;
  await page.locator("#subscriptions-refresh").click();
  await page.waitForFunction(() => globalThis.document.getElementById("subscriptions-refresh").textContent === "Refresh");
  assert.equal(reads, before + 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  }
  const detailScreenshot = process.env.CG_ACTIVITY_DETAIL_SCREENSHOT || (process.env.CG_ACTIVITY_SCREENSHOT_DIR && `${process.env.CG_ACTIVITY_SCREENSHOT_DIR}/subscriptions-detail-mobile.png`);
  if (detailScreenshot) await page.screenshot({ path: detailScreenshot, fullPage: true });
  await page.reload(); await page.locator(".subscription-card").nth(1).waitFor();
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await page.locator(".subscription-quick").nth(1).waitFor();
  const quickScreenshot = process.env.CG_ACTIVITY_SUBSCRIPTIONS_SCREENSHOT || (process.env.CG_ACTIVITY_SCREENSHOT_DIR && `${process.env.CG_ACTIVITY_SCREENSHOT_DIR}/subscriptions-quick-mobile.png`);
  if (quickScreenshot) await page.screenshot({ path: quickScreenshot, fullPage: true });
  await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
  await page.locator(".subscription-card").nth(1).waitFor();
  currentTime += ACTIVITY_SESSION_TTL_MS;
  await page.locator("#subscriptions-refresh").click();
  await page.locator("#subscriptions-notice").filter({ hasText: /session has ended/ }).waitFor();
  assert.equal(await page.locator(".subscription-card").count(), 0);
  assert.equal(await page.locator("#subscriptions-refresh").isDisabled(), true);
  assert.deepEqual(errors, []);
});


test("Later controls work in a real browser at desktop and mobile widths", { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  const ownerId = "U_LATER_BROWSER", channelId = "C_LATER_BROWSER";
  await setUser(ownerId, { approved: true });
  await upsertChannelEntry(channelId, { name: "Later browser fixture", type: "channel" });
  const entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  const root = { ts: "100.000001", user: ownerId, text: "Postpone this conversation" };
  indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  const client = { auth: { test: async () => ({ user_id: "B_LATER" }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { replies: async () => ({ messages: [root] }) } };
  let base;
  const app = express(); serveBrandAssets(app);
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "T_LATER", getBaseUrl: () => base }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  for (const width of [320, 390, 700, 768, 1024, 1100, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "T_LATER" }));
    await page.getByRole("button", { name: "Delay for later: Postpone this conversation", exact: true }).waitFor();
    const layout = await page.locator("#threads .actions").evaluate((cell) => {
      const bounds = cell.getBoundingClientRect();
      const controls = [...cell.querySelectorAll("a,button")].filter((item) => !item.hidden).map((item) => {
        const r = item.getBoundingClientRect();
        return { text: item.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      return { left: bounds.left, right: bounds.right, controls };
    });
    for (const control of layout.controls) {
      assert.ok(control.left >= layout.left - 1 && control.right <= layout.right + 1, `${width}: ${control.text} must stay inside its action cell`);
    }
    for (let i = 0; i < layout.controls.length; i++) for (let j = i + 1; j < layout.controls.length; j++) {
      const a = layout.controls[i], c = layout.controls[j];
      assert.ok(a.right <= c.left + 1 || c.right <= a.left + 1 || a.bottom <= c.top + 1 || c.bottom <= a.top + 1, `${width}: ${a.text} overlaps ${c.text}`);
    }
    assert.equal(await page.getByRole("button", { name: "Delay for later: Postpone this conversation", exact: true }).innerText(), "🕒 Later");
    if (process.env.CG_LATER_LAYOUT_SCREENSHOT && [390, 768, 1440].includes(width)) {
      await page.screenshot({ path: process.env.CG_LATER_LAYOUT_SCREENSHOT.replace(".png", `-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Delay for later: Postpone this conversation", exact: true }).click();
    await page.waitForFunction(() => globalThis.document.querySelector('[data-filter="later"] span').textContent === "1");
    assert.equal(await page.locator("#threads tr").count(), 0);
    await page.locator('[data-filter="later"]').click();
    await page.getByRole("button", { name: "Resume: Postpone this conversation", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    await page.getByRole("button", { name: "Resume: Postpone this conversation", exact: true }).click();
    await page.waitForFunction(() => globalThis.document.querySelector('[data-filter="later"] span').textContent === "0");
    await page.locator('[data-filter="active"]').click();
    await page.getByRole("button", { name: "Delay for later: Postpone this conversation", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
});
