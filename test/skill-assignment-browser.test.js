// Real admin UI/API acceptance against disposable folder sources and a conversation.
// CG_BROWSER_MODULE=/usr/local/lib/node_modules/playwright/index.mjs node --test test/skill-assignment-browser.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

test("conversation and template skill pickers preserve grants, drafts, filtering and narrow layouts", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  const { getTemplate, upsertTemplate } = await import("../src/gateway/skills/catalog.js");
  const { saveSettings } = await import("../src/config/settings.js");
  const app = express();
  app.use(express.json());
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get(["/conversations/channel/C_SKILL_PICKER", "/skills"], (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sourceIds = [];
  for (const [label, slugs] of [
    ["Alpha assignment source", ["picker-org", "picker-template", "picker-shared", "picker-own"]],
    ["Beta assignment source", ["picker-available", "picker-other"]],
  ]) {
    const dir = tempDir("cg-assignment-browser-");
    for (const slug of slugs) {
      await mkdir(path.join(dir, slug));
      await writeFile(path.join(dir, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: ${slug} browser acceptance fixture.\n---\n\n# ${slug}\n`);
    }
    const response = await fetch(`${base}/api/skills/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "folder", url: dir, label, mode: "auto" }) });
    assert.equal(response.status, 201);
    sourceIds.push((await response.json()).source.id);
  }
  saveSettings({ accessGrants: { skills: ["picker-org"] } });
  upsertTemplate({ slug: "picker-development", name: "Picker Development", skills: ["picker-template", "picker-shared"] });
  upsertTemplate({ slug: "picker-empty", name: "Picker Empty", skills: [] });
  const channelId = "C_SKILL_PICKER";
  const channel = await upsertChannelEntry(channelId, { name: "skill-picker-browser", type: "channel", isDM: false });
  const initialOwn = ["picker-shared", "picker-own", "picker-unavailable"];
  await saveChannelMeta(channel.slug, { ...defaultChannelMeta({ channelId, name: channel.name, type: "channel", isDM: false }), skillTemplate: "picker-development", skills: initialOwn });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const picker = page.locator("#channel-detail .ch-skills");
  const savebar = page.locator("#channel-detail .detail-savebar");
  const openChannel = async () => {
    await page.goto(`${base}/conversations/channel/${channelId}`);
    await page.locator('#channel-detail .subtab[data-pane="skills"]').click();
    await picker.locator("[data-picker-active]").waitFor();
  };
  const saveChannel = async () => {
    const saved = page.waitForResponse((response) => response.url().endsWith(`/channels/${channelId}/meta`) && response.request().method() === "PUT");
    await savebar.locator(".save-channel").click();
    const response = await saved;
    assert.equal(response.status(), 200, await response.text());
    await page.waitForFunction(() => globalThis.document.querySelector("#channel-detail .detail-savebar")?.hidden);
  };
  const screenshot = async (name) => {
    if (!process.env.CG_UI_SCREENSHOTS) return;
    await mkdir(process.env.CG_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, name), fullPage: true });
  };
  await openChannel();
  for (const slug of ["picker-org", "picker-template", "picker-shared"]) {
    assert.equal(await picker.locator(`[data-picker-active] [data-skill="${slug}"]`).count(), 1);
    assert.equal(await picker.locator(`[data-picker-action][data-slug="${slug}"]`).count(), 0, `${slug} is inherited and cannot be added or removed`);
  }
  assert.equal(await picker.getByRole("button", { name: "Remove picker-unavailable", exact: true }).count(), 1);
  await picker.locator("[data-picker-source]").selectOption(`source:${sourceIds[1]}`);
  assert.equal(await picker.locator("[data-picker-active] [data-skill]").count(), 0, "source filter also filters active skills");
  assert.equal(await picker.locator("[data-picker-available] [data-skill]").count(), 2);
  await picker.locator("[data-picker-query]").fill("available");
  assert.equal(await picker.locator("[data-picker-available] [data-skill]").count(), 1);
  assert.equal(await savebar.isHidden(), true, "filtering alone never marks the conversation dirty");
  await picker.getByRole("button", { name: "Add picker-available", exact: true }).click();
  assert.equal(await savebar.isVisible(), true);
  await picker.locator("[data-picker-query]").fill("");
  await picker.locator("[data-picker-source]").selectOption("");
  await picker.getByRole("button", { name: "Remove picker-own", exact: true }).click();
  await page.locator(".ch-skill-template").selectOption("picker-empty");
  assert.equal(await picker.getByRole("button", { name: "Remove picker-shared", exact: true }).count(), 1, "explicit overlap becomes removable after switching away");
  await page.locator(".ch-skill-template").selectOption("picker-development");
  assert.equal(await picker.getByRole("button", { name: "Remove picker-shared", exact: true }).count(), 0);
  await saveChannel();
  const expectedOwn = ["picker-available", "picker-shared", "picker-unavailable"];
  assert.deepEqual((await getChannelMeta(channel.slug)).skills.sort(), expectedOwn);
  await openChannel();
  await screenshot("skill-assignment-desktop.png");
  await page.locator(".ch-skill-template").selectOption("picker-empty");
  assert.equal(await picker.getByRole("button", { name: "Remove picker-shared", exact: true }).count(), 1, "explicit overlapping grant survives save and reload");
  await saveChannel();
  await openChannel();
  assert.equal(await page.locator(".ch-skill-template").inputValue(), "picker-empty");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await picker.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "conversation picker fits a narrow screen");
  await screenshot("skill-assignment-mobile.png");

  // An unavailable metadata read must not overwrite grants during an unrelated change.
  await page.route("**/api/skills/catalog?deleted=1", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture catalog outage" }) }));
  await page.reload();
  await page.locator('#channel-detail .subtab[data-pane="skills"]').click();
  await picker.getByText(/Skill assignments unavailable/).waitFor();
  await page.locator('#channel-detail .subtab[data-pane="runtime"]').click();
  await page.locator(".ch-syncdrive").fill("https://drive.google.com/drive/folders/browser-fixture");
  await saveChannel();
  assert.deepEqual((await getChannelMeta(channel.slug)).skills.sort(), expectedOwn);
  assert.equal((await getChannelMeta(channel.slug)).skillTemplate, "picker-empty");
  await page.unroute("**/api/skills/catalog?deleted=1");

  // Deleting a template leaves existing references in stored channel metadata. The UI must
  // preserve that unavailable link without resubmitting it as a new, invalid assignment.
  await saveChannelMeta(channel.slug, { ...(await getChannelMeta(channel.slug)), skillTemplate: "picker-missing" });
  await openChannel();
  assert.equal(await page.locator(".ch-skill-template").inputValue(), "picker-missing");
  assert.match(await page.locator(".ch-skill-template option:checked").textContent(), /unavailable/);
  await picker.getByRole("button", { name: "Add picker-own", exact: true }).click();
  await page.locator('#channel-detail .subtab[data-pane="runtime"]').click();
  await page.locator(".ch-syncdrive").fill("https://drive.google.com/drive/folders/missing-template-fixture");
  await saveChannel();
  assert.deepEqual((await getChannelMeta(channel.slug)).skills.sort(), [...expectedOwn, "picker-own"].sort());
  assert.equal((await getChannelMeta(channel.slug)).skillTemplate, "picker-missing");
  assert.match((await getChannelMeta(channel.slug)).syncDriveFolder, /missing-template-fixture$/);
  await openChannel();
  assert.equal(await page.locator(".ch-skill-template").inputValue(), "picker-missing");
  await page.locator(".ch-skill-template").selectOption("");
  await saveChannel();
  assert.equal((await getChannelMeta(channel.slug)).skillTemplate, "");
  assert.deepEqual((await getChannelMeta(channel.slug)).skills.sort(), [...expectedOwn, "picker-own"].sort());

  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(`${base}/skills`);
  await page.locator("#skills-summary .stat").first().waitFor();
  await page.locator('.skills-tab[data-tab="templates"]').click();
  await page.locator("#template-select").selectOption("picker-development");
  const templatePicker = page.locator("#template-skills-picker");
  await templatePicker.locator("[data-picker-active]").waitFor();
  await page.locator("#tpl-name").fill("Updated picker development");
  await page.locator("#tpl-desc").fill("Draft description survives skill actions.");
  await templatePicker.locator("[data-picker-source]").selectOption(`source:${sourceIds[1]}`);
  await templatePicker.locator("[data-picker-query]").fill("available");
  await templatePicker.getByRole("button", { name: "Add picker-available", exact: true }).click();
  await templatePicker.locator("[data-picker-query]").fill("");
  await templatePicker.locator("[data-picker-source]").selectOption(`source:${sourceIds[0]}`);
  await templatePicker.getByRole("button", { name: "Remove picker-template", exact: true }).click();
  assert.equal(await page.locator("#tpl-name").inputValue(), "Updated picker development");
  assert.equal(await page.locator("#tpl-desc").inputValue(), "Draft description survives skill actions.");
  const templateSaved = page.waitForResponse((response) => response.url().endsWith("/api/skills/templates") && response.request().method() === "POST");
  await page.locator('[data-action="save-template"]').click();
  assert.equal((await templateSaved).status(), 200);
  assert.deepEqual(getTemplate("picker-development").skills.sort(), ["picker-available", "picker-shared"]);
  await page.reload();
  await page.locator("#skills-summary .stat").first().waitFor();
  await page.locator('.skills-tab[data-tab="templates"]').click();
  await page.locator("#template-select").selectOption("picker-development");
  await templatePicker.locator("[data-picker-active]").waitFor();
  assert.equal(await page.locator("#tpl-name").inputValue(), "Updated picker development");
  assert.equal(await page.locator("#tpl-desc").inputValue(), "Draft description survives skill actions.");
  assert.equal(await templatePicker.locator("[data-picker-active] [data-skill]").count(), 2);
  await screenshot("skill-template-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await templatePicker.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "template picker has no horizontal overflow");
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, "template page fits a narrow screen");
  await screenshot("skill-template-mobile.png");
  assert.deepEqual(errors, []);
});
