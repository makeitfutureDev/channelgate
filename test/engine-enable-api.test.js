// The Admin API guard around the per-harness on/off switch: the daemon must never be saved into a
// state where it has no engine to run, or where the default engine is one the admin just turned
// off. Exercises the real router over a live HTTP listener.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { saveSettings, getEngine, isEngineEnabled, getEngineFallback } = await import("../src/config/settings.js");

const app = express();
app.use(express.json());
app.use("/api", createSettingsRouter({}));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const putSettings = async (body) => {
  const res = await fetch(`${base}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test("disabling every harness is refused", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true, opencode: true } });
  const res = await putSettings({ engineEnabled: { claude: false, codex: false, opencode: false } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one engine/i);
  assert.equal(isEngineEnabled("claude"), true, "the refused patch must not have been applied");
});

test("a partial map only changes the engines it names", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true, opencode: true } });
  const res = await putSettings({ engineEnabled: { codex: false, bogus: false } });
  assert.equal(res.status, 200);
  assert.equal(isEngineEnabled("codex"), false);
  assert.equal(isEngineEnabled("claude"), true);
  assert.equal(isEngineEnabled("bogus"), false, "an unknown id is dropped, never stored");
});

test("the default engine is validated against the enable state being saved in the SAME request", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true, opencode: true } });

  const conflicting = await putSettings({ engine: "codex", engineEnabled: { codex: false } });
  assert.equal(conflicting.status, 400);
  assert.match(conflicting.body.error, /disabled/i);
  assert.equal(getEngine(), "claude");

  const consistent = await putSettings({ engine: "codex", engineEnabled: { claude: true, codex: true } });
  assert.equal(consistent.status, 200);
  assert.equal(getEngine(), "codex");
});

test("the failover toggle accepts both the canonical and the legacy key, writing only the canonical one", async () => {
  saveSettings({ engine: "claude", engineFallback: true, codexFallback: undefined });
  assert.equal((await putSettings({ engineFallback: false })).status, 200);
  assert.equal(getEngineFallback(), false);
  assert.equal((await putSettings({ codexFallback: true })).status, 200);
  assert.equal(getEngineFallback(), true, "an older UI's key still works");
});

test("the admin UI renders the harness switches and saves both engine settings", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="engine-enabled-box"/);
  assert.match(html, /id="set-engine-fallback"/);
  assert.doesNotMatch(html, /id="set-codex-fallback"/, "the Codex-only wording is gone");
  assert.match(client, /set-engine-fallback"\)\.checked = s\.engineFallback !== false/);
  assert.match(client, /engineFallback: document\.getElementById\("set-engine-fallback"\)\.checked/);
  assert.match(client, /engineEnabled: \{ \.\.\.ENGINE_ENABLED \}/);
  // Every engine picker is built from the enabled set, so a disabled harness can't be chosen.
  assert.match(client, /function selectableEngines/);
  assert.match(client, /selectableEngines\(\)\.map/);
});
