import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  modelWizardModelBlocks,
  modelWizardEngineBlocks,
  modelWizardEffortBlocks,
  modelOptionsForEngine,
  MODEL_PICKER_ACTION_PATTERN,
  EFFORT_PICKER_ACTION_PATTERN,
  MODEL_WIZARD_BACK_ACTION_PATTERN,
  MODEL_WIZARD_BACK_ENGINE_ACTION,
  MODEL_WIZARD_BACK_MODEL_ACTION,
  MODEL_WIZARD_BACK_SCOPE_ACTION,
} = await import("../src/slack/model-wizard.js");

const allButtons = (blocks) => blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements);
const isBack = (el) => MODEL_WIZARD_BACK_ACTION_PATTERN.test(el.action_id);
// The CHOICE buttons of a step — the navigation buttons are asserted separately, below.
const buttons = (blocks) => allButtons(blocks).filter((e) => !isBack(e));

test("the model step is a flat list of buttons — no dropdown", () => {
  const blocks = modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "", isDM: false });

  assert.ok(!JSON.stringify(blocks).includes("static_select"));
  assert.ok(!blocks.some((b) => b.accessory));
  const els = buttons(blocks);
  assert.equal(els.length, modelOptionsForEngine("claude").length);
  assert.ok(els.every((e) => e.type === "button"));
  // Slack requires unique action_ids per block and rejects >25 elements in one actions block.
  assert.equal(new Set(els.map((e) => e.action_id)).size, els.length);
  assert.ok(els.every((e) => MODEL_PICKER_ACTION_PATTERN.test(e.action_id)));
  assert.ok(blocks.filter((b) => b.type === "actions").every((b) => b.elements.length <= 25));
});

test("every model button carries the scope + thread + value the handler decodes", () => {
  const blocks = modelWizardModelBlocks({ scope: "thread", threadTs: "1700000000.000100", engine: "claude", current: "", isDM: false });
  const values = buttons(blocks).map((e) => JSON.parse(e.value));

  assert.ok(values.every((v) => v.s === "t" && v.t === "1700000000.000100"));
  assert.deepEqual(
    values.map((v) => v.v),
    modelOptionsForEngine("claude").map((o) => o.value),
  );
});

test("the button already in force is marked, since buttons have no initial_option", () => {
  const els = buttons(modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "claude-sonnet-5", isDM: false }));
  const marked = els.filter((e) => e.style === "primary");

  assert.equal(marked.length, 1);
  assert.equal(JSON.parse(marked[0].value).v, "claude-sonnet-5");
  assert.match(marked[0].text.text, /^✓ /);
  // With no override set, the "Gateway default" entry is the one marked.
  const noOverride = buttons(modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "", isDM: false }));
  assert.equal(noOverride.findIndex((e) => e.style === "primary"), 0);
});

test("a previously saved Claude alias remains marked and selectable", () => {
  const els = buttons(modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "opus", isDM: false }));
  const selected = els.find((button) => button.style === "primary");
  assert.equal(JSON.parse(selected.value).v, "opus");
  assert.equal(selected.text.text, "✓ Current: opus");
});

test("the effort step is buttons too, one per level the engine accepts", () => {
  const blocks = modelWizardEffortBlocks({ scope: "channel", threadTs: "", engine: "codex", model: "gpt-5.6", current: "high", isDM: false });

  assert.ok(!JSON.stringify(blocks).includes("static_select"));
  const els = buttons(blocks);
  assert.ok(els.every((e) => e.type === "button" && EFFORT_PICKER_ACTION_PATTERN.test(e.action_id)));
  assert.equal(new Set(els.map((e) => e.action_id)).size, els.length);
  assert.deepEqual(
    els.slice(1).map((e) => JSON.parse(e.value).v),
    ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.equal(JSON.parse(els.find((e) => e.style === "primary").value).v, "high");
});

test("each step after the first offers a back button to the step before it", () => {
  const model = allButtons(modelWizardModelBlocks({ scope: "thread", threadTs: "1700000000.000100", engine: "claude", current: "", isDM: false })).filter(isBack);
  const effort = allButtons(modelWizardEffortBlocks({ scope: "thread", threadTs: "1700000000.000100", engine: "claude", model: "", current: "", isDM: false })).filter(isBack);

  // Exactly one, pointing at the PREVIOUS step — a mis-click is one click away from correction.
  assert.deepEqual(model.map((e) => e.action_id), [MODEL_WIZARD_BACK_ENGINE_ACTION]);
  assert.deepEqual(effort.map((e) => e.action_id), [MODEL_WIZARD_BACK_MODEL_ACTION]);
  // It carries the same scope + thread as the step it sits on, so the repaint stays in that scope.
  for (const el of [...model, ...effort]) {
    assert.equal(el.type, "button");
    assert.deepEqual(JSON.parse(el.value), { s: "t", t: "1700000000.000100" });
  }
});

test("the back pattern matches every back id and nothing else in the wizard", () => {
  for (const id of [MODEL_WIZARD_BACK_SCOPE_ACTION, MODEL_WIZARD_BACK_ENGINE_ACTION, MODEL_WIZARD_BACK_MODEL_ACTION]) {
    assert.ok(MODEL_WIZARD_BACK_ACTION_PATTERN.test(id));
  }
  // The harness-step registration in app.js is /^cg_mw_engine_(?!reset$).../ — back must not
  // collide with it, or a "← Back" click would be handled as a harness pick.
  assert.ok(!/^cg_mw_engine_(?!reset$)[a-z0-9_-]+$/.test(MODEL_WIZARD_BACK_ENGINE_ACTION));
  assert.ok(!MODEL_WIZARD_BACK_ACTION_PATTERN.test("cg_mw_engine_claude"));
  assert.ok(!MODEL_WIZARD_BACK_ACTION_PATTERN.test("cg_mw_back_scope_x"));
});

test("the picker patterns still match the retired static_select action ids", () => {
  assert.ok(MODEL_PICKER_ACTION_PATTERN.test("cg_model_pick"));
  assert.ok(MODEL_PICKER_ACTION_PATTERN.test("cg_model_pick_12"));
  assert.ok(!MODEL_PICKER_ACTION_PATTERN.test("cg_model_picker"));
  assert.ok(EFFORT_PICKER_ACTION_PATTERN.test("cg_effort_pick"));
  assert.ok(EFFORT_PICKER_ACTION_PATTERN.test("cg_effort_pick_3"));
});


test("wizard descriptions and posted text name the harnesses that live toggles and channel approvals leave", async () => {
  const { saveSettings, getSettings } = await import("../src/config/settings.js");
  const { modelWizardScopeBlocks, modelWizardEngineBlocks, modelWizardLicenseBlocks, modelWizardText, postModelWizard } = await import("../src/slack/model-wizard.js");
  const before = getSettings().engineEnabled;
  const meta = { approvedEngines: ["claude", "codex", "codex-eu"] };
  const messages = [];
  const client = { chat: { postMessage: async (message) => messages.push(message) } };
  const labels = (m) => allButtons(modelWizardEngineBlocks({ scope: "channel", meta: m })).filter((b) => /^cg_mw_engine_(?!reset$)/.test(b.action_id)).map((b) => b.text.text);
  try {
    saveSettings({ engineEnabled: { claude: true, codex: true, "codex-eu": true, "claude-bedrock": true } });
    await postModelWizard(client, { channel: "C_WIZARD", meta });
    // A license is never a harness: Codex EU and Bedrock are licenses of the two harnesses.
    assert.match(messages.at(-1).text, /harness \(Claude Code \/ Codex\)/);
    assert.ok(!messages.at(-1).text.includes("Codex EU"));
    assert.ok(!JSON.stringify(modelWizardScopeBlocks({ meta })).includes("Codex EU"));
    assert.deepEqual(labels(meta), ["Claude Code", "Codex"]);
    // The approved, switched-on second Codex license shows up one step later, as a license.
    const licenses = JSON.stringify(modelWizardLicenseBlocks({ scope: "channel", meta, engine: "codex", pool: "" }));
    assert.match(licenses, /Any license/);
    assert.match(licenses, /Codex EU/);
    // The unapproved Bedrock license leaves Claude Code with one license: no license step.
    assert.equal(modelWizardLicenseBlocks({ scope: "channel", meta, engine: "claude", pool: "" }), null);
    saveSettings({ engineEnabled: { "codex-eu": false } });
    assert.equal(modelWizardLicenseBlocks({ scope: "channel", meta, engine: "codex", pool: "" }), null);
    // A harness with no usable license left is not offered at all.
    saveSettings({ engineEnabled: { codex: false } });
    await postModelWizard(client, { channel: "C_WIZARD", meta });
    assert.match(messages.at(-1).text, /harness \(Claude Code\)/);
    assert.deepEqual(labels(meta), ["Claude Code"]);
    saveSettings({ engineEnabled: { codex: true } });
    assert.deepEqual(labels({ approvedEngines: ["codex"] }), ["Codex"]);
    assert.match(modelWizardText({ codexAuthSource: "channel", channelId: "C_WIZARD" }), /pick scope, then harness/);
    await postModelWizard(client, { channel: "C_WIZARD", meta: { codexAuthSource: "channel" } });
    assert.equal(messages.at(-1).text, modelWizardText({ codexAuthSource: "channel" }));
  } finally {
    saveSettings({ engineEnabled: before });
  }
});

test("the channel's own Codex sign-in is a license of Codex, offered only in its connected channel", async () => {
  const { modelWizardLicenseBlocks } = await import("../src/slack/model-wizard.js");
  const connected = { channelId: "C_ACCOUNT_PICKER", codexAuthSource: "channel" };
  const ids = meta => allButtons(modelWizardEngineBlocks({ scope: "channel", meta })).map(button => button.action_id);
  const licenses = meta => {
    const blocks = modelWizardLicenseBlocks({ scope: "channel", meta, engine: "codex", pool: "" });
    return blocks ? allButtons(blocks).filter((b) => /^cg_mw_license_\d+$/.test(b.action_id)).map((b) => JSON.parse(b.value).v) : null;
  };
  // The harness step lists harnesses only — never a license id.
  assert.deepEqual(ids(connected).filter((id) => /^cg_mw_engine_(?!reset$)/.test(id)), ["cg_mw_engine_claude", "cg_mw_engine_codex"]);
  assert.deepEqual(licenses(connected), ["any", "codex", "codex-channel"]);
  // One usable Codex license: no license step at all.
  assert.equal(licenses({ channelId: "C_UNCONNECTED" }), null);
  assert.equal(licenses({ ...connected, approvedEngines: ["claude", "codex"] }), null);
  assert.ok(!ids({ ...connected, approvedEngines: ["claude"] }).includes("cg_mw_engine_codex"));
});
