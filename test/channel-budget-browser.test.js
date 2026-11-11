// Disposable browser acceptance for channel monthly budgets.
// In the shipped image, follow TEST-PLAN.md's Browser acceptance runner with this test path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv, tempDir, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
testLicenseEnv();

test("monthly USD budgets persist values and explain cost boundaries in channel and DM help", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const root = tempDir("cg-workspace-browser-");
  process.env.CG_FS_ROOT = root;
  const shared = path.join(root, "shared-project");
  const separate = path.join(root, "separate-project");
  const unused = path.join(root, "unused-project");
  await Promise.all([mkdir(shared), mkdir(separate), mkdir(unused)]);

  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry, getChannelMeta, getChannelEntry } = await import("../src/config/store.js");
  const add = async (channelId, name, workDir) => {
    const entry = await upsertChannelEntry(channelId, { name, type: "channel", isDM: false, platform: "slack" });
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name, type: "channel", isDM: false, platform: "slack" }), workDir });
  };
  await add("C_FOLDER_WARNING_A", "folder-warning-a", shared);
  await add("C_FOLDER_WARNING_B", "folder-warning-b", shared);
  await add("C_FOLDER_WARNING_CONTROL", "folder-warning-control", separate);
  const dm = await upsertChannelEntry("D_BUDGET_HELP", { name: "budget-help-dm", type: "im", isDM: true });
  await saveChannelMeta(dm.slug, defaultChannelMeta({ channelId: "D_BUDGET_HELP", name: "budget-help-dm", type: "im", isDM: true }));

  const app = express();
  app.use(express.json());
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BUDGET_ADMIN" }, passkeys: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.get("/api/channels/:channelId/members", (_req, res) => res.json({ members: [] }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/conversations/channel/:channelId", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  app.get("/conversations/dm/:channelId", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15_000);
  // The fixture targets folder warnings, not the daemon-wide live-session feed. Disabling SSE
  // avoids a deliberately open stream producing teardown noise in the console-error assertion.
  await page.addInitScript(() => Object.defineProperty(globalThis, "EventSource", { value: undefined }));
  const errors = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const source = message.location().url;
    errors.push(`${message.text()}${source ? ` (${source})` : ""}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/C_FOLDER_WARNING_A`);


  await page.locator('#channel-detail .subtab[data-pane="runtime"]').click();
  const input = page.locator('#channel-detail .ch-monthly-spending-limit');
  await input.waitFor();
  const assertBudgetHelp = async (field) => {
    const label = field.locator('..');
    await label.getByText(/recorded/i).last().waitFor();
    const help = (await label.innerText()).replace(/\s+/g, ' ');
    assert.match(help, /UTC/);
    assert.match(help, /recorded/i);
    assert.match(help, /runs may exceed/i);
    assert.match(help, /unpriced usage/i);
    assert.match(help, /external service charges are excluded/i);
    assert.doesNotMatch(help, /guaranteed cancellation|exact prepaid/i);
  };
  await assertBudgetHelp(input);
  assert.equal(await input.inputValue(), '');
  for (const [value, expected] of [['12.34', 12.34], ['', null]]) {
    await input.fill(value);
    const saved = page.waitForResponse(r => r.url().endsWith('/channels/C_FOLDER_WARNING_A/meta') && r.request().method() === 'PUT');
    await page.locator('#channel-detail .save-channel').click();
    assert.equal((await saved).status(), 200);
    assert.equal((await getChannelMeta((await getChannelEntry('C_FOLDER_WARNING_A')).slug)).monthlySpendingLimitUSD, expected);
    await page.reload();
    await page.locator('#channel-detail .subtab[data-pane="runtime"]').click();
    await input.waitFor();
    assert.equal(await input.inputValue(), value);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await input.isVisible(), true);
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/dm/D_BUDGET_HELP`);
  const dmInput = page.locator('#channel-detail .dm-budget');
  await dmInput.waitFor();
  await assertBudgetHelp(dmInput);
  assert.deepEqual(errors, []);
});
