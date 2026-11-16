import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser } = await import("../src/config/store.js");
const { saveCallHistory } = await import("../src/gateway/voice/history.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");

test("Calls page renders, expands, retries and paginates safely in Chromium", { skip: !process.env.CG_BROWSER_MODULE, timeout: 60_000 }, async (t) => {
  resetActivityStateForTests(); getDb().exec("DELETE FROM voice_calls");
  await setUser("U_HISTORY", { approved: true });
  let base;
  const app = express();
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "T_HISTORY", getBaseUrl: () => base, voiceAvailable: () => false }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const problems = []; page.on("pageerror", (error) => problems.push(error.message));
  const grant = createActivityGrantUrl({ baseUrl: base, ownerId: "U_HISTORY", teamId: "T_HISTORY" });
  const response = await context.request.post(base + "/activity/exchange", { headers: { Origin: base }, data: { token: new URL(grant).hash.slice(1) } });
  assert.equal(response.status(), 200);
  const { url } = await response.json();
  await page.goto(base + url + "/calls");
  await page.getByRole("status").filter({ hasText: "No calls recorded yet" }).waitFor();
  const startedMs = Date.now();
  for (let i = 0; i < 31; i++) saveCallHistory({ id: "browser-" + i, ownerId: "U_HISTORY", teamId: "T_HISTORY",
    startedMs: startedMs + i, endedMs: startedMs + 65000, durationMs: 65000, costUSD: 0.0123, model: "gemini-3.8-live",
    summary: "Discussed a project.\n<script>globalThis.pwned=true</script>", reason: "the caller hung up",
    threads: [{ channelId: "C_WORK", channelName: "#project", threadTs: "100.000001", messageTs: "100.000002", title: "Planning <img src=x>", durationMs: 65000 }] });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelectorAll(".call-history-card").length === 30);
  const first = page.locator(".call-history-card").first();
  assert.match(await first.locator("summary").textContent(), /1m 5s.*~\$0\.0123 voice.*1 thread/);
  let failedDetail = false;
  await page.route("**/api/calls/browser-30", async (route) => {
    if (!failedDetail) { failedDetail = true; await route.fulfill({ status: 503, body: "{}", contentType: "application/json" }); }
    else await route.continue();
  });
  await first.locator("summary").click();
  await first.getByRole("button", { name: "Retry summary" }).click();
  await first.getByRole("heading", { name: "Threads visited" }).waitFor();
  assert.match(await first.locator(".call-history-summary").textContent(), /<script>/);
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
  const link = first.getByRole("link");
  assert.equal(await link.getAttribute("href"), url + "/calls/browser-30/thread/0");
  assert.equal(await first.locator("img").count(), 0);
  let failOlder = true;
  await page.route("**/api/calls?before=*", async (route) => {
    if (failOlder) { failOlder = false; await route.fulfill({ status: 503, body: "{}", contentType: "application/json" }); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Load older calls" }).click();
  await page.getByRole("status").filter({ hasText: "Couldn’t load call history" }).waitFor();
  assert.equal(await page.locator(".call-history-card").count(), 30);
  await page.getByRole("button", { name: "Load older calls" }).click();
  await page.waitForFunction(() => globalThis.document.querySelectorAll(".call-history-card").length === 31);
  assert.equal(await page.getByRole("button", { name: "Load older calls" }).isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  await page.reload();
  await page.waitForFunction(() => globalThis.document.querySelectorAll(".call-history-card").length === 30);
  assert.deepEqual(problems, []);
});
