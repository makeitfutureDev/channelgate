import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { parseModelShortcut } = await import("../src/config/model-shortcuts.js");
const { getModelShortcuts, settingsForApi, saveSettings } = await import("../src/config/settings.js");
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
