// Saving an Anthropic-compatible provider through the admin API.
//
// The PUT handler used to name `qwenApiKey`/`qwenBaseUrl` literally. With a TABLE behind the UI
// that shape silently breaks: the admin gets a card for the second provider whose key and endpoint
// are accepted with a 200 and then never stored, which looks exactly like a provider that refuses
// the credential. These tests pin the table-driven behaviour instead.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { QWEN_PROVIDERS } = await import("../src/engines/qwen.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function put(body, expected = 200) {
  const response = await fetch(`${base}/settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, expected);
  return response.json();
}

const card = (id) => settings.settingsForApi().qwenProviders.find((p) => p.id === id);
const clearAll = () => settings.saveSettings(Object.fromEntries(
  QWEN_PROVIDERS.flatMap((e) => [[e.settings.apiKey, ""], [e.settings.baseUrl, ""], [e.defaultModelKey, ""]]),
));

test("every provider in the table can be configured, and none of them echoes its key back", async () => {
  clearAll();
  for (const entry of QWEN_PROVIDERS) {
    const value = `sk-fixture-${entry.id}-value-4321`;
    await put({ [entry.settings.apiKey]: `  ${value}  `, [entry.settings.baseUrl]: "https://ws-test.example/apps/anthropic" });
    const stored = settings.getQwenConfig(entry.id);
    assert.equal(stored.apiKey, value, `${entry.id} must actually store its key (trimmed)`);
    assert.equal(stored.baseUrl, "https://ws-test.example/apps/anthropic");
    const shown = card(entry.id);
    assert.equal(shown.hasApiKey, true);
    assert.equal(shown.apiKeyLast4, "4321");
    assert.equal(JSON.stringify(settings.settingsForApi()).includes(value), false, "a listing must never carry the value");
  }
  clearAll();
});

test("an endpoint the daemon would send a credential to must be https", async () => {
  clearAll();
  for (const entry of QWEN_PROVIDERS) {
    const rejected = await put({ [entry.settings.baseUrl]: "http://plain.example/apps/anthropic" }, 400);
    assert.match(rejected.error, /https:\/\/ endpoint/);
    assert.match(rejected.error, new RegExp(entry.label.replace(/[()]/g, "\\$&")), "the rejection names WHICH provider");
    assert.equal(settings.getQwenConfig(entry.id).baseUrl, entry.defaultBaseUrl, "nothing is stored on a rejected save");
  }
  clearAll();
});

test("a key the admin cannot read is removed by the explicit clear flag, not by an empty box", async () => {
  clearAll();
  const entry = QWEN_PROVIDERS[QWEN_PROVIDERS.length - 1];
  await put({ [entry.settings.apiKey]: "sk-fixture-to-be-cleared" });
  assert.equal(settings.getQwenConfig(entry.id).apiKey, "sk-fixture-to-be-cleared");
  // The UI sends no key field at all when the (masked) box was not typed into — a save of any
  // other setting must not wipe the credential.
  await put({ [entry.settings.baseUrl]: "https://ws-test.example/apps/anthropic" });
  assert.equal(settings.getQwenConfig(entry.id).apiKey, "sk-fixture-to-be-cleared", "an untouched key survives an unrelated save");
  const flag = `clear${entry.settings.apiKey[0].toUpperCase()}${entry.settings.apiKey.slice(1)}`;
  await put({ [flag]: true });
  assert.equal(settings.getQwenConfig(entry.id).apiKey, "");
  assert.equal(card(entry.id).hasApiKey, false);
  clearAll();
});

test("a provider's gateway default model is validated against THAT provider's catalog", async () => {
  clearAll();
  const entry = QWEN_PROVIDERS[QWEN_PROVIDERS.length - 1];
  await put({ [entry.defaultModelKey]: entry.models[0].value });
  assert.equal(settings.getDefaultModel(entry.id), entry.models[0].value);
  // An Anthropic id in a provider's default-model box would break every defaulted run in the
  // deployment, so it is refused at the boundary rather than at spawn time.
  const rejected = await put({ [entry.defaultModelKey]: "opus" }, 400);
  assert.match(rejected.error, /is not a .* model/);
  assert.equal(settings.getDefaultModel(entry.id), entry.models[0].value, "the rejected save changed nothing");
  clearAll();
});
