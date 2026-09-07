// Channel Settings modal for Slack. It mirrors the web conversation editor's safe channel-level
// controls while keeping credential values write-only and re-authorizing every interaction in the
// controller. Dangerous gateway-wide/admin-only settings remain in the web admin UI.
import { MIN_MASKABLE_LENGTH } from "../config/channel-env.js";

export const CHANNEL_SETTINGS_ACTION_ID = "cg_channel_settings";
export const CHANNEL_SETTINGS_TAB_PREFIX = "cg_channel_settings_tab_";
export const CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID = "cg_channel_settings_runtime_edit";
export const CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID = "cg_channel_settings_runtime_engine";
export const CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID = "cg_channel_settings_runtime_model";
export const CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID = "cg_channel_settings_runtime_form";
export const CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID = "cg_channel_settings_connections_edit";
export const CHANNEL_SETTINGS_CONNECTIONS_CALLBACK_ID = "cg_channel_settings_connections_form";
export const CHANNEL_SETTINGS_FALLBACK_ACTION_ID = "cg_channel_settings_connections_fallback";
export const CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID = "cg_channel_settings_clear_composio";
export const CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID = "cg_channel_settings_clear_toolbox";
export const CHANNEL_SETTINGS_CLEAR_MAKE_ACTION_ID = "cg_channel_settings_clear_make";
export const CHANNEL_SETTINGS_CLOUD_MANAGE_ACTION_ID = "cg_channel_settings_cloud_manage";
export const CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX = "cg_channel_settings_cloud_engine_";
export const CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX = "cg_channel_settings_cloud_toggle_";
export const CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX = "cg_channel_settings_cloud_page_";
export const CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID = "cg_channel_settings_skills_manage";
export const CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX = "cg_channel_settings_skill_toggle_";
export const CHANNEL_SETTINGS_SKILL_PAGE_PREFIX = "cg_channel_settings_skill_page_";
export const CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID = "cg_channel_settings_template_edit";
export const CHANNEL_SETTINGS_TEMPLATE_CALLBACK_ID = "cg_channel_settings_template_form";
export const CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID = "cg_channel_settings_secrets_manage";
export const CHANNEL_SETTINGS_ACTION_PATTERN = /^cg_channel_settings(?:$|_)/;
export const CHANNEL_SETTINGS_TABS = Object.freeze(["runtime", "mcp", "skills", "secrets"]);
export const SETTINGS_DEFAULT_VALUE = "__default__";
export const SETTINGS_NONE_VALUE = "__none__";
export const SETTINGS_PAGE_SIZE = 12;
export const RUNTIME_ENGINE_BLOCK_ID = "settings_runtime_engine";
export const RUNTIME_MODEL_BLOCK_ID = "settings_runtime_model";
export const RUNTIME_EFFORT_BLOCK_ID = "settings_runtime_effort";
export const RUNTIME_EFFORT_ACTION_ID = "cg_channel_settings_runtime_effort";
export const CONNECTION_COMPOSIO_BLOCK_ID = "settings_composio_token";
export const CONNECTION_COMPOSIO_ACTION_ID = "cg_channel_settings_composio_token";
export const CONNECTION_TOOLBOX_BLOCK_ID = "settings_toolbox_token";
export const CONNECTION_TOOLBOX_ACTION_ID = "cg_channel_settings_toolbox_token";
export const CONNECTION_MAKE_URL_BLOCK_ID = "settings_make_url";
export const CONNECTION_MAKE_URL_ACTION_ID = "cg_channel_settings_make_url";
export const CONNECTION_MAKE_KEY_BLOCK_ID = "settings_make_key";
export const CONNECTION_MAKE_KEY_ACTION_ID = "cg_channel_settings_make_key";
export const TEMPLATE_BLOCK_ID = "settings_skill_template";
export const TEMPLATE_ACTION_ID = "cg_channel_settings_skill_template";
const EXPIRED = "This channel settings view expired. Open it again from a recent reply.";
const MAX_LIST_ITEMS = 30;

function plain(text) {
  return { type: "plain_text", text: String(text).slice(0, 3000), emoji: true };
}

function mrkdwn(text) {
  return { type: "mrkdwn", text: String(text).slice(0, 3000) };
}

function escapeMrkdwn(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineCode(value) {
  return `\`${escapeMrkdwn(value || "—").replaceAll("`", "'")}\``;
}

function normalizeTab(tab) {
  const value = String(tab || "").toLowerCase();
  return CHANNEL_SETTINGS_TABS.includes(value) ? value : "runtime";
}

export function actionValue(op, extra = {}) {
  return JSON.stringify({ o: op, ...extra });
}

export function parseActionValue(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function settingsMetadata(state = {}) {
  return JSON.stringify({
    c: state.channelId,
    s: state.slug,
    t: state.threadTs || "",
    u: state.ownerId,
    p: normalizeTab(state.tab),
  });
}

export function parseSettingsMetadata(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw new Error(EXPIRED);
  }
  if (!value || typeof value !== "object" || !value.c || !value.s || !value.u) throw new Error(EXPIRED);
  return {
    channelId: String(value.c),
    slug: String(value.s),
    threadTs: String(value.t || ""),
    ownerId: String(value.u),
    tab: normalizeTab(value.p),
  };
}

export function maskedCredential(value) {
  const text = String(value || "");
  return {
    configured: Boolean(text),
    last4: text.length >= MIN_MASKABLE_LENGTH ? text.slice(-4) : "",
  };
}

function credentialLabel(value = {}) {
  if (!value.configured) return "not configured";
  return value.last4 ? `configured · ${inlineCode(`••••${value.last4}`)}` : "configured · tail hidden";
}

function names(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const label = typeof value === "string"
      ? value
      : value?.name || value?.serverName || value?.id || value?.namespace || "";
    const clean = String(label || "").trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function listLabel(values = []) {
  const all = names(values);
  if (!all.length) return "_none_";
  const shown = all.slice(0, MAX_LIST_ITEMS).map(inlineCode).join(", ");
  return all.length > MAX_LIST_ITEMS ? `${shown}  _(+${all.length - MAX_LIST_ITEMS} more)_` : shown;
}

function fieldBlock(label, value) {
  return { type: "section", text: mrkdwn(`*${label}*\n${value}`) };
}

function button(actionId, label, state, op, extra = {}, options = {}) {
  return {
    type: "button",
    action_id: actionId,
    text: plain(label),
    value: actionValue(op, { c: state.channelId, u: state.ownerId, ...extra }),
    ...(options.style ? { style: options.style } : {}),
    ...(options.confirm ? { confirm: options.confirm } : {}),
  };
}

function destructiveConfirm(title, text, confirm = "Remove") {
  return {
    title: plain(title),
    text: mrkdwn(text),
    confirm: plain(confirm),
    deny: plain("Cancel"),
    style: "danger",
  };
}

function runtimeBlocks(snapshot = {}, state = {}, { canEditRuntime = true } = {}) {
  const runtime = snapshot.runtime || {};
  const configuredEngine = runtime.configuredEngine
    ? inlineCode(runtime.configuredEngine)
    : `_inherits gateway default (${inlineCode(runtime.effectiveEngine || "unknown")})_`;
  const configuredModel = runtime.configuredModel
    ? inlineCode(runtime.configuredModel)
    : `_inherits ${runtime.gatewayModel ? `gateway default (${inlineCode(runtime.gatewayModel)})` : "the CLI default"}_`;
  const effort = runtime.configuredEffort ? inlineCode(runtime.configuredEffort) : "_engine default_";
  const blocks = [
    fieldBlock("Engine", configuredEngine),
    fieldBlock("Model", configuredModel),
    fieldBlock("Reasoning effort", effort),
  ];
  if (canEditRuntime) {
    blocks.push({
      type: "actions",
      elements: [button(CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID, "Change engine & model", state, "runtime_edit", {}, { style: "primary" })],
    });
  } else {
    blocks.push({ type: "context", elements: [mrkdwn("_Your gateway's runtime-change policy limits this control to administrators._")] });
  }
  return blocks;
}

function mcpBlocks(snapshot = {}, state = {}) {
  const c = snapshot.connections || {};
  const cloud = snapshot.cloudMcp || {};
  const composio = c.composioMode === "sdk"
    ? `${inlineCode("SDK")} · ${c.composioSdkReady ? "organization identity is ready" : "organization API key or entitlement is missing"}`
    : `${credentialLabel(c.composioChannel)}${c.composioChannel?.configured
      ? " · channel credential wins"
      : c.noDefaultTokens
        ? " · organization fallback refused here"
        : c.composioOrg?.configured
          ? " · using organization default"
          : " · no shared fallback"}`;
  const toolbox = c.toolboxChannel?.configured
    ? `${credentialLabel(c.toolboxChannel)} · channel credential wins`
    : c.noDefaultTokens
      ? "not configured here · organization fallback refused"
      : c.toolboxOrg?.configured
        ? "not configured here · falls back per-user, then organization default"
        : "not configured here · may fall back to each user's credential";
  const make = c.makeToolboxUrl
    ? `${inlineCode(c.makeToolboxUrl)} · key ${credentialLabel(c.makeToolboxKey)}`
    : "not configured";
  const remove = [];
  if (c.composioChannel?.configured) {
    remove.push(button(CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID, "Remove Composio token", state, "clear_composio", {}, {
      style: "danger",
      confirm: destructiveConfirm("Remove Composio token?", "The channel will fall back to the organization credential unless fallbacks are disabled."),
    }));
  }
  if (c.toolboxChannel?.configured) {
    remove.push(button(CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID, "Remove Toolbox token", state, "clear_toolbox", {}, {
      style: "danger",
      confirm: destructiveConfirm("Remove Toolbox token?", "The channel will fall back to a personal or organization credential unless fallbacks are disabled."),
    }));
  }
  if (c.makeToolboxUrl || c.makeToolboxKey?.configured) {
    remove.push(button(CHANNEL_SETTINGS_CLEAR_MAKE_ACTION_ID, "Disconnect Make MCP", state, "clear_make", {}, {
      style: "danger",
      confirm: destructiveConfirm("Disconnect Make MCP?", "The saved Make MCP URL and token will both be removed."),
    }));
  }
  return [
    { type: "header", text: plain("MCP connections") },
    fieldBlock(`Composio shared · ${c.composioMode === "sdk" ? "SDK mode" : "Personal mode"}`, composio),
    fieldBlock("Toolbox", toolbox),
    fieldBlock("Make MCP toolbox", make),
    {
      type: "actions",
      elements: [
        button(CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID, "Update connection tokens", state, "connections_edit", {}, { style: "primary" }),
        button(CHANNEL_SETTINGS_FALLBACK_ACTION_ID, c.noDefaultTokens ? "Enable inherited credentials" : "Disable inherited credentials", state, "fallback", { enabled: c.noDefaultTokens }),
      ],
    },
    ...(remove.length ? [{ type: "actions", elements: remove }] : []),
    { type: "divider" },
    { type: "header", text: plain("Cloud MCP") },
    fieldBlock("Claude · configured for this channel", listLabel(cloud.claude?.channel)),
    fieldBlock("Claude · inherited from organization", listLabel(cloud.claude?.organization)),
    fieldBlock("Codex · configured for this channel", listLabel(cloud.codex?.channel)),
    fieldBlock("Codex · inherited from organization", listLabel(cloud.codex?.organization)),
    {
      type: "actions",
      elements: [button(CHANNEL_SETTINGS_CLOUD_MANAGE_ACTION_ID, "Manage Cloud MCP", state, "cloud_manage", {}, { style: "primary" })],
    },
    { type: "context", elements: [mrkdwn("Gateway, Composio, Toolbox, and Make toolbox are injected separately from the Cloud MCP picker.")] },
  ];
}

function skillsBlocks(snapshot = {}, state = {}) {
  const skills = snapshot.skills || {};
  return [
    fieldBlock("Skill template", skills.template ? inlineCode(skills.template) : "_none_"),
    fieldBlock("Additional channel skills", listLabel(skills.additional)),
    fieldBlock("Channel tier now", listLabel(skills.channel)),
    fieldBlock("Inherited from organization", listLabel(skills.organization)),
    fieldBlock("Effective shared grants", listLabel(skills.effective)),
    {
      type: "actions",
      elements: [
        button(CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID, "Manage skills", state, "skills_manage", {}, { style: "primary" }),
        button(CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID, "Change template", state, "template_edit"),
      ],
    },
    { type: "context", elements: [mrkdwn("Personal skill grants are user-specific, so they are not channel settings and are not included here.")] },
  ];
}

function secretLine(entry = {}) {
  const tail = entry.last4 ? inlineCode(`••••${entry.last4}`) : "set · tail hidden";
  const date = entry.setAt && !Number.isNaN(new Date(entry.setAt).getTime())
    ? new Date(entry.setAt).toISOString().slice(0, 10)
    : "";
  const trail = [entry.setBy ? `by ${escapeMrkdwn(entry.setBy)}` : "", date].filter(Boolean).join(" · ");
  const provider = entry.resolvable === false ? ` · ⚠️ provider ${inlineCode(entry.provider || "unknown")} unavailable` : "";
  return `*${escapeMrkdwn(entry.name || "unnamed")}* — ${tail}${trail ? ` · ${trail}` : ""}${provider}`;
}

function secretsBlocks(snapshot = {}, state = {}, { canEditSecrets = false } = {}) {
  const vars = Array.isArray(snapshot.secrets) ? snapshot.secrets : [];
  const shown = vars.slice(0, MAX_LIST_ITEMS);
  const blocks = shown.length
    ? shown.map((entry) => ({ type: "section", text: mrkdwn(secretLine(entry)) }))
    : [{ type: "section", text: mrkdwn("_No environment secrets are configured for this channel._") }];
  if (vars.length > shown.length) {
    blocks.push({ type: "context", elements: [mrkdwn(`_+${vars.length - shown.length} more variables. Open /secrets for the complete manager._`)] });
  }
  blocks.push({
    type: "context",
    elements: [mrkdwn("Values are write-only. This view shows names and, only for long locally stored values, the last four characters.")],
  });
  if (canEditSecrets) {
    blocks.push({
      type: "actions",
      elements: [button(CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID, "Add, update, or remove secrets", state, "secrets_manage", {}, { style: "primary" })],
    });
  } else {
    blocks.push({ type: "context", elements: [mrkdwn("_Secrets can only be changed when this channel's mode permits command execution._")] });
  }
  return blocks;
}

const TAB_LABELS = Object.freeze({
  runtime: "Engine & model",
  mcp: "MCP",
  skills: "Skills",
  secrets: "Secrets",
});

function tabButtons(state, active) {
  return {
    type: "actions",
    block_id: "cg_channel_settings_tabs",
    elements: CHANNEL_SETTINGS_TABS.map((tab) => ({
      type: "button",
      action_id: `${CHANNEL_SETTINGS_TAB_PREFIX}${tab}`,
      text: plain(TAB_LABELS[tab]),
      ...(tab === active ? { style: "primary" } : {}),
      value: actionValue("tab", { c: state.channelId, u: state.ownerId, p: tab }),
    })),
  };
}

export function buildChannelSettingsView(snapshot = {}, state = {}, {
  channelName = "",
  tab = state.tab,
  canEditRuntime = true,
  canEditSecrets = false,
  notice = "",
} = {}) {
  const active = normalizeTab(tab);
  const content = active === "mcp"
    ? mcpBlocks(snapshot, state)
    : active === "skills"
      ? skillsBlocks(snapshot, state)
      : active === "secrets"
        ? secretsBlocks(snapshot, state, { canEditSecrets })
        : runtimeBlocks(snapshot, state, { canEditRuntime });
  return {
    type: "modal",
    callback_id: "cg_channel_settings_modal",
    private_metadata: settingsMetadata({ ...state, tab: active }),
    title: plain("Channel settings"),
    close: plain("Done"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Settings for *#${escapeMrkdwn(channelName || "this channel")}*. Only current channel managers can open or change this view.`)] },
      ...(notice ? [{ type: "section", text: mrkdwn(notice) }] : []),
      tabButtons(state, active),
      { type: "divider" },
      ...content,
    ],
  };
}

function option(label, value, description = "") {
  return {
    text: plain(String(label).slice(0, 75)),
    value: String(value).slice(0, 150),
    ...(description ? { description: plain(String(description).slice(0, 75)) } : {}),
  };
}

function selected(options, value) {
  return options.find((entry) => entry.value === value) || options[0];
}

export function editorMetadata(state = {}, extra = {}) {
  return JSON.stringify({
    c: state.channelId,
    s: state.slug,
    t: state.threadTs || "",
    u: state.ownerId,
    v: String(extra.view || ""),
    e: String(extra.engine || ""),
    m: String(extra.model || ""),
    p: Math.max(0, Number(extra.page) || 0),
  });
}

export function parseEditorMetadata(raw) {
  let value;
  try { value = JSON.parse(String(raw || "")); } catch { throw new Error(EXPIRED); }
  if (!value || typeof value !== "object" || !value.c || !value.s || !value.u || !value.v) throw new Error(EXPIRED);
  return {
    channelId: String(value.c),
    slug: String(value.s),
    threadTs: String(value.t || ""),
    ownerId: String(value.u),
    view: String(value.v),
    engine: String(value.e || ""),
    model: String(value.m || ""),
    page: Math.max(0, Number(value.p) || 0),
  };
}

function inputSelect({ blockId, actionId, label, options, initialValue, dispatch = false }) {
  const current = options.find((entry) => entry.value === initialValue);
  const prioritized = current ? [current, ...options.filter((entry) => entry !== current)] : options;
  const normalized = prioritized.slice(0, 100).map((entry) => option(entry.label, entry.value, entry.description));
  return {
    type: "input",
    block_id: blockId,
    label: plain(label),
    ...(dispatch ? { dispatch_action: true } : {}),
    element: {
      type: "static_select",
      action_id: actionId,
      options: normalized,
      initial_option: selected(normalized, initialValue),
    },
  };
}

export function buildRuntimeEditorView(runtime = {}, state = {}, {
  channelName = "",
  engines = [],
  models = [],
  efforts = [],
  engineChoice = runtime.configuredEngineId || SETTINGS_DEFAULT_VALUE,
  modelChoice = runtime.configuredModel || SETTINGS_DEFAULT_VALUE,
} = {}) {
  const engineOptions = [
    { label: `Gateway default (${runtime.gatewayEngineLabel || runtime.effectiveEngine || "current"})`, value: SETTINGS_DEFAULT_VALUE },
    ...engines,
  ];
  const modelOptions = [
    { label: runtime.gatewayModel ? `Gateway default (${runtime.gatewayModel})` : "Engine default", value: SETTINGS_DEFAULT_VALUE },
    ...models,
  ];
  const effortOptions = [
    { label: "Engine default", value: SETTINGS_DEFAULT_VALUE },
    ...efforts,
  ];
  const selectedEffort = efforts.some((entry) => entry.value === runtime.configuredEffort)
    ? runtime.configuredEffort
    : SETTINGS_DEFAULT_VALUE;
  return {
    type: "modal",
    callback_id: CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID,
    private_metadata: editorMetadata(state, { view: "runtime", engine: engineChoice, model: modelChoice }),
    title: plain("Engine & model"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Change the default runtime for *#${escapeMrkdwn(channelName || "this channel")}*. Existing per-thread overrides are unchanged.`)] },
      inputSelect({ blockId: RUNTIME_ENGINE_BLOCK_ID, actionId: CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, label: "Engine", options: engineOptions, initialValue: engineChoice, dispatch: true }),
      inputSelect({ blockId: RUNTIME_MODEL_BLOCK_ID, actionId: CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID, label: "Model", options: modelOptions, initialValue: modelChoice, dispatch: true }),
      inputSelect({ blockId: RUNTIME_EFFORT_BLOCK_ID, actionId: RUNTIME_EFFORT_ACTION_ID, label: "Reasoning effort", options: effortOptions, initialValue: selectedEffort }),
    ],
  };
}

export function readRuntimeForm(view = {}) {
  const values = view?.state?.values || {};
  const pick = (blockId, actionId) => String(values[blockId]?.[actionId]?.selected_option?.value || SETTINGS_DEFAULT_VALUE);
  return {
    engine: pick(RUNTIME_ENGINE_BLOCK_ID, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID),
    model: pick(RUNTIME_MODEL_BLOCK_ID, CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID),
    effort: pick(RUNTIME_EFFORT_BLOCK_ID, RUNTIME_EFFORT_ACTION_ID),
  };
}

function optionalTextInput({ blockId, actionId, label, placeholder, initialValue = "", maxLength = 3000, hint = "" }) {
  return {
    type: "input",
    block_id: blockId,
    optional: true,
    label: plain(label),
    element: {
      type: "plain_text_input",
      action_id: actionId,
      placeholder: plain(placeholder),
      max_length: maxLength,
      ...(initialValue ? { initial_value: initialValue } : {}),
    },
    ...(hint ? { hint: plain(hint) } : {}),
  };
}

export function buildConnectionsEditorView(connections = {}, state = {}, { channelName = "" } = {}) {
  const modeHint = connections.composioMode === "sdk"
    ? "The global gateway is in SDK mode. This value is stored for Personal mode and becomes active if an admin switches modes later."
    : "Replaces this channel's shared Composio credential. Leave blank to keep the current value.";
  return {
    type: "modal",
    callback_id: CHANNEL_SETTINGS_CONNECTIONS_CALLBACK_ID,
    private_metadata: editorMetadata(state, { view: "connections" }),
    title: plain("Connection tokens"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Update write-only credentials for *#${escapeMrkdwn(channelName || "this channel")}*. Saved values are never prefilled or shown again.`)] },
      optionalTextInput({ blockId: CONNECTION_COMPOSIO_BLOCK_ID, actionId: CONNECTION_COMPOSIO_ACTION_ID, label: "Composio channel token", placeholder: "Leave blank to keep the saved token", hint: modeHint }),
      optionalTextInput({ blockId: CONNECTION_TOOLBOX_BLOCK_ID, actionId: CONNECTION_TOOLBOX_ACTION_ID, label: "Toolbox token", placeholder: "Leave blank to keep the saved token", hint: "Used by the shared makeitfuture-toolbox connection." }),
      optionalTextInput({ blockId: CONNECTION_MAKE_URL_BLOCK_ID, actionId: CONNECTION_MAKE_URL_ACTION_ID, label: "Make MCP server URL", placeholder: "https://eu1.make.celonis.com/mcp/server/…", initialValue: connections.makeToolboxUrl || "", maxLength: 500, hint: "Leave unchanged to keep it; use Disconnect Make MCP in the main tab to remove it." }),
      optionalTextInput({ blockId: CONNECTION_MAKE_KEY_BLOCK_ID, actionId: CONNECTION_MAKE_KEY_ACTION_ID, label: "Make MCP token", placeholder: "Leave blank to keep the saved token", hint: "A URL and token are both required before Make MCP is active." }),
    ],
  };
}

export function readConnectionsForm(view = {}) {
  const values = view?.state?.values || {};
  const textValue = (blockId, actionId) => String(values[blockId]?.[actionId]?.value || "").trim();
  return {
    composioToken: textValue(CONNECTION_COMPOSIO_BLOCK_ID, CONNECTION_COMPOSIO_ACTION_ID),
    toolboxToken: textValue(CONNECTION_TOOLBOX_BLOCK_ID, CONNECTION_TOOLBOX_ACTION_ID),
    makeToolboxUrl: textValue(CONNECTION_MAKE_URL_BLOCK_ID, CONNECTION_MAKE_URL_ACTION_ID),
    makeToolboxKey: textValue(CONNECTION_MAKE_KEY_BLOCK_ID, CONNECTION_MAKE_KEY_ACTION_ID),
  };
}

export function catalogMetadata(state = {}, { view, engine = "", page = 0 } = {}) {
  return editorMetadata(state, { view, engine, page });
}

export function buildCatalogManagerView(items = [], state = {}, {
  kind = "skills",
  channelName = "",
  engine = "",
  page = 0,
  notice = "",
} = {}) {
  const isMcp = kind === "cloud";
  const safePage = Math.min(Math.max(0, Number(page) || 0), Math.max(0, Math.ceil(items.length / SETTINGS_PAGE_SIZE) - 1));
  const shown = items.slice(safePage * SETTINGS_PAGE_SIZE, (safePage + 1) * SETTINGS_PAGE_SIZE);
  const blocks = [
    { type: "context", elements: [mrkdwn(`${isMcp ? "Optional Cloud MCP capabilities" : "Catalog skills"} for *#${escapeMrkdwn(channelName || "this channel")}*. Changes affect the next run.`)] },
    ...(notice ? [{ type: "section", text: mrkdwn(notice) }] : []),
  ];
  if (isMcp) {
    blocks.push({
      type: "actions",
      elements: ["claude", "codex"].map((id) => button(`${CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX}${id}`, id === "claude" ? "Claude" : "Codex", state, "cloud_engine", { e: id }, id === engine ? { style: "primary" } : {})),
    });
  }
  if (!shown.length) blocks.push({ type: "section", text: mrkdwn("_No available items._") });
  for (const [offset, item] of shown.entries()) {
    const activeSource = item.direct ? "active in this channel" : item.inherited ? "inherited" : item.template ? "from template" : item.scoped ? "channel repository" : "inactive";
    const description = item.description ? `\n${escapeMrkdwn(item.description).slice(0, 450)}` : "";
    const disconnected = item.connected === false ? " · ⚠️ currently offline" : "";
    const actionId = isMcp
      ? `${CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX}${offset}`
      : `${CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX}${offset}`;
    const op = isMcp ? "cloud_toggle" : "skill_toggle";
    const accessory = item.direct
      ? button(actionId, "Deactivate", state, op, { k: item.key, e: engine, a: false }, {
          style: "danger",
          confirm: destructiveConfirm(`Deactivate ${item.name}?`, `It will stop being granted directly to this channel. Inherited/template capabilities remain active.`, "Deactivate"),
        })
      : item.active
        ? null
        : button(actionId, "Activate", state, op, { k: item.key, e: engine, a: true }, { style: "primary" });
    blocks.push({
      type: "section",
      text: mrkdwn(`*${escapeMrkdwn(item.name)}* · ${activeSource}${disconnected}${description}`),
      ...(accessory ? { accessory } : {}),
    });
  }
  const pages = Math.max(1, Math.ceil(items.length / SETTINGS_PAGE_SIZE));
  if (pages > 1) {
    const prefix = isMcp ? CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX : CHANNEL_SETTINGS_SKILL_PAGE_PREFIX;
    const controls = [];
    if (safePage > 0) controls.push(button(`${prefix}prev`, "← Previous", state, `${kind}_page`, { e: engine, p: safePage - 1 }));
    if (safePage + 1 < pages) controls.push(button(`${prefix}next`, "Next →", state, `${kind}_page`, { e: engine, p: safePage + 1 }));
    blocks.push({ type: "actions", elements: controls });
    blocks.push({ type: "context", elements: [mrkdwn(`Page ${safePage + 1} of ${pages} · ${items.length} item(s)`)] });
  }
  return {
    type: "modal",
    callback_id: isMcp ? "cg_channel_settings_cloud_modal" : "cg_channel_settings_skills_modal",
    private_metadata: catalogMetadata(state, { view: kind, engine, page: safePage }),
    title: plain(isMcp ? "Cloud MCP" : "Channel skills"),
    close: plain("Done"),
    blocks,
  };
}

export function buildTemplateEditorView(templates = [], current = "", state = {}, { channelName = "" } = {}) {
  const ordered = [...templates].sort((a, b) => Number(b.slug === current) - Number(a.slug === current));
  const options = [
    option("No template", SETTINGS_NONE_VALUE, "Keep only channel and organization grants"),
    ...ordered.map((entry) => option(entry.name || entry.slug, entry.slug, entry.description || "")),
  ].slice(0, 100);
  return {
    type: "modal",
    callback_id: CHANNEL_SETTINGS_TEMPLATE_CALLBACK_ID,
    private_metadata: editorMetadata(state, { view: "template" }),
    title: plain("Skill template"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Choose the live skill template followed by *#${escapeMrkdwn(channelName || "this channel")}*. Directly added skills remain.`)] },
      {
        type: "input",
        block_id: TEMPLATE_BLOCK_ID,
        label: plain("Template"),
        element: {
          type: "static_select",
          action_id: TEMPLATE_ACTION_ID,
          options,
          initial_option: selected(options, current || SETTINGS_NONE_VALUE),
        },
      },
    ],
  };
}

export function readTemplateForm(view = {}) {
  const value = view?.state?.values?.[TEMPLATE_BLOCK_ID]?.[TEMPLATE_ACTION_ID]?.selected_option?.value;
  return String(value || SETTINGS_NONE_VALUE);
}

export function buildChannelSettingsErrorView(message) {
  return {
    type: "modal",
    callback_id: "cg_channel_settings_error",
    title: plain("Channel settings"),
    close: plain("Close"),
    blocks: [{ type: "section", text: mrkdwn(`⚠️ ${escapeMrkdwn(message || "Something went wrong.")}`) }],
  };
}
