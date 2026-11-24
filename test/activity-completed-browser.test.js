import { selectActivityFilter } from "./activity-browser-controls.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");

for (const width of [1440, 390]) {
  test(`Completed is ungrouped and newest-completion first at ${width}px`, { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
    const make = (title, channelId, completedMs, lastMessageMs, extra = {}) => ({ title, channelId,
      threadTs: String(completedMs), channelName: channelId, status: "done", completedMs,
      lastMessageMs, url: "", comment: "", dismissed: true, ...extra });
    let rows = [make("Older completion", "C1", 100, 9000, { pinned: true, dismissed: false }),
      make("Latest completion", "C2", 300, 1000), make("Middle completion", "C1", 200, 5000)];
    const snapshot = () => ({ rows, groupBy: "channel", groupByVersion: 1,
      pinnedChannels: [{ channelId: "C1", channelName: "Pinned channel" }] });
    const streams = new Set();
    const app = express();
    app.get("/activity/fixture", (_req, res) => res.type("html").send(activityPage({ sessionId: "fixture", csrf: "fixture" }).html));
    app.get("/activity/fixture/api/threads", (_req, res) => res.json(snapshot()));
    app.get("/activity/fixture/stream", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`event: threads\ndata: ${JSON.stringify(snapshot())}\n\n`);
      streams.add(res); req.on("close", () => streams.delete(res));
    });
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const { chromium } = await import(process.env.CG_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/activity/fixture`);
    await selectActivityFilter(page, "done");
    const titles = page.locator("#threads .thread-title");
    await titles.first().waitFor();
    assert.equal(await page.locator("#group-by").inputValue(), "none");
    assert.deepEqual(await titles.allTextContents(), ["Latest completion", "Middle completion", "Older completion"]);
    assert.equal(await page.locator("#threads tr[data-group]").count(), 0);
    assert.equal(await page.locator("#pinned-section").isVisible(), false);
    rows = rows.map(row => row.title === "Older completion" ? { ...row, completedMs: 400 } : row);
    for (const stream of streams) stream.write(`event: threads\ndata: ${JSON.stringify(snapshot())}\n\n`);
    await page.waitForFunction(() => globalThis.document.querySelector("#threads .thread-title")?.textContent === "Older completion");
    await page.locator("#group-by").selectOption("channel");
    await selectActivityFilter(page, "active");
    assert.equal(await page.locator("#group-by").inputValue(), "channel");
    await page.reload(); await selectActivityFilter(page, "done"); await titles.first().waitFor();
    assert.equal(await page.locator("#group-by").inputValue(), "none");
    assert.deepEqual(await titles.allTextContents(), ["Older completion", "Latest completion", "Middle completion"]);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    assert.deepEqual(errors, []);
  });
}
