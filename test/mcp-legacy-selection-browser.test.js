import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("unrelated admin saves retain unavailable MCP selections and removals cannot restore them", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { saveSettings } = await import("../src/config/settings.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  const { catalogFromClaudeList } = await import("../src/gateway/mcp-discovery.js");
  const original = { name: "credentialed", namespace: "mcp__credentialed", match: { serverName: "credentialed" } };
  writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ mcpServers: {
    credentialed: { command: "node", args: ["fixture-echo.mjs"], env: { TOKEN: "test-private-mcp-value" } },
  } }));
  const catalog = await catalogFromClaudeList("credentialed: node fixture-echo.mjs - ✓ Connected");
  assert.equal(catalog[0].selectable, false);
  assert.equal(catalog[0].match, undefined, "unavailable catalog intentionally redacts transport references");
  saveSettings({ engineEnabled: { claude: true, codex: true }, engineFallback: false });
  const app = express();
  app.use(express.json());
  app.get("/api/mcp/available", (req, res) => res.json({ servers: req.query.engine === "claude" ? catalog : [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/conversations/channel/:id", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const engine of ["claude", "codex"]) {
    const id = `C_MCP_LEGACY_${engine.toUpperCase()}`;
    const entry = await upsertChannelEntry(id, { name: `mcp-legacy-${engine}`, type: "channel", isDM: false });
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name: entry.name, type: "channel", isDM: false }), engine, allowedMcps: [original], allowedCodexMcps: [], allowNetwork: false });
    await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${id}`);
    await page.locator('[data-pane="mcps"].subtab').click();
    const selected = page.locator('.ch-mcps input[data-mcp-engine="claude"][value="credentialed"]');
    await selected.waitFor();
    assert.equal(await selected.isChecked(), true);
    assert.equal(await selected.isDisabled(), false, "legacy selection remains removable");
    assert.ok(!(await page.locator(".ch-mcps").innerText()).includes("test-private-mcp-value"));
    const save = async () => {
      const pending = page.waitForResponse((r) => r.url().endsWith(`/channels/${id}/meta`) && r.request().method() === "PUT");
      await page.locator(".save-channel").click();
      const response = await pending;
      assert.equal(response.status(), 200, await response.text());
      await page.locator(".detail-savebar .msg").filter({ hasText: /^Saved$/ }).waitFor();
      return response.request().postDataJSON();
    };
    await page.locator('[data-pane="runtime"].subtab').click();
    await page.locator(".ch-memory").setChecked(!(await page.locator(".ch-memory").isChecked()));
    const body = await save();
    assert.deepEqual(body.allowedMcps, [original], `${engine} unrelated save round-trips the exact saved reference`);
    assert.deepEqual((await getChannelMeta(entry.slug)).allowedMcps, [original]);
    assert.equal((await getChannelMeta(entry.slug)).engine, engine);
    assert.deepEqual((await getChannelMeta(entry.slug)).allowedCodexMcps, []);
    await page.locator('[data-pane="mcps"].subtab').click();
    await selected.uncheck();
    await save();
    assert.deepEqual((await getChannelMeta(entry.slug)).allowedMcps, []);
    assert.equal(await selected.isDisabled(), true, "committed removal refreshes the original selection and disables unavailable re-add");
    await page.locator('[data-pane="runtime"].subtab').click();
    await page.locator(".ch-memory").setChecked(!(await page.locator(".ch-memory").isChecked()));
    assert.deepEqual((await save()).allowedMcps, [], "later saves cannot resurrect removed originals");
    const rejected = await page.evaluate(async ({ id, original }) => {
      const r = await fetch(`/api/channels/${id}/meta`, { method: "PUT", headers: { "content-type": "application/json", "X-CG-Request": "1" }, body: JSON.stringify({ allowedMcps: [original] }) });
      return { status: r.status, body: await r.json() };
    }, { id, original });
    assert.equal(rejected.status, 400, "backend still rejects a newly added unavailable reference");
    assert.ok(!JSON.stringify(rejected).includes("test-private-mcp-value"));
    assert.deepEqual((await getChannelMeta(entry.slug)).allowedMcps, []);
  }
  assert.deepEqual(errors, []);
});
