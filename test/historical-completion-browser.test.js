import { selectActivityFilter } from "./activity-browser-controls.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { indexSlackThread } = await import("../src/gateway/slack-threads.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");
for (const width of [1440, 390]) test(`historical own check leaves Active while another actor's Done stays green at ${width}px`, { skip: !process.env.CG_BROWSER_MODULE, timeout: 30_000 }, async (t) => {
  resetActivityStateForTests();
  const userId = `UHISTORICAL${width}`, other = `UOTHERHISTORY${width}`, channelId = `C_HISTORY_${width}`;
  for (const id of [userId, other]) await setUser(id, { approved: true });
  await upsertChannelEntry(channelId, { name: "Historical completion", type: "channel" });
  const entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  const roots = [
    { ts: "100.000001", user: userId, text: "I closed this before the upgrade", reactions: [{ name: "white_check_mark", count: 1, users: [userId] }] },
    { ts: "101.000001", user: userId, text: "Someone else closed this", reactions: [{ name: "white_check_mark", count: 1, users: [other] }] },
    { ts: "102.000001", user: userId, text: "Legacy gateway-marked closed thread", reactions: [{ name: "white_check_mark", count: 1, users: ["UGATEWAYHISTORY"] }] },
  ];
  for (const root of roots) indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  getDb().prepare("UPDATE slack_thread_participants SET historical_completion_checked=0 WHERE channel_id=?").run(channelId);
  const client = { conversations: { replies: async ({ ts }) => ({ messages: [roots.find(root => root.ts === ts)] }) }, auth: { test: async () => ({ user_id: "UGATEWAYHISTORY" }) } };
  const app = express(); let base;
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "THISTORY", getBaseUrl: () => base }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId: userId, teamId: "THISTORY" }));
  await page.getByRole("link", { name: roots[1].text, exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: roots[0].text, exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: roots[2].text, exact: true }).count(), 0);
  assert.equal(await page.locator("#threads tr.s-done").count(), 1);
  await page.reload();
  await page.getByRole("link", { name: roots[1].text, exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: roots[0].text, exact: true }).count(), 0);
  await selectActivityFilter(page, "done");
  await page.getByRole("link", { name: roots[0].text, exact: true }).waitFor();
  await page.getByRole("link", { name: roots[2].text, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
});
