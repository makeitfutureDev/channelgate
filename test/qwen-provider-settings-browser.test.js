// Real browser + disposable admin API state; no production settings are modified.
// CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test test/qwen-provider-settings-browser.test.js
//
// The Qwen settings card became one card PER provider, cloned from a template and wired at render
// time. Everything that used to be guaranteed by a fixed element id — the key reveals, the clear
// button, the model picker, and above all which provider a typed key is saved under — is now
// produced by code, so it is checked in a real browser against the real admin API.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("each provider gets its own settings card, and a key typed in one is saved under that provider", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { saveSettings, getQwenConfig, getDefaultModel } = await import("../src/config/settings.js");
  const { QWEN_PROVIDERS } = await import("../src/engines/qwen.js");
  saveSettings(Object.fromEntries(QWEN_PROVIDERS.flatMap((e) => [[e.settings.apiKey, ""], [e.settings.baseUrl, ""], [e.defaultModelKey, ""]])));

  const app = express();
  app.use(express.json());
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/settings`);

  const cards = page.locator(".qwen-provider-card");
  await cards.first().waitFor();
  assert.equal(await cards.count(), QWEN_PROVIDERS.length, "one card per provider in the table");
  for (const [i, entry] of QWEN_PROVIDERS.entries()) {
    assert.equal(await cards.nth(i).locator('[data-role="label"]').textContent(), entry.label);
  }
  const first = cards.nth(0);
  const eu = cards.nth(QWEN_PROVIDERS.length - 1);
  const euEntry = QWEN_PROVIDERS[QWEN_PROVIDERS.length - 1];

  // A provider that ships no endpoint says the box is required rather than implying a default.
  assert.equal(await first.locator('[data-role="base-url"]').getAttribute("placeholder"), QWEN_PROVIDERS[0].defaultBaseUrl);
  assert.match(await eu.locator('[data-role="base-url"]').getAttribute("placeholder"), /required/);
  assert.equal(await eu.locator('[data-role="key-state"]').textContent(), "not set");

  // An opt-in harness with no key of its own says so on its enable toggle, by provider.
  const toggles = page.locator("#engine-enabled-box label");
  assert.match(await toggles.filter({ hasText: euEntry.label }).textContent(), /needs an API key below/);

  // The model picker is the provider's OWN catalog, not the other provider's.
  const euModels = await eu.locator('[data-role="default-model"] option').allInnerTexts();
  assert.ok(euModels.includes("Kimi K2.7 Code"), `the EU catalog is offered: ${euModels.join(", ")}`);
  assert.equal(
    (await first.locator('[data-role="default-model"] option').allInnerTexts()).includes("Kimi K2.7 Code"),
    false,
    "one provider's shipped catalog never leaks into another's picker",
  );

  const save = page.locator("#save-settings");
  const persist = async () => {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
    await save.click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => globalThis.document.querySelector("#settings-dirty-msg")?.textContent === "All changes saved");
  };

  await eu.locator('[data-role="api-key"]').fill("sk-ws-BROWSER-FIXTURE-5678");
  await eu.locator('[data-role="base-url"]').fill("https://ws-browser.eu-central-1.example/apps/anthropic");
  await eu.locator('[data-role="default-model"]').selectOption(euEntry.models[0].value);
  await persist();

  assert.equal(getQwenConfig(euEntry.id).apiKey, "sk-ws-BROWSER-FIXTURE-5678", "the key is stored under the provider it was typed into");
  assert.equal(getQwenConfig(euEntry.id).baseUrl, "https://ws-browser.eu-central-1.example/apps/anthropic");
  assert.equal(getDefaultModel(euEntry.id), euEntry.models[0].value);
  assert.equal(getQwenConfig(QWEN_PROVIDERS[0].id).apiKey, "", "the other provider is untouched");
  // The repaint after a save must mask it again — the value never returns from a listing.
  assert.equal(await eu.locator('[data-role="key-state"]').textContent(), "set · ••••5678");
  assert.match(await toggles.filter({ hasText: euEntry.label }).textContent(), /^(?!.*needs an API key).*$/s, "the toggle stops asking for a key once one is stored");

  // Clearing is explicit: an untouched (masked) box on a later save must not wipe the credential.
  await eu.locator('[data-role="base-url"]').fill("https://ws-browser-2.eu-central-1.example/apps/anthropic");
  await persist();
  assert.equal(getQwenConfig(euEntry.id).apiKey, "sk-ws-BROWSER-FIXTURE-5678", "an unrelated save keeps the key");
  await eu.locator('[data-role="clear-key"]').click();
  await persist();
  assert.equal(getQwenConfig(euEntry.id).apiKey, "", "the armed clear removed it");
  assert.equal(await eu.locator('[data-role="key-state"]').textContent(), "not set");

  // The settings search indexes each card separately — they are siblings, not one wrapped block.
  await page.locator("#settings-search").fill("Model Studio");
  await page.waitForFunction(() => !globalThis.document.querySelectorAll(".qwen-provider-card")[1]?.classList.contains("filtered-out"));
  assert.equal(await eu.evaluate((el) => el.classList.contains("filtered-out")), false, "the EU card matches its own text");
  assert.equal(await first.evaluate((el) => el.classList.contains("filtered-out")), true, "the other provider's card is filtered out");

  assert.deepEqual(errors, [], "no page or console errors");
  saveSettings(Object.fromEntries(QWEN_PROVIDERS.flatMap((e) => [[e.settings.apiKey, ""], [e.settings.baseUrl, ""], [e.defaultModelKey, ""]])));
});
