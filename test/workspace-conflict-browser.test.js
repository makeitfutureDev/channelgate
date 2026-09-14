// Real browser acceptance for duplicate working-folder warnings.
// CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test test/workspace-conflict-browser.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

test("duplicate conversation rows and used folders render red warnings that clear after save", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const root = tempDir("cg-workspace-browser-");
  process.env.CG_FS_ROOT = root;
  const shared = path.join(root, "shared-project");
  const separate = path.join(root, "separate-project");
  const unused = path.join(root, "unused-project");
  await Promise.all([mkdir(shared), mkdir(separate), mkdir(unused)]);

  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
  const add = async (channelId, name, workDir) => {
    const entry = await upsertChannelEntry(channelId, { name, type: "channel", isDM: false, platform: "slack" });
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name, type: "channel", isDM: false, platform: "slack" }), workDir });
  };
  await add("C_FOLDER_WARNING_A", "folder-warning-a", shared);
  await add("C_FOLDER_WARNING_B", "folder-warning-b", shared);
  await add("C_FOLDER_WARNING_CONTROL", "folder-warning-control", separate);

  const app = express();
  app.use(express.json());
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/conversations/channel/:channelId", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/C_FOLDER_WARNING_A`);

  const warningRows = page.locator("#channel-list .workdir-conflict");
  await warningRows.first().waitFor();
  assert.equal(await warningRows.count(), 2);
  assert.deepEqual(await warningRows.locator(".conv-nm b").allTextContents(), ["#folder-warning-a", "#folder-warning-b"]);
  assert.equal(await page.locator('#channel-list a[href="/conversations/channel/C_FOLDER_WARNING_CONTROL"]').getAttribute("class"), "list-item conv-item");

  await page.locator('#channel-detail .subtab[data-pane="runtime"]').click();
  await page.locator("#channel-detail .ch-browse").click();
  const folderWarning = page.locator("#fs-conflict");
  await folderWarning.waitFor();
  assert.match(await folderWarning.textContent(), /Already assigned to #folder-warning-b/);
  assert.doesNotMatch(await folderWarning.textContent(), /folder-warning-a/);

  await page.locator("#fs-home").click();
  await page.waitForFunction((expected) => globalThis.document.querySelector("#fs-current")?.textContent === expected, root);
  await page.locator("#fs-list .fs-item", { hasText: "separate-project" }).click();
  await page.waitForFunction((expected) => globalThis.document.querySelector("#fs-current")?.textContent === expected, separate);
  assert.match(await folderWarning.textContent(), /Already assigned to #folder-warning-control/);
  await page.locator("#fs-home").click();
  await page.waitForFunction((expected) => globalThis.document.querySelector("#fs-current")?.textContent === expected, root);
  await page.locator("#fs-list .fs-item", { hasText: "unused-project" }).click();
  await page.waitForFunction((expected) => globalThis.document.querySelector("#fs-current")?.textContent === expected, unused);
  assert.equal(await folderWarning.isHidden(), true);

  await page.locator("#fs-select").click();
  const saved = page.waitForResponse((response) => response.url().endsWith("/channels/C_FOLDER_WARNING_A/meta") && response.request().method() === "PUT");
  await page.locator("#channel-detail .save-channel").click();
  assert.equal((await saved).status(), 200);
  await page.waitForFunction(() => globalThis.document.querySelectorAll("#channel-list .workdir-conflict").length === 0);
  assert.deepEqual(errors, []);
});
