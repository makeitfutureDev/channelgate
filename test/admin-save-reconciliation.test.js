import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileChannelMeta } from "../public/admin-state.js";

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
