// Admin UI. Talks to the REST API in src/web/routes/admin.js. No framework, no build step.
// Layout: left sidebar nav; Channels & DMs are master–detail (searchable list + the selected
// item's settings), so only ONE item's (heavy) settings DOM is rendered at a time.

import { conversationKindForChannel, conversationRouteForPath, pathForConversation, pathForView, titleForView, viewForPath } from "./admin-routes.js";
import {
  accessGrantSkillOptions,
  captureGrantMcpSelection,
  changedSettingKeys,
  channelGuestAcceptedIds,
  channelGuestSavePatch,
  diffSettingsPayload,
  loadChannelGuestOptions,
  reconcileChannelMeta,
} from "./admin-state.js";
import { activeSectionFor, filterSettings } from "./admin-settings-search.js";
import { api } from "./admin-api.js";
import { attachReveal, confirmDialog, escapeHtml, infoDialog, openDialog, paintReveal, passwordDialog, revealSecret, tokenValue } from "./admin-view.js";
import { loadSkills } from "./admin-skills.js";
import { mountUserPicker } from "./admin-user-picker.js";
import { describeEvent, eventLabel, isAdminEvent } from "./admin-events.js";

// ── Inline SVG icon ─────────────────────────────────────────────────────────────
const ICON_FOLDER = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"/></svg>`;

// ── Reference data / state ──────────────────────────────────────────────────────
let SKILLS = [];
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
// Which harnesses the admin left switched on. A disabled engine must not appear in ANY picker —
// global, per channel, or per DM — so every engine <select> is built from this filter.
let ENGINE_ENABLED = {};
let GLOBAL_COMPOSIO_MODE = "personal";
let orgGrantsEditor = null;
// The Settings page's Save sends a DIFF, so it has to remember what it was painted from:
// SETTINGS_BASELINE is the form read back immediately after that paint (form shape, compared
// against the form at save time) and SETTINGS_SNAPSHOT is the server representation itself (API
// shape, compared against a newer one to name what changed under a refused save). SETTINGS_VERSION
// is echoed on the save so the server can refuse a stale one.
let SETTINGS_BASELINE = null;
let SETTINGS_SNAPSHOT = null;
let SETTINGS_VERSION = "";
// Live parts of the settings payload: they move on their own and are nobody's edit.
const SETTINGS_NON_VALUE_KEYS = ["ok", "stale", "code", "error", "slack", "platforms", "engines", "settingsVersion"];
// Unified Conversations selection key: "ch:<channelId>" (channel) or "dm:<channelId>" (DM). One
// key drives both list highlight + detail. (The User/Admin DM templates live under Settings now.)
let selectedConv = null;
let convFilter = "all"; // segmented control: all | channels | dms
let CONV_COSTS = null; // { byId: {channelId→cost}, bySlug: {slug→cost} }; null until first (soft) fetch
let convCostsFetched = false;
let detailDirty = false; // whether the open conversation detail has unsaved edits (drives the savebar)
// Controls that save through their OWN request are never part of a card's "Unsaved changes" state.
// The per-conversation environment secrets are the case that exists: write-only values stored the
// moment "Save variable" is pressed (they must never round-trip through the card's Save), so typing
// in them — or storing one — must not tell the admin the card has edits waiting.
const SELF_SAVING_CONTROLS = ".channel-env-card";
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
  Object.assign(MODEL_EFFORT_OPTIONS, Object.fromEntries(manifests.map((m) => [m.id, Object.fromEntries(
    (m.models || []).filter((o) => Array.isArray(o.efforts) && o.efforts.length).map((o) => [o.value, o.efforts]),
  )])));
}

function engineIsEnabled(id) {
  return ENGINE_ENABLED[id] !== false;
}

// Enabled harnesses only — but never an EMPTY list: if the map hasn't loaded yet (or somehow
// disables everything) fall back to the full manifest so a picker is never blank.
function selectableEngines() {
  const enabled = ENGINE_MANIFESTS.filter((m) => engineIsEnabled(m.id));
  return enabled.length ? enabled : ENGINE_MANIFESTS;
}

function engineOptionsHtml({ includeDefault = false } = {}) {
  return (includeDefault ? '<option value="">Default (global setting)</option>' : "") +
    selectableEngines().map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join("");
}

function syncEffortOptions({ engineSelect, modelSelect, effortSelect, label, value }) {
  const engine = effectiveEngine(engineSelect?.value || "");
  const modelEfforts = MODEL_EFFORT_OPTIONS[engine]?.[modelSelect?.value || ""];
  const options = modelEfforts?.length
    ? [["", "default"], ...modelEfforts.map((effort) => [effort, effort])]
    : EFFORT_OPTIONS[engine] || EFFORT_OPTIONS.claude;
  const current = value !== undefined ? value : effortSelect.value;
  effortSelect.innerHTML = options.map(([v, text]) => `<option value="${escapeHtml(v)}">${escapeHtml(text)}</option>`).join("");
  effortSelect.value = options.some(([v]) => v === current) ? current : "";
  if (label) label.textContent = `Effort (${ENGINE_MANIFESTS.find((m) => m.id === engine)?.label || engine})`;
}

// Model choices per engine — mirrors the Slack /model wizard's dropdowns. Every value passes the
// server's isValidModel guard; "" = blank (inherit: gateway default, or the CLI default).
const MODEL_OPTIONS = {
  claude: [
    ["best", "Best"],
    ["opus", "Opus"],
    ["opus[1m]", "Opus 1M (1M context)"],
    ["sonnet", "Sonnet"],
    ["sonnet[1m]", "Sonnet 1M (1M context)"],
    ["haiku", "Haiku"],
    ["fable", "Fable"],
    ["opusplan", "Opus plan"],
  ],
  codex: [
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
  return engine === "codex" ? /^(?:gpt-|o[0-9]|codex)/i.test(model) : /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\])$|^claude-/i.test(model);
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
      ? ` · ${["claude", "codex"].includes(String(m.engine || "claude")) ? "approved-domain network" : "network unsupported"}`
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
  admin: "Admins get all tools without approval prompts. Other members get Worker with the selected Auto and Lean options. Confined to the channel folder unless “Admin channels can access the host home” is enabled in Settings → Container runtime. That setting shares the gateway user’s home with all admitted members; it does not grant host root access.",
};
// Per-option descriptions for the two access dropdowns (shown live under each, like the profile help).
const ACCESS_HELP = {
  approved: "Anyone on the org's approved list who is a member of this channel can talk to the bot here. (Default.)",
  admins: "Only gateway admins can talk to the bot in this channel — everyone else is ignored.",
  none: "Locked — nobody can use the bot here until you add them by name in the Users tab (Allowed users).",
};
const MANAGE_HELP = {
  admins: "Only gateway admins can edit the Slack Access page. Other authorized users can edit the ordinary Settings tabs. (Default.)",
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
  return base + ` · ${["claude", "codex"].includes(String(m.engine || "claude")) ? "approved-domain network" : "network unsupported"}`;
}

// ── View switching + URL history ────────────────────────────────────────────────
function loadView(name) {
  if (name === "channels" && !viewLoaded.channels) { viewLoaded.channels = true; loadConversations().catch(() => {}); }
  if (name === "users" && !viewLoaded.users) { viewLoaded.users = true; loadUsers().catch(() => {}); }
  if (name === "settings" && !viewLoaded.settings) { viewLoaded.settings = true; loadSettings().catch(() => {}); }
  if (name === "api" && !viewLoaded.api) { viewLoaded.api = true; loadApiDocs().catch(() => {}); }
  if (name === "skills") loadSkills().catch(() => {}); // always refresh
  if (name === "schedules") loadSchedules().catch(() => {}); // always refresh
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
  if (load) loadView(view);
  if (view === "settings") enterSettingsView(hash);
}

// ── API docs (static reference for the HTTP run API) ────────────────────────────
// The page content is static in index.html; this only fills the live base URL (from the public
// URL setting, else the current origin) and whether a token has been generated. Degrades quietly
// if /api/settings isn't reachable (e.g. session expired) — the reference still reads fine.
function gotoApiTokenSettings() {
  setView("settings");
  if (!viewLoaded.settings) { viewLoaded.settings = true; loadSettings().catch(() => {}); }
  revealSetting("set-apikey");
}

async function loadApiDocs() {
  let base = window.location.origin;
  let hasKey = null;
  try {
    const s = await api("/api/settings");
    if (s.publicUrl) base = String(s.publicUrl).replace(/\/+$/, "");
    hasKey = Boolean(s.hasApiKey);
  } catch {
    /* not logged in / offline — the reference is static, so just keep the origin fallback */
  }
  for (const el of document.querySelectorAll("#view-api .apidoc-base")) el.textContent = base;
  const note = document.getElementById("apidoc-token-note");
  if (note) {
    note.textContent =
      hasKey === true
        ? "A token is set. Reveal, copy, or regenerate it under Settings → HTTP run API."
        : hasKey === false
        ? "No token generated yet — create one under Settings → HTTP run API."
        : "Generate one under Settings → HTTP run API.";
    note.classList.toggle("apidoc-note-warn", hasKey === false);
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
    const eng = (r.engine || "?") + (r.taskKind && r.taskKind !== "interactive" ? " · " + r.taskKind : "");
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
  const engine = (r.engine || "?") + (r.model ? " · " + r.model : "");
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
  fillAuditSelect(document.getElementById("audit-engine"), [...engineSet].sort().map((e) => [e, e]), "All engines");

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

// Single-metric horizontal bar list, descending. Row: name · bar (width ∝ value) · value.
function barList(items, valueOf, fmt, color, empty) {
  if (!items.length) return `<p class="hint" style="margin:6px 0 0">${empty}</p>`;
  const max = Math.max(1, ...items.map(valueOf));
  return items.map((it) => {
    const pct = Math.max(2, (valueOf(it) / max) * 100);
    return `<div class="bar-row">
      <span class="bar-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="bar-val">${fmt(it)}</span>
    </div>`;
  }).join("");
}

// Per-channel bars: sessions (blue) over cost (gold) over tokens (teal), each normalized to its own max.
function channelBars(items) {
  if (!items.length) return `<p class="hint" style="margin:6px 0 0">No channel activity yet.</p>`;
  const maxRuns = Math.max(1, ...items.map((c) => c.runs));
  const maxCost = Math.max(1e-6, ...items.map((c) => c.cost || 0));
  const maxTokens = Math.max(1, ...items.map((c) => c.tokens || 0));
  return items.map((c) => {
    const rp = Math.max(2, (c.runs / maxRuns) * 100);
    const cp = Math.max(2, ((c.cost || 0) / maxCost) * 100);
    const tp = Math.max(2, ((c.tokens || 0) / maxTokens) * 100);
    return `<div class="bar-row bar-row-dual">
      <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
      <span class="bar-dual">
        <span class="bar-track"><span class="bar-fill" style="width:${rp}%;background:#91c9ce"></span></span>
        <span class="bar-track"><span class="bar-fill" style="width:${cp}%;background:var(--orange)"></span></span>
        <span class="bar-track"><span class="bar-fill" style="width:${tp}%;background:#317b80"></span></span>
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
let ACTIVE_RUNS = []; // live in-flight turns, for the "Active sessions" KPI + its modal
let activeRunsVersion = 0;
let activeRunsLive = false;
let activeRunsSource = null;
let activeModalTimer = null;

function dashboardActiveRuns() {
  return dashHarness === "all"
    ? ACTIVE_RUNS
    : ACTIVE_RUNS.filter((run) => String(run.engine || run.engineName || "").toLowerCase() === dashHarness);
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
  if (rangeSel) dashRange = rangeSel.value;
  if (harnessSel) dashHarness = harnessSel.value;
  let d;
  try {
    d = await api(`/api/dashboard?range=${encodeURIComponent(dashRange)}&harness=${encodeURIComponent(dashHarness)}`);
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
  const kpis = [
    { label: "Token Est Cost", value: fmtUSD(t.cost), cls: "cost", sub: multiDay ? `≈ ${fmtUSD(t.cost / spanDays)}/day · ${pricingCoverage}` : pricingCoverage, view: "audit" },
    { label: "Claude Cost", value: fmtUSD(t.claudeCost), cls: "cost", sub: "provider-reported", view: "audit" },
    { label: "Codex Cost", value: fmtUSD(t.codexCost), cls: "cost", sub: "Standard API estimate", view: "audit" },
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

  // Token cost is the hero (2fr wide, gridlines, peak dated). Runs + tokens ride at 1fr but share the
  // hero's chart height so all three axis labels line up along the same bottom edge.
  const costPeak = peakBucket((x) => x.cost);
  const costPeakLabel = costPeak && costPeak.cost > 0
    ? `peak ${fmtUSD(costPeak.cost)}${costPeak.key ? " · " + bucketLabel(costPeak.key, unit) : ""}`
    : "no value yet";
  const charts = [
    chartCard(`Token est. cost per ${per}`, series.map((x) => x.cost), "var(--orange)", costPeakLabel, axis, { height: 110, grid: true, tall: true }),
    chartCard("Runs", series.map((x) => x.runs), "#91c9ce", `peak ${peakOf((x) => x.runs, fmtNum)}`, axis, { height: 110, tall: true }),
    chartCard("Tokens", series.map((x) => x.tokens), "#317b80", `peak ${peakOf((x) => x.tokens, fmtCompact)}`, axis, { height: 110, tall: true }),
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

  body.innerHTML = `
    <div class="kpi-row">${kpiHtml}</div>
    <div id="dash-approvals"></div>
    <div class="dash-grid">${charts}</div>
    <div class="dash-two">
      <div class="chart-card">
        <div class="chart-title"><h3>Runs per user</h3><span class="chart-peak">${users.length} of ${fmtNum(t.users)}</span></div>
        ${barList(users, (u) => u.runs, (u) => `<span>${fmtNum(u.runs)} runs</span><span>${fmtCompact(u.tokens)} tokens</span><span>${fmtUSD(u.cost)} est.</span>`, "#91c9ce", "No user activity yet.")}
        ${moreUsers > 0 ? `<p class="hint" style="margin:8px 0 0">+ ${moreUsers} more</p>` : ""}
      </div>
      <div class="chart-card">
        <div class="chart-title"><h3>Channels — runs, token cost &amp; tokens</h3>
          <span class="legend"><span><span class="dot" style="background:#91c9ce"></span>runs</span><span><span class="dot" style="background:var(--orange)"></span>token cost</span><span><span class="dot" style="background:#317b80"></span>tokens</span></span>
        </div>
        ${channelBars(channels)}
        ${moreChannels > 0 ? `<p class="hint" style="margin:8px 0 0">+ ${moreChannels} more</p>` : ""}
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

  // KPI cards drill in — a view card switches views; the "active" card opens the live-sessions
  // modal. Click or keyboard (Enter/Space).
  for (const el of body.querySelectorAll(".kpi-link")) {
    const go = () => { if (el.dataset.action === "active") openActiveSessions(); else if (el.dataset.goto) setView(el.dataset.goto); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
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
  if (key?.startsWith("dm:")) return pathForConversation("dm", key.slice(3));
  if (key?.startsWith("ch:")) {
    const channelId = key.slice(3);
    const ch = CHANNELS.find((item) => item.channelId === channelId);
    return pathForConversation(conversationKindForChannel(ch), channelId);
  }
  return pathForView("channels");
}

function conversationExists(key) {
  if (key?.startsWith("dm:")) return DMS.some((d) => d.channelId === key.slice(3));
  if (key?.startsWith("ch:")) return CHANNELS.some((c) => c.channelId === key.slice(3));
  return false;
}

function convRow(key, color, name, sub, cost) {
  const el = document.createElement("a");
  el.className = "list-item conv-item" + (selectedConv === key ? " active" : "");
  el.href = conversationPathForKey(key);
  // Compact whole-dollar 30-day cost (skip sub-$1 rows so the list stays quiet).
  const dollars = cost == null ? null : Math.round(cost);
  const costHtml = dollars && dollars >= 1 ? `<span class="conv-cost">$${escapeHtml(dollars.toLocaleString())}</span>` : "";
  el.innerHTML =
    `<span class="capdot" style="background:${color}"></span>` +
    `<span class="conv-nm"><b>${escapeHtml(name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span>` +
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

  // The User/Admin DM templates live under Settings → Access Templates (not this list). DM rows below
  // still borrow their template's capdot via DM_TEMPLATES.

  // Channels — sorted by name; capdot + profile label (+ network) sub-line; 30-day cost if known.
  if (showChannels) {
    const chans = CHANNELS
      .filter((c) => !f || (c.name || "").toLowerCase().includes(f) || (c.slug || "").toLowerCase().includes(f))
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
      for (const c of chans) list.appendChild(convRow("ch:" + c.channelId, capColorOf(c.meta || {}), hashName(c.name || c.slug), capLabelOf(c.meta || {}), costFor(c.channelId, c.slug)));
    }
  }

  // Direct messages — capdot by the DM's effective capability; sub-line = template name.
  if (showDms) {
    const dmItems = DMS
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
        list.appendChild(convRow("dm:" + d.channelId, capColorOf(capMeta), d.userName || d.slug, tplName, costFor(d.channelId, d.slug)));
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
  selectedConv = key;
  detailDirty = false;
  renderConvList();
  if (key) openDetail(key);
  else {
    document.getElementById("channel-detail").innerHTML =
      `<p class="empty-detail">Select a conversation on the left to edit its settings.<br /><span class="hint">New channels appear once the bot has seen a message in them, and start <strong>fail-closed</strong>. DMs appear after the person messages the bot.</span></p>`;
  }

  const path = conversationPathForKey(key);
  const state = { view: "channels", conversation: key };
  if (history === "replace" || (canonicalize && window.location.pathname !== path)) window.history.replaceState(state, "", path);
  else if (history === "push" && window.location.pathname !== path) window.history.pushState(state, "", path);
  return !requestedKey || Boolean(key);
}

function openDetail(key) {
  if (!key) return;
  if (key.startsWith("ch:")) {
    const ch = CHANNELS.find((c) => c.channelId === key.slice(3));
    if (ch) renderChannelDetail(ch);
  } else if (key.startsWith("dm:")) {
    renderDmDetail(key.slice(3));
  }
}

// ── Shared checklist helpers (MCP list, filter box, "N of M enabled" count) ───────
function effectiveMcpEngine(value) {
  const engine = effectiveEngine(value);
  const manifest = ENGINE_MANIFESTS.find((entry) => entry.id === engine);
  return manifest?.supports?.mcp === false ? "" : engine;
}

function mcpEntryId(entry) {
  return String(entry?.id || entry?.name || "");
}

function mcpBoxState(box) {
  try {
    const parsed = JSON.parse(box.dataset.mcpSelections || "{}");
    return {
      claude: Array.isArray(parsed.claude) ? parsed.claude.map(String) : [],
      codex: Array.isArray(parsed.codex) ? parsed.codex.map(String) : [],
    };
  } catch {
    return { claude: [], codex: [] };
  }
}

function initializeMcpBox(box, { claude = [], codex = [] } = {}) {
  box.dataset.kind = "m";
  box.dataset.mcpSelections = JSON.stringify({
    claude: claude.map(mcpEntryId).filter(Boolean),
    codex: codex.map(mcpEntryId).filter(Boolean),
  });
  // Preserve already-saved objects when discovery is unavailable/offline so an unrelated Save
  // round-trips them instead of silently erasing access.
  box._mcpOriginals = { claude: [...claude], codex: [...codex] };
}

function captureMcpSelection(box) {
  if (box.dataset.engine === "both") {
    const state = mcpBoxState(box);
    for (const engine of ["claude", "codex"]) {
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
  const catalog = AVAILABLE_MCPS[engine] || [];
  const state = mcpBoxState(box);
  const wanted = new Set(state[engine]);
  const merged = [...catalog];
  const known = new Set(merged.map(mcpEntryId));
  for (const original of box._mcpOriginals?.[engine] || []) {
    const id = mcpEntryId(original);
    if (!id || !wanted.has(id) || known.has(id)) continue;
    merged.push({ ...original, connected: false });
    known.add(id);
  }
  return merged;
}

function paintMcpBox(box, engine) {
  const selected = mcpBoxState(box)[engine];
  const entries = catalogWithSavedEntries(box, engine);
  box.classList.remove("empty");
  const items = entries.map((s) => s.connected
    ? { value: mcpEntryId(s), label: s.name }
    : { value: mcpEntryId(s), labelHtml: `${escapeHtml(s.name)} <span class="off-badge">offline</span>` });
  checkboxList(box, items, selected, "value", "label");
}

function paintAllMcpBoxes(box) {
  box.replaceChildren();
  box.classList.remove("empty");
  for (const engine of ["claude", "codex"]) {
    const section = document.createElement("section");
    section.className = "mcp-engine-group";
    section.innerHTML = `<h5>${engine === "claude" ? "Claude" : "Codex"}</h5>`;
    const list = document.createElement("div");
    const selected = mcpBoxState(box)[engine];
    const items = catalogWithSavedEntries(box, engine).map((entry) => entry.connected
      ? { value: mcpEntryId(entry), label: entry.name }
      : { value: mcpEntryId(entry), labelHtml: `${escapeHtml(entry.name)} <span class="off-badge">offline</span>` });
    checkboxList(list, items, selected, "value", "label");
    for (const input of list.querySelectorAll('input[type="checkbox"]')) input.dataset.mcpEngine = engine;
    section.appendChild(list);
    box.appendChild(section);
  }
}

async function loadMcpCatalog(engine) {
  if (Array.isArray(AVAILABLE_MCPS[engine])) return AVAILABLE_MCPS[engine];
  if (!MCP_CATALOG_LOADS[engine]) {
    MCP_CATALOG_LOADS[engine] = api(`/api/mcp/available?engine=${encodeURIComponent(engine)}`)
      .then((result) => {
        AVAILABLE_MCPS[engine] = Array.isArray(result.servers) ? result.servers : [];
        return AVAILABLE_MCPS[engine];
      })
      .finally(() => {
        delete MCP_CATALOG_LOADS[engine];
      });
  }
  return MCP_CATALOG_LOADS[engine];
}

async function renderMcpBoxForEngine(box, engineValue, countEl) {
  captureMcpSelection(box);
  box.dataset.engine = "both";
  const missing = ["claude", "codex"].filter((engine) => !Array.isArray(AVAILABLE_MCPS[engine]));
  if (missing.length) {
    box.dataset.mcpLoading = "both";
    box.classList.add("empty");
    box.textContent = "loading Claude and Codex MCP lists…";
    updateChecksCount(box, countEl);
    await Promise.all(missing.map(async (engine) => {
      try { await loadMcpCatalog(engine); } catch { AVAILABLE_MCPS[engine] = []; }
    }));
    if (!box.isConnected) return;
  }
  delete box.dataset.mcpLoading;
  paintAllMcpBoxes(box);
  updateChecksCount(box, countEl);
}

function selectedMcpEntries(box, engine) {
  captureMcpSelection(box);
  const selected = mcpBoxState(box)[engine];
  const available = catalogWithSavedEntries(box, engine);
  return selected.map((id) => available.find((entry) => mcpEntryId(entry) === id)).filter(Boolean);
}

function wireGrantTierNavigation(select, currentTier) {
  if (!select) return;
  select.value = currentTier;
  select.onchange = (event) => {
    // This selector navigates between grant scopes; it does not mutate a grant by itself.
    event.stopPropagation();
    const next = select.value;
    if (next === "organization") {
      setView("settings");
      selectSettingsSection("access");
    } else if (next === "channel") {
      setView("channels");
    } else if (next === "user") {
      setView("users");
    }
    select.value = currentTier;
  };
}

// Skills/connectors share one editor at each tier. Its MCP state keeps independent Claude/Codex
// selections while the engine dropdown switches the visible catalog; OpenCode deliberately has
// no MCP editor because its restricted proof profile rejects that capability.
function buildAccessGrantsEditor(cfg = {}, { tier = "organization" } = {}) {
  const el = document.createElement("div");
  el.className = "access-grants-editor";
  el.innerHTML = `
    <div class="grid grid-2">
      <label class="field"><span>Connector engine</span><select class="grant-engine"></select></label>
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
  engineSelect.innerHTML = selectableEngines()
    .filter((m) => m.id !== "opencode")
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`)
    .join("");
  engineSelect.value = effectiveMcpEngine(GLOBAL_ENGINE) || "claude";
  const mcpsBox = el.querySelector(".grant-mcps");
  const mcpsCount = el.querySelector(".grant-mcps-count");
  initializeMcpBox(mcpsBox, {
    claude: cfg.allowedMcps || [],
    codex: cfg.allowedCodexMcps || [],
  });
  const skillsBox = el.querySelector(".grant-skills");
  skillsBox.dataset.kind = "s";
  checkboxList(skillsBox, accessGrantSkillOptions(SKILLS, cfg.skills || []), cfg.skills || []);
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
      allowedOpenCodeMcps: [],
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

function renderChannelDetail(ch) {
  const detail = document.getElementById("channel-detail");
  detailDirty = false;
  const meta = ch.meta || { allowedUsers: [], allowedMcps: [], skills: [], adminMode: false };
  const node = document.getElementById("channel-card").content.cloneNode(true);
  const card = node.querySelector(".conv-detail");
  card.querySelector(".ch-name").textContent = hashName(ch.name || ch.slug);
  card.querySelector(".ch-type").textContent = ch.type + (ch.isDM ? " · DM" : "");
  card.querySelector(".ch-slug").textContent = ch.slug;

  // Header capability pill — colored by the live mode; kept in sync as flags change.
  const modePill = card.querySelector(".ch-mode");
  const paintModePill = (m) => { modePill.textContent = capLabelOf(m); modePill.setAttribute("style", capPillStyle(m)); };
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
    if (e.target.closest(`[data-pane="instructions"], [data-pane="memory"], .detail-savebar, .checks-filter, ${SELF_SAVING_CONTROLS}`)) return;
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
  skillsBox.dataset.kind = "s";
  initializeMcpBox(mcpsBox, {
    claude: meta.allowedMcps || [],
    codex: meta.allowedCodexMcps || [],
  });
  checkboxList(skillsBox, accessGrantSkillOptions(SKILLS, meta.skills || []), meta.skills || []);
  wireChecksTools(mcpsBox, card.querySelector(".ch-mcps-filter"), mcpsCount);
  mcpsBox.addEventListener("change", () => captureMcpSelection(mcpsBox));
  wireChecksTools(skillsBox, card.querySelector(".ch-skills-filter"), card.querySelector(".ch-skills-count"));
  fillSkillTemplateSelect(card.querySelector(".ch-skill-template"), meta.skillTemplate || "", card.querySelector(".ch-skill-template-state"));

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
  manageSel.value = ["admins", "members"].includes(meta.manageAccess) ? meta.manageAccess : "admins";
  const applyManageUI = () => { manageHelp.textContent = MANAGE_HELP[manageSel.value] || ""; };
  applyManageUI();
  manageSel.addEventListener("change", applyManageUI);

  card.querySelector(".ch-memory").checked = meta.memory !== false; // default on (global default is on)
  card.querySelector(".ch-nudges").checked = !!meta.nudges;
  card.querySelector(".ch-nodefaulttokens").checked = !!meta.noDefaultTokens;
  const workdirInput = card.querySelector(".ch-workdir");
  workdirInput.value = meta.workDir || "";
  card.querySelector(".ch-browse").addEventListener("click", () => openFolderPicker(workdirInput));
  card.querySelector(".ch-workdir-reset").addEventListener("click", () => {
    if (!workdirInput.value) return;
    workdirInput.value = "";
    // Follow the same pending-edit flow as Browse: Save applies it; Discard restores the path.
    workdirInput.dispatchEvent(new Event("input", { bubbles: true }));
    workdirInput.focus();
  });
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
  const engineSelect = card.querySelector(".ch-engine");
  engineSelect.value = meta.engine || "";
  renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  syncModelOptions({
    engineSelect,
    modelSelect: card.querySelector(".ch-model"),
    value: meta.model || "",
    blankLabel: "gateway default (Settings)",
  });
  syncEffortOptions({
    engineSelect,
    modelSelect: card.querySelector(".ch-model"),
    effortSelect: card.querySelector(".ch-effort"),
    label: card.querySelector(".ch-effort-label"),
    value: meta.effort || "",
  });
  engineSelect.addEventListener("change", () => {
    syncModelOptions({
      engineSelect,
      modelSelect: card.querySelector(".ch-model"),
      blankLabel: "gateway default (Settings)",
    });
    syncEffortOptions({
      engineSelect,
      modelSelect: card.querySelector(".ch-model"),
      effortSelect: card.querySelector(".ch-effort"),
      label: card.querySelector(".ch-effort-label"),
    });
    renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  });
  card.querySelector(".ch-model").addEventListener("change", () => syncEffortOptions({
    engineSelect,
    modelSelect: card.querySelector(".ch-model"),
    effortSelect: card.querySelector(".ch-effort"),
    label: card.querySelector(".ch-effort-label"),
  }));
  card.querySelector(".ch-composio-state").textContent = GLOBAL_COMPOSIO_MODE === "sdk"
    ? (meta.hasComposioToken ? "saved · inactive in SDK mode" : "inactive in SDK mode")
    : (meta.hasComposioToken ? "" : "no token (uses org default)");
  card.querySelector(".ch-toolboxtoken-state").textContent = meta.hasToolboxToken ? "" : "no token (uses each user's own)";
  attachReveal(card.querySelector(".ch-composio"), { has: meta.hasComposioToken, last4: meta.composioTokenLast4, fetch: revealSecret("channel", "composioToken", ch.slug) });
  attachReveal(card.querySelector(".ch-toolboxtoken"), { has: meta.hasToolboxToken, last4: meta.toolboxTokenLast4, fetch: revealSecret("channel", "toolboxToken", ch.slug) });
  card.querySelector(".ch-composio-label").value = meta.composioTokenLabel || "";
  card.querySelector(".ch-toolboxtoken-label").value = meta.toolboxTokenLabel || "";
  // Per-channel environment secrets. These are the ONE part of the channel card that saves
  // immediately rather than on the card's Save button: the card round-trips its fields, and a
  // write-only value must never be a field that round-trips. The list is names + last4 only —
  // there is no reveal endpoint for these, by design (see config/channel-env.js).
  const envList = card.querySelector(".ch-env-list");
  const envState = card.querySelector(".ch-env-state");
  const envHint = card.querySelector(".ch-env-hint");
  const envNameInput = card.querySelector(".ch-env-name");
  const envValueInput = card.querySelector(".ch-env-value");
  const envSaveButton = card.querySelector(".ch-env-save");
  let envVars = Array.isArray(meta.envVars) ? meta.envVars : [];
  const renderEnvVars = () => {
    envState.textContent = envVars.length ? `${envVars.length} set` : "none";
    envList.textContent = "";
    if (envVars.length === 0) {
      const empty = document.createElement("em");
      empty.className = "state";
      empty.textContent = "No variables — runs here use whatever login the gateway host has.";
      envList.appendChild(empty);
      return;
    }
    for (const entry of envVars) {
      const row = document.createElement("div");
      row.className = "ch-env-row";
      const name = document.createElement("code");
      name.textContent = entry.name;
      const mask = document.createElement("em");
      mask.className = "state";
      const trail = [entry.setBy ? `set by ${entry.setBy}` : "", entry.setAt ? new Date(entry.setAt).toISOString().slice(0, 10) : ""].filter(Boolean).join(" · ");
      mask.textContent = `${entry.last4 ? `••••${entry.last4}` : "•••••••"}${trail ? ` · ${trail}` : ""}`
        + (entry.resolvable === false ? ` · ⚠️ provider "${entry.provider}" can't be resolved by this build` : "");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost ch-env-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: `Remove ${entry.name}?`,
          body: "Runs in this channel stop receiving it. The value can't be recovered — you would have to issue a new one.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        remove.disabled = true;
        try {
          const result = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/env/${encodeURIComponent(entry.name)}`, { method: "DELETE" });
          envVars = result.vars || [];
          envHint.textContent = `Removed ${entry.name}.`;
          renderEnvVars();
        } catch (e) {
          remove.disabled = false;
          envHint.textContent = e.message || "Couldn't remove that variable.";
        }
      });
      row.append(name, mask, remove);
      envList.appendChild(row);
    }
  };
  renderEnvVars();
  // Environment variables are UPPER_SNAKE everywhere they are shown, and the store folds case on
  // write — so fold it VISIBLY here too, as the admin types. Typing `supabase_token` and having
  // the row come back as SUPABASE_TOKEN is a surprise; watching it become SUPABASE_TOKEN is not.
  // The caret is restored because assigning .value otherwise jumps it to the end mid-word.
  envNameInput.addEventListener("input", () => {
    const upper = envNameInput.value.toUpperCase();
    if (upper === envNameInput.value) return;
    const { selectionStart, selectionEnd } = envNameInput;
    envNameInput.value = upper; // ASCII case folding is length-preserving, so the caret still fits
    try { envNameInput.setSelectionRange(selectionStart, selectionEnd); } catch { /* selection unsupported here */ }
  });
  envNameInput.addEventListener("blur", () => { envNameInput.value = envNameInput.value.trim().toUpperCase(); });
  envSaveButton.addEventListener("click", async () => {
    const name = envNameInput.value.trim().toUpperCase();
    envNameInput.value = name; // what gets sent is what the admin can see
    const value = envValueInput.value;
    if (!name || !value) {
      envHint.textContent = "Both a name and a value are required.";
      return;
    }
    envSaveButton.disabled = true;
    envHint.textContent = "saving…";
    try {
      const result = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/env/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      envVars = result.vars || [];
      // Clear the value box the moment it is stored: a secret left sitting in a form field is one
      // screen-share away from being read, and there is nothing to re-submit.
      envValueInput.value = "";
      envNameInput.value = "";
      envHint.textContent = `Saved ${name}. It reaches the next run in this channel.`;
      renderEnvVars();
    } catch (e) {
      envHint.textContent = e.message || "Couldn't save that variable.";
    } finally {
      envSaveButton.disabled = false;
    }
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
    const toolboxTok = tokenValue(card.querySelector(".ch-toolboxtoken"));
    const composioLabel = card.querySelector(".ch-composio-label").value;
    const toolboxLabel = card.querySelector(".ch-toolboxtoken-label").value;
    const makeToolboxKey = tokenValue(makeToolboxKeyInput);
    try {
      const result = await api(`/api/channels/${encodeURIComponent(ch.channelId)}/meta`, {
        method: "PUT",
        body: JSON.stringify({
          ...channelGuestSavePatch(usersBox.dataset.ready === "1", explicitCheckedValues(usersBox)),
          allowedMcps: selectedMcpEntries(mcpsBox, "claude")
            .map((s) => ({ name: s.name, match: s.match, namespace: s.namespace })),
          allowedCodexMcps: selectedMcpEntries(mcpsBox, "codex")
            .map((s) => ({ id: s.id, name: s.name, kind: s.kind, serverName: s.serverName, ...(s.toolPrefix ? { toolPrefix: s.toolPrefix } : {}) })),
          skills: checkedValues(card.querySelector(".ch-skills")),
          skillTemplate: card.querySelector(".ch-skill-template").value,
          profile: card.querySelector(".ch-profile").value,
          access: card.querySelector(".ch-access").value,
          manageAccess: card.querySelector(".ch-manage").value,
          adminMode: card.querySelector(".ch-admin").checked,
          allowBash: card.querySelector(".ch-bash").checked,
          allowNetwork: card.querySelector(".ch-network").checked,
          autoMode: card.querySelector(".ch-auto").checked,
          cleanMode: card.querySelector(".ch-clean").checked,
          memory: card.querySelector(".ch-memory").checked,
          nudges: card.querySelector(".ch-nudges").checked,
          noDefaultTokens: card.querySelector(".ch-nodefaulttokens").checked,
          engine: engineSelect.value,
          workDir: card.querySelector(".ch-workdir").value,
          syncDriveFolder: card.querySelector(".ch-syncdrive").value,
          model: card.querySelector(".ch-model").value,
          effort: card.querySelector(".ch-effort").value,
          ...(composioTok ? { composioToken: composioTok } : {}),
          ...(toolboxTok ? { toolboxToken: toolboxTok } : {}),
          // Owner labels always round-trip (empty clears them) — notes, not secrets.
          composioTokenLabel: composioLabel,
          toolboxTokenLabel: toolboxLabel,
          makeToolboxUrl: makeToolboxUrlInput.value,
          ...(makeToolboxKey ? { makeToolboxKey } : {}),
          ...(clearMakeToolbox ? { clearMakeToolbox: true } : {}),
        }),
      });
      // The server response is the validated, committed record. Reconcile the cached channel from
      // that whole record so a later SPA re-render cannot resurrect stale MCP/skill selections.
      ch.meta = reconcileChannelMeta(ch.meta, result.meta);
      const acceptedGuests = channelGuestAcceptedIds(
        usersBox.dataset.ready === "1",
        ch.meta.allowedUsers,
      );
      if (acceptedGuests) {
        const accepted = new Set(acceptedGuests);
        for (const input of usersBox.querySelectorAll('input[type="checkbox"]')) {
          input.checked = accepted.has(input.value);
        }
      }
      makeToolboxUrlInput.value = ch.meta.makeToolboxUrl || "";
      attachReveal(makeToolboxKeyInput, { has: ch.meta.hasMakeToolboxKey, last4: ch.meta.makeToolboxKeyLast4, fetch: revealSecret("channel", "makeToolboxKey", ch.slug) });
      makeToolboxState.textContent = ch.meta.hasMakeToolboxKey ? "saved" : "not configured";
      clearMakeToolbox = false;
      paintModePill(ch.meta);
      renderConvList();
      detailDirty = false;
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
    selectSettingsSection("agent"); // land on Agent defaults (where the global instructions live)
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
  const subtabs = card.querySelectorAll(".subtab");
  const subpanes = card.querySelectorAll(".subpane");
  for (const tab of subtabs) {
    tab.addEventListener("click", () => {
      for (const t of subtabs) t.classList.toggle("active", t === tab);
      for (const p of subpanes) p.classList.toggle("active", p.dataset.pane === tab.dataset.pane);
      if (tab.dataset.pane === "memory") loadMemory();
      if (tab.dataset.pane === "instructions") loadInstructions();
    });
  }

  detail.innerHTML = "";
  detail.appendChild(node);
}

// ── Reusable config editor (Access Templates / custom DM) ────────────────────────
// Uses the SAME capability picker as a channel's Access tab: profile cards (Read-only / Worker /
// Autonomous / Full access / Lean / Custom) drive the hidden flag checkboxes, "Custom" reveals them,
// a network switch, then the Tools (MCP/Skills) and Runtime (engine/model/effort) blocks — so a
// template is configured with the exact same elements as a channel. getValues() returns the flat
// flag shape the template/DM save expects (no `profile` field — it's re-derived from the flags).
function buildConfigEditor(cfg = {}) {
  const el = document.createElement("div");
  el.className = "cfg-editor";
  el.innerHTML = `
<div class="mode-layout">
    <div><p class="fldlab">Mode</p><div class="cap-cards cfg-capcards">
      <button type="button" class="cap-card" data-cap="read"><h5>Read-only</h5><p>Reads files. Changes need approval.</p></button>
      <button type="button" class="cap-card" data-cap="worker"><h5>Worker</h5><p>Runs commands and edits files in this channel’s folder only.</p></button>
      <button type="button" class="cap-card danger" data-cap="admin"><h5>Admin</h5><p>Full tools for admins. Host-home access can be enabled in Settings.</p></button>
    </div></div>
    <div class="mode-options"><p class="fldlab">Special modes</p>
      <label class="togglerow"><input type="checkbox" class="cfg-auto" /><span class="switch"></span><span class="t"><b>Auto</b><small>Automatically approve tool requests for all members. Enables Worker when Read-only is selected.</small></span></label>
      <label class="togglerow"><input type="checkbox" class="cfg-clean" /><span class="switch"></span><span class="t"><b>Lean</b><small>Bare model without skills or connectors. In Admin mode, applies to non-admins.</small></span></label>
    </div>
  </div>
  <select class="cfg-profile" hidden aria-hidden="true"><option value="read">Read-only</option><option value="worker">Worker</option><option value="admin">Admin</option></select>
  <em class="state cfg-profile-help" style="display:block;margin:0 0 16px"></em>
  <input type="checkbox" class="cfg-admin" hidden /><input type="checkbox" class="cfg-bash" hidden />
    <label class="togglerow cfg-network-wrap">
      <input type="checkbox" class="cfg-network" />
      <span class="switch"></span>
      <span class="t"><b>Network egress</b><small><code>git push</code> / <code>gh</code> to the allowed domains — needs Bash, admin-only</small></span>
    </label>

    <p class="fldlab" style="margin-top:20px">Tools</p>
    <div class="grid grid-2">
      <div class="col tools-col">
        <div class="checks-head"><h4>MCP servers</h4><span class="checks-count cfg-mcps-count"></span></div>
        <input type="search" class="checks-filter cfg-mcps-filter" placeholder="Filter servers…" autocomplete="off" />
        <div class="cfg-mcps checks"></div>
      </div>
      <div class="col tools-col">
        <label class="field"><span>Skill template <em class="state">· followed live; skills checked below are added on top</em></span>
          <select class="cfg-skill-template"><option value="">none</option></select>
          <em class="state cfg-skill-template-state"></em></label>
        <div class="checks-head"><h4>Additional skills</h4><span class="checks-count cfg-skills-count"></span></div>
        <input type="search" class="checks-filter cfg-skills-filter" placeholder="Filter skills…" autocomplete="off" />
        <div class="cfg-skills checks"></div>
      </div>
    </div>

    <p class="fldlab" style="margin-top:20px">Runtime</p>
    <div class="grid grid-2">
      <label class="field"><span>Engine (which CLI drives this)</span>
        <select class="cfg-engine"><option value="">Default (global setting)</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
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
  checkboxList(skillsBox, accessGrantSkillOptions(SKILLS, cfg.skills || []), cfg.skills || []);
  wireChecksTools(mcpsBox, el.querySelector(".cfg-mcps-filter"), mcpsCount);
  mcpsBox.addEventListener("change", () => captureMcpSelection(mcpsBox));
  wireChecksTools(skillsBox, el.querySelector(".cfg-skills-filter"), el.querySelector(".cfg-skills-count"));
  fillSkillTemplateSelect(el.querySelector(".cfg-skill-template"), cfg.skillTemplate || "", el.querySelector(".cfg-skill-template-state"));
  const engineSelect = el.querySelector(".cfg-engine");
  engineSelect.innerHTML = engineOptionsHtml({ includeDefault: true });
  engineSelect.value = cfg.engine || "";
  renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  syncModelOptions({
    engineSelect,
    modelSelect: el.querySelector(".cfg-model"),
    value: cfg.model || "",
    blankLabel: "gateway default (Settings)",
  });
  syncEffortOptions({
    engineSelect,
    modelSelect: el.querySelector(".cfg-model"),
    effortSelect: el.querySelector(".cfg-effort"),
    label: el.querySelector(".cfg-effort-label"),
    value: cfg.effort || "",
  });
  engineSelect.addEventListener("change", () => {
    syncModelOptions({
      engineSelect,
      modelSelect: el.querySelector(".cfg-model"),
      blankLabel: "gateway default (Settings)",
    });
    syncEffortOptions({
      engineSelect,
      modelSelect: el.querySelector(".cfg-model"),
      effortSelect: el.querySelector(".cfg-effort"),
      label: el.querySelector(".cfg-effort-label"),
    });
    renderMcpBoxForEngine(mcpsBox, engineSelect.value, mcpsCount);
  });
  el.querySelector(".cfg-model").addEventListener("change", () => syncEffortOptions({
    engineSelect,
    modelSelect: el.querySelector(".cfg-model"),
    effortSelect: el.querySelector(".cfg-effort"),
    label: el.querySelector(".cfg-effort-label"),
  }));

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
  const profHelp = el.querySelector(".cfg-profile-help");
  const capCards = [...el.querySelectorAll(".cap-card")];
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
  const mark = () => {
    if (detailDirty) return;
    detailDirty = true;
    bar.hidden = false;
    msg.textContent = "Unsaved changes";
    msg.classList.remove("clean");
  };
  const onEdit = (e) => { if (!e.target.closest(`.detail-savebar, .checks-filter, ${SELF_SAVING_CONTROLS}`)) mark(); };
  card.addEventListener("input", onEdit);
  card.addEventListener("change", onEdit);
  bar.querySelector(".save-changes").addEventListener("click", async () => {
    try {
      await save();
      detailDirty = false;
      msg.textContent = "Saved";
      msg.classList.add("clean");
      setTimeout(() => { if (!detailDirty) bar.hidden = true; }, 1500);
    } catch (e) {
      msg.textContent = "Couldn't save: " + e.message;
      msg.classList.remove("clean");
    }
  });
  bar.querySelector(".discard").addEventListener("click", discard);
  return mark;
}

// ── Org DM templates (User / Admin) — live under Settings → Access Templates ───────────
// Two buildConfigEditor instances mounted into the settings section; their values fold into the
// page's one global Save (see the save-settings handler). getValues() is read from these refs.
const dmTplEditors = { user: null, admin: null };
let channelTplEditor = null;
function renderChannelTemplateSettings(template) {
  const mount = document.getElementById("tpl-channel-editor");
  if (!mount) return;
  mount.innerHTML = "";
  channelTplEditor = buildConfigEditor(template || {});
  mount.appendChild(channelTplEditor.el);
}
function renderDmTemplateSettings(templates) {
  for (const name of ["user", "admin"]) {
    const mount = document.getElementById(`tpl-${name}-editor`);
    if (!mount) continue;
    mount.innerHTML = "";
    const ed = buildConfigEditor(templates[name] || {});
    mount.appendChild(ed.el);
    dmTplEditors[name] = ed;
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
  tplField.innerHTML = `<span>Template — a preset config, or Custom to hand-configure this DM</span>
    <select class="dm-template"><option value="user">User template</option><option value="admin">Admin template</option><option value="custom">Custom</option></select>`;
  card.appendChild(tplField);
  const tplSel = tplField.querySelector(".dm-template");
  tplSel.value = dm.template;

  const customBox = document.createElement("div");
  customBox.className = "dm-custom";
  card.appendChild(customBox);
  let ed = null;
  const renderCustom = () => {
    customBox.innerHTML = "";
    ed = null;
    if (tplSel.value === "custom") { ed = buildConfigEditor(dm.meta || {}); customBox.appendChild(ed.el); }
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
      const body = { template: tpl, ...(tpl === "custom" && ed ? ed.getValues() : {}) };
      await api(`/api/dms/${encodeURIComponent(dm.channelId)}`, { method: "PUT", body: JSON.stringify(body) });
      dm.template = tpl;
      renderConvList();
    },
    () => renderDmDetail(id),
  );
  detail.innerHTML = "";
  detail.appendChild(card);
}

// ── Schedules ──────────────────────────────────────────────────────────────────
let scheduleEditor = null;
let scheduleRows = [];

function scheduleDetail(label, value) {
  return `<div class="schedule-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></div>`;
}

function scheduleTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseScheduleCron(cron) {
  const [minute, hour, monthDay, month, weekDay] = String(cron || "").trim().split(/\s+/);
  if ([minute, hour, monthDay, month, weekDay].some((part) => part === undefined) || month !== "*") return { frequency: "advanced" };
  if (/^\d+$/.test(minute) && hour === "*" && monthDay === "*" && weekDay === "*") return { frequency: "hourly", minute };
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return { frequency: "advanced" };
  const time = scheduleTime(hour, minute);
  if (monthDay === "*" && weekDay === "*") return { frequency: "daily", time };
  if (monthDay === "*" && weekDay === "1-5") return { frequency: "weekdays", time };
  if (monthDay === "*" && /^[0-6]$/.test(weekDay)) return { frequency: "weekly", day: weekDay, time };
  if (/^\d+$/.test(monthDay) && weekDay === "*") return { frequency: "monthly", monthDay, time };
  return { frequency: "advanced" };
}

function friendlySchedule(schedule) {
  if (schedule.once) return `Once · ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "time unavailable"}`;
  const parsed = parseScheduleCron(schedule.cron);
  const at = parsed.time ? ` at ${parsed.time}` : "";
  if (parsed.frequency === "daily") return `Daily${at}`;
  if (parsed.frequency === "weekdays") return `Weekdays${at}`;
  if (parsed.frequency === "weekly") return `Weekly on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(parsed.day)]}${at}`;
  if (parsed.frequency === "monthly") return `Monthly on day ${Number(parsed.monthDay)}${at}`;
  if (parsed.frequency === "hourly") return `Hourly at :${String(parsed.minute).padStart(2, "0")}`;
  return "Custom schedule";
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function syncScheduleTimingFields() {
  const once = Boolean(scheduleEditor?.schedule.once);
  const frequency = document.getElementById("schedule-frequency").value;
  document.getElementById("schedule-recurring-fields").hidden = once;
  document.getElementById("schedule-once-wrap").hidden = !once;
  document.getElementById("schedule-day-wrap").hidden = once || frequency !== "weekly";
  document.getElementById("schedule-month-day-wrap").hidden = once || frequency !== "monthly";
  document.getElementById("schedule-time-wrap").hidden = once || ["hourly", "advanced"].includes(frequency);
  document.getElementById("schedule-minute-wrap").hidden = once || frequency !== "hourly";
  document.getElementById("schedule-cron-wrap").hidden = once || frequency !== "advanced";
}

function cronFromScheduleEditor() {
  const frequency = document.getElementById("schedule-frequency").value;
  const [hour = "0", minute = "0"] = document.getElementById("schedule-time").value.split(":");
  if (frequency === "daily") return `${Number(minute)} ${Number(hour)} * * *`;
  if (frequency === "weekdays") return `${Number(minute)} ${Number(hour)} * * 1-5`;
  if (frequency === "weekly") return `${Number(minute)} ${Number(hour)} * * ${document.getElementById("schedule-day").value}`;
  if (frequency === "monthly") return `${Number(minute)} ${Number(hour)} ${Number(document.getElementById("schedule-month-day").value)} * *`;
  if (frequency === "hourly") return `${Number(document.getElementById("schedule-minute").value)} * * * *`;
  return document.getElementById("schedule-modal-cron").value.trim();
}

function openScheduleEditor(schedule) {
  const modal = document.getElementById("schedule-modal");
  const prompt = document.getElementById("schedule-modal-prompt");
  const error = document.getElementById("schedule-modal-error");
  const status = schedule.lastRun
    ? `${schedule.lastStatus || "unknown"} · ${new Date(schedule.lastRun).toLocaleString()}`
    : "Never run";
  scheduleEditor = { schedule };
  document.getElementById("schedule-modal-title").textContent = schedule.description || "Automation details";
  document.getElementById("schedule-modal-details").innerHTML = [
    scheduleDetail("Channel", schedule.channelName || schedule.slug || schedule.channelId),
    scheduleDetail("Type", schedule.kind === "reminder" ? "Reminder" : "Task"),
    scheduleDetail("Status", status),
  ].join("");
  document.getElementById("schedule-modal-description").value = schedule.description || "";
  document.getElementById("schedule-modal-enabled").checked = Boolean(schedule.enabled);
  const parsed = parseScheduleCron(schedule.cron);
  document.getElementById("schedule-frequency").value = parsed.frequency;
  document.getElementById("schedule-time").value = parsed.time || "09:00";
  document.getElementById("schedule-day").value = parsed.day || "1";
  document.getElementById("schedule-month-day").value = parsed.monthDay || "1";
  document.getElementById("schedule-minute").value = parsed.minute || "0";
  document.getElementById("schedule-modal-cron").value = schedule.cron || "";
  document.getElementById("schedule-modal-run-at").value = localDateTimeValue(schedule.runAt);
  document.getElementById("schedule-modal-notify").value = schedule.notify || "channel";
  document.getElementById("schedule-modal-notify-user").value = schedule.notifyUserId || "";
  document.getElementById("schedule-modal-notify-user-wrap").hidden = schedule.notify !== "user";
  const deliveryWrap = document.getElementById("schedule-modal-delivery-wrap");
  deliveryWrap.hidden = schedule.kind === "reminder";
  const delivery = document.getElementById("schedule-modal-delivery");
  delivery.value = schedule.delivery || "standard";
  delivery.querySelector('option[value="daily-thread"]').disabled = Boolean(schedule.once);
  prompt.value = schedule.prompt || "";
  syncScheduleTimingFields();
  error.textContent = "";
  error.hidden = true;
  modal.hidden = false;
  prompt.focus();
}

function closeScheduleEditor() {
  document.getElementById("schedule-modal").hidden = true;
  document.getElementById("schedule-modal-error").hidden = true;
  scheduleEditor = null;
}

async function saveScheduleEditor() {
  if (!scheduleEditor) return;
  const input = document.getElementById("schedule-modal-prompt");
  const errorEl = document.getElementById("schedule-modal-error");
  const save = document.getElementById("schedule-modal-save");
  const prompt = input.value;
  if (!prompt.trim()) {
    errorEl.textContent = "Prompt cannot be empty.";
    errorEl.hidden = false;
    input.focus();
    return;
  }

  save.disabled = true;
  save.textContent = "Saving…";
  errorEl.hidden = true;
  try {
    const schedule = scheduleEditor.schedule;
    const body = {
      prompt,
      description: document.getElementById("schedule-modal-description").value.trim(),
      enabled: document.getElementById("schedule-modal-enabled").checked,
      notify: document.getElementById("schedule-modal-notify").value,
      notifyUserId: document.getElementById("schedule-modal-notify-user").value,
    };
    // datetime-local is in the browser's timezone. Send an explicit instant so a daemon in
    // another timezone cannot shift it (or turn a future task into an immediately due one).
    if (schedule.once) body.runAt = new Date(document.getElementById("schedule-modal-run-at").value).toISOString();
    else body.cron = cronFromScheduleEditor();
    if (schedule.kind !== "reminder") body.delivery = document.getElementById("schedule-modal-delivery").value;
    const result = await api(`/api/schedules/${scheduleEditor.schedule.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    Object.assign(scheduleEditor.schedule, result.schedule);
    closeScheduleEditor();
    await loadSchedules();
  } catch (error) {
    const modalError = document.getElementById("schedule-modal-error");
    modalError.textContent = error.message || "Could not save the automation.";
    modalError.hidden = false;
    input.focus();
  } finally {
    save.disabled = false;
    save.textContent = "Save automation";
  }
}

async function loadSchedules() {
  const { schedules } = await api("/api/schedules");
  scheduleRows = schedules;
  renderSchedules();
}

function renderSchedules() {
  const wrap = document.getElementById("schedules");
  const query = document.getElementById("schedule-search").value.trim().toLocaleLowerCase();
  if (!scheduleRows.length) {
    wrap.innerHTML = `<p class="hint">No schedules yet. In a channel, ask the bot something like "every weekday at 9am, post a standup reminder".</p>`;
    return;
  }
  const schedules = scheduleRows.filter((schedule) => !query || [schedule.channelName, schedule.description, schedule.prompt, friendlySchedule(schedule), schedule.cron].some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  if (!schedules.length) {
    wrap.innerHTML = `<div class="card schedule-empty"><strong>No matching automations</strong><span>Try a channel, person, automation name, or timing.</span></div>`;
    return;
  }
  const groups = {};
  for (const s of schedules) (groups[s.channelName] ||= []).push(s);
  wrap.innerHTML = "";
  for (const [name, list] of Object.entries(groups)) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><h3>${escapeHtml(name)}</h3><span class="badge">${list.length} job${list.length === 1 ? "" : "s"}</span></div>`;
    for (const s of list) {
      const row = document.createElement("div");
      row.className = "sched-row";
      // Last-run: a status dot (ok/warn) + relative-ish text; "never run" when it hasn't fired yet.
      const runHtml = s.lastRun
        ? `<span class="sched-run"><span class="dot ${s.lastStatus && s.lastStatus !== "ok" ? "warn" : "ok"}"></span>last ${escapeHtml(new Date(s.lastRun).toLocaleString())}</span>`
        : `<span class="sched-run"><span class="dot off"></span>never run</span>`;
      row.innerHTML = `
        <label class="toggle inline"><input type="checkbox" class="sched-enabled" ${s.enabled ? "checked" : ""}/></label>
        <button type="button" class="sched-open" title="View details and edit prompt">
          <span class="sched-friendly" title="${escapeHtml(s.cron || "")}">${escapeHtml(friendlySchedule(s))}</span>${s.cronValid || s.once ? "" : ' <span class="sched-badge">invalid</span>'}
          <span class="sched-desc">${escapeHtml(s.description || s.prompt)}</span>
          ${runHtml}
        </button>
        <span class="sched-saved">saved</span>
        <button class="sched-del">Delete</button>`;
      const savedFlash = row.querySelector(".sched-saved");
      row.querySelector(".sched-open").addEventListener("click", () => openScheduleEditor(s));
      row.addEventListener("click", (e) => {
        if (e.target.closest("input, select, button, label")) return;
        openScheduleEditor(s);
      });
      // Brief "saved" flash next to the row on a successful autosave PUT (notify + enable).
      const flashSaved = () => { savedFlash.classList.add("show"); setTimeout(() => savedFlash.classList.remove("show"), 1400); };
      row.querySelector(".sched-enabled").addEventListener("change", async (e) => {
        await api(`/api/schedules/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: e.target.checked }) });
        flashSaved();
      });
      row.querySelector(".sched-del").addEventListener("click", async () => {
        const ok = await confirmDialog({ title: "Delete this automation?", body: "The schedule is removed and stops running. This can't be undone.", confirmLabel: "Delete", danger: true });
        if (!ok) return;
        await api(`/api/schedules/${s.id}`, { method: "DELETE" });
        loadSchedules();
      });
      card.appendChild(row);
    }
    wrap.appendChild(card);
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

async function loadUsers() {
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
    const tok =
      `<span class="tokdots">` +
      `<i class="${u.hasComposioToken ? "set" : ""}" title="Composio">C</i>` +
      `<i class="${u.hasToolboxToken ? "set" : ""}" title="Toolbox">T</i></span>`;
    return `<tr data-id="${escapeHtml(id)}"${userDrawerId === id ? ' class="sel"' : ""}>
      <td>${escapeHtml(u.name || id)}</td>
      <td class="mono">${escapeHtml(id)}</td>
      <td>${role}</td>
      <td class="user-skills-count" title="Skills enabled for this user (personal grants)">${accessGrantSkillOptions([], u.skills || []).length}</td>
      <td>${tok}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Slack ID</th><th>Role</th><th title="Skills enabled for this user (personal grants)">Skills</th><th>Tokens</th></tr></thead>
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
  const userGrantsEditor = buildAccessGrantsEditor(u, { tier: "user" });
  const userGrantsHost = node.querySelector(".ud-grants");
  userGrantsHost.innerHTML = `<label class="field"><span>Grant tier</span><select class="ud-grant-tier"><option value="organization">Organization — applies everywhere</option><option value="channel">Channel</option><option value="user" selected>This user</option></select><em class="state">The effective run gets the live union of all three tiers.</em></label>`;
  userGrantsHost.appendChild(userGrantsEditor.el);
  wireGrantTierNavigation(userGrantsHost.querySelector(".ud-grant-tier"), "user");
  node.querySelector(".ud-composio-state").textContent = GLOBAL_COMPOSIO_MODE === "sdk"
    ? (u.hasComposioToken ? "saved · inactive in SDK mode" : "inactive in SDK mode")
    : (u.hasComposioToken ? "" : "no token set");
  node.querySelector(".ud-toolbox-state").textContent = u.hasToolboxToken ? "" : "no token set";

  drawer.innerHTML = "";
  drawer.hidden = false;
  drawer.appendChild(node);

  // Editable masked token fields — same reveal semantics as before.
  attachReveal(drawer.querySelector(".ud-composio"), { has: u.hasComposioToken, last4: u.composioTokenLast4, fetch: revealSecret("user", "composioToken", id) });
  attachReveal(drawer.querySelector(".ud-toolboxtoken"), { has: u.hasToolboxToken, last4: u.toolboxTokenLast4, fetch: revealSecret("user", "toolboxToken", id) });
  drawer.querySelector(".ud-composio-label").value = u.composioTokenLabel || "";
  drawer.querySelector(".ud-toolboxtoken-label").value = u.toolboxTokenLabel || "";

  drawer.querySelector(".ud-close").addEventListener("click", closeUserDrawer);

  const saved = drawer.querySelector(".ud-saved");
  drawer.querySelector(".ud-save").addEventListener("click", async () => {
    const token = tokenValue(drawer.querySelector(".ud-composio"));
    const toolboxToken = tokenValue(drawer.querySelector(".ud-toolboxtoken"));
    // Owner labels always round-trip (empty clears them) — notes, not secrets.
    const composioTokenLabel = drawer.querySelector(".ud-composio-label").value;
    const toolboxTokenLabel = drawer.querySelector(".ud-toolboxtoken-label").value;
    saved.textContent = "saving…";
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: drawer.querySelector(".ud-name").value,
          isAdmin: drawer.querySelector(".ud-admin").checked,
          approved: drawer.querySelector(".ud-approved").checked,
          ...(token ? { composioToken: token } : {}),
          ...(toolboxToken ? { toolboxToken } : {}),
          composioTokenLabel,
          toolboxTokenLabel,
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
function renderSlackStatus(slack) {
  // The Make.com help block names the bot's own member ID once Slack is connected.
  for (const el of document.querySelectorAll("[data-bot-user-id]")) if (slack?.botUserId) el.textContent = slack.botUserId;
  const el = document.getElementById("slack-status");
  if (!slack) return;
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
  const sdkField = document.getElementById("composio-sdk-key-field");
  if (sdkField) sdkField.hidden = mode !== "sdk";
  const help = document.getElementById("composio-mode-help");
  if (help) {
    help.textContent = mode === "sdk"
      ? (entitled ? "Enterprise · Beta. Stable identity per Slack user/channel; separate sessions per Slack thread. Only channel managers manage shared connections." : "Enterprise · Beta. An active Enterprise license is required. Save Personal tokens mode or activate an Enterprise license to restore integrations.")
      : "Uses the saved token on each user and channel, with the organization token as the shared fallback.";
  }
  const note = document.getElementById("composio-personal-token-note");
  if (note) note.textContent = mode === "sdk" ? "· Composio tokens retained, currently inactive" : "";
}

// The org-default "clear" buttons arm a pending delete that applies on Save (batch-save model,
// same as the checkbox they replaced). Toggling is purely visual until the save handler reads
// the .armed class; disarmClearTok resets one after a successful save.
function disarmClearTok(btn) {
  if (!btn) return;
  btn.classList.remove("armed");
  btn.textContent = "clear";
  btn.title = "Remove this org-default token when you save";
}
function toggleClearTok(btn) {
  const armed = btn.classList.toggle("armed");
  btn.textContent = armed ? "clear ✓" : "clear";
  btn.title = armed ? "This org-default token will be removed when you save" : "Remove this org-default token when you save";
  markSettingsDirty();
}

// ── Settings: ONE long page — jump nav (scroll-spy) + live search filter ──────────
// Every section is always rendered and always in the DOM (the single Save has always depended on
// that). The header links no longer swap panes, they scroll; the search box hides the cards that
// don't match. Matching rules live in admin-settings-search.js so they can be tested headlessly.
const settingsScroller = () => document.getElementById("view-settings");

// How much of the page the sticky header covers — a scroll target must land BELOW it, and the
// scroll-spy's reading line sits at the same place.
function settingsBarOffset() {
  const bar = document.getElementById("settings-bar");
  const scroller = settingsScroller();
  if (!bar || !scroller) return 0;
  // Where the PINNED bar's bottom edge sits, measured from the top of the scroll view. A sticky
  // element pins to the scrollport's padding edge, offset by its own `top` (which is negative here
  // so the bar also covers the view's top padding) — read both instead of assuming, so changing
  // the padding or the bar's height in CSS can never start dropping jump targets behind it.
  const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
  const top = parseFloat(getComputedStyle(bar).top) || 0;
  return Math.max(0, pad + top) + bar.offsetHeight + 18;
}

// Rebuilt on every query rather than cached: half these cards (MCP checklists,
// license state, template grants) are filled in asynchronously, and a stale index would silently
// make freshly-loaded settings unsearchable. ~30 blocks of textContent is cheap.
// Input VALUES are deliberately not indexed — textContent skips them, so no token can be surfaced
// (or leaked into a match) by typing part of it into the search box.
function buildSettingsIndex() {
  const index = [];
  for (const sec of document.querySelectorAll("#settings-body .setsec")) {
    const sectionTitle = sec.querySelector(".setsec-head h3")?.textContent || "";
    const sectionDesc = sec.querySelector(".setsec-head .setsec-desc")?.textContent || "";
    let n = 0;
    for (const block of sec.children) {
      if (block.classList.contains("setsec-head")) continue;
      if (!block.dataset.setkey) block.dataset.setkey = `${sec.dataset.sec}-${n}`;
      n += 1;
      index.push({
        id: block.dataset.setkey,
        section: sec.dataset.sec,
        sectionTitle,
        sectionDesc,
        title: block.querySelector("h4")?.textContent || "",
        text: block.textContent || "",
      });
    }
  }
  return index;
}

function applySettingsFilter(query = "") {
  const result = filterSettings(buildSettingsIndex(), query);
  for (const block of document.querySelectorAll("#settings-body [data-setkey]")) {
    block.classList.toggle("filtered-out", result.active && result.cards.get(block.dataset.setkey) === false);
  }
  for (const sec of document.querySelectorAll("#settings-body .setsec")) {
    sec.classList.toggle("filtered-out", result.active && !(result.sections.get(sec.dataset.sec) > 0));
  }
  for (const a of document.querySelectorAll("#settings-nav a")) {
    a.classList.toggle("dim", result.active && !(result.sections.get(a.dataset.sec) > 0));
  }
  const notice = document.getElementById("settings-no-results");
  if (notice) {
    notice.hidden = !result.empty;
    document.getElementById("settings-no-results-q").textContent = `“${result.query.trim()}”`;
  }
  const clear = document.getElementById("settings-search-clear");
  if (clear) clear.hidden = !result.query;
  const kbd = document.getElementById("settings-search-kbd");
  if (kbd) kbd.hidden = Boolean(result.query);
  document.getElementById("view-settings")?.classList.toggle("searching", result.active);
  updateSettingsSpy();
  return result;
}

function clearSettingsSearch() {
  const input = document.getElementById("settings-search");
  if (input && input.value) input.value = "";
  applySettingsFilter("");
}

// Which section the reader is actually in. Filtered-out sections are skipped so a search can't
// leave the nav pointing at something invisible.
function updateSettingsSpy() {
  const scroller = settingsScroller();
  if (!scroller || !scroller.classList.contains("active")) return;
  // A smooth jump fires scroll events all the way there. Until it settles the nav shows what was
  // CLICKED, not whatever section the animation is passing through.
  if (settingsJumpTarget && Date.now() < settingsJumpUntil) return markSettingsNav(settingsJumpTarget);
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop + settingsBarOffset();
  // Rounded on both sides: a section scrolled exactly to the reading line can otherwise land a
  // fraction of a pixel below it and hand the mark back to the section above.
  const sections = [...document.querySelectorAll("#settings-body .setsec")].map((sec) => ({
    id: sec.dataset.sec,
    visible: !sec.classList.contains("filtered-out"),
    top: Math.round(sec.getBoundingClientRect().top - base),
  }));
  markSettingsNav(activeSectionFor(sections, Math.round(scroller.scrollTop), scroller.clientHeight, scroller.scrollHeight));
}

function markSettingsNav(sec) {
  for (const a of document.querySelectorAll("#settings-nav a")) a.classList.toggle("on", a.dataset.sec === sec);
}

function scrollSettingsTo(el, { smooth = true } = {}) {
  const scroller = settingsScroller();
  if (!scroller || !el) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - settingsBarOffset();
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}

// Every explicit jump bumps this. Restoring the #set-… position on view entry is deferred by a
// frame (the view must lay out first), and a caller that jumped somewhere on purpose in the
// meantime must win over the stale hash.
let settingsJumps = 0;
// The section a smooth jump is heading for, and how long the spy defers to it.
let settingsJumpTarget = null;
let settingsJumpUntil = 0;
const SETTINGS_JUMP_SETTLE_MS = 1200;
function releaseSettingsJumpLock() { settingsJumpUntil = 0; }

// Jump to a section by id. A live search is cleared first — scrolling to a card the filter has
// hidden would look like a dead link.
function selectSettingsSection(sec, { smooth = true, hash = true } = {}) {
  settingsJumps += 1;
  clearSettingsSearch();
  const target = document.getElementById(`set-${sec}`);
  if (!target) return;
  settingsJumpTarget = sec;
  settingsJumpUntil = smooth ? Date.now() + SETTINGS_JUMP_SETTLE_MS : 0;
  markSettingsNav(sec);
  scrollSettingsTo(target, { smooth });
  // A section is a position on this page, not a history step — replaceState, and the router only
  // ever reads the pathname.
  if (hash && window.location.pathname === pathForView("settings")) {
    window.history.replaceState(window.history.state, "", `${pathForView("settings")}#set-${sec}`);
  }
}

// Restore #set-<section> when the Settings page is opened (deep link, refresh, browser Back).
function enterSettingsView(hash = "") {
  const match = /^#set-([a-z-]+)$/.exec(hash || "");
  const stamp = settingsJumps;
  requestAnimationFrame(() => {
    if (settingsJumps !== stamp) return; // an explicit jump already claimed the scroll position
    if (match && document.getElementById(`set-${match[1]}`)) selectSettingsSection(match[1], { smooth: false });
    else updateSettingsSpy();
  });
}

// Deep-jump to ONE control (not a whole section) and mark it, for cross-page links like the API
// docs' "generate a token" pointer.
function revealSetting(id) {
  settingsJumps += 1;
  settingsJumpTarget = null;
  settingsJumpUntil = 0;
  clearSettingsSearch();
  const el = document.getElementById(id);
  const card = el?.closest(".setcard") || el;
  if (!card) return;
  scrollSettingsTo(card);
  card.classList.remove("pulse");
  void card.offsetWidth; // restart the animation when the same card is targeted twice
  card.classList.add("pulse");
  setTimeout(() => card.classList.remove("pulse"), 2000);
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

// One checkbox per known harness. Re-rendered (not patched) on every change so the engine pickers
// and the "last one standing" lock stay derived from a single source: ENGINE_ENABLED.
function paintEngineToggles() {
  const box = document.getElementById("engine-enabled-box");
  if (!box || !ENGINE_MANIFESTS.length) return;
  const onCount = ENGINE_MANIFESTS.filter((m) => engineIsEnabled(m.id)).length;
  box.replaceChildren(...ENGINE_MANIFESTS.map((m) => {
    const on = engineIsEnabled(m.id);
    const label = document.createElement("label");
    label.className = "engine-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = on;
    // The last enabled harness can't be switched off — the daemon would have nothing to run, and
    // the API refuses that state anyway. Disable the box rather than let the save 400.
    input.disabled = on && onCount === 1;
    input.title = input.disabled ? "At least one harness must stay enabled" : "";
    input.addEventListener("change", () => {
      ENGINE_ENABLED[m.id] = input.checked;
      const globalSelect = document.getElementById("set-engine");
      const chosen = globalSelect?.value;
      paintEngineToggles();
      if (globalSelect) {
        globalSelect.innerHTML = engineOptionsHtml();
        // Turning off the harness that IS the default silently re-points the default at an enabled
        // one — visibly, in the select, before the admin saves.
        globalSelect.value = engineIsEnabled(chosen) ? chosen : selectableEngines()[0]?.id || chosen;
      }
      markSettingsDirty();
    });
    label.append(input, document.createTextNode(` ${m.label}`));
    return label;
  }));
}

// Read the whole Settings form into the API's shape. Separate from the save handler because it is
// called TWICE: once right after a paint (the baseline the page was loaded with) and once on Save
// — what differs between the two is all that gets sent.
function readSettingsForm() {
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
    trustedBotApps: document.getElementById("set-trusted-apps").value,
    defaultChannelAccess: document.getElementById("set-channel-access").value,
    composioMode: document.getElementById("set-composio-mode").value,
    ...(tokenValue(document.getElementById("set-composio-sdk-key")) ? { composioSdkApiKey: tokenValue(document.getElementById("set-composio-sdk-key")) } : {}),
    ...(document.getElementById("clear-composio-sdk-key").classList.contains("armed") ? { clearComposioSdkApiKey: true } : {}),
    ...(tokenValue(document.getElementById("set-default-composio")) ? { defaultComposioToken: tokenValue(document.getElementById("set-default-composio")) } : {}),
    ...(document.getElementById("clear-default-composio").classList.contains("armed") ? { clearDefaultComposioToken: true } : {}),
    ...(tokenValue(document.getElementById("set-default-toolbox")) ? { defaultToolboxToken: tokenValue(document.getElementById("set-default-toolbox")) } : {}),
    ...(document.getElementById("clear-default-toolbox").classList.contains("armed") ? { clearDefaultToolboxToken: true } : {}),
    // Owner labels always round-trip (empty clears them) — they're notes, not secrets.
    defaultComposioTokenLabel: document.getElementById("set-default-composio-label").value,
    defaultToolboxTokenLabel: document.getElementById("set-default-toolbox-label").value,
    accessGrants: orgGrantsEditor?.getValues() || {},
    composioMcpUrl: document.getElementById("set-composio").value,
    toolboxMcpUrl: document.getElementById("set-toolbox").value,
    publicUrl: document.getElementById("set-public-url").value,
    approvalLinks: document.getElementById("set-approval-links").value,
    aiTestingUsers: aiTestingPicker?.getValues() || [],
    ...(document.getElementById("set-gchat-key").value.trim() ? { googleChatServiceAccountJson: document.getElementById("set-gchat-key").value } : {}),
    ...(document.getElementById("clear-gchat-key").classList.contains("armed") ? { clearGoogleChatServiceAccountJson: true } : {}),
    googleChatSubscription: document.getElementById("set-gchat-sub").value,
    googleChatBotUserId: document.getElementById("set-gchat-bot").value,
    teamsAppId: document.getElementById("set-teams-app").value,
    ...(tokenValue(document.getElementById("set-teams-secret")) ? { teamsAppPassword: tokenValue(document.getElementById("set-teams-secret")) } : {}),
    ...(document.getElementById("clear-teams-secret").classList.contains("armed") ? { clearTeamsAppPassword: true } : {}),
    teamsTenantId: document.getElementById("set-teams-tenant").value,
    ...(tokenValue(document.getElementById("set-license-key")) ? { licenseKey: tokenValue(document.getElementById("set-license-key")) } : {}),
    ...(document.getElementById("clear-license-key").classList.contains("armed") ? { clearLicenseKey: true } : {}),
    platformUrl: document.getElementById("set-platform-url").value,
    contextWindow: Number(document.getElementById("set-ctxwindow").value) || undefined,
    engine: document.getElementById("set-engine").value,
    defaultClaudeModel: document.getElementById("set-default-claude-model").value,
    defaultCodexModel: document.getElementById("set-default-codex-model").value,
    modelChangeAccess: document.getElementById("set-model-change-access").value,
    engineEnabled: { ...ENGINE_ENABLED },
    engineFallback: document.getElementById("set-engine-fallback").checked,
    engineFallbackMode: document.getElementById("set-engine-fallback-mode").value,
    showMessageCost: document.getElementById("set-show-message-cost").checked,
    whisperEnabled: document.getElementById("set-whisper-enabled").checked,
    containerCli: document.getElementById("set-container-cli").value,
    containerImage: document.getElementById("set-container-image").value,
    containerIdleMinutes: Number(document.getElementById("set-container-idle").value) || undefined,
    containerMaxRunning: Number(document.getElementById("set-container-max").value) || undefined,
    containerPidsLimit: Number(document.getElementById("set-container-pids").value) || undefined,
    containerMemory: document.getElementById("set-container-memory").value,
    containerCpus: document.getElementById("set-container-cpus").value,
    containerFullAccessHome: document.getElementById("set-container-full-access-home").checked,
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
    driveSyncEnabled: document.getElementById("set-drivesync-enabled").checked,
    driveSyncKeyFile: document.getElementById("set-drivesync-keyfile").value,
    ...(document.getElementById("set-drivesync-keyjson").value.trim() ? { driveSyncKeyJson: document.getElementById("set-drivesync-keyjson").value } : {}),
    ...(document.getElementById("clear-drivesync-keyjson").checked ? { clearDriveSyncKeyJson: true } : {}),
    driveSyncSubject: document.getElementById("set-drivesync-subject").value,
    driveSyncIntervalMinutes: Number(document.getElementById("set-drivesync-interval").value) || undefined,
    driveSyncConflict: document.getElementById("set-drivesync-conflict").value,
    driveSyncRclonePath: document.getElementById("set-drivesync-rclone").value,
    codexModelRates: readCodexRates(),
    ...(channelTplEditor ? { channelTemplate: channelTplEditor.getValues() } : {}),
    // DM templates fold into the one global Save. Only include an editor that's mounted (the
    // section may not have been visited yet — mounting happens in loadSettings, so it always is).
    ...(dmTplEditors.user && dmTplEditors.admin
      ? { dmTemplates: { user: dmTplEditors.user.getValues(), admin: dmTplEditors.admin.getValues() } }
      : {}),
    ...(document.getElementById("set-adminpw").value ? { adminPassword: document.getElementById("set-adminpw").value } : {}),
    // HTTP run API token (write-only): send the new value only if edited/generated; the clear
    // toggle removes it. Leaving the field untouched keeps the stored token.
    ...(tokenValue(document.getElementById("set-apikey")) ? { apiKey: tokenValue(document.getElementById("set-apikey")) } : {}),
    ...(document.getElementById("clear-apikey").classList.contains("armed") ? { clearApiKey: true } : {}),
  };
}

function paintSettings(s) {
  applyEngineManifests(s.engines);
  ENGINE_ENABLED = { ...(s.engineEnabled || {}) };
  paintEngineToggles();
  const orgGrantsHost = document.getElementById("org-grants-editor");
  orgGrantsEditor = buildAccessGrantsEditor(s.accessGrants || {}, { tier: "organization" });
  orgGrantsHost.replaceChildren(orgGrantsEditor.el);
  wireGrantTierNavigation(document.getElementById("org-grant-tier"), "organization");
  const globalEngineSelect = document.getElementById("set-engine");
  if (globalEngineSelect && ENGINE_MANIFESTS.length) globalEngineSelect.innerHTML = engineOptionsHtml();
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
  document.getElementById("set-trusted-apps").value = (s.trustedBotApps || []).join(", ");
  if (s.defaultChannelAccess) document.getElementById("set-channel-access").value = s.defaultChannelAccess;
  document.getElementById("set-composio-mode").value = s.composioMode === "sdk" ? "sdk" : "personal";
  document.getElementById("set-composio-mode").dataset.sdkEntitled = String(s.composioSdk?.entitled === true);
  document.querySelector('#set-composio-mode option[value="sdk"]').disabled = s.composioSdk?.entitled !== true;
  document.getElementById("set-composio-sdk-key").disabled = s.composioSdk?.entitled !== true;
  GLOBAL_COMPOSIO_MODE = document.getElementById("set-composio-mode").value;
  document.getElementById("composio-sdk-key-state").textContent = tokenState(s.hasComposioSdkApiKey, s.composioSdkApiKeyLast4);
  attachReveal(document.getElementById("set-composio-sdk-key"), "");
  syncComposioModeUi();
  document.getElementById("set-composio").value = s.composioMcpUrl || "";
  document.getElementById("set-toolbox").value = s.toolboxMcpUrl || "";
  document.getElementById("set-public-url").value = s.publicUrl || "";
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
  // No eye toggle on the key: attachReveal drives an <input type=password>, and this is a textarea
  // (a service-account key is multi-line JSON) — the same shape the Drive-sync key field uses. The
  // value is still fetchable through /api/secrets/reveal for an admin who needs it back.
  document.getElementById("set-teams-app").value = s.teams?.appId || "";
  document.getElementById("set-teams-tenant").value = s.teams?.tenantId || "";
  document.getElementById("state-teams-secret").textContent = tokenState(s.teams?.hasAppPassword, s.teams?.appPasswordLast4);
  attachReveal(document.getElementById("set-teams-secret"), { has: Boolean(s.teams?.hasAppPassword), last4: s.teams?.appPasswordLast4 || "", fetch: revealSecret("settings", "teamsAppPassword") });
  const teamsEndpoint = s.teams?.messagingEndpoint || "set a Public URL first";
  document.getElementById("teams-endpoint").textContent = teamsEndpoint;
  document.getElementById("teams-create-command").textContent = s.teams?.messagingEndpoint
    ? `teams app create --name "ChannelGate" --endpoint "${teamsEndpoint}"`
    : 'teams app create --name "ChannelGate" --endpoint "https://<public-url>/api/teams/messages"';
  document.getElementById("default-composio-state").textContent = tokenState(s.hasDefaultComposioToken, s.defaultComposioTokenLast4);
  document.getElementById("default-toolbox-state").textContent = tokenState(s.hasDefaultToolboxToken, s.defaultToolboxTokenLast4);
  attachReveal(document.getElementById("set-default-composio"), { has: s.hasDefaultComposioToken, last4: "", fetch: revealSecret("settings", "defaultComposioToken") });
  attachReveal(document.getElementById("set-default-toolbox"), { has: s.hasDefaultToolboxToken, last4: "", fetch: revealSecret("settings", "defaultToolboxToken") });
  document.getElementById("set-default-composio-label").value = s.defaultComposioTokenLabel || "";
  document.getElementById("set-default-toolbox-label").value = s.defaultToolboxTokenLabel || "";
  document.getElementById("set-ctxwindow").value = s.contextWindow || "";
  if (s.engine) document.getElementById("set-engine").value = s.engine;
  GLOBAL_ENGINE = s.engine || "claude";
  syncModelOptions({ modelSelect: document.getElementById("set-default-claude-model"), engine: "claude", value: s.defaultClaudeModel || "", blankLabel: "CLI default" });
  syncModelOptions({ modelSelect: document.getElementById("set-default-codex-model"), engine: "codex", value: s.defaultCodexModel || "", blankLabel: "CLI default" });
  document.getElementById("set-model-change-access").value = s.modelChangeAccess || "admins";
  document.getElementById("set-engine-fallback").checked = s.engineFallback !== false;
  document.getElementById("set-engine-fallback-mode").value = s.engineFallbackMode || "auto";
  document.getElementById("set-show-message-cost").checked = s.showMessageCost !== false;
  document.getElementById("set-whisper-enabled").checked = s.whisperEnabled !== false;
  // Container runtime. The token follows the write-only rule: has*/last4 here, value on demand.
  document.getElementById("set-container-cli").value = s.containerCli || "auto";
  document.getElementById("set-container-image").value = s.containerImage || "";
  document.getElementById("set-container-idle").value = s.containerIdleMinutes ?? 10;
  document.getElementById("set-container-max").value = s.containerMaxRunning ?? 8;
  document.getElementById("set-container-pids").value = s.containerPidsLimit ?? 1024;
  document.getElementById("set-container-memory").value = s.containerMemory || "";
  document.getElementById("set-container-cpus").value = s.containerCpus || "";
  document.getElementById("set-container-full-access-home").checked = s.containerFullAccessHome === true;
  document.getElementById("container-token-state").textContent = tokenState(s.hasContainerClaudeOauthToken, s.containerClaudeOauthTokenLast4);
  attachReveal(document.getElementById("set-container-claude-token"), { has: s.hasContainerClaudeOauthToken, last4: s.containerClaudeOauthTokenLast4 || "", fetch: revealSecret("settings", "containerClaudeOauthToken") });
  document.getElementById("set-adminpw").dataset.hasPassword = String(s.hasAdminPassword === true);
  document.getElementById("adminpw-state").textContent = s.hasAdminPassword ? "· set" : "· not set (UI open)";
  // HTTP run API key: a revealable field seeded with the stored token (so it can be copied into an
  // automation) plus a set/not-set state. Generated client-side, persisted on Save (write-only).
  attachReveal(document.getElementById("set-apikey"), { has: s.hasApiKey, last4: s.apiKeyLast4, fetch: revealSecret("settings", "apiKey") });
  document.getElementById("apikey-state").textContent = s.hasApiKey ? "· set" : "· not set (run API needs an admin login)";
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
  renderSlackStatus(s.slack);
  renderSkillTemplatesSettings().catch(() => {});
  renderChannelTemplateSettings(s.channelTemplate || {});
  // DM templates: (re)build the two editors from the stored config, and keep DM_TEMPLATES in sync so
  // the Conversations list shows each DM row's template-derived capdot after an edit + save.
  DM_TEMPLATES = s.dmTemplates || DM_TEMPLATES;
  renderDmTemplateSettings(DM_TEMPLATES);
  if (viewLoaded.channels) renderConvList();
  // Re-render the chip editors from the (just-set) hidden inputs, and treat this repaint as clean.
  for (const c of document.querySelectorAll("#view-settings .chips[data-chip-for]")) renderChipsFromInput(c);
  clearSettingsDirty();
  // A repaint shows what the daemon STORES, so nothing pending may survive it: an armed clear
  // toggle or a typed write-only value belongs either to a save that already happened or — after a
  // refused one — to a save that never will. They also have to go before the baseline below, or a
  // pending action would be captured as "already the server's state" and then never sent.
  for (const btn of document.querySelectorAll("#view-settings .clear-tok.armed")) disarmClearTok(btn);
  document.getElementById("set-adminpw").value = "";
  document.getElementById("set-gchat-key").value = "";
  // Remember what this paint put on the page: Save sends the difference against it, so a field
  // nobody touched here is never re-asserted over another writer's newer value.
  SETTINGS_SNAPSHOT = s;
  SETTINGS_VERSION = s?.settingsVersion ? String(s.settingsVersion) : "";
  SETTINGS_BASELINE = readSettingsForm();
}

async function loadSettings() {
  const [settings, directory] = await Promise.all([
    api("/api/settings"),
    api("/api/users").catch(() => ({ users: USERS })),
  ]);
  USERS = directory.users || {};
  paintSettings(settings);
  await loadLicense();
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

const fmtLicenseLimit = (v) => (v === null || v === undefined ? "unlimited" : String(v));
const fmtLicenseTime = (v) => (v ? new Date(v).toLocaleString() : "—");

function paintLicense(l) {
  document.getElementById("license-state-chip").textContent = LICENSE_STATE_LABEL[l.state] || `· ${l.state}`;
  document.getElementById("set-composio-mode").dataset.sdkEntitled = String(l.features?.composioSdk === true);
  document.querySelector('#set-composio-mode option[value="sdk"]').disabled = l.features?.composioSdk !== true;
  document.getElementById("set-composio-sdk-key").disabled = l.features?.composioSdk !== true;
  syncComposioModeUi();

  const banner = document.getElementById("license-banner");
  banner.className = `license-banner ${l.banner?.level || ""}`.trim();
  banner.textContent = l.banner?.text || "";
  banner.hidden = !l.banner;

  const facts = [
    ["Tier", l.tier === "none" ? "no key" : l.tier],
    ["Organization", l.organization || "—"],
    ["Key", l.hasLicenseKey ? `…${escapeHtml(l.licenseKeyLast4)} (from ${escapeHtml(l.licenseKeySource)})` : "none"],
    ["Conversations", fmtLicenseLimit(l.limits?.conversations)],
    ["AI messages / conversation / month", fmtLicenseLimit(l.limits?.messagesPerConversationPerMonth)],
    ["Last verified", fmtLicenseTime(l.verifiedAt)],
    ["Next check", fmtLicenseTime(l.nextCheckAt)],
    ["Expires", l.expiresAt ? fmtLicenseTime(l.expiresAt) : "—"],
    ["Installation id", `<code>${escapeHtml(l.installationId || "")}</code>`],
    ["Platform", `<code>${escapeHtml(l.platformUrl || "")}</code>`],
  ];
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
    ? `Unlimited AI messages per conversation on this tier — bars are relative to the busiest conversation.`
    : `Limit: ${cap} AI messages per conversation this month. A conversation is warned once at 80% and refused at the limit.`;
  host.innerHTML =
    `<p class="license-usage-limit">${escapeHtml(limitLine)}</p>` +
    rows.map((r) => {
      const pct = Math.max(2, Math.min(100, (r.runs / max) * 100));
      const ratio = cap === null ? 0 : r.runs / cap;
      const tone = ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "";
      const name = r.conversationId + (r.admitted ? "" : " (not in this month's allowed set)");
      return `<div class="bar-row">
        <span class="bar-name" title="${escapeHtml(name)}">${escapeHtml(r.conversationId)}</span>
        <span class="bar-track"><span class="bar-fill ${tone}" style="width:${pct}%${tone ? "" : ";background:var(--orange)"}"></span></span>
        <span class="bar-val">${r.runs}${cap === null ? "" : ` / ${cap}`}</span>
      </div>`;
    }).join("");
}

// Collect the per-model Codex rates table into the settings PUT shape.
function readCodexRates() {
  const out = {};
  for (const tr of document.querySelectorAll("#codex-rates tbody tr[data-model]")) {
    const r = {};
    for (const inp of tr.querySelectorAll("input[data-f]")) r[inp.dataset.f] = Number(inp.value || 0);
    out[tr.dataset.model] = r;
  }
  return out;
}

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
  for (const id of ["clear-composio-sdk-key", "clear-default-composio", "clear-default-toolbox", "clear-admin-user", "clear-license-key", "clear-gchat-key", "clear-teams-secret", "clear-container-claude-token"]) {
    const btn = document.getElementById(id);
    // The button lives inside the field's <label>; preventDefault stops the click from
    // bubbling to the label and focusing the token input.
    btn.addEventListener("click", (e) => { e.preventDefault(); toggleClearTok(btn); });
  }
  document.getElementById("set-composio-mode").addEventListener("change", syncComposioModeUi);

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
        try {
          const res = await api(`/api/platforms/${platform}/${action}`, { method: "POST" });
          renderPlatformStatus(banner, { connection: res.connection });
        } catch (error) {
          el.className = "status-banner bad";
          el.textContent = `● ${error.message}`;
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  document.getElementById("reset-channel-runtime").addEventListener("click", async () => {
    const saved = document.getElementById("reset-channel-runtime-saved");
    const ok = await confirmDialog({
      title: "Reset every channel to gateway defaults?",
      body: "Every channel's engine and model overrides will be cleared. New threads will inherit the gateway engine and per-engine model shown above; existing threads keep the engine that owns their current session. Access, effort, tools, tokens and DM templates stay unchanged. Save any changed gateway defaults first. This can't be undone.",
      confirmLabel: "Reset all channels",
      danger: true,
    });
    if (!ok) return;
    saved.textContent = "resetting…";
    try {
      const r = await api("/api/channels/reset-runtime", { method: "POST", body: JSON.stringify({}) });
      saved.textContent = `✓ reset ${r.count} channel(s)`;
      await loadConversations();
      await infoDialog({ title: "Channel runtime reset", body: `Reset ${r.count} channel(s) to the gateway engine and model defaults.` });
      setTimeout(() => (saved.textContent = ""), 4000);
    } catch (e) {
      saved.textContent = "✗ " + e.message;
    }
  });

  // HTTP run API token: generate (client-side random), copy, and clear-on-save. The generated
  // value is marked dirty + revealed so Save picks it up (tokenValue) and the operator can copy it.
  const apikeyMsg = document.getElementById("apikey-msg");
  document.getElementById("clear-apikey").addEventListener("click", (e) => { e.preventDefault(); toggleClearTok(document.getElementById("clear-apikey")); });
  document.getElementById("gen-apikey").addEventListener("click", (e) => {
    e.preventDefault();
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const tok = "cg_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const input = document.getElementById("set-apikey");
    input.value = tok;
    input._reveal.dirty = true;
    input.dataset.dirty = "1";
    input._reveal.revealed = true;
    paintReveal(input);
    disarmClearTok(document.getElementById("clear-apikey")); // generating a new key contradicts clearing
    apikeyMsg.textContent = "Generated — click Save to apply, then Copy for your automation.";
  });
  document.getElementById("copy-apikey").addEventListener("click", async (e) => {
    e.preventDefault();
    const input = document.getElementById("set-apikey");
    // The freshly typed/generated value if edited, otherwise the stored one behind the reveal.
    const val = input._reveal?.dirty ? input.value.trim() : String(input._reveal?.full || "");
    if (!val) { apikeyMsg.textContent = "No token yet — Generate one first."; return; }
    try { await navigator.clipboard.writeText(val); apikeyMsg.textContent = "Copied ✓"; }
    catch { apikeyMsg.textContent = "Copy failed — reveal it with the eye and copy manually."; }
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
      title: `Turn no-response reminders ${on ? "ON" : "OFF"} everywhere?`,
      body: `Every existing channel & DM will be set to the current default (${on ? "on" : "off"}). Per-conversation overrides are lost. Save the setting first if you just changed it. This can't be undone.`,
      confirmLabel: on ? "Enable on all" : "Disable on all",
      danger: true,
    });
    if (!ok) return;
    saved.textContent = "applying…";
    try {
      const r = await api("/api/channels/reset-nudges", { method: "POST", body: JSON.stringify({}) });
      saved.textContent = `✓ applied to ${r.count} conversation(s)`;
      await loadConversations();
      await infoDialog({ title: "Nudges applied", body: `Set no-response reminders ${r.nudges ? "on" : "off"} on ${r.count} conversation(s).` });
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
    const form = readSettingsForm();
    const patch = diffSettingsPayload(SETTINGS_BASELINE || {}, form);
    const newPw = form.adminPassword || "";
    // Only (re)connect Slack when a Slack token was actually changed in this save — a normal
    // settings change just persists and takes effect on the next message, no reconnect.
    const slackTokenChanged = !!(form.slackBotToken || form.slackAppToken || form.slackSigningSecret);
    try {
      const currentAdminPassword = newPw && document.getElementById("set-adminpw").dataset.hasPassword === "true"
        ? await passwordDialog({ body: "Enter your current admin password to change it." }) : "";
      if (newPw && document.getElementById("set-adminpw").dataset.hasPassword === "true" && !currentAdminPassword) {
        saved.textContent = "Password change cancelled";
        return;
      }
      const r = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...patch,
          ...(newPw ? { currentAdminPassword } : {}),
          // Echo the version this page was painted from: the server refuses the save (409) if
          // anything wrote settings in the meantime, instead of landing it on a newer state.
          ...(SETTINGS_VERSION ? { settingsVersion: SETTINGS_VERSION } : {}),
          connectSlack: slackTokenChanged,
        }),
      });
      if (newPw) await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: newPw }) });
      // Reset only the write-only password box; the token fields are repainted (masked) by the
      // loadSettings() call below, which re-seeds each reveal field with the freshly stored value.
      document.getElementById("set-adminpw").value = "";
      for (const id of ["clear-composio-sdk-key", "clear-default-composio", "clear-default-toolbox", "clear-admin-user", "clear-license-key", "clear-gchat-key", "clear-teams-secret", "clear-container-claude-token"]) disarmClearTok(document.getElementById(id));
      // A saved key kicks off a fresh verification server-side; repaint so the card shows the new
      // state (and the new last4) instead of the pre-save one.
      loadLicense().catch(() => { /* the save itself succeeded — the card refreshes on reload */ });
      disarmClearTok(document.getElementById("clear-apikey"));
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
    const ok = await confirmDialog({
      title: "Restart the daemon?",
      body: "The gateway checks ongoing turns and jobs first, waits up to five minutes, and restarts only after it becomes idle.",
      confirmLabel: "Restart when idle",
      danger: true,
    });
    if (!ok) return;
    const msg = document.getElementById("daemon-msg");
    let before;
    let started;
    try {
      before = await api("/api/health");
      started = await api("/api/daemon/restart", { method: "POST" });
    } catch (e) {
      msg.textContent = "✗ " + e.message;
      return;
    }
    msg.textContent = "Checking ongoing work…";
    const deadline = Date.now() + Number(started.waitMs || 300_000) + 60_000;
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
  document.getElementById("fs-up").disabled = !data.parent;
  document.getElementById("fs-up").dataset.parent = data.parent || "";
  const list = document.getElementById("fs-list");
  list.innerHTML = "";
  if (!data.dirs.length) {
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
  const el = document.getElementById("health");
  try {
    const h = await api("/api/health");
    const slackOk = !!h.slack?.connected;
    const warm = h.warmSessions ?? 0;
    const slackLabel = slackOk ? `Slack · @${h.slack.user}` : `Slack · ${h.slack?.status || "off"}`;
    // One chip per harness. An installed CLI that is signed OUT looks healthy to a version probe
    // and then fails every turn, so the chip reports the credential, not just the binary.
    const engines = h.engines && typeof h.engines === "object" ? h.engines : { claude: h.claude || {} };
    const engineChips = Object.entries(engines).filter(([, check]) => check?.enabled !== false).map(([id, check]) => {
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      const signedOut = check?.auth?.known === true && check.auth.authenticated === false;
      const ok = !!check?.available && !signedOut;
      const label = !check?.available
        ? `${name} · unavailable`
        : signedOut ? `${name} · signed out` : `${name} · ${check.version || "ready"}`;
      // A login that still works but dies in a few days is not "signed out" — it gets the chip's
      // tooltip rather than a red dot, which is where the remedy belongs before it becomes urgent.
      const title = signedOut ? check.auth.detail : check?.available ? check?.auth?.expiring || "" : check?.reason || "";
      return `<div class="statuschip"${title ? ` title="${escapeHtml(title)}"` : ""}><span class="dot ${ok ? "ok" : "off"}"></span>${escapeHtml(label)}</div>`;
    }).join("");
    // Gateway root goes in a tooltip rather than wrapping raw text in the rail.
    el.title = h.gatewayRoot || "";
    el.innerHTML =
      `<div class="statuschip"><span class="dot ${slackOk ? "ok" : "off"}"></span>${escapeHtml(slackLabel)}</div>` +
      engineChips +
      `<div class="statuschip"><span class="dot ${warm > 0 ? "ok" : "off"}"></span>Warm sessions · <span class="tabnum">${escapeHtml(String(warm))}</span></div>`;
    document.getElementById("logout").style.display = h.authEnabled ? "" : "none";
    paintContainerRuntimeHealth(h.containerRuntime);
  } catch (e) {
    el.removeAttribute("title");
    el.innerHTML = `<div class="statuschip"><span class="dot off"></span>API error</div>`;
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
  el.textContent = bits.join(" ");
}


// ── Gateway update (sidebar) ─────────────────────────────────────────────────────
// Version chip + one-click transactional update. Health exposes a sanitized durable status, so
// the browser follows its exact transaction through candidate and rollback restarts instead of
// treating any replacement daemon as success.
const UPDATE_PHASES = {
  queued: "queued",
  preflight: "checking Git, disk, config, service, and container engines",
  snapshotting: "creating a recovery snapshot",
  checkout: "checking out the candidate",
  installing: "installing exact dependencies",
  auditing: "checking production security advisories",
  testing: "running the regression suite",
  provisioning: "provisioning optional components",
  image: "rebuilding the channel container image",
  restarting: "restarting the gateway",
  verifying: "checking daemon, Slack, and container engines",
  rolling_back: "rolling back to the previous revision",
};

function updateResultHtml(transaction) {
  const revision = transaction.runningRevision ? ` <code>${escapeHtml(transaction.runningRevision)}</code>` : "";
  if (transaction.result === "updated" && transaction.imageWarning) {
    return `<span class="statuschip"><span class="dot warn"></span>container image needs attention — ${escapeHtml(transaction.imageWarning)}</span>`;
  }
  if (transaction.result === "updated" && transaction.changed === false) {
    return `<span class="statuschip"><span class="dot ok"></span>already up to date${revision}; checks passed</span>`;
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
  return `<span class="statuschip" title="${escapeHtml(detail)}"><span class="dot warn"></span>update and rollback failed — ${escapeHtml(detail)}</span>`;
}

function renderRunningUpdate(el, transaction) {
  const phase = UPDATE_PHASES[transaction.phase] || transaction.phase || "working";
  const gib = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(1);
  const disk = transaction.requiredDiskBytes
    ? ` · ${gib(transaction.requiredDiskBytes)} GiB required / ${gib(transaction.availableDiskBytes)} GiB free${transaction.optionalDownloadBytes ? " · includes missing 1.5 GiB Whisper model" : ""}`
    : "";
  el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Updating · ${escapeHtml(phase + disk)}</span>`;
}

async function monitorGatewayUpdate(transactionId, el, startedAt = Date.now()) {
  if (Date.now() - startedAt > 15 * 60_000) {
    el.innerHTML = `<span class="statuschip"><span class="dot warn"></span>Update is taking long — check ~/.channelgate/logs/update.log.</span>`;
    return;
  }
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`health ${response.status}`);
    const health = await response.json();
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
    }
  } catch {
    // A restart can briefly refuse connections; durable state remains available when it returns.
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
    const cur = u.current ? `<span class="statuschip" title="gateway version"><span class="dot ok"></span><code>${escapeHtml(u.current)}</code></span>` : "";
    if (u.behind > 0) {
      el.innerHTML = `${cur}<button id="update-now" class="ghost update-btn">Update (${u.behind} commit${u.behind === 1 ? "" : "s"} behind)</button>`;
      document.getElementById("update-now").addEventListener("click", runGatewayUpdate);
    } else {
      el.innerHTML = `${cur}<span class="statuschip"><span class="dot ok"></span>up to date${u.checked ? "" : " (couldn't reach remote)"}</span>`;
    }
  } catch {
    el.innerHTML = ""; // non-admin / locked-down — just hide the chip
  }
}

async function runGatewayUpdate() {
  const ok = await confirmDialog({
    title: "Update the gateway now?",
    body: "It pulls the latest version and restarts — the bot is offline for a few seconds.",
    confirmLabel: "Update",
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
const initialConversationRoute = conversationRouteForPath(window.location.pathname);
const initialView = viewForPath(window.location.pathname) || "dashboard";
setView(initialView, {
  history: initialConversationRoute || window.location.pathname === pathForView(initialView) ? "none" : "replace",
  load: false,
});

window.addEventListener("popstate", async () => {
  const conversation = conversationRouteForPath(window.location.pathname);
  const view = viewForPath(window.location.pathname) || "dashboard";
  setView(view, { history: "none" });
  if (view === "channels") await selectConv(conversation?.key || null, { history: "none", canonicalize: true });
});

// ── Static event wiring (elements always present in the DOM) ─────────────────────
const scheduleModal = document.getElementById("schedule-modal");
document.getElementById("schedule-modal-close").addEventListener("click", closeScheduleEditor);
document.getElementById("schedule-modal-cancel").addEventListener("click", closeScheduleEditor);
document.getElementById("schedule-modal-save").addEventListener("click", saveScheduleEditor);
document.getElementById("schedule-modal-prompt").addEventListener("input", () => {
  document.getElementById("schedule-modal-error").hidden = true;
});
document.getElementById("schedule-search").addEventListener("input", renderSchedules);
// Same clear affordance as the users search: the × shows once there is a query, Escape clears.
{
  const search = document.getElementById("schedule-search");
  const clear = document.getElementById("schedule-search-clear");
  search.addEventListener("input", () => { clear.hidden = !search.value.trim(); });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    search.value = "";
    clear.hidden = true;
    renderSchedules();
  });
  clear.addEventListener("click", () => {
    search.value = "";
    clear.hidden = true;
    renderSchedules();
    search.focus();
  });
}
document.getElementById("schedule-frequency").addEventListener("change", syncScheduleTimingFields);
document.getElementById("schedule-modal-notify").addEventListener("change", (event) => {
  document.getElementById("schedule-modal-notify-user-wrap").hidden = event.target.value !== "user";
});
scheduleModal.addEventListener("click", (e) => {
  if (e.target === scheduleModal) closeScheduleEditor();
});
document.addEventListener("keydown", (e) => {
  if (!scheduleModal.hidden && e.key === "Escape") closeScheduleEditor();
});

for (const b of document.querySelectorAll(".nav-item")) {
  b.addEventListener("click", async (e) => {
    // Keep modified clicks native so links can still open in a new tab/window.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (b.dataset.view === "channels") {
      if (!(await selectConv(null))) return;
      setView("channels", { history: "none" });
    } else setView(b.dataset.view);
  });
}
// API docs → jump to the token field in Settings.
document.getElementById("apidoc-gen").addEventListener("click", gotoApiTokenSettings);
document.getElementById("apidoc-goto-settings").addEventListener("click", (e) => { e.preventDefault(); gotoApiTokenSettings(); });
document.getElementById("channel-search").addEventListener("input", () => renderConvList());
// Segmented filter (All / Channels / DMs) — narrows the one conversation list.
for (const b of document.querySelectorAll("#conv-seg button")) {
  b.addEventListener("click", () => {
    convFilter = b.dataset.seg;
    for (const x of document.querySelectorAll("#conv-seg button")) x.classList.toggle("on", x === b);
    renderConvList();
  });
}

// Settings header — the section names are jump links into the one long page (real hrefs, so
// copy-link / new-tab still work), and the search box filters every card live.
for (const a of document.querySelectorAll("#settings-nav a")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    selectSettingsSection(a.dataset.sec);
  });
}

{
  const search = document.getElementById("settings-search");
  const clear = document.getElementById("settings-search-clear");
  const scroller = document.getElementById("view-settings");
  if (search) {
    // Filtering re-lays out the whole page, so put the reader at the first surviving section
    // instead of leaving them at an offset that now points at something else. Instant, not smooth:
    // this happens on every keystroke.
    search.addEventListener("input", () => {
      const result = applySettingsFilter(search.value);
      if (!result.active) return;
      releaseSettingsJumpLock();
      const first = document.querySelector("#settings-body .setsec:not(.filtered-out)");
      if (first) scrollSettingsTo(first, { smooth: false });
      else scroller?.scrollTo({ top: 0 });
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); clearSettingsSearch(); search.blur(); }
    });
  }
  clear?.addEventListener("click", () => { clearSettingsSearch(); search?.focus(); });
  document.getElementById("settings-no-results-clear")?.addEventListener("click", () => { clearSettingsSearch(); search?.focus(); });

  // Any real scroll input cancels the post-jump lock immediately — the reader's own scrolling
  // always outranks where a link was pointing.
  for (const event of ["wheel", "touchstart", "pointerdown"]) {
    scroller?.addEventListener(event, () => releaseSettingsJumpLock(), { passive: true });
  }

  // Scroll-spy. rAF-coalesced so a fast scroll does one measurement per frame.
  let spyQueued = false;
  scroller?.addEventListener("scroll", () => {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(() => { spyQueued = false; updateSettingsSpy(); });
  }, { passive: true });
  window.addEventListener("resize", () => updateSettingsSpy());

  // "/" or ⌘/Ctrl-K focuses the search — but only on Settings, and never while the user is typing
  // into an actual setting.
  document.addEventListener("keydown", (e) => {
    if (!scroller?.classList.contains("active") || !search) return;
    const typing = /^(input|textarea|select)$/i.test(e.target?.tagName || "") || e.target?.isContentEditable;
    const shortcut = e.key === "k" && (e.metaKey || e.ctrlKey);
    if (!shortcut && (typing || e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey)) return;
    e.preventDefault();
    search.focus();
    search.select();
  });
}

// Settings dirty tracking — any input/change in the panes flips the savebar to "Unsaved changes"
// (the savebar's own controls + the Access Templates tool filter boxes are exempt — filtering a
// checklist is a view action, not a config change). A successful save re-loads settings, clearing it.
{
  const view = document.getElementById("view-settings");
  const onEdit = (e) => { if (!e.target.closest(`.settings-savebar, .checks-filter, .setbar, ${SELF_SAVING_CONTROLS}`)) markSettingsDirty(); };
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
    await api(`/api/users/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: id }) });
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

document.getElementById("remove-password").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Remove admin password?",
    body: "The UI becomes open — anyone who can reach it can administer, with no sign-in.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  const currentAdminPassword = await passwordDialog({ body: "Enter your current admin password to remove it.", danger: true });
  if (!currentAdminPassword) return;
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ clearAdminPassword: true, currentAdminPassword, connectSlack: false }) });
    document.getElementById("daemon-msg").textContent = "✓ password removed";
    await loadSettings();
    await loadHealth();
  } catch (error) {
    document.getElementById("daemon-msg").textContent = "✗ " + error.message;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────────
async function init() {
  await loadHealth();
  startActiveRunsStream();
  loadUpdateStatus().catch(() => {}); // version chip + update button — off the critical path
  bindSettings();
  const { skills } = await api("/api/skills");
  try {
    SKILL_TEMPLATES = (await api("/api/skills/templates")).templates || [];
  } catch {
    SKILL_TEMPLATES = [];
  }
  SKILLS = skills;
  await loadSettings();
  await loadUsers(); // populate USERS for the channel user pickers (+ render the Users view)
  await loadConversations(); // default view: render the unified list (light); details render on click
  viewLoaded.channels = true;
  viewLoaded.users = true;
  viewLoaded.settings = true;
  if (initialConversationRoute) await selectConv(initialConversationRoute.key, { history: "none", canonicalize: true });
  loadView(initialView);

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
// edited under Settings → Access Templates. `SKILL_TEMPLATES` is loaded with the skill catalog.
function fillSkillTemplateSelect(select, value, stateEl) {
  if (!select) return;
  select.innerHTML = `<option value="">none</option>${SKILL_TEMPLATES.map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.name)} (${(t.resolved || []).length})</option>`).join("")}`;
  select.value = SKILL_TEMPLATES.some((t) => t.slug === value) ? value : "";
  const paint = () => {
    const t = SKILL_TEMPLATES.find((x) => x.slug === select.value);
    if (stateEl) stateEl.textContent = t ? `${(t.resolved || []).length} skill(s) from the template: ${(t.resolved || []).slice(0, 12).join(", ")}${(t.resolved || []).length > 12 ? "…" : ""}` : "no template — only the skills checked below (plus organization and personal grants)";
  };
  paint();
  select.addEventListener("change", paint);
}

let skillTplEditing = null; // slug being edited, "" for a new one, null for the list

async function renderSkillTemplatesSettings() {
  const mount = document.getElementById("skill-templates-editor");
  if (!mount) return;
  try {
    SKILL_TEMPLATES = (await api("/api/skills/templates")).templates || [];
  } catch (err) {
    mount.innerHTML = `<p class="skills-error">Could not load templates: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (skillTplEditing !== null) return renderSkillTemplateEditor(mount, skillTplEditing);
  const rows = SKILL_TEMPLATES.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong> <span class="skills-muted">${escapeHtml(t.slug)}</span>${t.builtin ? ' <span class="pill">built-in</span>' : ""}<br/><span class="skills-muted">${escapeHtml(t.description || "")}</span></td>
      <td>${(t.resolved || []).length} skill(s)<br/><span class="skills-muted">${(t.missing || []).length ? `<span class="skills-error">missing: ${escapeHtml(t.missing.join(", "))}</span>` : ""}</span></td>
      <td>${(t.channels || []).length ? t.channels.map((c) => escapeHtml(c.name)).join(", ") : '<span class="skills-muted">no conversation yet</span>'}</td>
      <td><button type="button" class="ghost" data-tpl-edit="${escapeHtml(t.slug)}">Edit</button></td>
    </tr>`).join("");
  mount.innerHTML = `
    <table class="skills-table"><thead><tr><th>Template</th><th>Skills</th><th>Used by</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="skills-muted">No templates yet.</td></tr>'}</tbody></table>
    <div class="skills-actions"><button type="button" class="ghost" data-tpl-new="1">+ New template</button></div>`;
  mount.querySelectorAll("[data-tpl-edit]").forEach((b) => b.addEventListener("click", () => { skillTplEditing = b.dataset.tplEdit; renderSkillTemplatesSettings(); }));
  mount.querySelector("[data-tpl-new]")?.addEventListener("click", () => { skillTplEditing = ""; renderSkillTemplatesSettings(); });
}

function renderSkillTemplateEditor(mount, slug) {
  const t = SKILL_TEMPLATES.find((x) => x.slug === slug) || { slug: "", name: "", description: "", skills: [], categories: [], builtin: false, channels: [] };
  const isNew = !slug;
  mount.innerHTML = `
    <div class="skills-form">
      <label class="field"><span>Name</span><input class="tpl-name" value="${escapeHtml(t.name)}" placeholder="Support" /></label>
      <label class="field"><span>Slug</span><input class="tpl-slug" value="${escapeHtml(t.slug)}" placeholder="support"${isNew ? "" : " readonly"} /></label>
      <label class="field wide"><span>Description</span><input class="tpl-desc" value="${escapeHtml(t.description || "")}" /></label>
    </div>
    <div class="col tools-col">
      <div class="checks-head"><h4>Explicit skills</h4><span class="checks-count tpl-skills-count"></span></div>
      <input type="search" class="checks-filter tpl-skills-filter" placeholder="Filter skills…" autocomplete="off" />
      <div class="tpl-skills checks"></div>
    </div>
    <p class="skills-note tpl-resolved">${(t.resolved || []).length ? `Currently resolves to ${(t.resolved || []).length} skill(s): ${escapeHtml((t.resolved || []).join(", "))}` : ""}</p>
    <div class="skills-actions">
      <button type="button" class="tpl-save">${isNew ? "Create template" : "Save template"}</button>
      ${!isNew && !t.builtin ? '<button type="button" class="ghost danger-btn tpl-delete">Delete</button>' : ""}
      <button type="button" class="ghost tpl-cancel">Back to the list</button>
      <span class="skills-muted tpl-status"></span>
    </div>`;
  const box = mount.querySelector(".tpl-skills");
  box.dataset.kind = "s";
  checkboxList(box, accessGrantSkillOptions(SKILLS, t.skills || []), t.skills || []);
  wireChecksTools(box, mount.querySelector(".tpl-skills-filter"), mount.querySelector(".tpl-skills-count"));
  const status = mount.querySelector(".tpl-status");
  mount.querySelector(".tpl-cancel").addEventListener("click", () => { skillTplEditing = null; renderSkillTemplatesSettings(); });
  mount.querySelector(".tpl-save").addEventListener("click", async () => {
    status.textContent = "saving…";
    try {
      const body = {
        slug: mount.querySelector(".tpl-slug").value.trim(),
        name: mount.querySelector(".tpl-name").value.trim(),
        description: mount.querySelector(".tpl-desc").value.trim(),
        categories: [],
        skills: checkedValues(box),
      };
      const r = await api("/api/skills/templates", { method: "POST", body: JSON.stringify(body) });
      status.textContent = `saved — ${(r.template.resolved || []).length} skill(s)`;
      skillTplEditing = null;
      await renderSkillTemplatesSettings();
    } catch (err) {
      status.textContent = err.message;
    }
  });
  mount.querySelector(".tpl-delete")?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: `Delete the ${t.name} template?`, body: "Conversations that follow it keep only their own added skills afterwards.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/api/skills/templates/${encodeURIComponent(t.slug)}`, { method: "DELETE" });
      skillTplEditing = null;
      await renderSkillTemplatesSettings();
    } catch (err) {
      status.textContent = err.message;
    }
  });
}
