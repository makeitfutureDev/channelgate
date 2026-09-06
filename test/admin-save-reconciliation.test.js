import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changedSettingKeys, diffSettingsPayload, reconcileChannelMeta, settingValuesEqual } from "../public/admin-state.js";

test("channel save reconciliation adopts authoritative tool and skill selections", () => {
  const current = {
    allowedMcps: [{ name: "old-claude" }],
    allowedCodexMcps: [],
    skills: ["old-skill"],
    hasComposioToken: false,
    composioTokenLast4: "",
  };
  const saved = {
    allowedMcps: [],
    allowedCodexMcps: [{
      id: "boost_space",
      name: "Boost.space",
      kind: "tool-group",
      serverName: "codex_apps",
      toolPrefix: "boost_space",
    }],
    skills: ["boost-workflow"],
    composioToken: "shared-token-1234",
  };

  const reconciled = reconcileChannelMeta(current, saved);

  assert.deepEqual(reconciled.allowedMcps, []);
  assert.deepEqual(reconciled.allowedCodexMcps, saved.allowedCodexMcps);
  assert.deepEqual(reconciled.skills, ["boost-workflow"]);
  assert.equal(reconciled.hasComposioToken, true);
  assert.equal(reconciled.composioTokenLast4, "1234");
});

test("channel save reconciliation clears derived token state from the authoritative response", () => {
  const reconciled = reconcileChannelMeta(
    {
      composioToken: "old-token",
      hasComposioToken: true,
      composioTokenLast4: "oken",
    },
    { composioToken: "" },
  );

  assert.equal(reconciled.hasComposioToken, false);
  assert.equal(reconciled.composioTokenLast4, "");
});

test("channel save reconciliation derives Make toolbox key state", () => {
  const saved = {
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc",
    makeToolboxKey: "make-secret-1234",
  };
  const reconciled = reconcileChannelMeta({}, saved);

  assert.equal(reconciled.makeToolboxUrl, saved.makeToolboxUrl);
  assert.equal(reconciled.hasMakeToolboxKey, true);
  assert.equal(reconciled.makeToolboxKeyLast4, "1234");

  const cleared = reconcileChannelMeta(reconciled, {
    makeToolboxUrl: "",
    makeToolboxKey: "",
  });
  assert.equal(cleared.hasMakeToolboxKey, false);
  assert.equal(cleared.makeToolboxKeyLast4, "");
});

test("Admin save handlers repaint from their successful PUT responses", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const channelSave = client.slice(
    client.indexOf('savebar.querySelector(".save-channel")'),
    client.indexOf("// Discard: re-render the detail"),
  );
  const settingsSave = client.slice(
    client.indexOf('document.getElementById("save-settings")'),
    client.indexOf('document.getElementById("reconnect-slack")'),
  );

  assert.match(client, /import \{[\s\S]*?reconcileChannelMeta,[\s\S]*?\} from "\.\/admin-state\.js"/);
  assert.match(channelSave, /const result = await api\(/);
  assert.match(channelSave, /ch\.meta = reconcileChannelMeta\(ch\.meta, result\.meta\)/);
  assert.match(client, /function paintSettings\(s\)/);
  // loadSettings paints from /api/settings and then refreshes the License card from its own
  // endpoint (the licensing state machine has a clock in it, so it is not part of the settings
  // payload). The invariant this guards is unchanged: settings are painted from ONE fetch.
  assert.match(client, /async function loadSettings\(\)\s*\{\s*paintSettings\(await api\("\/api\/settings"\)\);\s*await loadLicense\(\);\s*\}/);
  assert.match(client, /async function loadLicense\(\)/);
  assert.match(settingsSave, /paintSettings\(r\)/);
  assert.doesNotMatch(settingsSave, /await loadSettings\(\)/);
});

// ── Global settings: the save carries the CHANGE, not the page ────────────────────────────────
test("a settings diff carries only what moved since the page was painted", () => {
  const baseline = {
    scheduleMaxPerChannel: 20,
    sessionKeepalive: "10m",
    channelTemplate: { engine: "claude", effort: "high" },
    codexModelRates: { "gpt-5.6": { input: 5, output: 30 } },
    mentionReactions: "robot_face",
  };
  const form = {
    scheduleMaxPerChannel: 44,
    sessionKeepalive: "10m",
    channelTemplate: { engine: "claude", effort: "high" },
    codexModelRates: { "gpt-5.6": { input: 5, output: 30 } },
    mentionReactions: "robot_face",
  };

  // Exactly one key moved, so exactly one key is sent — the untouched channelTemplate cannot
  // revert another writer's change to it.
  assert.deepEqual(diffSettingsPayload(baseline, form), { scheduleMaxPerChannel: 44 });
});

test("a settings diff keeps deep edits, one-shot actions, and nothing undefined", () => {
  const baseline = { channelTemplate: { engine: "claude", effort: "high" }, contextWindow: 200000 };
  const form = {
    channelTemplate: { engine: "claude", effort: "low" }, // a nested value changed
    contextWindow: undefined, // a blanked number: JSON would drop it anyway
    adminPassword: "hunter2", // absent from the baseline = a pending action, always sent
    clearApiKey: true,
  };

  assert.deepEqual(diffSettingsPayload(baseline, form), {
    channelTemplate: { engine: "claude", effort: "low" },
    adminPassword: "hunter2",
    clearApiKey: true,
  });
  assert.deepEqual(diffSettingsPayload({}, {}), {});
});

test("settings equality is structural for the objects and arrays the form builds", () => {
  assert.equal(settingValuesEqual(["a", "b"], ["a", "b"]), true);
  assert.equal(settingValuesEqual(["a", "b"], ["b", "a"]), false);
  assert.equal(settingValuesEqual({ user: { mode: "read" } }, { user: { mode: "read" } }), true);
  assert.equal(settingValuesEqual(undefined, undefined), true);
  assert.equal(settingValuesEqual(undefined, ""), false);
  assert.equal(settingValuesEqual(0, false), false);
});

test("a refused save can name what changed under it, ignoring the live parts of the payload", () => {
  const before = { scheduleMaxPerChannel: 20, channelTemplate: { effort: "high" }, slack: { connected: false }, settingsVersion: "4" };
  const after = { scheduleMaxPerChannel: 20, channelTemplate: { effort: "low" }, slack: { connected: true }, settingsVersion: "5" };

  assert.deepEqual(changedSettingKeys(before, after, ["slack", "settingsVersion"]), ["channelTemplate"]);
  assert.deepEqual(changedSettingKeys(before, before, []), []);
});
