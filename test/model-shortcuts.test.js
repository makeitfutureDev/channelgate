import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { parseModelShortcut, defaultModelShortcuts, modelShortcutsFromSettings } = await import("../src/config/model-shortcuts.js");
const { getModelShortcuts, settingsForApi, saveSettings, getSettings } = await import("../src/config/settings.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
after(() => server.close());

async function put(modelShortcuts, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelShortcuts }),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

test("fresh installs inherit supported family defaults without persisting version pins", () => {
  const defaults = getModelShortcuts();
  assert.deepEqual(Object.keys(defaults).sort(), ["astra", "fable", "opus", "sol", "sonet", "terra"]);
  assert.equal(defaults.sonet.engine, "claude");
  assert.match(defaults.sonet.model, /^claude-sonnet-/);
  assert.equal(defaults.sol.engine, "codex");
  assert.match(defaults.sol.model, /^gpt-[\d.]+-sol$/);
  saveSettings({ sessionKeepalive: "10" });
  assert.deepEqual(getModelShortcuts(), defaults, "unrelated saves retain inheritance");
  assert.deepEqual(settingsForApi().modelShortcuts, defaults);
  assert.equal(Object.hasOwn(getSettings(), "modelShortcuts"), false);
});

test("catalog defaults choose the newest stable family numerically and omit absent families", () => {
  const catalogs = {
    claude: ["claude-sonnet-5-9", "claude-sonnet-5-10", "claude-sonnet-6-preview", "claude-sonnet-9-20261023", "claude-sonnet-9-2026-10-23", "sonnet", "claude-opus-5-5", "claude-haiku-5-5"].map(value => ({ value })),
    codex: ["gpt-6.9-sol", "gpt-6.10-sol", "gpt-6.10-sol-preview", "gpt-7-sol", "gpt-6-astra", "codex"].map(value => ({ value })),
  };
  const initial = defaultModelShortcuts(catalogs);
  assert.equal(initial.sonet.model, "claude-sonnet-5-10");
  assert.equal(initial.sol.model, "gpt-7-sol");
  assert.equal(defaultModelShortcuts({codex: catalogs.codex.slice(0, 2)}).sol.model, "gpt-6.10-sol");
  assert.equal(initial.fable, undefined);
  assert.equal(initial.terra, undefined);
  const settings = {};
  assert.deepEqual(modelShortcutsFromSettings(settings, catalogs), initial);
  catalogs.claude.push({ value: "claude-sonnet-6" });
  assert.equal(modelShortcutsFromSettings(settings, catalogs).sonet.model, "claude-sonnet-6");
  assert.deepEqual(settings, {}, "resolution never freezes a version into settings");
  assert.deepEqual(modelShortcutsFromSettings({modelShortcuts: {}}, catalogs), {});
  const custom = {sonet: {engine: "claude", model: "claude-sonnet-5-5"}};
  assert.deepEqual(modelShortcutsFromSettings({modelShortcuts: custom}, catalogs), custom);
  assert.deepEqual(modelShortcutsFromSettings({modelShortcuts: null}, catalogs), {});
  assert.deepEqual(defaultModelShortcuts(), {});
});

test("mention suffix parses a shortcut and preserves the task", () => {
  assert.deepEqual(parseModelShortcut(":astra build this"), { name: "astra", task: "build this" });
  assert.deepEqual(parseModelShortcut(": FABLE"), { name: "fable", task: "" });
  assert.equal(parseModelShortcut("review :astra"), null);
  assert.equal(parseModelShortcut(":astra, build this"), null);
});

test("settings save and expose valid engine/model mappings", async () => {
  await put({ astra: { engine: "codex", model: "gpt-6-astra" }, opus: { engine: "claude", model: "claude-opus-5-5" } });
  assert.deepEqual(getModelShortcuts(), {
    astra: { engine: "codex", model: "gpt-6-astra" },
    opus: { engine: "claude", model: "claude-opus-5-5" },
  });
  assert.deepEqual(settingsForApi().modelShortcuts, getModelShortcuts());
  await put({ astra: { engine: "codex", model: "gpt-5.6-sol" } });
  assert.equal(getModelShortcuts().astra.model, "gpt-5.6-sol", "an admin can repoint the shortcut when models change");
  await put({});
  assert.deepEqual(getModelShortcuts(), {});
});

test("invalid shortcut saves leave the old mapping intact", async () => {
  saveSettings({ modelShortcuts: { sol: { engine: "codex", model: "gpt-5.6-sol" } } });
  for (const invalid of [
    { "bad name": { engine: "codex", model: "gpt-5.6-sol" } },
    { sol: { engine: "claude", model: "gpt-5.6-sol" } },
    { sol: { engine: "codex", model: "not a model" } },
    { SOL: { engine: "codex", model: "gpt-5.6-sol" }, sol: { engine: "codex", model: "gpt-5.6-sol" } },
  ]) {
    await put(invalid, 400);
    assert.equal(getModelShortcuts().sol.model, "gpt-5.6-sol");
  }
});
