import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("channel runtime picker offers enabled providers and preserves their pins on unrelated saves", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { saveSettings } = await import("../src/config/settings.js");
  const { QWEN_PROVIDERS } = await import("../src/engines/qwen.js");
  const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
  saveSettings({
    engineEnabled: { claude: true, codex: true, qwen: true, "qwen-eu": true, opencode: false },
    ...Object.fromEntries(QWEN_PROVIDERS.flatMap((provider) => [
      [provider.settings.apiKey, `qa-picker-${provider.id}-dummy-key`],
      [provider.settings.baseUrl, `https://${provider.id}.example/anthropic`],
    ])),
  });
  const channels = [];
  for (const [index, provider] of QWEN_PROVIDERS.entries()) {
    const channelId = `C_PROVIDER_PICKER_${index}`;
    const entry = await upsertChannelEntry(channelId, { name: `provider-picker-${index}`, type: "channel", isDM: false });
    await saveChannelMeta(entry.slug, {
      ...defaultChannelMeta({ channelId, name: entry.name, type: "channel", isDM: false }),
      engine: provider.id, model: provider.models[0].value, allowNetwork: false,
    });
    channels.push({ channelId, entry, provider });
  }
  const app = express();
  app.use(express.json());
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/conversations/channel/:id", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const { channelId, entry, provider } of channels) {
    await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${channelId}`);
    await page.locator('[data-pane="runtime"].subtab').click();
    const engine = page.locator(".ch-engine");
    const offered = await engine.locator("option").evaluateAll((options) => options.map((option) => option.value));
    for (const id of ["", "claude", "codex", ...QWEN_PROVIDERS.map((p) => p.id)]) assert.ok(offered.includes(id), `enabled ${id || "default"} is offered`);
    assert.ok(!offered.includes("opencode"), "disabled harness stays out of the picker");
    assert.equal(await engine.inputValue(), provider.id, "the existing provider remains selected");
    assert.equal(await page.locator(".ch-model").inputValue(), provider.models[0].value);
    await page.locator('[data-pane="access"].subtab').click();
    await page.locator(".ch-network-wrap").click();
    assert.equal(await page.locator(".ch-network").isChecked(), true);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/channels/${channelId}/meta`) && response.request().method() === "PUT");
    await page.locator(".save-channel").click();
    const response = await saved;
    assert.equal(response.status(), 200);
    const body = response.request().postDataJSON();
    assert.equal(body.engine, provider.id, "unrelated save sends the original engine");
    assert.equal((await getChannelMeta(entry.slug)).engine, provider.id);
    assert.equal((await getChannelMeta(entry.slug)).model, provider.models[0].value);
    await page.reload();
    await page.locator('[data-pane="runtime"].subtab').click();
    assert.equal(await engine.inputValue(), provider.id, "the provider survives reload");
    const next = QWEN_PROVIDERS.find((p) => p.id !== provider.id);
    await engine.selectOption(next.id);
    await page.locator(".ch-model").selectOption(next.models[0].value);
    const switched = page.waitForResponse((r) => r.url().endsWith(`/api/channels/${channelId}/meta`) && r.request().method() === "PUT");
    await page.locator(".save-channel").click();
    assert.equal((await switched).status(), 200);
    assert.equal((await getChannelMeta(entry.slug)).engine, next.id, "another enabled provider can be selected and saved");
  }
  assert.deepEqual(errors, []);
});
