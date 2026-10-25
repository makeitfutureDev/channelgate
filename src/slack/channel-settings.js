// Channel Settings modal for Slack. It mirrors the web conversation editor's safe channel-level
// controls while keeping credential values write-only and re-authorizing every interaction in the
// controller. Dangerous gateway-wide/admin-only settings remain in the web admin UI.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ACCESS_FIELD_PREFIX, ACCESS_FLAGS, ACCESS_LABELS, ACCESS_SELECTS, ACCESS_USER_LISTS, accessSettingsSnapshot } from "./access-settings.js";
import { channelMode, modeLabel } from "../gateway/modes.js";
import { MIN_MASKABLE_LENGTH } from "../config/channel-env.js";
import { nextCronRun } from "../util/cron.js";
import { daemonTimeZone, zonedStamp } from "../util/timezone.js";
import { composioInventoryBlocks } from "./composio-inventory-view.js";

export const CHANNEL_SETTINGS_MODE_PREFIX = "cg_channel_settings_mode_";
export const CHANNEL_SETTINGS_OPTION_PREFIX = "cg_channel_settings_option_";
export const CHANNEL_SETTINGS_ACTION_ID = "cg_channel_settings";
// Pages are picked from one dropdown now. The per-tab button ids this prefix built still arrive
// from Settings views opened before that change: CHANNEL_SETTINGS_ACTION_PATTERN matches them, and
// the handler dispatches on the command in their value, so they keep working without the prefix
// being referenced anywhere.
export const CHANNEL_SETTINGS_TAB_PREFIX = "cg_channel_settings_tab_";
export const CHANNEL_SETTINGS_TAB_SELECT_ACTION_ID = "cg_channel_settings_tab_select";
// Kept only so a Settings modal opened before the inline dropdowns shipped still has a live
// control: the handler repaints the runtime tab instead of pushing the retired editor.
export const CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID = "cg_channel_settings_runtime_edit";
export const CHANNEL_SETTINGS_HARNESSES_ACTION_ID = "cg_channel_settings_harnesses";
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
// Custom MCP servers (src/gateway/custom-mcps.js) on the MCPs page: one pushed form adds or updates
// a server in either scope — the conversation's (`custom-<name>`, managers and admins) or the
// clicker's own (`my-<name>`) — and a Remove button per row. The scope rides in the button value
// and the form's metadata; the handler re-checks who may write it.
export const CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID = "cg_channel_settings_custom_mcp_add";
export const CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID = "cg_channel_settings_custom_mcp_remove";
export const CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID = "cg_channel_settings_custom_mcp_form";
export const CUSTOM_MCP_NAME_BLOCK_ID = "cg_custom_mcp_name";
export const CUSTOM_MCP_URL_BLOCK_ID = "cg_custom_mcp_url";
export const CUSTOM_MCP_TOKEN_BLOCK_ID = "cg_custom_mcp_token";
const CUSTOM_MCP_INPUT_ACTION_ID = "value";
export const CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX = "cg_channel_settings_cloud_engine_";
export const CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX = "cg_channel_settings_cloud_toggle_";
export const CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX = "cg_channel_settings_cloud_page_";
export const CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID = "cg_channel_settings_skills_manage";
export const CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX = "cg_channel_settings_skill_toggle_";
export const CHANNEL_SETTINGS_SKILL_PAGE_PREFIX = "cg_channel_settings_skill_page_";
// The template is one value out of a list, so it is picked in place like the runtime selects.
// The EDIT/CALLBACK pair below is the retired pushed editor, kept only so a Settings view (or a
// pushed modal) opened before the inline control shipped still resolves — the button repaints the
// page instead of pushing, and the callback still saves a modal that was already open.
export const CHANNEL_SETTINGS_TEMPLATE_SELECT_ACTION_ID = "cg_channel_settings_template_select";
export const CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID = "cg_channel_settings_template_edit";
export const CHANNEL_SETTINGS_TEMPLATE_CALLBACK_ID = "cg_channel_settings_template_form";
export const CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID = "cg_channel_settings_secrets_manage";
export const CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID = "cg_channel_settings_vpn_toggle";
export const CHANNEL_SETTINGS_VPN_REFRESH_ACTION_ID = "cg_channel_settings_vpn_refresh";
// Automations page controls. The schedule id rides in the button value and is re-checked against
// THIS channel's rows by the handler, so a stale or forged id can never touch another channel's.
export const CHANNEL_SETTINGS_AUTOMATION_TOGGLE_ACTION_ID = "cg_channel_settings_automation_toggle";
export const CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID = "cg_channel_settings_automation_delete";
// The redesigned pages' controls (2026-10): inline forms, the variable and schedule ⋯ menus, the
// in-place confirmations, the Access member ticks, and the in-place pickers.
export const CHANNEL_SETTINGS_ROOT_CALLBACK_ID = "cg_channel_settings_modal";
export const CHANNEL_SETTINGS_FORM_OPEN_ACTION_ID = "cg_channel_settings_form_open";
export const CHANNEL_SETTINGS_FORM_CANCEL_ACTION_ID = "cg_channel_settings_form_cancel";
export const CHANNEL_SETTINGS_FORM_REMOVE_ACTION_ID = "cg_channel_settings_form_remove";
export const CHANNEL_SETTINGS_VAR_MENU_ACTION_ID = "cg_channel_settings_var_menu";
export const CHANNEL_SETTINGS_SCHEDULE_MENU_ACTION_ID = "cg_channel_settings_schedule_menu";
export const CHANNEL_SETTINGS_CONFIRM_ACTION_ID = "cg_channel_settings_confirm";
export const CHANNEL_SETTINGS_CONFIRM_CANCEL_ACTION_ID = "cg_channel_settings_confirm_cancel";
export const CHANNEL_SETTINGS_MEMBER_ACTION_ID = "cg_channel_settings_member";
export const ACCESS_MEMBER_BLOCK_PREFIX = "cg_member_";
export const CHANNEL_SETTINGS_MEMBER_CLEAR_ACTION_ID = "cg_channel_settings_member_clear";
export const CHANNEL_SETTINGS_MEMBER_FIND_ACTION_ID = "cg_channel_settings_member_find";
export const CHANNEL_SETTINGS_FALLBACK_TOGGLE_ACTION_ID = "cg_channel_settings_fallback_toggle";
export const CHANNEL_SETTINGS_CLOUD_SELECT_PREFIX = "cg_channel_settings_cloud_select_";
export const CHANNEL_SETTINGS_SKILLS_SELECT_ACTION_ID = "cg_channel_settings_skills_select";
export const CHANNEL_SETTINGS_MY_SKILLS_SELECT_ACTION_ID = "cg_channel_settings_my_skills_select";
export const CHANNEL_SETTINGS_DM_MODE_ACTION_ID = "cg_channel_settings_dm_mode";
export const CHANNEL_SETTINGS_DM_FLAGS_ACTION_ID = "cg_channel_settings_dm_flags";
export const CHANNEL_SETTINGS_ACTION_PATTERN = /^cg_channel_settings(?:$|_)/;
// The pages the modal offers, in the order the page dropdown lists them (2026-10 redesign): what
// the agent is (Agent), who uses it (Access), what it reaches (MCP, Variables, Skills), what runs
// unattended (Schedules), and everything personal to the viewer (You). LEGACY_TABS lands a view
// or button from before the redesign on the page that now owns its controls.
export const CHANNEL_SETTINGS_TABS = Object.freeze(["agent", "access", "mcp", "variables", "skills", "schedules", "you"]);
const LEGACY_TABS = Object.freeze({ general: "agent", runtime: "agent", network: "agent", resume: "agent", secrets: "variables", automations: "schedules" });
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

export function escapeMrkdwn(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineCode(value) {
  return `\`${escapeMrkdwn(value || "—").replaceAll("`", "'")}\``;
}

export function normalizeTab(tab) {
  const value = String(tab || "").toLowerCase();
  if (CHANNEL_SETTINGS_TABS.includes(value)) return value;
  return LEGACY_TABS[value] || CHANNEL_SETTINGS_TABS[0];
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

// What did this control ask for? A button carries its command in `value`; a select carries it in
// the option the user landed on. Every other select on these pages holds a bare id (a model, an
// effort), which is not JSON and yields {} — the same answer an unrecognized control gets, so the
// handler's dispatch on `o` stays the only thing that decides what happens.
export function settingsCommand(action) {
  return parseActionValue(action?.selected_option?.value ?? action?.value);
}

export function settingsMetadata(state = {}) {
  return JSON.stringify({
    c: state.channelId,
    s: state.slug,
    t: state.threadTs || "",
    u: state.ownerId,
    p: normalizeTab(state.tab),
    // The inline form open on the page (`f`) and the in-place confirmation waiting (`x`).
    ...(state.form ? { f: String(state.form).slice(0, 200) } : {}),
    ...(state.form && state.formSecretId ? { fs: String(state.formSecretId).slice(0, 36) } : {}),
    ...(state.confirm ? { x: String(state.confirm).slice(0, 200) } : {}),
    // The person the Access page's search picked (`y`).
    ...(state.memberFocus ? { y: String(state.memberFocus).slice(0, 32) } : {}),
    ...(Number.isSafeInteger(state.composioPage) && state.composioPage > 0 ? { cp: Math.min(state.composioPage, 10_000) } : {}),
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
    form: typeof value.f === "string" ? value.f : "",
    ...(typeof value.fs === "string" && /^[0-9a-f-]{36}$/.test(value.fs) ? { formSecretId: value.fs } : {}),
    confirm: typeof value.x === "string" ? value.x : "",
    memberFocus: typeof value.y === "string" && /^[UW][A-Z0-9]+$/.test(value.y) ? value.y : "",
    ...(Number.isSafeInteger(value.cp) && value.cp > 0 ? { composioPage: Math.min(value.cp, 10_000) } : {}),
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



// A custom MCP scope as the page shows it: `c` the conversation's, `p` the viewer's own.
export function customMcpScope(letter) {
  return letter === "c" ? "channel" : letter === "p" ? "user" : "";
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
    toggle ? (enabled ? "Turn on" : "Turn off") : "Refresh", state, operation,
    { ...(toggle ? { enabled } : {}), signature: vpnActionSignature(state, operation, enabled) },
    toggle && enabled ? { style: "primary" } : {});
}

// The VPN is one more thing this channel's network either does or does not do, so it rides
// directly under the network switch instead of owning a section further down the page. One state
// word and its controls — the paragraphs explaining what a VPN is are documentation, not settings.
// A message is kept only for the two states whose label cannot say why on its own (a failure and
// an unavailable service), and that is exactly the diagnosis a refused toggle reports.
const VPN_STATE_LABELS = Object.freeze({
  unconfigured: "Not configured", unavailable: "Unavailable", off: "Off",
  starting: "Starting", on: "On", stopping: "Stopping", failed: "Failed",
});

function vpnRows(snapshot, state, { canManageVpn }) {
  const vpn = snapshot.vpn;
  const buttons = [vpnButton(state)];
  // Stopping remains possible while a tunnel is starting or failed. A running control operation
  // must settle before another one can be accepted by the service.
  if (canManageVpn && vpn?.configured && !vpn.busy && vpn.state !== "unavailable") {
    if (vpn.enabled || vpn.running || ["on", "starting"].includes(vpn.state)) buttons.unshift(vpnButton(state, false));
    else if (vpn.state !== "stopping" && vpn.allowNetwork && !vpn.missingSecrets?.length) buttons.unshift(vpnButton(state, true));
  }
  const explained = vpn?.message && ["failed", "unavailable"].includes(vpn.state);
  return [
    { type: "section", text: mrkdwn(`*VPN* — ${vpn ? (VPN_STATE_LABELS[vpn.state] || "Unknown") : "Checking status…"}`) },
    ...(explained ? [{ type: "context", elements: [mrkdwn(escapeMrkdwn(vpn.message))] }] : []),
    ...(vpn?.missingSecrets?.length
      ? [{ type: "context", elements: [mrkdwn(`Missing channel secrets: ${vpn.missingSecrets.map(inlineCode).join(", ")}`)] }]
      : []),
    { type: "actions", elements: buttons },
  ];
}





// This channel's schedules, one-time reminders and /loop wake-ups — the rows the agent's own
// create_schedule and the harness's loop calls write — so what will fire here unattended is visible
// without asking the agent. The controls are the ones the agent's tools already give any
// authorized user: pause/resume a recurring schedule, delete any row. A one-time row is only ever
// cancelled (resuming one whose time has passed would fire it at once), and a loop is stopped, not
// paused, because its tick budget and thread binding make a paused loop meaningless.
const AUTOMATION_LIST_LIMIT = 20;

function automationWhen(sched = {}, { now = new Date(), tz = daemonTimeZone() } = {}) {
  if (sched.once || sched.runAt) {
    const at = Date.parse(sched.runAt);
    return Number.isFinite(at) ? `Once · ${zonedStamp(new Date(at), { tz })}` : "Once";
  }
  const next = sched.enabled ? nextCronRun(sched.cron, now) : null;
  return `${inlineCode(sched.cron)}${next ? ` · next ${zonedStamp(next, { tz })}` : ""}`;
}

function automationKind(sched = {}) {
  if (sched.loop) return "Loop";
  if (sched.kind === "reminder") return sched.ack ? "Reminder · needs ✅" : "Reminder";
  return "Task";
}



const TAB_LABELS = Object.freeze({
  agent: "Agent",
  access: "Access",
  mcp: "MCP",
  variables: "Variables",
  skills: "Skills",
  schedules: "Schedules",
  you: "You",
});

// The pages a viewer is offered. A DM has one member — the viewer — so it has no Access page.
export function settingsPages({ isDM = false } = {}) {
  return CHANNEL_SETTINGS_TABS.filter((tab) => !(isDM && tab === "access"));
}

// Page navigation is ONE line: the conversation on the left, the page dropdown on the right.
// Slack lays out the buttons of an `actions` block in a modal as an equal-width two-column grid,
// so a row of seven tab buttons would be four rows tall — the dropdown costs a second click and
// saves a third of the first screen. The option values are the same `tab` command the old tab
// buttons carried, so both route through one handler.
function pageNav(state, active, { isDM = false } = {}) {
  const options = settingsPages({ isDM }).map((tab) => option(TAB_LABELS[tab], actionValue("tab", { p: tab })));
  return {
    type: "section",
    block_id: "cg_channel_settings_tabs",
    text: mrkdwn(isDM ? "*Direct message*" : `<#${escapeMrkdwn(state.channelId)}>`),
    accessory: {
      type: "static_select",
      action_id: CHANNEL_SETTINGS_TAB_SELECT_ACTION_ID,
      options,
      initial_option: options.find((entry) => parseActionValue(entry.value).p === active) || options[0],
    },
  };
}

// ── Inline forms ─────────────────────────────────────────────────────────────────────────────
// Editing a token, a URL or a variable opens its fields IN PLACE on the page instead of pushing a
// second modal. Slack only lets a modal carry input blocks when it has a submit button, so while a
// form is open the modal's footer button becomes "Save" and saving is a view submission — which
// is also what lets a refusal land under the field it is about. The open form rides in the view's
// metadata (`f`); its input block ids are keyed by the form, so a value typed into one form can
// never be carried into another by Slack's state retention.
export const SETTINGS_FIELD_ACTION_ID = "v";
// Write-only fields: their block ids rotate after a refused save, they are never refilled into a
// reopened form and never echoed in an error or a notice.
export const SETTINGS_SECRET_FIELDS = Object.freeze(["token", "value", "imapPassword", "smtpPassword"]);
// The fields a reopened form may be refilled with — every field a form reads, minus the secrets.
export const SETTINGS_DRAFT_FIELDS = Object.freeze(["label", "url", "name", "hosts", "address", "displayName", "imapHost", "imapPort", "imapUser", "smtpHost", "smtpPort", "smtpUser"]);
export function settingsFieldBlockId(form, field, secretId = "") {
  // Slack preserves typed values when both input identities survive views.update. A refused
  // async save rotates only write-only inputs; labels, URLs and other draft fields stay put.
  const key = secretId && SETTINGS_SECRET_FIELDS.includes(field) ? `${form}:${secretId}` : String(form);
  return `cgf_${field}_${createHmac("sha256", "cg-settings-form").update(key).digest("hex").slice(0, 8)}`;
}

// Which scope a form or row key names: c = this conversation, o = organization, p = the viewer.
export const FORM_SCOPES = Object.freeze({ c: "channel", o: "organization", p: "personal" });

// The form a key opens, or null for an unknown key. `snapshot` supplies the prefilled values (a URL,
// a label, the current allowed servers) — never a token or a variable's value.
export function settingsFormSpec(key, snapshot = {}) {
  const [kind, scope = "", ...rest] = String(key || "").split(":");
  const name = rest.join(":");
  const c = snapshot.connections || {};
  const my = snapshot.my || {};
  const token = (label, existing) => ({ name: "token", label, optional: Boolean(existing), placeholder: existing ? "Leave blank to keep the saved one" : "Stored write-only" });
  if (kind === "composio" && (scope === "c" || scope === "p")) {
    const saved = scope === "c" ? c.composioChannel?.configured : my.composio?.configured;
    return {
      key, title: scope === "c" ? "Shared Composio account" : "Your Composio account", removable: Boolean(saved),
      fields: [
        { name: "label", label: "Whose account", optional: true, placeholder: "e.g. Team account", initial: scope === "c" ? c.composioTokenLabel : my.composioLabel },
        token("Composio key", saved),
      ],
    };
  }
  if (kind === "make" && scope === "c") {
    return {
      key, title: "Make toolbox", removable: Boolean(c.makeToolboxUrl || c.makeToolboxKey?.configured),
      fields: [
        { name: "url", label: "Server URL", placeholder: "https://eu1.make.com/mcp/server/…", initial: c.makeToolboxUrl, maxLength: 500 },
        token("Key", c.makeToolboxKey?.configured),
      ],
    };
  }
  if (kind === "toolbox" && (scope === "c" || scope === "p")) {
    const saved = scope === "c" ? c.toolboxChannel?.configured : my.toolbox?.configured;
    return { key, title: scope === "c" ? "Toolbox token for this channel" : "Your Toolbox token", removable: Boolean(saved), fields: [{ name: "token", label: "Token", placeholder: "Bearer token, stored write-only" }] };
  }
  if (kind === "cm-add" && (scope === "c" || scope === "p")) {
    return {
      key, title: "New custom MCP server", removable: false,
      fields: [
        { name: "name", label: "Name", placeholder: "e.g. linear", maxLength: 32, hint: `Tools appear as ${scope === "c" ? "custom" : "my"}-<name>` },
        { name: "url", label: "Server URL", placeholder: "https://mcp.example.com/mcp", maxLength: 2048 },
        { name: "token", label: "Bearer token", placeholder: "Stored write-only" },
      ],
    };
  }
  if (kind === "cm" && (scope === "c" || scope === "p") && name) {
    const list = scope === "c" ? snapshot.customMcps?.channel : snapshot.customMcps?.personal;
    const entry = (Array.isArray(list) ? list : []).find((item) => item.name === name);
    if (!entry) return null;
    return {
      key, title: entry.serverName, removable: true,
      fields: [
        { name: "url", label: "Server URL", initial: entry.url, maxLength: 2048 },
        token("Bearer token", true),
      ],
    };
  }
  if (kind === "em-add" && (scope === "c" || scope === "p")) {
    return { key, title: "Connect email account", removable: false, fields: emailAccountFields({ scope }) };
  }
  if (kind === "em" && (scope === "c" || scope === "p") && name) {
    const list = scope === "c" ? snapshot.emailAccounts?.channel : snapshot.emailAccounts?.personal;
    const entry = (Array.isArray(list) ? list : []).find((item) => item.name === name);
    if (!entry) return null;
    return {
      key, title: `Edit email account ${name}`, removable: true, subject: `email account ${name}`,
      removeText: "Runs stop reading and sending mail with it, including any run in progress.",
      fields: emailAccountFields({ scope, entry }),
    };
  }
  if (kind === "var-add" && FORM_SCOPES[scope]) {
    return {
      key, title: "New variable", removable: false,
      fields: [
        { name: "name", label: "Name", placeholder: "SUPABASE_ACCESS_TOKEN", maxLength: 64 },
        { name: "value", label: "Value", placeholder: "Stored write-only, never shown again", maxLength: 3000 },
        { name: "secret", label: "Secret", type: "checkbox", optional: true, initial: true, option: "Programs see a stand-in; the real value only goes to allowed servers" },
        { name: "hosts", label: "Allowed servers", optional: true, placeholder: "Optional — api.example.com, *.example.com", maxLength: 500 },
      ],
    };
  }
  if ((kind === "var-val" || kind === "var-hosts") && FORM_SCOPES[scope] && name) {
    const entry = variableEntry(snapshot, FORM_SCOPES[scope], name);
    if (!entry) return null;
    return kind === "var-val"
      ? { key, title: `New value for ${name}`, removable: false, fields: [{ name: "value", label: "Value", placeholder: "Stored write-only", maxLength: 3000 }] }
      : {
        key, title: `Allowed servers for ${name}`, removable: false,
        fields: [{ name: "hosts", label: "Servers", optional: true, initial: (entry.hosts || []).join(", "), placeholder: "api.example.com, *.example.com", maxLength: 500, hint: "Empty = an admin approves each new server" }],
      };
  }
  return null;
}

export function variableEntry(snapshot = {}, scope, name) {
  const list = scope === "organization" ? snapshot.orgSecrets : scope === "personal" ? snapshot.personalSecrets : snapshot.secrets;
  return (Array.isArray(list) ? list : []).find((entry) => entry.name === name) || null;
}

// One form for a mailbox's IMAP and SMTP settings (src/gateway/email-accounts.js). `entry` is the
// stored masked record on an update: it prefills everything but the passwords, which are then
// optional (blank keeps the saved one). Blank ports take the defaults; blank SMTP user/password
// mean "same as IMAP".
function emailAccountFields({ scope, entry = null } = {}) {
  const password = (name, label, { optional = false, blankMeans = "" } = {}) => ({
    name, label, optional: Boolean(entry) || optional, maxLength: 1024,
    placeholder: entry ? "Leave blank to keep the saved one" : blankMeans || "Stored write-only",
  });
  return [
    ...(entry ? [] : [{ name: "name", label: "Name", placeholder: "e.g. work", maxLength: 32, hint: `A short handle for the account${scope === "c" ? " in this conversation" : ""}: work, support` }]),
    { name: "address", label: "Email address", placeholder: "name@example.com", maxLength: 254, initial: entry?.address },
    { name: "displayName", label: "Display name", optional: true, placeholder: "Optional — the sender's name", maxLength: 120, initial: entry?.displayName },
    { name: "imapHost", label: "IMAP server", placeholder: "imap.example.com", maxLength: 253, initial: entry?.imap?.host },
    { name: "imapPort", label: "IMAP port", optional: true, placeholder: "993", maxLength: 5, hint: "993 TLS · 143 STARTTLS", initial: entry?.imap?.port },
    { name: "imapUser", label: "IMAP user", placeholder: "name@example.com", maxLength: 320, initial: entry?.imap?.user },
    password("imapPassword", "IMAP password"),
    { name: "smtpHost", label: "SMTP server", placeholder: "smtp.example.com", maxLength: 253, initial: entry?.smtp?.host },
    { name: "smtpPort", label: "SMTP port", optional: true, placeholder: "587", maxLength: 5, hint: "465 TLS · 587 STARTTLS", initial: entry?.smtp?.port },
    { name: "smtpUser", label: "SMTP user", optional: true, placeholder: "Blank = same as IMAP", maxLength: 320, initial: entry?.smtp?.user },
    password("smtpPassword", "SMTP password", { optional: true, blankMeans: "Blank = same as IMAP" }),
  ];
}

// The values a submitted form carries, by field name, read from the root view's state.
export function readSettingsForm(view = {}, key, secretId = "") {
  const values = view?.state?.values || {};
  const out = {};
  for (const field of ["label", "token", "url", "name", "value", "hosts", "secret", "address", "displayName", "imapHost", "imapPort", "imapUser", "imapPassword", "smtpHost", "smtpPort", "smtpUser", "smtpPassword"]) {
    const entry = values[settingsFieldBlockId(key, field, secretId)]?.[SETTINGS_FIELD_ACTION_ID];
    if (!entry) continue;
    out[field] = field === "secret"
      ? (entry.selected_options || []).some((choice) => choice?.value === "secret")
      : String(entry.value || "").trim();
  }
  return out;
}

// `state.formError` ({ field, error }) is a refusal from the save that ran after Slack was answered
// (DNS, membership, a duplicate name): it is shown under its field, and `state.formDraft` refills
// the non-secret fields — a token is always typed again.
function formBlocks(spec, state) {
  const blocks = [{ type: "context", elements: [mrkdwn(`*${escapeMrkdwn(spec.title)}*`)] }];
  const draft = state.formDraft || {};
  const error = state.formError?.error ? state.formError : null;
  for (const raw of spec.fields) {
    const field = Object.hasOwn(draft, raw.name) && !SETTINGS_SECRET_FIELDS.includes(raw.name) ? { ...raw, initial: draft[raw.name] } : raw;
    const blockId = settingsFieldBlockId(spec.key, field.name, state.formSecretId);
    if (field.type === "checkbox") {
      const choice = option(field.label, "secret", field.option || "");
      blocks.push({
        type: "input", block_id: blockId, optional: true, label: plain(field.label),
        element: { type: "checkboxes", action_id: SETTINGS_FIELD_ACTION_ID, options: [choice], ...(field.initial ? { initial_options: [choice] } : {}) },
      });
      continue;
    }
    blocks.push({
      type: "input", block_id: blockId, optional: Boolean(field.optional), label: plain(field.label),
      element: {
        type: "plain_text_input", action_id: SETTINGS_FIELD_ACTION_ID, max_length: field.maxLength || 3000,
        ...(field.placeholder ? { placeholder: plain(field.placeholder) } : {}),
        ...(field.initial ? { initial_value: String(field.initial) } : {}),
      },
      ...(field.hint ? { hint: plain(field.hint) } : {}),
    });
    if (error && error.field === field.name) blocks.push(context(`⚠️ ${escapeMrkdwn(error.error)}`));
  }
  if (error && !spec.fields.some((field) => field.name === error.field)) blocks.push(context(`⚠️ ${escapeMrkdwn(error.error)}`));
  blocks.push({
    type: "actions",
    elements: [
      button(CHANNEL_SETTINGS_FORM_CANCEL_ACTION_ID, "Cancel", state, "form_cancel"),
      ...(spec.removable ? [button(CHANNEL_SETTINGS_FORM_REMOVE_ACTION_ID, "Remove", state, "form_remove", { f: spec.key }, {
        style: "danger",
        confirm: destructiveConfirm(`Remove ${spec.subject || spec.title}?`, spec.removeText || "Runs stop using it, including any run in progress. A token can't be recovered."),
      })] : []),
    ],
  });
  return blocks;
}

// A row that opens a form: its text, and an Edit (or Connect) button — or, while that form is
// open, the form itself under the text.
function editableRow(text, formKey, state, { editable = true, connected = true, label } = {}) {
  if (state.form === formKey) return [{ type: "section", text: mrkdwn(text) }];
  return [{
    type: "section",
    text: mrkdwn(text),
    ...(editable ? { accessory: button(CHANNEL_SETTINGS_FORM_OPEN_ACTION_ID, label || (connected ? "Edit" : "Connect"), state, "form_open", { f: formKey }) } : {}),
  }];
}

function withForm(blocks, formKey, snapshot, state) {
  if (state.form !== formKey) return blocks;
  const spec = settingsFormSpec(formKey, snapshot);
  return spec ? [...blocks, ...formBlocks(spec, state)] : blocks;
}

function confirmBlocks(state, text, confirmLabel) {
  return [
    { type: "section", text: mrkdwn(text) },
    { type: "actions", elements: [
      button(CHANNEL_SETTINGS_CONFIRM_ACTION_ID, confirmLabel, state, "confirm", { x: state.confirm }, { style: "danger" }),
      button(CHANNEL_SETTINGS_CONFIRM_CANCEL_ACTION_ID, "Cancel", state, "confirm_cancel"),
    ] },
  ];
}

const header = (text) => ({ type: "header", text: plain(text) });
const context = (text) => ({ type: "context", elements: [mrkdwn(text)] });
const masked = (value = {}) => (value.configured ? (value.last4 ? inlineCode(`••${value.last4}`) : "`••••`") : "");

// ── Agent ────────────────────────────────────────────────────────────────────────────────────
// Engine, model and effort as one row of dropdowns per scope (an actions block), the thread's
// first when Settings was opened from one; then the mode and its options in the same style.
function runtimeRow(scope, data = {}, state, { editable = true, codexLocked = false, reset = false } = {}) {
  const ids = RUNTIME_SELECT_ACTION_IDS[scope];
  const values = data.values || {};
  const inherited = data.inherited || {};
  const lists = { engine: data.options?.engines || [], model: data.options?.models || [], effort: data.options?.efforts || [] };
  const fields = RUNTIME_FIELDS.filter((field) => !(codexLocked && field === "engine"));
  if (!editable) {
    return [context(fields.map((field) => values[field] || inherited[field] || "default").map((value) => escapeMrkdwn(value)).join(" · "))];
  }
  const elements = fields.map((field) => {
    const options = [{ label: inherited[field] ? `${inherited[field]} (default)` : "Default", value: SETTINGS_DEFAULT_VALUE }, ...lists[field]];
    const known = options.some((entry) => entry.value === values[field]);
    const list = (known || !values[field] ? options : [...options, { label: String(values[field]), value: values[field] }]).slice(0, 100).map((entry) => option(entry.label, entry.value));
    return {
      type: "static_select",
      action_id: ids[field],
      placeholder: plain(field),
      options: list,
      initial_option: selected(list, values[field] || SETTINGS_DEFAULT_VALUE),
    };
  });
  if (reset) elements.push(button(CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID, "Use channel default", state, "thread_reset"));
  return [{ type: "actions", block_id: `cg_runtime_${scope}`, elements }];
}

const MODE_LABELS = Object.freeze({ read: "Read-only", worker: "Worker", admin: "Admin" });
const FLAG_LABELS = Object.freeze({ autoMode: "Auto-approve", cleanMode: "Lean", allowNetwork: "Internet" });

function modeRows(snapshot, state, { canEditAccess = false, canEnableAdmin = false } = {}) {
  const mode = snapshot.mode || {};
  const current = channelMode(mode);
  const dm = Boolean(snapshot.isDM);
  const flags = dm ? ["autoMode", "cleanMode"] : ["autoMode", "cleanMode", "allowNetwork"];
  if (!dm && !canEditAccess) {
    const on = flags.filter((flag) => mode[flag]).map((flag) => FLAG_LABELS[flag]);
    return [context(`*Mode* · ${MODE_LABELS[current] || modeLabel(mode)}${on.length ? ` · ${on.join(" · ")}` : ""}`), context("🔒 Managers and admins change the mode.")];
  }
  // "Admin" is offered only to someone who may enable it (an organization admin) or when it is
  // already the current mode, so a manager's view shows the truth and can still leave Admin.
  const modes = ["read", "worker", ...(canEnableAdmin || current === "admin" ? ["admin"] : [])];
  const modeOptions = modes.map((value) => option(MODE_LABELS[value], value));
  const flagOptions = flags.map((flag) => option(FLAG_LABELS[flag], flag));
  const chosen = flagOptions.filter((entry) => mode[entry.value]);
  return [
    context("*Mode*"),
    { type: "actions", block_id: "cg_mode_row", elements: [{
      type: "static_select",
      action_id: dm ? CHANNEL_SETTINGS_DM_MODE_ACTION_ID : `${ACCESS_FIELD_PREFIX}mode`,
      options: modeOptions,
      initial_option: selected(modeOptions, current),
    }] },
    { type: "actions", block_id: "cg_mode_flags", elements: [{
      type: "checkboxes",
      action_id: dm ? CHANNEL_SETTINGS_DM_FLAGS_ACTION_ID : `${ACCESS_FIELD_PREFIX}flags`,
      options: flagOptions,
      ...(chosen.length ? { initial_options: chosen } : {}),
    }] },
  ];
}

// Slack dispatches a multi-select after each click. Selecting an individual option while the
// initial All chip remains must start a restriction; selecting All on a restricted set clears it.
export function readHarnessSelection(action, meta) {
  const picked = (action?.selected_options || []).map((o) => o.value);
  const specific = picked.filter((value) => value !== SETTINGS_DEFAULT_VALUE);
  if (picked.includes(SETTINGS_DEFAULT_VALUE)) {
    return meta?.approvedEngines == null && specific.length ? specific : null;
  }
  return specific;
}

function harnessRows(runtime, opts) {
  const policy = runtime.approvedEngines;
  const labels = (runtime.harnessOptions || []).filter((o) => policy?.includes(o.value)).map((o) => o.label);
  const summary = policy == null ? "All harnesses" : labels.join(", ") || "No available harnesses";
  const heading = context(`*Approved harnesses · Enterprise* · ${escapeMrkdwn(summary)}`);
  if (!opts.canApproveHarnesses) return [heading];
  const options = [option("All harnesses", SETTINGS_DEFAULT_VALUE), ...(runtime.harnessOptions || []).map((o) => option(o.label, o.value))];
  const selectedValues = policy == null ? [SETTINGS_DEFAULT_VALUE] : policy;
  // Slack refuses the whole view (`invalid_arguments`) when `initial_options` is an empty list, so
  // a policy that is empty or names only engines this build no longer offers starts unselected.
  const initial = options.filter((o) => selectedValues.includes(o.value));
  // A multi-select is NOT a valid `actions` element (Slack: "unsupported element: multiselect");
  // it may only be a section accessory or an input. Live Settings refused to open for admins
  // on Enterprise installs until this moved.
  return [heading, {
    type: "section", block_id: "cg_channel_settings_harnesses", text: mrkdwn("*Approved harnesses*"),
    accessory: {
      type: "multi_static_select", action_id: CHANNEL_SETTINGS_HARNESSES_ACTION_ID,
      placeholder: plain("Approve one or more harnesses"), options,
      ...(initial.length ? { initial_options: initial } : {}),
    },
  }, context("Choose one or more harnesses. Select All harnesses to remove the restriction. The channel default must be approved. Thread pins and automatic fallback follow this policy.")];
}

function agentPage(snapshot, state, opts) {
  const runtime = snapshot.runtime || {};
  const scopes = runtime.scopes || {};
  const thread = scopes.thread || null;
  const editable = opts.canEditRuntime !== false;
  const locked = Boolean(runtime.channelLogin);
  const vpn = snapshot.vpn;
  const resume = snapshot.resume || {};
  return [
    ...(locked ? [context(`*Codex* · this channel's own login · ${escapeMrkdwn(runtime.channelLoginStatus || "checking…")}`)] : []),
    ...(thread ? [
      context(`*This thread*${thread.pinned ? " · 📌 pinned" : ""}`),
      ...runtimeRow("thread", thread, state, { editable, codexLocked: locked, reset: editable && thread.pinned }),
      ...(thread.sessionEngineLabel ? [context(`_Its session runs on ${escapeMrkdwn(thread.sessionEngineLabel)} until you pin an engine._`)] : []),
    ] : []),
    context("*Channel default*"),
    ...runtimeRow("channel", scopes.channel, state, { editable, codexLocked: locked }),
    ...(editable ? [] : [context("🔒 The gateway's policy limits engine changes to admins.")]),
    ...harnessRows(runtime, opts),
    { type: "divider" },
    ...modeRows(snapshot, state, opts),
    // No service provisioned: one line, no controls. A provisioned one (or one still being read —
    // `vpn` absent until the hydration pass fills it in) gets its state and controls.
    ...(vpn && vpn.configured === false ? [context("VPN · Not configured")] : vpnRows(snapshot, state, { canManageVpn: opts.canManageVpn })),
    ...(resume.inThread && resume.command ? [
      { type: "divider" },
      { type: "section", text: mrkdwn(`*Resume in a terminal*\n\`\`\`${escapeMrkdwn(resume.command)}\`\`\``) },
    ] : []),
  ];
}

// ── Access ───────────────────────────────────────────────────────────────────────────────────
// Who may use and manage the conversation, then the PEOPLE with a setting of their own here —
// guests, excluded members, named managers — and a people search (Slack's own users_select) to
// reach anyone else. Everyone the policy admits needs no row, so the list stays short in any size
// of channel and costs no Slack API call to draw. Each person is one section with a checkboxes
// accessory (Use, plus Manage when the channel names its managers), so a tick saves on its own.
export const ACCESS_PEOPLE_LIMIT = 60;

function memberRow(member, { canEditAccess, named }) {
  const role = member.isAdmin ? "admin" : member.excluded ? "excluded here" : member.guest ? "guest here" : member.approved ? "approved" : "not approved";
  const text = `<@${escapeMrkdwn(member.id)}>  _${role}_`;
  if (member.isAdmin) return { type: "section", text: mrkdwn(`${text} · always`) };
  if (!canEditAccess) return { type: "section", text: mrkdwn(`${text} · ${member.use ? "✅ can use" : "—"}${named && member.manage ? " · manages" : ""}`) };
  const options = [option("Use", "use"), ...(named ? [option("Manage", "manage")] : [])];
  const initial = options.filter((entry) => (entry.value === "use" ? member.use : member.manage));
  return {
    type: "section",
    block_id: `${ACCESS_MEMBER_BLOCK_PREFIX}${member.id}`,
    text: mrkdwn(text),
    accessory: { type: "checkboxes", action_id: CHANNEL_SETTINGS_MEMBER_ACTION_ID, options, ...(initial.length ? { initial_options: initial } : {}) },
  };
}

function accessPage(snapshot, state, { canEditAccess = false } = {}) {
  const access = accessSettingsSnapshot(snapshot.access || {});
  const named = access.manageAccess === "custom";
  const label = (field) => ACCESS_SELECTS[field].find((entry) => entry.value === access[field])?.label || access[field];
  const rows = [];
  if (canEditAccess) {
    rows.push(
      selectRow({ label: "Who can use it", actionId: `${ACCESS_FIELD_PREFIX}access`, options: ACCESS_SELECTS.access.map((entry) => ({ ...entry })), initialValue: access.access }),
      selectRow({ label: "Who can manage it", actionId: `${ACCESS_FIELD_PREFIX}manageAccess`, options: ACCESS_SELECTS.manageAccess.map((entry) => ({ ...entry })), initialValue: access.manageAccess }),
    );
  } else {
    rows.push(context("🔒 Only managers and admins change access."), fieldBlock("Who can use it", escapeMrkdwn(label("access"))), fieldBlock("Who can manage it", escapeMrkdwn(label("manageAccess"))));
  }
  rows.push(header("People"));
  rows.push({ type: "actions", block_id: "cg_member_find", elements: [
    {
      type: "users_select", action_id: CHANNEL_SETTINGS_MEMBER_FIND_ACTION_ID, placeholder: plain("Find a person…"),
      ...(state.memberFocus ? { initial_user: state.memberFocus } : {}),
    },
    ...(state.memberFocus ? [button(CHANNEL_SETTINGS_MEMBER_CLEAR_ACTION_ID, "Show list", state, "member_clear")] : []),
  ] });
  if (state.memberFocus) {
    const focus = snapshot.focusMember;
    if (!focus || focus.id !== state.memberFocus) rows.push(context("_Couldn't look that person up. Try again._"));
    else if (focus.inChannel === false) rows.push(context(`<@${escapeMrkdwn(focus.id)}> isn't in this channel. Invite them first, then tick Use.`));
    else rows.push(memberRow(focus, { canEditAccess, named }));
    return rows;
  }
  const people = Array.isArray(snapshot.people) ? snapshot.people : [];
  if (!people.length) {
    rows.push(context("_No one has a setting of their own here._"));
    return rows;
  }
  for (const person of people.slice(0, ACCESS_PEOPLE_LIMIT)) rows.push(memberRow(person, { canEditAccess, named }));
  if (people.length > ACCESS_PEOPLE_LIMIT) rows.push(context(`${people.length - ACCESS_PEOPLE_LIMIT} more — search for a person to change them.`));
  return rows;
}

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────
function connectionRows(snapshot, state, scope, opts) {
  const c = snapshot.connections || {};
  const my = snapshot.my || {};
  const blocks = [];
  // Composio
  blocks.push(header("Composio"));
  if (c.composioMode === "sdk") {
    blocks.push(context(scope === "c"
      ? `SDK mode · ${c.composioSdkReady ? "the organization identity is ready" : "the organization key or entitlement is missing"}`
      : "SDK mode · your session is created automatically"));
  } else {
    const saved = scope === "c" ? c.composioChannel : my.composio;
    const labelText = scope === "c" ? c.composioTokenLabel : my.composioLabel;
    const status = saved?.configured ? `${masked(saved)}${labelText ? ` · ${escapeMrkdwn(labelText)}` : ""}` : scope === "c" && !c.noDefaultTokens && c.composioOrg?.configured ? "_uses the organization account_" : "_not connected_";
    const form = `composio:${scope}`;
    blocks.push(...withForm(editableRow(`*${scope === "c" ? "Shared account" : "Your account"}* ${inlineCode(scope === "c" ? "composio-agent" : "composio-user")}\n${status}`, form, state, { connected: Boolean(saved?.configured) }), form, snapshot, state));
  }
  if (!state.form) blocks.push(...composioInventoryBlocks(snapshot.composioInventory, {
    page: state.composioPage || 0,
    command: (operation, extra = {}) => actionValue(operation, { c: state.channelId, s: state.slug, u: state.ownerId, ...extra }),
  }));
  // Make toolbox (a conversation's only)
  if (scope === "c") {
    blocks.push(header("Make toolbox"));
    const status = c.makeToolboxUrl ? `${escapeMrkdwn(String(c.makeToolboxUrl).replace(/^https:\/\//, ""))} ${masked(c.makeToolboxKey)}` : "_not connected_";
    blocks.push(...withForm(editableRow(`${inlineCode("make-toolbox")}\n${status}`, "make:c", state, { connected: Boolean(c.makeToolboxUrl) }), "make:c", snapshot, state));
  }
  // Toolbox — one server for the whole gateway (Settings → Integrations), a token per scope.
  blocks.push(header("Toolbox"));
  const toolbox = scope === "c" ? c.toolboxChannel : my.toolbox;
  const toolboxStatus = toolbox?.configured
    ? `${masked(toolbox)} · ${scope === "c" ? "this channel's token" : "your token"}`
    : scope === "c" ? (c.noDefaultTokens ? "_not set · organization token refused here_" : c.toolboxOrg?.configured ? "_each person's own token, else the organization's_" : "_each person's own token_") : "_not set_";
  const server = c.toolboxUrl ? ` · ${escapeMrkdwn(String(c.toolboxUrl).replace(/^https:\/\//, ""))}` : "";
  blocks.push(...withForm(editableRow(`${inlineCode("makeitfuture-toolbox")}${server}\n${toolboxStatus}`, `toolbox:${scope}`, state, { connected: Boolean(toolbox?.configured) }), `toolbox:${scope}`, snapshot, state));
  if (scope === "c") {
    const fallback = option("Fall back to organization tokens", "fallback");
    blocks.push({ type: "actions", block_id: "cg_connections_fallback", elements: [{
      type: "checkboxes", action_id: CHANNEL_SETTINGS_FALLBACK_TOGGLE_ACTION_ID, options: [fallback], ...(c.noDefaultTokens ? {} : { initial_options: [fallback] }),
    }] });
  }
  // Custom MCP
  blocks.push(header("Custom MCP"));
  const list = (scope === "c" ? snapshot.customMcps?.channel : snapshot.customMcps?.personal) || [];
  const editable = scope === "p" || Boolean(opts.canManageCustomMcp);
  for (const entry of list) {
    const form = `cm:${scope}:${entry.name}`;
    const row = editableRow(`${inlineCode(entry.serverName)} ${escapeMrkdwn(String(entry.url || "").replace(/^https:\/\//, "").slice(0, 200))} ${inlineCode(`••${entry.tokenLast4 || ""}`)}`, form, state, { editable });
    blocks.push(...withForm(row, form, snapshot, state));
  }
  const addKey = `cm-add:${scope}`;
  if (state.form === addKey) blocks.push(...withForm([], addKey, snapshot, state));
  else if (editable) blocks.push({ type: "actions", elements: [button(CHANNEL_SETTINGS_FORM_OPEN_ACTION_ID, "+ Add custom MCP", state, "form_open", { f: addKey })] });
  else blocks.push(context(list.length ? "🔒 Managers change these. Add your own under *You*." : "_None._ Managers add them here; add your own under *You*."));
  // Email accounts — masked rows (name, address, servers); passwords never reach the snapshot.
  // The conversation's follow the custom MCP gate (a manager's call); a person's own are theirs.
  blocks.push(header("Email accounts"));
  const accounts = (scope === "c" ? snapshot.emailAccounts?.channel : snapshot.emailAccounts?.personal) || [];
  const canEditEmail = scope === "p" || Boolean(opts.canManageCustomMcp);
  for (const account of accounts) {
    const form = `em:${scope}:${account.name}`;
    const server = (endpoint = {}) => escapeMrkdwn(`${endpoint.host || ""}:${endpoint.port || ""}`);
    const row = editableRow(`${inlineCode(account.name)} · ${escapeMrkdwn(String(account.address || "").slice(0, 120))} · IMAP ${server(account.imap)} · SMTP ${server(account.smtp)}`, form, state, { editable: canEditEmail });
    blocks.push(...withForm(row, form, snapshot, state));
  }
  const emailAddKey = `em-add:${scope}`;
  if (state.form === emailAddKey) blocks.push(...withForm([], emailAddKey, snapshot, state));
  else if (canEditEmail) blocks.push({ type: "actions", elements: [button(CHANNEL_SETTINGS_FORM_OPEN_ACTION_ID, "+ Connect email account", state, "form_open", { f: emailAddKey })] });
  else blocks.push(context(accounts.length ? "🔒 Managers change these. Connect your own under *You*." : "_None._ Managers connect them here; connect your own under *You*."));
  return blocks;
}

function cloudRows(snapshot) {
  const cloud = snapshot.cloudMcp || {};
  const blocks = [header("Cloud MCP")];
  for (const engine of ["claude", "codex"]) {
    const data = cloud[engine] || {};
    blocks.push(context(`*${engine === "claude" ? "Claude" : "Codex"}*`));
    if (!data.ready) {
      blocks.push(context("_Loading the catalog… switch pages to refresh._"));
      continue;
    }
    const options = (data.options || []).slice(0, 100).map((entry) => option(entry.label, entry.key));
    if (!options.length) {
      blocks.push(context("_No servers configured on the host._"));
      continue;
    }
    const initial = options.filter((entry) => (data.selected || []).includes(entry.value));
    blocks.push({ type: "section", block_id: `cg_cloud_${engine}`, text: mrkdwn("Select servers"), accessory: {
      type: "multi_static_select", action_id: `${CHANNEL_SETTINGS_CLOUD_SELECT_PREFIX}${engine}`, placeholder: plain("Add a server…"), options,
      ...(initial.length ? { initial_options: initial } : {}),
    } });
    if (data.inherited?.length) blocks.push(context(`Always on from the organization: ${data.inherited.map(inlineCode).join(" ")}`));
  }
  return blocks;
}

function mcpPage(snapshot, state, opts) {
  return [
    ...connectionRows(snapshot, state, "c", opts),
    ...(opts.canManageCloudMcp ? cloudRows(snapshot) : []),
  ];
}

// ── Variables ────────────────────────────────────────────────────────────────────────────────
// One line per variable with a ⋯ menu: Replace value · Allowed servers · Make readable/secret ·
// Remove. The two that cannot be undone (Remove, and Make readable, which hands programs the
// real value) ask in place first; an overflow menu can only carry one confirmation for all of its
// options, which would make every choice ask.
export function variableWhere(entry = {}) {
  const hosts = entry.hosts || [];
  const list = hosts.length ? `${escapeMrkdwn(hosts[0])}${hosts.length > 1 ? ` +${hosts.length - 1}` : ""}` : "";
  if (entry.protected && entry.approval) return list ? `🔒 approved for ${list}` : "🔒 secret · an admin approves each server";
  if (entry.protected) return `🔒 ${list}`;
  return entry.exposureChoice === "hidden" ? "👁 readable · kept readable: add allowed servers to hide it" : "👁 readable";
}

function variableRows(snapshot, state, letter, { editable = false } = {}) {
  const scope = FORM_SCOPES[letter];
  const list = (scope === "organization" ? snapshot.orgSecrets : scope === "personal" ? snapshot.personalSecrets : snapshot.secrets) || [];
  const blocks = [];
  for (const entry of list) {
    const text = `*${escapeMrkdwn(entry.name)}* ${entry.last4 ? inlineCode(`••${entry.last4}`) : "`••••`"}\n${variableWhere(entry)}`;
    const valForm = `var-val:${letter}:${entry.name}`;
    const hostForm = `var-hosts:${letter}:${entry.name}`;
    const open = state.form === valForm || state.form === hostForm;
    const row = { type: "section", text: mrkdwn(text) };
    if (editable && !open) {
      const act = (a, label) => option(label, JSON.stringify({ o: "var", s: letter, n: entry.name, a }));
      row.accessory = {
        type: "overflow", action_id: CHANNEL_SETTINGS_VAR_MENU_ACTION_ID,
        options: [
          act("value", "Replace value"),
          act("hosts", "Allowed servers"),
          entry.protected ? act("readable", "Make readable") : act("secret", "Make secret"),
          act("remove", "Remove"),
        ],
      };
    }
    blocks.push(row);
    if (state.form === valForm) blocks.push(...withForm([], valForm, snapshot, state));
    if (state.form === hostForm) blocks.push(...withForm([], hostForm, snapshot, state));
    if (state.confirm === `var-rm:${letter}:${entry.name}`) {
      blocks.push(...confirmBlocks(state, `Remove *${escapeMrkdwn(entry.name)}*? Runs stop receiving it; the value can't be recovered.`, "Remove"));
    }
    if (state.confirm === `var-read:${letter}:${entry.name}`) {
      blocks.push(...confirmBlocks(state, `Make *${escapeMrkdwn(entry.name)}* readable? Programs here will see the real value. Use this for passwords, database URLs and signing keys.`, "Make readable"));
    }
  }
  if (!list.length) blocks.push(context("_None._"));
  const addKey = `var-add:${letter}`;
  if (state.form === addKey) blocks.push(...withForm([], addKey, snapshot, state));
  else if (editable) blocks.push({ type: "actions", elements: [button(CHANNEL_SETTINGS_FORM_OPEN_ACTION_ID, "+ Add variable", state, "form_open", { f: addKey })] });
  return blocks;
}

function variablesPage(snapshot, state, opts) {
  return [
    header(`Channel · ${(snapshot.secrets || []).length}`),
    ...variableRows(snapshot, state, "c", { editable: Boolean(opts.canEditSecrets) }),
    header(`Organization · ${(snapshot.orgSecrets || []).length}`),
    ...variableRows(snapshot, state, "o", { editable: Boolean(opts.canEditOrgSecrets) }),
    ...(opts.canEditOrgSecrets ? [] : [context("🔒 Admins manage organization variables.")]),
    context("Your personal variables are under *You*."),
  ];
}

// ── Skills ───────────────────────────────────────────────────────────────────────────────────
function skillPicker(actionId, data = {}, placeholder) {
  const options = (data.options || []).slice(0, 100).map((entry) => option(entry.label || entry.key, entry.key, entry.description || ""));
  const initial = options.filter((entry) => (data.selected || []).includes(entry.value));
  if (!options.length) return [context("_No skills available in the catalog._")];
  return [{ type: "section", block_id: `${actionId}_row`, text: mrkdwn("Select skills"), accessory: {
    type: "multi_static_select", action_id: actionId, placeholder: plain(placeholder), options,
    ...(initial.length ? { initial_options: initial } : {}),
  } }, ...((data.options || []).length > 100 ? [context(`Showing 100 of ${data.options.length} skills; the admin UI lists them all.`)] : [])];
}

function skillsPage(snapshot, state) {
  const skills = snapshot.skills || {};
  const templates = Array.isArray(skills.templates) ? skills.templates : [];
  const direct = new Set((skills.additional || []).map((value) => String(value).toLowerCase()));
  const fromTemplate = (skills.channel || []).filter((value) => !direct.has(String(value).toLowerCase()));
  const org = skills.organization || [];
  const short = (list) => `${list.slice(0, 6).map(inlineCode).join(" ")}${list.length > 6 ? ` +${list.length - 6} more` : ""}`;
  return [
    templates.length
      ? selectRow({
        label: "Template", actionId: CHANNEL_SETTINGS_TEMPLATE_SELECT_ACTION_ID,
        options: [{ label: "None", value: SETTINGS_NONE_VALUE }, ...templates.map((entry) => ({ label: entry.name || entry.slug, value: entry.slug }))],
        initialValue: skills.templateSlug || SETTINGS_NONE_VALUE,
      })
      : fieldBlock("Template", "_none defined_"),
    context(`*Channel skills* · ${direct.size}`),
    ...skillPicker(CHANNEL_SETTINGS_SKILLS_SELECT_ACTION_ID, snapshot.skillPicker, "Add a skill…"),
    ...(fromTemplate.length ? [context(`From the *${escapeMrkdwn(skills.template || "template")}* template: ${short(fromTemplate)}`)] : []),
    ...(org.length ? [context(`Always on from the organization (${org.length}): ${short(org)}`)] : []),
  ];
}

// ── Schedules ────────────────────────────────────────────────────────────────────────────────
function scheduleRows(snapshot, state) {
  const list = Array.isArray(snapshot.automations) ? snapshot.automations : [];
  if (!list.length) return [context("_No schedules here._ Ask the agent, e.g. “every weekday at 9 summarize new issues”.")];
  const tz = daemonTimeZone();
  const blocks = [];
  for (const sched of list.slice(0, AUTOMATION_LIST_LIMIT)) {
    const title = String(sched.loop ? sched.loopReason || sched.prompt || "Loop" : sched.description || sched.prompt || sched.id).replace(/\s+/g, " ").trim();
    const recurring = !sched.loop && !sched.once && !sched.runAt;
    const last = sched.lastStatus ? ` · ${String(sched.lastStatus).startsWith("ok") ? "✅" : "⚠️"} last: ${escapeMrkdwn(String(sched.lastStatus).slice(0, 80))}` : "";
    const text = `*${sched.enabled ? "▶" : "⏸"} ${escapeMrkdwn(title.slice(0, 120))}*\n${automationKind(sched)} · ${automationWhen(sched, { tz })}${sched.enabled ? "" : " · paused"}${last}`;
    const remove = sched.loop ? "Stop loop" : recurring ? "Delete" : "Cancel";
    const accessory = recurring
      ? { type: "overflow", action_id: CHANNEL_SETTINGS_SCHEDULE_MENU_ACTION_ID, options: [
        option(sched.enabled ? "Pause" : "Resume", JSON.stringify({ o: "sched", id: String(sched.id), a: "toggle", e: !sched.enabled })),
        option(remove, JSON.stringify({ o: "sched", id: String(sched.id), a: "delete" })),
      ] }
      : button(CHANNEL_SETTINGS_AUTOMATION_DELETE_ACTION_ID, remove, state, "automation_delete", { id: sched.id }, {
        style: "danger", confirm: destructiveConfirm(`${remove}?`, `*${escapeMrkdwn(title.slice(0, 80))}* will not run again.`, remove),
      });
    blocks.push({ type: "section", text: mrkdwn(text), accessory });
    if (state.confirm === `sched-rm:${sched.id}`) blocks.push(...confirmBlocks(state, `Delete *${escapeMrkdwn(title.slice(0, 80))}*? It will not run again.`, "Delete"));
  }
  if (list.length > AUTOMATION_LIST_LIMIT) blocks.push(context(`${list.length - AUTOMATION_LIST_LIMIT} more — the admin UI lists them all.`));
  return blocks;
}

// ── You ──────────────────────────────────────────────────────────────────────────────────────
function youPage(snapshot, state, opts) {
  return [
    context("Only *your* runs use these, in every conversation."),
    ...connectionRows(snapshot, state, "p", opts),
    header(`Variables · ${(snapshot.personalSecrets || []).length}`),
    ...variableRows(snapshot, state, "p", { editable: true }),
    header("Skills"),
    ...skillPicker(CHANNEL_SETTINGS_MY_SKILLS_SELECT_ACTION_ID, snapshot.mySkillPicker, "Add a skill for your runs…"),
  ];
}

const MAX_VIEW_BLOCKS = 100;

export function buildChannelSettingsView(snapshot = {}, state = {}, {
  tab = state.tab,
  canEditRuntime = true,
  canApproveHarnesses = false,
  canEnableAdmin = false,
  canEditSecrets = false,
  // The organization scope reaches every conversation, so it is admin-only even for someone who
  // may edit this channel's own secrets.
  canEditOrgSecrets = false,
  canManageCloudMcp = false,
  canManageCustomMcp = false,
  canEditAccess = false,
  canManageVpn = false,
  notice = "",
} = {}) {
  const pages = settingsPages({ isDM: snapshot.isDM });
  const wanted = normalizeTab(tab);
  const active = pages.includes(wanted) ? wanted : pages[0];
  const opts = { canApproveHarnesses, canEditRuntime, canEnableAdmin, canEditSecrets, canEditOrgSecrets, canManageCloudMcp, canManageCustomMcp, canEditAccess, canManageVpn };
  const content = {
    agent: agentPage, access: accessPage, mcp: mcpPage, variables: variablesPage,
    skills: skillsPage, schedules: scheduleRows, you: youPage,
  }[active](snapshot, state, opts);
  let blocks = [
    pageNav(state, active, { isDM: snapshot.isDM }),
    ...(notice ? [{ type: "section", text: mrkdwn(notice) }] : []),
    { type: "divider" },
    ...content,
  ];
  if (blocks.length > MAX_VIEW_BLOCKS) blocks = [...blocks.slice(0, MAX_VIEW_BLOCKS - 1), context("_This page has more than Slack can show; the admin UI lists everything._")];
  const hasForm = blocks.some((block) => block.type === "input");
  return {
    type: "modal",
    callback_id: CHANNEL_SETTINGS_ROOT_CALLBACK_ID,
    private_metadata: settingsMetadata({ ...state, tab: active }),
    title: plain("Settings"),
    ...(hasForm ? { submit: plain("Save"), close: plain("Close") } : { close: plain("Done") }),
    blocks,
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

// The pushed form behind "Add or update …" on the MCPs page. Saving an existing name with the token
// left blank keeps the stored token (a URL change); a new name needs one.
export function buildCustomMcpEditorView(state = {}, { scope = "user", channelName = "", existing = [] } = {}) {
  const channel = scope === "channel";
  const names = (Array.isArray(existing) ? existing : []).map((entry) => entry.name).filter(Boolean);
  return {
    type: "modal",
    callback_id: CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID,
    private_metadata: editorMetadata(state, { view: channel ? "custom_mcp_c" : "custom_mcp_p" }),
    title: plain(channel ? "Conversation MCP server" : "My MCP server"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(channel
        ? `Every run in *#${escapeMrkdwn(channelName || "this channel")}* receives this server as \`custom-<name>\`.`
        : "Only runs you start receive this server, as `my-<name>`, in every conversation you talk in.")] },
      {
        type: "input",
        block_id: CUSTOM_MCP_NAME_BLOCK_ID,
        label: plain("Name"),
        element: { type: "plain_text_input", action_id: CUSTOM_MCP_INPUT_ACTION_ID, placeholder: plain("e.g. linear"), max_length: 32 },
        hint: plain(names.length
          ? `Lowercase letters, digits and dashes. Saved here: ${names.join(", ").slice(0, 120)} — reuse a name to update it.`
          : "Lowercase letters, digits and dashes."),
      },
      {
        type: "input",
        block_id: CUSTOM_MCP_URL_BLOCK_ID,
        label: plain("Server URL"),
        element: { type: "plain_text_input", action_id: CUSTOM_MCP_INPUT_ACTION_ID, placeholder: plain("https://mcp.example.com/mcp"), max_length: 2048 },
        hint: plain("HTTPS, on a public address."),
      },
      optionalTextInput({
        blockId: CUSTOM_MCP_TOKEN_BLOCK_ID,
        actionId: CUSTOM_MCP_INPUT_ACTION_ID,
        label: "Bearer token",
        placeholder: "Required for a new server",
        maxLength: 3000,
        hint: "Stored write-only and never shown again. Leave blank when updating an existing server to keep its token.",
      }),
    ],
  };
}

// A submitted secret-bearing form is popped before remote validation. This safe status view
// occupies its existing parent; retry opens a fresh blank form rather than replaying a token.
export function buildCustomMcpStatusView(state, { scope, message, retry = false } = {}) {
  return {
    type: "modal",
    callback_id: "cg_channel_settings_modal",
    private_metadata: settingsMetadata({ ...state, tab: "mcp" }),
    title: plain("Channel settings"),
    close: plain("Done"),
    blocks: [
      { type: "section", text: mrkdwn(escapeMrkdwn(message || "Checking access and the server address…")) },
      ...(retry ? [{ type: "actions", elements: [button(CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID, "Try again", state, "custom_mcp_add", { s: scope === "channel" ? "c" : "p" })] }] : []),
    ],
  };
}

export function readCustomMcpForm(view = {}) {
  const values = view?.state?.values || {};
  const text = (blockId) => String(values[blockId]?.[CUSTOM_MCP_INPUT_ACTION_ID]?.value || "").trim();
  return { name: text(CUSTOM_MCP_NAME_BLOCK_ID), url: text(CUSTOM_MCP_URL_BLOCK_ID), token: text(CUSTOM_MCP_TOKEN_BLOCK_ID) };
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
    const inadmissible = isMcp && item.selectable === false ? ` · ⚠️ unavailable: ${escapeMrkdwn(item.admissionReason || "no admissible transport")}` : "";
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
      : item.active || (isMcp && item.selectable === false)
        ? null
        : button(actionId, "Activate", state, op, { k: item.key, e: engine, a: true }, { style: "primary" });
    blocks.push({
      type: "section",
      text: mrkdwn(`*${escapeMrkdwn(item.name)}* · ${activeSource}${inadmissible}${disconnected}${description}`),
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

// Retired: the template is picked in place on the Skills page now. Kept so a modal that was
// already pushed when the inline control shipped still renders and submits.
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
