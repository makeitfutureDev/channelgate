import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread, recordSlackThreadParticipation } = await import("../src/gateway/slack-threads.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");

for (const width of [1440, 390]) {
  test(`shared Done remains visible to participants and dismissal stays personal at ${width}px`, { skip: !process.env.CG_BROWSER_MODULE, timeout: 40_000 }, async (t) => {
    const owner = `UDONEOWNER${width}`, participant = `UDONEVIEWER${width}`, channelId = `C_SHARED_DONE_${width}`, threadTs = "100.000001";
    resetActivityStateForTests();
    for (const userId of [owner, participant]) await setUser(userId, { approved: true });
    await upsertChannelEntry(channelId, { name: "Shared completion", type: "channel" });
    const entry = await getChannelEntry(channelId);
    await saveChannelMeta(entry.slug, { access: "approved" });
    const root = { ts: threadTs, user: owner, text: `Shared conversation ${width}` };
    indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
    recordSlackThreadParticipation(channelId, threadTs, participant, "101.000001");
    const client = { conversations: { replies: async () => ({ messages: [root] }) } };
    const app = express(); let base;
    app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "TSHAREDDONE", getBaseUrl: () => base }));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
    const { chromium } = await import(process.env.CG_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
    t.after(() => browser.close());
    const errors = [];
    const pages = [];
    for (const ownerId of [owner, participant]) {
      // Separate cookie jars prove that completion/hiding are attributed to the acting person.
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TSHAREDDONE" }));
      await page.getByRole("link", { name: root.text, exact: true }).waitFor();
      pages.push(page);
    }
    const [mine, theirs] = pages;
    const action = (page, name) => page.getByRole("button", { name: `${name}: ${root.text}`, exact: true });
    const filter = (page, value) => page.locator(`#filters button[data-filter="${value}"]`);
    const empty = (page) => page.waitForFunction(() => !globalThis.document.querySelector("#threads tr, #pinned-threads tr"));
    const visible = (page) => page.getByRole("link", { name: root.text, exact: true }).waitFor();
    const noOverflow = async (page) => assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `${width}px page has no horizontal overflow`);
    const sharedDone = async (page, section) => {
      const row = page.locator(`${section} tr.s-done`);
      await row.waitFor();
      assert.equal(await row.locator(".pill.done").textContent(), "Done");
      const colors = await row.evaluate((element) => {
        const green = (color) => { const [r, g, b] = color.match(/[\d.]+/g).map(Number); return g > r && g > b; };
        return {
          title: green(globalThis.getComputedStyle(element.querySelector(".thread-title")).color),
          pill: green(globalThis.getComputedStyle(element.querySelector(".pill.done")).color),
        };
      });
      assert.deepEqual(colors, { title: true, pill: true }, "shared completion is visibly green");
      await noOverflow(page);
    };

    assert.equal(await action(theirs, "Mark done").isVisible(), false, "participant cannot complete the owner's conversation");
    await action(mine, "Pin").click();
    await mine.locator("#pinned-threads tr").waitFor();
    await action(mine, "Mark done").click();
    await empty(mine);
    assert.equal(await filter(mine, "active").locator("span").textContent(), "0");
    await noOverflow(mine);
    await sharedDone(theirs, "#threads");
    assert.equal(await filter(theirs, "active").getAttribute("aria-pressed"), "true");
    assert.equal(await filter(theirs, "active").locator("span").textContent(), "1");
    assert.equal(await action(theirs, "Reopen").isVisible(), false);
    assert.equal(await action(theirs, "Mark done").isVisible(), false);

    await filter(mine, "done").click();
    await action(mine, "Reopen").waitFor();
    await sharedDone(mine, "#threads");
    await action(theirs, "Pin").click();
    await sharedDone(theirs, "#pinned-threads");
    await action(theirs, "Hide").click();
    await empty(theirs);
    assert.equal(await filter(theirs, "active").locator("span").textContent(), "0");
    await action(mine, "Reopen").waitFor();
    assert.equal(await filter(mine, "done").locator("span").textContent(), "1", "participant Hide leaves the owner's Completed entry intact");

    // Reopen restores the owner's automatic dismissal, but keeps the participant's manual Hide.
    await action(mine, "Reopen").click();
    await mine.locator("#pinned-threads tr:not(.s-done)").waitFor();
    await filter(mine, "active").click();
    await mine.locator("#pinned-threads tr:not(.s-done)").waitFor();
    await action(mine, "Mark done").waitFor();
    await empty(theirs);
    await theirs.reload();
    await filter(theirs, "hidden").click();
    await action(theirs, "Show").waitFor();
    await theirs.locator("#threads tr:not(.s-done)").waitFor();
    await noOverflow(theirs);
    recordSlackThreadParticipation(channelId, threadTs, owner, (Date.now() / 1000 + 1).toFixed(6));
    await action(theirs, "Show").waitFor();
    assert.equal(await filter(theirs, "active").locator("span").textContent(), "0", "another person's message cannot undo manual Hide");
    // This function is the authorized human-message ingress, as in the participant browser fixture.
    recordSlackThreadParticipation(channelId, threadTs, participant, (Date.now() / 1000 + 2).toFixed(6));
    await empty(theirs);
    await filter(theirs, "active").click();
    await theirs.locator("#pinned-threads tr:not(.s-done)").waitFor();
    await visible(mine);
    assert.equal(await action(theirs, "Mark done").isVisible(), false);
    await noOverflow(mine);
    await noOverflow(theirs);
    assert.deepEqual(errors, []);
  });
}
