// Admin UI. Talks to the REST API in src/web/routes/admin.js. No framework, no build step.
// Layout: left sidebar nav; Channels & DMs are master–detail (searchable list + the selected
// item's settings), so only ONE item's (heavy) settings DOM is rendered at a time.

import { conversationKindForChannel, conversationRouteForPath, pathForConversation, pathForView, titleForView, viewForPath } from "./admin-routes.js";
import {
  accessGrantSkillOptions,
  accessGrantSkillSelection,
  captureGrantMcpSelection,
  conversationChannelName,
  matchesConversationSource,
  changedSettingKeys,
  channelGuestAcceptedIds,
  channelGuestSavePatch,
  diffSettingsPayload,
  loadChannelGuestOptions,
  reconcileChannelMeta,
} from "./admin-state.js";
import { conversationTemplates, saveConversationTemplate, templateConfig } from "./admin-conversation-templates.js";
import { createSettingsNavigation, movedSettingsPath } from "./admin-settings-navigation.js";
import { api } from "./admin-api.js";
import { setSystemHealthActive } from "./admin-system-health.js";
import { setSubscriptionsActive } from "./admin-subscriptions.js";
import { attachReveal, confirmDialog, escapeHtml, infoDialog, openDialog, revealSecret, tokenValue } from "./admin-view.js";
import { freshAdminAuth, mountAdminAccess, mountUserDashboardAccess } from "./admin-access.js";
import { mountOrganizationGrants } from "./admin-organization-grants.js";
import { loadSkills, updateOrganizationSkills } from "./admin-skills.js";
import { mountSkillAssignmentPicker } from "./skill-assignment-picker.js";
import { mountUserPicker } from "./admin-user-picker.js";
import { mountSecretEditor, secretEditorMarkup } from "./admin-secrets.js";
import { customMcpEditorMarkup, mountCustomMcpEditor } from "./admin-custom-mcps.js";
import { emailAccountEditorMarkup, mountEmailAccountEditor } from "./admin-email-accounts.js";
import { mountComposioInventory } from "./admin-composio.js";
import { syncComposioPolicyUi, paintComposioPolicy, readComposioPolicy } from "./admin-composio-policy.js";
import { describeEvent, eventLabel, isAdminEvent } from "./admin-events.js";
import { automationRunMarkup, automationSummaryMarkup, automationStatusLabel, automationStatusTone } from "./admin-schedules.js";
import { engineChoices, engineDisplayName, harnessOf, mountLicenseLock, mountLicensePicker, mountLicensesManager, policyAdmits } from "./admin-licenses.js";

// ── Inline SVG icon ─────────────────────────────────────────────────────────────
const ICON_FOLDER = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"/></svg>`;

// ── Reference data / state ──────────────────────────────────────────────────────
let SKILLS = [];
// Personal catalog skills with their author ({ slug, createdBy }): offered only to that person.
let PERSONAL_SKILLS = [];
let SKILL_TEMPLATES = []; // { slug, name, description, skills, categories, resolved, channels }
let AVAILABLE_MCPS = { claude: null, codex: null }; // engine → catalog (null until loaded)
const MCP_CATALOG_LOADS = {}; // engine → in-flight Promise (dedupe open channel/template editors)
let USERS = {};
let aiTestingPicker = null;
let USER_RESULTS = {}; // server-filtered subset for the Users table; USERS stays the full directory
let CHANNELS = [];
let DMS = [];
let DM_TEMPLATES = {};
let GLOBAL_ENGINE = "claude";
let ENGINE_MANIFESTS = [];
// Which licenses the admin left switched on. A license that is off must not appear in ANY picker —
// global, per channel, or per DM — so every engine picker is built from this filter.
let ENGINE_ENABLED = {};
let GLOBAL_COMPOSIO_MODE = "personal";
let orgGrantsPanel;
// The Settings page's Save sends a DIFF, so it has to remember what it was painted from:
// SETTINGS_BASELINE is the form read back immediately after that paint (form shape, compared
// against the form at save time) and SETTINGS_SNAPSHOT is the server representation itself (API
// shape, compared against a newer one to name what changed under a refused save). SETTINGS_VERSION
// is echoed on the save so the server can refuse a stale one.
let SETTINGS_BASELINE = null;
let SETTINGS_SNAPSHOT = null;
let SETTINGS_VERSION = "";
function advanceSettingsVersion(from, to) {
  if (from && to && SETTINGS_VERSION === String(from)) SETTINGS_VERSION = String(to);
}
// Live parts of the settings payload: they move on their own and are nobody's edit.
const SETTINGS_NON_VALUE_KEYS = ["ok", "stale", "code", "error", "slack", "platforms", "engines", "settingsVersion"];
// Unified Conversations selection key: "ch:<channelId>" (channel) or "dm:<channelId>" (DM). One
// key drives both list highlight and detail. Conversation templates use "tpl:<id>".
let selectedConv = null;
let convSource = "all";
let convFilter = "all"; // segmented control: all | channels | dms | templates
let CONV_COSTS = null; // { byId: {channelId→cost}, bySlug: {slug→cost} }; null until first (soft) fetch
let convCostsFetched = false;
let detailDirty = false; // whether the open conversation detail has unsaved edits (drives the savebar)
// Controls that save through their OWN request are never part of a card's "Unsaved changes" state.
// Environment secrets and VPN control have independent writes and must never round-trip through
// the card's Save or tell the admin the card has edits waiting.
const SELF_SAVING_CONTROLS = ".channel-env-card, .ch-vpn-controls, .ch-codex-login, .admin-access-card, .lic-form, .lic-panel, .ch-licenses-card";
const viewLoaded = {};

const EFFORT_OPTIONS = {
  claude: [
    ["", "default"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
  ],
  codex: [
    ["", "default"],
    ["none", "None"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
    ["max", "Max"],
    ["ultra", "Ultra"],
  ],
};
const MODEL_EFFORT_OPTIONS = {};

function effectiveEngine(engine) {
  return engine || GLOBAL_ENGINE || "claude";
}

function applyEngineManifests(manifests) {
  if (!Array.isArray(manifests) || !manifests.length) return;
  ENGINE_MANIFESTS = manifests;
  Object.assign(EFFORT_OPTIONS, Object.fromEntries(manifests.map((m) => [m.id, [["", "default"], ...(m.efforts || []).map((v) => [v, v])]])));
  Object.assign(MODEL_OPTIONS, Object.fromEntries(manifests.map((m) => [m.id, (m.models || []).map((o) => [o.value, o.label])])));
  // Which harnesses speak the QwenCloud model vocabulary — declared by the adapter, never inferred
  // from the id, so modelMatchesEngine keeps working for a provider added later.
  QWEN_ENGINE_IDS = manifests.filter((m) => m.modelFamily === "qwen").map((m) => m.id);
  Object.assign(MODEL_EFFORT_OPTIONS, Object.fromEntries(manifests.map((m) => [m.id, Object.fromEntries(
    (m.models || []).filter((o) => Array.isArray(o.efforts) && o.efforts.length).map((o) => [o.value, o.efforts]),
  )])));
}

// Where an engine picker stands (admin-licenses.js): the manifest and the on/off map, plus — for a
// channel — whether it signed in its own Codex account and which licenses its lock admits.
// `channelIds` names the conversation the picker is for (its id and, for a code channel, the
// channel it was opened from): a license limited to one conversation is offered only there, so a
// picker with no conversation — a template, the gateway default — never offers one.
function licenseEnv({ codexAuthSource = "", policy = null, channelIds = [] } = {}) {
  return { manifests: ENGINE_MANIFESTS, enabled: ENGINE_ENABLED, codexAuthSource, policy, channelIds: channelIds.filter(Boolean) };
}

// What an engine id reads as wherever one is printed. From the manifest — a license an admin added
// has an id nobody can read.
function engineLabel(id) {
  return engineDisplayName(ENGINE_MANIFESTS, id);
}

// The one-control form of the picker, for a row that stores a single engine id and nothing beside
// it (a model shortcut, the connector catalog switch): one option per usable license.
function engineOptionsHtml() {
  return engineChoices(licenseEnv()).map((choice) => `<option value="${escapeHtml(choice.id)}">${escapeHtml(choice.label)}</option>`).join("");
}

function syncEffortOptions({ engineSelect, modelSelect, effortSelect, label, value, engine: pinnedEngine, blankLabel = "default" }) {
  const engine = pinnedEngine || effectiveEngine(engineSelect?.value || "");
  const modelEfforts = MODEL_EFFORT_OPTIONS[engine]?.[modelSelect?.value || ""];
  const options = modelEfforts?.length
    ? [["", "default"], ...modelEfforts.map((effort) => [effort, effort])]
    : EFFORT_OPTIONS[engine] || EFFORT_OPTIONS.claude;
  const current = value !== undefined ? value : effortSelect.value;
  effortSelect.innerHTML = options.map(([v, text]) => `<option value="${escapeHtml(v)}">${escapeHtml(v ? text : blankLabel)}</option>`).join("");
  effortSelect.value = options.some(([v]) => v === current) ? current : "";
  if (label) label.textContent = `Effort (${engineLabel(engine)})`;
}

// Model choices per engine — mirrors the Slack /model wizard's buttons. Every value passes the
// server's isValidModel guard; "" = blank (inherit: gateway default, or the CLI default).
const MODEL_OPTIONS = {
  claude: [
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-fable-5-2", "Fable 5.2"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
  ],
  codex: [
    ["gpt-6.2-astra", "GPT-6.2 Astra"],
    ["gpt-6.2-sol", "GPT-6.2 Sol"],
    ["gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["codex", "Codex (default family)"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6", "GPT-5.6 (alias for Sol)"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.4", "GPT-5.4"],
    ["gpt-5.4-mini", "GPT-5.4 mini"],
    ["gpt-5.4-nano", "GPT-5.4 nano"],
  ],
};

// Client-side mirror of modelBelongsToEngine (slack/util.js) — decides whether a saved model that
// isn't in the curated list (hand-edited config, a full id like claude-opus-4-8) should survive as
// an extra option (same engine: keep so Save round-trips it) or be dropped (other engine).
function modelMatchesEngine(model, engine) {
  const manifest = ENGINE_MANIFESTS.find((m) => m.id === engine);
  // A license whose listed models are its whole catalog has no family of further ids: a saved
  // model it no longer lists is dropped, not offered again for a save the server would refuse.
  if (manifest?.modelListClosed) return false;
  const family = manifest?.modelFamily || engine;
  // A license's own family ("license:<id>") follows its harness's shapes.
  if (family === "codex" || (String(family).startsWith("license:") && manifest?.harness === "codex")) return /^(?:gpt-|o[0-9]|codex)/i.test(model);
  if (family === "claude-extra") return /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\])$|^claude-|^(?:(?:us|eu|apac|global|us-gov)\.)?anthropic\.claude-|^arn:aws(?:-us-gov)?:bedrock:/i.test(model);
  if (family === "bedrock") return /^(?:opus|sonnet|haiku)$|^(?:(?:us|eu|apac|global|us-gov)\.)?anthropic\.claude-|^arn:aws(?:-us-gov|-cn)?:bedrock:/i.test(model);
  // Mirrors isQwenTextModel (src/engines/qwen.js): the provider families, minus the image/audio
  // and single-purpose ones that cannot hold a conversation. Every engine generated from that
  // table shares the shapes, so the check follows the SERVER's list of provider harnesses rather
  // than a hard-coded id — a provider added there must not silently fail this test and have its
  // saved model dropped from the picker on the next repaint.
  if (QWEN_ENGINE_IDS.includes(engine)) return /^(?:auto|qwen[0-9][\w.-]*|qwen-[\w.-]+|glm-[\w.-]+|deepseek-[\w.-]+|kimi-[\w.-]+|minimax-[\w.-]+)$/i.test(model) && !/(?:^wan|image|video|audio|tts|realtime|t2v|i2v|speech|ocr|(?:^|-)mt-)/i.test(model);
  return /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\])$|^claude-/i.test(model);
}

// Fill a model <select> for an engine. `engine` pins the list (the Settings per-engine defaults);
// otherwise it follows the paired engine <select> like syncEffortOptions does.
function syncModelOptions({ engineSelect, modelSelect, value, engine, blankLabel = "default" }) {
  const eng = engine || effectiveEngine(engineSelect?.value || "");
  const options = [["", blankLabel], ...(MODEL_OPTIONS[eng] || MODEL_OPTIONS.claude)];
  const current = value !== undefined ? value : modelSelect.value;
  if (current && modelMatchesEngine(current, eng) && !options.some(([v]) => v === current)) options.push([current, current]);
  modelSelect.innerHTML = options.map(([v, text]) => `<option value="${escapeHtml(v)}">${escapeHtml(text)}</option>`).join("");
  modelSelect.value = options.some(([v]) => v === current) ? current : "";
}

function syncDefaultEffort(modelSelect, effortSelect, engine, value) {
  const sync = (next) => syncEffortOptions({ modelSelect, effortSelect, engine, value: next, blankLabel: "CLI default" });
  sync(value || "");
  modelSelect.onchange = () => sync(effortSelect.value);
}

function addModelShortcutRow(name = "", target = {}) {
  const box = document.getElementById("model-shortcuts-editor");
  const row = document.createElement("div");
  row.className = "model-shortcut-row";
  row.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0";
  row.innerHTML = `<input class="shortcut-name" type="text" maxlength="24" placeholder="astra" aria-label="Shortcut name" style="max-width:120px" />
    <select class="shortcut-engine" aria-label="Harness"></select>
    <select class="shortcut-model" aria-label="Model"></select>
    <button type="button" class="clear-tok shortcut-remove">Remove</button>`;
  const engineSelect = row.querySelector(".shortcut-engine");
  const modelSelect = row.querySelector(".shortcut-model");
  engineSelect.innerHTML = engineOptionsHtml();
  if (target.engine && ![...engineSelect.options].some((option) => option.value === target.engine)) {
    const option = document.createElement("option");
    option.value = target.engine;
    option.textContent = `${engineLabel(target.engine)} (disabled)`;
    engineSelect.add(option);
  }
  engineSelect.value = target.engine || engineSelect.options[0]?.value || "claude";
  const fillModels = (value = "") => {
    const engine = engineSelect.value;
    const manifestModels = ENGINE_MANIFESTS.find((m) => m.id === engine)?.models || [];
    const options = manifestModels.length ? manifestModels.map((m) => [m.value, m.label || m.value]) : [...(MODEL_OPTIONS[engine] || [])];
    if (value && !options.some(([id]) => id === value)) options.push([value, value]);
    modelSelect.innerHTML = options.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join("");
    modelSelect.value = value && options.some(([id]) => id === value) ? value : (options[0]?.[0] || "");
  };
  row.querySelector(".shortcut-name").value = name;
  fillModels(target.model);
  engineSelect.addEventListener("change", () => fillModels());
  row.querySelector(".shortcut-remove").addEventListener("click", () => { row.remove(); markSettingsDirty(); });
  box.append(row);
}

function paintModelShortcuts(shortcuts) {
  const box = document.getElementById("model-shortcuts-editor");
  box.replaceChildren();
  for (const [name, target] of Object.entries(shortcuts || {})) addModelShortcutRow(name, target);
  document.getElementById("add-model-shortcut").disabled = false;
}

function collectModelShortcuts() {
  const shortcuts = {};
  for (const row of document.querySelectorAll("#model-shortcuts-editor .model-shortcut-row")) {
    const name = row.querySelector(".shortcut-name").value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(name)) throw new Error(`Invalid model shortcut name: ${name || "(blank)"}`);
    if (Object.hasOwn(shortcuts, name)) throw new Error(`Duplicate model shortcut: ${name}`);
    shortcuts[name] = { engine: row.querySelector(".shortcut-engine").value, model: row.querySelector(".shortcut-model").value };
  }
  return shortcuts;
}

document.getElementById("add-model-shortcut").addEventListener("click", () => { addModelShortcutRow(); markSettingsDirty(); });

function checkboxList(container, items, selected, valueKey = "value", labelKey = "label") {
  container.innerHTML = "";
  if (!items.length) {
    container.classList.add("empty");
    container.textContent = "none available";
    return;
  }
  container.classList.remove("empty");
  for (const item of items) {
    const value = typeof item === "string" ? item : item[valueKey];
    const label = typeof item === "string" ? item : item[labelKey];
    const wrap = document.createElement("label");
    // escapeHtml on the value for the same reason the label below is textContent: these names come
    // from `claude mcp list` / skill folder names, so a quote in one would break out of the attribute.
    const inherited = Boolean(item && typeof item === "object" && item.inherited);
    const locked = Boolean(item && typeof item === "object" && item.locked);
    wrap.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}" ${selected.includes(value) || inherited ? "checked" : ""} ${locked ? "disabled" : ""} ${inherited ? 'data-inherited="1"' : ""}/> <span></span>`;
    // labelHtml lets a caller inject markup (e.g. the "offline" badge span); plain labels stay
    // textContent so arbitrary names can't inject HTML.
    const span = wrap.querySelector("span");
    if (item && typeof item === "object" && item.labelHtml != null) span.innerHTML = item.labelHtml;
    else span.textContent = label;
    container.appendChild(wrap);
  }
}

function checkedValues(container) {
  return [...container.querySelectorAll("input:checked")].map((i) => i.value);
}

function explicitCheckedValues(container) {
  return [...container.querySelectorAll('input:checked:not([data-inherited="1"])')].map((i) => i.value);
}

// Channel "mode" — a friendly name over the flags (kept in sync with src/gateway/modes.js).
const MODE_LABEL = { read: "Read-only", worker: "Worker", admin: "Admin" };
function channelMode(m = {}) {
  if (m.adminMode) return "admin";
  if (m.allowBash || m.autoMode) return "worker";
  return "read";
}
function modeLabelOf(m = {}) {
  const base = [MODE_LABEL[channelMode(m)], m.autoMode ? "Auto" : "", m.cleanMode ? "Lean" : ""].filter(Boolean).join(" · ");
  const network = m.adminMode
    ? " · unrestricted network"
    : m.allowNetwork
      ? " · approved-domain network"
      : "";
  return base + network;
}

// Base mode flags mirror src/gateway/modes.js. Auto and Lean are separate options.
const PROFILE_FLAGS = {
  read: { adminMode: false, allowBash: false },
  worker: { adminMode: false, allowBash: true },
  admin: { adminMode: true, allowBash: true },
};
const PROFILE_HELP = {
  read: "Reads files. Edits and commands need approval. Selecting Read-only turns Auto off.",
  worker: "Runs commands and edits files in this channel’s folder only. Auto approves tool requests automatically; Lean removes optional skills and connectors.",
  admin: "Admins get all tools without approval prompts. Other members get Worker with the selected Auto and Lean options. Confined to the channel folder unless “Admin channels can access the host home” is enabled in Settings → Container runtime. That setting adds the home mount only to trusted admin runs in Admin channels; other members retain their project mounts. It does not grant host root access.",
};
// Per-option descriptions for the two access dropdowns (shown live under each, like the profile help).
const ACCESS_HELP = {
  approved: "Anyone on the org's approved list who is a member of this channel can talk to the bot here. (Default.)",
  admins: "Only gateway admins can talk to the bot in this channel — everyone else is ignored.",
  none: "Locked — nobody can use the bot here until you add them by name in the Users tab (Allowed users).",
};
const MANAGE_HELP = {
  admins: "Only gateway admins can edit the Slack Access page. Other authorized users can edit the ordinary Settings tabs. (Default.)",
  custom: "Only named channel managers and organization admins can edit Slack Access settings. Edit the named manager list in the channel’s Slack Access settings.",
  members: "Any approved channel member can edit Slack Access settings: Read-only/Worker/Admin mode, Auto, Lean, network, access policy and named users/managers. Permission bypass still requires an admin author. Work-dir stays admin-only.",
};
function channelProfileOf(m = {}) {
  if (m.adminMode) return "admin";
  if (m.allowBash || m.autoMode) return "worker";
  return "read";
}

// Capability → color/label, used identically in the list capdot, the header pill, and the picker
// cards. capKeyOf collapses a meta (preset OR custom flags) to one of read/worker/auto/full/lean.
const PROFILE_LABEL = { read: "Read-only", worker: "Worker", admin: "Admin" };
const CAP_RGB = { read: "145,201,206", worker: "78,163,169", auto: "232,176,75", full: "229,96,77", lean: "122,146,148" };
function capKeyOf(m = {}) {
  return channelProfileOf(m) === "admin" ? "full" : channelProfileOf(m);
}
const capColorOf = (m) => `var(--cap-${capKeyOf(m)})`;
// Inline style for a capability .pill: solid cap color text over the same color at low alpha.
function capPillStyle(m) {
  const rgb = CAP_RGB[capKeyOf(m)];
  return `color:var(--cap-${capKeyOf(m)});border-color:rgba(${rgb},.5);background:rgba(${rgb},.12)`;
}
// Friendly capability label for a meta (e.g. "Autonomous · network").
function capLabelOf(m = {}) {
  const p = channelProfileOf(m);
  const base = [PROFILE_LABEL[p], m.autoMode ? "Auto" : "", m.cleanMode ? "Lean" : ""].filter(Boolean).join(" · ");
  if (m.adminMode) return base + " · unrestricted network";
  if (!m.allowNetwork) return base;
  return base + " · approved-domain network";
}

// ── View switching + URL history ────────────────────────────────────────────────
function loadView(name, { refreshIdentity = true } = {}) {
  if (name === "system-health") {
    setSystemHealthActive(true, engineLabel);
    const id = window.location.hash.slice(1);
    if (["sh-slack-status", "sh-harness-status"].includes(id)) document.getElementById(id)?.scrollIntoView();
  }
  if (name === "subscriptions") setSubscriptionsActive(true);
  if (name === "channels" && !viewLoaded.channels) { viewLoaded.channels = true; loadConversations().catch(() => {}); }
  if (name === "users" && !viewLoaded.users) { viewLoaded.users = true; loadUsers().catch(() => {}); }
  if (name === "settings") {
    if (!viewLoaded.settings) { viewLoaded.settings = true; loadSettings().catch(() => {}); }
    // The self-saving identity card can change when chat discovers the first admin or a user
    // role changes. Refresh it independently so existing unsaved Settings edits stay intact.
    else if (refreshIdentity) mountAdminAccess(document.getElementById("admin-access"), { confirm: confirmDialog }).catch(() => {});
  }
  if (name === "api") loadApiDocs().catch(() => {});
  if (name === "skills") loadSkills({ loadOrganization: loadOrganizationGrants, versionMoved: advanceSettingsVersion }).catch(() => {});
  if (name === "variables") loadOrgSecrets();
  if (name === "schedules") loadSchedules().catch(() => {}); // always refresh
  if (name === "roi") loadRoi().catch(() => {});
  if (name === "audit") loadAudit().catch(() => {}); // always refresh
  if (name === "dashboard") loadDashboard().catch(() => {}); // always refresh
}

function setView(name, { history = "push", load = true } = {}) {
  const view = viewForPath(pathForView(name)); // unknown view ids fall back to Overview
  const hash = window.location.hash; // read before any history rewrite: /settings#set-<section>
  for (const b of document.querySelectorAll(".nav-item")) {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("active", v.id === `view-${view}`);
  document.title = `${titleForView(view)} — ChannelGate`;

  const path = pathForView(view);
  if (history === "replace") window.history.replaceState({ view }, "", path);
  else if (history === "push" && window.location.pathname !== path) window.history.pushState({ view }, "", path);
  if (view !== "api") {
    apiDocsVisit++;
    paintLegacyToken(null);
  }
  if (view !== "system-health") setSystemHealthActive(false);
  if (view !== "subscriptions") setSubscriptionsActive(false);
  if (load) loadView(view);
  if (view === "settings") settingsNavigation.enter(hash);
}

// ── API docs (static reference for the HTTP run API) ────────────────────────────
let apiDocsVisit = 0;
function paintLegacyToken(settings) {
  const card = document.getElementById("api-legacy-token");
  card.replaceChildren();
  card.hidden = !settings?.hasApiKey;
  if (settings) settingsNavigation.setLegacyKeyAvailable(settings.hasApiKey);
  if (card.hidden) return;
  card.innerHTML = `<h4>Organization-wide token · deprecated</h4>
    <p class="desc">This token can start runs as an admin in every conversation. Migrate existing automations to channel tokens.</p>`;
  if (!settings.hasStoredApiKey) {
    const status = document.createElement("p");
    status.className = "desc";
    status.textContent = `••••${settings.apiKeyLast4 || ""} · To revoke this token, remove CG_API_KEY from the daemon environment and restart it.`;
    card.append(status);
    return;
  }
  card.insertAdjacentHTML("beforeend", `<label class="field"><span>API token</span><input type="password" readonly autocomplete="off"></label>
    <div class="card-foot"><button type="button" class="ghost" data-copy>Copy token</button>
    <button type="button" class="ghost" data-revoke>Revoke token</button></div><span class="saved" role="status"></span>`);
  const message = card.querySelector('[role="status"]');
  const reveal = revealSecret("settings", "apiKey");
  const input = card.querySelector("input");
  const control = attachReveal(input, { has: true, last4: settings.apiKeyLast4, fetch: reveal });
  control.btn.tabIndex = 0;
  card.querySelector("[data-copy]").onclick = async () => {
    try {
      const value = await reveal();
      if (value && input.isConnected) {
        await navigator.clipboard.writeText(value);
        message.textContent = "Token copied.";
      }
    } catch (e) { message.textContent = e.message; }
  };
  const revoke = card.querySelector("[data-revoke]");
  revoke.onclick = async () => {
    if (!await confirmDialog({ title: "Revoke the organization-wide token?", body: "Automations using this stored token will lose access.", confirmLabel: "Revoke", danger: true })) return;
    revoke.disabled = true;
    try {
      const result = await api("/api/settings", { method: "PUT", body: JSON.stringify({
        clearApiKey: true, settingsVersion: settings.settingsVersion, connectSlack: false,
      }) });
      if (SETTINGS_VERSION === settings.settingsVersion) SETTINGS_VERSION = result.settingsVersion;
      if (input.isConnected) paintLegacyToken(result);
    } catch (e) {
      if (e.status === 409 && input.isConnected) {
        paintLegacyToken(e.body);
        await infoDialog({ title: "Settings changed", body: "The token was not revoked. Review the current token before trying again." });
      } else {
        message.textContent = e.message;
        revoke.disabled = false;
      }
    }
  };
}

async function loadApiDocs() {
  const visit = ++apiDocsVisit;
  paintLegacyToken(null);
  const settings = await api("/api/settings").catch(() => null);
  if (visit !== apiDocsVisit) return;
  const base = settings?.publicUrl ? String(settings.publicUrl).replace(/\/+$/, "") : window.location.origin;
  for (const el of document.querySelectorAll("#view-api .apidoc-base")) el.textContent = base;
  paintLegacyToken(settings);
  if (settings?.hasApiKey && location.hash === "#api-legacy-token") document.getElementById("api-legacy-token").scrollIntoView();
  await paintApiTokens();
}

// Every channel token across conversations — names, conversation, creator, dates, last four
// characters — and a revoke. Values never reach this page (they exist once, in the minting reply).
async function paintApiTokens() {
  const rows = document.getElementById("apitok-rows");
  if (!rows) return;
  let tokens = [];
  try {
    tokens = (await api("/api/api-tokens")).tokens || [];
  } catch {
    rows.innerHTML = `<tr><td colspan="6" class="hint">Sign in to see channel tokens.</td></tr>`;
    return;
  }
  const when = (v) => (v ? escapeHtml(String(v).slice(0, 16).replace("T", " ")) : "never");
  rows.innerHTML = tokens.length
    ? tokens.map((t) => `<tr${t.revoked ? ' class="muted"' : ""}>
        <td><code>${escapeHtml(t.prefix)}…${escapeHtml(t.last4)}</code> ${escapeHtml(t.name)}${t.revoked ? " <em>(revoked)</em>" : ""}</td>
        <td>${escapeHtml(t.channelName || t.slug)}</td>
        <td><code>${escapeHtml(t.createdBy)}</code></td>
        <td>${when(t.createdAt)}</td>
        <td>${when(t.lastUsedAt)}</td>
        <td>${t.revoked ? "" : `<button type="button" class="ghost apitok-revoke" data-id="${escapeHtml(String(t.id))}">Revoke</button>`}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="hint">No channel tokens yet. In a conversation, ask the agent: “create an API token for this channel”.</td></tr>`;
  for (const btn of rows.querySelectorAll(".apitok-revoke")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/api/api-tokens/${encodeURIComponent(btn.dataset.id)}/revoke`, { method: "POST", body: "{}" });
      } catch (e) {
        btn.disabled = false;
        alert(`Could not revoke: ${e?.message || e}`);
        return;
      }
      await paintApiTokens();
    });
  }
}

// ── Audit (read-only run history + usage ledger) ────────────────────────────────
// Smart money formatter: whole dollars once we're at $100+ (nobody wants "$359.3113" on a
// total), 2 decimals for normal amounts, 4 for sub-dollar per-run costs where precision matters.
const fmtUSD = (n) => {
  if (n == null) return "—";
  n = Number(n);
  if (Math.abs(n) >= 100) return "$" + Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
};
const fmtNum = (n) => Number(n || 0).toLocaleString();
// Human duration from ms: "820 ms" · "4.3 s" · "2m 05s". Null/0 → em dash.
const fmtDuration = (ms) => {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + " s";
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
};

// Activity — the full run history as a filterable, client-paginated table. One fetch (up to 1000
// rows) is cached in AUDIT_ROWS; the filters + "Show more" re-render from that cache (no new API
// calls). auditShown grows by AUDIT_PAGE per "Show more".
const AUDIT_PAGE = 50;
let AUDIT_ROWS = [];
let auditShown = AUDIT_PAGE;

// Fill a <select> with an "all" option + [value,label] entries, preserving the current selection.
function fillAuditSelect(sel, entries, allLabel) {
  const cur = sel.value;
  let html = `<option value="">${escapeHtml(allLabel)}</option>`;
  for (const [val, label] of entries) html += `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
  sel.innerHTML = html;
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// Render the runs table from the cache + current filter values. Search matches conversation +
// author; channel/user/engine are exact matches; all combinable. Empty → "No runs match."
function renderAuditRows() {
  const runsEl = document.getElementById("audit-runs");
  const q = (document.getElementById("audit-q").value || "").trim().toLowerCase();
  const chan = document.getElementById("audit-channel").value;
  const user = document.getElementById("audit-user").value;
  const engine = document.getElementById("audit-engine").value;
  const filtered = AUDIT_ROWS.filter((r) => {
    if (chan && (r.slug || "") !== chan) return false;
    if (user && (r.authorId || "") !== user) return false;
    if (engine && (r.engine || "") !== engine) return false;
    if (q && !`${r.channelName || r.slug || ""} ${r.authorName || r.authorId || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!filtered.length) {
    runsEl.innerHTML = `<div class="utable"><table><tbody><tr><td class="audit-empty" colspan="6">No runs match.</td></tr></tbody></table></div>`;
    return;
  }
  const shown = filtered.slice(0, auditShown);
  const anyEstimated = filtered.some((r) => r.costEstimated);
  const rows = shown.map((r, i) => {
    const when = new Date(r.ts).toLocaleString();
    const conv = r.channelName || r.slug || "?";
    const author = r.authorName || r.authorId || "?";
    const eng = (engineLabel(r.engine) || "?") + (r.taskKind && r.taskKind !== "interactive" ? " · " + r.taskKind : "");
    const tok = fmtNum((r.tokensIn || 0) + (r.tokensOut || 0));
    const cost = r.costUSD == null ? "—" : fmtUSD(r.costUSD) + (r.costEstimated ? "*" : "");
    return `<tr class="audit-row" data-i="${i}" tabindex="0">
      <td class="num audit-time">${escapeHtml(when)}</td>
      <td>${escapeHtml(conv)}</td>
      <td>${escapeHtml(author)}</td>
      <td><code>${escapeHtml(eng)}</code></td>
      <td class="num" style="text-align:right">${escapeHtml(tok)}</td>
      <td class="num" style="text-align:right">${escapeHtml(cost)}</td>
    </tr>`;
  }).join("");
  const more = filtered.length > auditShown;
  runsEl.innerHTML = `
    <div class="utable"><table>
      <thead><tr><th>Time</th><th>Conversation</th><th>Author</th><th>Engine</th><th style="text-align:right">Tokens</th><th style="text-align:right">Est. API value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="audit-foot">
      ${more ? `<button id="audit-more" class="ghost" type="button">Show more</button>` : ""}
      <span class="audit-count">Showing ${shown.length} of ${fmtNum(filtered.length)} runs${anyEstimated ? " · * = estimated standard API-equivalent" : ""}</span>
    </div>`;
  const moreBtn = document.getElementById("audit-more");
  if (moreBtn) moreBtn.addEventListener("click", () => { auditShown += AUDIT_PAGE; renderAuditRows(); });

  // A row opens the full record for that run. `shown` is closed over, so the index is stable
  // regardless of active filters/pagination. Click or keyboard (Enter/Space).
  const openRow = (tr) => { const rec = shown[Number(tr.dataset.i)]; if (rec) openSessionDetail(rec); };
  for (const tr of runsEl.querySelectorAll("tr.audit-row")) {
    tr.addEventListener("click", () => openRow(tr));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(tr); } });
  }
}

// ── Admin & security events ──────────────────────────────────────────────────────
// The `events` table (GET /api/audit/events), rendered under the run history. The run table above
// is the usage ledger; this is the trail of WHO CHANGED WHAT: channel policy changes, secret
// reveals (granted and refused), skill grants, platform connections. The wording lives in
// admin-events.js so it can be unit-tested without a DOM.
const EVENTS_PAGE = 25;
let AUDIT_EVENTS = [];
let eventsShown = EVENTS_PAGE;
let eventsAdminOnly = true;

function renderAuditEvents() {
  const el = document.getElementById("audit-events");
  if (!el) return;
  const filtered = eventsAdminOnly ? AUDIT_EVENTS.filter(isAdminEvent) : AUDIT_EVENTS;
  const shown = filtered.slice(0, eventsShown);
  const rows = shown.length
    ? shown.map((e) => {
        const when = new Date(e.ts).toLocaleString();
        const who = e.actor || e.author || "—";
        const where = e.slug || e.channel || "—";
        return `<tr>
      <td class="num audit-time">${escapeHtml(when)}</td>
      <td class="audit-kind">${escapeHtml(eventLabel(e.event))}</td>
      <td>${escapeHtml(where)}</td>
      <td>${escapeHtml(who)}</td>
      <td class="audit-what">${escapeHtml(describeEvent(e))}</td>
    </tr>`;
      }).join("")
    : `<tr><td class="audit-empty" colspan="5">No events recorded yet.</td></tr>`;
  el.innerHTML = `
    <div class="utable events-table"><table>
      <thead><tr><th>Time</th><th>Event</th><th>Conversation</th><th>Who</th><th>What changed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="audit-foot">
      ${filtered.length > eventsShown ? `<button id="events-more" class="ghost" type="button">Show more</button>` : ""}
      <button id="events-scope" class="ghost" type="button">${eventsAdminOnly ? "Show all events" : "Admin &amp; security only"}</button>
      <span class="audit-count">Showing ${shown.length} of ${fmtNum(filtered.length)} events</span>
    </div>`;
  const moreBtn = document.getElementById("events-more");
  if (moreBtn) moreBtn.addEventListener("click", () => { eventsShown += EVENTS_PAGE; renderAuditEvents(); });
  const scopeBtn = document.getElementById("events-scope");
  if (scopeBtn) scopeBtn.addEventListener("click", () => { eventsAdminOnly = !eventsAdminOnly; eventsShown = EVENTS_PAGE; renderAuditEvents(); });
}

async function loadAuditEvents() {
  const el = document.getElementById("audit-events");
  if (!el) return;
  try {
    const data = await api("/api/audit/events?limit=500");
    AUDIT_EVENTS = data.events || [];
  } catch (e) {
    el.innerHTML = `<div class="utable events-table"><table><tbody><tr><td class="audit-empty" colspan="5">Couldn't load events: ${escapeHtml(e.message)}</td></tr></tbody></table></div>`;
    return;
  }
  eventsShown = EVENTS_PAGE;
  renderAuditEvents();
}

// Session-detail modal — the full ledger record for one run, reusing the shared .modal styles.
// Read-only; Esc / backdrop / ✕ closes.
function openSessionDetail(r) {
  const modal = document.getElementById("session-modal");
  const bodyEl = document.getElementById("session-detail");
  const closeBtn = document.getElementById("session-close");
  const conv = r.channelName || r.slug || "?";
  const author = r.authorName || r.authorId || "?";
  const totalTok = (r.tokensIn || 0) + (r.tokensOut || 0);
  const cost = r.costUSD == null ? "—" : fmtUSD(r.costUSD) + (r.costEstimated ? " · estimated" : "");
  const engine = (engineLabel(r.engine) || "?") + (r.model ? " · " + r.model : "");
  const rows = [
    ["Time", new Date(r.ts).toLocaleString()],
    ["Conversation", conv + (r.slug && r.slug !== conv ? ` · ${r.slug}` : "")],
    ["Author", author + (r.authorId && r.authorId !== author ? ` · ${r.authorId}` : "")],
    ["Engine", engine],
    ["Task", r.taskKind || "interactive"],
    ["Tokens", `${fmtNum(totalTok)} total · ${fmtNum(r.tokensIn || 0)} in · ${fmtNum(r.tokensOut || 0)} out`],
    ["Estimated API value", cost],
    ["Duration", fmtDuration(r.durationMs)],
  ];
  bodyEl.innerHTML = rows
    .map(([k, v]) => `<div class="sd-row"><span class="sd-k">${escapeHtml(k)}</span><span class="sd-v">${escapeHtml(v)}</span></div>`)
    .join("");
  modal.hidden = false;
  const done = () => {
    modal.hidden = true;
    closeBtn.removeEventListener("click", done);
    modal.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKey);
  };
  const onBackdrop = (e) => { if (e.target === modal) done(); };
  const onKey = (e) => { if (e.key === "Escape") done(); };
  closeBtn.addEventListener("click", done);
  modal.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
  closeBtn.focus();
}

async function loadAudit() {
  const summaryEl = document.getElementById("audit-summary");
  summaryEl.textContent = "Loading…";
  let data;
  try {
    data = await api("/api/audit?limit=1000");
  } catch (e) {
    summaryEl.textContent = "Couldn't load activity: " + e.message;
    document.getElementById("audit-runs").innerHTML = "";
    return;
  }
  AUDIT_ROWS = data.usage || [];
  const s = data.summary || {};
  // Quiet all-time totals strip (folds in what the old summary cards showed).
  summaryEl.innerHTML = `${fmtNum(s.totalRuns)} runs all-time · ${fmtNum(s.totalTokens)} tokens · ${fmtUSD(s.totalCostUSD)} estimated standard API-equivalent`;

  // Build the filter option lists from the fetched rows — channels keyed by slug (stable), users
  // by authorId, engines by name.
  const chanOpts = new Map(), userOpts = new Map(), engineSet = new Set();
  for (const r of AUDIT_ROWS) {
    if (r.slug && !chanOpts.has(r.slug)) chanOpts.set(r.slug, r.channelName || r.slug);
    if (r.authorId && !userOpts.has(r.authorId)) userOpts.set(r.authorId, r.authorName || r.authorId);
    if (r.engine) engineSet.add(r.engine);
  }
  const byLabel = (a, b) => String(a[1]).localeCompare(String(b[1]), undefined, { sensitivity: "base" });
  fillAuditSelect(document.getElementById("audit-channel"), [...chanOpts.entries()].sort(byLabel), "All conversations");
  fillAuditSelect(document.getElementById("audit-user"), [...userOpts.entries()].sort(byLabel), "All users");
  fillAuditSelect(document.getElementById("audit-engine"), [...engineSet].sort().map((e) => [e, engineLabel(e)]), "All engines");

  auditShown = AUDIT_PAGE;
  renderAuditRows();
  await loadAuditEvents();
}

// ── Dashboard (KPIs + 30-day charts) ─────────────────────────────────────────────
// Read-only usage overview. Pure inline SVG sparklines + div bars — no chart lib, no build step.
// Data: GET /api/dashboard (SQL rollups over the last 30 days).
const fmtCompact = (n) => {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
};

// Sparkline area chart from a numeric series. The viewBox is stretched to fill (preserveAspectRatio
// none); stroke/dot stay crisp via non-scaling-stroke. Flat baseline when the series is all-zero.
// opts: { height } internal viewBox height, { grid } faint horizontal gridlines (hero chart),
// { tall } renders taller via the .spark-tall CSS class.
function sparkArea(values, color, opts = {}) {
  const W = 300, H = opts.height || 56, pad = 4;
  const n = values.length;
  const cls = "spark" + (opts.tall ? " spark-tall" : "");
  if (!n) return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
  const max = Math.max(1, ...values);
  const xs = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const ys = (v) => H - pad - (v / max) * (H - pad * 2);
  const pts = values.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const area = `M0,${H} L` + pts.join(" L") + ` L${W},${H} Z`;
  const lx = xs(n - 1).toFixed(1), ly = ys(values[n - 1]).toFixed(1);
  const grid = opts.grid
    ? [1, 2].map((k) => `<line x1="0" y1="${((H * k) / 3).toFixed(1)}" x2="${W}" y2="${((H * k) / 3).toFixed(1)}" stroke="var(--line-soft)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("")
    : "";
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}
    <path d="${area}" fill="${color}" opacity="0.14"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${lx}" cy="${ly}" r="2" fill="${color}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function chartCard(title, values, color, peak, axis, opts = {}) {
  return `<div class="chart-card">
    <div class="chart-title"><h3>${escapeHtml(title)}</h3><span class="chart-peak">${peak}</span></div>
    ${sparkArea(values, color, opts)}
    <div class="spark-axis"><span>${escapeHtml(axis[0] || "")}</span><span>${escapeHtml(axis[1] || "")}</span></div>
  </div>`;
}

// ── Per-model stacking ───────────────────────────────────────────────────────────
// Eight categorical hues, stepped for THIS surface (--panel #1e3535) and validated as a set:
// lightness band, chroma floor, adjacent CVD separation, normal-vision separation and 3:1 contrast
// all pass (scripts/validate_palette.js from the dataviz skill). The order is the colorblind-safety
// mechanism, not decoration — re-ordering or substituting a hue means re-running that validator.
// MODEL_OTHER is deliberately NOT a ninth category: it is the neutral every series past the eighth
// folds into, because a generated hue is how a stacked chart stops being readable.
const MODEL_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#48a02b", "#9085e9", "#e66767"];
const MODEL_OTHER = "#7a9294";
const MODEL_OTHER_KEY = "__other__";
// How many models get their own band. Seven leaves a slot for "Other" and keeps every adjacent pair
// inside the validated palette; the Models card below still lists every model, so nothing is hidden
// — it just stops being its own colour.
const MODEL_STACK_MAX = 7;

// Colour belongs to the MODEL, not to its rank in the current window: switching range, harness or
// source must never repaint the series that survived the filter. `models` arrives ordered by cost,
// but the slot is taken from the model id itself (a stable string hash), and a collision inside one
// chart is resolved by walking to the next free slot — deterministic for a given set of models, so
// the same models always draw the same way.
function modelColorMap(models) {
  const hash = (value) => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % MODEL_PALETTE.length;
  };
  const taken = new Set();
  const map = new Map();
  // Only the models that get their own band are assigned a hue — the rest are "Other" and share the
  // neutral. Assignment walks them SORTED BY ID, not in the cost order they arrive in, so a given
  // set of models always resolves a slot collision the same way no matter which window produced it.
  for (const model of models.slice(0, MODEL_STACK_MAX).sort()) {
    let slot = hash(model || "?");
    while (taken.has(slot)) slot = (slot + 1) % MODEL_PALETTE.length;
    taken.add(slot);
    map.set(model, MODEL_PALETTE[slot]);
  }
  map.set(MODEL_OTHER_KEY, MODEL_OTHER);
  return map;
}

// The models a stacked chart draws, largest first, plus "Other" when there are more. Returned as
// {key, label, color} so the chart, the legend and the tooltip all read the same list.
function stackKeys(models, colors) {
  const top = models.slice(0, MODEL_STACK_MAX);
  const keys = top.map((m) => ({ key: m.model, label: m.label, color: colors.get(m.model) || MODEL_OTHER }));
  if (models.length > top.length) {
    keys.push({ key: MODEL_OTHER_KEY, label: `Other (${models.length - top.length})`, color: MODEL_OTHER, rest: models.slice(top.length).map((m) => m.model) });
  }
  return keys;
}

// Per-bucket value for one stack key, folding every model past the cap into "Other".
function stackValue(point, entry, metric) {
  const models = point.models || {};
  if (!entry.rest) return Number(models[entry.key]?.[metric]) || 0;
  return entry.rest.reduce((total, model) => total + (Number(models[model]?.[metric]) || 0), 0);
}

// One stacked column per time bucket. Keep the columns centered within their buckets so the hover
// target and the visible bar always refer to the same day, hour or month.
function stackedColumns(series, keys, metric, opts = {}) {
  const W = 300, H = opts.height || 110, pad = 4;
  const n = series.length;
  const cls = "spark" + (opts.tall ? " spark-tall" : "");
  if (!n || !keys.length) return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
  const totals = series.map((point) => keys.reduce((sum, entry) => sum + stackValue(point, entry, metric), 0));
  const max = Math.max(1e-9, ...totals);
  const ys = (v) => H - pad - (v / max) * (H - pad * 2);
  const step = W / n;
  const width = Math.max(1, step - Math.min(2, step * 0.2));
  const grid = opts.grid
    ? [1, 2].map((k) => `<line x1="0" y1="${((H * k) / 3).toFixed(1)}" x2="${W}" y2="${((H * k) / 3).toFixed(1)}" stroke="var(--line-soft)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("")
    : "";
  const running = new Array(n).fill(0);
  const columns = [];
  for (const entry of keys) {
    for (let i = 0; i < n; i++) {
      const value = stackValue(series[i], entry, metric);
      if (value <= 0) continue;
      const bottom = ys(running[i]);
      running[i] += value;
      const top = ys(running[i]);
      columns.push(`<rect x="${(i * step + (step - width) / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${width.toFixed(2)}" height="${(bottom - top).toFixed(2)}" fill="${entry.color}"/>`);
    }
  }
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${columns.join("")}</svg>`;
}

// Legend for a stacked chart. Always rendered when there is more than one series — identity must
// never be carried by colour alone.
function modelLegend(keys) {
  if (keys.length < 2) return "";
  return `<span class="legend legend-wrap">${keys
    .map((entry) => `<span><span class="dot" style="background:${entry.color}"></span>${escapeHtml(entry.label)}</span>`)
    .join("")}</span>`;
}

// A stacked chart card with a hover layer for the model totals in each time bucket.
function stackedChartCard(id, title, series, keys, metric, peak, axis, fmt, opts = {}) {
  return `<div class="chart-card">
    <div class="chart-title"><h3>${escapeHtml(title)}</h3><span class="chart-peak">${peak}</span></div>
    <div class="spark-hover" data-stack="${escapeHtml(id)}" data-metric="${escapeHtml(metric)}" data-fmt="${escapeHtml(fmt)}">
      ${stackedColumns(series, keys, metric, opts)}
      <span class="spark-cursor" hidden></span>
      <div class="spark-tip" role="status" hidden></div>
    </div>
    <div class="spark-axis"><span>${escapeHtml(axis[0] || "")}</span><span>${escapeHtml(axis[1] || "")}</span></div>
  </div>`;
}

// One bar's track. With a `stack` (the row's per-model split and the shared key order), the fill is
// divided into per-model segments in the SAME order every bar uses, so the colours read as one
// legend across the whole page instead of per card. Without one it is a single-hue fill, which is
// what a metric with no model dimension (skill uses) still wants.
function barTrack(pct, { color = "", stack = null } = {}) {
  if (!stack || !stack.keys.length) return `<span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>`;
  const parts = stack.keys
    .map((entry) => ({ entry, value: stackValue(stack.row, entry, stack.metric) }))
    .filter((part) => part.value > 0);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return `<span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color || MODEL_OTHER}"></span></span>`;
  const segments = parts
    .map((part) => `<i style="width:${((part.value / total) * 100).toFixed(2)}%;background:${part.entry.color}" title="${escapeHtml(part.entry.label)}"></i>`)
    .join("");
  const format = stack.metric === "cost" ? fmtUSD : stack.metric === "tokens" ? fmtCompact : fmtNum;
  const metricName = { cost: "Token cost", tokens: "Tokens", runs: "Runs" }[stack.metric] || stack.metric;
  const details = parts.map((part) => `<span class="spark-tip-row"><span class="dot" style="background:${part.entry.color}"></span>${escapeHtml(part.entry.label)}<b>${format(part.value)}</b></span>`).join("");
  const accessible = `${stack.row.name || "Usage"}, ${metricName}: ${format(total)}. ${parts.map((part) => `${part.entry.label}: ${format(part.value)}`).join(", ")}`;
  return `<span class="bar-hover" role="img" tabindex="0" aria-label="${escapeHtml(accessible)}">
    <span class="bar-track"><span class="bar-fill bar-stack" style="width:${pct}%">${segments}</span></span>
    <span class="spark-tip bar-tip"><span class="spark-tip-head">${escapeHtml(metricName)} · <strong>${format(total)}</strong></span>${details}</span>
  </span>`;
}

// Single-metric horizontal bar list, descending. Row: name · bar (width ∝ value) · value.
// `stack` (optional) = { keys, metric } — splits every bar by model, as the charts above do.
function barList(items, valueOf, fmt, color, empty, stack = null) {
  if (!items.length) return `<p class="hint" style="margin:6px 0 0">${empty}</p>`;
  const max = Math.max(1, ...items.map(valueOf));
  return items.map((it) => {
    const pct = Math.max(2, (valueOf(it) / max) * 100);
    return `<div class="bar-row">
      <span class="bar-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
      ${barTrack(pct, { color, stack: stack ? { ...stack, row: it } : null })}
      <span class="bar-val">${fmt(it)}</span>
    </div>`;
  }).join("");
}

// How a session was driven. "Headless" is the one that needs saying out loud: a scripted
// `claude -p` / `codex exec` is indistinguishable on disk from the gateway's own invocation, so a
// row here means "not one of ours, but driven the same way", never "a person at a keyboard".
const ORIGIN_LABEL = {
  gateway: "Chat gateway",
  terminal: "Terminal CLI",
  vscode: "VS Code",
  desktop: "Desktop app",
  ssh: "SSH into a container",
  headless: "Headless / scripted",
  other: "Other",
};

// What the outside figure covers, and how much of what was read was recognised as the gateway's
// own work. That second number is the one that makes the first believable: an operator who sees
// "hundreds of sessions attributed back to the gateway" knows the total is not quietly inflated
// with the gateway's own runs.
function externalScanNote(scan) {
  if (!scan) return "Outside-the-gateway usage has not been scanned yet.";
  const parts = [];
  if (scan.since) parts.push(`Outside usage counted from ${new Date(scan.since).toLocaleString()}.`);
  else if (scan.trackingStartedAt) parts.push(`Outside usage covers all engine history on this host (first scanned ${new Date(scan.trackingStartedAt).toLocaleDateString()}).`);
  else parts.push("Outside usage has not been scanned yet.");
  const attributed = Object.entries(scan.attributed || {})
    .filter(([reason]) => !["terminal", "vscode", "desktop", "headless", "ssh", "other", "empty"].includes(reason))
    .reduce((sum, [, count]) => sum + count, 0);
  if (attributed) parts.push(`${fmtNum(attributed)} session(s) were recognised as the gateway's own and are not counted here.`);
  if (scan.pending) parts.push("A backlog of sessions is still being read.");
  if (scan.errors) parts.push(`${scan.errors} scope(s) could not be read.`);
  return parts.join(" ");
}

// Models, largest spend first: cost sets the bar, tokens and runs ride along as text. Every model
// is listed — this is the readout the stacked charts' top-7 cap deliberately does not limit.
function modelBars(models, colors) {
  if (!models.length) return `<p class="hint" style="margin:6px 0 0">No model usage in this window.</p>`;
  const max = Math.max(1e-9, ...models.map((m) => m.cost || 0));
  const totalCost = models.reduce((sum, m) => sum + (m.cost || 0), 0);
  const shown = models.slice(0, DASH_TOP_N);
  const rows = shown
    .map((m) => {
      const pct = Math.max(2, ((m.cost || 0) / max) * 100);
      const share = totalCost > 0 ? Math.round(((m.cost || 0) / totalCost) * 100) : 0;
      const where = m.externalRuns > 0 ? ` · ${fmtNum(m.externalRuns)} outside` : "";
      // Runs charted here because nothing recorded a model for them (Settings → Agent defaults).
      // Saying so keeps the band readable without letting the assumption pass as measurement.
      const guessed = m.assumedRuns > 0 ? ` · ${fmtNum(m.assumedRuns)} assumed` : "";
      // A model can spend without ever heading a run — a Codex subagent or the auto-review pass.
      // "0 runs" would read as a bug; naming what it actually is does not.
      const runs = m.runs > 0 ? `${fmtNum(m.runs)} runs${where}${guessed}` : "inside other runs";
      return `<div class="bar-row">
      <span class="bar-name" title="${escapeHtml(m.model || m.label)}">${escapeHtml(m.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${colors.get(m.model) || MODEL_OTHER}"></span></span>
      <span class="bar-val"><span>${m.cost > 0 ? fmtUSD(m.cost) : "unpriced"} · ${share}%</span><span>${runs}</span><span>${fmtCompact(m.tokens)} tokens</span></span>
    </div>`;
    })
    .join("");
  const more = models.length - shown.length;
  return rows + (more > 0 ? `<p class="hint" style="margin:8px 0 0">+ ${more} more</p>` : "");
}

// Per-channel bars: runs over cost over tokens, each normalized to its own max and each split by
// the models that produced it. Three rows of the same colours make the composition comparable down
// the column — a channel whose cost bar is mostly one hue while its runs bar is mostly another is
// running a few expensive turns on a pricier model, which the old single-hue bars could not show.
function channelBars(items, keys) {
  if (!items.length) return `<p class="hint" style="margin:6px 0 0">No channel activity yet.</p>`;
  const maxRuns = Math.max(1, ...items.map((c) => c.runs));
  const maxCost = Math.max(1e-6, ...items.map((c) => c.cost || 0));
  const maxTokens = Math.max(1, ...items.map((c) => c.tokens || 0));
  return items.map((c) => {
    const rp = Math.max(2, (c.runs / maxRuns) * 100);
    const cp = Math.max(2, ((c.cost || 0) / maxCost) * 100);
    const tp = Math.max(2, ((c.tokens || 0) / maxTokens) * 100);
    const track = (pct, metric, fallback) => barTrack(pct, { color: fallback, stack: keys?.length ? { keys, metric, row: c } : null });
    return `<div class="bar-row bar-row-dual">
      <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
      <span class="bar-dual">
        ${track(rp, "runs", "#91c9ce")}
        ${track(cp, "cost", "var(--orange)")}
        ${track(tp, "tokens", "#317b80")}
      </span>
      <span class="bar-val">${fmtNum(c.runs)} · ${fmtUSD(c.cost)} · ${fmtCompact(c.tokens)}</span>
    </div>`;
  }).join("");
}

// Format a bucket key for the axis/labels, per unit: hour → "14:00", day → "Jul 3", month → "Jul 26".
function bucketLabel(key, unit) {
  if (!key) return "";
  if (unit === "hour") return key.slice(11) + ":00";
  if (unit === "month") return new Date(key + "-01T00:00:00Z").toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  return new Date(key + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const UNIT_WORD = { hour: "hour", day: "day", month: "month" };

const DASH_TOP_N = 12;
let dashRange = "last30"; // remembered across nav so switching away and back keeps the selection
let dashHarness = "all"; // all | claude | codex; scopes every dashboard KPI and chart
let dashSource = "all"; // all | gateway | external; chat-driven runs, usage the gateway never launched, or both
let DASH_DATA = null; // the last dashboard payload, kept for the stacked charts' hover layer
let ACTIVE_RUNS = []; // live in-flight turns, for the "Active sessions" KPI + its modal
let activeRunsVersion = 0;
let activeRunsLive = false;
let activeRunsSource = null;
let activeModalTimer = null;

// A run counts under its harness whichever license it is on; the manifest says which that is.
function dashboardActiveRuns() {
  const harnessOfRun = (run) => harnessOf(ENGINE_MANIFESTS.find((m) => m.id === run.engine));
  return dashHarness === "all"
    ? ACTIVE_RUNS
    : ACTIVE_RUNS.filter((run) => String(run.engine || run.engineName || "").toLowerCase() === dashHarness || harnessOfRun(run) === dashHarness);
}

function renderActiveSessions() {
  const modal = document.getElementById("active-modal");
  const bodyEl = document.getElementById("active-body");
  if (!modal || modal.hidden || !bodyEl) return;
  const visibleRuns = dashboardActiveRuns();
  if (!visibleRuns.length) {
    bodyEl.innerHTML = `<p class="hint">No sessions are running right now.</p>`;
    return;
  }
  const now = Date.now();
  bodyEl.innerHTML = visibleRuns
    .map((r) => {
      const conv = r.channelName || r.slug || "?";
      const who = r.authorName || r.authorId || "?";
      const runtime = [r.engineName || r.engine, r.modelName || r.model].filter(Boolean).join(" · ") || "Resolving runtime…";
      const since = r.startedAt ? `running ${fmtDuration(now - r.startedAt)}` : "running";
      return `<div class="active-item"><span class="active-main"><span class="conv"><strong>${escapeHtml(conv)}</strong> · ${escapeHtml(who)}</span><span class="active-runtime">${escapeHtml(runtime)}</span></span><span class="since">${escapeHtml(since)}</span></div>`;
    })
    .join("");
}

function setActiveRuns(runs) {
  ACTIVE_RUNS = Array.isArray(runs) ? runs : [];
  activeRunsVersion += 1;
  const count = dashboardActiveRuns().length;
  const value = document.querySelector('[data-live-active="value"]');
  const sub = document.querySelector('[data-live-active="sub"]');
  if (value) value.textContent = fmtNum(count);
  if (sub) sub.textContent = count ? "running now — view" : "none running now";
  renderActiveSessions();
}

// Keep one authenticated same-origin EventSource open for the lifetime of the admin page. Each
// event is a complete snapshot, so the initial connection and every automatic reconnect repair any
// missed updates. The REST read remains as a fallback for browsers/network paths without SSE.
function startActiveRunsStream() {
  if (activeRunsSource || typeof EventSource === "undefined") return;
  activeRunsSource = new EventSource("/api/active-runs/stream");
  activeRunsSource.addEventListener("active-runs", (event) => {
    try {
      const data = JSON.parse(event.data);
      activeRunsLive = true;
      setActiveRuns(data.runs);
    } catch {
      /* malformed event — leave the last valid snapshot visible */
    }
  });
  activeRunsSource.addEventListener("open", () => { activeRunsLive = true; });
  activeRunsSource.addEventListener("error", () => { activeRunsLive = false; });
}

// ── Pending approvals (Overview) ─────────────────────────────────────────────────
// An approval card normally waits for someone to click it in the chat client, which leaves a run
// stuck whenever nobody is watching the thread. This panel resolves the same request from here:
// the API behind it goes through the identical handler as the button, so the scope (once / this
// thread / forever), the audit event, the card update and the requester binding are the same.
let PENDING_APPROVALS = { approvals: [], threadChoices: [] };
// #dash-body is a stable element whose innerHTML is replaced on every dashboard load, so the
// delegated click handler is attached exactly once — re-attaching per load would stack listeners
// and turn one click into N requests (the first decides, the rest 409).
let dashApprovalsWired = false;

async function loadPendingApprovals() {
  try {
    const data = await api("/api/approvals");
    PENDING_APPROVALS = { approvals: data.approvals || [], threadChoices: data.threadChoices || [] };
  } catch {
    // Best-effort, exactly like the active-sessions read: an Overview that cannot list approvals
    // must still render everything else.
    PENDING_APPROVALS = { approvals: [], threadChoices: [] };
  }
  renderPendingApprovals();
}

const SCOPE_LABEL = { once: "Once", thread: "This thread", forever: "Forever" };

function renderPendingApprovals() {
  const host = document.getElementById("dash-approvals");
  if (!host) return;
  const { approvals, threadChoices } = PENDING_APPROVALS;
  const total = approvals.length + threadChoices.length;
  if (!total) {
    host.innerHTML = "";
    return;
  }
  const now = Date.now();
  const age = (iso) => (iso ? fmtDuration(Math.max(0, now - Date.parse(iso))) : "—");
  const approvalRows = approvals.map((a) => {
    const summary = a.summary ? a.summary + (a.summaryTruncated ? "…" : "") : a.label || "";
    const scopes = a.scopes && a.scopes.length > 1
      ? `<select class="audit-filter" data-approval-scope="${escapeHtml(a.id)}">${a.scopes.map((sc) => `<option value="${escapeHtml(sc)}">${escapeHtml(SCOPE_LABEL[sc] || sc)}</option>`).join("")}</select>`
      : "";
    return `<div class="active-item" data-approval-row="${escapeHtml(a.id)}">
      <span class="active-main">
        <span class="conv"><strong>${escapeHtml(a.tool || a.kind)}</strong> · ${escapeHtml(a.channelName || a.channelId)} · ${escapeHtml(a.requesterName || a.requesterId)}</span>
        <span class="active-runtime">${escapeHtml(summary)}</span>
      </span>
      <span class="since">${escapeHtml(age(a.createdAt))}</span>
      ${scopes}
      <button type="button" data-approve="${escapeHtml(a.id)}">Approve</button>
      <button type="button" class="ghost" data-deny="${escapeHtml(a.id)}">Deny</button>
    </div>`;
  }).join("");
  const choiceRows = threadChoices.map((c) => `<div class="active-item" data-approval-row="${escapeHtml(c.id)}">
      <span class="active-main">
        <span class="conv"><strong>Busy thread</strong> · ${escapeHtml(c.channelName || c.channelId)} · ${escapeHtml(c.requesterName || c.requesterId)}</span>
        <span class="active-runtime">a new message is waiting on Steer / Queue / Cancel</span>
      </span>
      <span class="since">${escapeHtml(age(c.createdAt))}</span>
      <button type="button" data-choice="steer" data-choice-id="${escapeHtml(c.id)}">Steer</button>
      <button type="button" class="ghost" data-choice="queue" data-choice-id="${escapeHtml(c.id)}">Queue</button>
      <button type="button" class="ghost" data-choice="cancel" data-choice-id="${escapeHtml(c.id)}">Cancel</button>
    </div>`).join("");
  host.innerHTML = `<div class="chart-card">
      <div class="chart-title"><h3>Pending approvals</h3><span class="chart-peak">${fmtNum(total)} waiting</span></div>
      ${approvalRows}${choiceRows}
      <p class="hint" style="margin:10px 0 0">Deciding here is the same decision as clicking the card in the conversation — it is recorded as the <strong>admin UI</strong>.</p>
    </div>`;
}

// One delegated handler for both kinds of row. Buttons disable while the request is in flight so a
// double click cannot send a second decision, and the list is re-read afterwards either way.
async function resolveApprovalFromDash(target) {
  const row = target.closest("[data-approval-row]");
  const buttons = row ? [...row.querySelectorAll("button")] : [target];
  for (const b of buttons) b.disabled = true;
  try {
    if (target.dataset.approve || target.dataset.deny) {
      const id = target.dataset.approve || target.dataset.deny;
      // One row carries at most one scope select, so the row itself is the selector — no need to
      // quote a server-supplied id into a CSS attribute match.
      const scopeSel = row?.querySelector("[data-approval-scope]");
      await api(`/api/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ decision: target.dataset.approve ? "approve" : "deny", scope: scopeSel?.value || "once" }),
      });
    } else {
      await api(`/api/approvals/thread-choice/${encodeURIComponent(target.dataset.choiceId)}`, {
        method: "POST",
        body: JSON.stringify({ choice: target.dataset.choice }),
      });
    }
  } catch (e) {
    await infoDialog({ title: "Couldn't resolve that approval", body: e.message });
  }
  await loadPendingApprovals();
}

async function loadDashboard() {
  const body = document.getElementById("dash-body");
  const rangeSel = document.getElementById("dash-range");
  const harnessSel = document.getElementById("dash-harness");
  const sourceSel = document.getElementById("dash-source");
  if (rangeSel) dashRange = rangeSel.value;
  if (harnessSel) dashHarness = harnessSel.value;
  if (sourceSel) dashSource = sourceSel.value;
  let d;
  try {
    d = await api(`/api/dashboard?range=${encodeURIComponent(dashRange)}&harness=${encodeURIComponent(dashHarness)}&source=${encodeURIComponent(dashSource)}`);
  } catch (e) {
    body.innerHTML = `<p class="hint">Couldn't load dashboard: ${escapeHtml(e.message)}</p>`;
    return;
  }
  // Live in-flight turns for the "Active sessions" KPI — best-effort; degrade to 0 if the endpoint
  // isn't there yet (e.g. before the daemon has restarted onto the new route).
  const beforeActiveFetch = activeRunsVersion;
  try {
    const runs = (await api("/api/active-runs")).runs || [];
    // Never let a slower REST response overwrite a newer streamed snapshot.
    if (activeRunsVersion === beforeActiveFetch) setActiveRuns(runs);
  } catch {
    if (!activeRunsLive && activeRunsVersion === beforeActiveFetch) setActiveRuns([]);
  }
  const t = d.totals || {};
  const series = d.series || [];
  const unit = d.unit || "day";
  const per = UNIT_WORD[unit] || "day";
  const axis = series.length ? [bucketLabel(series[0].key, unit), bucketLabel(series[series.length - 1].key, unit)] : ["", ""];
  const peakOf = (sel, fmt) => fmt(series.reduce((m, x) => Math.max(m, sel(x)), 0));
  // The bucket that holds the highest value of `sel` — used to date the hero chart's peak label.
  const peakBucket = (sel) => series.reduce((best, x) => (best && sel(best) >= sel(x) ? best : x), null);
  // Rate-per-day only reads sensibly for multi-day ranges; for Today it's just the total.
  const spanDays = Math.max(1, (new Date(d.end) - new Date(d.start)) / 86400000);
  const multiDay = spanDays >= 1.5;
  const avgCost = t.runs ? t.cost / t.runs : 0;
  const pricingCoverage = t.unpricedRuns ? `${fmtNum(t.unpricedRuns)} runs unpriced` : "all runs priced";

  // KPIs — tokens in/out demoted to the Tokens sub-line. Some cards drill in: value/runs/tokens
  // open the Activity run history (view), "Active sessions" opens the live in-flight list (action).
  // "Active users" is a plain read-only tile (per user request — clicking it does nothing).
  const activeCount = dashboardActiveRuns().length;
  const outsideShare = t.cost > 0 ? Math.round(((t.externalCost || 0) / t.cost) * 100) : 0;
  const kpis = [
    { label: "Token Est Cost", value: fmtUSD(t.cost), cls: "cost", sub: multiDay ? `≈ ${fmtUSD(t.cost / spanDays)}/day · ${pricingCoverage}` : pricingCoverage, view: "audit" },
    { label: "Claude Cost", value: fmtUSD(t.claudeCost), cls: "cost", sub: "provider-reported", view: "audit" },
    { label: "Codex Cost", value: fmtUSD(t.codexCost), cls: "cost", sub: "Standard API estimate", view: "audit" },
    // The whole point of the external scan: what was spent on these engines WITHOUT going through a
    // conversation. Zero is a real answer here, so the tile is always shown rather than hidden.
    { label: "Outside the gateway", value: fmtUSD(t.externalCost), cls: "cost", sub: `${fmtNum(t.externalSessions || 0)} session${t.externalSessions === 1 ? "" : "s"} · ${outsideShare}% of spend` },
    { label: "Runs", value: fmtNum(t.runs), sub: multiDay ? `≈ ${(t.runs / spanDays).toFixed(1)}/day · ${fmtUSD(avgCost)} avg value` : `${fmtUSD(avgCost)} avg value`, view: "audit" },
    { label: "Active users", value: fmtNum(t.users), sub: `across ${fmtNum(t.channels)} channels` },
    { label: "Active sessions", value: fmtNum(activeCount), sub: activeCount ? "running now — view" : "none running now", action: "active", liveActive: true },
    { label: "Tokens", value: fmtCompact(t.tokens), sub: `${fmtCompact(t.tokensIn)} in · ${fmtCompact(t.tokensOut)} out`, view: "audit" },
  ];
  const kpiHtml = kpis.map((k) => {
    const dest = k.view ? ` data-goto="${escapeHtml(k.view)}"` : k.action ? ` data-action="${escapeHtml(k.action)}"` : "";
    const cls = "kpi" + (dest ? " kpi-link" : "");
    const attrs = dest ? `${dest} role="button" tabindex="0"` : "";
    return `<div class="${cls}"${attrs}>
    <div class="kpi-label">${escapeHtml(k.label)}</div>
    <div class="kpi-value${k.cls ? " " + k.cls : ""}"${k.liveActive ? ' data-live-active="value"' : ""}>${k.value}</div>
    <div class="kpi-sub"${k.liveActive ? ' data-live-active="sub"' : ""}>${escapeHtml(k.sub)}</div>
  </div>`;
  }).join("");

  // Four compact cards share one row: cost, runs, tokens and the usage-source breakdown.
  const costPeak = peakBucket((x) => x.cost);
  const costPeakLabel = costPeak && costPeak.cost > 0
    ? `peak ${fmtUSD(costPeak.cost)}${costPeak.key ? " · " + bucketLabel(costPeak.key, unit) : ""}`
    : "no value yet";
  // Every time chart is stacked by the model that actually answered, so a rising cost column can be
  // read as "we moved onto a pricier model" rather than only "we ran more". One colour map and one
  // key list across all three, so a band means the same thing in each and the legend is shared.
  const allModels = d.models || [];
  const modelColors = modelColorMap(allModels.map((m) => m.model));
  const keys = stackKeys(allModels, modelColors);
  DASH_DATA = { series, keys, unit, models: allModels };
  const charts = [
    stackedChartCard("cost", `Token est. cost per ${per}`, series, keys, "cost", costPeakLabel, axis, "usd", { height: 110, grid: true, tall: true }),
    stackedChartCard("runs", "Runs", series, keys, "runs", `peak ${peakOf((x) => x.runs, fmtNum)}`, axis, "num", { height: 110, tall: true }),
    stackedChartCard("tokens", "Tokens", series, keys, "tokens", `peak ${peakOf((x) => x.tokens, fmtCompact)}`, axis, "compact", { height: 110, tall: true }),
  ].join("");

  const users = (d.byUser || []).slice(0, DASH_TOP_N);
  // Friendlier DM labels: the API hands DMs as "dm-U…" slugs; resolve the trailing id via USERS.
  const channels = (d.byChannel || []).slice(0, DASH_TOP_N).map((c) => {
    if (typeof c.name === "string" && c.name.startsWith("dm-")) {
      const u = USERS[c.name.slice(3)];
      if (u && u.name) return { ...c, name: `${u.name} (DM)` };
    }
    return c;
  });
  const moreUsers = (d.byUser || []).length - users.length;
  const moreChannels = (d.byChannel || []).length - channels.length;
  const skills = (d.topSkills || []).slice(0, 10);

  // Where the spend came from, and how far back that answer is trustworthy. The gateway's own runs
  // are exact; outside usage is only counted from the moment the scan started keeping session ids,
  // so the panel says so rather than letting a short history read as "nobody works outside chat".
  const origins = d.origins || [];
  const scan = d.externalScan || null;
  const originsCard = `<div class="chart-card">
      <div class="chart-title"><h3>Where usage came from</h3><span class="chart-peak">${origins.length} source${origins.length === 1 ? "" : "s"}</span></div>
      ${barList(
        origins.map((o) => ({ ...o, name: ORIGIN_LABEL[o.origin] || o.origin })),
        (o) => o.cost,
        (o) => `<span>${fmtUSD(o.cost)}</span><span>${fmtNum(o.runs)} turns</span><span>${fmtCompact(o.tokens)} tokens</span>`,
        "#91c9ce",
        "No usage in this window.",
        { keys, metric: "cost" }
      )}
      <p class="hint" style="margin:10px 0 0">${escapeHtml(externalScanNote(scan))}</p>
    </div>`;

  // The dedicated model chart. A bar list, not a pie: the question is "which models are used more",
  // which is magnitude, and length compares far better than angle. Each bar keeps its series colour
  // so a band in the charts above and a row here are recognisably the same model.
  const assumedRuns = t.assumedRuns || 0;
  const modelsCard = `<div class="chart-card">
      <div class="chart-title"><h3>Models — token cost &amp; usage</h3><span class="chart-peak">${fmtNum(allModels.length)} model${allModels.length === 1 ? "" : "s"}</span></div>
      ${modelBars(allModels, modelColors)}
      ${assumedRuns > 0 ? `<p class="hint" style="margin:10px 0 0">${fmtNum(assumedRuns)} run(s) recorded no model and are charted under the fallback for their engine (Settings → Agent defaults). Their cost is what was actually recorded; only the model is assumed.</p>` : ""}
    </div>`;

  body.innerHTML = `
    ${d.historyDays ? `<p class="hint">Free cost-tracking history covers the last ${fmtNum(d.historyDays)} days. Enterprise includes unlimited history.</p>` : ""}
    <div class="kpi-row">${kpiHtml}</div>
    <div id="dash-approvals"></div>
    <div class="dash-legend">${modelLegend(keys)}</div>
    <div class="dash-grid">${charts}${originsCard}</div>
    <div class="dash-stack">
      ${modelsCard}
      <div class="chart-card">
        <div class="chart-title"><h3>Channels — runs, token cost &amp; tokens</h3>
          <span class="chart-peak">three bars per channel, split by model</span>
        </div>
        ${channelBars(channels, keys)}
        ${moreChannels > 0 ? `<p class="hint" style="margin:8px 0 0">+ ${moreChannels} more</p>` : ""}
      </div>
      <div class="chart-card">
        <div class="chart-title"><h3>Runs per user</h3><span class="chart-peak">${users.length} of ${fmtNum(t.users)}</span></div>
        ${barList(users, (u) => u.runs, (u) => `<span>${fmtNum(u.runs)} runs</span><span>${fmtCompact(u.tokens)} tokens</span><span>${fmtUSD(u.cost)} est.</span>`, "#91c9ce", "No user activity yet.", { keys, metric: "runs" })}
        ${moreUsers > 0 ? `<p class="hint" style="margin:8px 0 0">+ ${moreUsers} more</p>` : ""}
      </div>
      <div class="chart-card">
        <div class="chart-title"><h3>Top skills — usage</h3><span class="chart-peak">last 30 days</span></div>
        ${barList(skills, (s) => s.uses, (s) => `${fmtNum(s.uses)} uses`, "#6ea6a1", "No skill usage yet.")}
      </div>
    </div>`;

  // Approvals waiting on a human, decided in place. Painted after the body so the panel is a
  // separate read: a slow or missing approvals route never delays the rest of the Overview.
  renderPendingApprovals();
  void loadPendingApprovals();
  if (!dashApprovalsWired) {
    dashApprovalsWired = true;
    body.addEventListener("click", (event) => {
      const target = event.target.closest("[data-approve],[data-deny],[data-choice]");
      if (target) void resolveApprovalFromDash(target);
    });
  }

  wireStackHover(body);

  // KPI cards drill in — a view card switches views; the "active" card opens the live-sessions
  // modal. Click or keyboard (Enter/Space).
  for (const el of body.querySelectorAll(".kpi-link")) {
    const go = () => { if (el.dataset.action === "active") openActiveSessions(); else if (el.dataset.goto) setView(el.dataset.goto); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
}

// Crosshair + tooltip for the stacked time charts. A column with up to eight segments cannot be read
// without asking "which model is this, and how much"; the legend names the colours, this says the
// numbers. Pointer-driven and keyboard-reachable (the chart is focusable and arrow keys step
// buckets), so the reading is not mouse-only.
const STACK_FMT = { usd: (v) => fmtUSD(v), num: (v) => fmtNum(v), compact: (v) => fmtCompact(v) };

function renderStackTip(host, index) {
  const data = DASH_DATA;
  const point = data?.series?.[index];
  if (!point) return;
  const metric = host.dataset.metric;
  const fmt = STACK_FMT[host.dataset.fmt] || STACK_FMT.num;
  const rows = data.keys
    .map((entry) => ({ entry, value: stackValue(point, entry, metric) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const tip = host.querySelector(".spark-tip");
  const cursor = host.querySelector(".spark-cursor");
  const pct = ((index + 0.5) / data.series.length) * 100;
  cursor.style.left = `${pct}%`;
  cursor.hidden = false;
  tip.hidden = false;
  tip.classList.toggle("flip", pct > 60);
  tip.style.left = `${pct}%`;
  tip.innerHTML =
    `<div class="spark-tip-head">${escapeHtml(bucketLabel(point.key, data.unit))} · <strong>${fmt(total)}</strong></div>` +
    (rows.length
      ? rows.map((row) => `<div class="spark-tip-row"><span class="dot" style="background:${row.entry.color}"></span>${escapeHtml(row.entry.label)}<b>${fmt(row.value)}</b></div>`).join("")
      : `<div class="spark-tip-row">nothing in this ${data.unit}</div>`);
}

function wireStackHover(root) {
  for (const host of root.querySelectorAll(".spark-hover")) {
    const count = () => DASH_DATA?.series?.length || 0;
    let current = -1;
    const hide = () => {
      current = -1;
      host.querySelector(".spark-tip").hidden = true;
      host.querySelector(".spark-cursor").hidden = true;
    };
    const show = (index) => {
      const n = count();
      if (!n) return;
      current = Math.max(0, Math.min(n - 1, index));
      renderStackTip(host, current);
    };
    host.tabIndex = 0;
    host.addEventListener("pointermove", (event) => {
      const n = count();
      if (!n) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      show(Math.floor(((event.clientX - rect.left) / rect.width) * n));
    });
    host.addEventListener("pointerleave", hide);
    host.addEventListener("focus", () => show(current >= 0 ? current : count() - 1));
    host.addEventListener("blur", hide);
    host.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); show((current < 0 ? count() : current) - 1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); show(current + 1); }
      else if (event.key === "Escape") hide();
    });
  }
}

// Active-sessions modal — the turns being processed right now. Re-fetches on open so it's live even
// if the Overview count is a few seconds stale; reuses the shared .modal styles. Esc / backdrop / ✕
// closes.
async function openActiveSessions() {
  const modal = document.getElementById("active-modal");
  const bodyEl = document.getElementById("active-body");
  const closeBtn = document.getElementById("active-close");
  modal.hidden = false;
  renderActiveSessions();
  activeModalTimer = setInterval(renderActiveSessions, 1_000);
  const done = () => {
    modal.hidden = true;
    clearInterval(activeModalTimer);
    activeModalTimer = null;
    closeBtn.removeEventListener("click", done);
    modal.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKey);
  };
  const onBackdrop = (e) => { if (e.target === modal) done(); };
  const onKey = (e) => { if (e.key === "Escape") done(); };
  closeBtn.addEventListener("click", done);
  modal.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
  closeBtn.focus();

  // If SSE is reconnecting/unavailable, reconcile once through the existing snapshot endpoint.
  if (!activeRunsLive) {
    const beforeActiveFetch = activeRunsVersion;
    try {
      const runs = (await api("/api/active-runs")).runs || [];
      if (activeRunsVersion === beforeActiveFetch) setActiveRuns(runs);
    } catch (e) {
      if (activeRunsVersion === beforeActiveFetch) bodyEl.innerHTML = `<p class="hint">Couldn't load active sessions: ${escapeHtml(e.message)}</p>`;
    }
  }
}

// ── Conversations (master–detail): templates + channels + DMs in one list ─────────
async function refreshConversationRows() {
  try {
    const [{ channels }, { dms }] = await Promise.all([api("/api/channels"), api("/api/dms")]);
    CHANNELS = channels;
    DMS = dms;
    renderConvList();
    return true;
  } catch {
    return false;
  }
}

async function loadConversations() {
  const [{ channels }, { dms }, s] = await Promise.all([api("/api/channels"), api("/api/dms"), api("/api/settings")]);
  CHANNELS = channels;
  DMS = dms;
  DM_TEMPLATES = s.dmTemplates || {};
  applyEngineManifests(s.engines);
  GLOBAL_ENGINE = s.engine || "claude";
  renderConvList();
  // Cost enrichment is best-effort and one-shot: pull the 30-day rollup once, then re-render so
  // matching rows gain a "$N". Any failure leaves the list untouched (no costs, no console spam).
  if (!convCostsFetched) {
    convCostsFetched = true;
    fetchConvCosts().then((ok) => { if (ok) renderConvList(); }).catch(() => {});
  }
}

async function fetchConvCosts() {
  try {
    const d = await api("/api/dashboard?range=last30");
    const byId = {}, bySlug = {};
    for (const c of d.byChannel || []) {
      if (c.channelId != null) byId[c.channelId] = c.cost || 0;
      if (c.slug) bySlug[c.slug] = c.cost || 0;
    }
    CONV_COSTS = { byId, bySlug };
    return true;
  } catch {
    return false;
  }
}
function costFor(channelId, slug) {
  if (!CONV_COSTS) return null;
  const v = CONV_COSTS.byId[channelId] ?? CONV_COSTS.bySlug[slug];
  return v == null ? null : v;
}

// Build one list item row (capdot + name/sub + optional cost). Selection highlights the open one.
const hashName = (n) => (String(n || "").startsWith("#") ? String(n) : "#" + n);

function conversationPathForKey(key) {
  if (key?.startsWith("tpl:")) return pathForConversation("template", key.slice(4));
  if (key?.startsWith("dm:")) return pathForConversation("dm", key.slice(3));
  if (key?.startsWith("ch:")) {
    const channelId = key.slice(3);
    const ch = CHANNELS.find((item) => item.channelId === channelId);
    return pathForConversation(conversationKindForChannel(ch), channelId);
  }
  return pathForView("channels");
}

function conversationExists(key) {
  if (key?.startsWith("tpl:")) return conversationTemplates.some((template) => template.id === key.slice(4));
  if (key?.startsWith("dm:")) return DMS.some((d) => d.channelId === key.slice(3));
  if (key?.startsWith("ch:")) return CHANNELS.some((c) => c.channelId === key.slice(3));
  return false;
}

function workDirConflictSummary(conflict) {
  const others = Array.isArray(conflict?.conversations) ? conflict.conversations : [];
  if (!others.length) return "";
  const names = others.map((item) => item.isDM || item.type === "im"
    ? (item.name || item.slug)
    : hashName(item.name || item.slug));
  return `Working folder setup is linked with ${names.join(", ")}`;
}

function convRow(key, color, name, sub, cost, conflict = null) {
  const el = document.createElement("a");
  const conflictText = workDirConflictSummary(conflict);
  el.className = "list-item conv-item" + (conflictText ? " workdir-conflict" : "") + (selectedConv === key ? " active" : "");
  el.href = conversationPathForKey(key);
  if (conflictText) el.title = conflictText;
  // Compact whole-dollar 30-day cost (skip sub-$1 rows so the list stays quiet).
  const dollars = cost == null ? null : Math.round(cost);
  const costHtml = dollars && dollars >= 1 ? `<span class="conv-cost">$${escapeHtml(dollars.toLocaleString())}</span>` : "";
  const conflictHtml = conflictText ? '<span class="conv-conflict-mark" aria-label="Linked working folder">↔</span>' : "";
  el.innerHTML =
    `<span class="capdot" style="background:${color}"></span>` +
    `<span class="conv-nm"><b>${escapeHtml(name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}${conflictText ? '<small class="conv-conflict-text">Linked folder setup</small>' : ""}</span>` +
    conflictHtml +
    costHtml;
  el.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    selectConv(key);
  });
  return el;
}

function renderConvList() {
  const list = document.getElementById("channel-list");
  const f = (document.getElementById("channel-search").value || "").trim().toLowerCase();
  const showChannels = convFilter === "all" || convFilter === "channels";
  const showDms = convFilter === "all" || convFilter === "dms";
  list.innerHTML = "";

  const templates = convFilter === "templates";
  document.querySelector(".conv-source-filter").hidden = templates;
  document.getElementById("channel-search").closest(".list-search").hidden = templates;
  for (const button of document.querySelectorAll("#conv-seg button")) {
    button.classList.toggle("on", button.dataset.seg === convFilter);
    button.setAttribute("aria-pressed", String(button.dataset.seg === convFilter));
  }
  if (templates) {
    for (const { id, title } of conversationTemplates) {
      list.appendChild(convRow("tpl:" + id, "var(--accent)", title, "", null));
    }
    return;
  }

  // Channels — sorted by name; capdot + profile label (+ network) sub-line; 30-day cost if known.
  if (showChannels) {
    const chans = CHANNELS
      .filter((c) => matchesConversationSource(c, convSource))
      .filter((c) => !f || conversationChannelName(c).toLowerCase().includes(f) || (c.name || "").toLowerCase().includes(f) || (c.slug || "").toLowerCase().includes(f))
      .sort((a, b) => (a.name || a.slug || "").localeCompare(b.name || b.slug || "", undefined, { sensitivity: "base" }));
    const g = document.createElement("div");
    g.className = "list-group";
    g.textContent = "Channels";
    list.appendChild(g);
    if (!chans.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = CHANNELS.length ? "No channels match." : "No channels yet — invite the bot and send a message.";
      list.appendChild(e);
    } else {
      for (const c of chans) list.appendChild(convRow("ch:" + c.channelId, capColorOf(c.meta || {}), conversationChannelName(c), c.meta?.archived ? "Archived" : capLabelOf(c.meta || {}), costFor(c.channelId, c.slug), c.workDirConflict));
    }
  }

  // Direct messages — capdot by the DM's effective capability; sub-line = template name.
  if (showDms) {
    const dmItems = DMS
      .filter((d) => matchesConversationSource(d, convSource))
      .filter((d) => !f || (d.userName || "").toLowerCase().includes(f) || (d.dmUserId || "").toLowerCase().includes(f) || (d.slug || "").toLowerCase().includes(f))
      .sort((a, b) => (a.userName || a.slug || "").localeCompare(b.userName || b.slug || "", undefined, { sensitivity: "base" }));
    const g = document.createElement("div");
    g.className = "list-group";
    g.textContent = "Direct messages";
    list.appendChild(g);
    if (!dmItems.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = DMS.length ? "No DMs match." : "No DMs yet — DM the bot and it'll appear here.";
      list.appendChild(e);
    } else {
      for (const d of dmItems) {
        const tplName = d.template === "admin" ? "Admin template" : d.template === "custom" ? "Custom" : "User template";
        const capMeta = d.template === "custom" ? d.meta || {} : DM_TEMPLATES[d.template] || {};
        list.appendChild(convRow("dm:" + d.channelId, capColorOf(capMeta), d.userName || d.slug, tplName, costFor(d.channelId, d.slug), d.workDirConflict));
      }
    }
  }
}

// Central selection router: highlight the row + render the right detail. Guards unsaved edits.
async function selectConv(key, { history = "push", canonicalize = false } = {}) {
  const requestedKey = key;
  if (key && !conversationExists(key)) key = null;
  if (detailDirty && key !== selectedConv) {
    const ok = await confirmDialog({
      title: "Discard unsaved changes?",
      body: "This conversation has unsaved edits. Switching away will lose them.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) {
      const currentPath = conversationPathForKey(selectedConv);
      if (window.location.pathname !== currentPath) window.history.replaceState({ view: "channels", conversation: selectedConv }, "", currentPath);
      return false;
    }
  }
  if (key?.startsWith("tpl:")) convFilter = "templates";
  else if (convFilter === "templates") convFilter = "all";
  if (selectedConv !== key || !detailDirty) {
    selectedConv = key;
    detailDirty = false;
    renderConvList();
    if (key) openDetail(key);
    else {
      document.getElementById("channel-detail").innerHTML =
        `<p class="empty-detail">Select a conversation on the left to edit its settings.<br /><span class="hint">New channels appear once the bot has seen a message in them, and start <strong>fail-closed</strong>. DMs appear after the person messages the bot.</span></p>`;
    }
  }

  const path = conversationPathForKey(key);
  const state = { view: "channels", conversation: key };
  if (history === "replace" || (canonicalize && window.location.pathname !== path)) window.history.replaceState(state, "", path);
  else if (history === "push" && window.location.pathname !== path) window.history.pushState(state, "", path);
  return !requestedKey || Boolean(key);
}

function openDetail(key) {
  if (!key) return;
  if (key.startsWith("tpl:")) return renderConversationTemplate(key.slice(4));
  if (key.startsWith("ch:")) {
    const ch = CHANNELS.find((c) => c.channelId === key.slice(3));
    if (ch) renderChannelDetail(ch);
  } else if (key.startsWith("dm:")) {
    renderDmDetail(key.slice(3));
  }
}

// ── Shared checklist helpers (MCP list, filter box, "N of M enabled" count) ───────

function mcpEntryId(entry) {
  return String(entry?.id || entry?.name || "");
}

function mcpBoxState(box) {
  try {
    const parsed = JSON.parse(box.dataset.mcpSelections || "{}");
    return {
      claude: Array.isArray(parsed.claude) ? parsed.claude.map(String) : [],
      codex: Array.isArray(parsed.codex) ? parsed.codex.map(String) : [],
      "codex-channel": Array.isArray(parsed["codex-channel"]) ? parsed["codex-channel"].map(String) : [],
    };
  } catch {
    return { claude: [], codex: [], "codex-channel": [] };
  }
}

function initializeMcpBox(box, { claude = [], codex = [], "codex-channel": channelCodex = [] } = {}) {
  box.dataset.kind = "m";
  box.dataset.mcpSelections = JSON.stringify({
    claude: claude.map(mcpEntryId).filter(Boolean),
    codex: codex.map(mcpEntryId).filter(Boolean),
    "codex-channel": channelCodex.map(mcpEntryId).filter(Boolean),
  });
  // Preserve already-saved objects when discovery is unavailable/offline so an unrelated Save
  // round-trips them instead of silently erasing access.
  box._mcpOriginals = { claude: [...claude], codex: [...codex], "codex-channel": [...channelCodex] };
}

function captureMcpSelection(box) {
  if (box.dataset.engine === "both") {
    if (box.dataset.mcpLoading) return;
    const state = mcpBoxState(box);
    for (const engine of ["claude", "codex", ...(box.dataset.mcpChannelId ? ["codex-channel"] : [])]) {
      state[engine] = [...box.querySelectorAll(`input[type="checkbox"][data-mcp-engine="${engine}"]:checked`)]
        .map((input) => input.value);
    }
    box.dataset.mcpSelections = JSON.stringify(state);
    return;
  }
  const engine = box.dataset.engine;
  if (!engine || !["claude", "codex"].includes(engine)) return;
  const state = captureGrantMcpSelection(
    mcpBoxState(box),
    engine,
    checkedValues(box),
    box.dataset.mcpLoading === engine,
  );
  box.dataset.mcpSelections = JSON.stringify(state);
}

function catalogWithSavedEntries(box, engine) {
  const catalog = AVAILABLE_MCPS[engine === "codex-channel" ? `codex-channel:${box.dataset.mcpChannelId}` : engine] || [];
  const state = mcpBoxState(box);
  const wanted = new Set(state[engine]);
  const merged = [...catalog];
  const known = new Set(merged.map(mcpEntryId));
  for (const original of box._mcpOriginals?.[engine] || []) {
    const id = mcpEntryId(original);
    if (!id || !wanted.has(id) || known.has(id)) continue;
    merged.push({ ...original, connected: false, selectable: false, admissionReason: "is no longer available in the host catalog" });
    known.add(id);
  }
  return merged;
}

function mcpCheckboxItem(entry, selected) {
  const value = mcpEntryId(entry);
  if (entry.selectable === false) return { value,
    locked: !selected.includes(value),
    labelHtml: `${escapeHtml(entry.name)} <span class="off-badge">unavailable</span> <span>${escapeHtml(entry.admissionReason || "no admissible transport")}</span>` };
  return entry.connected ? { value, label: entry.name }
    : { value, labelHtml: `${escapeHtml(entry.name)} <span class="off-badge">offline</span>` };
}

function paintMcpBox(box, engine) {
  const selected = mcpBoxState(box)[engine];
  const entries = catalogWithSavedEntries(box, engine);
  box.classList.remove("empty");
  const items = entries.map(entry => mcpCheckboxItem(entry, selected));
  checkboxList(box, items, selected, "value", "label");
}

function paintAllMcpBoxes(box) {
  box.replaceChildren();
  box.classList.remove("empty");
  for (const engine of ["claude", "codex", ...(box.dataset.mcpChannelId ? ["codex-channel"] : [])]) {
    const section = document.createElement("section");
    section.className = "mcp-engine-group";
    section.innerHTML = `<h5>${engine === "claude" ? "Claude" : engine === "codex-channel" ? "Codex (channel account)" : "Codex"}</h5>`;
    const list = document.createElement("div");
    const selected = mcpBoxState(box)[engine];
    const items = catalogWithSavedEntries(box, engine).map(entry => mcpCheckboxItem(entry, selected));
    checkboxList(list, items, selected, "value", "label");
    for (const input of list.querySelectorAll('input[type="checkbox"]')) input.dataset.mcpEngine = engine;
    section.appendChild(list);
    box.appendChild(section);
  }
}

async function loadMcpCatalog(engine, channelId = "") {
  const key = engine === "codex-channel" && channelId ? `codex-channel:${channelId}` : engine;
  if (Array.isArray(AVAILABLE_MCPS[key])) return AVAILABLE_MCPS[key];
  if (!MCP_CATALOG_LOADS[key]) {
    MCP_CATALOG_LOADS[key] = api(`/api/mcp/available?engine=${encodeURIComponent(engine)}${channelId && engine === "codex-channel" ? `&channelId=${encodeURIComponent(channelId)}` : ""}`)
      .then((result) => {
        AVAILABLE_MCPS[key] = Array.isArray(result.servers) ? result.servers : [];
        return AVAILABLE_MCPS[key];
      })
      .finally(() => {
        delete MCP_CATALOG_LOADS[key];
      });
  }
  return MCP_CATALOG_LOADS[key];
}

async function renderMcpBoxForEngine(box, engineValue, countEl, channelId = "") {
  captureMcpSelection(box);
  box.dataset.engine = "both";
  box.dataset.mcpChannelId = channelId;
  const engines = ["claude", "codex", ...(channelId ? ["codex-channel"] : [])];
  const keyFor = engine => engine === "codex-channel" ? `codex-channel:${channelId}` : engine;
  const missing = engines.filter(engine => !Array.isArray(AVAILABLE_MCPS[keyFor(engine)]));
  if (missing.length) {
    box.dataset.mcpLoading = "both";
    box.classList.add("empty");
    box.textContent = "loading MCP lists…";
    updateChecksCount(box, countEl);
    await Promise.all(missing.map(async engine => {
      try { await loadMcpCatalog(engine, engine === "codex-channel" ? channelId : ""); }
      catch { AVAILABLE_MCPS[keyFor(engine)] = []; }
    }));
    if (!box.isConnected || box.dataset.mcpChannelId !== channelId) return;
  }
  delete box.dataset.mcpLoading;
  paintAllMcpBoxes(box);
  updateChecksCount(box, countEl);
}

function selectedMcpEntries(box, engine) {
  captureMcpSelection(box);
  const selected = mcpBoxState(box)[engine];
  const available = catalogWithSavedEntries(box, engine);
  return selected.map((id) => {
    const entry = available.find((candidate) => mcpEntryId(candidate) === id);
    // Unavailable catalog rows redact transport references. Round-trip an existing grant
    // verbatim rather than serializing that display-only stub and silently dropping it.
    // New selections still use the catalog and every save is revalidated by the backend.
    const original = box._mcpOriginals?.[engine]?.find((candidate) => mcpEntryId(candidate) === id);
    return entry?.selectable === false && original ? original : entry;
  }).filter(Boolean);
}

function openOrganizationGrants() {
  window.history.pushState({ view: "skills" }, "", "/skills#organization");
  setView("skills", { history: "none" });
}

function loadOrganizationGrants() {
  if (!orgGrantsPanel) {
    wireGrantTierNavigation(document.getElementById("org-grant-tier"), "organization");
    orgGrantsPanel = mountOrganizationGrants({
      api,
      buildEditor: (grants) => buildAccessGrantsEditor(grants, { tier: "organization" }),
      loadSkillOptions: async () => {
        const catalog = await api("/api/skills");
        SKILLS = catalog.skills;
        PERSONAL_SKILLS = catalog.personalSkills || [];
      },
      versionMoved: advanceSettingsVersion,
      onSaved: updateOrganizationSkills,
    });
  }
  return orgGrantsPanel.load();
}

function wireGrantTierNavigation(select, currentTier) {
  if (!select) return;
  select.value = currentTier;
  select.onchange = (event) => {
    // This selector navigates between grant scopes; it does not mutate a grant by itself.
    event.stopPropagation();
    const next = select.value;
    if (next === "organization") {
      openOrganizationGrants();
    } else if (next === "channel") {
      setView("channels");
    } else if (next === "user") {
      setView("users");
    }
    select.value = currentTier;
  };
}

// Skills/connectors share one editor at each tier. Its MCP state keeps independent Claude/Codex
// selections while the engine dropdown switches the visible catalog.
function buildAccessGrantsEditor(cfg = {}, { tier = "organization", ownerId = "" } = {}) {
  const el = document.createElement("div");
  el.className = "access-grants-editor";
  el.innerHTML = `
    <div class="grid grid-2">
      <label class="field"><span>Connector harness</span><select class="grant-engine"></select></label>
    </div>
    <div class="grid grid-2">
      <div class="col tools-col">
        <div class="checks-head"><h4>MCP servers</h4><span class="checks-count grant-mcps-count"></span></div>
        <input type="search" class="checks-filter grant-mcps-filter" placeholder="Filter servers…" autocomplete="off" />
        <div class="grant-mcps checks"></div>
      </div>
      <div class="col tools-col">
        <div class="checks-head"><h4>Skills</h4><span class="checks-count grant-skills-count"></span></div>
        <input type="search" class="checks-filter grant-skills-filter" placeholder="Filter skills…" autocomplete="off" />
        <div class="grant-skills checks"></div>
      </div>
    </div>`;
  const engineSelect = el.querySelector(".grant-engine");
  engineSelect.innerHTML = engineOptionsHtml();
  engineSelect.value = effectiveEngine(GLOBAL_ENGINE) || "claude";
  if (engineSelect.selectedIndex < 0) engineSelect.selectedIndex = 0;
  const mcpsBox = el.querySelector(".grant-mcps");
  const mcpsCount = el.querySelector(".grant-mcps-count");
  initializeMcpBox(mcpsBox, {
    claude: cfg.allowedMcps || [],
    codex: cfg.allowedCodexMcps || [],
  });
  const skillsBox = el.querySelector(".grant-skills");
  skillsBox.dataset.kind = "s";
  const skillOptions = accessGrantSkillOptions(SKILLS, cfg.skills || [], { personal: PERSONAL_SKILLS, ownerId: tier === "user" ? ownerId : "" });
  checkboxList(skillsBox, skillOptions, accessGrantSkillSelection(skillOptions, cfg.skills || []));
  wireChecksTools(mcpsBox, el.querySelector(".grant-mcps-filter"), mcpsCount);
  wireChecksTools(skillsBox, el.querySelector(".grant-skills-filter"), el.querySelector(".grant-skills-count"));
  mcpsBox.addEventListener("change", () => captureMcpSelection(mcpsBox));
  renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  engineSelect.addEventListener("change", (event) => {
    event.stopPropagation(); // catalog view switch, not a persisted grant change
    renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  });
  el.dataset.tier = tier;
  return {
    el,
    getValues: () => ({
      skills: checkedValues(skillsBox),
      allowedMcps: selectedMcpEntries(mcpsBox, "claude")
        .map((s) => ({ name: s.name, match: s.match, namespace: s.namespace })),
      allowedCodexMcps: selectedMcpEntries(mcpsBox, "codex")
        .map((s) => ({ id: s.id, name: s.name, kind: s.kind, serverName: s.serverName, ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}) })),
    }),
  };
}

// Update a "N of M enabled" count element from a checklist box.
function updateChecksCount(box, countEl) {
  if (!countEl) return;
  const total = box.querySelectorAll('input[type="checkbox"]').length;
  const on = box.querySelectorAll("input:checked").length;
  countEl.textContent = total ? `${on} of ${total} enabled` : "";
}

// Wire a filter <input> to hide non-matching checklist labels, and keep a count live.
function wireChecksTools(box, filterInput, countEl) {
  const refresh = () => updateChecksCount(box, countEl);
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      for (const lbl of box.querySelectorAll("label")) lbl.style.display = !q || lbl.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  }
  box.addEventListener("change", refresh);
  refresh();
  return refresh;
}

// Mount only for the selected conversation. Listing channels never probes their services.
function mountChannelVpnControls(card, channelId) {
  const toggle = card.querySelector(".ch-vpn-enabled");
  const status = card.querySelector(".ch-vpn-state");
  const errorBox = card.querySelector(".ch-vpn-error");
  const refresh = card.querySelector(".ch-vpn-refresh");
  const endpoint = `/api/channels/${encodeURIComponent(channelId)}/vpn`;
  let snapshot = null;
  let pending = false;
  let timer;
  const paint = () => {
    const canStop = !!(snapshot?.enabled || snapshot?.running);
    toggle.checked = canStop;
    const cannotStart = !snapshot?.allowNetwork || !!snapshot?.missingSecrets?.length;
    toggle.disabled = pending || !snapshot?.configured || !!snapshot?.busy
      || snapshot.state === "unavailable" || (!canStop && cannotStart);
    refresh.disabled = pending;
    if (snapshot) {
      const labels = { unconfigured: "Not configured", unavailable: "Unavailable", off: "Off", starting: "Starting", on: "Connected", stopping: "Stopping", failed: "Failed" };
      // The state word, plus the server's message only where the word cannot say why on its own (a
      // failure, an unavailable service) — for the other states it restates the label, and for an
      // unconfigured VPN it repeated the hint below almost word for word.
      const explained = ["failed", "unavailable"].includes(snapshot.state) ? snapshot.message : "";
      const parts = [labels[snapshot.state] || "Unknown", explained];
      if (!snapshot.configured) parts.push("An administrator must import the VPN profile and prepare the channel’s VPN service first.");
      if (snapshot.missingSecrets?.length) parts.push(`Add in Environment: ${snapshot.missingSecrets.join(", ")}.`);
      if (snapshot.configured && !snapshot.allowNetwork) parts.push("Enable Network and save the channel before starting VPN.");
      status.textContent = parts.filter(Boolean).join(" · ");
    }
  };
  const scheduleRefresh = () => {
    clearTimeout(timer);
    if (card.isConnected && ["starting", "stopping"].includes(snapshot?.state)) {
      timer = setTimeout(() => { if (card.isConnected) void request(); }, 2000);
    }
  };
  const request = async (enabled) => {
    if (pending || !card.isConnected) return;
    pending = true;
    clearTimeout(timer);
    errorBox.hidden = true;
    paint();
    try {
      snapshot = await api(endpoint, typeof enabled === "boolean"
        ? { method: "PUT", body: JSON.stringify({ enabled }) } : undefined);
    } catch (error) {
      errorBox.textContent = `VPN request failed: ${error.message}`;
      errorBox.hidden = false;
      if (typeof enabled === "boolean") {
        // A lost response may follow an accepted write. Reconcile before offering another toggle.
        try { snapshot = await api(endpoint); } catch { snapshot = null; }
      } else {
        snapshot = null;
      }
      if (!snapshot) {
        status.textContent = "VPN status unavailable. Refresh to retry.";
      }
    } finally {
      pending = false;
      paint();
      scheduleRefresh();
    }
  };
  toggle.addEventListener("change", () => { void request(toggle.checked); });
  refresh.addEventListener("click", () => { void request(); });
  void request();
  return request;
}

// Drive "Sync now": poll a channel's sync-status until its pass finishes (or the card closes).
function describeDriveSyncResult(last) {
  if (!last) return "";
  const when = new Date(last.at).toLocaleTimeString();
  return last.ok ? `✓ Synced at ${when}${last.firstRun ? " (first full resync)" : ""}.` : `✗ Sync failed at ${when}: ${last.summary || "unknown error"}`;
}
async function pollDriveSync(channelId, resultEl, stillOpen) {
  const started = Date.now();
  while (stillOpen()) {
    const s = await api(`/api/channels/${encodeURIComponent(channelId)}/sync-status`);
    if (!s.running) { resultEl.textContent = describeDriveSyncResult(s.last) || "Sync finished."; return; }
    resultEl.textContent = `⏳ Syncing… ${Math.round((Date.now() - started) / 1000)}s`;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Both the shared gateway and a channel login use the same private Codex sign-in controls.
// The server returns only a method and the temporary device code; never render raw CLI output.
function mountCodexLoginBox(box, url, { onComplete = () => {} } = {}) {
  const statusEl = box.querySelector(".ch-codex-login-status");
  const deviceBox = box.querySelector(".ch-codex-device-code");
  const deviceSection = box.querySelector(".ch-codex-device-section");
  const apiSection = box.querySelector(".ch-codex-api-section");
  const apiNote = box.querySelector(".ch-codex-api-note");
  const methodSelect = box.querySelector(".ch-codex-login-method");
  const apiKeyInput = box.querySelector(".ch-codex-api-key");
  const cancelButton = box.querySelector(".ch-codex-device-cancel");
  let poll = null;
  let observedPending = false;
  let startedHere = false;
  let latestState = null;
  const paintMethod = () => {
    deviceSection.hidden = methodSelect.value !== "device";
    apiSection.hidden = methodSelect.value !== "api-key";
    apiNote.hidden = methodSelect.value !== "api-key";
  };
  const paint = (state) => {
    latestState = state;
    if (state.phase === "pending" && methodSelect.value !== "device") methodSelect.value = "device";
    paintMethod();
    statusEl.textContent = state.phase === "pending" ? (state.code && state.url ? "Enter this code to finish signing in:" : "Requesting a ChatGPT sign-in code…")
      : state.phase === "failed" ? state.error
      : state.authenticated ? `Signed in with ${state.method === "chatgpt" ? "ChatGPT" : "an API key"}`
      : "No login yet";
    deviceBox.hidden = !(state.phase === "pending" && state.code && state.url);
    if (!deviceBox.hidden) {
      box.querySelector(".ch-codex-device-link").href = state.url;
      box.querySelector(".ch-codex-device-value").textContent = state.code;
    }
    cancelButton.hidden = state.phase !== "pending";
    if (state.phase === "pending") observedPending = true;
    if (state.phase === "complete" && (observedPending || startedHere)) {
      onComplete();
      observedPending = false;
      startedHere = false;
    }
    if (state.phase === "pending" && !poll) {
      poll = setInterval(() => {
        if (!box.isConnected) { clearInterval(poll); poll = null; return; }
        void api(url).then(paint).catch(() => { statusEl.textContent = "Could not check sign-in status"; });
      }, 2000);
    } else if (state.phase !== "pending" && poll) {
      clearInterval(poll);
      poll = null;
    }
  };
  void api(url).then(paint).catch((error) => { statusEl.textContent = `Could not check sign-in: ${error.message}`; });
  methodSelect.addEventListener("change", async () => {
    paintMethod();
    if (methodSelect.value === "api-key" && latestState?.phase === "pending") {
      try { await api(url, { method: "DELETE" }); paint(await api(url)); }
      catch (error) { statusEl.textContent = error.message; }
    }
    if (methodSelect.value !== "device" || latestState?.phase === "pending") return;
    startedHere = true;
    statusEl.textContent = "Starting ChatGPT sign-in…";
    try { paint(await api(url, { method: "POST", body: JSON.stringify({ method: "device" }) })); }
    catch (error) { startedHere = false; statusEl.textContent = error.message; }
  });
  box.querySelector(".ch-codex-device-value").addEventListener("click", async () => {
    const code = box.querySelector(".ch-codex-device-value").textContent;
    if (!code) return;
    const result = box.querySelector(".ch-codex-copy-state");
    try { await navigator.clipboard.writeText(code); result.textContent = "Copied"; }
    catch { result.textContent = "Could not copy code"; }
  });
  box.querySelector(".ch-codex-key-save").addEventListener("click", async () => {
    const key = apiKeyInput.value;
    apiKeyInput.value = "";
    if (!key) { statusEl.textContent = "Enter an OpenAI API key"; return; }
    startedHere = true;
    statusEl.textContent = "Saving API key sign-in…";
    try { paint(await api(url, { method: "POST", body: JSON.stringify({ method: "api-key", key }) })); }
    catch (error) { startedHere = false; statusEl.textContent = error.message; }
  });
  cancelButton.addEventListener("click", async () => {
    try { await api(url, { method: "DELETE" }); paint(await api(url)); }
    catch (error) { statusEl.textContent = error.message; }
  });
  paintMethod();
}

function renderChannelDetail(ch) {
  const detail = document.getElementById("channel-detail");
  detailDirty = false;
  const meta = ch.meta || { allowedUsers: [], allowedMcps: [], skills: [], adminMode: false };
  const node = document.getElementById("channel-card").content.cloneNode(true);
  const card = node.querySelector(".conv-detail");
  card.querySelector(".ch-name").textContent = conversationChannelName(ch);
  card.querySelector(".ch-type").textContent = ch.type + (ch.isDM ? " · DM" : "") + (meta.archived ? " · Archived — re-invite the bot to resume configuration updates" : "");
  card.querySelector(".ch-slug").textContent = ch.slug;

  // Header capability pill — colored by the live mode; kept in sync as flags change.
  const modePill = card.querySelector(".ch-mode");
  const paintModePill = (m) => { modePill.textContent = meta.archived ? "Archived" : capLabelOf(m); modePill.setAttribute("style", capPillStyle(m)); };
  paintModePill(meta);

  // ── Dirty tracking / savebar ──────────────────────────────────────────────────
  // Any change/input on Access/Tools/Runtime controls marks the detail dirty and reveals the
  // savebar. The two file editors (Instructions/Memory) and the savebar's own buttons are exempt.
  const savebar = card.querySelector(".detail-savebar");
  const savebarMsg = savebar.querySelector(".msg");
  const markDirty = () => {
    if (detailDirty) return;
    detailDirty = true;
    savebar.hidden = false;
    savebarMsg.textContent = "Unsaved changes";
    savebarMsg.classList.remove("clean");
  };
  const onEdit = (e) => {
    // Exempt: the two file editors, the savebar buttons, the tools filter boxes (filtering the
    // checklists is a view action, not a config change), and the self-saving controls above.
    if (e.target.closest(`[data-pane="instructions"], [data-pane="memory"], .detail-savebar, .checks-filter, .skill-assignment-filters, ${SELF_SAVING_CONTROLS}`)) return;
    markDirty();
  };
  card.addEventListener("input", onEdit);
  card.addEventListener("change", onEdit);

  // Guest users checklist — live membership for this conversation only. Never fall back to the
  // org-wide USERS directory: a failed roster read must preserve saved grants, not expose unrelated
  // people or accidentally clear the list on an unrelated channel save.
  const usersBox = card.querySelector(".ch-users");
  usersBox.dataset.kind = "u";
  usersBox.dataset.ready = "";
  usersBox.dataset.changed = "";
  usersBox.addEventListener("change", () => { usersBox.dataset.changed = "1"; });
  usersBox.classList.add("empty");
  usersBox.textContent = "Loading current Slack members…";
  loadChannelGuestOptions(api, ch.channelId)
    .then((memberItems) => {
      if (!usersBox.isConnected) return;
      checkboxList(usersBox, memberItems, meta.allowedUsers || [], "value", "label");
      usersBox.dataset.ready = "1";
    })
    .catch((error) => {
      if (!usersBox.isConnected) return;
      usersBox.classList.add("empty");
      usersBox.textContent = `Guest list unavailable — saved grants are preserved. ${error.message}`;
      usersBox.dataset.ready = "";
    });

  // Tools: MCP + Skills checklists, each with a filter box + "N of M enabled" count.
  const mcpsBox = card.querySelector(".ch-mcps");
  const mcpsCount = card.querySelector(".ch-mcps-count");
  const skillsBox = card.querySelector(".ch-skills");
  let skillsPicker = null;
  const templateSelect = card.querySelector(".ch-skill-template");
  templateSelect.disabled = true;
  skillsBox.textContent = "Loading skill assignments…";
  initializeMcpBox(mcpsBox, {
    claude: meta.allowedMcps || [],
    codex: meta.allowedCodexMcps || [],
    "codex-channel": meta.allowedChannelCodexMcps || [],
  });
  wireChecksTools(mcpsBox, card.querySelector(".ch-mcps-filter"), mcpsCount);
  mcpsBox.addEventListener("change", () => captureMcpSelection(mcpsBox));
  // Read current assignments when opening the conversation, including edits made in Skills
  // during this SPA session. Failed metadata reads must never clear saved grants on Save.
  Promise.all([api("/api/skills/catalog?deleted=1"), api("/api/skills/overview")]).then(([catalog, overview]) => {
    if (!skillsBox.isConnected) return;
    SKILL_TEMPLATES = overview.templates || [];
    fillSkillTemplateSelect(templateSelect, meta.skillTemplate || "", card.querySelector(".ch-skill-template-state"));
    const inherited = () => {
      const template = SKILL_TEMPLATES.find((t) => t.slug === templateSelect.value);
      const section = catalog.skills.filter((s) => s.channelScope === (meta.workspaceLink?.channelId || ch.channelId) && !s.deleted && s.visibility !== "personal").map((s) => s.slug);
      return [
        { id: "organization", label: "Organization skills", slugs: overview.orgSkills || [], note: "Managed organization-wide." },
        { id: "template", label: "Template skills", slugs: template?.resolved || [], note: template ? `Included by ${template.name}. Edit the template in Skills → Templates.` : "Choose a template above to include its skills." },
        ...(section.length ? [{ id: "section", label: "Conversation skills", slugs: section, note: "Included from this conversation’s repository section." }] : []),
      ];
    };
    skillsPicker = mountSkillAssignmentPicker(skillsBox, { skills: catalog.skills, sources: catalog.sources, selected: meta.skills || [], inherited: inherited(), onChange: markDirty });
    templateSelect.disabled = !!meta.workspaceLink;
    if (meta.workspaceLink) for (const input of skillsBox.querySelectorAll("input,button,select")) input.disabled = true;
    templateSelect.addEventListener("change", () => skillsPicker.update({ inherited: inherited() }));
  }).catch((error) => {
    if (!skillsBox.isConnected) return;
    skillsBox.textContent = `Skill assignments unavailable. Saved skills and template will be preserved. Reopen this conversation to retry. ${error.message}`;
  });

  // The base picker owns admin/shell flags; Auto and Lean are independent controls.
  const flagEls = {
    adminMode: card.querySelector(".ch-admin"),
    allowBash: card.querySelector(".ch-bash"),
    autoMode: card.querySelector(".ch-auto"),
    cleanMode: card.querySelector(".ch-clean"),
  };
  flagEls.adminMode.checked = !!meta.adminMode;
  flagEls.allowBash.checked = !!meta.allowBash;
  flagEls.autoMode.checked = !!meta.autoMode;
  flagEls.cleanMode.checked = !!meta.cleanMode;
  const networkBox = card.querySelector(".ch-network");
  networkBox.checked = !!meta.allowNetwork;
  showBudgetStatus(card.querySelector(".ch-budget-status"), ch.channelId);

  // Capability radio cards drive the hidden <select class="ch-profile"> (what the save reads).
  // Picking a base preserves the independent Auto/Lean controls.
  const profSel = card.querySelector(".ch-profile");
  const profHelp = card.querySelector(".ch-profile-help");
  const capCards = [...card.querySelectorAll(".cap-card")];
  const liveMeta = () => ({ adminMode: flagEls.adminMode.checked, allowBash: flagEls.allowBash.checked, autoMode: flagEls.autoMode.checked, cleanMode: flagEls.cleanMode.checked, allowNetwork: networkBox.checked });
  const applyProfileUI = (p) => {
    profSel.value = p;
    profHelp.textContent = PROFILE_HELP[p] || "";
    for (const c of capCards) c.classList.toggle("sel", c.dataset.cap === p);
    for (const c of capCards) {
      const mark = c.querySelector(".box-mark");
      if (mark) mark.textContent = c.dataset.cap === p ? "☑" : "□";
    }
    if (PROFILE_FLAGS[p]) {
      const f = PROFILE_FLAGS[p];
      flagEls.adminMode.checked = f.adminMode;
      flagEls.allowBash.checked = f.allowBash;
      if (p === "read") flagEls.autoMode.checked = false;
    }
    paintModePill(liveMeta());
  };
  applyProfileUI(channelProfileOf(meta));
  for (const c of capCards) c.addEventListener("click", () => { applyProfileUI(c.dataset.cap); markDirty(); });
  // Option changes repaint the summary and keep Read-only/Auto coherent.
  for (const el of Object.values(flagEls)) el.addEventListener("change", () => {
    if (flagEls.autoMode.checked && profSel.value === "read") applyProfileUI("worker");
    paintModePill(liveMeta());
  });
  networkBox.addEventListener("change", () => paintModePill(liveMeta()));

  // Access: who can USE + who can MANAGE, each with a live description of the selected option.
  const accessSel = card.querySelector(".ch-access");
  const accessHelp = card.querySelector(".ch-access-help");
  accessSel.value = meta.access || "approved";
  const applyAccessUI = () => { accessHelp.textContent = ACCESS_HELP[accessSel.value] || ""; };
  applyAccessUI();
  accessSel.addEventListener("change", applyAccessUI);

  const manageSel = card.querySelector(".ch-manage");
  const manageHelp = card.querySelector(".ch-manage-help");
  const managementPolicy = (value) => ["admins", "members", "custom"].includes(value) ? value : "admins";
  manageSel.value = managementPolicy(meta.manageAccess);
  let savedManageAccess = manageSel.value;
  const applyManageUI = () => { manageHelp.textContent = MANAGE_HELP[manageSel.value] || ""; };
  applyManageUI();
  manageSel.addEventListener("change", applyManageUI);

  card.querySelector(".ch-memory").checked = meta.memory !== false; // default on (global default is on)
  card.querySelector(".ch-skillswap").checked = !!meta.skillRuntimeSwap;
  const workdirInput = card.querySelector(".ch-workdir");
  workdirInput.value = meta.workDir || "";
  if (meta.workspaceLink) {
    const notice = document.createElement("p");
    notice.className = "hint";
    notice.textContent = `Linked folder setup: ${meta.workspaceLink.name}. Skills, templates, memory, instructions, mode, network and Drive sync follow this source. Edit shared settings there; choose a separate folder to unlink. Harness and model remain independent.`;
    const source = document.createElement("button");
    source.type = "button";
    source.textContent = "Open source conversation";
    source.addEventListener("click", () => {
      const id = meta.workspaceLink.channelId;
      selectConv((DMS.some((d) => d.channelId === id) ? "dm:" : "ch:") + id);
    });
    for (const cap of capCards) { cap.style.pointerEvents = "none"; cap.setAttribute("aria-disabled", "true"); }
    for (const pane of card.querySelectorAll('.subpane[data-pane="access"], .subpane[data-pane="connections"], .subpane[data-pane="mcps"], .subpane[data-pane="environment"], .subpane[data-pane="skills"]')) {
      const locked = document.createElement("fieldset");
      locked.disabled = true;
      locked.style.cssText = "border:0;padding:0;margin:0;min-width:0";
      while (pane.firstChild) locked.appendChild(pane.firstChild);
      pane.appendChild(locked);
    }
    notice.appendChild(source);
    card.querySelector(".dhead").after(notice);
    for (const selector of [".ch-memory", ".ch-syncdrive", ".ch-synctest", ".ch-profile", ".ch-network", ".ch-admin", ".ch-bash", ".ch-auto", ".ch-clean", ".ch-skillswap"]) {
      const input = card.querySelector(selector);
      if (input) { input.disabled = true; input.title = "Edit this shared setting in the source conversation"; }
    }
  }
  card.querySelector(".ch-browse").addEventListener("click", () => openFolderPicker(workdirInput));
  card.querySelector(".ch-workdir-reset").addEventListener("click", () => {
    if (!workdirInput.value) return;
    workdirInput.value = "";
    // Follow the same pending-edit flow as Browse: Save applies it; Discard restores the path.
    workdirInput.dispatchEvent(new Event("input", { bubbles: true }));
    workdirInput.focus();
  });
  // Additional folders: one row per entry (path, mode, Browse, Remove). Rows are read back on Save
  // (collectExtraFolders); an empty path row is dropped there rather than refused here.
  const extraList = card.querySelector(".ch-extrafolders");
  const addExtraFolderRow = (entry = { path: "", mode: "rw" }) => {
    const row = document.createElement("div");
    row.className = "row ch-extrafolder";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ch-extrafolder-path";
    input.placeholder = "/absolute/path/to/folder";
    input.value = entry.path || "";
    const mode = document.createElement("select");
    mode.className = "ch-extrafolder-mode";
    for (const [value, label] of [["rw", "read-write"], ["ro", "read-only"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mode.appendChild(option);
    }
    mode.value = entry.mode === "ro" ? "ro" : "rw";
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "ghost";
    browse.textContent = "Browse…";
    browse.addEventListener("click", () => openFolderPicker(input));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => { row.remove(); markDirty(); });
    row.append(input, mode, browse, remove);
    extraList.appendChild(row);
    return input;
  };
  for (const entry of Array.isArray(meta.extraFolders) ? meta.extraFolders : []) addExtraFolderRow(entry);
  card.querySelector(".ch-extrafolder-add").addEventListener("click", () => { addExtraFolderRow().focus(); markDirty(); });
  const collectExtraFolders = () => Array.from(card.querySelectorAll(".ch-extrafolder"))
    .map((row) => ({ path: row.querySelector(".ch-extrafolder-path").value.trim(), mode: row.querySelector(".ch-extrafolder-mode").value }))
    .filter((entry) => entry.path);
  card.querySelector(".ch-syncdrive").value = meta.syncDriveFolder || "";
  card.querySelector(".ch-synctest").addEventListener("click", async () => {
    const result = card.querySelector(".ch-synctest-result");
    const link = card.querySelector(".ch-syncdrive").value.trim();
    if (!link) { result.textContent = "Enter a Drive folder link first."; return; }
    result.textContent = "Testing…";
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/sync-test`, { method: "POST", body: JSON.stringify({ syncDriveFolder: link }) });
      result.textContent = r.ok ? "✓ Connected — service account can see the folder." : `✗ ${r.output || "connection failed"}`;
    } catch (e) {
      result.textContent = "✗ " + e.message;
    }
  });
  const startDriveSyncPass = async (resync) => {
    const result = card.querySelector(".ch-synctest-result");
    const saved = (meta.syncDriveFolder || "").trim();
    if (!saved) { result.textContent = "Save a Drive folder link first."; return; }
    if (card.querySelector(".ch-syncdrive").value.trim() !== saved) { result.textContent = "Save the changed Drive link first — Sync now uses the saved one."; return; }
    if (resync && !confirm("Resync merges the channel folder and the Drive folder from scratch. Use it only when the sync has stopped because its state is damaged.\n\nFiles deleted on only one side since the last good sync can come back. Continue?")) return;
    const button = card.querySelector(resync ? ".ch-syncresync" : ".ch-syncnow");
    button.disabled = true;
    result.textContent = resync ? "Starting resync…" : "Starting sync…";
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/sync-now`, { method: "POST", body: JSON.stringify(resync ? { resync: true } : {}) });
      if (!r.ok) { result.textContent = `✗ ${r.error || "sync not started"}`; return; }
      if (r.busy) result.textContent = "A sync pass is already running — waiting for it…";
      await pollDriveSync(ch.channelId, result, () => card.isConnected);
    } catch (e) {
      result.textContent = "✗ " + e.message;
    } finally {
      button.disabled = false;
    }
  };
  card.querySelector(".ch-syncnow").addEventListener("click", () => startDriveSyncPass(false));
  card.querySelector(".ch-syncresync").addEventListener("click", () => startDriveSyncPass(true));

  const approvedBox = card.querySelector(".ch-approved");
  const approved = meta.approvedTools || [];
  if (approved.length) {
    approvedBox.innerHTML = `Approved forever: ${approved.map(escapeHtml).join(", ")} — <a href="#" class="ch-clear-approved" style="color:var(--accent-2)">clear</a>`;
    approvedBox.querySelector(".ch-clear-approved").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await api(`/api/channels/${encodeURIComponent(ch.channelId)}/meta`, { method: "PUT", body: JSON.stringify({ approvedTools: [] }) });
        ch.meta = { ...(ch.meta || {}), approvedTools: [] };
        renderChannelDetail(ch);
      } catch (err) {
        /* ignore */
      }
    });
  } else {
    approvedBox.textContent = "";
  }
  // The legacy channel Codex account is retired (a channel's own account is a license limited to
  // it, below); a channel the boot migration could not move still reads its stored switch.
  const legacyAuthSource = meta.codexAuthSource === "channel" ? "channel" : "gateway";
  const spendingLimitInput = card.querySelector(".ch-monthly-spending-limit");
  spendingLimitInput.value = meta.monthlySpendingLimitUSD ?? "";
  const modelSelect = card.querySelector(".ch-model");
  const effortSelect = card.querySelector(".ch-effort");
  const effortLabel = card.querySelector(".ch-effort-label");
  // The lock: whole harnesses (`harness:<id>`) and single licenses this channel may run on.
  const harnessPolicy = card.querySelector(".ch-harness-policy");
  const harnessRestrict = card.querySelector(".ch-harness-restrict");
  const harnessOptions = card.querySelector(".ch-harness-options");
  const harnessHelp = card.querySelector(".ch-harness-help");
  let harnessPolicyDirty = false;
  harnessRestrict.checked = Array.isArray(meta.approvedEngines);
  // A license limited to another conversation can never run here, so it is not something to approve.
  const hereIds = [ch.channelId, meta.codeChannel?.originChannelId].filter(Boolean);
  const harnessLock = mountLicenseLock(harnessOptions, { manifests: ENGINE_MANIFESTS.filter((m) => !m.limitedToChannel || hereIds.includes(m.limitedToChannel)), policy: meta.approvedEngines });
  const approvedHarnesses = () => harnessRestrict.checked ? harnessLock.values() : null;
  const approvalAdmits = (id) => policyAdmits(approvedHarnesses(), ENGINE_MANIFESTS.find((m) => m.id === id));
  // The channel default: harness → license → "if it fails, also use" (meta `engine` + `licensePool`).
  // It offers what this channel may run on right now — the lock and the Codex sign-in as they
  // stand on the card, saved or not. `engineSelect.value` is the engine id, "" = the gateway default.
  const engineSelect = mountLicensePicker({
    harnessSelect: card.querySelector(".ch-engine"),
    env: () => licenseEnv({ codexAuthSource: legacyAuthSource, policy: approvedHarnesses(), channelIds: [ch.channelId, meta.codeChannel?.originChannelId] }),
    engine: meta.engine || "",
    pool: meta.licensePool || "",
    includeDefault: true,
    defaultAllowed: () => approvalAdmits(effectiveEngine("")),
    onChange: () => syncChannelRuntime(),
  });
  let shownEngine = engineSelect.value;
  // Model and effort belong to the engine the picker resolved to; so does the MCP catalog.
  const syncChannelRuntime = () => {
    shownEngine = engineSelect.value;
    syncModelOptions({ engineSelect, modelSelect, blankLabel: "gateway default (Settings)" });
    syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel });
    renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount, legacyAuthSource === "channel" ? ch.channelId : "");
  };
  const paintHarnessPolicy = () => {
    harnessOptions.hidden = !harnessRestrict.checked;
    engineSelect.repaint();
    if (engineSelect.value !== shownEngine) syncChannelRuntime();
  };
  harnessPolicy.addEventListener("change", () => { harnessPolicyDirty = true; paintHarnessPolicy(); });
  paintHarnessPolicy();
  void api("/api/license").then((license) => {
    if (!harnessPolicy.isConnected) return;
    for (const [selector, key] of [[".ch-skillswap", "skillModelRouting"], [".ch-skill-template", "skillTemplates"], [".ch-syncdrive", "driveSync"]]) {
      const control = card.querySelector(selector);
      if (control) {
        const entitled = license.features?.[key] === true;
        control.title = entitled ? "" : "Requires Enterprise; existing configuration can be cleared";
        if (control.type === "checkbox") control.disabled = !entitled && !control.checked;
        else if (control.tagName === "SELECT") for (const option of control.options) option.disabled = !entitled && Boolean(option.value);
        else control.readOnly = !entitled && !control.value;
      }
    }
    const addChannelLicense = card.querySelector(".ch-licenses .lic-add");
    if (license.features?.channelCodexLogin !== true) {
      card.querySelector(".ch-licenses-enterprise").hidden = false;
      if (addChannelLicense) addChannelLicense.disabled = true;
    }
    harnessPolicy.disabled = license.features?.channelHarnessPolicy !== true;
    harnessHelp.textContent = harnessPolicy.disabled
      ? "Enterprise is required to change approvals. Any saved restriction remains enforced."
      : "Lock this channel to whole harnesses or to single licenses, then choose an approved channel default. A whole harness includes licenses added to it later. Thread pins and automatic fallback must also stay inside the approved set. Uncheck to allow everything.";
  }).catch(() => { harnessHelp.textContent = "Could not verify Enterprise access. Reopen this channel to retry; saved approvals are preserved."; });


  // "Licenses for this channel": the Settings → Licenses manager, drawn for this conversation only.
  // Its add/edit form is the same one, locked to this channel; a change reloads the engine
  // manifest so the harness picker above offers the new license at once.
  const channelLicenses = mountLicensesManager({
    root: card.querySelector(".ch-licenses"),
    api,
    confirm: confirmDialog,
    copyText: copyTerminalCommand,
    mountCodexLogin: mountCodexLoginBox,
    state: () => ({ manifests: ENGINE_MANIFESTS, enabled: ENGINE_ENABLED }),
    reload: async () => {
      if (!settingsDirty) await loadSettings();
      await channelLicenses.load();
      if (card.isConnected) { engineSelect.repaint(); syncChannelRuntime(); }
    },
    versionMoved: ({ from, to } = {}) => advanceSettingsVersion(from, to),
    scope: { channelId: ch.channelId, label: conversationChannelName(ch) || ch.name || ch.slug || ch.channelId },
  });
  void channelLicenses.load();
  card.querySelector(".ch-org-grants").addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openOrganizationGrants();
  });
  card.querySelector(".ch-licenses-all")?.addEventListener("click", (e) => {
    e.preventDefault();
    setView("settings");
    settingsNavigation.choose("engine-licenses");
  });
  syncModelOptions({ engineSelect, modelSelect, value: meta.model || "", blankLabel: "gateway default (Settings)" });
  syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel, value: meta.effort || "" });
  syncChannelRuntime();
  modelSelect.addEventListener("change", () => syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel }));
  card.querySelector(".ch-composio-state").textContent = GLOBAL_COMPOSIO_MODE === "sdk"
    ? (meta.hasComposioToken ? "saved · inactive in SDK mode" : "inactive in SDK mode")
    : (meta.hasComposioToken ? "" : "no token (no shared composio-agent here)");
  attachReveal(card.querySelector(".ch-composio"), { has: meta.hasComposioToken, last4: meta.composioTokenLast4, fetch: revealSecret("channel", "composioToken", ch.slug) });
  card.querySelector(".ch-composio-label").value = meta.composioTokenLabel || "";
  // Per-channel environment secrets. These are the ONE part of the channel card that saves
  // immediately rather than on the card's Save button: the card round-trips its fields, and a
  // write-only value must never be a field that round-trips. The list is names + last4 only —
  // there is no reveal endpoint for these, by design (see config/channel-env.js).
  card.querySelector(".ch-env-editor").appendChild(secretEditorMarkup());
  mountSecretEditor({
    root: card,
    vars: Array.isArray(meta.envVars) ? meta.envVars : [],
    userName: (id) => USERS[id]?.name || "",
    endpoint: (name) => `/api/channels/${encodeURIComponent(ch.channelId)}/env/${encodeURIComponent(name)}`,
    namePlaceholder: "SUPABASE_ACCESS_TOKEN",
    emptyText: "No variables — runs here use whatever login the gateway host has, plus any organization secret.",
    removeBody: "Runs in this channel stop receiving it. The value can't be recovered — you would have to issue a new one.",
    savedText: (name) => `Saved ${name}. It reaches the next run in this channel.`,
  });

  // Custom MCP servers (gateway/custom-mcps.js): saved immediately like the env secrets above,
  // never round-tripped by the card's Save button, token write-only.
  const customMcpCard = card.querySelector(".custom-mcp-card");
  customMcpCard.querySelector(".ch-custom-mcps").appendChild(customMcpEditorMarkup());
  mountCustomMcpEditor({
    root: customMcpCard,
    servers: Array.isArray(meta.customMcps) ? meta.customMcps : [],
    userName: (id) => USERS[id]?.name || "",
    endpoint: (name) => `/api/channels/${encodeURIComponent(ch.channelId)}/custom-mcps/${encodeURIComponent(name)}`,
    emptyText: "No custom MCP servers — runs here get the built-in connections and any Cloud MCP selected below.",
    removeBody: "Runs in this conversation stop receiving this server, including any run in progress. The token can't be recovered.",
  });

  // Email accounts (gateway/email-accounts.js): same immediate, write-only contract.
  const emailAccountCard = card.querySelector(".email-account-card");
  emailAccountCard.querySelector(".ch-email-accounts").appendChild(emailAccountEditorMarkup());
  mountEmailAccountEditor({
    root: emailAccountCard,
    accounts: Array.isArray(meta.emailAccounts) ? meta.emailAccounts : [],
    userName: (id) => USERS[id]?.name || "",
    endpoint: (name) => `/api/channels/${encodeURIComponent(ch.channelId)}/email-accounts/${encodeURIComponent(name)}`,
    emptyText: "No email accounts — connect one and every run here can read and send with it.",
    removeBody: "Runs in this conversation can no longer read or send with this account. The passwords can't be recovered.",
  });

  const makeToolboxUrlInput = card.querySelector(".ch-make-toolbox-url");
  const makeToolboxKeyInput = card.querySelector(".ch-make-toolbox-key");
  const makeToolboxState = card.querySelector(".ch-make-toolbox-state");
  let clearMakeToolbox = false;
  makeToolboxUrlInput.value = meta.makeToolboxUrl || "";
  attachReveal(makeToolboxKeyInput, { has: meta.hasMakeToolboxKey, last4: meta.makeToolboxKeyLast4, fetch: revealSecret("channel", "makeToolboxKey", ch.slug) });
  makeToolboxState.textContent = meta.hasMakeToolboxKey ? "saved" : "not configured";
  makeToolboxUrlInput.addEventListener("input", () => { clearMakeToolbox = false; });
  makeToolboxKeyInput.addEventListener("input", () => { clearMakeToolbox = false; });
  card.querySelector(".ch-make-toolbox-clear").addEventListener("click", () => {
    clearMakeToolbox = true;
    makeToolboxUrlInput.value = "";
    attachReveal(makeToolboxKeyInput, "");
    makeToolboxState.textContent = "will clear on save";
    markDirty();
  });
  card.querySelector(".ch-make-toolbox-test").addEventListener("click", async () => {
    const button = card.querySelector(".ch-make-toolbox-test");
    const reveal = makeToolboxKeyInput._reveal;
    const key = reveal?.dirty ? makeToolboxKeyInput.value.trim() : String(reveal?.full || "");
    button.disabled = true;
    makeToolboxState.textContent = "testing…";
    try {
      const result = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/make-toolbox-test`, {
        method: "POST",
        body: JSON.stringify({
          makeToolboxUrl: makeToolboxUrlInput.value,
          ...(key ? { makeToolboxKey: key } : {}),
        }),
      });
      const names = Array.isArray(result.tools) ? result.tools.slice(0, 3).join(", ") : "";
      makeToolboxState.textContent = `connected · ${result.count} tool${result.count === 1 ? "" : "s"}${names ? ` · ${names}` : ""}`;
    } catch (error) {
      makeToolboxState.textContent = `test failed · ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  // ── Save (full meta PUT — identical body/fields to before) ────────────────────
  savebar.querySelector(".save-channel").addEventListener("click", async () => {
    const composioTok = tokenValue(card.querySelector(".ch-composio"));
    const composioLabel = card.querySelector(".ch-composio-label").value;
    const makeToolboxKey = tokenValue(makeToolboxKeyInput);
    try {
      const approvals = approvedHarnesses();
      if (harnessPolicyDirty && approvals !== null && !approvals.length) throw new Error("Select at least one approved harness or license.");
      if (approvals !== null && !approvalAdmits(legacyAuthSource === "channel" ? "codex" : effectiveEngine(engineSelect.value))) {
        throw new Error("Choose a channel default from its approved harnesses and licenses.");
      }
      const result = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/meta`, {
        method: "PUT",
        body: JSON.stringify(Object.fromEntries(Object.entries({
          ...(harnessPolicyDirty ? { approvedEngines: approvals } : {}),
          ...channelGuestSavePatch(usersBox.dataset.ready === "1", explicitCheckedValues(usersBox), usersBox.dataset.changed === "1"),
          allowedMcps: selectedMcpEntries(mcpsBox, "claude")
            .map((s) => ({ name: s.name, match: s.match, namespace: s.namespace })),
          allowedCodexMcps: selectedMcpEntries(mcpsBox, "codex")
            .map((s) => ({ id: s.id, name: s.name, kind: s.kind, serverName: s.serverName, ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}) })),
          allowedChannelCodexMcps: selectedMcpEntries(mcpsBox, "codex-channel")
            .map((s) => ({ id: s.id, name: s.name, kind: s.kind, serverName: s.serverName, ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}) })),
          ...(skillsPicker ? {
            skills: skillsPicker.getSelected(),
            // A deleted template may still be referenced by the saved conversation. Preserve
            // that reference on unrelated saves; the API rejects reassigning a missing template.
            ...(!templateSelect.value || SKILL_TEMPLATES.some((t) => t.slug === templateSelect.value)
              ? { skillTemplate: templateSelect.value } : {}),
          } : {}),
          profile: card.querySelector(".ch-profile").value,
          access: card.querySelector(".ch-access").value,
          ...(manageSel.value !== savedManageAccess ? { manageAccess: manageSel.value } : {}),
          adminMode: card.querySelector(".ch-admin").checked,
          allowBash: card.querySelector(".ch-bash").checked,
          allowNetwork: card.querySelector(".ch-network").checked,
          autoMode: card.querySelector(".ch-auto").checked,
          cleanMode: card.querySelector(".ch-clean").checked,
          skillRuntimeSwap: card.querySelector(".ch-skillswap").checked,
          memory: card.querySelector(".ch-memory").checked,
          engine: engineSelect.value,
          // Beside the license it belongs to; "" when the choice is a single license or inherited.
          licensePool: engineSelect.pool ?? "",
          ...(spendingLimitInput.value !== String(ch.meta?.monthlySpendingLimitUSD ?? "")
            ? { monthlySpendingLimitUSD: spendingLimitInput.value.trim() ? Number(spendingLimitInput.value) : null } : {}),
          workDir: card.querySelector(".ch-workdir").value,
          extraFolders: collectExtraFolders(),
          syncDriveFolder: card.querySelector(".ch-syncdrive").value,
          model: card.querySelector(".ch-model").value,
          effort: card.querySelector(".ch-effort").value,
          ...(composioTok ? { composioToken: composioTok } : {}),
          // Owner labels always round-trip (empty clears them) — notes, not secrets.
          composioTokenLabel: composioLabel,
          makeToolboxUrl: makeToolboxUrlInput.value,
          ...(makeToolboxKey ? { makeToolboxKey } : {}),
          ...(clearMakeToolbox ? { clearMakeToolbox: true } : {}),
        }).filter(([key]) => !meta.workspaceLink?.fields?.includes(key === "licensePool" ? "engine" : key)))),
      });
      // The server response is the validated, committed record. Reconcile the cached channel from
      // that whole record so a later SPA re-render cannot resurrect stale MCP/skill selections.
      ch.meta = reconcileChannelMeta(ch.meta, result.meta);
      savedManageAccess = managementPolicy(ch.meta.manageAccess);
      manageSel.value = savedManageAccess;
      applyManageUI();
      showBudgetStatus(card.querySelector(".ch-budget-status"), ch.channelId);
      harnessPolicyDirty = false;
      if (composioTok) void loadComposioConnections(true);
      initializeMcpBox(mcpsBox, { claude: ch.meta.allowedMcps || [], codex: ch.meta.allowedCodexMcps || [], "codex-channel": ch.meta.allowedChannelCodexMcps || [] });
      if (!mcpsBox.dataset.mcpLoading) paintAllMcpBoxes(mcpsBox);
      updateChecksCount(mcpsBox, mcpsCount);
      void refreshVpn();
      skillsPicker?.update({ selected: ch.meta.skills || [] });
      const acceptedGuests = channelGuestAcceptedIds(
        usersBox.dataset.ready === "1",
        ch.meta.allowedUsers,
      );
      if (acceptedGuests) {
        const accepted = new Set(acceptedGuests);
        for (const input of usersBox.querySelectorAll('input[type="checkbox"]')) {
          input.checked = input.dataset.inherited === "1" || accepted.has(input.value);
        }
      }
      usersBox.dataset.changed = "";
      makeToolboxUrlInput.value = ch.meta.makeToolboxUrl || "";
      attachReveal(makeToolboxKeyInput, { has: ch.meta.hasMakeToolboxKey, last4: ch.meta.makeToolboxKeyLast4, fetch: revealSecret("channel", "makeToolboxKey", ch.slug) });
      makeToolboxState.textContent = ch.meta.hasMakeToolboxKey ? "saved" : "not configured";
      clearMakeToolbox = false;
      paintModePill(ch.meta);
      // A work-folder save can add or remove warnings on several rows at once. Refresh both
      // conversation collections from the authoritative server rather than repainting stale flags.
      if (!(await refreshConversationRows())) renderConvList();
      detailDirty = false;
      if (meta.workspaceLink?.slug !== ch.meta.workspaceLink?.slug) {
        renderChannelDetail(ch);
        return;
      }
      savebarMsg.textContent = "Saved";
      savebarMsg.classList.add("clean");
      setTimeout(() => { if (!detailDirty) savebar.hidden = true; }, 1500);
    } catch (err) {
      savebarMsg.textContent = "Couldn't save: " + err.message;
      savebarMsg.classList.remove("clean");
    }
  });

  // Discard: re-render the detail from the cached ch object (clears dirty + hides the savebar).
  savebar.querySelector(".discard").addEventListener("click", () => renderChannelDetail(ch));

  // Memory tab — uncapped Markdown storage with bounded, on-demand recall. MEMORY.md and topic
  // files are indexed into derived SQLite FTS when the agent searches them; no body is injected.
  const memText = card.querySelector(".ch-memory-text");
  const memHint = card.querySelector(".ch-memory-hint");
  const memSaved = card.querySelector(".ch-memory-saved");
  let memLoaded = false;
  const memMeter = (facts, used) => ` <strong>${facts || 0}</strong> durable facts · ${used || 0} index characters · uncapped storage.`;
  const memTopics = (topics) =>
    topics && topics.length ? ` Topic files: ${topics.map((t) => `<code>memory/${escapeHtml(t)}</code>`).join(" ")}.` : "";
  const loadMemory = async () => {
    if (memLoaded) return;
    memLoaded = true;
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/memory`);
      memText.value = r.content || "";
      const extras = memMeter(r.facts || 0, r.used || 0) + memTopics(r.topics);
      memHint.innerHTML = r.enabled
        ? `Markdown is the portable source of truth. Fresh sessions receive only a compact catalog; the agent uses <code>search_channel_memory</code> and <code>read_channel_memory</code> to load relevant passages through a derived SQLite FTS5 index.${extras} <code>${escapeHtml(r.path)}</code>`
        : `Folder memory is <strong>off</strong> for this channel (turn it on in Runtime to have the agent use it). You can still edit the file here.${extras} <code>${escapeHtml(r.path)}</code>`;
    } catch (e) {
      memLoaded = false; // let a later tab click retry
      memHint.textContent = "Couldn't load memory: " + e.message;
    }
  };
  card.querySelector(".ch-memory-save").addEventListener("click", async () => {
    memSaved.textContent = "saving…";
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/memory`, {
        method: "PUT",
        body: JSON.stringify({ content: memText.value }),
      });
      memSaved.textContent = "✓ saved";
      setTimeout(() => (memSaved.textContent = ""), 4000);
      memLoaded = false; // refresh meter/topics on next open
      loadMemory();
    } catch (e) {
      memSaved.textContent = "✗ " + e.message;
    }
  });

  // Instructions tab — edits the channel-owned section of the REAL CLAUDE.md. The gateway's
  // managed block (global instructions + Slack guide) is shown above it read-only; everything in
  // the textarea persists across sessions and is never overwritten by the gateway. A content hash
  // guards against clobbering a concurrent edit (e.g. the agent adding a rule from Slack).
  const insText = card.querySelector(".ch-instructions-text");
  const insHint = card.querySelector(".ch-instructions-hint");
  const insSaved = card.querySelector(".ch-instructions-saved");
  const insGlobalWrap = card.querySelector(".ch-ins-global-wrap");
  const insGlobal = card.querySelector(".ch-ins-global");
  let insLoaded = false;
  let insHash = "";
  const loadInstructions = async () => {
    if (insLoaded) return;
    insLoaded = true;
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/instructions`);
      insHash = r.hash || "";
      insText.value = r.channel || "";
      insGlobal.textContent = r.global || "";
      insGlobalWrap.style.display = r.customFolder || !r.global ? "none" : "";
      if (r.customFolder) {
        insHint.innerHTML = `Custom working folder — you're editing the <strong>project's own</strong> <code>CLAUDE.md</code> directly (no gateway-managed block here). <code>${escapeHtml(r.path)}</code>`;
      } else {
        insHint.innerHTML = `This channel's own standing instructions — persistent, never overwritten by the gateway; you can also ask the agent in Slack to add a rule. <code>${escapeHtml(r.path)}</code>`;
      }
    } catch (e) {
      insLoaded = false; // let a later tab click retry
      insHint.textContent = "Couldn't load instructions: " + e.message;
    }
  };
  card.querySelector(".ch-ins-global-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    setView("settings");
    settingsNavigation.reveal(document.getElementById("set-agents-instructions"));
  });
  card.querySelector(".ch-instructions-save").addEventListener("click", async () => {
    insSaved.textContent = "saving…";
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/instructions`, {
        method: "PUT",
        body: JSON.stringify({ channel: insText.value, hash: insHash }),
      });
      insHash = r.hash || "";
      insSaved.textContent = "✓ saved";
      setTimeout(() => (insSaved.textContent = ""), 2500);
    } catch (e) {
      insSaved.textContent = "✗ " + e.message;
      // Conflict (409): refresh the hash + managed block so a second Save (after review) applies —
      // the textarea keeps the admin's text.
      try {
        const r = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/instructions`);
        insHash = r.hash || "";
        insGlobal.textContent = r.global || "";
      } catch {
        /* leave as-is */
      }
    }
  });

  // Page tabs are view toggles; all Access/MCP Connections/Cloud MCP/Environment/Skills/Runtime controls stay in the DOM so the one savebar
  // persists them. Instructions & Memory lazy-load on first open and keep their own Save.
  const loadComposioConnections = mountComposioInventory(card.querySelector(".ch-composio-inventory"), `/api/channels/${encodeURIComponent(ch.channelId)}/composio-connections`, { autoLoad: false });
  const subtabs = card.querySelectorAll(".subtab");
  const subpanes = card.querySelectorAll(".subpane");
  for (const tab of subtabs) {
    tab.addEventListener("click", () => {
      for (const t of subtabs) t.classList.toggle("active", t === tab);
      for (const p of subpanes) p.classList.toggle("active", p.dataset.pane === tab.dataset.pane);
      if (tab.dataset.pane === "memory") loadMemory();
      if (tab.dataset.pane === "instructions") loadInstructions();
      if (tab.dataset.pane === "connections") void loadComposioConnections();
    });
  }

  detail.innerHTML = "";
  if (meta.archived) {
    for (const control of card.querySelectorAll("input, select, textarea, button:not(.subtab)")) control.disabled = true;
  }
  detail.appendChild(node);
  const refreshVpn = mountChannelVpnControls(card, ch.channelId);
}

// Conversation templates and custom DMs share mode, tools and runtime controls.
// A custom DM can also store a license pool.
function buildConfigEditor(cfg = {}, { storesPool = false, channelId = "" } = {}) {
  const el = document.createElement("div");
  el.className = "cfg-editor";
  el.innerHTML = `
<div class="mode-layout">
    <div><p class="fldlab">Mode</p><div class="cap-cards cfg-capcards">
      <button type="button" class="cap-card" data-cap="read"><h5>Read-only</h5><p>Reads files. Changes need approval.</p></button>
      <button type="button" class="cap-card" data-cap="worker"><h5>Worker</h5><p>Runs commands and edits files in this channel’s folder only.</p></button>
      <button type="button" class="cap-card danger" data-cap="admin"><h5>Admin</h5><p>Admins can use all tools. Other members use Worker.</p></button>
    </div></div>
    <div class="mode-options"><p class="fldlab">Special modes</p>
      <label class="togglerow"><input type="checkbox" class="cfg-auto" /><span class="switch"></span><span class="t"><b>Auto</b><small>Approve tool requests automatically. Enables Worker in Read-only mode.</small></span></label>
      <label class="togglerow"><input type="checkbox" class="cfg-clean" /><span class="switch"></span><span class="t"><b>Lean</b><small>Bare model without skills or connectors. In Admin mode, applies to non-admins.</small></span></label>
    </div>
  </div>
  <select class="cfg-profile" hidden aria-hidden="true"><option value="read">Read-only</option><option value="worker">Worker</option><option value="admin">Admin</option></select>
  <input type="checkbox" class="cfg-admin" hidden /><input type="checkbox" class="cfg-bash" hidden />
    <label class="togglerow cfg-network-wrap">
      <input type="checkbox" class="cfg-network" />
      <span class="switch"></span>
      <span class="t"><b>Network egress</b><small>Allow outbound network requests.</small></span>
    </label>

    <p class="fldlab" style="margin-top:20px">Tools</p>
    <div class="grid grid-2">
      <div class="col tools-col">
        <div class="checks-head"><h4>MCP servers</h4><span class="checks-count cfg-mcps-count"></span></div>
        <input type="search" class="checks-filter cfg-mcps-filter" placeholder="Filter servers…" autocomplete="off" />
        <div class="cfg-mcps checks"></div>
      </div>
      <div class="col tools-col">
        <label class="field"><span>Skill template <em class="state">· follows updates from Skills</em></span>
          <select class="cfg-skill-template"><option value="">none</option></select>
          <em class="state cfg-skill-template-state"></em></label>
        <div class="checks-head"><h4>Additional skills</h4><span class="checks-count cfg-skills-count"></span></div>
        <input type="search" class="checks-filter cfg-skills-filter" placeholder="Filter skills…" autocomplete="off" />
        <div class="cfg-skills checks"></div>
      </div>
    </div>

    <p class="fldlab" style="margin-top:20px">Runtime</p>
    <div class="grid grid-2">
      <label class="field"><span>Harness</span>
        <select class="cfg-engine"><option value="">Default (global setting)</option></select></label>
      <label class="field"><span>Model</span>
        <select class="cfg-model"></select></label>
      <label class="field"><span class="cfg-effort-label">Effort</span>
        <select class="cfg-effort"><option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
    </div>`;
  const mcpsBox = el.querySelector(".cfg-mcps");
  const mcpsCount = el.querySelector(".cfg-mcps-count");
  const skillsBox = el.querySelector(".cfg-skills");
  skillsBox.dataset.kind = "s";
  initializeMcpBox(mcpsBox, {
    claude: cfg.allowedMcps || [],
    codex: cfg.allowedCodexMcps || [],
  });
  const skillOptions = accessGrantSkillOptions(SKILLS, cfg.skills || [], { personal: PERSONAL_SKILLS });
  checkboxList(skillsBox, skillOptions, accessGrantSkillSelection(skillOptions, cfg.skills || []));
  wireChecksTools(mcpsBox, el.querySelector(".cfg-mcps-filter"), mcpsCount);
  mcpsBox.addEventListener("change", () => captureMcpSelection(mcpsBox));
  wireChecksTools(skillsBox, el.querySelector(".cfg-skills-filter"), el.querySelector(".cfg-skills-count"));
  fillSkillTemplateSelect(el.querySelector(".cfg-skill-template"), cfg.skillTemplate || "", el.querySelector(".cfg-skill-template-state"));
  const modelSelect = el.querySelector(".cfg-model");
  const effortSelect = el.querySelector(".cfg-effort");
  const effortLabel = el.querySelector(".cfg-effort-label");
  // Harness → license (→ "if it fails, also use" where a pool is stored). `engineSelect.value` is
  // the engine id, "" = the gateway default.
  const engineSelect = mountLicensePicker({
    harnessSelect: el.querySelector(".cfg-engine"),
    env: () => licenseEnv({ channelIds: [channelId] }),
    engine: cfg.engine || "",
    pool: storesPool ? cfg.licensePool || "" : "",
    includeDefault: true,
    allowPool: storesPool,
    onChange: () => {
      syncModelOptions({ engineSelect, modelSelect, blankLabel: "gateway default (Settings)" });
      syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel });
      renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
    },
  });
  renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  syncModelOptions({ engineSelect, modelSelect, value: cfg.model || "", blankLabel: "gateway default (Settings)" });
  syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel, value: cfg.effort || "" });
  modelSelect.addEventListener("change", () => syncEffortOptions({ engineSelect, modelSelect, effortSelect, label: effortLabel }));

  // Capability cards → hidden flag checkboxes (identical mapping + copy to the channel Access tab).
  const flags = {
    adminMode: el.querySelector(".cfg-admin"),
    allowBash: el.querySelector(".cfg-bash"),
    autoMode: el.querySelector(".cfg-auto"),
    cleanMode: el.querySelector(".cfg-clean"),
  };
  flags.adminMode.checked = !!cfg.adminMode;
  flags.allowBash.checked = !!cfg.allowBash;
  flags.autoMode.checked = !!cfg.autoMode;
  flags.cleanMode.checked = !!cfg.cleanMode;
  const networkBox = el.querySelector(".cfg-network");
  networkBox.checked = !!cfg.allowNetwork;
  const profSel = el.querySelector(".cfg-profile");
  const capCards = [...el.querySelectorAll(".cap-card")];
  const applyProfileUI = (p) => {
    profSel.value = p;
    for (const c of capCards) c.classList.toggle("sel", c.dataset.cap === p);
    for (const c of capCards) {
      const mark = c.querySelector(".box-mark");
      if (mark) mark.textContent = c.dataset.cap === p ? "☑" : "□";
    }
    if (PROFILE_FLAGS[p]) {
      const f = PROFILE_FLAGS[p];
      flags.adminMode.checked = f.adminMode;
      flags.allowBash.checked = f.allowBash;
      if (p === "read") flags.autoMode.checked = false;
    }
  };
  applyProfileUI(channelProfileOf(cfg));
  for (const c of capCards)
    c.addEventListener("click", () => {
      applyProfileUI(c.dataset.cap);
      // A card click flips the hidden checkboxes programmatically (no native change event) — dispatch
      // one so the host's dirty tracking (settings global save / DM detail savebar) notices.
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

  flags.autoMode.addEventListener("change", () => {
    if (flags.autoMode.checked && profSel.value === "read") applyProfileUI("worker");
  });

  const getValues = () => ({
    skills: checkedValues(skillsBox),
    skillTemplate: el.querySelector(".cfg-skill-template").value,
    allowedMcps: selectedMcpEntries(mcpsBox, "claude").map((s) => ({ name: s.name, match: s.match, namespace: s.namespace })),
    allowedCodexMcps: selectedMcpEntries(mcpsBox, "codex")
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind, serverName: s.serverName, ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}) })),
    engine: engineSelect.value,
    ...(storesPool ? { licensePool: engineSelect.pool } : {}),
    model: el.querySelector(".cfg-model").value,
    effort: el.querySelector(".cfg-effort").value,
    adminMode: flags.adminMode.checked,
    allowBash: flags.allowBash.checked,
    allowNetwork: networkBox.checked,
    autoMode: flags.autoMode.checked,
    cleanMode: flags.cleanMode.checked,
  });
  return { el, getValues };
}

// Budgets are conversation-local and administered here, outside shared workspace/template policy.
function readBudgetInput(input) {
  if (!input.checkValidity()) throw new Error("Enter a positive monthly USD budget, or leave it blank for unlimited.");
  return input.value === "" ? null : Number(input.value);
}
function showBudgetStatus(element, channelId) {
  api(`/api/channels/${encodeURIComponent(channelId)}/budget`).then((budget) => {
    element.textContent = `${budget.month} UTC: $${budget.spentUSD.toFixed(2)} recorded${budget.limitUSD === null ? " · Unlimited" : ` of $${budget.limitUSD.toFixed(2)}${!budget.allowed ? " · New agent runs paused" : ""}`}${budget.unpricedRuns ? ` · ${budget.unpricedRuns} unpriced run(s)${budget.limitUSD === null ? "" : "; repair pricing to resume"}` : ""}`;
  }).catch(() => { element.textContent = "Budget usage unavailable. Reopen this conversation to retry."; });
}

// ── Shared savebar (DM + template details) ────────────────────────────────────────
function buildSavebar() {
  const bar = document.createElement("div");
  bar.className = "savebar detail-savebar";
  bar.hidden = true;
  bar.innerHTML = `<span class="msg">Unsaved changes</span><span class="spacer"></span><button type="button" class="ghost discard">Discard</button><button type="button" class="save-changes">Save changes</button>`;
  return bar;
}
// Dirty-track a detail card + wire its savebar. save() does the PUT; discard() re-renders.
function wireSavebar(card, bar, save, discard) {
  const msg = bar.querySelector(".msg");
  let revision = 0;
  const mark = () => {
    revision++;
    if (detailDirty) return;
    detailDirty = true;
    bar.hidden = false;
    msg.textContent = "Unsaved changes";
    msg.classList.remove("clean");
  };
  const onEdit = (e) => { if (!e.target.closest(`.detail-savebar, .checks-filter, ${SELF_SAVING_CONTROLS}`)) mark(); };
  card.addEventListener("input", onEdit);
  card.addEventListener("change", onEdit);
  const saveButton = bar.querySelector(".save-changes");
  const discardButton = bar.querySelector(".discard");
  saveButton.addEventListener("click", async () => {
    const submitted = revision;
    saveButton.disabled = discardButton.disabled = true;
    try {
      await save();
      if (!card.isConnected || submitted !== revision) return;
      detailDirty = false;
      msg.textContent = "Saved";
      msg.classList.add("clean");
      setTimeout(() => { if (!detailDirty) bar.hidden = true; }, 1500);
    } catch (e) {
      msg.textContent = "Couldn't save: " + e.message;
      msg.classList.remove("clean");
    } finally {
      saveButton.disabled = discardButton.disabled = false;
    }
  });
  discardButton.addEventListener("click", discard);
  return mark;
}

// One independent editor per template. Loading or saving a template never repaints Settings.
async function renderConversationTemplate(id) {
  const { title, description } = conversationTemplates.find((item) => item.id === id);
  const card = document.createElement("div");
  card.className = "card detail-card conversation-template";
  card.innerHTML = `<header class="dhead"><h2>${title}</h2></header><p class="hint">${description}</p><p class="template-loading" role="status">Loading…</p>`;
  document.getElementById("channel-detail").replaceChildren(card);
  detailDirty = false;
  const status = card.querySelector(".template-loading");
  try {
    const [settings, catalog] = await Promise.all([api("/api/settings"), api("/api/skills/templates")]);
    if (!card.isConnected) return;
    SKILL_TEMPLATES = catalog.templates || [];
    let version = settings.settingsVersion;
    let stored = templateConfig(settings, id);
    const editor = buildConfigEditor(stored);
    let baseline = editor.getValues();
    const bar = buildSavebar();
    status.replaceWith(editor.el, bar);
    wireSavebar(card, bar, async () => {
      const values = editor.getValues();
      const result = await saveConversationTemplate({ api, id, stored, version, baseline, values });
      advanceSettingsVersion(result.previousVersion, result.settings.settingsVersion);
      version = result.settings.settingsVersion;
      stored = templateConfig(result.settings, id);
      baseline = values;
      DM_TEMPLATES = result.settings.dmTemplates || DM_TEMPLATES;
      renderConvList();
    }, () => renderConversationTemplate(id));
  } catch (error) {
    status.textContent = `Couldn’t load this template. ${error.message}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ghost";
    retry.textContent = "Retry";
    retry.onclick = () => renderConversationTemplate(id);
    card.append(retry);
  }
}

// ── DM detail (1:1 with a person) ─────────────────────────────────────────────────
function renderDmDetail(id) {
  const detail = document.getElementById("channel-detail");
  detailDirty = false;
  const dm = DMS.find((d) => d.channelId === id);
  if (!dm) return;
  const card = document.createElement("div");
  card.className = "card detail-card conv-detail";
  const capMetaOf = (tpl) => (tpl === "custom" ? dm.meta || {} : DM_TEMPLATES[tpl] || {});

  const head = document.createElement("div");
  head.className = "dhead";
  head.innerHTML = `<h2>${escapeHtml(dm.userName || dm.slug)}</h2><span class="pill dm-cap"></span><span class="pill">DM</span><span class="stats"><code class="mono">${escapeHtml(dm.dmUserId || dm.slug)}</code></span>`;
  card.appendChild(head);
  const capPill = head.querySelector(".dm-cap");
  const paintCap = (tpl) => { const m = capMetaOf(tpl); capPill.textContent = capLabelOf(m); capPill.setAttribute("style", capPillStyle(m)); };

  const tplField = document.createElement("label");
  tplField.className = "field";
  tplField.innerHTML = `<span>DM template</span>
    <select class="dm-template"><option value="user">User template</option><option value="admin">Admin template</option><option value="custom">Custom</option></select>`;
  card.appendChild(tplField);
  const tplSel = tplField.querySelector(".dm-template");
  tplSel.value = dm.meta?.workspaceLink ? "custom" : dm.template;
  const editTemplate = document.createElement("a");
  editTemplate.className = "hint";
  editTemplate.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectConv("tpl:" + tplSel.value);
  });
  card.appendChild(editTemplate);
  if (dm.meta?.workspaceLink) {
    tplSel.disabled = true;
    const linked = document.createElement("p");
    linked.className = "hint";
    linked.textContent = `Shared setup linked to ${dm.meta.workspaceLink.name}. Edit shared settings in that source conversation; harness, model and effort remain independent.`;
    head.after(linked);
  }

  const budgetField = document.createElement("label");
  budgetField.className = "field";
  budgetField.innerHTML = `<span>Monthly budget (USD) · Enterprise</span><input type="number" class="dm-budget" min="0.01" step="any" placeholder="Unlimited" /><em class="state">Blank = unlimited. Resets monthly at 00:00 UTC. Active runs may exceed the limit; unpriced usage pauses new runs until pricing is repaired. External service charges are excluded.</em><em class="state dm-budget-status" role="status"></em>`;
  budgetField.querySelector("input").value = dm.meta?.monthlySpendingLimitUSD ?? "";
  card.appendChild(budgetField);
  showBudgetStatus(budgetField.querySelector(".dm-budget-status"), dm.channelId);
  const customBox = document.createElement("div");
  customBox.className = "dm-custom";
  card.appendChild(customBox);
  let ed = null;
  const renderCustom = () => {
    editTemplate.hidden = tplSel.value === "custom";
    editTemplate.textContent = tplSel.value === "admin" ? "Edit admin DM template" : "Edit user DM template";
    editTemplate.href = pathForConversation("template", tplSel.value);
    customBox.innerHTML = "";
    ed = null;
    if (tplSel.value === "custom") {
      ed = buildConfigEditor(dm.meta || {}, { storesPool: true, channelId: dm.channelId });
      customBox.appendChild(ed.el);
      if (dm.meta?.workspaceLink) for (const input of ed.el.querySelectorAll("input,select,button")) {
        if (!input.matches(".cfg-engine,.lic-select,.lic-also input,.cfg-model,.cfg-effort")) input.disabled = true;
      }
    }
  };
  renderCustom();
  paintCap(tplSel.value);
  tplSel.addEventListener("change", () => { renderCustom(); paintCap(tplSel.value); });

  const bar = buildSavebar();
  card.appendChild(bar);
  wireSavebar(
    card, bar,
    async () => {
      const tpl = tplSel.value;
      const values = tpl === "custom" && ed ? ed.getValues() : {};
      const body = { template: tpl, monthlySpendingLimitUSD: readBudgetInput(budgetField.querySelector("input")), ...Object.fromEntries(Object.entries(values).filter(([key]) => !dm.meta?.workspaceLink?.fields?.includes(key === "licensePool" ? "engine" : key))) };
      await api(`/api/dms/${encodeURIComponent(dm.channelId)}`, { method: "PUT", body: JSON.stringify(body) });
      showBudgetStatus(budgetField.querySelector(".dm-budget-status"), dm.channelId);
      dm.template = tpl;
      dm.meta = { ...dm.meta, monthlySpendingLimitUSD: body.monthlySpendingLimitUSD };
      renderConvList();
    },
    () => renderDmDetail(id),
  );
  detail.innerHTML = "";
  detail.appendChild(card);
}

// ── Automations ────────────────────────────────────────────────────────────────
// The health board is ONE component shared with the Activity dashboard (src/web/automation-board.js,
// served at /automation-board.js); the console only gives it the admin scope and its CSRF marker.
// The ROI page is the same component in its "roi" mode, mounted into its own root.
const boardMounts = new Map();
function mountBoard(rootId, extra, what) {
  if (boardMounts.has(rootId)) return boardMounts.get(rootId);
  const mounted = (async () => {
    const board = await import("/automation-board.js");
    if (!document.getElementById("automation-board-css")) {
      const style = document.createElement("style");
      style.id = "automation-board-css";
      style.textContent = board.AUTOMATION_BOARD_CSS;
      document.head.append(style);
    }
    board.automationBoardBrowser({ boardApi: "/api/automation-board", boardHeaders: { "X-CG-Request": "1" }, adminConsole: true, roiHref: "/roi", boardHref: "/automations", rootId, ...extra }, window);
  })().catch((error) => {
    boardMounts.delete(rootId);
    const host = document.getElementById(rootId);
    if (host) host.textContent = `Couldn’t load ${what}: ${error.message}`;
  });
  boardMounts.set(rootId, mounted);
  return mounted;
}
const loadSchedules = () => mountBoard("ab-root", {}, "automations");
const loadRoi = () => mountBoard("roi-root", { page: "roi" }, "ROI");

let scheduleHistory = null;
let scheduleHistoryRequest = 0;
let scheduleRunRequest = 0;
let scheduleHistoryTimer = null;

function closeScheduleHistory() {
  clearInterval(scheduleHistoryTimer);
  scheduleHistoryTimer = null;
  document.getElementById("schedule-history-modal").hidden = true;
  scheduleHistory = null;
  scheduleHistoryRequest++;
  scheduleRunRequest++;
}

function openScheduleHistory(schedule = null) {
  clearInterval(scheduleHistoryTimer);
  scheduleHistory = { schedule, runs: [], before: null, loading: false, detailLoading: false, selectedRun: null };
  scheduleRunRequest++;
  document.getElementById("schedule-history-title").textContent = schedule ? `${schedule.description || "Automation"} · Run history` : "All automation run history";
  document.getElementById("schedule-history-summary").innerHTML = "";
  document.getElementById("schedule-history-list").textContent = "Loading runs…";
  document.getElementById("schedule-history-detail").hidden = true;
  document.getElementById("schedule-history-more").hidden = true;
  document.getElementById("schedule-history-modal").hidden = false;
  document.getElementById("schedule-history-close").focus();
  loadScheduleHistory();
  scheduleHistoryTimer = setInterval(() => {
    if (!scheduleHistory || scheduleHistory.loading || scheduleHistory.detailLoading) return;
    loadScheduleHistory(false, true);
  }, 5000);
}

async function loadScheduleHistory(older = false, automatic = false) {
  if (!scheduleHistory) return;
  const state = scheduleHistory;
  if (state.loading) return;
  state.loading = true;
  const request = ++scheduleHistoryRequest;
  const errorEl = document.getElementById("schedule-history-error");
  const refresh = document.getElementById("schedule-history-refresh");
  const more = document.getElementById("schedule-history-more");
  errorEl.hidden = true;
  refresh.disabled = more.disabled = true;
  try {
    const path = state.schedule ? `/api/schedules/${encodeURIComponent(state.schedule.id)}/runs` : "/api/schedule-runs";
    const query = new URLSearchParams({ limit: "30" });
    if (older && state.before) query.set("before", state.before);
    const result = await api(`${path}?${query}`);
    if (request !== scheduleHistoryRequest || scheduleHistory !== state) return;
    const keepOlder = automatic && state.runs.length > 30;
    const freshIds = new Set(result.runs.map((run) => run.id));
    state.runs = older ? [...state.runs, ...result.runs] : keepOlder ? [...result.runs, ...state.runs.filter((run) => !freshIds.has(run.id))] : result.runs;
    if (!keepOlder) state.before = result.nextBefore;
    document.getElementById("schedule-history-summary").innerHTML = state.schedule ? automationSummaryMarkup(result.summary) : "";
    const list = document.getElementById("schedule-history-list");
    list.innerHTML = state.runs.length ? state.runs.map((run, index) => `<button class="schedule-run-row" type="button" data-run-index="${index}">
      <span><span class="dot ${automationStatusTone(run.status)}"></span> ${escapeHtml(automationStatusLabel(run.status))}</span>
      <strong>${escapeHtml(run.description || run.scheduleId)}</strong><span>${escapeHtml(run.channelName || run.channelId)}</span>
      <time>${escapeHtml(new Date(run.startedAt || run.scheduledAt).toLocaleString())}</time>
    </button>`).join("") : '<p class="hint">No recorded runs yet.</p>';
    for (const button of list.querySelectorAll("button")) button.addEventListener("click", () => openScheduleRun(state.runs[Number(button.dataset.runIndex)].id));
    more.hidden = !state.before;
    if (state.selectedRun) await openScheduleRun(state.selectedRun, true);
  } catch (error) {
    if (request !== scheduleHistoryRequest) return;
    errorEl.textContent = error.message || "Could not load automation history.";
    errorEl.hidden = false;
    if (!state.runs.length) document.getElementById("schedule-history-list").textContent = "History unavailable.";
  } finally {
    state.loading = false;
    if (request === scheduleHistoryRequest) refresh.disabled = more.disabled = false;
  }
}

async function openScheduleRun(id, automatic = false) {
  const state = scheduleHistory;
  if (!state || (automatic && state.detailLoading)) return;
  state.selectedRun = id;
  state.detailLoading = true;
  const request = ++scheduleRunRequest;
  const detail = document.getElementById("schedule-history-detail");
  detail.hidden = false;
  if (!automatic) detail.textContent = "Loading run details…";
  try {
    const { run } = await api(`/api/schedule-runs/${encodeURIComponent(id)}`);
    if (request !== scheduleRunRequest || state !== scheduleHistory) return;
    detail.innerHTML = automationRunMarkup(run);
    if (!automatic) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (request !== scheduleRunRequest || state !== scheduleHistory) return;
    detail.textContent = error.message || "Could not load this run.";
  } finally {
    if (request === scheduleRunRequest) state.detailLoading = false;
  }
}

// ── Users (scannable table + right-side edit drawer) ─────────────────────────────
// loadUsers is called at boot to populate the org-wide Users table. The drawer opens on row click
// and keeps the exact attachReveal/tokenValue masked-input semantics + the same per-user PUT body.
let userDrawerId = null; // which user the drawer is editing (kept open across a save/refresh)
let userSearchQuery = "";
let userSearchRequest = 0;

async function loadUserResults() {
  const query = userSearchQuery;
  const request = ++userSearchRequest;
  const users = query
    ? (await api(`/api/users?q=${encodeURIComponent(query)}`)).users
    : USERS;
  if (request !== userSearchRequest || query !== userSearchQuery) return false;
  USER_RESULTS = users;
  renderUsersTable();
  // A filtered-out selection is no longer represented by a row, so the drawer should not float
  // beside unrelated results. A visible selection keeps its existing unsaved drawer state.
  if (userDrawerId && !USER_RESULTS[userDrawerId]) closeUserDrawer();
  return true;
}

let userAutoApprovalLoaded = false;
async function loadUserAutoApproval() {
  if (userAutoApprovalLoaded) return;
  const policy = await api("/api/user-auto-approval");
  userAutoApprovalLoaded = true;
  const enabled = document.getElementById("user-auto-approval-enabled");
  const domains = document.getElementById("user-auto-approval-domains");
  const status = document.getElementById("user-auto-approval-status");
  const candidates = document.getElementById("user-auto-approval-candidates");
  const apply = document.getElementById("user-auto-approval-apply");
  const next = document.getElementById("user-auto-approval-next");
  let nextOffset = 0;
  const form = document.getElementById("user-auto-approval-form");
  enabled.checked = policy.enabled;
  domains.value = policy.domains.join(", ");
  let ids = [];
  let busy = false;
  function resetPreview() { ids = []; candidates.textContent = ""; apply.hidden = true; next.hidden = true; }
  form.addEventListener("input", resetPreview);
  async function perform(action) {
    if (busy) return;
    busy = true;
    for (const button of document.querySelectorAll("#user-auto-approval button")) button.disabled = true;
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally {
      busy = false;
      for (const button of document.querySelectorAll("#user-auto-approval button")) button.disabled = false;
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    perform(async () => {
      resetPreview();
      const saved = await api("/api/user-auto-approval", { method: "PUT", body: JSON.stringify({
        enabled: enabled.checked, domains: domains.value.split(/[\s,;]+/).filter(Boolean),
      }) });
      domains.value = saved.domains.join(", ");
      status.textContent = "Saved. Applies on the next message. Existing approvals are retained.";
    });
  });
  async function preview(offset = 0) { return perform(async () => {
    resetPreview();
    const result = await api("/api/user-auto-approval/preview", { method: "POST", body: JSON.stringify({ offset }) });
    nextOffset = result.nextOffset;
    next.hidden = nextOffset === null;
    ids = result.candidates.map(user => user.id);
    const list = document.createElement("ul");
    for (const user of result.candidates) {
      const item = document.createElement("li");
      item.textContent = `${user.name} (${user.email})`;
      list.appendChild(item);
    }
    candidates.replaceChildren(list);
    apply.hidden = !ids.length;
    status.textContent = `${ids.length} eligible users. ${result.failed} lookups failed.${result.truncated ? " More users available; preview the next batch." : ""}`;
  }); }
  document.getElementById("user-auto-approval-preview").addEventListener("click", () => preview());
  next.addEventListener("click", () => preview(nextOffset));
  apply.addEventListener("click", () => perform(async () => {
    const selected = ids;
    resetPreview();
    const result = await api("/api/user-auto-approval/apply", { method: "POST", body: JSON.stringify({ userIds: selected }) });
    status.textContent = `${result.approved} users approved after rechecking current identities and policy. ${result.failed} lookups failed.`;
    await loadUsers();
  }));
}

async function loadUsers() {
  await loadUserAutoApproval();
  const { users } = await api("/api/users");
  USERS = users;
  if (!await loadUserResults()) return;
  // If a drawer was open (e.g. a save just refreshed the data), re-open it on the same user.
  if (userDrawerId && USER_RESULTS[userDrawerId]) openUserDrawer(userDrawerId);
  else if (userDrawerId) closeUserDrawer();
}

function renderUsersTable() {
  const wrap = document.getElementById("users");
  const ids = Object.keys(USER_RESULTS).sort((a, b) =>
    (USER_RESULTS[a].name || a).localeCompare(USER_RESULTS[b].name || b, undefined, { sensitivity: "base" }));
  if (!ids.length) {
    const empty = userSearchQuery
      ? `No users match “${escapeHtml(userSearchQuery)}”.`
      : "No users yet — they're recorded when they first message the bot, or add one.";
    wrap.innerHTML = `<table><tbody><tr><td class="audit-empty">${empty}</td></tr></tbody></table>`;
    return;
  }
  const rows = ids.map((id) => {
    const u = USER_RESULTS[id];
    const role = u.isAdmin
      ? `<span class="rolechip admin">Admin</span>`
      : u.approved ? `<span class="rolechip appr">Approved</span>` : `<span class="rolechip none">No access</span>`;
    // Count only grants that load: another person's personal skill is skipped at run time.
    const skillOptions = accessGrantSkillOptions([], u.skills || [], { personal: PERSONAL_SKILLS, ownerId: id });
    const foreignSkills = skillOptions.filter((option) => option.foreign).length;
    const loadedSkills = accessGrantSkillSelection(skillOptions, u.skills || []).length;
    const tok =
      `<span class="tokdots">` +
      `<i class="${u.hasComposioToken ? "set" : ""}" title="Composio">C</i></span>`;
    return `<tr data-id="${escapeHtml(id)}"${userDrawerId === id ? ' class="sel"' : ""}>
      <td>${escapeHtml(u.name || id)}</td>
      <td class="mono">${escapeHtml(id)}</td>
      <td>${role}</td>
      <td class="user-skills-count" title="Skills enabled for this user (personal grants)${foreignSkills ? ` — ${foreignSkills} not loaded: another person's personal skill` : ""}">${loadedSkills}${foreignSkills ? ' <span class="pill" title="Another person\'s personal skill is granted here and is skipped at run time. Open the user to remove it.">⚠</span>' : ""}</td>
      <td>${u.nudges ? "On" : "Off"}</td>
      <td>${tok}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table>
    <thead><tr><th>Name</th><th>User ID</th><th>Role</th><th title="Skills enabled for this user (personal grants)">Skills</th><th>Reminders</th><th>Tokens</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  for (const tr of wrap.querySelectorAll("tbody tr[data-id]")) tr.addEventListener("click", () => openUserDrawer(tr.dataset.id));
}

function closeUserDrawer() {
  userDrawerId = null;
  const drawer = document.getElementById("user-drawer");
  drawer.hidden = true;
  drawer.innerHTML = "";
  for (const tr of document.querySelectorAll("#users tbody tr")) tr.classList.remove("sel");
}

function openUserDrawer(id) {
  const u = USERS[id];
  if (!u) return;
  userDrawerId = id;
  const drawer = document.getElementById("user-drawer");
  const node = document.getElementById("user-drawer-tpl").content.cloneNode(true);
  node.querySelector(".ud-name-title").textContent = u.name || id;
  node.querySelector(".ud-id").textContent = id;
  node.querySelector(".ud-name").value = u.name || "";
  node.querySelector(".ud-approved").checked = !!u.approved;
  node.querySelector(".ud-admin").checked = !!u.isAdmin;
  node.querySelector(".ud-nudges").checked = !!u.nudges;
  node.querySelector(".ud-reply-mentions").checked = u.replyMentions === true;
  const activityHost = node.querySelector(".ud-activity-identities");
  const linkedActivity = new Set(u.activityIdentities || []);
  const activityCandidates = Object.fromEntries(Object.entries(USERS).filter(([uid, user]) => {
    if (uid === id) return false;
    if (linkedActivity.has(uid)) return true;
    const assigned = Object.entries(USERS).some(([owner, record]) => owner !== id && (record.activityIdentities || []).includes(uid));
    return (user.approved || user.isAdmin) && user.activityPlatform && !assigned && !(user.activityIdentities || []).length;
  }).map(([uid, user]) => [uid, { ...user, name: `${user.name || uid} · ${user.activityPlatform === "msteams" ? "Microsoft Teams" : "Google Chat"}` }]));
  const activityPicker = mountUserPicker(activityHost, {
    users: activityCandidates, selected: [...linkedActivity], includeUser: () => true,
    labels: { selected: "Linked Activity accounts", placeholder: "Search users by name, email or account ID…",
      search: "Search Activity users", available: "Available Activity accounts", empty: "No Activity accounts linked." },
  });
  const userGrantsEditor = buildAccessGrantsEditor(u, { tier: "user", ownerId: id });
  const userGrantsHost = node.querySelector(".ud-grants");
  userGrantsHost.innerHTML = `<label class="field"><span>Grant tier</span><select class="ud-grant-tier"><option value="organization">Organization — applies everywhere</option><option value="channel">Channel</option><option value="user" selected>This user</option></select><em class="state">The effective run gets the live union of all three tiers.</em></label>`;
  userGrantsHost.appendChild(userGrantsEditor.el);
  wireGrantTierNavigation(userGrantsHost.querySelector(".ud-grant-tier"), "user");
  node.querySelector(".ud-composio-state").textContent = GLOBAL_COMPOSIO_MODE === "sdk"
    ? (u.hasComposioToken ? "saved · inactive in SDK mode" : "inactive in SDK mode")
    : (u.hasComposioToken ? "" : "no token set");

  drawer.innerHTML = "";
  drawer.hidden = false;
  drawer.appendChild(node);

  mountUserDashboardAccess(drawer.querySelector(".ud-dashboard-access"), id, { confirm: confirmDialog });
  drawer.querySelector(".ud-save-activity").addEventListener("click", async () => {
    const state = drawer.querySelector(".ud-activity-saved");
    state.textContent = "saving…";
    try {
      await api(`/api/users/${encodeURIComponent(id)}/activity-identities`, {
        method: "PUT", body: JSON.stringify({ activityIdentities: activityPicker.getValues() }),
      });
      await loadUsers();
      document.querySelector("#user-drawer .ud-activity-saved").textContent = "✓ saved";
    } catch (error) { state.textContent = "✗ " + error.message; }
  });


  // Editable masked token fields — same reveal semantics as before.
  attachReveal(drawer.querySelector(".ud-composio"), { has: u.hasComposioToken, last4: u.composioTokenLast4, fetch: revealSecret("user", "composioToken", id) });
  drawer.querySelector(".ud-composio-label").value = u.composioTokenLabel || "";
  mountComposioInventory(drawer.querySelector(".ud-composio-inventory"), `/api/users/${encodeURIComponent(id)}/composio-connections`);

  drawer.querySelector(".ud-close").addEventListener("click", closeUserDrawer);

  // This person's OWN environment secrets (config/scoped-env.js). Mounted on the row rather than
  // folded into the Save button: a secret write is one blind overwrite that must not ride along
  // with an unrelated profile save, and the endpoints are per-variable for the same reason.
  // This person's OWN custom MCP servers (gateway/custom-mcps.js) — same immediate, write-only
  // contract as their secrets below.
  const customMcpRow = drawer.querySelector(".ud-custom-mcps-row");
  customMcpRow.querySelector(".ud-custom-mcps").appendChild(customMcpEditorMarkup());
  mountCustomMcpEditor({
    root: customMcpRow,
    servers: u.customMcps || [],
    userName: (uid) => USERS[uid]?.name || "",
    endpoint: (name) => `/api/users/${encodeURIComponent(id)}/custom-mcps/${encodeURIComponent(name)}`,
    emptyText: "No personal MCP servers.",
    removeBody: "This person's runs stop receiving this server everywhere, including any run in progress. The token can't be recovered.",
  });

  // This person's OWN email accounts (gateway/email-accounts.js).
  const emailAccountRow = drawer.querySelector(".ud-email-accounts-row");
  emailAccountRow.querySelector(".ud-email-accounts").appendChild(emailAccountEditorMarkup());
  mountEmailAccountEditor({
    root: emailAccountRow,
    accounts: u.emailAccounts || [],
    userName: (uid) => USERS[uid]?.name || "",
    endpoint: (name) => `/api/users/${encodeURIComponent(id)}/email-accounts/${encodeURIComponent(name)}`,
    emptyText: "No personal email accounts.",
    removeBody: "This person's runs can no longer read or send with this account anywhere. The passwords can't be recovered.",
  });

  const secretsRow = drawer.querySelector(".ud-secrets-row");
  secretsRow.querySelector(".ud-secrets").appendChild(secretEditorMarkup());
  mountSecretEditor({
    root: secretsRow,
    vars: u.secrets || [],
    userName: (id) => USERS[id]?.name || "",
    endpoint: (name) => `/api/users/${encodeURIComponent(id)}/env/${encodeURIComponent(name)}`,
    namePlaceholder: "GH_TOKEN",
    emptyText: "No personal variables — this person's runs use the organization's and each conversation's own secrets.",
    removeBody: "This person's runs stop receiving it everywhere. The value can't be recovered — they would have to issue a new one.",
    savedText: (name) => `Saved ${name}. It reaches the next run this person authors.`,
  });

  const saved = drawer.querySelector(".ud-saved");
  drawer.querySelector(".ud-save").addEventListener("click", async () => {
    const token = tokenValue(drawer.querySelector(".ud-composio"));
    // Owner labels always round-trip (empty clears them) — notes, not secrets.
    const composioTokenLabel = drawer.querySelector(".ud-composio-label").value;
    saved.textContent = "saving…";
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: drawer.querySelector(".ud-name").value,
          isAdmin: drawer.querySelector(".ud-admin").checked,
          approved: drawer.querySelector(".ud-approved").checked,
          nudges: drawer.querySelector(".ud-nudges").checked,
          replyMentions: drawer.querySelector(".ud-reply-mentions").checked,
          ...(token ? { composioToken: token } : {}),
          composioTokenLabel,
          accessGrants: userGrantsEditor.getValues(),
        }),
      });
      // Refresh the table + re-open the drawer on the same user (fresh masked token previews).
      await loadUsers();
      const s2 = document.querySelector("#user-drawer .ud-saved");
      if (s2) { s2.textContent = "✓ saved"; setTimeout(() => (s2.textContent = ""), 2500); }
    } catch (err) {
      saved.textContent = "✗ " + err.message;
    }
  });

  // Reflect the selected row without a full re-render.
  for (const tr of document.querySelectorAll("#users tbody tr")) tr.classList.toggle("sel", tr.dataset.id === id);
}

// ── Settings ────────────────────────────────────────────────────────────────────
function updateConnectionSummary(banner, connection) {
  const badge = banner.closest(".setcard").querySelector(".setcard-state");
  const state = connection?.connected ? "Connected" : ({
    connecting: "Connecting…", disconnecting: "Disconnecting…", error: "Connection error",
  })[connection?.status] || "Not connected";
  badge.textContent = state;
  badge.dataset.tone = connection?.connected ? "ok" : connection?.status === "error" ? "error" : "";
}

function renderSlackStatus(slack) {
  // The Make.com help block names the bot's own member ID once Slack is connected.
  for (const el of document.querySelectorAll("[data-bot-user-id]")) if (slack?.botUserId) el.textContent = slack.botUserId;
  const el = document.getElementById("slack-status");
  if (!slack) return;
  updateConnectionSummary(el, slack);
  if (slack.connected) {
    el.className = "status-banner ok";
    el.textContent = `● Connected as @${slack.user} in ${slack.team}`;
  } else if (slack.status === "connecting") {
    el.className = "status-banner";
    el.textContent = "○ Connecting…";
  } else if (slack.status === "error") {
    el.className = "status-banner bad";
    el.textContent = `● Connection error: ${slack.error || "unknown"}`;
  } else {
    el.className = "status-banner";
    el.textContent = "○ Not connected — enter tokens below and save.";
  }
}

// Google Chat / Teams connection banners. Same vocabulary as the Slack one so an operator reads
// all three the same way; driven by the per-platform snapshot the settings payload carries.
function renderPlatformStatus(id, platform) {
  const el = document.getElementById(id);
  if (!el) return;
  const connection = platform?.connection;
  updateConnectionSummary(el, connection);
  if (connection?.connected) {
    el.className = "status-banner ok";
    el.textContent = `● Connected${connection.detail ? ` — ${connection.detail}` : ""}`;
  } else if (connection?.status === "connecting") {
    el.className = "status-banner";
    el.textContent = "○ Connecting…";
  } else if (connection?.status === "error") {
    el.className = "status-banner bad";
    el.textContent = `● Connection error: ${connection.error || "unknown"}`;
  } else {
    el.className = "status-banner";
    el.textContent = "○ Not connected — fill in the credentials below, save, then Connect.";
  }
}

function tokenState(has, last4 = "") {
  return has ? (last4 ? `set · ••••${last4}` : "set") : "not set";
}

function syncComposioModeUi() {
  const mode = document.getElementById("set-composio-mode")?.value === "sdk" ? "sdk" : "personal";
  GLOBAL_COMPOSIO_MODE = mode;
  const entitled = document.getElementById("set-composio-mode")?.dataset.sdkEntitled === "true";
  document.getElementById("composio-personal-url-field").hidden = mode !== "personal";
  const sdkField = document.getElementById("composio-sdk-key-field");
  if (sdkField) sdkField.hidden = mode !== "sdk";
  const policy = document.getElementById("composio-sdk-policy");
  if (policy) syncComposioPolicyUi(policy, { sdkMode: mode === "sdk", entitled });
  const help = document.getElementById("composio-mode-help");
  if (help) {
    help.textContent = mode === "sdk"
      ? (entitled ? "Enterprise · Beta. Stable identity per Slack user/channel; separate sessions per Slack thread. Only channel managers manage shared connections." : "Enterprise · Beta. An active Enterprise license is required. Save Personal tokens mode or activate an Enterprise license to restore integrations.")
      : "Uses the saved token on each user (composio-user) and on each channel (composio-agent). There is no organization-wide fallback.";
  }
}

// The settings "clear" buttons arm a pending delete that applies on Save (batch-save model,
// same as the checkbox they replaced). Toggling is purely visual until the save handler reads
// the .armed class; disarmClearTok resets one after a successful save.
function disarmClearTok(btn) {
  if (!btn) return;
  btn.classList.remove("armed");
  btn.textContent = "clear";
  btn.title = "Remove this saved token when you save";
}
function toggleClearTok(btn) {
  const armed = btn.classList.toggle("armed");
  btn.textContent = armed ? "clear ✓" : "clear";
  btn.title = armed ? "This saved token will be removed when you save" : "Remove this saved token when you save";
  markSettingsDirty();
}

const settingsNavigation = createSettingsNavigation((href) => {
  window.history.pushState({}, "", href);
  applyLocation();
});

function refreshFeatureCards() {
  for (const card of document.querySelectorAll("[data-feature-toggle]")) {
    const on = document.getElementById(card.dataset.featureToggle).checked;
    card.querySelector(".setcard-state").textContent = on ? "On" : "Off";
    const fields = card.querySelector(".feature-fields");
    if (fields) fields.hidden = !on;
  }
  for (const fields of document.querySelectorAll("[data-requires-setting]")) {
    fields.hidden = !document.getElementById(fields.dataset.requiresSetting).checked;
  }
  for (const card of document.querySelectorAll(".setcard[data-engine-id]")) {
    const enabled = ENGINE_ENABLED[card.dataset.engineId] !== false;
    const state = enabled ? "On" : "Off";
    const badge = card.querySelector(".setcard-state");
    if (badge.textContent !== state) card.open = enabled;
    badge.textContent = state;
  }
}

// ── Settings: dirty tracking for the one global Save ──────────────────────────────
let settingsDirty = false;
function markSettingsDirty() {
  if (settingsDirty) return;
  settingsDirty = true;
  const m = document.getElementById("settings-dirty-msg");
  if (m) { m.textContent = "Unsaved changes"; m.classList.remove("clean"); }
}
// Called at the end of loadSettings() — repainting from stored values is the natural "clean" point
// (initial load AND right after a successful save, which re-loads settings).
function clearSettingsDirty() {
  settingsDirty = false;
  const m = document.getElementById("settings-dirty-msg");
  if (m) { m.textContent = "All changes saved"; m.classList.add("clean"); }
  // NB: #settings-saved (the save-result "✓ saved" text) is owned by the save handler, which writes
  // it just before re-loading settings — don't clear it here or the confirmation would flash away.
}

// ── Settings: chip editors (trusted apps / network domains) ───────────────────────
// The visible .chips box is backed by a hidden <input id="…"> the save handler already reads. We
// keep that input in sync (comma-separated) so the save payload is byte-for-byte identical.
function serializeChips(container) {
  const vals = [...container.querySelectorAll(".c")].map((c) => c.dataset.val);
  document.getElementById(container.dataset.chipFor).value = vals.join(", ");
}
function renderChipsFromInput(container) {
  const raw = document.getElementById(container.dataset.chipFor).value || "";
  const vals = raw.split(",").map((v) => v.trim()).filter(Boolean);
  for (const c of [...container.querySelectorAll(".c")]) c.remove();
  const input = container.querySelector(".chip-input");
  for (const v of vals) {
    const chip = document.createElement("span");
    chip.className = "c";
    chip.dataset.val = v;
    chip.innerHTML = `${escapeHtml(v)} <button type="button" class="chip-x" aria-label="Remove ${escapeHtml(v)}">×</button>`;
    container.insertBefore(chip, input);
  }
}
function addChipValues(container, text) {
  const input = container.querySelector(".chip-input");
  const existing = new Set([...container.querySelectorAll(".c")].map((c) => c.dataset.val));
  let added = false;
  for (const v of String(text).split(",").map((x) => x.trim()).filter(Boolean)) {
    if (existing.has(v)) continue;
    existing.add(v);
    const chip = document.createElement("span");
    chip.className = "c";
    chip.dataset.val = v;
    chip.innerHTML = `${escapeHtml(v)} <button type="button" class="chip-x" aria-label="Remove ${escapeHtml(v)}">×</button>`;
    container.insertBefore(chip, input);
    added = true;
  }
  if (added) { serializeChips(container); markSettingsDirty(); }
}

// Whether an opt-in harness's own provider credential is configured, by engine id. Filled from the
// settings payload; used only to annotate the toggle, never to gate it (an admin may legitimately
// switch a harness on and paste its key in the same save).
const SETTINGS_HAVE_PROVIDER_KEY = {};

// The Anthropic-compatible provider harnesses (/api/settings `qwenProviders`) and the cards
// rendered for them. `collectSettings` reads the cards rather than fixed element ids, so the
// save body carries exactly the providers the server declared.
let QWEN_ENGINE_IDS = [];
let QWEN_PROVIDER_CARDS = [];
let TERMINAL_HARNESS_CARDS = [];

async function copyTerminalCommand(command) {
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    // Self-hosted HTTP pages may have no Clipboard API. Keep a user-initiated copy available.
    const input = document.createElement("textarea");
    input.value = command;
    input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(input);
    try {
      input.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      input.remove();
    }
  }
}

function paintTerminalHarnesses(harnesses, settings) {
  const tpl = document.getElementById("terminal-harness-tpl");
  if (!tpl) return;
  for (const old of document.querySelectorAll(".terminal-harness-card")) old.remove();
  TERMINAL_HARNESS_CARDS = [];
  for (const harness of harnesses || []) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const at = (role) => card.querySelector(`[data-role="${role}"]`);
    card.dataset.engineId = harness.id;
    at("label").textContent = harness.label;
    at("description").textContent = harness.description;
    at("command").textContent = harness.command;
    const copy = at("copy-command");
    copy.setAttribute("aria-label", `Copy ${harness.label} terminal command`);
    copy.addEventListener("click", async () => {
      at("copy-state").textContent = "Copying…";
      const copied = await copyTerminalCommand(harness.command);
      at("copy-state").textContent = copied ? "Copied" : "Could not copy — select the command and copy it manually.";
      copy.focus();
    });
    const modelSelect = at("default-model");
    const effortSelect = at("default-effort");
    syncModelOptions({ modelSelect, engine: harness.id, value: settings[harness.modelField] || "", blankLabel: "provider default" });
    syncDefaultEffort(modelSelect, effortSelect, harness.id, settings[harness.effortField]);
    tpl.parentNode.insertBefore(card, tpl);
    TERMINAL_HARNESS_CARDS.push({ ...harness, modelSelect, effortSelect });
  }
}

function collectTerminalHarnesses() {
  return Object.fromEntries(TERMINAL_HARNESS_CARDS.flatMap((card) => [
    [card.modelField, card.modelSelect.value], [card.effortField, card.effortSelect.value],
  ]));
}

// One settings card per provider, cloned from the template that marks where they belong. Rendered
// as SIBLINGS of the other cards (not nested in a wrapper) so the settings search, the jump nav
// and the section's own spacing treat them like any hand-written card.
function paintQwenProviders(providers) {
  const tpl = document.getElementById("qwen-provider-tpl");
  if (!tpl) return;
  for (const old of document.querySelectorAll(".qwen-provider-card")) old.remove();
  QWEN_PROVIDER_CARDS = [];
  for (const p of providers || []) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const at = (role) => card.querySelector(`[data-role="${role}"]`);
    card.dataset.engineId = p.id;
    at("label").textContent = p.label;
    at("description").textContent = p.description || "";
    at("endpoint-hint").textContent = p.endpointHint || "";
    const keyInput = at("api-key");
    const urlInput = at("base-url");
    const modelSelect = at("default-model");
    const effortSelect = at("default-effort");
    const clearBtn = at("clear-key");
    // An endpoint the provider ships is a placeholder (blank = keep it); one only the operator can
    // know is not, so the box says so instead of implying a default exists.
    urlInput.placeholder = p.defaultBaseUrl || "required — paste your account's endpoint";
    urlInput.value = p.baseUrl || "";
    at("key-state").textContent = tokenState(p.hasApiKey, p.apiKeyLast4);
    attachReveal(keyInput, { has: p.hasApiKey, last4: p.apiKeyLast4 || "", fetch: revealSecret("settings", p.apiKeyField) });
    // The button sits inside the field's <label>; preventDefault stops the click focusing the input.
    clearBtn.addEventListener("click", (e) => { e.preventDefault(); toggleClearTok(clearBtn); });
    syncModelOptions({ modelSelect, engine: p.id, value: p.defaultModel || "", blankLabel: "provider default" });
    syncDefaultEffort(modelSelect, effortSelect, p.id, p.defaultEffort);
    // Say WHERE the list came from: a stale shipped list and a live account list look identical in
    // a picker, and the difference decides whether a missing model is a typo or a missing key.
    const catalog = ENGINE_MANIFESTS.find((m) => m.id === p.id)?.modelCatalog;
    at("catalog-note").textContent = catalog?.source === "live"
      ? `Read from the account itself${catalog.refreshedAt ? ` · refreshed ${new Date(catalog.refreshedAt).toLocaleString()}` : ""}.`
      : (p.hasApiKey
        ? "Built-in list — the account's own list could not be read. Check the key and endpoint, then reload."
        : "Built-in list. Save an API key to read the account's own models.");
    tpl.parentNode.insertBefore(card, tpl);
    QWEN_PROVIDER_CARDS.push({ ...p, keyInput, urlInput, modelSelect, effortSelect, clearBtn });
  }
}

// The provider half of the save body: each card's endpoint, default model, and a key only when one
// was typed (write-only) or an explicit clear was armed.
function collectQwenProviders() {
  const body = {};
  for (const card of QWEN_PROVIDER_CARDS) {
    body[card.baseUrlField] = card.urlInput.value;
    body[card.defaultModelField] = card.modelSelect.value;
    body[card.defaultEffortField] = card.effortSelect.value;
    const typed = tokenValue(card.keyInput);
    if (typed) body[card.apiKeyField] = typed;
    if (card.clearBtn.classList.contains("armed")) body[`clear${card.apiKeyField[0].toUpperCase()}${card.apiKeyField.slice(1)}`] = true;
  }
  return body;
}

// ── Settings: engine licenses ─────────────────────────────────────────────────────────────────────
// Every license of each harness, switched on and off here (admin-licenses.js draws the list and
// owns adding, editing, verifying and removing one). Re-rendered — not patched — on every change, so
// the pickers and the "last one standing" lock stay derived from a single source: ENGINE_ENABLED.
// (These are ENGINE licenses. The ChannelGate product license is loadLicense(), further down.)
let HEALTH_ENGINES = null; // /api/health → engines: the status shown for a license the gateway ships with
let licensesManager = null;
let gatewayEnginePicker = null; // #set-engine as the harness step of the gateway default

// Where a license the gateway ships with is configured on this page, if it is: its own card, or
// the default-model field named after it.
function builtinLicenseSettings(id) {
  return TERMINAL_HARNESS_CARDS.find((card) => card.id === id)?.modelSelect.closest(".setcard")
    || QWEN_PROVIDER_CARDS.find((card) => card.id === id)?.keyInput.closest(".setcard")
    || document.getElementById(`set-default-${id}-model`)?.closest(".field")
    || null;
}

// The conversations a license can be limited to (Settings can be opened before the Conversations
// page ever loaded its lists, so they are fetched when missing).
async function licenseConversations() {
  // Read-only here: the Conversations page owns its lists and repaints when it loads them.
  let channels = CHANNELS, dms = DMS;
  if (!channels.length && !dms.length) {
    [{ channels }, { dms }] = await Promise.all([api("/api/channels"), api("/api/dms")]);
  }
  const named = [
    ...channels.map((c) => ({ id: c.channelId, label: conversationChannelName(c) || c.name || c.slug || c.channelId })),
    ...dms.map((d) => ({ id: d.channelId, label: `DM · ${d.userName || d.dmUserId || d.slug || d.channelId}` })),
  ];
  return named.filter((place) => place.id).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function paintEngineLicenses() {
  const root = document.getElementById("engine-enabled-box");
  if (!root || !ENGINE_MANIFESTS.length) return;
  licensesManager ||= mountLicensesManager({
    root,
    api,
    confirm: confirmDialog,
    copyText: copyTerminalCommand,
    mountCodexLogin: mountCodexLoginBox,
    state: () => ({ manifests: ENGINE_MANIFESTS, enabled: ENGINE_ENABLED }),
    health: (id) => HEALTH_ENGINES?.[id] || null,
    setEnabled: (id, on) => {
      ENGINE_ENABLED[id] = on;
      refreshFeatureCards();
      licensesManager.paint();
      // Switching off the license that IS the default re-points the default at one that is on —
      // visibly, in the picker, before the admin saves.
      gatewayEnginePicker?.repaint();
      markSettingsDirty();
    },
    // A license that needs a provider credential of its own says where that lives. Without this the
    // switch reads like every other one and the admin only discovers the missing key when a run
    // fails in Slack.
    builtinNote: (m) => !m.optIn || SETTINGS_HAVE_PROVIDER_KEY[m.id] ? ""
      : m.terminalSetup ? " · configure in a terminal (Settings button)" : " · needs an API key (Settings button)",
    openBuiltin: (m) => builtinLicenseSettings(m.id) ? () => settingsNavigation.reveal(builtinLicenseSettings(m.id)) : null,
    blocked: () => settingsDirty ? "Save your settings changes first — changing a license reloads this page from the saved settings." : "",
    reload: loadSettings,
    // Only the step this page can account for: its own version → the one the check produced.
    versionMoved: ({ from, to } = {}) => advanceSettingsVersion(from, to),
    // What a license can be limited to: every channel and DM this gateway knows, by name.
    conversations: licenseConversations,
    // The gateway's own Codex sign-in ("Default sign-in" of Codex): ChatGPT or an API key.
    gatewayCodexLogin: {
      url: "/api/gateway/codex-login",
      onComplete: () => {
        delete AVAILABLE_MCPS.codex;
        const box = document.querySelector("#channel-detail .ch-mcps");
        if (box && box.dataset.mcpCodexKey === "codex") void renderMcpBoxForEngine(box, "codex", document.querySelector("#channel-detail .ch-mcps-count"));
      },
    },
  });
  licensesManager.paint();
}

// The gateway default as the picker stores it: `engine` + `enginePool`.
function readGatewayEngine() {
  return gatewayEnginePicker
    ? { engine: gatewayEnginePicker.value, enginePool: gatewayEnginePicker.pool }
    : { engine: document.getElementById("set-engine").value };
}

// Read the whole Settings form into the API's shape. Separate from the save handler because it is
// called TWICE: once right after a paint (the baseline the page was loaded with) and once on Save
// — what differs between the two is all that gets sent.
function paintLogoColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  document.getElementById("set-logo-color").value = color;
  document.getElementById("set-logo-hex").value = color;
  const preview = document.getElementById("set-logo-preview");
  preview.querySelector("rect").setAttribute("fill", color);
  const luminance = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  preview.querySelector("g").setAttribute("fill", luminance > .179 ? "#18382b" : "#ffffff");
}
for (const id of ["set-logo-color", "set-logo-hex"]) document.getElementById(id).addEventListener("input", (event) => {
  paintLogoColor(event.target.value);
});
document.getElementById("reset-logo-color").addEventListener("click", () => { paintLogoColor("#ff642f"); markSettingsDirty(); });
function readSettingsForm() {
  if (!document.getElementById("set-logo-hex").checkValidity()) throw new Error("Logo color must be a six-digit hex color, such as #ff642f.");
  for (const id of ["set-max-concurrent-runs", "set-reserved-interactive-runs"]) {
    const input = document.getElementById(id);
    if (!input.checkValidity()) throw new Error(`${id === "set-max-concurrent-runs" ? "Maximum parallel agent runs" : "Reserved interactive slots"} must be a whole number between ${input.min} and ${input.max}.`);
  }

  return {
    // Tokens are write-only: tokenValue() is "" unless the admin actually typed a new one (the
    // fields are pre-filled with the masked stored value, so `.value` is never blank).
    slackBotToken: tokenValue(document.getElementById("set-bot")),
    slackAppToken: tokenValue(document.getElementById("set-app")),
    slackSigningSecret: tokenValue(document.getElementById("set-sign")),
    ...(tokenValue(document.getElementById("set-admin-user")) ? { slackAdminUserToken: tokenValue(document.getElementById("set-admin-user")) } : {}),
    ...(document.getElementById("clear-admin-user").classList.contains("armed") ? { clearSlackAdminUserToken: true } : {}),
    sessionKeepalive: document.getElementById("set-keepalive").value,
    mentionReactions: document.getElementById("set-mention-reactions").value,
    teamsMentionReactions: document.getElementById("set-teams-mention-reactions").value,
    googleChatMentionReactions: document.getElementById("set-google-chat-mention-reactions").value,
    trustedBotApps: document.getElementById("set-trusted-apps").value,
    defaultChannelAccess: document.getElementById("set-channel-access").value,
    composioMode: document.getElementById("set-composio-mode").value,
    composioSdkPolicy: readComposioPolicy(document.getElementById("composio-sdk-policy")),
    ...(tokenValue(document.getElementById("set-composio-sdk-key")) ? { composioSdkApiKey: tokenValue(document.getElementById("set-composio-sdk-key")) } : {}),
    ...(document.getElementById("clear-composio-sdk-key").classList.contains("armed") ? { clearComposioSdkApiKey: true } : {}),
    composioMcpUrl: document.getElementById("set-composio").value,
    publicUrl: document.getElementById("set-public-url").value,
    appleAppIds: document.getElementById("set-apple-app-ids").value,
    logoColor: document.getElementById("set-logo-hex").value,
    trustProxy: document.getElementById("set-trust-proxy").value,
    approvalLinks: document.getElementById("set-approval-links").value,
    aiTestingUsers: aiTestingPicker?.getValues() || [],
    ...(document.getElementById("set-gchat-key").value.trim() ? { googleChatServiceAccountJson: document.getElementById("set-gchat-key").value } : {}),
    ...(document.getElementById("clear-gchat-key").classList.contains("armed") ? { clearGoogleChatServiceAccountJson: true } : {}),
    googleChatSubscription: document.getElementById("set-gchat-sub").value,
    googleChatBotUserId: document.getElementById("set-gchat-bot").value,
    googleChatReactionTopic: document.getElementById("set-gchat-reaction-topic").value,
    googleChatAppServiceAccount: document.getElementById("set-gchat-app-sa").value,
    googleChatProjectNumber: document.getElementById("set-gchat-project-number").value,
    teamsAppId: document.getElementById("set-teams-app").value,
    ...(tokenValue(document.getElementById("set-teams-secret")) ? { teamsAppPassword: tokenValue(document.getElementById("set-teams-secret")) } : {}),
    ...(document.getElementById("clear-teams-secret").classList.contains("armed") ? { clearTeamsAppPassword: true } : {}),
    teamsTenantId: document.getElementById("set-teams-tenant").value,
    teamsFilesEnabled: document.getElementById("set-teams-files-enabled").checked,
    teamsFileDriveIds: document.getElementById("set-teams-file-drives").value.split(/[\s,]+/).filter(Boolean),
    teamsAllMessageEvents: document.getElementById("set-teams-all-message-events").checked,
    ...(tokenValue(document.getElementById("set-license-key")) ? { licenseKey: tokenValue(document.getElementById("set-license-key")) } : {}),
    ...(document.getElementById("clear-license-key").classList.contains("armed") ? { clearLicenseKey: true } : {}),
    platformUrl: document.getElementById("set-platform-url").value,
    contextWindow: Number(document.getElementById("set-ctxwindow").value) || undefined,
    ...readGatewayEngine(),
    defaultClaudeModel: document.getElementById("set-default-claude-model").value,
    defaultCodexModel: document.getElementById("set-default-codex-model").value,
    defaultClaudeEffort: document.getElementById("set-default-claude-effort").value,
    defaultCodexEffort: document.getElementById("set-default-codex-effort").value,
    ...collectQwenProviders(),
    ...collectTerminalHarnesses(),
    iosCallsEnabled: document.getElementById("set-ios-calls-enabled").checked,
    ...(document.getElementById("set-apns-team-id").value.trim() ? { apnsTeamId: document.getElementById("set-apns-team-id").value.trim() } : {}),
    ...(document.getElementById("set-apns-key-id").value.trim() ? { apnsKeyId: document.getElementById("set-apns-key-id").value.trim() } : {}),
    apnsBundleId: document.getElementById("set-apns-bundle-id").value.trim() || "com.makeitfuture.channelgate",
    ...(document.getElementById("set-apns-private-key").value.trim() ? { apnsPrivateKey: document.getElementById("set-apns-private-key").value.trim() } : {}),
    clearApnsPrivateKey: document.getElementById("clear-apns-private-key").checked,
    voiceCallsEnabled: document.getElementById("set-voice-calls-enabled").checked,
    ...(tokenValue(document.getElementById("set-gemini-api-key")) ? { geminiApiKey: tokenValue(document.getElementById("set-gemini-api-key")) } : {}),
    ...(document.getElementById("clear-gemini-api-key").classList.contains("armed") ? { clearGeminiApiKey: true } : {}),
    ...(document.getElementById("set-voice-call-model").value ? { voiceCallModel: document.getElementById("set-voice-call-model").value } : {}),
    ...(document.getElementById("set-voice-call-voice").value ? { voiceCallVoice: document.getElementById("set-voice-call-voice").value } : {}),
    perplexityResearchEnabled: document.getElementById("set-perplexity-research-enabled").checked,
    ...(document.getElementById("set-perplexity-session-token").value ? { perplexitySessionToken: document.getElementById("set-perplexity-session-token").value } : {}),
    ...(document.getElementById("clear-perplexity-session-token").classList.contains("armed") ? { clearPerplexitySessionToken: true } : {}),
    modelShortcuts: collectModelShortcuts(),
    engineEnabled: { ...ENGINE_ENABLED },
    engineFallback: document.getElementById("set-engine-fallback").checked,
    engineFallbackMode: document.getElementById("set-engine-fallback-mode").value,
    showMessageCost: document.getElementById("set-show-message-cost").checked,
    whisperEnabled: document.getElementById("set-whisper-enabled").checked,
    maxConcurrentRuns: Number(document.getElementById("set-max-concurrent-runs").value),
    reservedInteractiveRuns: Number(document.getElementById("set-reserved-interactive-runs").value),
    containerCli: document.getElementById("set-container-cli").value,
    containerImage: document.getElementById("set-container-image").value,
    containerIdleMinutes: Number(document.getElementById("set-container-idle").value) || undefined,
    containerMaxRunning: Number(document.getElementById("set-container-max").value) || undefined,
    containerPidsLimit: Number(document.getElementById("set-container-pids").value) || undefined,
    containerMemory: document.getElementById("set-container-memory").value,
    containerCpus: document.getElementById("set-container-cpus").value,
    containerFullAccessHome: document.getElementById("set-container-full-access-home").checked,
    fsRoots: document.getElementById("set-fs-roots").value.split("\n").map((line) => line.trim()).filter(Boolean),
    privateMcpHosts: document.getElementById("set-private-mcp-hosts").value.split("\n").map((line) => line.trim()).filter(Boolean),
    containerEgressMode: document.getElementById("set-container-egress-bridge").checked ? "bridge" : "proxy",
    containerEgressSecretsStrict: document.getElementById("set-container-egress-strict").checked,
    // Write-only: send a value only when one was typed; "clear" arms an explicit removal.
    ...(tokenValue(document.getElementById("set-container-claude-token")) ? { containerClaudeOauthToken: tokenValue(document.getElementById("set-container-claude-token")) } : {}),
    ...(document.getElementById("clear-container-claude-token").classList.contains("armed") ? { clearContainerClaudeOauthToken: true } : {}),
    agentsFile: document.getElementById("set-agentsfile").checked,
    agentsInstructions: document.getElementById("set-agents-instructions").value,
    agentMemory: document.getElementById("set-agentmemory").checked,
    memoryReviewEvery: Number(document.getElementById("set-memory-review-every").value),
    memoryReviewModel: document.getElementById("set-memory-review-model").value,
    memoryReviewNotify: document.getElementById("set-memory-review-notify").checked,
    scheduleMinIntervalMinutes: Number(document.getElementById("set-sched-min").value) || undefined,
    scheduleMaxPerChannel: Number(document.getElementById("set-sched-max").value) || undefined,
    noResponseReminderHours: Number(document.getElementById("set-nudge-hours").value) || undefined,
    defaultNudges: document.getElementById("set-default-nudges").checked,
    publicFileLinksEnabled: document.getElementById("set-public-file-links-enabled").checked,
    emailAccountsEnabled: document.getElementById("set-email-accounts-enabled").checked,
    driveSyncEnabled: document.getElementById("set-drivesync-enabled").checked,
    driveSyncKeyFile: document.getElementById("set-drivesync-keyfile").value,
    ...(document.getElementById("set-drivesync-keyjson").value.trim() ? { driveSyncKeyJson: document.getElementById("set-drivesync-keyjson").value } : {}),
    ...(document.getElementById("clear-drivesync-keyjson").checked ? { clearDriveSyncKeyJson: true } : {}),
    driveSyncSubject: document.getElementById("set-drivesync-subject").value,
    driveSyncIntervalMinutes: Number(document.getElementById("set-drivesync-interval").value) || undefined,
    driveSyncConflict: document.getElementById("set-drivesync-conflict").value,
    driveSyncRclonePath: document.getElementById("set-drivesync-rclone").value,
    codexModelRates: readCodexRates(),
    claudeModelRates: readClaudeRates(),
    assumedModels: {
      claude: document.getElementById("set-assumed-claude").value.trim(),
      codex: document.getElementById("set-assumed-codex").value.trim(),
    },
    // HTTP run API token (write-only): send the new value only if edited/generated; the clear
    // toggle removes it. Leaving the field untouched keeps the stored token.
  };
}

function paintSettings(s) {
  const iphone = s.iosCalls || {};
  document.getElementById("set-ios-calls-enabled").checked = iphone.enabled === true;
  document.getElementById("set-apns-team-id").value = iphone.teamId || "";
  document.getElementById("set-apns-key-id").value = iphone.keyId || "";
  document.getElementById("set-apns-bundle-id").value = iphone.bundleId || "com.makeitfuture.channelgate";
  document.getElementById("set-apns-private-key").value = "";
  document.getElementById("clear-apns-private-key").checked = false;
  document.getElementById("apns-key-state").textContent = iphone.hasPrivateKey ? "stored" : "not configured";
  const voice = s.voiceCalls || {};
  document.getElementById("set-voice-calls-enabled").checked = voice.enabled === true;
  document.getElementById("gemini-api-key-state").textContent = tokenState(voice.hasApiKey, voice.apiKeyLast4);
  attachReveal(document.getElementById("set-gemini-api-key"), { has: voice.hasApiKey, last4: voice.apiKeyLast4, fetch: revealSecret("settings", "geminiApiKey") });
  for (const [id, options, current] of [["set-voice-call-model", voice.models, voice.model], ["set-voice-call-voice", voice.voices, voice.voice]]) {
    const select = document.getElementById(id);
    select.replaceChildren(...(options || []).map((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; return option; }));
    select.value = current || "";
  }
  document.getElementById("set-perplexity-research-enabled").checked = s.perplexityResearch?.enabled === true;
  document.getElementById("set-perplexity-session-token").value = "";
  document.getElementById("perplexity-session-state").textContent = s.perplexityResearch?.hasSessionToken ? "configured" : "not configured";
  // Keep a provider the operator opened or closed by hand across a save/repaint.
  const manualDisclosures = new Map();
  for (const card of document.querySelectorAll("details[data-engine-id]")) {
    if (card.open !== (ENGINE_ENABLED[card.dataset.engineId] !== false)) {
      manualDisclosures.set(card.dataset.engineId, card.open);
    }
  }
  applyEngineManifests(s.engines);
  ENGINE_ENABLED = { ...(s.engineEnabled || {}) };
  // Before the licenses paint: they annotate an opt-in license whose provider key is still missing.
  paintQwenProviders(s.qwenProviders);
  for (const p of s.qwenProviders || []) SETTINGS_HAVE_PROVIDER_KEY[p.id] = p.hasApiKey === true;
  paintTerminalHarnesses(s.terminalHarnesses, s);
  paintEngineLicenses();
  document.getElementById("state-bot").textContent = tokenState(s.tokens.hasBotToken, s.tokens.botTokenLast4);
  document.getElementById("state-app").textContent = tokenState(s.tokens.hasAppToken, s.tokens.appTokenLast4);
  document.getElementById("state-sign").textContent = s.tokens.hasSigningSecret ? "set" : "not set";
  attachReveal(document.getElementById("set-bot"), { has: s.tokens.hasBotToken, last4: s.tokens.botTokenLast4, fetch: revealSecret("settings", "slackBotToken") });
  attachReveal(document.getElementById("set-app"), { has: s.tokens.hasAppToken, last4: s.tokens.appTokenLast4, fetch: revealSecret("settings", "slackAppToken") });
  attachReveal(document.getElementById("set-sign"), { has: s.tokens.hasSigningSecret, last4: "", fetch: revealSecret("settings", "slackSigningSecret") });
  document.getElementById("state-admin-user").textContent = tokenState(s.tokens.hasAdminUserToken, s.tokens.adminUserTokenLast4);
  attachReveal(document.getElementById("set-admin-user"), { has: s.tokens.hasAdminUserToken, last4: s.tokens.adminUserTokenLast4, fetch: revealSecret("settings", "slackAdminUserToken") });
  document.getElementById("set-keepalive").value = s.sessionKeepalive || "";
  document.getElementById("set-mention-reactions").value = (s.mentionReactions || []).join(", ");
  document.getElementById("set-teams-mention-reactions").value = (s.teamsMentionReactions || []).join(", ");
  document.getElementById("set-google-chat-mention-reactions").value = (s.googleChatMentionReactions || []).join(", ");
  document.getElementById("set-trusted-apps").value = (s.trustedBotApps || []).join(", ");
  if (s.defaultChannelAccess) document.getElementById("set-channel-access").value = s.defaultChannelAccess;
  document.getElementById("set-composio-mode").value = s.composioMode === "sdk" ? "sdk" : "personal";
  paintComposioPolicy(document.getElementById("composio-sdk-policy"), s.composioSdkPolicy);
  document.getElementById("set-composio-mode").dataset.sdkEntitled = String(s.composioSdk?.entitled === true);
  document.querySelector('#set-composio-mode option[value="sdk"]').disabled = s.composioSdk?.entitled !== true;
  document.getElementById("set-composio-sdk-key").disabled = s.composioSdk?.entitled !== true;
  GLOBAL_COMPOSIO_MODE = document.getElementById("set-composio-mode").value;
  document.getElementById("composio-sdk-key-state").textContent = tokenState(s.hasComposioSdkApiKey, s.composioSdkApiKeyLast4);
  attachReveal(document.getElementById("set-composio-sdk-key"), "");
  syncComposioModeUi();
  document.getElementById("set-composio").value = s.composioMcpUrl || "";
  document.getElementById("set-public-url").value = s.publicUrl || "";
  document.getElementById("set-apple-app-ids").value = s.appleAppIds || "";
  paintLogoColor(s.logoColor || "#ff642f");
  document.getElementById("set-trust-proxy").value = s.trustProxy || "";
  document.getElementById("set-approval-links").value = s.approvalLinks || "auto";
  aiTestingPicker = mountUserPicker(document.getElementById("set-ai-testing-users"), {
    users: USERS, selected: s.aiTestingUsers || [], onChange: markSettingsDirty,
  });
  // ── Google Chat + Teams ────────────────────────────────────────────────────
  const platformById = Object.fromEntries((s.platforms || []).map((p) => [p.id, p]));
  renderPlatformStatus("gchat-status", platformById.googlechat);
  renderPlatformStatus("teams-status", platformById.msteams);
  document.getElementById("state-gchat-key").textContent = s.googleChat?.hasServiceAccount
    ? `set${s.googleChat.serviceAccountEmail ? ` · ${s.googleChat.serviceAccountEmail}` : ""}`
    : "not set";
  document.getElementById("set-gchat-sub").value = s.googleChat?.subscription || "";
  document.getElementById("set-gchat-bot").value = s.googleChat?.botUserId || "";
  document.getElementById("set-gchat-reaction-topic").value = s.googleChat?.reactionTopic || "";
  document.getElementById("set-gchat-app-sa").value = s.googleChat?.appServiceAccount || "";
  document.getElementById("set-gchat-project-number").value = s.googleChat?.projectNumber || "";
  document.getElementById("gchat-endpoint").textContent = s.googleChat?.eventsEndpoint || "set the Public URL first";
  // No eye toggle on the key: attachReveal drives an <input type=password>, and this is a textarea
  // (a service-account key is multi-line JSON) — the same shape the Drive-sync key field uses. The
  // value is still fetchable through /api/secrets/reveal for an admin who needs it back.
  document.getElementById("set-teams-app").value = s.teams?.appId || "";
  document.getElementById("set-teams-tenant").value = s.teams?.tenantId || "";
  document.getElementById("set-teams-files-enabled").checked = Boolean(s.teams?.filesEnabled);
  document.getElementById("set-teams-file-drives").value = (s.teams?.fileDriveIds || []).join("\n");
  document.getElementById("set-teams-all-message-events").checked = s.teams?.allMessageEvents === true;
  document.getElementById("state-teams-secret").textContent = tokenState(s.teams?.hasAppPassword, s.teams?.appPasswordLast4);
  attachReveal(document.getElementById("set-teams-secret"), { has: Boolean(s.teams?.hasAppPassword), last4: s.teams?.appPasswordLast4 || "", fetch: revealSecret("settings", "teamsAppPassword") });
  const teamsEndpoint = s.teams?.messagingEndpoint || "set a Public URL first";
  document.getElementById("teams-endpoint").textContent = teamsEndpoint;
  document.getElementById("teams-create-command").textContent = s.teams?.messagingEndpoint
    ? `teams app create --name "ChannelGate" --endpoint "${teamsEndpoint}"`
    : 'teams app create --name "ChannelGate" --endpoint "https://<public-url>/api/teams/messages"';
  document.getElementById("set-ctxwindow").value = s.contextWindow || "";
  // The gateway default: harness → license → "if it fails, also use" (settings `engine` + `enginePool`).
  if (ENGINE_MANIFESTS.length) {
    gatewayEnginePicker ||= mountLicensePicker({ harnessSelect: document.getElementById("set-engine"), env: () => licenseEnv() });
    gatewayEnginePicker.set(s.engine || "", s.enginePool || "");
  } else if (s.engine) document.getElementById("set-engine").value = s.engine;
  GLOBAL_ENGINE = s.engine || "claude";
  syncModelOptions({ modelSelect: document.getElementById("set-default-claude-model"), engine: "claude", value: s.defaultClaudeModel || "", blankLabel: "CLI default" });
  syncModelOptions({ modelSelect: document.getElementById("set-default-codex-model"), engine: "codex", value: s.defaultCodexModel || "", blankLabel: "CLI default" });
  for (const engine of ["claude", "codex"]) {
    syncDefaultEffort(document.getElementById(`set-default-${engine}-model`), document.getElementById(`set-default-${engine}-effort`), engine, s[`default${engine === "claude" ? "Claude" : "Codex"}Effort`]);
  }
  paintModelShortcuts(s.modelShortcuts);
  document.getElementById("set-engine-fallback").checked = s.engineFallback !== false;
  document.getElementById("set-engine-fallback-mode").value = s.engineFallbackMode || "auto";
  document.getElementById("set-show-message-cost").checked = s.showMessageCost !== false;
  document.getElementById("set-whisper-enabled").checked = s.whisperEnabled !== false;
  document.getElementById("set-max-concurrent-runs").value = s.maxConcurrentRuns ?? 8;
  document.getElementById("set-reserved-interactive-runs").value = s.reservedInteractiveRuns ?? 2;
  // Container runtime. The token follows the write-only rule: has*/last4 here, value on demand.
  document.getElementById("set-container-cli").value = s.containerCli || "auto";
  document.getElementById("set-container-image").value = s.containerImage || "";
  document.getElementById("set-container-idle").value = s.containerIdleMinutes ?? 10;
  document.getElementById("set-container-max").value = s.containerMaxRunning ?? 8;
  document.getElementById("set-container-pids").value = s.containerPidsLimit ?? 4096;
  document.getElementById("set-container-memory").value = s.containerMemory || "";
  document.getElementById("set-container-cpus").value = s.containerCpus || "";
  document.getElementById("set-container-full-access-home").checked = s.containerFullAccessHome === true;
  document.getElementById("set-fs-roots").value = Array.isArray(s.fsRoots) ? s.fsRoots.join("\n") : "";
  document.getElementById("set-private-mcp-hosts").value = Array.isArray(s.privateMcpHosts) ? s.privateMcpHosts.join("\n") : "";
  document.getElementById("set-container-egress-bridge").checked = s.containerEgressMode === "bridge";
  document.getElementById("set-container-egress-strict").checked = s.containerEgressSecretsStrict === true;
  document.getElementById("container-token-state").textContent = tokenState(s.hasContainerClaudeOauthToken, s.containerClaudeOauthTokenLast4);
  attachReveal(document.getElementById("set-container-claude-token"), { has: s.hasContainerClaudeOauthToken, last4: s.containerClaudeOauthTokenLast4 || "", fetch: revealSecret("settings", "containerClaudeOauthToken") });
  // HTTP run API key: a revealable field seeded with the stored token (so it can be copied into an
  // automation) plus a set/not-set state. Generated client-side, persisted on Save (write-only).
  // License key: has*/last4 only in this payload, like every other secret. The value is fetched
  // one at a time from /api/secrets/reveal behind the eye toggle.
  attachReveal(document.getElementById("set-license-key"), { has: s.hasLicenseKey, last4: s.licenseKeyLast4, fetch: revealSecret("settings", "licenseKey") });
  document.getElementById("license-key-state").textContent = tokenState(s.hasLicenseKey, s.licenseKeyLast4);
  document.getElementById("set-platform-url").value = s.platformUrl || "";
  document.getElementById("set-agentsfile").checked = s.agentsFile !== false;
  document.getElementById("set-agents-instructions").value = s.agentsInstructions || "";
  document.getElementById("set-agentmemory").checked = s.agentMemory !== false;
  document.getElementById("set-memory-review-every").value = s.memoryReviewEvery ?? 5;
  document.getElementById("set-memory-review-model").value = s.memoryReviewModel || "";
  document.getElementById("set-memory-review-notify").checked = s.memoryReviewNotify !== false;
  document.getElementById("set-sched-min").value = s.scheduleMinIntervalMinutes ?? 60;
  document.getElementById("set-sched-max").value = s.scheduleMaxPerChannel ?? 20;
  document.getElementById("set-nudge-hours").value = s.noResponseReminderHours ?? 24;
  document.getElementById("set-default-nudges").checked = s.defaultNudges === true;
  document.getElementById("set-public-file-links-enabled").checked = s.publicFileLinksEnabled === true;
  document.getElementById("set-email-accounts-enabled").checked = s.emailAccountsEnabled === true;
  document.getElementById("set-drivesync-enabled").checked = s.driveSyncEnabled === true;
  // Pasted key is write-only: never echo it; show set/not-set + the service-account email to share with.
  document.getElementById("set-drivesync-keyjson").value = "";
  document.getElementById("clear-drivesync-keyjson").checked = false;
  document.getElementById("drivesync-key-state").textContent = s.hasDriveSyncKeyJson
    ? `· key set${s.driveSyncKeyEmail ? " · share folders with " + s.driveSyncKeyEmail : ""}`
    : "· no key";
  document.getElementById("set-drivesync-keyfile").value = s.driveSyncKeyFile || "";
  document.getElementById("set-drivesync-subject").value = s.driveSyncSubject || "";
  document.getElementById("set-drivesync-interval").value = s.driveSyncIntervalMinutes ?? 15;
  document.getElementById("set-drivesync-conflict").value = s.driveSyncConflict || "newer";
  document.getElementById("set-drivesync-rclone").value = s.driveSyncRclonePath && s.driveSyncRclonePath !== "rclone" ? s.driveSyncRclonePath : "";
  // Per-model Codex rates table (fixed model list; server merges edits over its defaults).
  const ratesBody = document.querySelector("#codex-rates tbody");
  ratesBody.innerHTML = Object.entries(s.codexModelRates || {})
    .map(
      ([model, r]) =>
        `<tr data-model="${escapeHtml(model)}"><td><code>${escapeHtml(model)}</code></td>` +
        ["input", "cachedInput", "output"]
          .map((f) => `<td><input type="number" min="0" step="0.001" data-f="${f}" value="${Number(r?.[f] ?? 0)}" /></td>`)
          .join("") +
        `</tr>`
    )
    .join("");
  // Per-model Claude rates. Open model list (Anthropic ships models between gateway releases), so
  // this paints whatever the server merged rather than a fixed set of rows.
  const claudeRatesBody = document.querySelector("#claude-rates tbody");
  claudeRatesBody.innerHTML = Object.entries(s.claudeModelRates || {})
    .map(
      ([model, r]) =>
        `<tr data-model="${escapeHtml(model)}"><td><code>${escapeHtml(model)}</code></td>` +
        ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"]
          .map((f) => `<td><input type="number" min="0" step="0.001" data-f="${f}" value="${Number(r?.[f] ?? 0)}" /></td>`)
          .join("") +
        `</tr>`
    )
    .join("");
  const assumed = s.assumedModels || {};
  document.getElementById("set-assumed-claude").value = assumed.claude ?? "";
  document.getElementById("set-assumed-codex").value = assumed.codex ?? "";
  renderSlackStatus(s.slack);
  DM_TEMPLATES = s.dmTemplates || DM_TEMPLATES;
  if (viewLoaded.channels) renderConvList();
  // Re-render the chip editors from the (just-set) hidden inputs, and treat this repaint as clean.
  for (const c of document.querySelectorAll("#view-settings .chips[data-chip-for]")) renderChipsFromInput(c);
  clearSettingsDirty();
  // A repaint shows what the daemon STORES, so nothing pending may survive it: an armed clear
  // toggle or a typed write-only value belongs either to a save that already happened or — after a
  // refused one — to a save that never will. They also have to go before the baseline below, or a
  // pending action would be captured as "already the server's state" and then never sent.
  for (const btn of document.querySelectorAll("#view-settings .clear-tok.armed")) disarmClearTok(btn);
  document.getElementById("set-gchat-key").value = "";
  // Remember what this paint put on the page: Save sends the difference against it, so a field
  // nobody touched here is never re-asserted over another writer's newer value.
  settingsNavigation.setLegacyKeyAvailable(s.hasApiKey);
  SETTINGS_SNAPSHOT = s;
  SETTINGS_VERSION = s?.settingsVersion ? String(s.settingsVersion) : "";
  refreshFeatureCards();
  for (const card of document.querySelectorAll("details[data-engine-id]")) {
    if (manualDisclosures.has(card.dataset.engineId)) card.open = manualDisclosures.get(card.dataset.engineId);
  }
  SETTINGS_BASELINE = readSettingsForm();
}

async function loadSettings() {
  const [settings, directory] = await Promise.all([
    api("/api/settings"),
    api("/api/users").catch(() => ({ users: USERS })),
  ]);
  USERS = directory.users || {};
  paintSettings(settings);
  await Promise.all([loadLicense(), mountAdminAccess(document.getElementById("admin-access"), { confirm: confirmDialog })]);
  // The admin-added engine licenses: their type, sign-in state and verification (the manifest
  // painted above already lists them by name).
  await licensesManager?.load();
}

// ── Variables: organization-wide environment secrets (config/scoped-env.js) ────────
// Its own endpoint, not part of /api/settings: that payload is a fixed set of named fields with
// hand-written has*/last4 echoes, and an arbitrary-name secret bag behind it is exactly the shape
// that erodes the "resolve a NAMED field" property web/secrets.js depends on.
let orgSecretEditor = null;
let orgSecretEntitled = null;
async function loadOrgSecrets() {
  const host = document.getElementById("org-secrets-editor");
  if (!host) return;
  const status = document.getElementById("org-secrets-status");
  let entitled;
  let vars;
  try {
    const [license, list] = await Promise.all([api("/api/license"), api("/api/org-secrets")]);
    entitled = license.features?.organizationVariables === true;
    vars = list.vars || [];
    status.textContent = entitled ? "" : "Enterprise is required to add or replace organization variables.";
  } catch (error) {
    status.textContent = "Could not load organization variables. " + error.message;
    return;
  }
  if (orgSecretEditor && orgSecretEntitled === entitled) {
    orgSecretEditor.setVars(vars);
    return;
  }
  host.textContent = "";
  orgSecretEntitled = entitled;
  const markup = secretEditorMarkup();
  markup.querySelector(".secret-add").hidden = !entitled;
  host.appendChild(markup);
  const card = document.getElementById("org-secrets-card");
  orgSecretEditor = mountSecretEditor({
    root: card,
    disabled: !entitled,
    allowRemoval: true,
    vars,
    userName: (id) => USERS[id]?.name || "",
    endpoint: (name) => `/api/org-secrets/${encodeURIComponent(name)}`,
    namePlaceholder: "GH_TOKEN",
    emptyText: "No organization variables set.",
    removeBody: "EVERY conversation stops receiving it on its next run. The value can't be recovered — you would have to issue a new one.",
    savedText: (name) => `Saved ${name}. Every conversation's next run receives it.`,
  });
}

// ── Settings: the License card (src/ee/) ──────────────────────────────────────────
// Its own endpoint, not part of /api/settings: the state machine has a clock in it (grace windows,
// the next scheduled check, the UTC month-boundary fallback) and the usage ledger is per-month
// data the settings payload has no business carrying.
async function loadLicense() {
  try {
    paintLicense(await api("/api/license"));
  } catch (error) {
    const host = document.getElementById("license-usage");
    if (host) host.innerHTML = `<p class="license-usage-empty">Couldn't load the license state: ${escapeHtml(error.message)}</p>`;
  }
}

const LICENSE_STATE_LABEL = {
  no_key: "· no key — 1 conversation",
  valid: "· verified",
  invalid: "· key rejected",
  revoked: "· key revoked",
  expired: "· license expired",
  grace: "· offline grace",
  expired_grace: "· grace expired",
};

const fmtLicenseLimit = (v) => (v === null || v === undefined ? "unlimited" : escapeHtml(String(v)));
const fmtLicenseTime = (v) => (v ? escapeHtml(new Date(v).toLocaleString()) : "—");

function paintLicense(l) {
  document.getElementById("license-state-chip").textContent = LICENSE_STATE_LABEL[l.state] || `· ${l.state}`;
  const instructions = document.getElementById("set-agents-instructions");
  instructions.readOnly = l.features?.organizationInstructions !== true;
  document.getElementById("organization-instructions-entitlement").textContent = instructions.readOnly
    ? "Enterprise is required to add or edit organization instructions. Saved instructions remain active; you can clear them explicitly. Channel instructions and core safety rules remain available."
    : "Organization defaults follow the existing channel and Lean-mode rules. Saved instructions remain active if the license is downgraded.";
  document.getElementById("clear-organization-instructions").onclick = () => { instructions.value = ""; instructions.dispatchEvent(new Event("input", { bubbles: true })); };
  document.getElementById("set-composio-mode").dataset.sdkEntitled = String(l.features?.composioSdk === true);
  document.querySelector('#set-composio-mode option[value="sdk"]').disabled = l.features?.composioSdk !== true;
  document.getElementById("set-composio-sdk-key").disabled = l.features?.composioSdk !== true;
  syncComposioModeUi();
  document.querySelectorAll('[id^="set-drivesync-"]').forEach((control) => {
    if ("disabled" in control) { control.disabled = l.features?.driveSync !== true; control.title = control.disabled ? "Google Drive sync requires Enterprise" : ""; }
  });
  const domainToggle = document.getElementById("user-auto-approval-enabled");
  if (domainToggle && !domainToggle.checked) domainToggle.disabled = l.features?.companyDomainApproval !== true;

  const banner = document.getElementById("license-banner");
  banner.className = `license-banner ${l.banner?.level || ""}`.trim();
  banner.textContent = l.banner?.text || "";
  banner.hidden = !l.banner;

  // Everything here comes from the licensing platform's response. The key fields are already
  // escaped below; the free-text ones must be too, because this list is rendered as HTML.
  const facts = [
    ["Tier", l.tier === "none" ? "no key" : escapeHtml(l.tier)],
    ["Organization", escapeHtml(l.organization || "—")],
    ["Key", l.hasLicenseKey ? `…${escapeHtml(l.licenseKeyLast4)} (from ${escapeHtml(l.licenseKeySource)})` : "none"],
    ["Registered channels", fmtLicenseLimit(l.limits?.channels)],
    ["Registered users", fmtLicenseLimit(l.limits?.users)],
    ["Conversation threads / channel / month", l.limits?.conversationsPerChannelPerMonth === undefined ? "not reported" : fmtLicenseLimit(l.limits.conversationsPerChannelPerMonth)],
    ["AI messages / channel / month", fmtLicenseLimit(l.limits?.messagesPerConversationPerMonth)],
    ["Last verified", fmtLicenseTime(l.verifiedAt)],
    ["Next check", fmtLicenseTime(l.nextCheckAt)],
    ["Expires", l.expiresAt ? fmtLicenseTime(l.expiresAt) : "—"],
    ["Installation id", `<code>${escapeHtml(l.installationId || "")}</code>`],
    ["Platform", `<code>${escapeHtml(l.platformUrl || "")}</code>`],
  ];
  if (l.tier !== "free" && l.limits?.conversations !== null) facts.push(["Active channels / month", fmtLicenseLimit(l.limits?.conversations)]);
  if (l.placeholderPublicKey) facts.push(["Signing key", "PLACEHOLDER — this build cannot verify a production key"]);
  document.getElementById("license-facts").innerHTML = facts
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`)
    .join("");

  const usage = l.usage || { conversations: [], runs: 0, month: "" };
  document.getElementById("license-usage-month").textContent = usage.month ? `· ${usage.month} (UTC)` : "";
  const cap = l.limits?.messagesPerConversationPerMonth ?? null;
  const rows = usage.conversations || [];
  const host = document.getElementById("license-usage");
  if (!rows.length) {
    host.innerHTML = `<p class="license-usage-empty">No AI messages yet this month.</p>`;
    return;
  }
  // The bar is scaled to the CAP when there is one, so "how close am I?" is readable at a glance
  // instead of every conversation filling the track relative to the busiest one.
  const max = cap === null ? Math.max(1, ...rows.map((r) => r.runs)) : cap;
  const limitLine = cap === null
    ? `Unlimited AI messages per channel on this tier — bars are relative to the busiest channel.`
    : `Limit: ${cap} AI messages per channel this month. A channel is warned once at 80% and refused at the limit.`;
  host.innerHTML =
    `<p class="license-usage-limit">${escapeHtml(limitLine)}</p>` +
    rows.map((r) => {
      const pct = Math.max(2, Math.min(100, (r.runs / max) * 100));
      const ratio = cap === null ? 0 : r.runs / cap;
      const tone = ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "";
      const name = `${r.conversationId} · ${r.activeConversations ?? 0} active threads` + (r.admitted ? "" : " (not in this month's allowed set)");
      return `<div class="bar-row">
        <span class="bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="bar-track"><span class="bar-fill ${tone}" style="width:${pct}%${tone ? "" : ";background:var(--orange)"}"></span></span>
        <span class="bar-val">${r.runs}${cap === null ? "" : ` / ${cap}`}</span>
      </div>`;
    }).join("");
}

// Collect a per-model rates table into the settings PUT shape. Both tables carry their field names
// in `data-f`, so one reader covers the Codex and Claude tables and neither can drift from the
// other's column set.
function readRatesTable(tableId) {
  const out = {};
  for (const tr of document.querySelectorAll(`#${tableId} tbody tr[data-model]`)) {
    const r = {};
    for (const inp of tr.querySelectorAll("input[data-f]")) r[inp.dataset.f] = Number(inp.value || 0);
    out[tr.dataset.model] = r;
  }
  return out;
}
const readCodexRates = () => readRatesTable("codex-rates");
const readClaudeRates = () => readRatesTable("claude-rates");

function bindSettings() {
  // "Verify now": one bounded round trip to the platform. It is allowed to be slow (the platform
  // may be down) but it always says what happened — a silent button is the failure mode this
  // whole card exists to avoid.
  const verifyBtn = document.getElementById("license-verify");
  const verifyMsg = document.getElementById("license-verify-msg");
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    verifyMsg.textContent = "Checking with the ChannelGate platform…";
    try {
      const result = await api("/api/license/verify", { method: "POST" });
      verifyMsg.textContent = result.outcome === "verified"
        ? "Verified."
        : `Check finished: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`;
      paintLicense({ ...result, usage: (await api("/api/license")).usage });
    } catch (error) {
      verifyMsg.textContent = `Couldn't verify: ${error.message}`;
    } finally {
      verifyBtn.disabled = false;
    }
  });
  for (const id of ["clear-composio-sdk-key", "clear-admin-user", "clear-license-key", "clear-gchat-key", "clear-teams-secret", "clear-container-claude-token", "clear-perplexity-session-token", "clear-gemini-api-key"]) {
    const btn = document.getElementById(id);
    // The button lives inside the field's <label>; preventDefault stops the click from
    // bubbling to the label and focusing the token input.
    btn.addEventListener("click", (e) => { e.preventDefault(); toggleClearTok(btn); });
  }
  document.getElementById("set-composio-mode").addEventListener("change", syncComposioModeUi);
  document.getElementById("composio-sdk-policy").addEventListener("change", syncComposioModeUi);

  // Connect / disconnect a chat platform without restarting the daemon — the same live-reconnect
  // affordance Slack has had, for the platforms whose credentials live on this page.
  for (const [platform, banner] of [["googlechat", "gchat-status"], ["msteams", "teams-status"]]) {
    for (const action of ["connect", "disconnect"]) {
      const btn = document.getElementById(`${platform === "googlechat" ? "gchat" : "teams"}-${action}`);
      if (!btn) continue;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        btn.disabled = true;
        const el = document.getElementById(banner);
        el.className = "status-banner";
        el.textContent = action === "connect" ? "○ Connecting…" : "○ Disconnecting…";
        updateConnectionSummary(el, { status: action === "connect" ? "connecting" : "disconnecting" });
        try {
          const res = await api(`/api/platforms/${platform}/${action}`, { method: "POST" });
          renderPlatformStatus(banner, { connection: res.connection });
        } catch (error) {
          el.className = "status-banner bad";
          el.textContent = `● ${error.message}`;
          updateConnectionSummary(el, { status: "error" });
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  document.getElementById("reset-channel-runtime").addEventListener("click", async () => {
    const saved = document.getElementById("reset-channel-runtime-saved");
    // Two scopes, because clearing channel meta alone only changes what NEW threads inherit: a
    // thread pinned by hand (/model → "just this thread", or a claude/codex directive) keeps its
    // own harness and model until that per-thread pin is cleared too.
    const choice = await confirmDialog({
      title: "Reset every channel to gateway defaults?",
      body: "Every channel's engine, model and effort overrides will be cleared. \"Channels only\" changes what new threads inherit; threads that were pinned by hand (/model → just this thread) keep their pinned harness and model. \"Channels + threads\" also clears those per-thread engine, model and effort pins — existing threads still keep the engine that owns their live session. Access, tools, tokens and DM templates stay unchanged. Save any changed gateway defaults first. This can't be undone.",
      confirmLabel: "Channels only",
      alternativeLabel: "Channels + threads",
      danger: true,
      alternativeDanger: true,
    });
    if (!choice) return;
    const includeThreads = choice === "alternative";
    saved.textContent = "resetting…";
    try {
      const r = await api("/api/channels/reset-runtime", { method: "POST", body: JSON.stringify({ includeThreads }) });
      const threadNote = includeThreads ? ` and ${r.threads} thread pin(s)` : "";
      saved.textContent = `✓ reset ${r.count} channel(s)${threadNote}`;
      await loadConversations();
      await infoDialog({
        title: "Channel runtime reset",
        body: `Reset ${r.count} channel(s)${threadNote} to the gateway engine and model defaults.`
          + (includeThreads ? "" : " Threads pinned with /model keep their own harness and model — re-run this and pick \"Channels + threads\" to clear those too."),
      });
      setTimeout(() => (saved.textContent = ""), 6000);
    } catch (e) {
      saved.textContent = "✗ " + e.message;
    }
  });

  document.getElementById("reset-access").addEventListener("click", async () => {
    const saved = document.getElementById("reset-access-saved");
    const ok = await confirmDialog({
      title: "Reset access on every channel?",
      body: "Who-can-use resets to the org default access policy; who-can-manage resets to org admins only; custom guest & manager lists are cleared. Capability profiles, skills, connectors and tokens are left untouched. This can't be undone.",
      confirmLabel: "Reset all",
      danger: true,
    });
    if (!ok) return;
    saved.textContent = "resetting…";
    try {
      const r = await api("/api/channels/reset-access", { method: "POST", body: JSON.stringify({}) });
      saved.textContent = `✓ reset ${r.count} channel(s)`;
      await loadConversations();
      // Explicit completion confirmation the admin can't miss (the inline note is small + auto-clears).
      await infoDialog({ title: "Access reset", body: `Reset access on ${r.count} channel(s).` });
      setTimeout(() => (saved.textContent = ""), 4000);
    } catch (e) {
      saved.textContent = "✗ " + e.message;
    }
  });

  document.getElementById("reset-nudges").addEventListener("click", async () => {
    const saved = document.getElementById("reset-nudges-saved");
    const on = document.getElementById("set-default-nudges").checked;
    const ok = await confirmDialog({
      title: `Turn no-response reminders ${on ? "ON" : "OFF"} for every user?`,
      body: `Every existing user will be set to the current default (${on ? "on" : "off"}). Personal choices are lost. Save the setting first if you just changed it. This can't be undone.`,
      confirmLabel: on ? "Enable on all" : "Disable on all",
      danger: true,
    });
    if (!ok) return;
    saved.textContent = "applying…";
    try {
      const r = await api("/api/users/reset-nudges", { method: "POST", body: JSON.stringify({}) });
      saved.textContent = `✓ applied to ${r.count} user(s)`;
      await loadUsers();
      await infoDialog({ title: "Reminders applied", body: `Set no-response reminders ${r.nudges ? "on" : "off"} for ${r.count} user(s).` });
      setTimeout(() => (saved.textContent = ""), 4000);
    } catch (e) {
      saved.textContent = "✗ " + e.message;
    }
  });

  document.getElementById("save-settings").addEventListener("click", async () => {
    const saved = document.getElementById("settings-saved");
    saved.textContent = "saving…";
    // Only the fields this admin actually changed. Everything else is left to whatever the daemon
    // holds now — the whole point: an unrelated save must not revert another writer.
    let form;
    try { form = readSettingsForm(); }
    catch (e) { saved.textContent = "✗ " + e.message; return; }
    const patch = diffSettingsPayload(SETTINGS_BASELINE || {}, form);
    // The pool sits beside the license it belongs to: a save that moves the default sends both,
    // or the daemon would clear the pool as it does for a bare engine change.
    if (Object.hasOwn(patch, "engine") && Object.hasOwn(form, "enginePool")) patch.enginePool = form.enginePool;
    // Only (re)connect Slack when a Slack token was actually changed in this save — a normal
    // settings change just persists and takes effect on the next message, no reconnect.
    const slackTokenChanged = !!(form.slackBotToken || form.slackAppToken || form.slackSigningSecret);
    try {
      if (Object.hasOwn(patch, "publicUrl")) {
        const me = await api("/api/auth/me");
        if (!me.bootstrap) await freshAdminAuth();
      }
      const r = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...patch,
          // Echo the version this page was painted from: the server refuses the save (409) if
          // anything wrote settings in the meantime, instead of landing it on a newer state.
          ...(SETTINGS_VERSION ? { settingsVersion: SETTINGS_VERSION } : {}),
          connectSlack: slackTokenChanged,
        }),
      });
      for (const id of ["clear-composio-sdk-key", "clear-admin-user", "clear-license-key", "clear-gchat-key", "clear-teams-secret", "clear-container-claude-token", "clear-perplexity-session-token", "clear-gemini-api-key"]) disarmClearTok(document.getElementById(id));
      for (const card of QWEN_PROVIDER_CARDS) disarmClearTok(card.clearBtn);
      // A saved key kicks off a fresh verification server-side; repaint so the card shows the new
      // state (and the new last4) instead of the pre-save one.
      loadLicense().catch(() => { /* the save itself succeeded — the card refreshes on reload */ });
      saved.textContent = slackTokenChanged ? (r.slack?.connected ? "✓ saved & reconnected" : "✓ saved") : "✓ saved";
      // Paint directly from the representation returned by the write that committed. A second GET
      // is unnecessary and can repaint stale client/cache state over the just-saved boolean.
      paintSettings(r);
      await loadHealth();
    } catch (e) {
      // 409 = somebody wrote settings between this page's load and its Save, so NOTHING was saved.
      // The refusal carries the current representation: repaint from it (the page must stop
      // holding values the daemon no longer has) and name what moved, so the admin can re-apply
      // their change knowing what it would have landed on.
      if (e.status === 409 && e.body) {
        const moved = changedSettingKeys(SETTINGS_SNAPSHOT || {}, e.body, SETTINGS_NON_VALUE_KEYS);
        paintSettings(e.body);
        saved.textContent = `✗ ${e.message}${moved.length ? ` Changed elsewhere: ${moved.join(", ")}.` : ""}`;
        return;
      }
      saved.textContent = "✗ " + e.message;
    }
  });

  document.getElementById("reconnect-slack").addEventListener("click", async () => {
    const saved = document.getElementById("settings-saved");
    try {
      const r = await api("/api/slack/reconnect", { method: "POST" });
      renderSlackStatus(r.slack);
      saved.textContent = r.slack.connected ? "✓ reconnected" : "✗ " + (r.slack.error || "failed");
      await loadHealth();
    } catch (e) {
      saved.textContent = "✗ " + e.message;
    }
  });

  document.getElementById("disconnect-slack").addEventListener("click", async () => {
    const r = await api("/api/slack/disconnect", { method: "POST" });
    renderSlackStatus(r.slack);
    await loadHealth();
  });

  document.getElementById("restart-daemon").addEventListener("click", async () => {
    const choice = await confirmDialog({
      title: "Restart the daemon?",
      body: "Wait until idle allows ongoing work to finish (up to five minutes). Force restart skips the wait and interrupts active turns and jobs; an update in progress may fail.",
      confirmLabel: "Wait until idle",
      alternativeLabel: "Force restart",
      alternativeDanger: true,
    });
    if (!choice) return;
    const force = choice === "alternative";
    const msg = document.getElementById("daemon-msg");
    let before;
    let started;
    try {
      before = await api("/api/health");
      started = await api("/api/daemon/restart", { method: "POST", body: JSON.stringify({ force }) });
    } catch (e) {
      msg.textContent = "✗ " + (e.body?.message || e.message);
      return;
    }
    msg.textContent = force ? "Force restart requested — active work will be interrupted…" : "Checking ongoing work…";
    const deadline = Date.now() + (force ? 0 : Number(started.waitMs || 300_000)) + 60_000;
    const timer = setInterval(async () => {
      try {
        const health = await api("/api/health");
        if (health.instanceId && health.instanceId !== before.instanceId) {
          clearInterval(timer);
          msg.textContent = "✓ back online — reloading…";
          window.location.reload();
          return;
        }
        const status = await api(`/api/daemon/restart/status?id=${encodeURIComponent(started.id)}`);
        if (status.phase === "cancelled") {
          clearInterval(timer);
          msg.textContent = "Restart cancelled — ongoing work is still active.";
          return;
        }
        if (status.phase === "waiting" && status.activity?.total) {
          msg.textContent = `Waiting for ${status.activity.total} active work signal${status.activity.total === 1 ? "" : "s"}…`;
        } else if (status.phase === "restarting") {
          msg.textContent = "Restarting…";
        } else {
          msg.textContent = "Checking ongoing work…";
        }
      } catch {
        msg.textContent = "Restarting…";
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        msg.textContent = "Restart status is still unresolved — reload or check gateway activity.";
      }
    }, 2000);
  });
}

// ── Folder picker (server-side filesystem browser) ─────────────────────────────
let fsTargetInput = null;
let fsCurrentPath = "";

async function fsBrowse(p) {
  const data = await api(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ""}`);
  fsCurrentPath = data.path;
  document.getElementById("fs-current").textContent = data.path;
  const conflict = document.getElementById("fs-conflict");
  const otherAssignments = (Array.isArray(data.assignedConversations) ? data.assignedConversations : [])
    .filter((item) => `${item.isDM || item.type === "im" ? "dm" : "ch"}:${item.channelId}` !== selectedConv);
  if (otherAssignments.length) {
    const names = otherAssignments.map((item) => item.isDM || item.type === "im"
      ? (item.name || item.slug)
      : hashName(item.name || item.slug));
    conflict.textContent = `Already assigned to ${names.join(", ")}. Selecting it links this conversation to the existing folder setup: skills, memory, instructions, mode, network and Drive sync. Harness and model stay independent.`;
    conflict.hidden = false;
  } else {
    conflict.textContent = "";
    conflict.hidden = true;
  }
  document.getElementById("fs-up").disabled = !data.parent;
  document.getElementById("fs-up").dataset.parent = data.parent || "";
  const list = document.getElementById("fs-list");
  list.innerHTML = "";
  // The other allowed roots (Settings → Container runtime) are offered at the primary root.
  for (const root of Array.isArray(data.otherRoots) ? data.otherRoots : []) {
    const row = document.createElement("div");
    row.className = "fs-item";
    row.innerHTML = ICON_FOLDER;
    row.appendChild(document.createTextNode(`${root} (allowed root)`));
    row.addEventListener("click", () => fsBrowse(root));
    list.appendChild(row);
  }
  if (!data.dirs.length && !(data.otherRoots || []).length) {
    list.innerHTML = `<div class="fs-item" style="color:var(--muted);cursor:default">(no sub-folders)</div>`;
  }
  for (const d of data.dirs) {
    const row = document.createElement("div");
    row.className = "fs-item";
    row.innerHTML = ICON_FOLDER;
    row.appendChild(document.createTextNode(d.name));
    row.addEventListener("click", () => fsBrowse(d.path));
    list.appendChild(row);
  }
}

function openFolderPicker(inputEl) {
  fsTargetInput = inputEl;
  document.getElementById("fs-modal").hidden = false;
  fsBrowse(inputEl.value && inputEl.value.startsWith("/") ? inputEl.value : "").catch(() => fsBrowse(""));
}
function closeFolderPicker() {
  document.getElementById("fs-modal").hidden = true;
  fsTargetInput = null;
}

// ── Health ──────────────────────────────────────────────────────────────────────
async function loadHealth() {
  try {
    const h = await api("/api/health");
    const engines = h.engines && typeof h.engines === "object" ? h.engines : { claude: h.claude || {} };
    const firstHealth = !HEALTH_ENGINES;
    HEALTH_ENGINES = engines;
    if (firstHealth) licensesManager?.paint();
    document.getElementById("logout").style.display = h.authEnabled ? "" : "none";
    paintContainerRuntimeHealth(h.containerRuntime);
  } catch {
    paintContainerRuntimeHealth(null);
  }
}

// The read-only status line under the Container runtime card: what the daemon actually found on
// this host, so "I enabled it and nothing happens" is answerable without reading the boot log.
function paintContainerRuntimeHealth(state) {
  const el = document.getElementById("container-runtime-health");
  if (!el) return;
  if (!state) { el.textContent = "Status unavailable — the health endpoint did not answer."; return; }
  const cli = state.cli || {};
  const image = state.image || {};
  const bits = [];
  if (!cli.ok) bits.push(`No usable container CLI — ${cli.reason || "none found"}.`);
  else {
    const who = `${cli.kind || cli.bin || "container CLI"}${cli.version ? ` ${cli.version}` : ""}${cli.rootless ? " (rootless)" : ""}`;
    bits.push(`${who} · ${state.running || 0} channel container${state.running === 1 ? "" : "s"} running.`);
    bits.push(image.present ? `Image ${image.ref} ready.` : `Image ${image.ref || "(unset)"} is not built — ${image.reason || "run npm run build:image on the gateway host"}.`);
  }
  if (image.desiredToolchain || image.toolchain) {
    for (const [name, wanted] of Object.entries(image.desiredToolchain || {})) {
      if (name !== "@openai/codex" && name !== "@anthropic-ai/claude-code") continue;
      bits.push(`${name === "@openai/codex" ? "Codex" : "Claude"}: built ${image.toolchain?.[name] || "unknown"}, desired ${wanted}.`);
    }
    if (image.needsRebuild) bits.push(image.managed ? "Image rebuild required; run Update to retry." : "Custom image needs an operator rebuild.");
    if (state.awaitingImage) bits.push(`${state.awaitingImage} container(s) awaiting the built image; adopted on the next idle start.`);
  }
  if (state.socket && state.socket.listening === false) bits.push("The gateway control socket is not listening — container runs would have no gateway tools.");
  if (state.service?.advice) bits.push(state.service.advice);
  el.textContent = bits.join(" ");
}


// ── Gateway update (sidebar) ─────────────────────────────────────────────────────
// Version chip + one-click transactional update. Health exposes a sanitized durable status, so
// the browser follows its exact transaction through candidate and rollback restarts instead of
// treating any replacement daemon as success.
const UPDATE_PHASES = {
  queued: "queued",
  preflight: "checking host Git, disk, config, service, and daemon health",
  snapshotting: "creating a recovery snapshot",
  checkout: "checking out the candidate",
  installing: "installing exact dependencies",
  auditing: "checking production security advisories",
  testing: "running the regression suite",
  provisioning: "provisioning optional components",
  image: "rebuilding the channel container image",
  restarting: "restarting the gateway",
  verifying: "checking daemon revision, runtime, and Slack reconnect",
  rolling_back: "rolling back to the previous revision",
};

function updateResultHtml(transaction) {
  if (transaction.interrupted) {
    const cause = transaction.candidateError ? ` Candidate error: ${transaction.candidateError}` : "";
    return `<span class="statuschip"><span class="dot warn"></span>${escapeHtml(transaction.reason + cause)}</span>`;
  }
  const revision = transaction.runningRevision
    ? ` <code title="${escapeHtml(transaction.runningRevision)}">${escapeHtml(transaction.runningRevision.slice(0, 7))}</code>`
    : "";
  if (transaction.result === "updated" && transaction.imageWarning) {
    return `<span class="statuschip"><span class="dot warn"></span>container image needs attention — ${escapeHtml(transaction.imageWarning)}</span>`;
  }
  if (transaction.result === "updated" && transaction.changed === false) {
    return `<span class="statuschip"><span class="dot ok"></span>repair complete${revision}; restart verified</span>`;
  }
  if (transaction.result === "updated") {
    return `<span class="statuschip"><span class="dot ok"></span>update complete${revision}; extended checks passed</span>`;
  }
  if (transaction.result === "rolled_back") {
    const detail = transaction.candidateError ? ` — ${escapeHtml(transaction.candidateError)}` : "";
    return `<span class="statuschip" title="${escapeHtml(transaction.reason || "")}"><span class="dot warn"></span>candidate failed; rolled back${revision}${detail}</span>`;
  }
  if (transaction.result === "refused") {
    return `<span class="statuschip" title="${escapeHtml(transaction.reason || "")}"><span class="dot warn"></span>update refused — ${escapeHtml(transaction.reason || "preflight failed")}</span>`;
  }
  const detail = transaction.rollbackError || transaction.candidateError || transaction.reason || "check update.log";
  const failure = transaction.rollbackError ? "update and rollback failed" : "update failed";
  return `<span class="statuschip" title="${escapeHtml(detail)}"><span class="dot warn"></span>${failure} — ${escapeHtml(detail)}</span>`;
}

function renderRunningUpdate(el, transaction) {
  const phase = UPDATE_PHASES[transaction.phase] || transaction.phase || "working";
  const gib = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(1);
  const disk = transaction.requiredDiskBytes
    ? ` · ${gib(transaction.requiredDiskBytes)} GiB required / ${gib(transaction.availableDiskBytes)} GiB free${transaction.optionalDownloadBytes ? " · includes missing 1.5 GiB Whisper model" : ""}`
    : "";
  const elapsed = Math.max(0, Math.floor((Date.now() - (Number(transaction.startedAt) || Date.now())) / 60_000));
  el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Updating · ${escapeHtml(phase + disk)} · ${elapsed} min elapsed${elapsed >= 15 ? " · still monitoring" : ""}</span>`;
}

async function monitorGatewayUpdate(transactionId, el, startedAt = Date.now()) {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`health ${response.status}`);
    const health = await response.json();
    // Restart clears in-memory admin sessions. Public health intentionally omits transaction
    // details; ask for login instead of polling that restricted response forever.
    if (!Object.hasOwn(health, "update")) {
      el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Gateway is reachable. <a href="/login">Sign in again to resume update status</a>; completion is not yet verified.</span>`;
      return;
    }
    const transaction = health.update;
    if (transaction?.id === transactionId) {
      if (transaction.status === "terminal") {
        if (transaction.result === "rolled_back") {
          el.innerHTML = updateResultHtml(transaction);
          return;
        }
        if (transaction.result === "refused") {
          el.innerHTML = updateResultHtml(transaction);
          return;
        }
        if (transaction.result === "failed") {
          el.innerHTML = updateResultHtml(transaction);
          return;
        }
        const expected = transaction.runningRevision || transaction.targetRevision;
        if (expected && health.revision !== expected) {
          renderRunningUpdate(el, { phase: "verifying" });
        } else if (transaction.changed) {
          sessionStorage.setItem("cg-update-result", JSON.stringify(transaction));
          location.reload();
          return;
        } else {
          el.innerHTML = updateResultHtml(transaction);
          return;
        }
      } else {
        renderRunningUpdate(el, transaction);
      }
    } else {
      el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Update status changed or is unavailable; checking again…</span>`;
    }
  } catch {
    el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Waiting for the gateway to reconnect · ${Math.max(0, Math.floor((Date.now() - startedAt) / 60_000))} min elapsed · still monitoring</span>`;
  }
  setTimeout(() => monitorGatewayUpdate(transactionId, el, startedAt), 2_000);
}

async function loadUpdateStatus() {
  const el = document.getElementById("update");
  if (!el) return;
  try {
    const saved = sessionStorage.getItem("cg-update-result");
    if (saved) {
      sessionStorage.removeItem("cg-update-result");
      el.innerHTML = updateResultHtml(JSON.parse(saved));
      return;
    }
    const [u, health] = await Promise.all([api("/api/update/check"), api("/api/health")]);
    const transaction = health.update;
    if (transaction?.status === "running") {
      renderRunningUpdate(el, transaction);
      monitorGatewayUpdate(transaction.id, el, transaction.startedAt || Date.now());
      return;
    }
    const previous = transaction?.status === "terminal" ? updateResultHtml(transaction) : "";
    const cur = previous + (u.current ? `<span class="statuschip" title="gateway version"><span class="dot ok"></span><code>${escapeHtml(u.current)}</code></span>` : "");
    if (u.behind > 0) {
      if (u.automaticUpdates !== true) {
        el.innerHTML = `${cur}<span class="statuschip"><span class="dot warn"></span>${Number(u.behind)} commit${u.behind === 1 ? "" : "s"} behind · update manually on the host. Automatic updates require Enterprise.</span>`;
        return;
      }
      el.innerHTML = `${cur}<button id="update-now" class="ghost update-btn">Update (${u.behind} commit${u.behind === 1 ? "" : "s"} behind)</button>`;
      document.getElementById("update-now").addEventListener("click", runGatewayUpdate);
    } else {
      el.innerHTML = `${cur}<span class="statuschip"><span class="dot ${u.checked ? "ok" : "warn"}"></span>${u.checked ? "up to date" : "update check unavailable — could not reach remote"}</span>`;
      if (u.checked && u.automaticUpdates === true) {
        el.innerHTML += `<button id="update-now" class="ghost update-btn">Repair gateway</button>`;
        document.getElementById("update-now").addEventListener("click", runGatewayUpdate);
      }
    }
  } catch {
    el.innerHTML = ""; // non-admin / locked-down — just hide the chip
  }
}

async function runGatewayUpdate() {
  const ok = await confirmDialog({
    title: "Update or repair the gateway now?",
    body: "It checks the host installation, repairs dependencies and the runtime image, then restarts and verifies the gateway. This can take several minutes; failures trigger rollback.",
    confirmLabel: "Update / Repair",
  });
  if (!ok) return;
  const el = document.getElementById("update");
  let started = null;
  try {
    started = await api("/api/update/run", { method: "POST" });
  } catch (e) {
    el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>update failed: ${escapeHtml(e.message)}</span>`;
    return;
  }
  renderRunningUpdate(el, started.transaction);
  monitorGatewayUpdate(started.transaction.id, el);
}

// Resolve the initial path before async boot work so a refresh paints the requested page without
// flashing Overview. `/` remains a backwards-compatible entry point and is canonicalized.
function redirectMovedSetting() {
  const href = movedSettingsPath(window.location);
  if (href) window.history.replaceState({}, "", href);
}
redirectMovedSetting();
const initialConversationRoute = conversationRouteForPath(window.location.pathname);
const initialView = viewForPath(window.location.pathname) || "dashboard";
setView(initialView, {
  history: initialConversationRoute || window.location.pathname === pathForView(initialView) ? "none" : "replace",
  load: false,
});

async function applyLocation() {
  redirectMovedSetting();
  const conversation = conversationRouteForPath(window.location.pathname);
  const view = viewForPath(window.location.pathname) || "dashboard";
  setView(view, { history: "none" });
  if (view === "channels") await selectConv(conversation?.key || null, { history: "none", canonicalize: true });
}
window.addEventListener("popstate", applyLocation);

// ── Static event wiring (elements always present in the DOM) ─────────────────────
document.getElementById("schedule-history-all").addEventListener("click", () => openScheduleHistory());
document.getElementById("schedule-history-close").addEventListener("click", closeScheduleHistory);
document.getElementById("schedule-history-refresh").addEventListener("click", () => loadScheduleHistory());
document.getElementById("schedule-history-more").addEventListener("click", () => loadScheduleHistory(true));
document.getElementById("schedule-history-modal").addEventListener("click", (event) => {
  if (event.target.id === "schedule-history-modal") closeScheduleHistory();
});

// Settings → Google Drive sync → "Sync all now": one pass over every linked channel, then poll.
document.getElementById("drivesync-sync-all").addEventListener("click", async () => {
  const button = document.getElementById("drivesync-sync-all");
  const result = document.getElementById("drivesync-sync-all-result");
  if (settingsDirty) { result.textContent = "Save your changes first — Sync all now uses the saved settings."; return; }
  button.disabled = true;
  result.textContent = "Starting…";
  try {
    const r = await api("/api/drive-sync/sync-all", { method: "POST", body: "{}" });
    if (!r.ok) { result.textContent = `✗ ${r.error || "sync not started"}`; return; }
    const started = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const s = await api("/api/drive-sync/status");
      const busy = s.sweeping || s.channels.some((c) => c.running);
      if (busy) { result.textContent = `⏳ Syncing ${s.channels.length} channel(s)… ${Math.round((Date.now() - started) / 1000)}s`; continue; }
      const failed = s.channels.filter((c) => c.last && !c.last.ok);
      result.textContent = failed.length
        ? `✗ ${failed.length} of ${s.channels.length} failed: ${failed.map((c) => `${c.name || c.slug} — ${c.last.summary || "unknown error"}`).join("; ")}`
        : `✓ Synced ${s.channels.length} channel(s) at ${new Date().toLocaleTimeString()}.`;
      return;
    }
  } catch (e) {
    result.textContent = "✗ " + e.message;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("schedule-history-modal").hidden && e.key === "Escape") closeScheduleHistory();
});

for (const b of document.querySelectorAll(".nav-item")) {
  b.addEventListener("click", async (e) => {
    // Keep modified clicks native so links can still open in a new tab/window.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (b.dataset.view === "channels") {
      const resumeTemplate = selectedConv?.startsWith("tpl:") && detailDirty && !document.getElementById("view-channels").classList.contains("active");
      if (!(await selectConv(resumeTemplate ? selectedConv : null))) return;
      setView("channels", { history: "none" });
    } else setView(b.dataset.view);
  });
}
// API docs → jump to the token field in Settings.
document.getElementById("channel-search").addEventListener("input", () => renderConvList());
document.getElementById("conv-source").addEventListener("change", (event) => {
  convSource = event.target.value;
  renderConvList();
});
for (const button of document.querySelectorAll("#conv-seg button")) {
  button.addEventListener("click", async () => {
    const filter = button.dataset.seg;
    if (filter === convFilter) return;
    if (filter === "templates") return selectConv("tpl:channel");
    if (convFilter === "templates" && !await selectConv(null)) return;
    convFilter = filter;
    renderConvList();
  });
}

// Guide links can point to a control in another category.
document.getElementById("settings-body").addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#set-"]');
  if (!link || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const target = document.getElementById(link.hash.slice(1));
  if (!target) return;
  event.preventDefault();
  if (target.matches(".setsec")) settingsNavigation.choose(target.dataset.sec);
  else settingsNavigation.reveal(target);
});
document.getElementById("settings-body").addEventListener("change", (event) => {
  if (event.target.matches("input[type=checkbox]")) refreshFeatureCards();
});

// Settings dirty tracking — any input/change in the panes flips the savebar to "Unsaved changes"
// (the savebar and tool filter boxes are exempt — filtering a
// checklist is a view action, not a config change). A successful save re-loads settings, clearing it.
{
  const view = document.getElementById("view-settings");
  const onEdit = (e) => { if (e.target.closest("#settings-body") && !e.target.closest(`.checks-filter, ${SELF_SAVING_CONTROLS}`)) markSettingsDirty(); };
  view.addEventListener("input", onEdit);
  view.addEventListener("change", onEdit);
}

// Chip editors (trusted apps / network domains) — Enter/comma adds a chip, × removes one; both
// sync back into the hidden <input> the save handler reads.
for (const container of document.querySelectorAll("#view-settings .chips[data-chip-for]")) {
  const input = container.querySelector(".chip-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addChipValues(container, input.value); input.value = ""; }
    else if (e.key === "Backspace" && !input.value) {
      const chips = container.querySelectorAll(".c");
      if (chips.length) { chips[chips.length - 1].remove(); serializeChips(container); markSettingsDirty(); }
    }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) { addChipValues(container, input.value); input.value = ""; } });
  container.addEventListener("click", (e) => {
    const x = e.target.closest(".chip-x");
    if (x) { x.closest(".c").remove(); serializeChips(container); markSettingsDirty(); }
    else if (e.target === container) input.focus();
  });
}

document.getElementById("fs-up").addEventListener("click", (e) => {
  const parent = e.currentTarget.dataset.parent;
  if (parent) fsBrowse(parent);
});
document.getElementById("fs-home").addEventListener("click", () => fsBrowse(""));
document.getElementById("fs-cancel").addEventListener("click", closeFolderPicker);
document.getElementById("fs-select").addEventListener("click", () => {
  if (fsTargetInput) {
    fsTargetInput.value = fsCurrentPath;
    // Programmatic set doesn't fire input — dispatch one so dirty-tracking sees the workdir change.
    fsTargetInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  closeFolderPicker();
});
document.getElementById("fs-modal").addEventListener("click", (e) => {
  if (e.target.id === "fs-modal") closeFolderPicker();
});

// "+ Add user" reveals a small inline row (input + Add + Cancel); same PUT as before.
{
  const form = document.getElementById("add-user");
  const idInput = document.getElementById("add-user-id");
  document.getElementById("add-user-toggle").addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) idInput.focus();
  });
  document.getElementById("add-user-cancel").addEventListener("click", () => { idInput.value = ""; form.hidden = true; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = idInput.value.trim();
    if (!id) return;
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: id }) });
    } catch (error) {
      await infoDialog({ title: "Couldn't add user", body: error.message || "The user could not be added. Try again." });
      return;
    }
    idInput.value = "";
    form.hidden = true;
    const search = document.getElementById("users-search");
    if (search) search.value = "";
    userSearchQuery = "";
    document.getElementById("users-search-clear").hidden = true;
    userDrawerId = id; // open the new user's drawer after the refresh
    await loadUsers();
  });
}

// Users search is server-side: debounce keystrokes, keep the full USERS directory untouched for
// access editors, and ignore out-of-order responses when a slower query finishes last.
{
  const search = document.getElementById("users-search");
  const clear = document.getElementById("users-search-clear");
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    userSearchQuery = search.value.trim();
    clear.hidden = !userSearchQuery;
    timer = setTimeout(() => loadUserResults().catch(() => {}), 220);
  };
  search.addEventListener("input", run);
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    search.value = "";
    run();
    search.blur();
  });
  clear.addEventListener("click", () => {
    search.value = "";
    run();
    search.focus();
  });
}

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", headers: { "X-CG-Request": "1" } });
  location.href = "/login.html";
});

document.getElementById("audit-refresh").addEventListener("click", (e) => {
  e.preventDefault();
  loadAudit().catch(() => {});
});

// Activity filters — re-render from the cached fetch (no new API calls); reset pagination each time.
for (const id of ["audit-q", "audit-channel", "audit-user", "audit-engine"]) {
  const el = document.getElementById(id);
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { auditShown = AUDIT_PAGE; renderAuditRows(); });
}

document.getElementById("dash-refresh").addEventListener("click", (e) => {
  e.preventDefault();
  loadDashboard().catch(() => {});
});

document.getElementById("dash-range").addEventListener("change", () => loadDashboard().catch(() => {}));
document.getElementById("dash-harness").addEventListener("change", () => loadDashboard().catch(() => {}));
document.getElementById("dash-source").addEventListener("change", () => loadDashboard().catch(() => {}));

// ── Boot ─────────────────────────────────────────────────────────────────────────
async function init() {
  const identity = await api("/api/auth/me", { cache: "no-store" });
  if (identity.linkRequired || identity.bootstrap) {
    // Existing unlinked passkeys can authenticate, but ordinary admin APIs stay closed until
    // their owner proves the existing gateway identity. Keep that remedy reachable on its own.
    document.querySelector(".app").style.display = "none";
    const gate = document.createElement("main");
    gate.className = "identity-link-gate";
    const card = document.createElement("div");
    card.className = "setcard identity-link-card";
    const title = document.createElement("h2");
    title.textContent = identity.linkRequired ? "Link your gateway admin user" : "Complete dashboard access setup";
    const access = document.getElementById("admin-access");
    card.append(title, access);
    gate.append(card);
    document.body.append(gate);
    await mountAdminAccess(access, { confirm: confirmDialog, onLinked: () => window.location.reload() });
    return;
  }
  await loadHealth();
  startActiveRunsStream();
  loadUpdateStatus().catch(() => {}); // version chip + update button — off the critical path
  bindSettings();
  const { skills, personalSkills = [] } = await api("/api/skills");
  try {
    SKILL_TEMPLATES = (await api("/api/skills/templates")).templates || [];
  } catch {
    SKILL_TEMPLATES = [];
  }
  SKILLS = skills;
  PERSONAL_SKILLS = Array.isArray(personalSkills) ? personalSkills : [];
  await loadSettings();
  await loadUsers(); // populate USERS for the channel user pickers (+ render the Users view)
  await loadConversations(); // default view: render the unified list (light); details render on click
  viewLoaded.channels = true;
  viewLoaded.users = true;
  viewLoaded.settings = true;
  if (initialConversationRoute) await selectConv(initialConversationRoute.key, { history: "none", canonicalize: true });
  loadView(initialView, { refreshIdentity: false });

  // Warm both catalogs off the critical path; every grant editor shows Claude and Codex together.
  for (const engine of ["claude", "codex"]) loadMcpCatalog(engine).catch(() => {});
}
// A failed boot used to end in console.error, so the page just sat on "Loading…" forever and the
// only clue was the devtools console. Paint it instead. The Host/Origin refusal gets its own copy
// because it is the one failure the operator can fix AND the Settings page that fixes it is behind
// the very guard that is refusing — without the loopback escape hatch spelled out, the UI is a
// closed loop.
function showFatalError(error) {
  console.error(error);
  const host = window.location.host;
  const hostGuarded = error?.code === "host_not_allowed";
  const body = hostGuarded
    ? `<p>The gateway refused every API call because it does not recognise the hostname
         <code>${escapeHtml(host)}</code>. This is the DNS-rebinding guard: the daemon only answers
         <code>/api/*</code> for loopback, its bind address, and hostnames you have declared.</p>
       <p><strong>To fix it, open the admin UI on the machine the daemon runs on</strong> — loopback
         is always allowed, so <code>http://localhost:&lt;PORT&gt;</code> (4747 unless you changed
         it) gets you in — then set <strong>Settings → Public URL</strong> to
         <code>${escapeHtml(window.location.origin)}</code> and save. It applies immediately; no
         restart is needed. Setting <code>CG_ALLOWED_HOSTS=${escapeHtml(host)}</code> in
         <code>.env</code> and restarting works too.</p>`
    : `<p>The admin UI could not finish loading.</p>
       <p class="mono">${escapeHtml(error?.message || String(error))}</p>`;
  const panel = document.createElement("div");
  panel.className = "fatal";
  panel.innerHTML = `<div class="fatal-card">
      <h2>${hostGuarded ? "This hostname is not allowed" : "Admin UI failed to load"}</h2>
      ${body}
      <button type="button" class="fatal-retry">Retry</button>
    </div>`;
  panel.querySelector(".fatal-retry").addEventListener("click", () => window.location.reload());
  document.body.appendChild(panel);
}

init().catch(showFatalError);


// ── Skill templates ──────────────────────────────────────────────────────────────
// A conversation follows one template (live) and adds its own skills on top; the templates are
// edited under Skills → Templates. `SKILL_TEMPLATES` is loaded with the skill catalog.
function fillSkillTemplateSelect(select, value, stateEl) {
  if (!select) return;
  select.innerHTML = `<option value="">none</option>${SKILL_TEMPLATES.map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.name)} (${(t.resolved || []).length})</option>`).join("")}`;
  if (value && !SKILL_TEMPLATES.some((t) => t.slug === value)) {
    const missing = document.createElement("option");
    missing.value = value;
    missing.textContent = `${value} (unavailable)`;
    select.add(missing);
  }
  select.value = value;
  const paint = () => {
    const t = SKILL_TEMPLATES.find((x) => x.slug === select.value);
    if (stateEl) stateEl.textContent = t ? `${(t.resolved || []).length} skills included` : "";
  };
  paint();
  select.onchange = paint;
}


// Skills owns template editing. A refreshed catalog updates any mounted template picker without
// firing change events or disturbing a draft in another view.
document.addEventListener("skill-templates-loaded", ({ detail }) => {
  SKILL_TEMPLATES = detail;
  for (const select of document.querySelectorAll(".cfg-skill-template, .ch-skill-template:not(:disabled)")) {
    fillSkillTemplateSelect(select, select.value, select.closest(".field")?.querySelector(".cfg-skill-template-state, .ch-skill-template-state"));
  }
});
