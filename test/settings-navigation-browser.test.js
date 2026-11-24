// Disposable real API + browser state. Set CG_BROWSER_MODULE to the installed Playwright module.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("settings categories, targeted search and drafts work at desktop and mobile widths", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const settings = await import("../src/config/settings.js");
  const app = express();
  app.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/settings", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/settings`);
  const search = page.locator("#settings-search");
  const results = page.locator("#settings-results button");
  const nav = page.locator("#settings-nav");
  const navItem = (section) => nav.locator(`[data-sec="${section}"]`);
  const visibleSections = page.locator("#settings-body .setsec:visible");
  await navItem("connection").waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector("#set-max-concurrent-runs")?.value === "8");

  assert.equal(await visibleSections.count(), await nav.locator("[data-sec]").count());
  assert.equal(await page.locator("#settings-category").inputValue(), "connection");
  assert.equal(await navItem("connection").getAttribute("aria-current"), "location");
  const allIds = await nav.locator("[data-sec]").evaluateAll((items) => items.map((el) => el.dataset.sec));
  assert.equal(allIds.length, new Set(allIds).size, "each category appears once");
  assert.equal(allIds.length, await page.locator("#settings-body > .setsec").count());
  const connectionCards = page.locator("#set-connection > details");
  assert.equal(await connectionCards.count(), 3);
  assert.equal(await connectionCards.evaluateAll((cards) => cards.every((el) => !el.open)), true);
  assert.equal(await page.locator("#set-bot").isVisible(), false);
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-connections-desktop.png") });
  const content = await page.locator("#set-connection").boundingBox();
  assert.ok(content.width > 900, `desktop settings width is ${content.width}px`);

  // Reading on from the first category updates the rail without selecting a link.
  await page.locator("#view-settings").evaluate((el) => {
    el.scrollTop += el.querySelector("#set-messaging").getBoundingClientRect().top - el.querySelector("#settings-bar").getBoundingClientRect().bottom;
  });
  await nav.locator('[data-sec="messaging"][aria-current="location"]').waitFor();

  // A query from a different category reaches the exact field inside a closed card.
  await navItem("agent").click();
  await search.fill("slack signing secret");
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-field-search.png") });
  await results.filter({ hasText: /Signing Secret/i }).first().click();
  const signingSecret = page.locator("#set-sign");
  assert.equal(await page.locator("#settings-category").inputValue(), "connection");
  assert.equal(await search.inputValue(), "");
  assert.equal(await signingSecret.evaluate((el) => el === el.ownerDocument.activeElement), true);
  assert.equal(await page.locator("#settings-dirty-msg").textContent(), "All changes saved");
  const draftSecret = "private-fixture-draft-7391";
  await signingSecret.fill(draftSecret);
  await search.fill(draftSecret);
  await page.locator("#settings-no-results").waitFor();
  await page.locator("#settings-no-results-clear").click();
  assert.equal(await signingSecret.inputValue(), draftSecret);
  await signingSecret.fill("");

  // A disabled feature exposes its switch. Search does not silently enable it.
  await search.fill("Gemini API key");
  await results.filter({ hasText: /Gemini API key/i }).first().click();
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-calls-desktop.png") });
  const voice = page.locator("#set-voice-calls-enabled");
  const geminiKey = page.locator("#set-gemini-api-key");
  assert.equal(await page.locator("#settings-category").inputValue(), "calls");
  assert.equal(await page.locator("#set-ios-calls-enabled").isVisible(), true);
  assert.equal(await voice.isChecked(), false);
  assert.equal(await voice.evaluate((el) => el === el.ownerDocument.activeElement), true);
  assert.equal(await geminiKey.isVisible(), false);
  await voice.check();
  assert.equal(await geminiKey.isVisible(), true);
  await voice.uncheck();
  assert.equal(await geminiKey.isVisible(), false);

  await search.fill("Allowed app slugs");
  await results.first().click();
  assert.equal(await page.locator("#set-composio-mode").evaluate((el) => el === el.ownerDocument.activeElement), true);
  assert.equal(await page.locator("#set-composio-mode").inputValue(), "personal");
  // Match a configured gateway with two tall editors among several short cards.
  const mode = page.locator("#set-composio-mode");
  const endpoint = page.locator("#set-composio");
  const drive = page.locator("#set-drivesync-enabled");
  const personalUrl = await endpoint.inputValue();
  await mode.selectOption("sdk");
  assert.equal(await endpoint.isVisible(), false);
  await drive.check();
  const cards = page.locator("#set-integrations > .setcard");
  async function checkLayout(twoFields) {
    const boxes = await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(boxes[i].left, boxes[0].left);
      assert.equal(boxes[i].right, boxes[0].right);
      assert.ok(Math.abs(boxes[i].top - boxes[i - 1].bottom - 12) < 1);
    }
    const interval = await page.locator("#set-drivesync-interval").boundingBox();
    const conflict = await page.locator("#set-drivesync-conflict").boundingBox();
    if (twoFields) assert.ok(conflict.x >= interval.x + interval.width);
    else assert.ok(conflict.y >= interval.y + interval.height);
  }
  await checkLayout(true);
  await navItem("integrations").click();
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-integrations-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkLayout(false);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await drive.uncheck();
  assert.equal(await page.locator("#set-drivesync-interval").isVisible(), false);
  await search.fill("personal-mode Composio MCP URL");
  await results.first().click();
  assert.equal(await mode.evaluate((el) => el === el.ownerDocument.activeElement), true);
  await mode.selectOption("personal");
  assert.equal(await endpoint.inputValue(), personalUrl);
  await search.fill("deprecated legacy key");
  await page.locator("#settings-no-results").waitFor();

  // A provider editor can put a saved credential suffix in a placeholder.
  // Search metadata must exclude it even when the settings index is freshly rebuilt.
  await signingSecret.evaluate((el) => {
    el.placeholder = "masked-fixture-suffix-7649";
    el.after(el.ownerDocument.createComment("simulate an editor repaint"));
  });
  await search.fill("masked-fixture-suffix-7649");
  await page.locator("#settings-no-results").waitFor();
  await search.fill("add trusted bot app ID");
  await results.first().click();
  assert.equal(await page.locator('[aria-label="Add trusted bot app ID"]').evaluate((el) => el === el.ownerDocument.activeElement), true);

  // Two edits survive a category change and a no-results search. One global Save persists both.
  const publicUrl = "https://settings-fixture.example.test";
  await search.fill("public URL");
  await results.filter({ hasText: /externally-reachable/i }).first().click();
  await page.locator("#set-public-url").fill(publicUrl);
  await search.fill("global variables");
  await results.filter({ hasText: "Organization variables" }).click();
  await page.locator("#view-variables.active").waitFor();
  assert.equal(new URL(page.url()).pathname, "/variables");
  await page.goBack();
  await page.locator("#set-public-url").waitFor();
  assert.equal(await page.locator("#set-public-url").inputValue(), publicUrl);
  await navItem("messaging").click();
  assert.equal(await page.locator("#set-mention-reactions").isVisible(), true);
  assert.equal(await page.locator("#set-whisper-enabled").isVisible(), true);
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-messages-desktop.png") });
  assert.equal(await voice.isVisible(), true);
  await page.locator("#set-mention-reactions").fill("rocket");
  await navItem("appearance").click();
  await search.fill("unmatched-fixture-9875");
  await page.locator("#settings-no-results").waitFor();
  await search.press("Escape");
  assert.equal(await page.locator("#settings-category").inputValue(), "appearance");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
  await page.locator("#save-settings").click();
  const response = await saved;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(settings.getPublicUrl(), publicUrl);
  assert.deepEqual(settings.getMentionReactions("slack"), ["rocket"]);

  await page.setViewportSize({ width: 390, height: 844 });
  const picker = page.locator("#settings-category");
  await page.waitForFunction(() => globalThis.document.querySelector("#settings-dirty-msg").textContent === "All changes saved");
  await picker.selectOption("connection");
  assert.equal(await page.locator("#settings-dirty-msg").textContent(), "All changes saved", "changing the mobile category is a navigation action");
  assert.equal(await visibleSections.count(), await nav.locator("[data-sec]").count());
  assert.equal(await page.locator("#settings-category").inputValue(), "connection");
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "settings-connections-mobile.png") });
  await search.fill("Allowed Microsoft drive IDs");
  await search.press("Enter");
  const drivesSwitch = page.locator("#set-teams-files-enabled");
  assert.equal(await drivesSwitch.evaluate((el) => el === el.ownerDocument.activeElement), true);
  assert.equal(await page.locator("#set-teams-file-drives").isVisible(), false);
  await drivesSwitch.check();
  assert.equal(await page.locator("#set-teams-file-drives").isVisible(), true);
  await drivesSwitch.uncheck();
  await search.fill("Google Chat project number");
  await results.filter({ hasText: /project number/i }).first().click();
  assert.equal(await page.locator("#set-gchat-project-number").isVisible(), true);
  assert.equal(await picker.inputValue(), "connection");
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.equal(new URL(page.url()).hash, "#set-gchat-project-number");
  await page.reload();
  await page.locator("#set-gchat-project-number").waitFor();
  assert.equal(new URL(page.url()).hash, "#set-gchat-project-number");
  assert.deepEqual(errors, []);
});
