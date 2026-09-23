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
  parseActionValue,
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
  CHANNEL_SETTINGS_TABS,
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
const selects = (view) => view.blocks.filter((block) => block.accessory?.type === "static_select");
const rendered = (view) => JSON.stringify(view);

test("Settings footer button is authorized-user-only and requester-bound", () => {
  assert.equal(settingsButton("C1", "1.1", "U1", false), null);
  assert.equal(settingsButton("C1", "1.1", "", true), null);

  const button = settingsButton("C1", "1.1", "U1", true);
  assert.equal(button.action_id, CHANNEL_SETTINGS_ACTION_ID);
  assert.equal(button.text.text, "⚙️ Settings");
  assert.deepEqual(parseActionValue(button.value), { o: "open", c: "C1", t: "1.1", u: "U1" });
});

test("authorized user reply footer adds Settings after the existing workspace controls", () => {
  const buttons = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayUseSettings: true },
  );
  // The 💻 resume control moved into Settings → Resume Session; footers no longer carry it.
  assert.deepEqual(buttons.map((button) => button.text.text), ["📂", "🔑", "⚙️ Settings"]);
  assert.equal(buttons.some((button) => button.action_id === "resume_cmd_modal"), false);

  const ordinary = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayUseSettings: false },
  );
  assert.equal(ordinary.some((button) => button.action_id === CHANNEL_SETTINGS_ACTION_ID), false);
});

test("Channel Settings modal renders all working tabs for managers with one active state", () => {
  const view = buildChannelSettingsView(snapshot, state, { channelName: "project-alpha", tab: "mcp", canManageCloudMcp: true, canEditAccess: true });
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
  assert.equal(selects(runtime).length, 6);
  const skills = buildChannelSettingsView(snapshot, state, { tab: "skills" });
  assert.match(rendered(skills), /Development/);
  assert.ok(allButtons(skills).some((button) => button.action_id === CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID));
  for (const heading of ["Channel Skills Including Template", "All Shared Skills"]) {
    const index = skills.blocks.findIndex((block) => block.text?.text.startsWith(`*${heading}*\n`));
    assert.ok(index >= 0, `${heading} is shown`);
    assert.match(rendered(skills.blocks[index + 1]), /updates automatically/i, `${heading} explains its automatic summary`);
  }
  const secretsView = buildChannelSettingsView(snapshot, state, { tab: "secrets", canEditSecrets: true });
  const secrets = rendered(secretsView);
  assert.match(secrets, /SUPABASE_ACCESS_TOKEN/);
  assert.match(secrets, /••••beef/);
  assert.doesNotMatch(secrets, /actual-secret-value/);
  assert.ok(allButtons(secretsView).some((button) => button.action_id === "cg_channel_secrets_add"));
  // Row ids carry a scope letter (o/p/c) so three lists in one view can each have an index 0.
  assert.ok(secretsView.blocks.some((block) => block.accessory?.action_id === "cg_channel_secrets_remove_c0"));
  // All three scopes are on the tab, so it answers "what will a run here actually receive?".
  for (const heading of [/Organization/, /Yours/, /This conversation/]) assert.match(secrets, heading);
  // The personal scope is always the viewer's own to change; the organization's is admin-only.
  assert.ok(allButtons(secretsView).some((button) => button.action_id === "cg_channel_secrets_add_personal"));
  assert.ok(!allButtons(secretsView).some((button) => button.action_id === "cg_channel_secrets_add_organization"));
  const orgAdminView = buildChannelSettingsView(snapshot, state, { tab: "secrets", canEditSecrets: true, canEditOrgSecrets: true });
  assert.ok(allButtons(orgAdminView).some((button) => button.action_id === "cg_channel_secrets_add_organization"));
  assert.doesNotMatch(secrets, /Add, update, or remove secrets/);
  const mcp = buildChannelSettingsView(snapshot, state, { tab: "mcp" });
  assert.ok(allButtons(mcp).some((button) => button.action_id === CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID));
});

test("Resume Session tab shows this thread's copyable command, and says why when there is none", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "resume" });
  const text = rendered(view);
  // The command is escaped like every other value in this modal, so a channel-configurable work
  // folder can never smuggle Slack control markup into the card.
  assert.match(text, /```cd .*settings-channel.* &amp;&amp; claude --resume 994f6108-b405-4bbe-b96d-1641051df2fa```/);
  assert.match(text, /\/resume <command>/);
  assert.match(text, /994f6108-b405-4bbe-b96d-1641051df2fa/);
  assert.equal(parseSettingsMetadata(view.private_metadata).tab, "resume");
  assert.ok(allButtons(view).some((button) => button.action_id === `cg_channel_settings_tab_resume`), "the tab has its own button");

  const noSession = rendered(buildChannelSettingsView({ ...snapshot, resume: { inThread: true, command: "" } }, state, { tab: "resume" }));
  assert.match(noSession, /No session in this thread yet/);
  assert.doesNotMatch(noSession, /--resume/);

  const outsideThread = rendered(buildChannelSettingsView({ ...snapshot, resume: { inThread: false, command: "" } }, state, { tab: "resume" }));
  assert.match(outsideThread, /inside a thread/);
});

test("runtime tab edits the channel default and the thread pin in place, with no submit button", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "runtime", canEditRuntime: true });
  // Slack rejects `input` blocks in a modal without a submit; every control has to dispatch itself.
  assert.equal(view.submit, undefined);
  assert.equal(view.blocks.some((block) => block.type === "input"), false);

  const byAction = Object.fromEntries(selects(view).map((block) => [block.accessory.action_id, block.accessory]));
  assert.deepEqual(Object.keys(byAction).sort(), [
    CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID, RUNTIME_EFFORT_ACTION_ID,
    CHANNEL_SETTINGS_THREAD_EFFORT_ACTION_ID, CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID, CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID,
  ].sort());

  // Stored values preselect themselves; an unset field preselects the label of what it inherits.
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID].initial_option.value, "claude-opus-4-8");
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID].initial_option.value, SETTINGS_DEFAULT_VALUE);
  assert.equal(byAction[CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID].initial_option.text.text, "Inherited default (Claude)");
  assert.equal(byAction[CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID].initial_option.value, "codex");
  assert.equal(byAction[CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID].initial_option.text.text, "Follow channel (gpt-5.6-sol)");
  // The thread's model catalog follows the harness the THREAD runs, not the channel's.
  assert.deepEqual(byAction[CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID].options.map((item) => item.value), [SETTINGS_DEFAULT_VALUE, "gpt-5.6-sol"]);
  assert.ok(allButtons(view).some((button) => button.action_id === CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID));

  for (const [actionId, expected] of [
    [CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, { scope: "channel", field: "engine" }],
    [RUNTIME_EFFORT_ACTION_ID, { scope: "channel", field: "effort" }],
    [CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID, { scope: "thread", field: "model" }],
  ]) assert.deepEqual(runtimeSelectTarget(actionId), expected);
  assert.equal(runtimeSelectTarget(CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID), null);
});

test("runtime tab hides the thread scope until Settings is opened from a thread", () => {
  const withoutThread = { ...snapshot, runtime: { ...snapshot.runtime, scopes: { ...snapshot.runtime.scopes, thread: null } } };
  const view = buildChannelSettingsView(withoutThread, state, { tab: "runtime", canEditRuntime: true });
  assert.equal(selects(view).length, 3);
  assert.match(rendered(view), /Open Settings from a reply inside a thread/);
  assert.equal(allButtons(view).some((button) => button.action_id === CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID), false);
});

test("a stored value outside the engine catalog stays visible instead of silently reading as the default", () => {
  const retired = { ...snapshot, runtime: { ...snapshot.runtime, scopes: {
    ...snapshot.runtime.scopes,
    channel: { ...snapshot.runtime.scopes.channel, values: { engine: "", model: "claude-opus-4-1-retired", effort: "" } },
  } } };
  const model = selects(buildChannelSettingsView(retired, state, { tab: "runtime", canEditRuntime: true }))
    .find((block) => block.accessory.action_id === CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID).accessory;
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
  await saveSession(entry.slug, "1700000000.000100", "resume-session-id", "codex");
  const resume = await resolveResumeSession({ entry, meta }, "1700000000.000100");
  assert.equal(resume.sessionId, "resume-session-id");
  assert.equal(resume.engine, "codex");
  assert.match(resume.command, /resume-session-id/);
  const view = rendered(buildChannelSettingsView({ ...snapshot, resume }, state, { tab: "resume" }));
  assert.match(view, /resume-session-id/);
  assert.match(view, /Run this on the gateway machine/);

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
      canEnableAdmin: false, canEditRuntime: true, canEditSecrets: true, canEditOrgSecrets: false, canManageCloudMcp: false, canManageVpn: false, canEditAccess: false,
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


test("DM Settings has three base modes for admins and independent Auto/Lean controls", () => {
  const data = { ...snapshot, isDM: true, mode: { adminMode: true, autoMode: true, cleanMode: true } };
  const admin = buildChannelSettingsView(data, state, { tab: "runtime", canEnableAdmin: true });
  const buttons = allButtons(admin);
  assert.deepEqual(buttons.filter((b) => b.action_id.startsWith("cg_channel_settings_mode_")).map((b) => b.text.text), ["Read-only", "Worker", "Admin"]);
  assert.equal(buttons.find((b) => b.text.text === "Admin").style, "primary");
  for (const label of ["☑ Auto", "☑ Lean"]) assert.ok(buttons.some((b) => b.text.text === label));
  const member = buildChannelSettingsView(data, state, { tab: "runtime", canEnableAdmin: false });
  assert.equal(allButtons(member).some((b) => b.action_id === "cg_channel_settings_mode_admin"), false);
});

test("non-admin Settings hides Cloud MCP while keeping connection editing", () => {
  const view = buildChannelSettingsView(snapshot, state, { tab: "mcp", ...channelSettingsEditOptions({}, false) });
  assert.ok(allButtons(view).some((button) => button.action_id === CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID));
  assert.equal(allButtons(view).some((button) => button.action_id.startsWith("cg_channel_settings_cloud_")), false);
  assert.doesNotMatch(rendered(view), /github|figma/);
  const adminView = buildChannelSettingsView(snapshot, state, { tab: "mcp", ...channelSettingsEditOptions({}, true) });
  assert.ok(allButtons(adminView).some((button) => button.action_id === "cg_channel_settings_cloud_manage"));
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
