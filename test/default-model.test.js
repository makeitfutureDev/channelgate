// Gateway-wide default model (per engine): resolution, trimming, and the round-trip through
// saveSettings — the setting that keeps gateway runs pinned even when the admin's interactive
// terminal `/model` changes the CLI's own default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv(); // scratch gateway dir — getSettings() reads no real config

const { getDefaultModel, saveSettings, settingsForApi } = await import("../src/config/settings.js");
const { isValidModel } = await import("../src/slack/util.js");

test("unset default model is empty for both engines (CLI default)", () => {
  assert.equal(getDefaultModel("claude"), "");
  assert.equal(getDefaultModel("codex"), "");
});

test("per-engine defaults round-trip through saveSettings and are keyed by engine", () => {
  saveSettings({ defaultClaudeModel: "opus", defaultCodexModel: "gpt-5.6-terra" });
  assert.equal(getDefaultModel("claude"), "opus");
  assert.equal(getDefaultModel("codex"), "gpt-5.6-terra");
  // Any non-"codex" engine value resolves to the Claude default.
  assert.equal(getDefaultModel(""), "opus");
  const api = settingsForApi();
  assert.equal(api.defaultClaudeModel, "opus");
  assert.equal(api.defaultCodexModel, "gpt-5.6-terra");
});

test("values are trimmed and non-strings ignored; blank clears back to CLI default", () => {
  saveSettings({ defaultClaudeModel: "  sonnet  " });
  assert.equal(getDefaultModel("claude"), "sonnet");
  saveSettings({ defaultClaudeModel: 42 });
  assert.equal(getDefaultModel("claude"), ""); // stored garbage never reaches --model
  saveSettings({ defaultClaudeModel: "opus", defaultCodexModel: "" });
  assert.equal(getDefaultModel("codex"), "");
});

test("the admin route's isValidModel guard accepts the intended ids and rejects garbage", () => {
  for (const ok of ["opus", "sonnet", "haiku", "opus[1m]", "claude-fable-5", "gpt-5.6-terra", "codex", "o3-mini"]) {
    assert.equal(isValidModel(ok), true, ok);
  }
  for (const bad of ["opus; rm -rf /", "my model", "--verbose", "OPUS EXTRA"]) {
    assert.equal(isValidModel(bad), false, bad);
  }
});
