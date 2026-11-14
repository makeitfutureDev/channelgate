import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, getUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread } = await import("../src/gateway/slack-threads.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");

// The real page, CSP and stylesheet in Chromium: the Comment column saves, a header drag
// reorders every row, an edge drag resizes, and the layout survives a reload.
test("Activity columns move, resize and keep comments in a real browser", { skip: !process.env.CG_BROWSER_MODULE, timeout: 60_000 }, async (t) => {
  resetActivityStateForTests();
  const ownerId = "UACTIVITYCOLS", channelId = "C_ACTIVITY_COLS";
  await setUser(ownerId, { approved: true, activityGroupBy: "status" });
  await upsertChannelEntry(channelId, { name: "Columns fixture", type: "channel" });
  const entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  const roots = [{ ts: "100.000001", user: ownerId, text: "First columns fixture" }, { ts: "100.000002", user: ownerId, text: "Second columns fixture" }];
  for (const root of roots) indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  const client = { conversations: { replies: async ({ ts }) => ({ messages: [roots.find((root) => root.ts === ts)] }) } };
  let base;
  const app = express();
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "TCOLS", getBaseUrl: () => base,
    snapshot: async () => ({ rows: roots.map((root, index) => ({ channel_id: channelId, thread_ts: root.ts, title: root.text,
      channelName: "Columns fixture", status: index ? "idle" : "waiting", last_message_ms: Date.now() - index * 60_000 })), total: roots.length }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(5000);
  const problems = [];
  // Subscription usage has no provider in this fixture (503); anything else, or any CSP refusal, fails.
  page.on("console", (message) => { if (message.type() === "error" && !/status of 503/.test(message.text())) problems.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/api/subscriptions")) problems.push(response.status() + " " + response.url()); });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TCOLS" }));
  await page.getByRole("link", { name: "Open in Slack: First columns fixture", exact: true }).waitFor();
  const headers = () => page.$$eval("#table thead th", (cells) => cells.map((cell) => cell.dataset.col));
  const rowCells = () => page.$$eval("#threads tr:first-child td", (cells) => cells.map((cell) => cell.className));
  assert.deepEqual(await headers(), ["conversation", "comment", "channel", "status", "last", "actions"]);
  assert.deepEqual(await rowCells(), ["thread-cell", "comment-cell", "channel-cell", "status-cell", "time-cell", "actions"]);
  // Every header sits over its own column.
  const aligned = () => page.evaluate(() => {
    const ths = [...globalThis.document.querySelectorAll("#table thead th")], tds = [...globalThis.document.querySelectorAll("#threads tr:first-child td")];
    return ths.every((th, index) => Math.abs(th.getBoundingClientRect().left - tds[index].getBoundingClientRect().left) < 1.5);
  });
  assert.equal(await aligned(), true);

  // Comment: Enter saves it to the viewer's account.
  const comment = page.getByRole("textbox", { name: "Comment on: First columns fixture" });
  await comment.fill("Waiting for Ana");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/comment"));
  await comment.press("Enter");
  assert.equal((await saved).status(), 200);
  assert.deepEqual((await getUser(ownerId)).activityComments, { [JSON.stringify([channelId, roots[0].ts])]: "Waiting for Ana" });

  // Resize: drag the Conversation edge 150px narrower.
  const handle = page.locator('#table th[data-col="conversation"] .col-resize');
  const before = (await page.locator('#table th[data-col="conversation"]').boundingBox()).width;
  const box = await handle.boundingBox();
  const resized = page.waitForResponse((response) => response.url().endsWith("/api/columns"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 75, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal((await resized).status(), 200);
  const after = (await page.locator('#table th[data-col="conversation"]').boundingBox()).width;
  assert.ok(Math.abs(before - 150 - after) < 3, `resized from ${before} to ${after}`);
  assert.equal(await aligned(), true, "rows follow a resized header");
  assert.equal((await getUser(ownerId)).activityColumns.widths.conversation, Math.round(after));

  // Reorder: drop Status onto the left half of Conversation.
  const moved = page.waitForResponse((response) => response.url().endsWith("/api/columns"));
  const target = await page.locator('#table th[data-col="conversation"]').boundingBox();
  await page.locator('#table th[data-col="status"] .col-label').dragTo(page.locator('#table th[data-col="conversation"]'), { targetPosition: { x: 4, y: target.height / 2 } });
  assert.equal((await moved).status(), 200);
  const order = ["status", "conversation", "comment", "channel", "last", "actions"];
  assert.deepEqual(await headers(), order);
  assert.deepEqual(await page.$$eval("#pinned-table thead th", (cells) => cells.map((cell) => cell.dataset.col)), order, "both tables share the layout");
  assert.deepEqual(await rowCells(), ["status-cell", "thread-cell", "comment-cell", "channel-cell", "time-cell", "actions"]);
  assert.equal(await aligned(), true);

  // A reload restores the comment, the order and the width.
  await page.reload();
  await page.locator("#result-count").filter({ hasText: "2 conversations" }).waitFor().catch(async (error) => {
    throw new Error(error.message + "\n" + page.url() + "\n" + (await page.locator("body").innerText()).slice(0, 600));
  });
  await comment.waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector("#table thead th")?.dataset.col === "status");
  assert.equal(await comment.inputValue(), "Waiting for Ana");
  assert.ok(Math.abs((await page.locator('#table th[data-col="conversation"]').boundingBox()).width - after) < 2);
  assert.equal(await aligned(), true);

  // Double-click resets a width; the Columns dialog resets everything.
  const reset = page.waitForResponse((response) => response.url().endsWith("/api/columns"));
  await handle.dblclick();
  assert.equal((await reset).status(), 200);
  assert.deepEqual((await getUser(ownerId)).activityColumns.widths, {});
  await page.getByRole("button", { name: "▤ Columns" }).click();
  await page.getByRole("button", { name: "Reset order and widths" }).click();
  const dialogSave = page.waitForResponse((response) => response.url().endsWith("/api/columns"));
  await page.getByRole("button", { name: "Save columns" }).click();
  assert.equal((await dialogSave).status(), 200);
  assert.deepEqual(await headers(), ["conversation", "comment", "channel", "status", "last", "actions"]);

  // Phones keep the stacked card layout and still show the comment field without overflow.
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.equal(await comment.isVisible(), true);
  assert.deepEqual(problems, []);
  await page.close();
});
