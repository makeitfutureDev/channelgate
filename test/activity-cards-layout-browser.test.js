import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread } = await import("../src/gateway/slack-threads.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");

const ORDER = ["conversation", "comment", "channel", "status", "last", "actions"];

// Grouped by channel, every cell stays inside its card, sits under its own header, and the
// card's heading band spans the card, whatever widths the viewer saved.
test("Activity channel cards keep their cells inside the card and under their headers", { skip: !process.env.CG_BROWSER_MODULE, timeout: 90_000 }, async (t) => {
  resetActivityStateForTests();
  const ownerId = "UACTIVITYCARDS", rows = [];
  for (const [channelId, name] of [["C_CARDS_ONE", "cards-one"], ["C_CARDS_TWO", "cards-two"]]) {
    await upsertChannelEntry(channelId, { name, type: "channel" });
    const entry = await getChannelEntry(channelId);
    await saveChannelMeta(entry.slug, { access: "approved" });
    for (let index = 0; index < 3; index++) {
      const root = { ts: `20${index}.0000${channelId.length}${index}`, user: ownerId, text: `Card fixture ${index} in ${name}` };
      indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
      rows.push({ channel_id: channelId, thread_ts: root.ts, title: root.text, starter_id: ownerId, channelName: name,
        status: index ? "idle" : "waiting", last_message_ms: Date.now() - index * 3_600_000 });
    }
  }
  let base;
  const app = express();
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.use("/activity", createActivityRouter({ getClient: () => ({ conversations: { replies: async () => ({ messages: [] }) } }),
    getTeamId: () => "TCARDS", getBaseUrl: () => base, voiceAvailable: () => true, snapshot: async () => ({ rows, total: rows.length }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());

  const layout = async ({ widths, viewport, groupBy = "channel" }) => {
    await setUser(ownerId, { approved: true, activityGroupBy: groupBy, activityColumns: { order: ORDER, widths } });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TCARDS" }));
    await page.locator("#threads tr[data-group]").first().waitFor();
    const result = await page.evaluate(() => {
      const box = (node) => node.getBoundingClientRect();
      const ths = [...globalThis.document.querySelectorAll("#table thead th")];
      return [...globalThis.document.querySelectorAll("#threads tr")].map((tr) => {
        const card = box(tr), tds = [...tr.querySelectorAll("td")];
        const heading = globalThis.getComputedStyle(tr, "::before"); // content-box: the universal border-box rule skips pseudo-elements
        const band = tr.dataset.group === undefined ? null : ["width", "paddingLeft", "paddingRight"].reduce((sum, key) => sum + Number.parseFloat(heading[key]), 0);
        return {
          inside: tds.every((td) => box(td).left >= card.left && box(td).right <= card.right),
          aligned: tds.every((td, index) => Math.abs(box(td).left - box(ths[index]).left) < 1.5 && Math.abs(box(td).right - box(ths[index]).right) < 1.5),
          bandSpansCard: band === null || Math.abs(band - tr.clientWidth) < 1.5,
        };
      });
    });
    await context.close();
    return result;
  };
  const cases = [
    { name: "default widths", widths: {}, viewport: { width: 1440, height: 900 } },
    { name: "a column wider than the viewport", widths: { conversation: 900 }, viewport: { width: 1440, height: 900 } },
    { name: "every flexible column resized narrow", widths: { conversation: 300, comment: 120, channel: 100 }, viewport: { width: 1440, height: 900 } },
    { name: "a narrow desktop window", widths: {}, viewport: { width: 760, height: 900 } },
    { name: "status grouping with fixed columns", widths: { conversation: 300, comment: 120, channel: 100 }, viewport: { width: 1440, height: 900 }, groupBy: "status" },
  ];
  for (const testCase of cases) {
    const measured = await layout(testCase);
    assert.ok(measured.length > 0, testCase.name);
    for (const row of measured) {
      assert.equal(row.inside, true, `${testCase.name}: every cell stays inside its row`);
      assert.equal(row.aligned, true, `${testCase.name}: every cell sits under its header`);
      assert.equal(row.bandSpansCard, true, `${testCase.name}: the group heading spans the row`);
    }
  }
});
