// UI-managed settings are pushed into process.env so the env-based readers pick them up. The
// lifecycle that used to be missing is the CLEAR: applySettingsToEnv only ever assigned, so
// emptying a field in the admin UI left the previously applied value live until the next restart
// (and a field that was never in the ambient environment stayed set forever). Scratch gateway dir
// + SQLite (env set before the store import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

// Captured BEFORE the first applySettingsToEnv call, which is when the ambient snapshot is taken:
// COMPOSIO_MCP_URL stands for "the .env/shell already provided a value", SKILLS_MCP_URL for
// "this variable did not exist at boot".
const AMBIENT = "https://ambient.example/mcp";
process.env.COMPOSIO_MCP_URL = AMBIENT;
delete process.env.SKILLS_MCP_URL;

const { applySettingsToEnv, saveSettings } = await import("../src/config/settings.js");

test("a cleared setting restores the ambient value, or deletes the variable it invented", () => {
  applySettingsToEnv(); // boot: nothing stored yet
  assert.equal(process.env.COMPOSIO_MCP_URL, AMBIENT);
  assert.equal("SKILLS_MCP_URL" in process.env, false);

  saveSettings({ composioMcpUrl: "https://ui.example/mcp", skillsMcpUrl: "https://ui.example/skills" });
  applySettingsToEnv();
  assert.equal(process.env.COMPOSIO_MCP_URL, "https://ui.example/mcp"); // UI wins over .env
  assert.equal(process.env.SKILLS_MCP_URL, "https://ui.example/skills");

  saveSettings({ composioMcpUrl: "", skillsMcpUrl: "" }); // admin empties both fields
  applySettingsToEnv();
  assert.equal(process.env.COMPOSIO_MCP_URL, AMBIENT, "must fall back to the pre-override value");
  assert.equal("SKILLS_MCP_URL" in process.env, false, "must be deleted, not left at the stale UI value");
});

test("the ambient snapshot is taken once, not refreshed from an already-overridden env", () => {
  saveSettings({ composioMcpUrl: "https://second.example/mcp" });
  applySettingsToEnv();
  assert.equal(process.env.COMPOSIO_MCP_URL, "https://second.example/mcp");
  saveSettings({ composioMcpUrl: "" });
  applySettingsToEnv();
  // Re-capturing on every pass would have made the previous override the new "ambient" value and
  // pinned it permanently.
  assert.equal(process.env.COMPOSIO_MCP_URL, AMBIENT);
});
