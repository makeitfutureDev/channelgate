import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  modelWizardModelBlocks,
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
  const els = buttons(modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "sonnet", isDM: false }));
  const marked = els.filter((e) => e.style === "primary");

  assert.equal(marked.length, 1);
  assert.equal(JSON.parse(marked[0].value).v, "sonnet");
  assert.match(marked[0].text.text, /^✓ /);
  // With no override set, the "Gateway default" entry is the one marked.
  const noOverride = buttons(modelWizardModelBlocks({ scope: "channel", threadTs: "", engine: "claude", current: "", isDM: false }));
  assert.equal(noOverride.findIndex((e) => e.style === "primary"), 0);
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
