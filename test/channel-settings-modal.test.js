import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

import {
  buildCatalogManagerView,
  buildChannelSettingsView,
  buildConnectionsEditorView,
  buildTemplateEditorView,
  maskedCredential,
  actionValue,
  parseActionValue,
  settingsCommand,
  parseEditorMetadata,
  parseSettingsMetadata,
  readConnectionsForm,
  readTemplateForm,
  CHANNEL_SETTINGS_ACTION_ID,
  CHANNEL_SETTINGS_ACTION_PATTERN,
  CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX,
  CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID,
  CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID,
  CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID,
  CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID,
  CHANNEL_SETTINGS_THREAD_EFFORT_ACTION_ID,
  CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID,
  CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID,
  CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID,
  CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID,
  CHANNEL_SETTINGS_TEMPLATE_SELECT_ACTION_ID,
  CHANNEL_SETTINGS_TABS,
  CHANNEL_SETTINGS_TAB_SELECT_ACTION_ID,
  CONNECTION_COMPOSIO_ACTION_ID,
  CONNECTION_COMPOSIO_BLOCK_ID,
  CONNECTION_COMPOSIO_LABEL_ACTION_ID,
  CONNECTION_COMPOSIO_LABEL_BLOCK_ID,
  CONNECTION_MAKE_KEY_ACTION_ID,
  CONNECTION_MAKE_KEY_BLOCK_ID,
  CONNECTION_MAKE_URL_ACTION_ID,
  CONNECTION_MAKE_URL_BLOCK_ID,
  CONNECTION_TOOLBOX_ACTION_ID,
  CONNECTION_TOOLBOX_BLOCK_ID,
  RUNTIME_EFFORT_ACTION_ID,
  runtimeSelectTarget,
  SETTINGS_DEFAULT_VALUE,
  SETTINGS_NONE_VALUE,
  TEMPLATE_ACTION_ID,
  TEMPLATE_BLOCK_ID,
} from "../src/slack/channel-settings.js";
import { footerButtons, settingsButton } from "../src/slack/footer.js";
import { CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID, CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID } from "../src/slack/channel-settings.js";

const [{ channelSettingsContext, channelSettingsEditOptions, secretsContext, cloudSelectionsAfterToggle, connectionSettingsPatch, runtimeSettingsPatch, nextRuntimeTriple, runtimeScopes, applyThreadRuntimeSelection }, store] = await Promise.all([
  import("../src/slack/app.js"),
  import("../src/config/store.js"),
]);

const state = {
  channelId: "C_SETTINGS",
  slug: "settings-channel",
  threadTs: "1700000000.000100",
  ownerId: "U_MANAGER",
};

const snapshot = {
  runtime: {
    configuredEngineId: "",
    configuredEngine: "",
    effectiveEngineId: "claude",
    effectiveEngine: "Claude",
    gatewayEngineId: "claude",
    gatewayEngineLabel: "Claude",
    configuredModel: "claude-opus-4-8",
    gatewayModel: "claude-sonnet-4-6",
    configuredEffort: "high",
    scopes: {
      channel: {
        values: { engine: "", model: "claude-opus-4-8", effort: "high" },
        inherited: { engine: "Inherited default (Claude)", model: "Inherited default (claude-sonnet-4-6)", effort: "Engine default" },
        options: {
          engines: [{ label: "Claude", value: "claude" }, { label: "Codex", value: "codex" }],
          models: [{ label: "Opus 4.8", value: "claude-opus-4-8" }],
          efforts: [{ label: "High", value: "high" }],
        },
      },
      thread: {
        values: { engine: "codex", model: "", effort: "" },
        pinned: true,
        sessionEngineLabel: "",
        inherited: { engine: "Follow channel (Claude)", model: "Follow channel (gpt-5.6-sol)", effort: "Follow channel (engine default)" },
        options: {
          engines: [{ label: "Claude", value: "claude" }, { label: "Codex", value: "codex" }],
          models: [{ label: "GPT-5.6", value: "gpt-5.6-sol" }],
          efforts: [{ label: "High", value: "high" }],
        },
      },
    },
  },
  connections: {
    composioMode: "personal",
    composioChannel: { configured: true, last4: "c123" },
    composioOrg: { configured: true, last4: "o123" },
    toolboxChannel: { configured: false, last4: "" },
    toolboxOrg: { configured: true, last4: "t123" },
    makeToolboxUrl: "https://example.test/mcp",
    makeToolboxKey: { configured: true, last4: "m123" },
    noDefaultTokens: false,
  },
  cloudMcp: {
    claude: { channel: [{ name: "github" }], organization: [{ name: "drive" }] },
    codex: { channel: [{ name: "figma" }], organization: [] },
  },
  skills: {
    template: "Development",
    templateSlug: "development",
    templates: [
      { slug: "development", name: "Development", description: "Build software" },
      { slug: "support", name: "Support", description: "Answer customers" },
    ],
    additional: ["pdf"],
    channel: ["development", "pdf"],
    organization: ["gateway-usage"],
    effective: ["gateway-usage", "development", "pdf"],
  },
  secrets: [{ name: "SUPABASE_ACCESS_TOKEN", last4: "beef", setBy: "<@U_MANAGER>", setAt: Date.UTC(2026, 8, 7), provider: "local", resolvable: true }],
  resume: {
    inThread: true,
    sessionId: "994f6108-b405-4bbe-b96d-1641051df2fa",
    engine: "claude",
    workDir: "/home/agent/ChannelGate/slack/settings-channel",
    command: 'cd "/home/agent/ChannelGate/slack/settings-channel" && claude --resume 994f6108-b405-4bbe-b96d-1641051df2fa',
  },
};

const allButtons = (view) => view.blocks.flatMap((block) => block.elements || []).filter((item) => item.type === "button");
const tabRow = (view) => view.blocks.find((block) => block.block_id === "cg_channel_settings_tabs");
// Every count below is about the controls that save something; the tab row is navigation.
const selects = (view) => view.blocks.filter((block) => block.accessory?.type === "static_select");
// Every interactive element on a page, whether it is a section accessory or sits in an actions row.
const elements = (view) => view.blocks.flatMap((block) => [...(block.accessory ? [block.accessory] : []), ...(block.elements || [])]);
const byActionId = (view, id) => elements(view).find((element) => element.action_id === id);
const rendered = (view) => JSON.stringify(view);

test("Settings footer button is requester-bound, or unbound on an author-less post", () => {
  assert.equal(settingsButton("", "1.1", "U1"), null);

  const button = settingsButton("C1", "1.1", "U1");
  assert.equal(button.action_id, CHANNEL_SETTINGS_ACTION_ID);
  assert.equal(button.text.text, "⚙️ Settings");
  assert.deepEqual(parseActionValue(button.value), { o: "open", c: "C1", t: "1.1", u: "U1" });
  // An automation post has no requester: the button opens under whoever clicks it.
  assert.deepEqual(parseActionValue(settingsButton("C1", "", "").value), { o: "open", c: "C1", t: "", u: "" });
});

test("every reply footer carries the same fixed menu: Files, Variables, Settings — no Resume", () => {
  for (const authorId of ["U1", ""]) {
    const buttons = footerButtons(
      { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
      { channel: "C1", threadTs: "1.1", authorId },
    );
    // The 💻 resume control moved into Settings → Resume Session; footers no longer carry it.
    assert.deepEqual(buttons.map((button) => button.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
    assert.equal(buttons.some((button) => button.action_id === "resume_cmd_modal"), false);
  }
});

test("Settings pages are one dropdown on the first line, with the open page selected", () => {
  const view = buildChannelSettingsView(snapshot, state, { channelName: "project-alpha", tab: "mcp", canManageCloudMcp: true, canEditAccess: true });
  const nav = tabRow(view);
  assert.equal(view.blocks.indexOf(nav), 0, "navigation is the first line");
  // Slack lays out a modal's button rows as a two-column grid, so seven tab buttons would be four
  // rows tall; one dropdown beside the conversation name is one line.
  assert.equal(nav.accessory.type, "static_select");
  assert.equal(nav.accessory.action_id, CHANNEL_SETTINGS_TAB_SELECT_ACTION_ID);
  assert.match(nav.text.text, /<#C_SETTINGS>/);
  assert.deepEqual(nav.accessory.options.map((entry) => parseActionValue(entry.value).p), [...CHANNEL_SETTINGS_TABS]);
  assert.deepEqual(nav.accessory.options.map((entry) => entry.text.text), ["Agent", "Access", "MCP", "Variables", "Skills", "Schedules", "You"]);
  assert.equal(parseActionValue(nav.accessory.initial_option.value).p, "mcp");
  assert.equal(view.close.text, "Done");
  assert.equal(view.submit, undefined, "no form open, no submit");
  assert.doesNotMatch(rendered(view), /changes apply to the next turn/i);
  assert.deepEqual(parseSettingsMetadata(view.private_metadata), { ...state, tab: "mcp", form: "", confirm: "", memberPage: 0, memberFocus: "" });
  // A DM has one member, so it has no Access page.
  const dm = tabRow(buildChannelSettingsView({ ...snapshot, isDM: true }, state, { tab: "access" }));
  assert.equal(dm.accessory.options.some((entry) => parseActionValue(entry.value).p === "access"), false);
  assert.equal(parseActionValue(dm.accessory.initial_option.value).p, "agent");
});

test("a settings control's command is read from a button value or from the picked option", () => {
  const option = tabRow(buildChannelSettingsView(snapshot, state, { tab: "agent" })).accessory.options[2];
  assert.deepEqual(settingsCommand({ selected_option: { value: option.value } }), { o: "tab", p: "mcp" });
  // A tab button from a view opened before the dropdown came back routes through the same command.
  assert.deepEqual(settingsCommand({ value: actionValue("tab", { c: state.channelId, u: state.ownerId, p: "skills" }) }), { o: "tab", c: state.channelId, u: state.ownerId, p: "skills" });
  // A runtime dropdown's bare model id is not a command, and neither is a missing control.
  assert.deepEqual(settingsCommand({ selected_option: { value: "claude-opus-4-8" } }), {});
  assert.deepEqual(settingsCommand({}), {});
  assert.deepEqual(settingsCommand(undefined), {});
});

test("Agent holds this thread's and the channel's runtime rows, the mode and the VPN line", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "agent", canEditRuntime: true, canEditAccess: true, canManageVpn: true });
  const text = rendered(view);
  assert.match(text, /\*This thread\* · 📌 pinned/);
  assert.match(text, /\*Channel default\*/);
  // The thread row comes first: opened from a thread, that is what is usually changed.
  const threadRow = view.blocks.findIndex((block) => block.block_id === "cg_runtime_thread");
  const channelRow = view.blocks.findIndex((block) => block.block_id === "cg_runtime_channel");
  assert.ok(threadRow > 0 && threadRow < channelRow);
  assert.equal(byActionId(view, "cg_channel_settings_access_field_mode").type, "static_select", "mode is a dropdown in the same style");
  assert.equal(byActionId(view, "cg_channel_settings_access_field_flags").type, "checkboxes");
  assert.deepEqual(byActionId(view, "cg_channel_settings_access_field_flags").options.map((entry) => entry.text.text), ["Auto-approve", "Lean", "Internet"]);
  // `vpn` absent = a provisioned service still being read; an unprovisioned one is one plain line.
  assert.match(text, /VPN\* — Checking status/);
  assert.match(rendered(buildChannelSettingsView({ ...snapshot, vpn: { configured: false, state: "unconfigured" } }, state, { tab: "agent" })), /VPN · Not configured/);
  assert.doesNotMatch(text, /cg_channel_settings_access_field_allowedUsers/, "people live on Access now");
  // Every legacy page id lands on the page that owns its controls now.
  for (const [legacy, page] of [["general", "agent"], ["runtime", "agent"], ["network", "agent"], ["resume", "agent"], ["secrets", "variables"], ["automations", "schedules"], ["nonsense", "agent"]]) {
    assert.equal(parseSettingsMetadata(buildChannelSettingsView(snapshot, state, { tab: legacy }).private_metadata).tab, page, legacy);
  }
});

test("each Settings page renders its part of the channel setup", () => {
  const skills = buildChannelSettingsView({ ...snapshot, skillPicker: { options: [{ key: "pdf", label: "pdf" }, { key: "eli5", label: "eli5" }], selected: ["pdf"] } }, state, { tab: "skills" });
  assert.match(rendered(skills), /Development/);
  const picker = byActionId(skills, "cg_channel_settings_skills_select");
  assert.equal(picker.type, "multi_static_select");
  assert.deepEqual(picker.initial_options.map((entry) => entry.value), ["pdf"]);
  assert.match(rendered(skills), /Always on from the organization \(1\)/);
  assert.doesNotMatch(rendered(skills), /All Shared Skills|Manage Channel Skills/, "no duplicate lists, no pushed manager");

  const secretsView = buildChannelSettingsView({ ...snapshot, secrets: [{ name: "SUPABASE_ACCESS_TOKEN", last4: "beef", protected: true, hosts: ["api.supabase.com"] }] }, state, { tab: "variables", canEditSecrets: true });
  const secrets = rendered(secretsView);
  assert.match(secrets, /SUPABASE_ACCESS_TOKEN/);
  assert.match(secrets, /••beef/);
  assert.match(secrets, /🔒 api.supabase.com/);
  assert.doesNotMatch(secrets, /actual-secret-value/);
  const menu = byActionId(secretsView, "cg_channel_settings_var_menu");
  assert.equal(menu.type, "overflow");
  assert.deepEqual(menu.options.map((entry) => entry.text.text), ["Replace value", "Allowed servers", "Make readable", "Remove"]);
  for (const heading of ["Channel · 1", "Organization · 0"]) assert.ok(secretsView.blocks.some((block) => block.type === "header" && block.text.text === heading), heading);
  // Organization variables are admin-only to add; personal ones moved to You.
  assert.equal(elements(secretsView).filter((element) => element.action_id === "cg_channel_settings_form_open").map((element) => parseActionValue(element.value).f).join(","), "var-add:c");
  const orgAdmin = buildChannelSettingsView(snapshot, state, { tab: "variables", canEditSecrets: true, canEditOrgSecrets: true });
  assert.ok(elements(orgAdmin).some((element) => parseActionValue(element.value).f === "var-add:o"));
  assert.match(secrets, /Your personal variables are under \*You\*/);

  const mcp = buildChannelSettingsView(snapshot, state, { tab: "mcp" });
  const forms = elements(mcp).filter((element) => element.action_id === "cg_channel_settings_form_open").map((element) => parseActionValue(element.value).f);
  assert.deepEqual(forms, ["composio:c", "make:c", "toolbox:c"], "Composio, Make toolbox and Toolbox each edit in place");
  for (const heading of ["Composio", "Make toolbox", "Toolbox", "Custom MCP"]) assert.ok(mcp.blocks.some((block) => block.type === "header" && block.text.text === heading), heading);
});

test("Agent shows this thread's resume command, escaped, and nothing outside a thread or session", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "agent" });
  const text = rendered(view);
  // The command is escaped like every other value in this modal, so a channel-configurable work
  // folder can never smuggle Slack control markup into the card.
  assert.match(text, /Resume in a terminal/);
  assert.match(text, /```cd .*settings-channel.* &amp;&amp; claude --resume 994f6108-b405-4bbe-b96d-1641051df2fa```/);
  assert.doesNotMatch(rendered(buildChannelSettingsView({ ...snapshot, resume: { inThread: true, command: "" } }, state, { tab: "agent" })), /Resume in a terminal/);
  assert.doesNotMatch(rendered(buildChannelSettingsView({ ...snapshot, resume: { inThread: false, command: "" } }, state, { tab: "agent" })), /Resume in a terminal/);
});

test("Agent edits the channel default and the thread pin in place, one row of dropdowns per scope", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "agent", canEditRuntime: true });
  assert.equal(view.submit, undefined);
  assert.equal(view.blocks.some((block) => block.type === "input"), false);
  const row = (scope) => view.blocks.find((block) => block.block_id === `cg_runtime_${scope}`).elements;
  assert.deepEqual(row("channel").map((element) => element.action_id), [CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID, RUNTIME_EFFORT_ACTION_ID]);
  assert.deepEqual(row("thread").map((element) => element.action_id), [CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID, CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID, CHANNEL_SETTINGS_THREAD_EFFORT_ACTION_ID, CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID]);
  const byAction = Object.fromEntries([...row("channel"), ...row("thread")].map((element) => [element.action_id, element]));
  // Stored values preselect themselves; an unset field preselects what it inherits.
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID].initial_option.value, "claude-opus-4-8");
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID].initial_option.value, SETTINGS_DEFAULT_VALUE);
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID].initial_option.text.text, "Inherited default (Claude) (default)");
  assert.equal(byAction[CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID].initial_option.value, "codex");
  // The thread's model catalog follows the harness the THREAD runs, not the channel's.
  assert.deepEqual(byAction[CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID].options.map((item) => item.value), [SETTINGS_DEFAULT_VALUE, "gpt-5.6-sol"]);
  for (const [actionId, expected] of [
    [CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, { scope: "channel", field: "engine" }],
    [RUNTIME_EFFORT_ACTION_ID, { scope: "channel", field: "effort" }],
    [CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID, { scope: "thread", field: "model" }],
  ]) assert.deepEqual(runtimeSelectTarget(actionId), expected);
  assert.equal(runtimeSelectTarget(CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID), null);
  // A member under a runtime-change policy reads the values instead.
  const locked = buildChannelSettingsView(snapshot, state, { tab: "agent", canEditRuntime: false });
  assert.equal(locked.blocks.some((block) => String(block.block_id || "").startsWith("cg_runtime_")), false);
  assert.match(rendered(locked), /limits engine changes to admins/);
});

test("Agent shows only the channel row until Settings is opened from a thread", () => {
  const withoutThread = { ...snapshot, runtime: { ...snapshot.runtime, scopes: { ...snapshot.runtime.scopes, thread: null } } };
  const view = buildChannelSettingsView(withoutThread, state, { tab: "agent", canEditRuntime: true });
  assert.equal(view.blocks.some((block) => block.block_id === "cg_runtime_thread"), false);
  assert.doesNotMatch(rendered(view), /This thread/);
  assert.equal(elements(view).some((element) => element.action_id === CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID), false);
});

test("a stored value outside the engine catalog stays visible instead of silently reading as the default", () => {
  const retired = { ...snapshot, runtime: { ...snapshot.runtime, scopes: {
    ...snapshot.runtime.scopes,
    channel: { ...snapshot.runtime.scopes.channel, values: { engine: "", model: "claude-opus-4-1-retired", effort: "" } },
  } } };
  const model = byActionId(buildChannelSettingsView(retired, state, { tab: "agent", canEditRuntime: true }), CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID);
  assert.equal(model.initial_option.value, "claude-opus-4-1-retired");
  assert.equal(model.initial_option.text.text, "claude-opus-4-1-retired");
});

test("one runtime dropdown at a time, dropping only the dependents its new value invalidates", () => {
  // A model names one specific harness, so a harness change always drops it; an effort survives
  // only while the harness the thread moved to still offers it for the model it now runs.
  assert.deepEqual(
    nextRuntimeTriple({ engine: "codex", model: "gpt-5.6-sol", effort: "ultra" }, "engine", "claude", "claude"),
    { engine: "claude", model: "", effort: "" },
  );
  assert.deepEqual(
    nextRuntimeTriple({ engine: "claude", model: "claude-opus-4-8", effort: "high" }, "engine", "codex", "claude"),
    { engine: "codex", model: "", effort: "high" },
  );
  // Choosing a model on the same harness keeps the engine untouched.
  assert.equal(nextRuntimeTriple({ engine: "codex", model: "", effort: "" }, "model", "gpt-5.6-sol", "claude").engine, "codex");
  // The inherit sentinel clears the field, and an empty engine falls back to the scope's parent.
  assert.deepEqual(
    nextRuntimeTriple({ engine: "", model: "claude-opus-4-8", effort: "" }, "engine", SETTINGS_DEFAULT_VALUE, "codex"),
    { engine: "", model: "", effort: "" },
  );
});

test("connection editor never prefills saved credentials and parses only newly submitted values", () => {
  const view = buildConnectionsEditorView(snapshot.connections, state, { channelName: "project-alpha" });
  const json = rendered(view);
  assert.doesNotMatch(json, /c123|o123|t123|m123/);
  assert.match(json, /https:\/\/example\.test\/mcp/);

  const submitted = {
    state: { values: {
      [CONNECTION_COMPOSIO_BLOCK_ID]: { [CONNECTION_COMPOSIO_ACTION_ID]: { value: "new-composio" } },
      [CONNECTION_TOOLBOX_BLOCK_ID]: { [CONNECTION_TOOLBOX_ACTION_ID]: { value: "new-toolbox" } },
      [CONNECTION_MAKE_URL_BLOCK_ID]: { [CONNECTION_MAKE_URL_ACTION_ID]: { value: "https://eu1.make.celonis.com/mcp/server/abc" } },
      [CONNECTION_MAKE_KEY_BLOCK_ID]: { [CONNECTION_MAKE_KEY_ACTION_ID]: { value: "new-make-key" } },
    } },
  };
  assert.deepEqual(readConnectionsForm(submitted), {
    composioToken: "new-composio",
    toolboxToken: "new-toolbox",
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/abc",
    makeToolboxKey: "new-make-key",
  });
});

test("Composio labels round-trip independently of write-only tokens, including old forms", () => {
  const current = { composioToken: "saved-private-credential", composioTokenLabel: "Shared account" };
  const connections = { ...snapshot.connections, composioTokenLabel: current.composioTokenLabel };
  const view = buildConnectionsEditorView(connections, state);
  const labelInput = view.blocks.find((block) => block.block_id === CONNECTION_COMPOSIO_LABEL_BLOCK_ID).element;
  assert.equal(labelInput.initial_value, "Shared account");
  assert.equal(view.blocks.find((block) => block.block_id === CONNECTION_COMPOSIO_BLOCK_ID).element.initial_value, undefined);
  assert.doesNotMatch(rendered(view), /saved-private-credential|c123/);
  assert.match(rendered(buildChannelSettingsView({ connections }, state, { tab: "mcp" })), /Shared account/);
  for (const value of ["  Renamed account  ", "", null]) {
    const form = readConnectionsForm({ state: { values: {
      [CONNECTION_COMPOSIO_LABEL_BLOCK_ID]: { [CONNECTION_COMPOSIO_LABEL_ACTION_ID]: { value } },
    } } });
    const result = connectionSettingsPatch(current, form);
    assert.deepEqual(result.errors, {});
    assert.equal(result.patch.composioTokenLabel, String(value || "").trim());
    assert.equal(Object.hasOwn(result.patch, "composioToken"), false);
    assert.equal({ ...current, ...result.patch }.composioToken, current.composioToken);
    assert.ok(result.changed.includes("Composio label"));
  }
  const legacy = connectionSettingsPatch(current, readConnectionsForm({ state: { values: {} } }));
  assert.equal(Object.hasOwn(legacy.patch, "composioTokenLabel"), false);
});

test("catalog managers paginate and only allow direct grants to be deactivated", () => {
  const items = [
    { key: "direct", name: "Direct", direct: true, active: true },
    { key: "org", name: "Organization", inherited: true, active: true },
    { key: "off", name: "Inactive", active: false },
  ];
  const view = buildCatalogManagerView(items, state, { kind: "cloud", channelName: "project-alpha", engine: "claude" });
  const controls = view.blocks.map((block) => block.accessory).filter((button) => button?.action_id?.startsWith(CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX));
  assert.equal(controls.length, 2);
  assert.equal(controls.find((button) => parseActionValue(button.value).k === "direct").text.text, "Deactivate");
  assert.equal(controls.find((button) => parseActionValue(button.value).k === "off").text.text, "Activate");
  assert.equal(controls.some((button) => parseActionValue(button.value).k === "org"), false);
});

test("the skill template is picked in place, with no second modal to open", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "skills" });
  const picker = byActionId(view, CHANNEL_SETTINGS_TEMPLATE_SELECT_ACTION_ID);
  assert.ok(picker, "the Skills page carries the template dropdown itself");
  assert.equal(picker.initial_option.value, "development");
  assert.deepEqual(picker.options.map((o) => o.value), [SETTINGS_NONE_VALUE, "development", "support"]);
  assert.equal(elements(view).some((element) => element.action_id === CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID), false);
});

test("with no templates defined the Skills page says so", () => {
  const view = buildChannelSettingsView({ ...snapshot, skills: { ...snapshot.skills, template: "", templateSlug: "", templates: [] } }, state, { tab: "skills" });
  assert.equal(elements(view).some((element) => element.action_id === CHANNEL_SETTINGS_TEMPLATE_SELECT_ACTION_ID), false);
  assert.match(rendered(view), /none defined/);
});

test("template editor supports clearing and selecting a live template", () => {
  const view = buildTemplateEditorView([{ slug: "development", name: "Development", description: "Build software" }], "development", state);
  assert.equal(view.blocks.find((block) => block.block_id === TEMPLATE_BLOCK_ID).element.initial_option.value, "development");
  assert.equal(readTemplateForm({ state: { values: { [TEMPLATE_BLOCK_ID]: { [TEMPLATE_ACTION_ID]: { selected_option: { value: SETTINGS_NONE_VALUE } } } } } }), SETTINGS_NONE_VALUE);
});

test("Settings action matcher covers editor controls but not unrelated Slack actions", () => {
  for (const id of [CHANNEL_SETTINGS_ACTION_ID, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, `${CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX}0`]) {
    assert.match(id, CHANNEL_SETTINGS_ACTION_PATTERN);
  }
  assert.doesNotMatch("cg_channel_secrets_add", CHANNEL_SETTINGS_ACTION_PATTERN);
  assert.equal(SETTINGS_DEFAULT_VALUE, "__default__");
});

test("runtime mutation validation rejects cross-engine models and normalizes defaults", () => {
  assert.deepEqual(runtimeSettingsPatch({
    engine: SETTINGS_DEFAULT_VALUE,
    model: SETTINGS_DEFAULT_VALUE,
    effort: SETTINGS_DEFAULT_VALUE,
  }, { gatewayEngine: "claude", enabledEngines: ["claude", "codex"] }), {
    patch: { engine: "", model: "", effort: "" },
    actualEngine: "claude",
  });
  assert.throws(
    () => runtimeSettingsPatch({ engine: "codex", model: "opus", effort: SETTINGS_DEFAULT_VALUE }, { gatewayEngine: "claude", enabledEngines: ["claude", "codex"] }),
    /does not belong/i,
  );
});

test("blank connection inputs preserve stored tokens while explicit values rotate only their own fields", () => {
  const current = {
    composioToken: "old-composio",
    toolboxToken: "old-toolbox",
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/current",
    makeToolboxKey: "old-make-key",
  };
  const unchanged = connectionSettingsPatch(current, {
    composioToken: "",
    toolboxToken: "",
    makeToolboxUrl: current.makeToolboxUrl,
    makeToolboxKey: "",
  });
  assert.deepEqual(unchanged.patch, { makeToolboxUrl: current.makeToolboxUrl, makeToolboxKey: current.makeToolboxKey });
  assert.deepEqual(unchanged.changed, []);

  const rotated = connectionSettingsPatch(current, {
    composioToken: "new-composio",
    toolboxToken: "",
    makeToolboxUrl: current.makeToolboxUrl,
    makeToolboxKey: "",
  });
  assert.equal(rotated.patch.composioToken, "new-composio");
  assert.equal(rotated.patch.toolboxToken, undefined);
  assert.deepEqual(rotated.changed, ["Composio"]);
});

test("Cloud MCP toggles replace one matching selection without duplicating other grants", () => {
  const current = [
    { id: "github", name: "GitHub", kind: "tool-group", serverName: "codex_apps", toolPrefix: "github" },
    { id: "figma", name: "Figma", kind: "tool-group", serverName: "codex_apps", toolPrefix: "figma" },
  ];
  const github = { id: "github", name: "GitHub", kind: "tool-group", serverName: "codex_apps", toolPrefix: "github" };
  assert.deepEqual(cloudSelectionsAfterToggle(current, "codex", "tool-group:github", { activate: false }), [current[1]]);
  assert.deepEqual(cloudSelectionsAfterToggle([current[1]], "codex", "tool-group:github", { activate: true, selection: github }), [current[1], github]);
});

test("the Resume Session tab renders the live session resolved from the store", async () => {
  const { resolveResumeSession } = await import("../src/slack/resume-session.js");
  const { saveSession, clearSession } = await import("../src/gateway/sessions.js");
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry("C_SETTINGS_RESUME", { name: "settings-resume", type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, store.defaultChannelMeta({ channelId: "C_SETTINGS_RESUME", name: "settings-resume", type: "channel", isDM: false }));
  const meta = await store.getChannelMeta(entry.slug);

  // A session minted by Codex must be printed as a Codex resume line even though the channel
  // default is Claude: a session id belongs to exactly one harness.
  await saveSession(entry.slug, "1700000000.000100", "resume-session-id", "codex", null, JSON.stringify({ backend: "container", scope: "project" }));
  const resume = await resolveResumeSession({ entry, meta }, "1700000000.000100");
  assert.equal(resume.sessionId, "resume-session-id");
  assert.equal(resume.engine, "codex");
  assert.match(resume.command, /resume-session-id/);
  const view = rendered(buildChannelSettingsView({ ...snapshot, resume }, state, { tab: "agent" }));
  assert.match(view, /resume-session-id/);
  assert.match(view, /Resume in a terminal/);

  // A cleared session leaves no command behind, and no thread means nothing to resume at all.
  await clearSession(entry.slug, "1700000000.000100");
  assert.equal((await resolveResumeSession({ entry, meta }, "1700000000.000100")).command, "");
  assert.deepEqual(await resolveResumeSession({ entry, meta }, ""), { inThread: false, sessionId: "", engine: "", workDir: "", command: "" });
});

test("credential snapshots retain only a safe tail", () => {
  assert.deepEqual(maskedCredential("actual-secret-value-1234"), { configured: true, last4: "1234" });
  assert.deepEqual(maskedCredential("short"), { configured: true, last4: "" });
  assert.deepEqual(maskedCredential(""), { configured: false, last4: "" });
});

test("Settings and secrets admit authorized members and guests, but Cloud MCP requires a current admin", async () => {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry("C_SETTINGS_AUTH", {
    name: "settings-auth",
    type: "channel",
    isDM: false,
  });
  const base = {
    ...store.defaultChannelMeta({
      channelId: "C_SETTINGS_AUTH",
      name: "settings-auth",
      type: "channel",
      isDM: false,
    }),
    access: "approved",
    manageAccess: "custom",
    managers: ["U_SETTINGS_MANAGER"],
  };
  await store.saveChannelMeta(entry.slug, base);
  await store.setUser("U_SETTINGS_MANAGER", { name: "Settings Manager", approved: true });

  const memberClient = {
    conversations: {
      members: async () => ({ members: ["U_SETTINGS_MANAGER"], response_metadata: {} }),
    },
  };
  const current = await channelSettingsContext(memberClient, {
    channelId: "C_SETTINGS_AUTH",
    userId: "U_SETTINGS_MANAGER",
    expectedSlug: entry.slug,
    verifyMembership: true,
  });
  assert.equal(current.entry.slug, entry.slug);

  await store.saveChannelMeta(entry.slug, { ...base, managers: [] });
  const args = { channelId: "C_SETTINGS_AUTH", userId: "U_SETTINGS_MANAGER", expectedSlug: entry.slug, verifyMembership: true };
  assert.equal((await channelSettingsContext(memberClient, args)).entry.slug, entry.slug);
  await assert.rejects(() => channelSettingsContext(memberClient, { ...args, cloudMcp: true }), /Only administrators/);
  for (const flags of [{}, { allowBash: true }, { autoMode: true }, { adminMode: true }]) {
    await store.saveChannelMeta(entry.slug, { ...base, managers: [], ...flags });
    assert.equal((await secretsContext(memberClient, args)).mayEdit, true);
    // A non-admin may edit this channel's own secrets in every mode, but never the organization's:
    // that scope reaches every conversation in the deployment.
    assert.deepEqual(channelSettingsEditOptions({ ...base, ...flags }, false), {
      canEnableAdmin: false, canEditRuntime: true, canEditSecrets: true, canEditOrgSecrets: false, canManageCloudMcp: false, canManageVpn: false,
      canManageCustomMcp: false, canEditAccess: false,
    });
    assert.equal(channelSettingsEditOptions({ ...base, ...flags }, true).canEditOrgSecrets, true);
  }
  await store.setUser(args.userId, { approved: false });
  await store.saveChannelMeta(entry.slug, { ...base, managers: [], allowedUsers: [args.userId] });
  assert.equal((await channelSettingsContext(memberClient, args)).entry.slug, entry.slug);
  assert.equal((await secretsContext(memberClient, args)).mayEdit, true);
  await store.setUser(args.userId, { isAdmin: true });
  assert.equal((await channelSettingsContext(memberClient, { ...args, cloudMcp: true })).userIsAdmin, true);
  await store.setUser(args.userId, { isAdmin: false });
  await assert.rejects(() => channelSettingsContext(memberClient, { ...args, cloudMcp: true }), /Only administrators/);
  await store.saveChannelMeta(entry.slug, { ...base, managers: [] });
  await assert.rejects(
    () => channelSettingsContext(memberClient, {
      channelId: "C_SETTINGS_AUTH",
      userId: "U_SETTINGS_MANAGER",
      expectedSlug: entry.slug,
      verifyMembership: true,
    }),
    /not authorized to view this channel's settings/i,
  );
  await assert.rejects(() => secretsContext(memberClient, args), /not authorized/);

  await store.setUser(args.userId, { approved: true });
  await store.saveChannelMeta(entry.slug, base);
  const formerMemberClient = {
    conversations: { members: async () => ({ members: [], response_metadata: {} }) },
  };
  await assert.rejects(
    () => channelSettingsContext(formerMemberClient, {
      channelId: "C_SETTINGS_AUTH",
      userId: "U_SETTINGS_MANAGER",
      expectedSlug: entry.slug,
      verifyMembership: true,
    }),
    /no longer a member/i,
  );
});


test("DM Settings has a mode dropdown (Admin only for admins) and independent Auto/Lean ticks", () => {
  const data = { ...snapshot, isDM: true, mode: { adminMode: true, autoMode: true, cleanMode: true } };
  const admin = buildChannelSettingsView(data, state, { tab: "agent", canEnableAdmin: true });
  const mode = byActionId(admin, "cg_channel_settings_dm_mode");
  assert.deepEqual(mode.options.map((entry) => entry.text.text), ["Read-only", "Worker", "Admin"]);
  assert.equal(mode.initial_option.value, "admin");
  const flags = byActionId(admin, "cg_channel_settings_dm_flags");
  assert.deepEqual(flags.options.map((entry) => entry.value), ["autoMode", "cleanMode"]);
  assert.deepEqual(flags.initial_options.map((entry) => entry.value), ["autoMode", "cleanMode"]);
  const member = buildChannelSettingsView({ ...data, mode: { autoMode: true } }, state, { tab: "agent", canEnableAdmin: false });
  assert.equal(byActionId(member, "cg_channel_settings_dm_mode").options.some((entry) => entry.value === "admin"), false);
});

test("non-admin Settings hides Cloud MCP while keeping connection editing", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "mcp", ...channelSettingsEditOptions({}, false) });
  assert.ok(elements(view).some((element) => element.action_id === "cg_channel_settings_form_open"));
  assert.equal(elements(view).some((element) => String(element.action_id).startsWith("cg_channel_settings_cloud_")), false);
  assert.equal(view.blocks.some((block) => block.type === "header" && block.text.text === "Cloud MCP"), false);
  const cloudMcp = { claude: { ready: true, options: [{ key: "github", label: "github" }], selected: ["github"], inherited: ["drive"] }, codex: { ready: false } };
  const adminView = buildChannelSettingsView({ ...snapshot, cloudMcp }, state, { tab: "mcp", ...channelSettingsEditOptions({}, true) });
  const claude = byActionId(adminView, "cg_channel_settings_cloud_select_claude");
  assert.equal(claude.type, "multi_static_select");
  assert.deepEqual(claude.initial_options.map((entry) => entry.value), ["github"]);
  assert.match(rendered(adminView), /Always on from the organization: `drive`/);
  assert.match(rendered(adminView), /Loading the catalog/, "a cold catalog says so instead of blocking the page");
});

test("the runtime tab's thread scope reports the pins in force and the catalogs they imply", async () => {
  const { setThreadEngine, setThreadModel, setThreadEffort } = await import("../src/gateway/thread-engine.js");
  const { saveSession } = await import("../src/gateway/sessions.js");
  const slug = "runtime-scope-channel";
  const thread = "1700000000.000900";
  const meta = { engine: "claude", model: "claude-opus-4-8", effort: "high" };
  const base = { runtime: { ...snapshot.runtime, configuredEngineId: "claude", configuredModel: "claude-opus-4-8", configuredEffort: "high", effectiveEngineId: "claude" } };

  // No thread context at all: only the channel scope exists, so no control can widen a channel
  // default into a pin on a thread the view cannot name.
  assert.equal((await runtimeScopes(slug, meta, base, "")).thread, null);

  // An unpinned thread inherits everything, and says so rather than showing three blanks.
  const clean = await runtimeScopes(slug, meta, base, thread);
  assert.deepEqual(clean.thread.values, { engine: "", model: "", effort: "" });
  assert.equal(clean.thread.pinned, false);
  assert.equal(clean.thread.inherited.engine, "Follow channel (Claude)");
  assert.equal(clean.thread.inherited.model, "Follow channel (claude-opus-4-8)");

  // An unpinned thread whose live session was minted by the other harness keeps running there —
  // the tab names it instead of promising the channel's engine.
  await saveSession(slug, thread, "sess-codex-1", "codex");
  const minted = await runtimeScopes(slug, meta, base, thread);
  assert.equal(minted.thread.sessionEngineLabel, "Codex");
  assert.ok(minted.thread.options.models.every((item) => item.value !== "claude-opus-4-8"));

  // A pinned harness cannot inherit the channel's model: it is a flag for the other CLI.
  await setThreadEngine(slug, thread, "codex");
  await setThreadModel(slug, thread, "gpt-5.6-sol");
  await setThreadEffort(slug, thread, "low");
  const pinned = await runtimeScopes(slug, meta, base, thread);
  assert.deepEqual(pinned.thread.values, { engine: "codex", model: "gpt-5.6-sol", effort: "low" });
  assert.equal(pinned.thread.pinned, true);
  assert.equal(pinned.thread.sessionEngineLabel, "", "an explicit pin needs no explanation");
  assert.notEqual(pinned.thread.inherited.model, "Follow channel (claude-opus-4-8)");
  assert.equal(pinned.thread.inherited.engine, "Follow channel (Claude)", "the inherit option still names the CHANNEL's engine");
  // The channel scope is untouched by any of it.
  assert.deepEqual(pinned.channel.values, { engine: "claude", model: "claude-opus-4-8", effort: "high" });
});

test("dedicated Codex login shows channel status and only Codex model controls in Slack", async () => {
  const meta = { channelId: "C_OWN_CODEX", codexAuthSource: "channel", engine: "codex", model: "gpt-5.6-sol", effort: "low" };
  const data = { ...snapshot, runtime: { ...snapshot.runtime, channelLogin: true, channelLoginStatus: "Signed in with ChatGPT", configuredEngineId: "codex", configuredModel: meta.model, configuredEffort: meta.effort, effectiveEngineId: "codex" } };
  const scopes = await runtimeScopes("own-codex-channel", meta, data, state.threadTs);
  const view = buildChannelSettingsView({ ...data, runtime: { ...data.runtime, scopes } }, state, { tab: "agent", canEditRuntime: true });
  assert.match(rendered(view), /this channel's own login · Signed in with ChatGPT/);
  assert.equal(elements(view).some((element) => element.action_id === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID || element.action_id === CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID), false);
  assert.equal(scopes.channel.values.model, "gpt-5.6-sol");
  assert.equal(scopes.channel.options.models.some((item) => item.value === "gpt-5.6-sol"), true);
});

test("a DM following an org template inherits that template's runtime, not the gateway's", async () => {
  const { saveSettings, getSettings, getEngine } = await import("../src/config/settings.js");
  const before = getSettings();
  try {
    await saveSettings({ ...before, engine: "claude", dmTemplates: { ...(before.dmTemplates || {}), user: { engine: "codex", model: "gpt-5.6-sol", effort: "low" } } });
    assert.equal(getEngine(), "claude", "the gateway default is the OTHER harness");
    const meta = { isDM: true, template: "user", engine: "", model: "", effort: "" };
    const scopes = await runtimeScopes("dm-template-channel", meta, { runtime: { ...snapshot.runtime, configuredEngineId: "codex", configuredModel: "gpt-5.6-sol", configuredEffort: "low", effectiveEngineId: "codex" } }, "");
    // The empty-value label has to name what this DM actually falls back to. Saying "Claude" here
    // would also mean a Codex model pick got validated against Claude and refused.
    assert.equal(scopes.channel.inherited.engine, "Inherited default (Codex)");
    assert.equal(scopes.channel.inherited.model, "Inherited default (gpt-5.6-sol)");
    assert.equal(scopes.channel.inherited.effort, "Inherited default (low)");
  } finally {
    await saveSettings(before);
  }
});

test("a channel pinned to the non-default harness names THAT harness's default model as inherited", async () => {
  const { saveSettings, getSettings } = await import("../src/config/settings.js");
  const before = getSettings();
  try {
    // Gateway default engine is Codex; this channel is pinned to Claude with no model of its own.
    await saveSettings({ ...before, engine: "codex", defaultClaudeModel: "opus[1m]", defaultCodexModel: "gpt-6-sol" });
    const meta = { engine: "claude", model: "", effort: "" };
    const scopes = await runtimeScopes("pinned-claude-channel", meta, { runtime: { ...snapshot.runtime, configuredEngineId: "claude", configuredModel: "", configuredEffort: "", effectiveEngineId: "claude" } }, "");
    // What a run here actually uses is Claude's default; the Codex default must not be shown as
    // the inherited value of a Claude channel (QA-0925: "Inherited default (gpt-6-sol)").
    assert.equal(scopes.channel.inherited.model, "Inherited default (opus[1m])");
    assert.equal(scopes.channel.inherited.engine, "Inherited default (Codex)", "the ENGINE row still names what an unset engine inherits");
    assert.ok(scopes.channel.options.models.every((option) => !/^gpt-/.test(option.value)), "and the catalog is Claude's");
  } finally {
    await saveSettings(before);
  }
});

test("a thread pick is validated against the harness the dropdown offered, not the channel's", async () => {
  const { saveSession } = await import("../src/gateway/sessions.js");
  const { getThreadEngine, getThreadModel, getThreadEffort } = await import("../src/gateway/thread-engine.js");
  const slug = "offered-model-channel";
  const thread = "1700000000.000700";
  const entry = { slug, channelId: "C_OFFERED", name: "offered" };
  const state = { channelId: "C_OFFERED", slug, threadTs: thread, ownerId: "U_MANAGER" };
  const meta = { engine: "claude", model: "claude-opus-4-8", effort: "" };
  // Unpinned thread, Claude channel, but the live session belongs to Codex — so the tab offers
  // Codex models. Picking one has to stick: validating it against the CHANNEL's Claude would have
  // dropped it as foreign and turned the click into a silent no-op.
  await saveSession(slug, thread, "sess-offered-1", "codex");
  const offered = (await runtimeScopes(slug, meta, { runtime: { configuredEngineId: "claude", configuredModel: "claude-opus-4-8", configuredEffort: "", effectiveEngineId: "claude" } }, thread)).thread;
  assert.equal(offered.sessionEngineLabel, "Codex");
  const chosen = offered.options.models[0].value;

  await applyThreadRuntimeSelection({ entry, meta, state, actorId: "U_MANAGER", field: "model", value: chosen });
  assert.equal(await getThreadModel(slug, thread), chosen);
  assert.equal(await getThreadEngine(slug, thread), "", "changing only the model must not pin the harness");

  // Clearing goes back to inheriting, and clears the dependents it invalidates with it.
  await applyThreadRuntimeSelection({ entry, meta, state, actorId: "U_MANAGER", field: "engine", value: "claude" });
  assert.equal(await getThreadEngine(slug, thread), "claude");
  assert.equal(await getThreadModel(slug, thread), "", "a Codex model is not a Claude flag");
  assert.equal(await getThreadEffort(slug, thread), "");

  // A thread scope with no thread in the view refuses rather than widening to the channel.
  await assert.rejects(
    () => applyThreadRuntimeSelection({ entry, meta, state: { ...state, threadTs: "" }, actorId: "U_MANAGER", field: "engine", value: "codex" }),
    /inside the thread/i,
  );
});

test("the Schedules page lists this channel's schedules with the controls each kind allows", () => {
  const empty = rendered(buildChannelSettingsView({ ...snapshot, automations: [] }, state, { tab: "schedules" }));
  assert.match(empty, /No schedules here/);
  const automations = [
    { id: "rec1", cron: "0 9 * * 1-5", description: "Daily <standup>", enabled: true, kind: "task", createdBy: "U1", lastStatus: "ok" },
    { id: "rec2", cron: "0 18 * * *", prompt: "Evening digest", enabled: false, kind: "task" },
    { id: "once1", once: true, runAt: "2026-10-01T07:30:00.000Z", description: "Ping Ana", enabled: true, kind: "reminder", ack: true },
    { id: "loop1", loop: true, cron: "*/5 * * * *", loopReason: "watch CI", enabled: true, ticksRemaining: 7, threadTs: "1.2" },
  ];
  const view = buildChannelSettingsView({ ...snapshot, automations }, state, { tab: "schedules" });
  const text = rendered(view);
  assert.match(text, /Daily &lt;standup&gt;/, "titles are escaped");
  assert.match(text, /next 20/, "an enabled recurring row names its next run");
  assert.match(text, /paused/);
  assert.match(text, /Reminder · needs ✅/);
  const row = (title) => view.blocks.find((block) => block.type === "section" && block.text.text.includes(title)).accessory;
  const menu = (title) => row(title).options.map((entry) => ({ label: entry.text.text, ...JSON.parse(entry.value) }));
  assert.deepEqual(menu("standup").map((entry) => entry.label), ["Pause", "Delete"]);
  assert.deepEqual(menu("standup")[0], { label: "Pause", o: "sched", id: "rec1", a: "toggle", e: false });
  assert.deepEqual(menu("Evening digest").map((entry) => entry.label), ["Resume", "Delete"]);
  assert.equal(row("Ping Ana").text.text, "Cancel", "a one-time row is cancelled, never resumed");
  assert.equal(row("Ping Ana").action_id, CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID);
  assert.ok(row("Ping Ana").confirm, "cancelling asks first");
  assert.equal(row("watch CI").text.text, "Stop loop");
  for (const id of [CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID, CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID]) assert.match(id, CHANNEL_SETTINGS_ACTION_PATTERN);
  // Delete from a menu asks in place on the next paint.
  const confirming = buildChannelSettingsView({ ...snapshot, automations }, { ...state, confirm: "sched-rm:rec1" }, { tab: "schedules" });
  assert.match(rendered(confirming), /Delete \*Daily &lt;standup&gt;\*\? It will not run again/);
});

test("Automations controls act only on this channel's rows and respect the enabled-schedule ceiling", async () => {
  const { applyAutomationAction } = await import("../src/slack/app.js");
  const schedules = await import("../src/config/schedules.js");
  const { getScheduleMaxPerChannel } = await import("../src/config/settings.js");
  const mine = "C_AUTOMATIONS";
  const rec = schedules.addSchedule({ channelId: mine, slug: "automations", cron: "0 9 * * *", prompt: "daily" });
  const once = schedules.addSchedule({ channelId: mine, slug: "automations", runAt: "2026-10-01T07:30:00.000Z", once: true, prompt: "once" });
  const other = schedules.addSchedule({ channelId: "C_OTHER_AUTOMATIONS", slug: "other", cron: "0 9 * * *", prompt: "not yours" });
  const act = (actionId, command) => applyAutomationAction({ channelId: mine, slug: "automations", actorId: "U1", actionId, command });

  assert.match(await act(CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID, { id: rec.id, enabled: false }), /Paused/);
  assert.equal(schedules.listForChannel(mine).find((s) => s.id === rec.id).enabled, false);
  await assert.rejects(act(CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID, { id: once.id, enabled: false }), /Only recurring/);
  await assert.rejects(act(CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID, { id: other.id }), /no longer exists/);
  assert.ok(schedules.getSchedules().some((s) => s.id === other.id), "another channel's row is untouched");

  // Resuming past the per-channel ceiling is refused, exactly like create_schedule.
  const fillers = [];
  while (schedules.countEnabledForChannel(mine) < getScheduleMaxPerChannel()) {
    fillers.push(schedules.addSchedule({ channelId: mine, slug: "automations", cron: "0 10 * * *", prompt: "filler" }));
  }
  await assert.rejects(act(CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID, { id: rec.id, enabled: true }), /limit/);
  schedules.deleteSchedule(fillers.pop().id);
  assert.match(await act(CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID, { id: rec.id, enabled: true }), /Resumed/);
  assert.equal(schedules.listForChannel(mine).find((s) => s.id === rec.id).enabled, true);

  assert.match(await act(CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID, { id: once.id }), /Removed/);
  assert.equal(schedules.listForChannel(mine).some((s) => s.id === once.id), false);
  for (const row of [...schedules.listForChannel(mine), other]) schedules.deleteSchedule(row.id);
});


test("Slack settings reject an unconfigured provider before replacing thread pins", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  const { setThreadEngine, setThreadModel, setThreadEffort, getThreadEngine, getThreadModel, getThreadEffort } = await import("../src/gateway/thread-engine.js");
  saveSettings({ engineEnabled: { claude: true, codex: true, "qwen-eu": true }, qwenEuApiKey: "", qwenEuBaseUrl: "" });
  const entry = { slug: "provider-settings-pins" }, threadTs = "1800000000.345678";
  await setThreadEngine(entry.slug, threadTs, "codex");
  await setThreadModel(entry.slug, threadTs, "gpt-6-sol");
  await setThreadEffort(entry.slug, threadTs, "high");
  await assert.rejects(applyThreadRuntimeSelection({ entry, meta: { engine: "claude" }, state: { channelId: "C_PROVIDER", threadTs }, actorId: "U_MANAGER", field: "engine", value: "qwen-eu" }), /not configured/);
  assert.deepEqual([await getThreadEngine(entry.slug, threadTs), await getThreadModel(entry.slug, threadTs), await getThreadEffort(entry.slug, threadTs)], ["codex", "gpt-6-sol", "high"]);
});

test("Cloud MCP manager marks inadmissible definitions and offers only removal for existing selections", () => {
  const items = [
    { key: "missing", name: "missing", selectable: false, admissionReason: "is not defined", active: false },
    { key: "credentialed", name: "credentialed", selectable: false, admissionReason: "needs host credentials", direct: true, active: true },
    { key: "healthy", name: "healthy", selectable: true, active: false },
  ];
  const view = buildCatalogManagerView(items, state, { kind: "cloud", channelName: "fixture", engine: "claude" });
  const rows = view.blocks.filter(block => block.type === "section" && /missing|credentialed|healthy/.test(block.text?.text || ""));
  assert.equal(rows.find(row => row.text.text.includes("*missing*")).accessory, undefined);
  assert.equal(rows.find(row => row.text.text.includes("*credentialed*")).accessory.text.text, "Deactivate");
  assert.equal(rows.find(row => row.text.text.includes("*healthy*")).accessory.text.text, "Activate");
  assert.match(rendered(view), /unavailable:.*is not defined/);
});
