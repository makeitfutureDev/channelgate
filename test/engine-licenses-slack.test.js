// Engine licenses on Slack: every engine pick is harness → license → model → effort. The license
// step exists only while the chosen harness has more than one license usable in the conversation,
// and what is stored is always `engine` (the first license) plus the pool of further licenses of
// the same harness. ("License" here is an ENGINE license — the ChannelGate product license is
// src/ee/license.js and is covered by the license-*.test.js files.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";

const { saveSettings } = await import("../src/config/settings.js");
const { createLicense } = await import("../src/config/engine-licenses.js");
const { licenseLoginHome } = await import("../src/engines/license-state.js");
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSession } = await import("../src/gateway/sessions.js");
const { getThreadEngine, getThreadLicensePool, getThreadModel, setThreadEngine } = await import("../src/gateway/thread-engine.js");
const {
  buildChannelSettingsView, RUNTIME_LICENSE_ACTION_IDS, runtimeSelectTarget,
  CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID,
} = await import("../src/slack/channel-settings.js");
const { runtimeScopes, applyThreadRuntimeSelection } = await import("../src/slack/app.js");
const {
  handleModelWizard, modelWizardEngineBlocks, modelWizardLicenseBlocks,
  MODEL_WIZARD_SCOPE_CHANNEL_ACTION, MODEL_WIZARD_SCOPE_THREAD_ACTION, MODEL_WIZARD_ALSO_ACTION, MODEL_WIZARD_LICENSE_DONE_ACTION,
  MODEL_WIZARD_LICENSE_ACTION_PATTERN, MODEL_WIZARD_BACK_ACTION_PATTERN, MODEL_PICKER_ACTION, EFFORT_PICKER_ACTION,
} = await import("../src/slack/model-wizard.js");
const { clipLabel, harnessChoices, licenseChoices, namedSelection, nextLicenseSelection } = await import("../src/slack/license-controls.js");
const { createForkThread, forkLicensePool } = await import("../src/slack/fork-thread.js");
const { engineSwitchChoiceText, engineSwitchChoiceBlocks } = await import("../src/slack/engine-switch-choice.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");

// A signed-in Codex sign-in license, as test/engine-licenses.test.js makes one.
const jwt = (plan = "business") => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "lic-test" } })).toString("base64url")}.fixture`;
const signIn = (id) => {
  mkdirSync(licenseLoginHome(id), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(licenseLoginHome(id), "auth.json"), JSON.stringify({ tokens: { access_token: jwt(), refresh_token: "fixture-refresh", account_id: "lic-test" } }), { mode: 0o600 });
};
const reset = () => saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true }, engineFallback: true });
// Two more Codex licenses beside the default sign-in.
function twoLicenses() {
  reset();
  const work = createLicense({ kind: "codex-login", label: "Work ChatGPT", type: "business" });
  const second = createLicense({ kind: "codex-login", label: "Second seat", type: "business" });
  signIn(work.id);
  signIn(second.id);
  return { work: work.id, second: second.id };
}

const ADMIN = "U_LIC_ADMIN";
const baseRuntime = (meta) => ({ runtime: {
  configuredEngineId: meta.engine || "", effectiveEngineId: meta.engine || "claude",
  configuredModel: meta.model || "", configuredEffort: meta.effort || "",
} });
const settingsState = (channelId, slug, threadTs = "") => ({ channelId, slug, threadTs, ownerId: ADMIN });
async function agentView(slug, meta, threadTs = "") {
  const data = baseRuntime(meta);
  const scopes = await runtimeScopes(slug, meta, data, threadTs);
  const view = buildChannelSettingsView({ runtime: { ...data.runtime, scopes } }, settingsState("C_LIC_VIEW", slug, threadTs), { tab: "agent", canEditRuntime: true });
  return { scopes, view };
}
// Every interactive element of a view or a message, accessories included.
const controls = (blocks) => blocks.flatMap((block) => [...(block.elements || []), ...(block.accessory ? [block.accessory] : [])]).filter((el) => el.action_id);
const byAction = (blocks, actionId) => controls(blocks).find((el) => el.action_id === actionId);
const optionLabels = (control) => control.options.map((o) => o.text.text);
const optionValues = (control) => control.options.map((o) => o.value);

async function channel(id, name, meta = {}) {
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId: id, name: entry.name, type: "channel", isDM: false, template: "custom", engine: "claude", model: "", effort: "", allowNetwork: false, ...meta });
  return entry;
}
function wizardClient() {
  const updates = [], ephemerals = [];
  return { updates, ephemerals, chat: {
    update: async (args) => { updates.push(args); return { ok: true }; },
    postEphemeral: async (args) => { ephemerals.push(args); return { ok: true }; },
    postMessage: async () => ({ ok: true }),
  } };
}
const wizardState = (scope, thread, value) => JSON.stringify({ s: scope, t: thread, ...(value === undefined ? {} : { v: value }) });
async function click(client, channelId, action) {
  await handleModelWizard({
    ack: async () => {},
    body: { user: { id: ADMIN }, channel: { id: channelId }, container: { channel_id: channelId, message_ts: "1902000000.000200" } },
    action, client, respond: async () => {},
  });
}
const card = (client) => JSON.stringify(client.updates.at(-1).blocks);
const licenseButtons = (blocks) => controls(blocks).filter((el) => MODEL_WIZARD_LICENSE_ACTION_PATTERN.test(el.action_id));

test("with one license per harness no surface shows a license control", async () => {
  reset();
  assert.deepEqual(harnessChoices({}), [{ label: "Claude Code", value: "claude" }, { label: "Codex", value: "codex" }]);
  assert.equal(licenseChoices({ engine: "codex", meta: {} }), null);

  // Settings modal: the first select is the Harness, and no License / "also use" control follows.
  const { scopes, view } = await agentView("lic-one", { engine: "codex" }, "1902000000.000001");
  assert.equal(scopes.channel.license, null);
  assert.equal(scopes.thread.license, null);
  assert.equal(scopes.channel.selection, "Codex");
  const harness = byAction(view.blocks, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID);
  assert.deepEqual(optionLabels(harness).slice(-2), ["Claude Code", "Codex"]);
  assert.equal(harness.initial_option.value, "codex");
  for (const scope of ["channel", "thread"]) for (const field of ["license", "also"]) {
    assert.equal(byAction(view.blocks, RUNTIME_LICENSE_ACTION_IDS[scope][field]), undefined, `${scope} ${field}`);
  }
  assert.doesNotMatch(JSON.stringify(view.blocks), /multi_static_select|Any license|If it fails, also use/);

  // /model wizard: the harness step lists the two harnesses and goes straight on to the model.
  assert.equal(modelWizardLicenseBlocks({ scope: "channel", threadTs: "", meta: {}, engine: "codex", pool: "" }), null);
  const entry = await channel("C_LIC_ONE", "lic-one-wizard");
  const client = wizardClient();
  await click(client, "C_LIC_ONE", { action_id: MODEL_WIZARD_SCOPE_CHANNEL_ACTION, value: wizardState("c", "") });
  assert.deepEqual(controls(client.updates.at(-1).blocks).filter((el) => /^cg_mw_engine_(?!reset$)/.test(el.action_id)).map((el) => el.text.text), ["Claude Code", "Codex"]);
  await click(client, "C_LIC_ONE", { action_id: "cg_mw_engine_codex", value: wizardState("c", "") });
  assert.match(card(client), /Choose a Codex model/);
  assert.match(card(client), /returns to the harness step/);
  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.engine, "codex");
  assert.equal(meta.licensePool || "", "");
  assert.equal(client.ephemerals.length, 0);
});

test("with more than one usable license the modal shows License and, for a specific license, the also-use control", async () => {
  const { work, second } = twoLicenses();

  // A specific license: License select + "If it fails, also use" multi-select.
  const specific = await agentView("lic-two", { engine: "codex" });
  assert.equal(specific.scopes.channel.selection, "Codex · Default sign-in");
  const license = byAction(specific.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.license);
  assert.equal(license.type, "static_select");
  assert.deepEqual(optionLabels(license), ["Any license", "Default sign-in", "Work ChatGPT", "Second seat"]);
  assert.deepEqual(optionValues(license), ["any", "codex", work, second]);
  assert.equal(license.initial_option.value, "codex");
  const also = byAction(specific.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.also);
  assert.equal(also.type, "multi_static_select");
  assert.deepEqual(optionValues(also), [work, second]);
  assert.equal(also.initial_options, undefined, "Slack refuses an empty initial_options list");
  assert.match(JSON.stringify(specific.view.blocks), /If it fails, also use/);
  assert.match(JSON.stringify(specific.view.blocks), /When a license cannot answer, the turn moves to the next one\./);
  // Slack: a multi-select is an accessory, never an element of an actions block.
  for (const block of specific.view.blocks.filter((b) => b.type === "actions")) {
    assert.ok(block.elements.length <= 25);
    assert.ok(block.elements.every((el) => el.type !== "multi_static_select"));
  }
  // Both scopes at once stay inside Slack's view limits, with no id used twice.
  const both = (await agentView("lic-two", { engine: "codex" }, "1902000000.000050")).view.blocks;
  assert.ok(both.length <= 100);
  const ids = controls(both).map((el) => el.action_id);
  assert.equal(new Set(ids).size, ids.length);
  const blockIds = both.map((block) => block.block_id).filter(Boolean);
  assert.equal(new Set(blockIds).size, blockIds.length);
  assert.ok(blockIds.every((id) => id.length <= 255));
  // The harness select still names the HARNESS while the stored engine is one of its licenses.
  const stored = await agentView("lic-two", { engine: work, licensePool: [second] });
  assert.equal(byAction(stored.view.blocks, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID).initial_option.value, "codex");
  assert.equal(byAction(stored.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.license).initial_option.value, work);
  const storedAlso = byAction(stored.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.also);
  assert.deepEqual(optionValues(storedAlso), ["codex", second]);
  assert.deepEqual(storedAlso.initial_options.map((o) => o.value), [second]);
  assert.equal(stored.scopes.channel.selection, "Codex · Work ChatGPT, then Second seat");

  // "Any license": nothing to add beside it.
  const any = await agentView("lic-two", { engine: "codex", licensePool: "any" });
  assert.equal(byAction(any.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.license).initial_option.value, "any");
  assert.equal(byAction(any.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.also), undefined);
  assert.equal(any.scopes.channel.selection, "Codex · any license");

  // The other harness still has one license: no license control there, and none while the
  // channel follows the inherited default (no harness chosen at this level).
  const claude = await agentView("lic-two", { engine: "claude" });
  assert.equal(byAction(claude.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.license), undefined);
  const inherited = await agentView("lic-two", {});
  assert.equal(byAction(inherited.view.blocks, RUNTIME_LICENSE_ACTION_IDS.channel.license), undefined);

  // The new controls dispatch to the same scope router as the three existing selects.
  assert.deepEqual(runtimeSelectTarget(RUNTIME_LICENSE_ACTION_IDS.channel.license), { scope: "channel", field: "license" });
  assert.deepEqual(runtimeSelectTarget(RUNTIME_LICENSE_ACTION_IDS.thread.also), { scope: "thread", field: "also" });
});

test("a license pick resolves to the engine and pool every level stores", () => {
  const { work, second } = twoLicenses();
  const current = { engine: work, licensePool: [second] };
  // "Any license" = the harness's own license + the pool "any".
  assert.deepEqual(nextLicenseSelection({ field: "license", value: "any", current, meta: {} }), { engine: "codex", licensePool: "any" });
  // Moving the first license keeps the others, minus the one that became first.
  assert.deepEqual(nextLicenseSelection({ field: "license", value: second, current, meta: {} }), { engine: second, licensePool: "" });
  assert.deepEqual(nextLicenseSelection({ field: "license", value: "codex", current, meta: {} }), { engine: "codex", licensePool: [second] });
  // "also use" replaces the list; emptied, the pool is gone.
  assert.deepEqual(nextLicenseSelection({ field: "also", also: ["codex", second], current, meta: {} }), { engine: work, licensePool: ["codex", second] });
  assert.deepEqual(nextLicenseSelection({ field: "also", also: [], current, meta: {} }), { engine: work, licensePool: "" });
  // A control left on screen after the level went back to its default, a license of the other
  // harness, and a license the channel's policy does not admit are refused.
  assert.throws(() => nextLicenseSelection({ field: "license", value: "any", current: { engine: "" }, meta: {} }), /Choose a harness/);
  assert.throws(() => nextLicenseSelection({ field: "also", also: ["claude"], current, meta: {} }), (error) => error.code === "invalid_license_pool");
  assert.throws(() => nextLicenseSelection({ field: "license", value: second, current, meta: { approvedEngines: ["claude", "codex", work] } }), (error) => error.code === "invalid_license_pool");
  // A harness name is a bare harness pick (the conversation's own selection for it); any other id
  // is exactly that license.
  assert.deepEqual(namedSelection("codex", { engine: work, licensePool: [second] }), { engine: work, licensePool: [second] });
  assert.deepEqual(namedSelection("codex", { engine: "claude" }), { engine: "codex", licensePool: "" });
  assert.deepEqual(namedSelection(second, { engine: work, licensePool: [second] }), { engine: second, licensePool: "" });
});

test("the /model wizard asks for the license and saves Any license as the harness default plus the pool any", async () => {
  const { work, second } = twoLicenses();
  const entry = await channel("C_LIC_WIZ", "lic-wizard");
  const client = wizardClient();
  const read = async () => { const meta = await getChannelMeta(entry.slug); return [meta.engine, meta.licensePool || ""]; };

  await click(client, "C_LIC_WIZ", { action_id: MODEL_WIZARD_SCOPE_CHANNEL_ACTION, value: wizardState("c", "") });
  // Step 2 lists harnesses — never a license.
  assert.deepEqual(controls(client.updates.at(-1).blocks).filter((el) => /^cg_mw_engine_(?!reset$)/.test(el.action_id)).map((el) => el.action_id), ["cg_mw_engine_claude", "cg_mw_engine_codex"]);
  await click(client, "C_LIC_WIZ", { action_id: "cg_mw_engine_codex", value: wizardState("c", "") });
  assert.deepEqual(await read(), ["codex", ""]);
  const step = client.updates.at(-1).blocks;
  assert.match(JSON.stringify(step), /Which Codex license\?/);
  assert.deepEqual(licenseButtons(step).map((el) => el.text.text), ["Any license", "✓ Default sign-in", "Work ChatGPT", "Second seat"]);
  assert.deepEqual(licenseButtons(step).map((el) => JSON.parse(el.value).v), ["any", "codex", work, second]);
  assert.equal(new Set(controls(step).map((el) => el.action_id)).size, controls(step).length, "action ids are unique in the message");

  // "Any license" has nothing more to ask: saved, and on to the model.
  await click(client, "C_LIC_WIZ", { action_id: "cg_mw_license_0", value: wizardState("c", "", "any") });
  assert.deepEqual(await read(), ["codex", "any"]);
  assert.match(card(client), /Choose a Codex model/);
  const back = controls(client.updates.at(-1).blocks).find((el) => MODEL_WIZARD_BACK_ACTION_PATTERN.test(el.action_id));
  assert.equal(back.action_id, "cg_mw_back_license");

  // Back to the license step, then a specific license: the card stays and offers the others.
  await click(client, "C_LIC_WIZ", { action_id: back.action_id, value: back.value });
  assert.match(card(client), /Current: `Codex · any license`/);
  assert.equal(byAction(client.updates.at(-1).blocks, MODEL_WIZARD_ALSO_ACTION), undefined, "nothing to add beside Any license");
  await click(client, "C_LIC_WIZ", { action_id: "cg_mw_license_2", value: wizardState("c", "", work) });
  assert.deepEqual(await read(), [work, ""]);
  const also = client.updates.at(-1).blocks.find((block) => block.accessory?.action_id === MODEL_WIZARD_ALSO_ACTION);
  assert.equal(also.accessory.type, "multi_static_select");
  assert.deepEqual(optionValues(also.accessory), ["codex", second]);
  assert.ok(also.block_id.length <= 255);

  // The multi-select carries the whole list on every dispatch; its state rides in the block id.
  await click(client, "C_LIC_WIZ", { action_id: MODEL_WIZARD_ALSO_ACTION, block_id: also.block_id, selected_options: [{ value: second }] });
  assert.deepEqual(await read(), [work, [second]]);
  assert.match(card(client), /Current: `Codex · Work ChatGPT, then Second seat`/);
  assert.deepEqual(byAction(client.updates.at(-1).blocks, MODEL_WIZARD_ALSO_ACTION).initial_options.map((o) => o.value), [second]);

  // Continue → model → effort → done; model and effort picks leave the selection alone.
  await click(client, "C_LIC_WIZ", { action_id: MODEL_WIZARD_LICENSE_DONE_ACTION, value: wizardState("c", "") });
  assert.match(card(client), /Choose a Work ChatGPT model/);
  await click(client, "C_LIC_WIZ", { action_id: `${MODEL_PICKER_ACTION}_0`, value: wizardState("c", "", "__default__") });
  await click(client, "C_LIC_WIZ", { action_id: `${EFFORT_PICKER_ACTION}_0`, value: wizardState("c", "", "__default__") });
  assert.deepEqual(await read(), [work, [second]]);
  assert.match(client.updates.at(-1).text, /Harness: Codex · Work ChatGPT, then Second seat\./);
  assert.equal(client.ephemerals.length, 0);

  // "Use defaults" clears the pool with the engine.
  await click(client, "C_LIC_WIZ", { action_id: "cg_mw_engine_reset", value: wizardState("c", "") });
  assert.deepEqual(await read(), ["", ""]);
  // A license button from a card that outlived its selection is refused, not guessed at.
  await click(client, "C_LIC_WIZ", { action_id: "cg_mw_license_0", value: wizardState("c", "", "any") });
  assert.deepEqual(await read(), ["", ""]);
  assert.equal(client.ephemerals.length, 1);
  assert.match(card(client), /Which harness\?/);
});

test("a thread pin carries its license pool", async () => {
  const { work, second } = twoLicenses();
  const entry = await channel("C_LIC_PIN", "lic-thread-pin", { engine: work, licensePool: [second] });
  const meta = await getChannelMeta(entry.slug);
  const thread = "1902000000.000300";
  const state = settingsState("C_LIC_PIN", entry.slug, thread);
  const pin = async () => [await getThreadEngine(entry.slug, thread), await getThreadLicensePool(entry.slug, thread)];
  const pick = (field, value, also) => applyThreadRuntimeSelection({ entry, meta, state, actorId: ADMIN, field, value, also });

  // Settings modal, thread row. Harness: the channel's selection for that harness comes along.
  const notice = await pick("engine", "codex");
  assert.deepEqual(await pin(), [work, [second]]);
  assert.match(notice, /This thread: \*Codex · Work ChatGPT, then Second seat\*/);
  const view = await agentView(entry.slug, meta, thread);
  assert.equal(byAction(view.view.blocks, CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID).initial_option.value, "codex");
  assert.equal(byAction(view.view.blocks, RUNTIME_LICENSE_ACTION_IDS.thread.license).initial_option.value, work);
  assert.deepEqual(byAction(view.view.blocks, RUNTIME_LICENSE_ACTION_IDS.thread.also).initial_options.map((o) => o.value), [second]);
  // "also use" replaces the list beside the same first license.
  await pick("also", "", ["codex", second]);
  assert.deepEqual(await pin(), [work, ["codex", second]]);
  // A model pick leaves the pin and its pool alone.
  const model = view.scopes.thread.options.models[0].value;
  await pick("model", model);
  assert.deepEqual(await pin(), [work, ["codex", second]]);
  assert.equal(await getThreadModel(entry.slug, thread), model);
  // License → "Any license".
  await pick("license", "any");
  assert.deepEqual(await pin(), ["codex", "any"]);

  // /model wizard, thread scope: picking the harness again keeps the thread's own selection.
  const client = wizardClient();
  await click(client, "C_LIC_PIN", { action_id: MODEL_WIZARD_SCOPE_THREAD_ACTION, value: wizardState("t", thread) });
  assert.match(card(client), /Current: `Codex · any license`/);
  await click(client, "C_LIC_PIN", { action_id: "cg_mw_engine_codex", value: wizardState("t", thread) });
  assert.deepEqual(await pin(), ["codex", "any"]);
  assert.match(card(client), /Which Codex license\?/);
  await click(client, "C_LIC_PIN", { action_id: "cg_mw_license_3", value: wizardState("t", thread, second) });
  const also = client.updates.at(-1).blocks.find((block) => block.accessory?.action_id === MODEL_WIZARD_ALSO_ACTION);
  await click(client, "C_LIC_PIN", { action_id: MODEL_WIZARD_ALSO_ACTION, block_id: also.block_id, selected_options: [{ value: work }] });
  assert.deepEqual(await pin(), [second, [work]]);
  const stored = await getChannelMeta(entry.slug);
  assert.deepEqual([stored.engine, stored.licensePool], [work, [second]], "a thread pick never touches the channel");
  assert.equal(client.ephemerals.length, 0);

  // Back to "Follow channel": the pin and its pool go together.
  await pick("engine", "");
  assert.deepEqual(await pin(), ["", ""]);

  // A channel pick made from inside a thread whose session another license started moves that
  // thread onto the chosen selection — pool included.
  const moved = "1902000000.000400";
  await saveSession(entry.slug, moved, "session-claude-lic", "claude");
  const inThread = wizardClient();
  await click(inThread, "C_LIC_PIN", { action_id: "cg_mw_engine_codex", value: wizardState("c", moved) });
  assert.deepEqual([await getThreadEngine(entry.slug, moved), await getThreadLicensePool(entry.slug, moved)], [work, [second]]);
});

test("a harness word in a message pins the channel's selection; a license id pins exactly that license", async () => {
  const { work, second } = twoLicenses();
  const USER = "U_LIC_DIRECTIVE", BOT = "BLICDIRECTIVE", CHANNEL = "D_LIC_DIRECTIVE";
  const messages = [];
  const client = {
    chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; }, update: async () => ({ ok: true }) },
    apiCall: async () => ({ ok: true }),
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Directive User" } }), list: async () => ({ members: [] }) },
    conversations: { info: async () => ({ channel: { id: CHANNEL, is_im: true } }), replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
  };
  await setUser(USER, { name: "Directive User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "lic-directive-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: work, licensePool: [second] });
  const spawned = runtime.calls.spawn.length;
  const say = (text, ts) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> ${text}`, ts }, client, { botUserId: BOT });
  const pin = async (ts) => [await getThreadEngine(entry.slug, ts), await getThreadLicensePool(entry.slug, ts)];

  // The harness word: the license and the further licenses this conversation chose for it.
  await say("codex", "1903.001");
  assert.deepEqual(await pin("1903.001"), [work, [second]]);
  assert.match(messages.at(-1).text, /This thread now uses \*Codex · Work ChatGPT, then Second seat\*/);
  // A license id: that license and nothing to move to.
  await say(second, "1903.002");
  assert.deepEqual(await pin("1903.002"), [second, ""]);
  assert.match(messages.at(-1).text, /This thread now uses \*Codex · Second seat\*/);
  // The other harness: its own license, no pool — the channel's Codex pool is not carried across.
  await say("claude", "1903.003");
  assert.deepEqual(await pin("1903.003"), ["claude", ""]);
  assert.match(messages.at(-1).text, /This thread now uses \*Claude Code\*/);
  // A thread already pinned to the other harness is moved the same way.
  await setThreadEngine(entry.slug, "1903.004", "claude");
  await say("codex", "1903.004");
  assert.deepEqual(await pin("1903.004"), [work, [second]]);
  // A thread already pinned to a license of the harness named keeps that license: the word names
  // the harness the thread is on, it does not hand the thread back to the channel's selection.
  await say("codex", "1903.002");
  assert.deepEqual(await pin("1903.002"), [second, ""]);
  assert.match(messages.at(-1).text, /This thread now uses \*Codex · Second seat\*/);
  assert.equal(runtime.calls.spawn.length, spawned, "a directive on its own starts no engine");
});

test("a pick outside the channel's allow list is answered, pins nothing and starts no engine", async () => {
  const { work, second } = twoLicenses();
  const USER = "U_LIC_ALLOW", BOT = "BLICALLOW", CHANNEL = "C_LIC_ALLOW";
  const messages = [];
  const client = {
    chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; }, update: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
    apiCall: async () => ({ ok: true }),
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Member" } }), list: async () => ({ members: [] }) },
    conversations: { info: async () => ({ channel: { id: CHANNEL, is_channel: true } }), replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
  };
  // An approved member who is not an admin: the allow list, not the person's role, bounds the pick.
  await setUser(USER, { name: "Member", approved: true, isAdmin: false });
  testLicenseEnv({ tier: "enterprise" });
  let entry;
  try { entry = await channel(CHANNEL, "lic-allow", { approvedEngines: ["harness:claude", work] }); } finally { testLicenseEnv(); }
  const say = (text, ts, extra = {}) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "channel", user: USER, text: `<@${BOT}> ${text}`, ts }, client, { botUserId: BOT, ...extra });
  const pin = async (ts) => [await getThreadEngine(entry.slug, ts), await getThreadLicensePool(entry.slug, ts), await getThreadModel(entry.slug, ts)];
  const refused = /^Second seat is not approved for this conversation\. Approved here: Claude Code \(any license\), Work ChatGPT\. /;
  const spawned = runtime.calls.spawn.length;

  // Inside the list: the harness word resolves to the one Codex license this channel may use.
  await say("codex", "1905.001");
  assert.deepEqual(await pin("1905.001"), [work, "", ""]);
  assert.match(messages.at(-1).text, /This thread now uses \*Codex\*/, "one usable license: the harness is the whole name");

  // Outside it: a license id on its own, and one followed by a task.
  for (const [text, ts] of [[second, "1905.002"], [`${second} summarize the README`, "1905.003"]]) {
    const before = messages.length;
    await say(text, ts);
    assert.equal(messages.length, before + 1, "exactly one answer");
    assert.match(messages.at(-1).text, refused);
    assert.equal(messages.at(-1).thread_ts, ts, "answered in the thread it was typed in");
    assert.deepEqual(await pin(ts), ["", "", ""]);
  }
  // A thread that already has a selection keeps it.
  await say(second, "1905.001");
  assert.match(messages.at(-1).text, refused);
  assert.deepEqual(await pin("1905.001"), [work, "", ""]);

  // A model shortcut naming a license outside the list (members may use shortcuts here).
  saveSettings({ modelShortcuts: { seat: { engine: second, model: "gpt-6.1-sol" } } });
  await say(":seat summarize the README", "1905.004");
  assert.match(messages.at(-1).text, refused);
  assert.deepEqual(await pin("1905.004"), ["", "", ""], "neither the license nor the shortcut's model is pinned");

  // The harness-switch card's "switch" choice.
  await say("summarize the README", "1905.005", { engineChoice: second, engineChoiceSwitch: true });
  assert.match(messages.at(-1).text, refused);
  assert.deepEqual(await pin("1905.005"), ["", "", ""]);

  // A whole harness outside the list names the harness.
  testLicenseEnv({ tier: "enterprise" });
  try { await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), approvedEngines: ["claude"] }); } finally { testLicenseEnv(); }
  await say("codex summarize the README", "1905.006");
  assert.match(messages.at(-1).text, /^Codex is not approved for this conversation\. Approved here: Claude\. Pick one of those/);
  assert.deepEqual(await pin("1905.006"), ["", "", ""]);

  assert.equal(runtime.calls.spawn.length, spawned, "a refused pick never runs the message on another license");
  saveSettings({ modelShortcuts: {} });
});

test("a fork keeps the license selection of the thread it was forked from", async () => {
  const { work, second } = twoLicenses();
  const entry = await channel("C_LIC_FORK", "lic-fork", { engine: "codex", licensePool: "any" });
  const meta = await getChannelMeta(entry.slug);
  const slug = entry.slug;
  const source = "1904000000.000100";

  // A pinned source: its own pool travels, in order, minus the license the fork starts on.
  await setThreadEngine(slug, source, work, { licensePool: [second, "codex"] });
  assert.deepEqual(await forkLicensePool({ slug, sourceThreadTs: source, engine: work, meta }), [second, "codex"]);
  // The session already moved to a later license of the selection: the fork starts there and
  // keeps the others.
  assert.deepEqual(await forkLicensePool({ slug, sourceThreadTs: source, engine: second, meta }), [work, "codex"]);
  // A license outside the pinned selection, or the other harness, carries nothing.
  await setThreadEngine(slug, source, work, { licensePool: [second] });
  assert.equal(await forkLicensePool({ slug, sourceThreadTs: source, engine: "codex", meta }), "");
  assert.equal(await forkLicensePool({ slug, sourceThreadTs: source, engine: "claude", meta }), "");
  // An unpinned source follows the conversation's selection for that harness.
  assert.equal(await forkLicensePool({ slug, sourceThreadTs: "1904000000.000200", engine: "codex", meta }), "any");
  assert.equal(await forkLicensePool({ slug, sourceThreadTs: "1904000000.000200", engine: "codex", meta: { engine: "claude" } }), "");

  // The fork thread is pinned with the pool it was handed.
  let next = 1905;
  const client = {
    chat: { postMessage: async () => ({ ts: `${++next}.000001` }), getPermalink: async () => ({ permalink: "https://slack.test/p1" }) },
    apiCall: async () => ({ ok: true }),
  };
  const licensePool = await forkLicensePool({ slug, sourceThreadTs: source, engine: work, meta });
  const fork = await createForkThread(client, {
    channelId: "C_LIC_FORK", slug, sourceThreadTs: source, authorId: ADMIN, botUserId: "UBOT", title: "Side topic", activityTitle: "Fork: Side topic",
    sourceUrl: "https://slack.test/p1", engine: work, licensePool, model: "", effort: "", clean: false,
  });
  assert.equal(await getThreadEngine(slug, fork.forkKey), work);
  assert.deepEqual(await getThreadLicensePool(slug, fork.forkKey), [second]);
});

test("the ask card names every license that was tried and still offers only the other harness", () => {
  const { work, second } = twoLicenses();
  const ask = { failedEngine: work, otherEngine: "claude", kind: "usage_limit", alsoFailed: [second, "codex"] };
  assert.equal(
    engineSwitchChoiceText(ask),
    "⚠️ Work ChatGPT hit its usage limit, and Second seat and Codex could not answer either. Nothing ran for your message. Switch this thread to Claude, or try Work ChatGPT again?",
  );
  assert.deepEqual(engineSwitchChoiceBlocks("ask-1", ask)[1].elements.map((b) => b.text.text), ["Switch to Claude", "Try Work ChatGPT again"]);
  // Everything failed, the other harness included: it is named once, last.
  const both = { ...ask, bothFailed: true, alsoFailed: [second, "claude"] };
  assert.match(engineSwitchChoiceText(both), /Work ChatGPT hit its usage limit, and Second seat and Claude could not answer either/);
  assert.deepEqual(engineSwitchChoiceBlocks("ask-2", both)[1].elements.map((b) => b.text.text), ["Try Work ChatGPT again", "Try Claude again"]);
  // No pool: the sentence is the one the card always had.
  assert.equal(engineSwitchChoiceText({ failedEngine: "codex", otherEngine: "claude", kind: "usage_limit" }), "⚠️ Codex hit its usage limit. Nothing ran for your message. Switch this thread to Claude, or try Codex again?");
});

test("labels typed by an admin are cut to what Slack accepts", () => {
  assert.equal(clipLabel("Short"), "Short");
  const long = clipLabel(`${"W".repeat(70)}${"😀".repeat(10)}`);
  assert.ok(long.length <= 75);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(long, /[\uD800-\uDBFF]…$/, "never cut inside a surrogate pair");
  // A long license label reaches every control clipped, never over the 75-character limit.
  reset();
  const label = "Enterprise seat for the platform team in the Frankfurt region".slice(0, 60);
  const license = createLicense({ kind: "codex-login", label, type: "enterprise" });
  signIn(license.id);
  const blocks = modelWizardLicenseBlocks({ scope: "channel", threadTs: "1906000000.000100", meta: {}, engine: license.id, pool: "" });
  for (const el of controls(blocks)) {
    if (el.text) assert.ok(el.text.text.length <= 75, el.text.text);
    for (const option of el.options || []) assert.ok(option.text.text.length <= 75);
  }
  assert.match(JSON.stringify(modelWizardEngineBlocks({ scope: "channel", threadTs: "", meta: { engine: license.id } })), /Current: `Codex · Enterprise seat/);
  reset();
});
