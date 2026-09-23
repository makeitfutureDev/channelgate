// Channel Settings modal for Slack. It mirrors the web conversation editor's safe channel-level
// controls while keeping credential values write-only and re-authorizing every interaction in the
// controller. Dangerous gateway-wide/admin-only settings remain in the web admin UI.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ACCESS_EDIT_ACTION_ID, accessSummary } from "./access-settings.js";
import { channelMode, modeLabel } from "../gateway/modes.js";
import { MIN_MASKABLE_LENGTH } from "../config/channel-env.js";
import { buildSecretsView } from "./secret-explorer.js";

export const CHANNEL_SETTINGS_MODE_PREFIX = "cg_channel_settings_mode_";
export const CHANNEL_SETTINGS_OPTION_PREFIX = "cg_channel_settings_option_";
export const CHANNEL_SETTINGS_ACTION_ID = "cg_channel_settings";
export const CHANNEL_SETTINGS_TAB_PREFIX = "cg_channel_settings_tab_";
// Kept only so a Settings modal opened before the inline dropdowns shipped still has a live
// control: the handler repaints the runtime tab instead of pushing the retired editor.
export const CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID = "cg_channel_settings_runtime_edit";
export const CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID = "cg_channel_settings_runtime_engine";
export const CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID = "cg_channel_settings_runtime_model";
export const CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID = "cg_channel_settings_thread_engine";
export const CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID = "cg_channel_settings_thread_model";
export const CHANNEL_SETTINGS_THREAD_EFFORT_ACTION_ID = "cg_channel_settings_thread_effort";
export const CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID = "cg_channel_settings_thread_reset";
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
export const CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID = "cg_channel_settings_vpn_toggle";
export const CHANNEL_SETTINGS_VPN_REFRESH_ACTION_ID = "cg_channel_settings_vpn_refresh";
export const CHANNEL_SETTINGS_ACTION_PATTERN = /^cg_channel_settings(?:$|_)/;
export const CHANNEL_SETTINGS_TABS = Object.freeze(["runtime", "resume", "mcp", "skills", "secrets", "network", "access"]);
export const SETTINGS_DEFAULT_VALUE = "__default__";
export const SETTINGS_NONE_VALUE = "__none__";
export const SETTINGS_PAGE_SIZE = 12;
export const RUNTIME_EFFORT_ACTION_ID = "cg_channel_settings_runtime_effort";
// The two runtime scopes the Engine & model tab edits in place. Declaring the ids once keeps the
// renderer and the controller from drifting over which dropdown writes which scope and field.
export const RUNTIME_SELECT_ACTION_IDS = Object.freeze({
  channel: Object.freeze({
    engine: CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID,
    model: CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID,
    effort: RUNTIME_EFFORT_ACTION_ID,
  }),
  thread: Object.freeze({
    engine: CHANNEL_SETTINGS_THREAD_ENGINE_ACTION_ID,
    model: CHANNEL_SETTINGS_THREAD_MODEL_ACTION_ID,
    effort: CHANNEL_SETTINGS_THREAD_EFFORT_ACTION_ID,
  }),
});
export const RUNTIME_SCOPES = Object.freeze(Object.keys(RUNTIME_SELECT_ACTION_IDS));
export const RUNTIME_FIELDS = Object.freeze(["engine", "model", "effort"]);

// Which scope and field a dispatched dropdown writes, or null when the action isn't one of them.
export function runtimeSelectTarget(actionId) {
  for (const scope of RUNTIME_SCOPES) {
    for (const field of RUNTIME_FIELDS) {
      if (RUNTIME_SELECT_ACTION_IDS[scope][field] === actionId) return { scope, field };
    }
  }
  return null;
}
export const CONNECTION_COMPOSIO_BLOCK_ID = "settings_composio_token";
export const CONNECTION_COMPOSIO_ACTION_ID = "cg_channel_settings_composio_token";
export const CONNECTION_COMPOSIO_LABEL_BLOCK_ID = "settings_composio_label";
export const CONNECTION_COMPOSIO_LABEL_ACTION_ID = "cg_channel_settings_composio_label";
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

// One scope's three rows. A stored value renders as itself; an empty one renders as the label of
// whatever it inherits, so "nothing set here" never shows up as a blank the reader has to decode.
// `options` carries the catalogs the app layer resolved for the engine THIS scope actually runs.
function runtimeScopeRows(scope, { values = {}, inherited = {}, options = {} } = {}, { editable = true } = {}) {
  const ids = RUNTIME_SELECT_ACTION_IDS[scope];
  const lists = { engine: options.engines || [], model: options.models || [], effort: options.efforts || [] };
  const labels = { engine: "Engine", model: "Model", effort: "Reasoning effort" };
  return RUNTIME_FIELDS.map((field) => (editable
    ? selectRow({
      label: labels[field],
      actionId: ids[field],
      options: [{ label: inherited[field] || "Inherited default", value: SETTINGS_DEFAULT_VALUE }, ...lists[field]],
      initialValue: values[field] || SETTINGS_DEFAULT_VALUE,
    })
    : fieldBlock(labels[field], values[field] ? inlineCode(values[field]) : `_${escapeMrkdwn(inherited[field] || "inherited default")}_`)));
}

function runtimeBlocks(snapshot = {}, state = {}, { canEditRuntime = true, canEnableAdmin = false } = {}) {
  const runtime = snapshot.runtime || {};
  const scopes = runtime.scopes || {};
  const thread = scopes.thread || null;
  const mode = snapshot.mode || {};
  const selected = channelMode(mode);
  const blocks = [
    ...(snapshot.isDM ? [fieldBlock("Mode", modeLabel(mode)),
    { type: "actions", elements: [
      ...["read", "worker", ...(canEnableAdmin ? ["admin"] : [])].map((value) =>
        button(`${CHANNEL_SETTINGS_MODE_PREFIX}${value}`, { read: "Read-only", worker: "Worker", admin: "Admin" }[value], state, "mode", { mode: value }, { style: selected === value ? "primary" : undefined })),
    ] },
    { type: "actions", elements: [
      button(`${CHANNEL_SETTINGS_OPTION_PREFIX}auto`, `${mode.autoMode ? "☑" : "☐"} Auto`, state, "option", { key: "autoMode", enabled: !mode.autoMode }),
      button(`${CHANNEL_SETTINGS_OPTION_PREFIX}lean`, `${mode.cleanMode ? "☑" : "☐"} Lean`, state, "option", { key: "cleanMode", enabled: !mode.cleanMode }),
    ] },
    { type: "context", elements: [mrkdwn("Read-only reads files; changes need approval. Worker runs commands and edits files in the channel folder only. Admin gives admins all tools without approval prompts; other members get Worker with the selected Auto/Lean options. Host-home access is a separate web Settings → Container runtime option shared by all admitted members, not host root access. Auto approves tool requests for all members. Lean removes optional skills and connectors.")] },
    { type: "divider" },
    ] : []),
    { type: "section", text: mrkdwn("*Channel default*") },
    ...runtimeScopeRows("channel", scopes.channel, { editable: canEditRuntime }),
    { type: "context", elements: [mrkdwn("Applies to every thread here that has no pin of its own. Each change saves immediately and takes effect on the next turn.")] },
    { type: "divider" },
    { type: "section", text: mrkdwn("*This thread*") },
  ];
  if (!thread) {
    blocks.push({ type: "context", elements: [mrkdwn("_Open Settings from a reply inside a thread to pin that thread's engine, model or effort._")] });
  } else {
    blocks.push(
      ...runtimeScopeRows("thread", thread, { editable: canEditRuntime }),
      ...(canEditRuntime && thread.pinned
        ? [{ type: "actions", elements: [button(CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID, "Follow channel default", state, "thread_reset", {}, {
          confirm: destructiveConfirm("Clear this thread's pins?", "The thread goes back to the channel's engine, model and effort.", "Clear"),
        })] }]
        : []),
      { type: "context", elements: [mrkdwn("A pin here beats the channel default for this thread only, and stops cross-engine failover from answering on the other harness.")] },
      ...(thread.sessionEngineLabel
        ? [{ type: "context", elements: [mrkdwn(`_This thread's live session was started by *${escapeMrkdwn(thread.sessionEngineLabel)}*, so it keeps running there until you pin an engine above or clear the session with \`/clear\`._`)] }]
        : []),
    );
  }
  if (!canEditRuntime) {
    blocks.push({ type: "context", elements: [mrkdwn("_Your gateway's runtime-change policy limits this control to administrators._")] });
  }
  return blocks;
}

function mcpBlocks(snapshot = {}, state = {}, { canManageCloudMcp = false } = {}) {
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
    ...(c.composioTokenLabel ? [fieldBlock("Composio channel label", inlineCode(c.composioTokenLabel))] : []),
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
    ...(canManageCloudMcp ? [
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
    ] : []),
  ];
}

function skillsBlocks(snapshot = {}, state = {}) {
  const skills = snapshot.skills || {};
  return [
    fieldBlock("Skill Template", skills.template ? inlineCode(skills.template) : "_none_"),
    { type: "context", elements: [mrkdwn("A reusable set of skills for this channel. Use Change Template below to choose a different set.")] },
    fieldBlock("Channel Skills", listLabel(skills.additional)),
    { type: "context", elements: [mrkdwn("Added directly to this channel. Use Manage Channel Skills below to add or remove them.")] },
    fieldBlock("Channel Skills Including Template", listLabel(skills.channel)),
    { type: "context", elements: [mrkdwn("Channel Skills plus the selected template. This summary updates automatically when either changes.")] },
    fieldBlock("Org Skills", listLabel(skills.organization)),
    { type: "context", elements: [mrkdwn("Inherited from the organization. Only admins can add or remove Org Skills in the admin UI → Skills. They cannot be removed for just this channel.")] },
    fieldBlock("All Shared Skills", listLabel(skills.effective)),
    { type: "context", elements: [mrkdwn("Org Skills plus Channel Skills Including Template, with duplicates listed once. This summary updates automatically when you configure the groups above.")] },
    {
      type: "actions",
      elements: [
        button(CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID, "Manage Channel Skills", state, "skills_manage", {}, { style: "primary" }),
        button(CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID, "Change Template", state, "template_edit"),
      ],
    },
    { type: "context", elements: [mrkdwn("Personal skill grants are user-specific, so they are not channel settings and are not included here.")] },
  ];
}

function secretsBlocks(snapshot = {}, state = {}, { canEditSecrets = false, canEditOrgSecrets = false } = {}) {
  // The same masked rows and mutation controls as /secrets, directly in the Settings tab — all
  // three scopes, so the tab answers "what will this run actually receive?" and not just "what did
  // this conversation set?". snapshot.secrets stays the channel list for older callers.
  return buildSecretsView({
    organization: Array.isArray(snapshot.orgSecrets) ? snapshot.orgSecrets : [],
    personal: Array.isArray(snapshot.personalSecrets) ? snapshot.personalSecrets : [],
    channel: Array.isArray(snapshot.secrets) ? snapshot.secrets : [],
  }, state, {
    mayEdit: canEditSecrets,
    canEditOrg: canEditOrgSecrets,
  }).blocks;
}

// Bind privileged VPN actions to the view's channel, slug and owner. A restart intentionally
// expires old VPN controls; the user can reopen Settings to obtain a fresh binding.
const vpnActionKey = randomBytes(32);
function vpnActionSignature(state, operation, enabled) {
  return createHmac("sha256", vpnActionKey).update(JSON.stringify([
    state.channelId, state.slug, state.ownerId, operation, enabled ?? null,
  ])).digest("hex");
}

export function assertVpnActionBinding(state, command, actionId) {
  const operation = actionId === CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID ? "vpn_toggle" : "vpn_refresh";
  if (![CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID, CHANNEL_SETTINGS_VPN_REFRESH_ACTION_ID].includes(actionId)
    || command.o !== operation || command.c !== state.channelId || command.u !== state.ownerId
    || (operation === "vpn_toggle" && typeof command.enabled !== "boolean")) throw new Error(EXPIRED);
  const actual = Buffer.from(String(command.signature || ""), "hex");
  const expected = Buffer.from(vpnActionSignature(state, operation, command.enabled), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(EXPIRED);
}

function vpnButton(state, enabled) {
  const toggle = typeof enabled === "boolean";
  const operation = toggle ? "vpn_toggle" : "vpn_refresh";
  return button(toggle ? CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID : CHANNEL_SETTINGS_VPN_REFRESH_ACTION_ID,
    toggle ? (enabled ? "Turn VPN on" : "Turn VPN off") : "Refresh VPN status", state, operation,
    { ...(toggle ? { enabled } : {}), signature: vpnActionSignature(state, operation, enabled) },
    toggle && enabled ? { style: "primary" } : {});
}

function networkBlocks(snapshot, state, { canManageVpn }) {
  const vpn = snapshot.vpn;
  const labels = { unconfigured: "Not configured", unavailable: "Unavailable", off: "Off", starting: "Starting — not connected yet", on: "On — connected", stopping: "Stopping", failed: "Failed — not connected" };
  const buttons = [vpnButton(state)];
  // Stopping remains possible while a tunnel is starting or failed. A running control operation
  // must settle before another one can be accepted by the service.
  if (canManageVpn && vpn?.configured && !vpn.busy && vpn.state !== "unavailable") {
    if (vpn.enabled || vpn.running || ["on", "starting"].includes(vpn.state)) buttons.unshift(vpnButton(state, false));
    else if (vpn.state !== "stopping" && vpn.allowNetwork && !vpn.missingSecrets?.length) buttons.unshift(vpnButton(state, true));
  }
  return [
    fieldBlock("Network use", snapshot.mode?.allowNetwork ? "Allowed" : "Off"),
    { type: "context", elements: [mrkdwn("Network use is the engine's channel policy. Managers can change it under Access.")] },
    fieldBlock("VPN", vpn ? (labels[vpn.state] || "Unknown") : "Checking status…"),
    ...(vpn?.message ? [{ type: "section", text: mrkdwn(escapeMrkdwn(vpn.message)) }] : []),
    ...(vpn?.missingSecrets?.length ? [fieldBlock("Missing channel secrets", vpn.missingSecrets.map(inlineCode).join(", "))] : []),
    { type: "actions", elements: buttons },
    { type: "context", elements: [mrkdwn("VPN connects the channel's dedicated VPN service and extractor. It does not route the ordinary agent container through the tunnel. Only admins and current channel managers can turn it on or off.")] },
  ];
}

// The terminal command that reopens this thread's engine session, resolved by the app layer
// (slack/resume-session.js) at render time. It replaced the 💻 control that used to ride under
// every reply: the command is only wanted occasionally, and Settings is already the per-thread
// place to look. Pins are per THREAD, so this tab — like the runtime tab's "This thread" scope —
// only has something to show when Settings was opened from a reply inside a thread.
function resumeBlocks(snapshot = {}) {
  const resume = snapshot.resume || {};
  if (!resume.inThread) {
    return [{ type: "context", elements: [mrkdwn("_Open Settings from a reply inside a thread to get that thread's resume command._")] }];
  }
  if (!resume.command) {
    return [
      { type: "section", text: mrkdwn("No session in this thread yet — send a message first, then open this tab again.") },
      { type: "context", elements: [mrkdwn("To continue a session you started elsewhere, post `/resume <command or session id>` in this thread.")] },
    ];
  }
  return [
    { type: "section", text: mrkdwn("Run this on the gateway machine to open this thread's session in your terminal:") },
    // Escaped like every other value in this modal: a work-folder path is channel-configurable,
    // and Slack parses control sequences inside a code block too.
    { type: "section", text: mrkdwn("```" + escapeMrkdwn(resume.command) + "```") },
    { type: "context", elements: [mrkdwn("Paste the same line back as `/resume <command>` in this channel to continue that session from a Slack thread.")] },
    ...(resume.sessionId ? [fieldBlock("Session id", inlineCode(resume.sessionId))] : []),
    ...(resume.workDir ? [fieldBlock("Folder", inlineCode(resume.workDir))] : []),
  ];
}

const TAB_LABELS = Object.freeze({
  access: "Access",
  network: "Network",
  runtime: "Engine & model",
  resume: "Resume Session",
  mcp: "MCP",
  skills: "Skills",
  secrets: "Secrets",
});

function tabButtons(state, active, canEditAccess) {
  return {
    type: "actions",
    block_id: "cg_channel_settings_tabs",
    elements: CHANNEL_SETTINGS_TABS.filter((tab) => tab !== "access" || canEditAccess).map((tab) => ({
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
  canEnableAdmin = false,
  canEditSecrets = false,
  // The organization scope reaches every conversation, so it is admin-only even for someone who
  // may edit this channel's own secrets.
  canEditOrgSecrets = false,
  canManageCloudMcp = false,
  canEditAccess = false,
  canManageVpn = false,
  notice = "",
} = {}) {
  const requested = normalizeTab(tab);
  const active = requested === "access" && !canEditAccess ? "runtime" : requested;
  const content = active === "access"
    ? [
      { type: "section", text: mrkdwn(accessSummary(snapshot.access || {})) },
      { type: "actions", elements: [button(ACCESS_EDIT_ACTION_ID, "Change access settings", state, "access_edit", {}, { style: "primary" })] },
    ]
    : active === "resume"
    ? resumeBlocks(snapshot)
    : active === "network"
    ? networkBlocks(snapshot, state, { canManageVpn })
    : active === "mcp"
    ? mcpBlocks(snapshot, state, { canManageCloudMcp })
    : active === "skills"
      ? skillsBlocks(snapshot, state)
      : active === "secrets"
        ? secretsBlocks(snapshot, state, { canEditSecrets, canEditOrgSecrets })
        : runtimeBlocks(snapshot, state, { canEditRuntime, canEnableAdmin });
  return {
    type: "modal",
    callback_id: "cg_channel_settings_modal",
    private_metadata: settingsMetadata({ ...state, tab: active }),
    title: plain("Channel settings"),
    close: plain("Done"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Settings for *#${escapeMrkdwn(channelName || "this channel")}*. Anyone authorized to use the agent here can edit these settings. Access settings and VPN controls require a channel manager or admin. Cloud MCP is admin-only.`)] },
      ...(notice ? [{ type: "section", text: mrkdwn(notice) }] : []),
      tabButtons(state, active, canEditAccess),
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

// A labelled dropdown that saves on pick. It has to be a SECTION accessory rather than an `input`
// block: Slack rejects a modal carrying input blocks without a submit button, and this tab has
// only "Done". A section accessory dispatches block_actions the moment a value is chosen, which is
// what lets the runtime tab persist each field in place instead of pushing a form.
// A stored value outside the catalog (a hand-set model, a model the CLI stopped listing) is
// appended rather than silently falling back to the first option, so the control never shows a
// value the channel is not actually running.
function selectRow({ label, actionId, options, initialValue }) {
  const known = options.some((entry) => entry.value === initialValue);
  const list = known || !initialValue
    ? options
    : [...options, { label: String(initialValue).slice(0, 60), value: initialValue, description: "Set outside the current catalog" }];
  const normalized = list.slice(0, 100).map((entry) => option(entry.label, entry.value, entry.description));
  return {
    type: "section",
    block_id: `${actionId}_row`,
    text: mrkdwn(`*${label}*`),
    accessory: {
      type: "static_select",
      action_id: actionId,
      placeholder: plain(label),
      options: normalized,
      initial_option: selected(normalized, initialValue),
    },
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
      optionalTextInput({ blockId: CONNECTION_COMPOSIO_LABEL_BLOCK_ID, actionId: CONNECTION_COMPOSIO_LABEL_ACTION_ID, label: "Composio label", placeholder: "Whose account? e.g. Team account", initialValue: connections.composioTokenLabel || "", hint: "An optional name to identify this account. Clear this field to remove the label; the token stays unchanged." }),
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
    ...(Object.hasOwn(values, CONNECTION_COMPOSIO_LABEL_BLOCK_ID)
      ? { composioTokenLabel: textValue(CONNECTION_COMPOSIO_LABEL_BLOCK_ID, CONNECTION_COMPOSIO_LABEL_ACTION_ID) }
      : {}),
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
