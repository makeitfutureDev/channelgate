import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");

test("local Whisper defaults on and a stored false round-trips to the Admin API", () => {
  assert.equal(settings.getWhisperEnabled?.(), true);
  settings.saveSettings({ whisperEnabled: false });
  assert.equal(settings.getWhisperEnabled?.(), false);
  assert.equal(settings.settingsForApi().whisperEnabled, false);
});

test("Admin settings accept only a boolean and the UI loads and saves the toggle", () => {
  const route = readFileSync(new URL("../src/web/routes/settings.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(route, /typeof body\.whisperEnabled === "boolean"/);
  assert.match(html, /id="set-whisper-enabled"/);
  assert.match(client, /set-whisper-enabled"\)\.checked = s\.whisperEnabled !== false/);
  assert.match(client, /whisperEnabled: document\.getElementById\("set-whisper-enabled"\)\.checked/);
});
