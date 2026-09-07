import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

import {
  buildCatalogManagerView,
  buildChannelSettingsView,
  buildConnectionsEditorView,
  buildRuntimeEditorView,
  buildTemplateEditorView,
  maskedCredential,
  parseActionValue,
  parseEditorMetadata,
  parseSettingsMetadata,
  readConnectionsForm,
  readRuntimeForm,
  readTemplateForm,
  CHANNEL_SETTINGS_ACTION_ID,
  CHANNEL_SETTINGS_ACTION_PATTERN,
  CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX,
  CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID,
  CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID,
  CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID,
  CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID,
  CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID,
  CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID,
  CHANNEL_SETTINGS_TABS,
  CONNECTION_COMPOSIO_ACTION_ID,
  CONNECTION_COMPOSIO_BLOCK_ID,
  CONNECTION_MAKE_KEY_ACTION_ID,
  CONNECTION_MAKE_KEY_BLOCK_ID,
  CONNECTION_MAKE_URL_ACTION_ID,
  CONNECTION_MAKE_URL_BLOCK_ID,
  CONNECTION_TOOLBOX_ACTION_ID,
  CONNECTION_TOOLBOX_BLOCK_ID,
  RUNTIME_EFFORT_ACTION_ID,
  RUNTIME_EFFORT_BLOCK_ID,
  RUNTIME_ENGINE_BLOCK_ID,
  RUNTIME_MODEL_BLOCK_ID,
  SETTINGS_DEFAULT_VALUE,
  SETTINGS_NONE_VALUE,
  TEMPLATE_ACTION_ID,
  TEMPLATE_BLOCK_ID,
} from "../src/slack/channel-settings.js";
import { footerButtons, settingsButton } from "../src/slack/footer.js";

const [{ channelSettingsContext, cloudSelectionsAfterToggle, connectionSettingsPatch, runtimeSettingsPatch }, store] = await Promise.all([
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
    additional: ["pdf"],
    channel: ["development", "pdf"],
    organization: ["gateway-usage"],
    effective: ["gateway-usage", "development", "pdf"],
  },
  secrets: [{ name: "SUPABASE_ACCESS_TOKEN", last4: "beef", setBy: "<@U_MANAGER>", setAt: Date.UTC(2026, 8, 7), provider: "local", resolvable: true }],
};

const allButtons = (view) => view.blocks.flatMap((block) => block.elements || []).filter((item) => item.type === "button");
const rendered = (view) => JSON.stringify(view);

test("Settings footer button is manager-only and requester-bound", () => {
  assert.equal(settingsButton("C1", "1.1", "U1", false), null);
  assert.equal(settingsButton("C1", "1.1", "", true), null);

  const button = settingsButton("C1", "1.1", "U1", true);
  assert.equal(button.action_id, CHANNEL_SETTINGS_ACTION_ID);
  assert.equal(button.text.text, "⚙️ Settings");
  assert.deepEqual(parseActionValue(button.value), { o: "open", c: "C1", t: "1.1", u: "U1" });
});

test("manager reply footer adds Settings after the existing workspace controls", () => {
  const buttons = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayManage: true },
  );
  assert.deepEqual(buttons.map((button) => button.text.text), ["💻", "📂", "🔑", "⚙️ Settings"]);

  const ordinary = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayManage: false },
  );
  assert.equal(ordinary.some((button) => button.action_id === CHANNEL_SETTINGS_ACTION_ID), false);
});

test("Channel Settings modal renders four working tabs with one active state", () => {
  const view = buildChannelSettingsView(snapshot, state, { channelName: "project-alpha", tab: "mcp" });
  const buttons = allButtons(view).filter((button) => button.action_id.startsWith("cg_channel_settings_tab_"));
  assert.equal(buttons.length, CHANNEL_SETTINGS_TABS.length);
  assert.equal(new Set(buttons.map((button) => button.action_id)).size, CHANNEL_SETTINGS_TABS.length);
  assert.equal(buttons.filter((button) => button.style === "primary").length, 1);
  assert.match(buttons.find((button) => button.style === "primary").action_id, /_mcp$/);
  assert.match(rendered(view), /MCP connections/);
  assert.match(rendered(view), /Cloud MCP/);
  assert.match(rendered(view), /github/);

  const metadata = parseSettingsMetadata(view.private_metadata);
  assert.deepEqual(metadata, { ...state, tab: "mcp" });
});

test("each Settings tab renders its channel setup snapshot", () => {
  const runtime = buildChannelSettingsView(snapshot, state, { tab: "runtime", canEditRuntime: true });
  assert.match(rendered(runtime), /claude-opus-4-8/);
  assert.ok(allButtons(runtime).some((button) => button.action_id === "cg_channel_settings_runtime_edit"));
  const skills = buildChannelSettingsView(snapshot, state, { tab: "skills" });
  assert.match(rendered(skills), /Development/);
  assert.ok(allButtons(skills).some((button) => button.action_id === CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID));
  const secretsView = buildChannelSettingsView(snapshot, state, { tab: "secrets", canEditSecrets: true });
  const secrets = rendered(secretsView);
  assert.match(secrets, /SUPABASE_ACCESS_TOKEN/);
  assert.match(secrets, /••••beef/);
  assert.doesNotMatch(secrets, /actual-secret-value/);
  assert.ok(allButtons(secretsView).some((button) => button.action_id === CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID));
  const mcp = buildChannelSettingsView(snapshot, state, { tab: "mcp" });
  assert.ok(allButtons(mcp).some((button) => button.action_id === CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID));
});

test("runtime editor rebuilds valid engine/model/effort controls and parses a submission", () => {
  const view = buildRuntimeEditorView(snapshot.runtime, state, {
    channelName: "project-alpha",
    engines: [{ label: "Claude", value: "claude" }, { label: "Codex", value: "codex" }],
    models: [{ label: "Opus", value: "opus", description: "Best Claude model" }],
    efforts: [{ label: "High", value: "high" }],
    engineChoice: "claude",
    modelChoice: "opus",
  });
  assert.equal(view.callback_id, CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID);
  assert.equal(parseEditorMetadata(view.private_metadata).engine, "claude");
  assert.equal(view.blocks.find((block) => block.block_id === RUNTIME_ENGINE_BLOCK_ID).element.initial_option.value, "claude");
  assert.equal(view.blocks.find((block) => block.block_id === RUNTIME_MODEL_BLOCK_ID).element.initial_option.value, "opus");
  assert.equal(view.blocks.find((block) => block.block_id === RUNTIME_EFFORT_BLOCK_ID).dispatch_action, undefined);

  const submitted = {
    state: { values: {
      [RUNTIME_ENGINE_BLOCK_ID]: { [CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID]: { selected_option: { value: "codex" } } },
      [RUNTIME_MODEL_BLOCK_ID]: { [CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID]: { selected_option: { value: "gpt-5.6-sol" } } },
      [RUNTIME_EFFORT_BLOCK_ID]: { [RUNTIME_EFFORT_ACTION_ID]: { selected_option: { value: "high" } } },
    } },
  };
  assert.deepEqual(readRuntimeForm(submitted), { engine: "codex", model: "gpt-5.6-sol", effort: "high" });
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

test("credential snapshots retain only a safe tail", () => {
  assert.deepEqual(maskedCredential("actual-secret-value-1234"), { configured: true, last4: "1234" });
  assert.deepEqual(maskedCredential("short"), { configured: true, last4: "" });
  assert.deepEqual(maskedCredential(""), { configured: false, last4: "" });
});

test("historic Settings controls re-check current manager access and membership", async () => {
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
  await assert.rejects(
    () => channelSettingsContext(memberClient, {
      channelId: "C_SETTINGS_AUTH",
      userId: "U_SETTINGS_MANAGER",
      expectedSlug: entry.slug,
      verifyMembership: true,
    }),
    /not authorized to view this channel's settings/i,
  );

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
