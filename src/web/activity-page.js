// Cookie-authenticated browser dashboard with self-hosted brand assets and no browser storage.
import crypto from "node:crypto";
import { activityConnectionsBrowser } from "./activity-connections-page.js";
import { callHistoryBrowser, CALL_HISTORY_CSS } from "./call-history-page.js";
import { automationBoardBrowser, AUTOMATION_BOARD_CSS, AUTOMATION_BOARD_HTML, AUTOMATION_ROI_HTML } from "./automation-board.js";
import { skillsBrowser, SKILLS_CSS, SKILLS_HTML } from "./skills-page.js";
import { getEmailAccountsEnabled, getLogoColor } from "../config/settings.js";
import { channelGateLogo } from "../config/appearance.js";
import { ACTIVITY_THEME_CSS } from "./activity-theme.js";
import { createSubscriptionUi, SUBSCRIPTION_CSS } from "../../public/subscription-ui.js";
import { DEFAULT_ACTIVITY_GROUP_ORDER, DEFAULT_ACTIVITY_GROUPING, ACTIVITY_COLUMNS, ACTIVITY_COLUMN_MIN_WIDTHS, ACTIVITY_COLUMN_MAX_WIDTH, ACTIVITY_COMMENT_MAX, ACTIVITY_HIDEABLE_COLUMNS } from "./activity-order.js";
import { activityAppHead, ACTIVITY_APP_COLORS } from "./activity-app.js";
import { CALL_OVERLAY_CSS, callOverlayBrowser, callOverlayConfig, callOverlayMarkup } from "./call-overlay.js";

// The header's theme switch, shared by every dashboard view. Matching the system choice clears
// the override, so the page follows the OS again; a failed save keeps the theme for this page only.
function themeBrowser(config, browser) {
  "use strict";
  const { base, csrf } = config;
  const { document } = browser;
  const themeButton = document.getElementById("theme-toggle"), root = document.documentElement, scheme = browser.matchMedia?.("(prefers-color-scheme: light)");
  const effectiveTheme = () => root?.dataset.theme || (scheme?.matches ? "light" : "dark");
  function paintTheme() {
    // Native window controls and the standalone fallback must follow the page override too.
    for (const id of ["app-theme-dark", "app-theme-light"]) {
      document.getElementById(id)?.setAttribute("content", config.themeColors[effectiveTheme()]);
    }
    if (!themeButton) return;
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    themeButton.setAttribute("aria-label", "Switch to " + next + " theme");
    themeButton.title = "Switch to " + next + " theme";
    themeButton.dataset.theme = effectiveTheme();
  }
  async function saveTheme(saved) {
    if (!root) return;
    if (saved === "system") delete root.dataset.theme; else root.dataset.theme = saved;
    paintTheme();
    try {
      await fetch(base + "/api/theme", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf }, body: JSON.stringify({ theme: saved }) });
    } catch { /* The page keeps the chosen theme; it simply is not remembered. */ }
  }
  themeButton?.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    void saveTheme(next === (scheme?.matches ? "light" : "dark") ? "system" : next);
  });
  scheme?.addEventListener?.("change", paintTheme);
  paintTheme();
  // On narrow screens the page links and the theme switch fold into one menu button.
  const menuButton = document.getElementById("nav-toggle"), header = menuButton?.closest?.(".top");
  function setMenu(open) {
    if (!menuButton || !header) return;
    menuButton.setAttribute("aria-expanded", String(open));
    if (open) header.dataset.menu = "open"; else delete header.dataset.menu;
  }
  menuButton?.addEventListener("click", () => { setMenu(menuButton.getAttribute("aria-expanded") !== "true"); });
  if (menuButton) {
    document.addEventListener?.("click", (event) => { if (header?.dataset.menu && !event.target?.closest?.("#page-menu, #nav-toggle")) setMenu(false); });
    document.addEventListener?.("keydown", (event) => { if (event.key === "Escape" && header?.dataset.menu) { setMenu(false); menuButton.focus?.(); } });
  }
  return { saveTheme, current: () => root?.dataset.theme || "system" };
}

// Kept as an ordinary function so the exact script served to browsers is testable without a bundler.
function activityBrowser(config, browser, subscriptionUi, callUi) {
  "use strict";
  callUi = callUi || null;
  const { base, csrf, defaultGroupOrder, defaultGrouping } = config;
  const voiceCalls = config.voiceCalls === true;
  const teamId = typeof config.teamId === "string" && /^[A-Z0-9]{2,32}$/.test(config.teamId) ? config.teamId : "";
  const { document, location, EventSource } = browser;
  const el = (id) => document.getElementById(id);
  const body = el("threads"), search = el("search"), tabs = el("filters");
  const pinnedBody = el("pinned-threads"), pinnedChannelList = el("pinned-channels");
  const pendingChannels = new Set(), channelNodes = new Map();
  let pinnedChannels = [];
  const isPinned = (row) => filter !== "done" && !row.hidden && !(row.status === "done" && row.dismissed) && (row.pinned || row.channelPinned);
  const filterLabels = { active: 1, working: 1, waiting: 1, error: 1, idle: 1, later: 1, done: 1, open: 1, hidden: 1 };
  const states = { working: "Working", waiting: "Waiting", error: "Error", done: "Done", later: "Later", idle: "Idle" };
  const pending = new Set(), nodes = new Map(), optimistic = new Map();
  const orderDialog = el("order-dialog"), orderList = el("order-list"), orderButton = el("group-order");
  const orderNodes = new Map();
  const grouping = el("group-by");
  let groupBy = defaultGrouping, groupByVersion = -1, savingGrouping = false;
  let completedGroupBy = "none";
  const allDoneButton = el("mark-all-done"), allDoneDialog = el("all-done-dialog");
  const historyButton = el("load-history");
  let loadingHistory = false, moreHistory = true;
  let completingAll = false;
  let groupOrder = [...defaultGroupOrder], groupOrderVersion = -1, draftOrder = [], savingOrder = false;
  let rows = [], filter = "active", ended = false, loaded = false, stream = null;
  // The server sends a window (newest 100 per group plus every working, waiting and pinned
  // thread) and the true totals; "Load more" widens the current group's window.
  let serverCounts = null, more = {}, loadingMore = false;
  const feedGroupOf = (view) => view === "hidden" ? "hidden" : view === "done" ? "done" : "open";
  let revision = 0, requestId = 0, lastUpdated = 0, connected = false;
  let unavailable = false, message = "", actionMessage = "";
  // Table columns: the viewer's saved order and pixel widths (unset = the stylesheet default).
  const columnMeta = config.columns;
  const columnIds = columnMeta.ids;
  const columnsDialog = el("columns-dialog"), columnsList = el("columns-list"), columnsButton = el("columns-button");
  const columnsNodes = new Map(), commentPending = new Set();
  let columnOrder = [...columnIds], columnWidths = {}, columnHidden = new Set(), columnsVersion = -1, columnsSource = "", columnsSaving = 0, columnsSeq = 0, columnsTimer = null;
  let resizing = null, dragging = null, draftColumns = [], draftWidths = {}, draftHidden = new Set(), columnsDialogSaving = false;
  // Touch screens (phones, tablets) keep a layout of their own, separate from the computer one.
  const columnsDevice = browser.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches === true ? "touch" : "desktop";
  const cleanHidden = (value) => new Set(Array.isArray(value) ? value.filter((id) => columnMeta.hideable.includes(id)) : []);
  const subscriptionRoot = el("subscriptions-cards"), quickRoot = el("subscription-quick"), subscriptionNotice = el("subscriptions-notice"), subscriptionButton = el("subscriptions-refresh");
  let subscriptionData = null, subscriptionPending = false, subscriptionGeneration = 0, subscriptionTimer = null, subscriptionPaused = false;
  function clearSubscriptions() {
    subscriptionGeneration++;
    if (subscriptionTimer !== null) browser.clearTimeout(subscriptionTimer);
    subscriptionTimer = null;
    subscriptionData = null;
    if (quickRoot) { quickRoot.innerHTML = ""; quickRoot.hidden = true; }
    if (subscriptionRoot) subscriptionRoot.innerHTML = "";
    if (subscriptionNotice) subscriptionNotice.textContent = "";
    if (subscriptionButton) subscriptionButton.disabled = true;
  }
  function paintSubscriptions() {
    if (!subscriptionData) return;
    const subscriptions = subscriptionData.subscriptions.filter(subscriptionUi.isSubscription);
    if (quickRoot) { quickRoot.innerHTML = subscriptionUi.summary(subscriptions); quickRoot.hidden = subscriptions.length === 0; }
    if (subscriptionRoot) subscriptionRoot.innerHTML = subscriptionUi.grouped(subscriptions);
    if (subscriptionNotice) subscriptionNotice.textContent = subscriptions.length ? "" : "No subscription accounts connected.";
  }
  async function refreshSubscriptions() {
    if (subscriptionTimer !== null) browser.clearTimeout(subscriptionTimer);
    subscriptionTimer = null;
    if (ended || subscriptionPaused || document.hidden || subscriptionPending || !subscriptionRoot && !quickRoot) return;
    const generation = subscriptionGeneration;
    subscriptionPending = true;
    if (subscriptionButton) { subscriptionButton.disabled = true; subscriptionButton.textContent = "Refreshing…"; }
    try {
      const response = await fetch(base + "/api/subscriptions", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (!ended && !document.hidden && generation === subscriptionGeneration) {
        if (!Array.isArray(data.subscriptions)) throw new Error("invalid subscriptions");
        subscriptionData = data; paintSubscriptions();
      }
    } catch {
      if (!ended && !document.hidden && generation === subscriptionGeneration && subscriptionNotice) subscriptionNotice.textContent = subscriptionData
        ? "Couldn’t refresh. Showing previous usage; limits may have changed." : "Subscription usage is temporarily unavailable.";
    } finally {
      subscriptionPending = false;
      if (!ended && !subscriptionPaused && !document.hidden) {
        if (generation !== subscriptionGeneration) void refreshSubscriptions();
        else {
          if (subscriptionButton) { subscriptionButton.disabled = false; subscriptionButton.textContent = "Refresh"; }
          subscriptionTimer = browser.setTimeout(refreshSubscriptions, 600_000);
        }
      }
    }
  }
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

  function validOrder(value) {
    return Array.isArray(value) && value.length === defaultGroupOrder.length
      && new Set(value).size === value.length && value.every((status) => defaultGroupOrder.includes(status));
  }
  function acceptOrder(data) {
    const version = Number.isSafeInteger(data.groupOrderVersion) && data.groupOrderVersion >= 0 ? data.groupOrderVersion : 0;
    if (validOrder(data.groupOrder) && version >= groupOrderVersion) {
      groupOrder = [...data.groupOrder]; groupOrderVersion = version;
    }
  }
  function acceptGrouping(data) {
    const version = Number.isSafeInteger(data.groupByVersion) && data.groupByVersion >= 0 ? data.groupByVersion : 0;
    if (["status", "channel"].includes(data.groupBy) && version >= groupByVersion) {
      groupBy = data.groupBy; groupByVersion = version;
    }
  }
  async function saveGrouping() {
    if (ended || savingGrouping) return;
    const selected = grouping.value;
    if (filter === "done") {
      if (["none", "status", "channel"].includes(selected)) completedGroupBy = selected;
      render();
      return;
    }
    if (!["status", "channel"].includes(selected)) return;
    savingGrouping = true; grouping.disabled = true;
    actionMessage = "";
    try {
      const response = await fetch(base + "/api/group-by", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ groupBy: selected }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return;
      if (!["status", "channel"].includes(data.groupBy)) throw new Error("invalid grouping");
      acceptGrouping(data);
      revision++; // Discard snapshots fetched before this save.
    } catch {
      if (!ended) actionMessage = "That grouping couldn’t be saved. Please try again.";
    } finally { savingGrouping = false; render(); connection(); }
  }
  function renderOrder() {
    draftOrder.forEach((status, index) => {
      let entry = orderNodes.get(status);
      if (!entry) {
        const item = node("li"), label = node("span", "order-label", states[status]);
        const controls = node("div", "order-moves");
        const buttons = [-1, 1].map((direction) => {
          const button = node("button", "order-move", direction < 0 ? "↑" : "↓");
          button.type = "button";
          button.dataset.status = status;
          button.dataset.direction = String(direction);
          button.setAttribute("aria-label", "Move " + states[status] + (direction < 0 ? " up" : " down"));
          return button;
        });
        controls.append(...buttons); item.append(label, controls);
        entry = { item, buttons }; orderNodes.set(status, entry);
      }
      entry.buttons[0].disabled = savingOrder || index === 0;
      entry.buttons[1].disabled = savingOrder || index === draftOrder.length - 1;
      if (orderList.children[index] !== entry.item) orderList.insertBefore(entry.item, orderList.children[index] || null);
    });
    for (const id of ["order-save", "order-cancel", "order-reset"]) el(id).disabled = savingOrder;
    el("order-save").textContent = savingOrder ? "Saving…" : "Save order";
  }
  async function saveOrder() {
    if (savingOrder || ended) return;
    savingOrder = true;
    el("order-error").textContent = "";
    renderOrder();
    try {
      const response = await fetch(base + "/api/group-order", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ groupOrder: draftOrder }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return;
      if (!validOrder(data.groupOrder)) throw new Error("invalid order");
      acceptOrder(data);
      revision++; // An older in-flight snapshot must not overwrite the saved order.
      orderDialog.close(); render();
    } catch {
      if (!ended) el("order-error").textContent = "That order couldn’t be saved. Please try again.";
    } finally { savingOrder = false; renderOrder(); }
  }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function validColumnOrder(value) {
    return Array.isArray(value) && value.length === columnIds.length && new Set(value).size === value.length && value.every((id) => columnIds.includes(id));
  }
  function clampWidth(id, width) {
    return Math.min(columnMeta.max, Math.max(columnMeta.min[id], Math.round(width)));
  }
  function cleanWidths(value) {
    const widths = {};
    if (value && typeof value === "object") for (const id of Object.keys(columnMeta.min)) {
      if (Object.hasOwn(value, id) && Number.isSafeInteger(value[id]) && clampWidth(id, value[id]) === value[id]) widths[id] = value[id];
    }
    return widths;
  }
  function acceptColumns(data) {
    // A drag, a resize or an unsaved change in flight owns the layout until it settles.
    if (resizing || dragging || columnsSaving || columnsTimer !== null || !data?.columns) return;
    // A touch screen without a saved layout of its own starts from the computer layout; its own
    // layout (once saved) always wins over that fallback, whatever the two version counters say.
    const own = columnsDevice === "touch" && data.columnsTouch && validColumnOrder(data.columnsTouch.order);
    const layout = own ? data.columnsTouch : data.columns, source = own ? "touch" : "desktop";
    const raw = own ? data.columnsTouchVersion : data.columnsVersion;
    const version = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    if (!validColumnOrder(layout.order) || (source === columnsSource && version < columnsVersion) || (columnsSource === "touch" && source !== "touch")) return;
    // Widths sized for a computer screen would push a tablet's columns off-screen, so a touch screen
    // without its own layout takes the computer order and hidden columns but the default widths.
    columnOrder = [...layout.order]; columnWidths = own || columnsDevice === "desktop" ? cleanWidths(layout.widths) : {}; columnHidden = cleanHidden(layout.hidden);
    columnsVersion = version; columnsSource = source;
    applyColumns();
  }
  const shownColumns = () => columnOrder.filter((id) => !columnHidden.has(id));
  function columnTracks() {
    return shownColumns().map((id) => Object.hasOwn(columnWidths, id) ? columnWidths[id] + "px" : columnMeta.templates[id]);
  }
  // With every flexible column resized to a fixed width, a trailing empty track takes up the
  // slack so a group heading still spans the whole row.
  function columnTemplate() {
    const tracks = columnTracks();
    return tracks.some((track) => /fr\b/.test(track)) ? tracks : [...tracks, "minmax(0,1fr)"];
  }
  function columnFloor() {
    return "calc(" + shownColumns().map((id) => Object.hasOwn(columnWidths, id) ? columnWidths[id] + "px" : columnMeta.floors[id]).join(" + ") + ")";
  }
  function headerRows() { return [...(document.querySelectorAll?.("thead tr") || [])]; }
  function paintTemplate() {
    const tracks = columnTemplate(), template = tracks.join(" "), floor = columnFloor(), gaps = String(tracks.length - 1);
    for (const table of [el("table"), el("pinned-table")]) {
      table?.style?.setProperty?.("--cols", template);
      table?.style?.setProperty?.("--tracks-min", floor);
      table?.style?.setProperty?.("--track-gaps", gaps);
    }
  }
  function placeCells(parent, cells) {
    columnOrder.forEach((id, index) => {
      const cell = cells[id];
      if (!cell) return;
      if (cell.hidden !== columnHidden.has(id)) cell.hidden = columnHidden.has(id);
      if (parent.children[index] !== cell) parent.insertBefore(cell, parent.children[index] || null);
    });
  }
  function applyColumns() {
    paintTemplate();
    for (const tr of headerRows()) {
      const cells = {};
      for (const th of tr.querySelectorAll("th")) if (th.dataset.col) cells[th.dataset.col] = th;
      placeCells(tr, cells);
    }
    for (const entry of nodes.values()) placeCells(entry.tr, entry.cells);
  }
  async function saveColumns(order = columnOrder, widths = columnWidths, hidden = columnHidden) {
    if (ended) return false;
    const seq = ++columnsSeq;
    columnsSaving++;
    try {
      const response = await fetch(base + "/api/columns", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ device: columnsDevice, order, widths, hidden: [...hidden] }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return false; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return false;
      if (!validColumnOrder(data.columns?.order)) throw new Error("invalid columns");
      revision++; // An older in-flight snapshot must not overwrite the saved layout.
      if (seq === columnsSeq && !resizing && !dragging) {
        columnOrder = [...data.columns.order]; columnWidths = cleanWidths(data.columns.widths); columnHidden = cleanHidden(data.columns.hidden);
        columnsVersion = Number.isSafeInteger(data.columnsVersion) ? data.columnsVersion : columnsVersion; columnsSource = columnsDevice;
        applyColumns();
      }
      return true;
    } catch {
      if (!ended) { actionMessage = "That column layout couldn’t be saved. Please try again."; notice(); }
      return false;
    } finally { columnsSaving--; }
  }
  // Keyboard resizing saves once the keys stop, not on every step.
  function saveColumnsSoon() {
    if (columnsTimer !== null) browser.clearTimeout(columnsTimer);
    columnsTimer = browser.setTimeout(() => { columnsTimer = null; void saveColumns(); }, 600);
  }
  function moveColumn(id, target, after) {
    if (id === target || !columnIds.includes(id) || !columnIds.includes(target)) return false;
    const order = columnOrder.filter((item) => item !== id);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
    if (order.join() === columnOrder.join()) return false;
    columnOrder = order; applyColumns();
    return true;
  }
  function renderColumnsDialog() {
    if (!columnsList) return;
    draftColumns.forEach((id, index) => {
      let entry = columnsNodes.get(id);
      if (!entry) {
        const item = node("li"), label = node("span", "order-label", columnMeta.labels[id]);
        const controls = node("div", "order-moves");
        const buttons = [-1, 1].map((direction) => {
          const button = node("button", "order-move", direction < 0 ? "↑" : "↓");
          button.type = "button"; button.dataset.column = id; button.dataset.direction = String(direction);
          button.setAttribute("aria-label", "Move " + columnMeta.labels[id] + (direction < 0 ? " left" : " right"));
          return button;
        });
        controls.append(...buttons); item.append(label, controls);
        // Optional columns get a Show switch; the conversation and its actions always stay.
        let show = null;
        if (columnMeta.hideable.includes(id)) {
          show = node("button", "order-show"); show.type = "button"; show.dataset.showColumn = id;
          item.append(show);
        }
        entry = { item, buttons, show }; columnsNodes.set(id, entry);
      }
      entry.buttons[0].disabled = columnsDialogSaving || index === 0;
      entry.buttons[1].disabled = columnsDialogSaving || index === draftColumns.length - 1;
      if (entry.show) {
        const visible = !draftHidden.has(id);
        entry.show.textContent = visible ? "Shown" : "Hidden";
        entry.show.setAttribute("aria-pressed", String(visible));
        entry.show.setAttribute("aria-label", (visible ? "Hide the " : "Show the ") + columnMeta.labels[id] + " column");
        entry.show.disabled = columnsDialogSaving;
        entry.item.dataset.hidden = visible ? "" : "1";
      }
      if (columnsList.children[index] !== entry.item) columnsList.insertBefore(entry.item, columnsList.children[index] || null);
    });
    for (const id of ["columns-save", "columns-cancel", "columns-reset"]) { const item = el(id); if (item) item.disabled = columnsDialogSaving; }
    const save = el("columns-save"); if (save) save.textContent = columnsDialogSaving ? "Saving…" : "Save columns";
  }
  function key(row) { return JSON.stringify([row.channelId, row.threadTs]); }
  function safeUrl(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin === location.origin && url.pathname.startsWith(base + "/open/") && !url.search && !url.hash && !url.username && !url.password) return url.href;
      return url.protocol === "https:" && !url.username && !url.password && !url.port &&
        (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) ? url.href : "";
    } catch { return ""; }
  }
  function link(anchor, url, app = false) {
    if (url) {
      anchor.href = url;
      anchor.target = app ? "_self" : "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.removeAttribute("aria-disabled");
    } else {
      anchor.removeAttribute("href");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  // The channel name opens the conversation itself in the Slack app (Ctrl/⌘-click: in the browser).
  // Only a bare Slack team and conversation id are linked; Slack enforces its own access on open.
  function channelLink(anchor, channelId) {
    const id = typeof channelId === "string" && /^[CDG][A-Z0-9]{1,32}$/.test(channelId) ? channelId : "";
    const name = anchor.textContent;
    if (teamId && id) {
      anchor.href = "slack://channel?team=" + teamId + "&id=" + id;
      anchor.target = "_self";
      anchor.rel = "noopener noreferrer";
      anchor.dataset.web = "https://app.slack.com/client/" + teamId + "/" + id;
      anchor.removeAttribute("aria-disabled");
      anchor.setAttribute("aria-label", "Open " + name + " in Slack");
      anchor.title = "Open " + name + " in Slack · Ctrl/⌘-click opens it in the browser";
    } else {
      anchor.removeAttribute("href");
      anchor.dataset.web = "";
      anchor.setAttribute("aria-disabled", "true");
      anchor.removeAttribute("aria-label");
      anchor.title = name;
    }
  }
  function connection() {
    const stale = lastUpdated && Date.now() - lastUpdated > 90_000;
    el("connection").className = "connection " + (ended ? "offline" : connected && !stale ? "live" : "reconnecting");
    el("connection-text").textContent = ended ? "Session ended" : stale ? "Updates delayed" : connected ? "Live updates" : "Reconnecting…";
    el("updated").textContent = lastUpdated ? "Updated " + timeFormat.format(lastUpdated) : "Waiting for updates";
  }
  function notice() {
    const text = ended ? "Your access has ended or this session has expired. Sign in with a passkey or open Dashboard again from Slack." :
      actionMessage || message || (unavailable ? "Some activity is temporarily unavailable. We’ll keep trying to refresh it." : "");
    el("notice").textContent = text;
    el("notice").hidden = !text;
  }
  function endAccess() {
    ended = true;
    clearSubscriptions();
    if (subscriptionNotice) subscriptionNotice.textContent = "Your session has ended. Sign in with a passkey or open Dashboard again from Slack.";
    if (subscriptionButton) subscriptionButton.textContent = "Refresh";
    connected = false;
    stream?.close();
    rows = [];
    // The server totals and "Load more" windows describe data this viewer may no longer see.
    serverCounts = null;
    more = {};
    pinnedChannels = [];
    pendingChannels.clear();
    pending.clear();
    lastUpdated = 0;
    search.value = "";
    search.disabled = true;
    orderButton.disabled = true;
    grouping.disabled = true;
    orderDialog.close();
    allDoneDialog.close();
    columnsDialog?.close();
    if (columnsButton) columnsButton.disabled = true;
    if (el("columns-quick")) el("columns-quick").disabled = true;
    el("all-done-error").textContent = "";
    actionMessage = "";
    message = "";
    for (const button of tabs.querySelectorAll("button")) button.disabled = true;
    render();
    connection();
  }
  function accept(data) {
    if (ended || !data || !Array.isArray(data.rows)) return false;
    rows = data.rows.filter((row) => row && typeof row.channelId === "string" && typeof row.threadTs === "string")
      .map((row) => ({ ...row, status: Object.hasOwn(states, row.status) ? row.status : "idle", comment: typeof row.comment === "string" ? row.comment : "" }))
      // A Done/Hide/Later/Pin click in flight keeps its optimistic look over any snapshot that
      // lands before the write is confirmed, so the row never flickers back.
      .map((row) => optimistic.has(key(row)) ? { ...row, ...optimistic.get(key(row)) } : row);
    serverCounts = data.counts && typeof data.counts === "object" ? data.counts : null;
    more = data.more && typeof data.more === "object" ? data.more : {};
    pinnedChannels = Array.isArray(data.pinnedChannels) ? data.pinnedChannels.filter((entry) => entry
      && typeof entry.channelId === "string" && typeof entry.channelName === "string") : [];
    acceptOrder(data);
    acceptGrouping(data);
    acceptColumns(data);
    revision++;
    loaded = true;
    unavailable = Boolean(data.unavailable);
    message = "";
    lastUpdated = Date.now();
    render();
    connection();
    return true;
  }
  function makeRow(rowKey) {
    const tr = node("tr");
    const titleCell = node("td", "thread-cell"), title = node("a", "thread-title");
    titleCell.append(title);
    // A private one-line note: Enter or leaving the field saves it, Escape restores the saved one.
    const commentCell = node("td", "comment-cell"), comment = node("input", "comment-input");
    comment.type = "text"; comment.placeholder = "Add a comment";
    comment.setAttribute("maxlength", String(columnMeta.commentMax));
    comment.setAttribute("autocomplete", "off");
    comment.dataset.key = rowKey;
    commentCell.append(comment);
    const channelCell = node("td", "channel-cell"), channel = node("a", "channel-link");
    const channelPin = node("button", "toggle channel-pin");
    channelPin.type = "button"; channelPin.dataset.channelId = "";
    channelCell.append(channel, channelPin);
    const statusCell = node("td", "status-cell"), pill = node("span", "pill");
    const dot = node("span", "status-dot"), statusText = node("span"), elapsed = node("span", "elapsed");
    dot.setAttribute("aria-hidden", "true");
    pill.append(dot, statusText, elapsed);
    statusCell.append(pill);
    const timeCell = node("td", "time-cell"), time = node("time");
    timeCell.append(time);
    const actions = node("td", "actions"), open = node("a", "open-link", "Open in Slack"), toggle = node("button", "toggle");
    toggle.type = "button";
    toggle.dataset.key = rowKey;
    const delay = node("button", "toggle");
    delay.type = "button"; delay.dataset.key = rowKey; delay.dataset.operation = "later";
    const pin = node("button", "toggle");
    pin.type = "button"; pin.dataset.key = rowKey; pin.dataset.operation = "pin";
    const links = node("div", "action-links"), state = node("div", "action-state");
    links.append(open);
    // A voice call bound to this thread (web/call-overlay.js), only while the gateway offers calls.
    const call = node("a", "call-link", "Call the agent");
    call.href = "#call";
    if (voiceCalls) links.append(call);
    const hide = node("button", "toggle");
    hide.type = "button"; hide.dataset.key = rowKey; hide.dataset.operation = "hide";
    state.append(toggle, delay, pin, hide);
    // Narrow screens show Open and Done; "More" unfolds the rest of the row's actions, labelled.
    const more = node("button", "more-toggle", "More actions");
    more.type = "button"; more.setAttribute("aria-expanded", "false"); more.title = "More actions";
    more.addEventListener("click", () => {
      const open = tr.dataset.more === undefined;
      more.setAttribute("aria-expanded", String(open)); more.title = more.textContent = open ? "Fewer actions" : "More actions";
      if (open) tr.dataset.more = ""; else delete tr.dataset.more;
    });
    actions.append(links, state, more);
    const cells = { conversation: titleCell, comment: commentCell, channel: channelCell, status: statusCell, last: timeCell, actions };
    placeCells(tr, cells);
    const entry = { tr, cells, title, comment, saved: "", channel, channelPin, pill, statusText, elapsed, time, open, call, toggle, delay, hide, pin, since: 0, stamp: 0 };
    comment.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault?.(); comment.blur?.(); }
      else if (event.key === "Escape") { comment.value = entry.saved; delete comment.dataset.state; comment.blur?.(); }
    });
    comment.addEventListener("change", () => { void saveComment(rowKey, comment.value); });
    return entry;
  }
  function matches(row) {
    if (Boolean(row.hidden) !== (filter === "hidden")) return false;
    if (filter === "active" && row.status === "done" && row.dismissed) return false;
    if (filter !== "hidden" && !isPinned(row)) {
      if (filter === "active" && row.status === "later") return false;
      if (filter === "open" && row.status === "done") return false;
      if (filter !== "active" && filter !== "open" && row.status !== filter) return false;
    }
    const query = search.value.trim().toLocaleLowerCase();
    return !query || (String(row.title || "") + " " + String(row.channelName || "") + " " + String(row.comment || "")).toLocaleLowerCase().includes(query);
  }
  // Compact clocks: "4m 12s" for running work, "5m"/"8h"/"6d" since the last message.
  function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + String(seconds % 60).padStart(2, "0") + "s";
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? hours + "h " + String(minutes % 60).padStart(2, "0") + "m" : Math.floor(hours / 24) + "d " + (hours % 24) + "h";
  }
  function ago(stamp, now) {
    const minutes = Math.floor((now - stamp) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return minutes + "m";
    if (minutes < 1440) return Math.floor(minutes / 60) + "h";
    if (minutes < 10_080) return Math.floor(minutes / 1440) + "d";
    return shortDate.format(stamp);
  }
  function clock(entry, now = Date.now()) {
    entry.elapsed.textContent = entry.since ? duration(now - entry.since) : "";
    entry.elapsed.hidden = !entry.since;
    if (entry.since) entry.pill.title = "Running for " + duration(now - entry.since);
    else entry.pill.removeAttribute("title");
    entry.time.textContent = entry.stamp ? ago(entry.stamp, now) : "—";
    if (entry.stamp) {
      const date = new Date(entry.stamp);
      entry.time.dateTime = date.toISOString();
      entry.time.title = dateFormat.format(date);
    } else {
      entry.time.removeAttribute("datetime");
      entry.time.removeAttribute("title");
    }
  }
  function render() {
    const currentGrouping = filter === "done" ? completedGroupBy : groupBy;
    const counts = { active: 0, open: 0, working: 0, waiting: 0, error: 0, idle: 0, later: 0, done: 0, hidden: 0 };
    for (const row of rows) { if (row.hidden) { counts.hidden++; continue; } counts[row.status]++; if (row.status !== "done") counts.open++; if (row.status !== "later" && !(row.status === "done" && row.dismissed)) counts.active++; }
    if (serverCounts) for (const name of Object.keys(counts)) if (Number.isSafeInteger(serverCounts[name])) counts[name] = Math.max(counts[name], serverCounts[name]);
    const loadMore = el("load-more");
    if (loadMore) {
      loadMore.hidden = ended || !loaded || !more[feedGroupOf(filter)];
      loadMore.disabled = loadingMore;
      loadMore.textContent = loadingMore ? "Loading…" : "Load more";
    }
    for (const button of tabs.querySelectorAll("button")) {
      const selected = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(selected));
      button.querySelector("span").textContent = String(counts[button.dataset.filter]);
    }
    // Narrow screens pick the status from a menu instead of the tab strip.
    const filterSelect = el("filter-select");
    if (filterSelect) {
      for (const option of filterSelect.options || []) option.textContent = option.dataset.label + " · " + counts[option.value];
      filterSelect.value = filter; filterSelect.disabled = ended;
    }
    el("summary").textContent = counts.active + " visible · " + counts.done + " done · " + counts.later + " later · " + counts.working + " working · " + counts.waiting + " waiting";
    const rank = (status) => status === "done" ? groupOrder.length + 1 : status === "later" ? groupOrder.length : groupOrder.indexOf(status);
    grouping.disabled = ended || savingGrouping;
    if (el("group-none")) el("group-none").hidden = el("group-none").disabled = filter !== "done";
    if (!savingGrouping) grouping.value = currentGrouping;
    body.dataset.groupBy = currentGrouping;
    pinnedBody.dataset.groupBy = currentGrouping;
    const channelHue = (id) => { let hash = 0; for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; return hash % 8; };
    const channelName = (row) => String(row.channelName || "Conversation");
    const groupKey = (row) => currentGrouping === "channel" ? row.channelId : row.status;
    const filtered = ended ? [] : rows.filter(matches);
    // Rank whole channel cards by their newest visible conversation, on every snapshot.
    const channelActivity = new Map();
    for (const row of filtered) {
      channelActivity.set(row.channelId, Math.max(channelActivity.get(row.channelId) || 0, Number(row.lastMessageMs) || 0));
    }
    const compareChannel = (a, b) => channelActivity.get(b.channelId) - channelActivity.get(a.channelId)
      || channelName(a).localeCompare(channelName(b)) || a.channelId.localeCompare(b.channelId);
    const newest = (a, b) => (Number(b.lastMessageMs) || 0) - (Number(a.lastMessageMs) || 0);
    const latest = filter === "done" ? (a, b) => (Number(b.completedMs) || 0) - (Number(a.completedMs) || 0) || newest(a, b) : newest;
    const compareRows = (a, b) => (currentGrouping === "channel" ? compareChannel(a, b) : 0) || rank(a.status) - rank(b.status) || latest(a, b);
    // Individual pins lead the conversations inherited from a channel pin, within each channel.
    const comparePinned = (a, b) => (currentGrouping === "channel" ? compareChannel(a, b) : 0)
      || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || (currentGrouping === "channel" ? rank(a.status) - rank(b.status) : 0) || latest(a, b);
    const pinned = filtered.filter(isPinned).sort(comparePinned);
    const ordinary = filtered.filter((row) => !isPinned(row)).sort(compareRows);
    const groupPinned = currentGrouping === "channel";
    // A stable hue per channel, nudged when it would match the card directly above it.
    const hues = new Map();
    for (const section of currentGrouping === "channel" ? [pinned, ordinary] : []) {
      let previous = -1;
      for (const row of section) {
        if (hues.has(section === pinned ? "p" + row.channelId : row.channelId)) continue;
        let hue = channelHue(row.channelId);
        if (hue === previous) hue = (hue + 1) % 8;
        hues.set(section === pinned ? "p" + row.channelId : row.channelId, hue); previous = hue;
      }
    }
    // The table carries the mode too, so its header lines up with the cards' indented cells.
    for (const element of [body, el("table")]) if (currentGrouping === "channel") element.dataset.cards = ""; else delete element.dataset.cards;
    for (const element of [pinnedBody, el("pinned-table")]) if (groupPinned) element.dataset.cards = ""; else delete element.dataset.cards;
    const shown = [...pinned, ...ordinary];
    const visible = new Set(shown.map(key));
    const groupSize = new Map();
    for (const row of ordinary) groupSize.set(groupKey(row), (groupSize.get(groupKey(row)) || 0) + 1);
    const pinnedGroupSize = new Map();
    for (const row of pinned) pinnedGroupSize.set(groupKey(row), (pinnedGroupSize.get(groupKey(row)) || 0) + 1);
    for (const [rowKey, entry] of nodes) {
      if (!visible.has(rowKey)) { entry.tr.remove(); nodes.delete(rowKey); }
    }
    shown.forEach((row, index) => {
      const rowKey = key(row);
      let entry = nodes.get(rowKey);
      if (!entry) { entry = makeRow(rowKey); nodes.set(rowKey, entry); }
      const title = String(row.title || "Untitled conversation"), url = safeUrl(row.url);
      const app = Boolean((!row.platform || row.platform === "slack") && url && new URL(url).origin === location.origin);
      entry.title.textContent = title;
      entry.title.title = title;
      entry.saved = row.comment;
      // Never overwrite what the person is typing, saving, or failed to save.
      if (document.activeElement !== entry.comment && !commentPending.has(rowKey) && entry.comment.dataset.state !== "error") entry.comment.value = row.comment;
      entry.comment.title = row.comment || "Add a private comment";
      entry.comment.setAttribute("aria-label", "Comment on: " + title);
      entry.comment.disabled = ended;
      link(entry.title, url, app);
      entry.channel.textContent = String(row.channelName || "Conversation");
      channelLink(entry.channel, row.channelId);
      paintChannelPin(entry.channelPin, row.channelId, row.channelName, Boolean(row.channelPinned));
      entry.tr.className = "row s-" + row.status;
      // Label each group on its first conversation, preserving row controls and focus.
      const saved = isPinned(row);
      const localIndex = saved ? index : index - pinned.length;
      const sectionRows = saved ? pinned : ordinary, sizes = saved ? pinnedGroupSize : groupSize;
      if (currentGrouping !== "none" && (!saved || groupPinned) && (localIndex === 0 || groupKey(sectionRows[localIndex - 1]) !== groupKey(row))) entry.tr.dataset.group = (currentGrouping === "channel" ? channelName(row) : states[row.status]) + " · " + sizes.get(groupKey(row));
      else delete entry.tr.dataset.group;
      // Channel groups render as cards: a per-channel hue, and the closing row rounds the card off.
      if (currentGrouping === "channel" && (!saved || groupPinned)) {
        entry.tr.dataset.hue = String(hues.get(saved ? "p" + row.channelId : row.channelId));
        if (localIndex === sectionRows.length - 1 || groupKey(sectionRows[localIndex + 1]) !== groupKey(row)) entry.tr.dataset.groupEnd = "";
        else delete entry.tr.dataset.groupEnd;
      } else { delete entry.tr.dataset.hue; delete entry.tr.dataset.groupEnd; }
      entry.pill.className = "pill " + row.status;
      entry.statusText.textContent = states[row.status];
      const since = Number(row.workingSinceMs);
      entry.since = row.status === "working" && Number.isSafeInteger(since) && since > 0 ? since : 0;
      const stamp = Number(row.lastMessageMs), date = new Date(stamp);
      const validDate = stamp > 0 && Number.isFinite(date.getTime());
      entry.stamp = validDate ? stamp : 0;
      clock(entry);
      link(entry.open, url, app);
      entry.open.dataset.app = app ? "1" : "";
      entry.open.dataset.platform = row.platform || "slack";
      const platformName = row.platform === "googlechat" ? "Google Chat" : row.platform === "msteams" ? "Microsoft Teams" : "Slack";
      entry.open.textContent = "Open in " + platformName;
      entry.open.setAttribute("aria-label", "Open in " + platformName + ": " + title);
      entry.open.title = app ? "Open in Slack · Ctrl/⌘-click opens it in the browser" : "Open in " + platformName;
      if (voiceCalls && /^[A-Z0-9_]{1,32}$/.test(String(row.channelId)) && /^\d{1,13}\.\d{1,6}$/.test(String(row.threadTs))) {
        entry.call.dataset.channelId = row.channelId; entry.call.dataset.threadTs = row.threadTs;
        entry.call.dataset.channelName = String(row.channelName || ""); entry.call.dataset.title = title;
        entry.call.title = "Call the agent about this conversation";
        entry.call.setAttribute("aria-label", "Call the agent: " + title);
      }
      const busy = pending.has(rowKey);
      entry.delay.hidden = row.status === "done" || row.canComplete === false || row.hidden;
      entry.toggle.hidden = row.canComplete === false || row.hidden;
      entry.hide.disabled = busy || completingAll || ended;
      entry.hide.textContent = row.hidden ? "Show" : "Hide";
      entry.hide.dataset.state = row.hidden ? "show" : "hide";
      entry.hide.title = row.hidden ? "Show in my activity" : "Hide from my activity; your next message brings it back";
      entry.hide.setAttribute("aria-label", (row.hidden ? "Show: " : "Hide: ") + title);
      entry.delay.disabled = busy || completingAll || ended;
      entry.delay.textContent = busy ? "Saving…" : row.status === "later" ? "Resume" : "Later";
      entry.delay.dataset.state = busy ? "busy" : row.status === "later" ? "resume" : "later";
      entry.delay.title = row.status === "later" ? "Resume" : "Later";
      entry.delay.setAttribute("aria-label", (row.status === "later" ? "Resume: " : "Delay for later: ") + title);
      entry.toggle.disabled = busy || completingAll || ended;
      const selfDone = row.status === "done" && row.dismissed;
      entry.toggle.textContent = busy ? "Saving…" : selfDone ? "Reopen" : "Done";
      entry.toggle.dataset.state = busy ? "busy" : selfDone ? "reopen" : "done";
      entry.toggle.title = selfDone ? "Reopen" : "Mark done and remove from my Active view";
      entry.toggle.setAttribute("aria-label", (selfDone ? "Reopen: " : "Mark done: ") + title);
      entry.pin.disabled = busy || completingAll || ended;
      entry.pin.textContent = row.pinned ? "Unpin" : "Pin";
      entry.pin.dataset.state = row.pinned ? "unpin" : "pin";
      entry.pin.title = row.pinned ? "Unpin conversation" : "Pin conversation";
      entry.pin.setAttribute("aria-label", (row.pinned ? "Unpin: " : "Pin: ") + title);
      entry.pin.setAttribute("aria-pressed", String(Boolean(row.pinned)));
      const target = saved ? pinnedBody : body;
      if (target.children[localIndex] !== entry.tr) target.insertBefore(entry.tr, target.children[localIndex] || null);
    });
    const query = search.value.trim().toLocaleLowerCase();
    const channels = ended || filter === "hidden" || filter === "done" ? [] : pinnedChannels.filter((entry) => !query || entry.channelName.toLocaleLowerCase().includes(query)
      || pinned.some((row) => row.channelId === entry.channelId))
      .sort((a, b) => a.channelName.localeCompare(b.channelName) || a.channelId.localeCompare(b.channelId));
    const visibleChannels = new Set(channels.map((entry) => entry.channelId));
    for (const [id, entry] of channelNodes) if (!visibleChannels.has(id)) { entry.card.remove(); channelNodes.delete(id); }
    channels.forEach((channel, index) => {
      let entry = channelNodes.get(channel.channelId);
      if (!entry) {
        const card = node("div", "pinned-channel"), name = node("a", "channel-link"), count = node("span", "pinned-channel-count"), button = node("button", "toggle channel-pin");
        button.type = "button"; card.append(name, count, button);
        entry = { card, name, count, button }; channelNodes.set(channel.channelId, entry);
      }
      entry.name.textContent = channel.channelName;
      channelLink(entry.name, channel.channelId);
      const open = rows.filter((row) => row.channelId === channel.channelId && !row.hidden && !(row.status === "done" && row.dismissed)).length;
      // A populated channel already has its full card above; keep the compact control for
      // empty channels and for Status grouping, where channel cards are not rendered.
      entry.card.hidden = groupPinned && open > 0 && pinned.some((row) => row.channelId === channel.channelId);
      entry.count.textContent = open ? open + " visible" : "No visible conversations";
      entry.card.dataset.channelId = channel.channelId;
      paintChannelPin(entry.button, channel.channelId, channel.channelName, true);
      if (pinnedChannelList.children[index] !== entry.card) pinnedChannelList.insertBefore(entry.card, pinnedChannelList.children[index] || null);
    });
    pinnedChannelList.hidden = channels.every((channel) => channelNodes.get(channel.channelId).card.hidden);
    el("pinned-section").hidden = pinned.length === 0 && channels.length === 0;
    el("pinned-count").textContent = String(pinned.length);
    el("table").hidden = ordinary.length === 0;
    el("empty").hidden = shown.length > 0 || ended;
    el("empty-title").textContent = !loaded ? "Loading your activity…" : search.value.trim() ? "No matching conversations" : filter === "hidden" ? "No hidden conversations" : filter === "later" ? "Nothing saved for later" : filter === "done" ? "No completed conversations" : "You’re all caught up";
    el("empty-copy").textContent = !loaded ? "Your latest conversations will appear here." : search.value.trim() ? "Try a different title or channel name." : filter === "hidden" ? "Hide only affects your list. Show a conversation here or send a new message to bring it back." : filter === "later" ? "Use Delay for later or the agent’s 👎 button to postpone a conversation. Resume it when you’re ready." : filter === "done" ? "Completed conversations appear here. Work you complete yourself leaves Active; work completed by others stays there until you Hide it." : "Conversations matching this view will appear as activity arrives.";
    el("result-count").textContent = ended ? "" : shown.length + (shown.length === 1 ? " conversation" : " conversations");
    historyButton.disabled = ended || !loaded || loadingHistory || !moreHistory;
    historyButton.textContent = loadingHistory ? "Loading older threads…" : moreHistory ? "Load older threads" : "History loaded";
    historyButton.setAttribute("aria-busy", String(loadingHistory));
    renderAllDone();
    notice();
  }
  function paintChannelPin(button, channelId, name, pinned) {
    button.dataset.channelId = channelId;
    button.dataset.state = pinned ? "unpin" : "pin";
    button.textContent = pinned ? "Unpin channel" : "Pin channel";
    button.title = pinned ? "Unpin channel" : "Pin channel and its visible conversations";
    button.setAttribute("aria-label", (pinned ? "Unpin channel: " : "Pin channel: ") + String(name || "Conversation"));
    button.setAttribute("aria-pressed", String(pinned));
    button.disabled = ended || pendingChannels.has(channelId);
  }
  async function pinChannel(channelId) {
    if (ended || pendingChannels.has(channelId)) return;
    const pinned = pinnedChannels.some((entry) => entry.channelId === channelId);
    pendingChannels.add(channelId); actionMessage = ""; render();
    try {
      const response = await fetch(base + "/api/channel-pin", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ channelId, pinned: !pinned }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      revision++; // A fetch started before this preference write must not overwrite it.
      await refresh();
    } catch { if (!ended) actionMessage = "That channel pin couldn’t be saved. Please try again."; }
    finally { pendingChannels.delete(channelId); render(); }
  }
  function renderAllDone() {
    allDoneButton.disabled = ended || !loaded || completingAll || pending.size > 0;
    el("all-done-confirm").disabled = ended || completingAll || pending.size > 0;
    el("all-done-cancel").disabled = completingAll;
    el("all-done-confirm").textContent = completingAll ? "Marking all done…" : "Mark All Done";
    allDoneDialog.setAttribute("aria-busy", String(completingAll));
  }
  async function completeAll() {
    if (ended || completingAll || pending.size > 0 || !allDoneDialog.open) return;
    completingAll = true;
    actionMessage = "";
    el("all-done-error").textContent = "";
    render();
    try {
      const response = await fetch(base + "/api/completion-all", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ confirmed: true }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return;
      if (![data.marked, data.skipped, data.failed].every((count) => Number.isSafeInteger(count) && count >= 0)) throw new Error("invalid result");
      const noun = data.marked === 1 ? " thread" : " threads";
      actionMessage = "Marked " + data.marked + noun + " done. " + data.skipped + " skipped. " + data.failed + " failed."
        + (data.failed ? " You can retry Mark All Done for the remaining open threads." : "");
      allDoneDialog.close();
      revision++; // A snapshot requested before completion cannot overwrite the refresh.
      await refresh();
    } catch {
      if (!ended) el("all-done-error").textContent = "Mark All Done couldn’t finish. Some threads may already be done. You can safely try again.";
    } finally { completingAll = false; render(); }
  }
  async function loadHistory() {
    if (ended || !loaded || loadingHistory || !moreHistory) return;
    loadingHistory = true;
    actionMessage = "";
    render();
    try {
      const response = await fetch(base + "/api/history", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: "{}",
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return;
      if (!data.history || typeof data.history.moreHistory !== "boolean") throw new Error("invalid history");
      moreHistory = data.history.moreHistory;
      actionMessage = data.history.unavailable ? "Some older threads couldn’t be loaded. Please try again later."
        : moreHistory ? "Older threads loaded. More history is available." : "All available tracked history has been loaded.";
      // SSE can advance while indexing. Refresh current rows instead of applying an older result.
      revision++;
      await refresh();
    } catch {
      if (!ended) actionMessage = "Older threads couldn’t be loaded. Please try again.";
    } finally { loadingHistory = false; render(); }
  }
  async function refresh() {
    if (ended) return;
    const startRevision = revision, id = ++requestId;
    try {
      const response = await fetch(base + "/api/threads", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      // An SSE snapshot or a newer fetch always wins over an older in-flight request.
      if (!ended && startRevision === revision && id === requestId && !accept(data)) throw new Error("invalid snapshot");
    } catch {
      if (ended || startRevision !== revision || id !== requestId) return;
      message = "Activity couldn’t refresh. We’ll try again automatically.";
      notice();
    }
  }
  async function saveComment(rowKey, value) {
    const row = rows.find((item) => key(item) === rowKey), entry = nodes.get(rowKey);
    if (ended || !row || !entry || commentPending.has(rowKey)) return;
    const text = String(value).replace(/\s+/g, " ").trim();
    if (text === row.comment) { entry.comment.value = text; delete entry.comment.dataset.state; return; }
    commentPending.add(rowKey);
    entry.comment.dataset.state = "saving";
    actionMessage = "";
    try {
      const response = await fetch(base + "/api/comment", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ channelId: row.channelId, threadTs: row.threadTs, comment: text }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (ended) return;
      for (const item of rows) if (key(item) === rowKey) item.comment = typeof data.comment === "string" ? data.comment : text;
      delete entry.comment.dataset.state;
      if (document.activeElement !== entry.comment) entry.comment.value = rows.find((item) => key(item) === rowKey)?.comment ?? text;
      revision++; // A snapshot fetched before this save must not bring back the old comment.
    } catch {
      if (!ended) { entry.comment.dataset.state = "error"; actionMessage = "That comment couldn’t be saved. Edit it to try again."; }
    } finally {
      commentPending.delete(rowKey);
      render();
    }
  }
  async function complete(rowKey, operation = "completion") {
    if (ended || completingAll || pending.has(rowKey)) return;
    const row = rows.find((item) => key(item) === rowKey);
    if (!row) return;
    const field = operation === "hide" ? "hidden" : operation === "pin" ? "pinned" : operation === "later" ? "later" : "done";
    const value = operation === "hide" ? !row.hidden : operation === "pin" ? !row.pinned : operation === "later" ? row.status !== "later" : row.status !== "done" || !row.dismissed;
    // Apply the change locally at once: the server still rechecks access and adds the Slack ✅,
    // but the row must leave the view on click, not after those round trips and a full refresh.
    const patch = operation === "hide" ? { hidden: value } : operation === "pin" ? { pinned: value }
      : operation === "later" ? (value ? { status: "later" } : null) : value ? { status: "done", dismissed: true } : null;
    const previous = patch && Object.fromEntries(Object.keys(patch).map((name) => [name, row[name]]));
    pending.add(rowKey);
    if (patch) { optimistic.set(rowKey, patch); Object.assign(row, patch); }
    actionMessage = "";
    render();
    try {
      const response = await fetch(base + "/api/" + operation, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ channelId: row.channelId, threadTs: row.threadTs, [field]: value }),
      });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      optimistic.delete(rowKey); // Saved: the server's snapshot is authoritative from here on.
      await refresh();
    } catch {
      if (!ended) {
        actionMessage = "That change couldn’t be saved. Please try again.";
        if (patch) { const current = rows.find((item) => key(item) === rowKey); if (current) Object.assign(current, previous); }
      }
    } finally {
      optimistic.delete(rowKey);
      pending.delete(rowKey);
      render();
    }
  }
  el("filter-select")?.addEventListener("change", (event) => {
    if (ended || !Object.hasOwn(filterLabels, event.target.value)) return;
    filter = event.target.value; render();
  });
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button || ended) return;
    filter = button.dataset.filter;
    render();
  });
  historyButton.addEventListener("click", () => { void loadHistory(); });
  allDoneButton.addEventListener("click", () => {
    if (ended || !loaded || completingAll || pending.size > 0) return;
    el("all-done-error").textContent = "";
    renderAllDone();
    allDoneDialog.showModal();
    el("all-done-cancel").focus();
  });
  el("all-done-cancel").addEventListener("click", () => { if (!completingAll) allDoneDialog.close(); });
  el("all-done-confirm").addEventListener("click", () => { void completeAll(); });
  allDoneDialog.addEventListener("cancel", (event) => { if (completingAll) event.preventDefault(); });
  orderButton.addEventListener("click", () => {
    if (ended) return;
    draftOrder = [...groupOrder];
    el("order-error").textContent = "";
    renderOrder(); orderDialog.showModal();
  });
  orderList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button || button.disabled || savingOrder || ended) return;
    const index = draftOrder.indexOf(button.dataset.status), next = index + Number(button.dataset.direction);
    if (index < 0 || next < 0 || next >= draftOrder.length) return;
    [draftOrder[index], draftOrder[next]] = [draftOrder[next], draftOrder[index]];
    renderOrder();
    const buttons = orderNodes.get(button.dataset.status).buttons;
    (button.disabled ? buttons.find((item) => !item.disabled) : button)?.focus();
  });
  el("order-reset").addEventListener("click", () => { if (!savingOrder && !ended) { draftOrder = [...defaultGroupOrder]; renderOrder(); } });
  el("order-cancel").addEventListener("click", () => { if (!savingOrder) orderDialog.close(); });
  el("order-save").addEventListener("click", () => { void saveOrder(); });
  orderDialog.addEventListener("cancel", (event) => { if (savingOrder) event.preventDefault(); });
  grouping.addEventListener("change", () => { void saveGrouping(); });
  // Column headers: drag a header to move it, drag its edge to resize, double-click the edge to
  // reset it. The edge is also a focusable separator (←/→, Shift for larger steps, Home resets).
  function headerHandlers(head) {
    head.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest?.(".col-resize"), th = handle?.closest?.("th");
      if (!handle || !th?.dataset.col || ended || event.button > 0) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      handle.dataset.active = "";
      th.draggable = false; // A resize must never become a column drag.
      document.documentElement.classList?.add("col-resizing");
      resizing = { id: th.dataset.col, handle, startX: event.clientX, start: th.getBoundingClientRect().width, moved: false };
    });
    head.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      const width = clampWidth(resizing.id, resizing.start + event.clientX - resizing.startX);
      if (Math.abs(event.clientX - resizing.startX) < 2 && !resizing.moved) return;
      resizing.moved = true; columnWidths[resizing.id] = width; paintTemplate();
    });
    const finish = () => {
      if (!resizing) return;
      const { handle, moved } = resizing;
      delete handle.dataset.active;
      const th = handle.closest?.("th"); if (th) th.draggable = columnsDevice === "desktop";
      document.documentElement.classList?.remove("col-resizing");
      resizing = null;
      if (moved) void saveColumns();
    };
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
    head.addEventListener("lostpointercapture", finish);
    head.addEventListener("dblclick", (event) => {
      const th = event.target.closest?.(".col-resize")?.closest?.("th");
      if (!th?.dataset.col || ended || !Object.hasOwn(columnWidths, th.dataset.col)) return;
      delete columnWidths[th.dataset.col]; paintTemplate(); void saveColumns();
    });
    head.addEventListener("keydown", (event) => {
      const th = event.target.closest?.(".col-resize")?.closest?.("th"), id = th?.dataset.col;
      if (!id || ended || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") delete columnWidths[id];
      else columnWidths[id] = clampWidth(id, (columnWidths[id] ?? th.getBoundingClientRect().width) + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 64 : 16));
      paintTemplate(); saveColumnsSoon();
    });
    head.addEventListener("dragstart", (event) => {
      const th = event.target.closest?.("th");
      if (resizing || ended || !th?.dataset.col || columnsDevice !== "desktop") { event.preventDefault(); return; }
      dragging = th.dataset.col; th.dataset.dragging = "";
      event.dataTransfer?.setData("text/plain", dragging);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    head.addEventListener("dragover", (event) => {
      const th = event.target.closest?.("th");
      if (!dragging || !th?.dataset.col) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      for (const item of document.querySelectorAll?.("th[data-drop]") || []) if (item !== th) delete item.dataset.drop;
      const box = th.getBoundingClientRect();
      th.dataset.drop = th.dataset.col === dragging ? "" : event.clientX > box.left + box.width / 2 ? "after" : "before";
    });
    head.addEventListener("dragleave", (event) => {
      const th = event.target.closest?.("th");
      if (th && !th.contains?.(event.relatedTarget)) delete th.dataset.drop;
    });
    head.addEventListener("drop", (event) => {
      const th = event.target.closest?.("th");
      if (!dragging || !th?.dataset.col) return;
      event.preventDefault();
      const id = dragging, after = th.dataset.drop === "after";
      delete th.dataset.drop;
      if (moveColumn(id, th.dataset.col, after)) void saveColumns();
    });
    head.addEventListener("dragend", () => {
      for (const item of document.querySelectorAll?.("th[data-drop],th[data-dragging]") || []) { delete item.dataset.drop; delete item.dataset.dragging; }
      dragging = null;
    });
  }
  for (const head of document.querySelectorAll?.("thead") || []) headerHandlers(head);
  // Dragging a header fights scrolling on a touch screen: there the Columns menu rearranges.
  if (columnsDevice === "touch") for (const th of document.querySelectorAll?.("th[data-col]") || []) { th.draggable = false; th.title = "Use Columns to move or hide columns"; }
  if (el("columns-device")) el("columns-device").textContent = columnsDevice === "touch"
    ? "This layout is for phones and tablets. Your computer keeps its own." : "This layout is for computers. Phones and tablets keep their own.";
  function openColumns() {
    if (ended) return;
    draftColumns = [...columnOrder]; draftWidths = { ...columnWidths }; draftHidden = new Set(columnHidden);
    el("columns-error").textContent = "";
    renderColumnsDialog(); columnsDialog.showModal();
  }
  columnsButton?.addEventListener("click", openColumns);
  el("columns-quick")?.addEventListener("click", openColumns);
  columnsList?.addEventListener("click", (event) => {
    const show = event.target.closest("button[data-show-column]");
    if (show?.dataset.showColumn) {
      if (show.disabled || columnsDialogSaving || ended) return;
      const id = show.dataset.showColumn;
      if (draftHidden.has(id)) draftHidden.delete(id); else draftHidden.add(id);
      renderColumnsDialog(); show.focus?.();
      return;
    }
    const button = event.target.closest("button[data-column]");
    if (!button || button.disabled || columnsDialogSaving || ended) return;
    const index = draftColumns.indexOf(button.dataset.column), next = index + Number(button.dataset.direction);
    if (index < 0 || next < 0 || next >= draftColumns.length) return;
    [draftColumns[index], draftColumns[next]] = [draftColumns[next], draftColumns[index]];
    renderColumnsDialog();
    const buttons = columnsNodes.get(button.dataset.column).buttons;
    (button.disabled ? buttons.find((item) => !item.disabled) : button)?.focus();
  });
  el("columns-reset")?.addEventListener("click", () => {
    if (columnsDialogSaving || ended) return;
    draftColumns = [...columnIds]; draftWidths = {}; draftHidden = new Set(); renderColumnsDialog();
  });
  el("columns-cancel")?.addEventListener("click", () => { if (!columnsDialogSaving) columnsDialog.close(); });
  el("columns-save")?.addEventListener("click", async () => {
    if (columnsDialogSaving || ended) return;
    columnsDialogSaving = true; el("columns-error").textContent = ""; renderColumnsDialog();
    const previous = { order: [...columnOrder], widths: { ...columnWidths }, hidden: new Set(columnHidden) };
    columnOrder = [...draftColumns]; columnWidths = { ...draftWidths }; columnHidden = new Set(draftHidden); applyColumns();
    const saved = await saveColumns();
    columnsDialogSaving = false;
    if (saved) columnsDialog.close();
    else if (!ended) {
      columnOrder = previous.order; columnWidths = previous.widths; columnHidden = previous.hidden; applyColumns();
      actionMessage = ""; notice();
      el("columns-error").textContent = "That column layout couldn’t be saved. Please try again.";
    }
    renderColumnsDialog();
  });
  columnsDialog?.addEventListener("cancel", (event) => { if (columnsDialogSaving) event.preventDefault(); });
  applyColumns();
  search.addEventListener("input", render);
  function rowClick(event) {
    const channelButton = event.target.closest("button[data-channel-id]");
    if (channelButton?.dataset.channelId) { void pinChannel(channelButton.dataset.channelId); return; }
    const button = event.target.closest("button[data-key]");
    if (button) { void complete(button.dataset.key, button.dataset.operation); return; }
    const callAnchor = event.target.closest?.("a.call-link");
    if (callAnchor) {
      event.preventDefault();
      if (callAnchor.dataset.channelId) callUi?.open({ channelId: callAnchor.dataset.channelId, threadTs: callAnchor.dataset.threadTs || "", channelName: String(callAnchor.dataset.channelName || ""), title: callAnchor.dataset.title || "" });
      return;
    }
    // The Slack button opens the desktop app; Ctrl/⌘-click opens the same thread in the browser.
    const anchor = event.target.closest?.("a.open-link");
    if (anchor?.href && anchor.dataset.app === "1" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      browser.open?.(anchor.href + "?browser=1", "_blank", "noopener,noreferrer");
      return;
    }
    const channelAnchor = event.target.closest?.("a.channel-link");
    if (channelAnchor?.href && channelAnchor.dataset.web && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      browser.open?.(channelAnchor.dataset.web, "_blank", "noopener,noreferrer");
    }
  }
  async function loadMoreRows() {
    if (ended || loadingMore) return;
    loadingMore = true; render();
    try {
      const response = await fetch(base + "/api/threads/more", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf }, body: JSON.stringify({ group: feedGroupOf(filter) }) });
      if (response.status === 401 || response.status === 403) { endAccess(); return; }
      if (!response.ok) throw new Error("unavailable");
      revision++;
      accept(await response.json());
    } catch {
      if (!ended) { actionMessage = "Older conversations couldn’t be loaded. Please try again."; }
    } finally { loadingMore = false; render(); }
  }
  el("load-more")?.addEventListener("click", () => { void loadMoreRows(); });
  body.addEventListener("click", rowClick);
  pinnedBody.addEventListener("click", rowClick);
  pinnedChannelList.addEventListener("click", rowClick);
  el("call-agent")?.addEventListener("click", () => { callUi?.toggle(); });
  if (callUi && config.callTarget && config.callTarget.channelId) callUi.open({ channelId: config.callTarget.channelId, threadTs: config.callTarget.threadTs || "" });
  subscriptionButton?.addEventListener("click", () => { void refreshSubscriptions(); });
  document.addEventListener?.("visibilitychange", () => {
    if (document.hidden) {
      subscriptionGeneration++;
      if (subscriptionTimer !== null) browser.clearTimeout(subscriptionTimer);
      subscriptionTimer = null;
    } else void refreshSubscriptions();
  });
  render();
  void refreshSubscriptions();
  void refresh();
  stream = new EventSource(base + "/stream");
  stream.addEventListener("open", () => { if (!ended) { connected = true; connection(); } });
  stream.addEventListener("threads", (event) => {
    if (ended) return;
    try { if (accept(JSON.parse(event.data))) { connected = true; connection(); } } catch { /* Wait for the next full snapshot. */ }
  });
  stream.addEventListener("access-ended", endAccess);
  stream.addEventListener("error", () => {
    if (ended) return;
    connected = false;
    connection();
    void refresh(); // Also detects expired cookies: EventSource does not expose HTTP status.
  });
  const timer = setInterval(() => { connection(); if (!ended) void refresh(); }, 60_000);
  const ticker = setInterval(() => { if (!ended && !document.hidden) { const now = Date.now(); for (const entry of nodes.values()) clock(entry, now); } }, 1000);
  browser.addEventListener("pagehide", () => { subscriptionPaused = true; subscriptionGeneration++; if (subscriptionTimer !== null) browser.clearTimeout(subscriptionTimer); stream.close(); clearInterval(timer); clearInterval(ticker); });
  browser.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
}

// The Settings view: the viewer's own preferences, connections, MCP servers, variables, skills
// and SSH keys. Every value is rendered with textContent; secret inputs are never prefilled.
function settingsBrowser(config, browser, theme, connections) {
  "use strict";
  const { base, csrf } = config;
  const { document, location } = browser;
  const el = (id) => document.getElementById(id);
  const panel = el("settings-panel"), nav = el("settings-nav"), status = el("settings-status");
  const SECTIONS = [["general", "General"], ["voice", "Voice calls"], ["connections", "Connections"], ["email", "Email accounts"], ["mcps", "MCP servers"], ["variables", "Variables"], ["skills", "Skills"], ["ssh", "SSH keys"], ["api", "API tokens"]].filter(([id]) => id !== "email" || config.emailAccounts === true);
  const voiceCalls = config.voiceCalls === true;
  const wanted = String(location?.hash || "").replace(/^#/, "");
  let section = SECTIONS.some(([id]) => id === wanted) ? wanted : config.emailPage ? "email" : config.connectionsPage ? "connections" : "general";
  let data = null, busy = false, ended = false, notice = "", noticeKind = "", editing = null;
  const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function when(value) {
    const date = new Date(typeof value === "number" ? value : String(value || ""));
    return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : "";
  }
  function button(text, onClick, className = "settings-button") {
    const item = node("button", className, text);
    item.type = "button"; item.disabled = busy || ended;
    item.addEventListener("click", onClick);
    return item;
  }
  function input(name, { type = "text", placeholder = "", value = "", max = 300, multiline = false } = {}) {
    const item = node(multiline ? "textarea" : "input", "settings-input");
    if (!multiline) item.type = type;
    item.name = name; item.value = value; item.placeholder = placeholder;
    item.setAttribute("autocomplete", type === "password" ? "new-password" : "off");
    item.setAttribute("spellcheck", "false");
    item.setAttribute("maxlength", String(max));
    item.disabled = busy || ended;
    return item;
  }
  function field(label, control, hint = "") {
    const wrap = node("label", "settings-field");
    wrap.append(node("span", "settings-label", label), control);
    if (hint) wrap.append(node("span", "settings-hint", hint));
    return wrap;
  }
  function card(title, description = "") {
    const item = node("section", "settings-card");
    item.append(node("h2", "", title));
    if (description) item.append(node("p", "settings-copy", description));
    return item;
  }
  function row(primary, secondary, actions = []) {
    const item = node("div", "settings-row"), text = node("div", "settings-row-text");
    text.append(node("div", "settings-row-title", primary));
    if (secondary) text.append(node("div", "settings-row-meta", secondary));
    const controls = node("div", "settings-row-actions");
    controls.append(...actions);
    item.append(text, controls);
    return item;
  }
  // A form posts its named controls plus `extra`; a refusal stays beside the form.
  function form(fields, submitText, build, { extra = {}, cancel = null } = {}) {
    const item = node("form", "settings-form"), error = node("p", "settings-error");
    error.setAttribute("role", "alert");
    item.append(...fields);
    const footer = node("div", "settings-form-actions");
    if (cancel) footer.append(button("Cancel", cancel, "settings-button ghost"));
    const submit = node("button", "settings-button primary", submitText);
    submit.type = "submit"; submit.disabled = busy || ended;
    footer.append(submit);
    item.append(error, footer);
    item.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {};
      for (const control of item.querySelectorAll("input")) values[control.name] = control.type === "checkbox" ? control.checked : control.value;
      for (const control of item.querySelectorAll("textarea")) values[control.name] = control.value;
      for (const control of item.querySelectorAll("select")) values[control.name] = control.value;
      void send({ ...build(values), ...extra }, error);
    });
    return item;
  }
  function confirmThen(message, body) {
    return () => { if (!browser.confirm || browser.confirm(message)) void send(body); };
  }
  function paintStatus() {
    status.textContent = ended ? "Your session has ended. Sign in with a passkey or open Dashboard again from Slack." : notice;
    status.className = "settings-status" + (ended ? " error" : noticeKind ? " " + noticeKind : "");
    status.hidden = !status.textContent;
  }
  function end() { ended = true; busy = false; render(); }

  async function load() {
    try {
      const response = await fetch(base + "/api/settings", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) { end(); return; }
      if (!response.ok) throw new Error("unavailable");
      data = await response.json();
    } catch {
      notice = "Settings couldn’t load. Refresh the page to try again."; noticeKind = "error";
    }
    render();
  }
  function lock(value) { for (const control of panel.querySelectorAll("input,textarea,select,button")) control.disabled = value; }
  // Starting a change locks the page instead of re-rendering it, so a refusal keeps what the
  // person typed and shows beside the form that caused it.
  async function send(body, errorNode = null) {
    if (busy || ended) return;
    busy = true; notice = ""; noticeKind = ""; paintStatus(); lock(true);
    if (errorNode) errorNode.textContent = "";
    panel.setAttribute("aria-busy", "true");
    const settle = (message) => {
      busy = false; lock(false); panel.setAttribute("aria-busy", "false");
      if (errorNode) errorNode.textContent = message; else { notice = message; noticeKind = "error"; paintStatus(); }
    };
    try {
      const response = await fetch(base + "/api/settings", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf }, body: JSON.stringify(body),
      });
      if (response.status === 401 || response.status === 403) { end(); return; }
      const result = await response.json().catch(() => ({}));
      if (response.status === 400 && typeof result.error === "string") { settle(result.error); return; }
      if (!response.ok || !result.settings) throw new Error("unavailable");
      data = result.settings; editing = null; busy = false;
      if (body.action === "composio.save" || body.action === "composio.remove") connections.refresh();
      notice = String(result.notice || "Saved."); noticeKind = "ok";
      render();
    } catch { settle("That change couldn’t be saved. Please try again."); }
  }

  // Settings → API tokens has its own endpoints: it works per conversation, and a minted value
  // lives only in this page's memory until the person leaves the section or the conversation.
  const tok = { channels: null, channelId: "", list: null, reveal: null, loading: false, message: "", requested: false };
  async function tokRequest(path, init) {
    const response = await fetch(base + "/api/api-tokens" + path, { credentials: "same-origin", cache: "no-store", ...init });
    if (response.status === 401) { end(); throw new Error(""); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (typeof result.error === "string" && response.status !== 403 && response.status !== 503) throw new Error(result.error);
      throw new Error(response.status === 403 ? "You no longer have access to that conversation." : "That couldn’t be done. Please try again.");
    }
    return result;
  }
  async function tokLoadList() {
    tok.list = null; tok.message = "";
    if (!tok.channelId) { render(); return; }
    render();
    try { tok.list = await tokRequest("/" + encodeURIComponent(tok.channelId)); }
    catch (error) { tok.message = error.message; }
    render();
  }
  async function tokLoadChannels() {
    tok.loading = true; tok.requested = true; tok.message = ""; render();
    try {
      const result = await tokRequest("");
      tok.channels = result.channels || [];
      if (!tok.channels.some((c) => c.channelId === tok.channelId)) tok.channelId = tok.channels[0]?.channelId || "";
    } catch (error) { tok.channels = tok.channels || []; tok.message = error.message; }
    tok.loading = false;
    await tokLoadList();
  }
  async function tokMutate(path, body, errorNode) {
    if (tok.loading || ended) return null;
    tok.loading = true; lock(true);
    if (errorNode) errorNode.textContent = "";
    try {
      return await tokRequest(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf }, body: JSON.stringify(body || {}) });
    } catch (error) {
      if (errorNode) errorNode.textContent = error.message; else { tok.message = error.message; }
      return null;
    } finally { tok.loading = false; lock(false); }
  }

  const BUILD = {
    general() {
      const account = card("Account", "Who this dashboard belongs to.");
      const roles = { admin: "Administrator", member: "Approved member", guest: "Guest" };
      account.append(row(data.account.name || data.account.id, (roles[data.account.role] || "Member") + " · " + data.account.id));
      const appearance = card("Appearance", "Saved to your account, so every dashboard session uses it.");
      const select = node("select", "settings-input");
      for (const [value, label] of [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]]) {
        const option = node("option", "", label); option.value = value; option.selected = theme.current() === value; select.append(option);
      }
      select.disabled = ended;
      select.addEventListener("change", () => { void theme.saveTheme(select.value); });
      appearance.append(field("Theme", select));
      appearance.append(node("p", "settings-copy", "The app logo color is shared by everyone on this gateway. An administrator can change it in gateway Settings → Appearance."));
      if (data.account.role === "admin") {
        const branding = node("a", "settings-button", "Change app logo color"); branding.href = "/settings#set-appearance"; appearance.append(branding);
      }
      const reminders = card("Quiet-thread reminders", "When the agent answers you and the thread stays quiet, it mentions you there once after the reminder window. Applies in every channel and DM.");
      const enabled = Boolean(data.general.nudges);
      reminders.append(row(enabled ? "On" : "Off", "", [button(enabled ? "Turn off" : "Turn on", () => { void send({ action: "nudges", enabled: !enabled }); }, "settings-button" + (enabled ? "" : " primary"))]));
      const mentions = card("Mention me in replies", "Automatically mention you when delivering your replies in channels and group conversations. Follows you across conversations; direct messages never need a mention.");
      const mentioned = Boolean(data.general.replyMentions);
      mentions.append(row(mentioned ? "On" : "Off", "", [button(mentioned ? "Turn off" : "Turn on", () => { void send({ action: "replyMentions", enabled: !mentioned }); }, "settings-button" + (mentioned ? "" : " primary"))]));
      const voiceStart = card("Start on voice clips in agent threads", "When you reply with a voice clip in a Slack thread where the agent answered last, it starts without an @mention or 🤖. Never on top-level channel messages, and never when the clip mentions someone.");
      const voiceStarts = Boolean(data.general.voiceAutoStart);
      voiceStart.append(row(voiceStarts ? "On" : "Off", "", [button(voiceStarts ? "Turn off" : "Turn on", () => { void send({ action: "voiceAutoStart", enabled: !voiceStarts }); }, "settings-button" + (voiceStarts ? "" : " primary"))]));
      const keys = card("Passkeys", "Sign back in to this dashboard without a new Slack link.");
      const link = node("a", "settings-button", "Manage passkeys"); link.href = base + "/passkeys";
      keys.append(link);
      return [account, appearance, reminders, mentions, voiceStart, keys];
    },
    voice() {
      const v = data.voice || { language: "", style: "brief", patience: "normal", instructions: "", styles: ["brief", "conversational", "thinking-partner"], patience_options: ["quick", "normal", "patient"], limits: { language: 60, instructions: 2000 } };
      const prefs = card("How the agent talks to you on a call", "Your voice calls only. Saved to your account; your next call uses it. The voice always knows who you are, which conversations you have open and what you did on recent calls.");
      if (!voiceCalls) prefs.append(node("p", "settings-copy", "Voice calls are not enabled on this gateway yet; an administrator turns them on under Settings → Calls. Your preferences are kept for when they are."));
      const styleLabels = { brief: "Brief — short answers, gets on with it", conversational: "Conversational — a little more, elaborates when asked", "thinking-partner": "Thinking partner — listens while you think aloud, asks one question at a time" };
      const patienceLabels = { quick: "Quick — answers as soon as you stop", normal: "Normal", patient: "Patient — waits through your pauses" };
      const select = (name, options, current, labels) => {
        const item = node("select", "settings-input"); item.name = name; item.disabled = busy || ended;
        for (const value of options) { const option = node("option", "", labels[value] || value); option.value = value; option.selected = value === current; item.append(option); }
        item.value = current;
        return item;
      };
      prefs.append(form([
        field("Language", input("language", { value: v.language, max: v.limits.language, placeholder: "e.g. Romanian, English" }), "Leave empty and it follows whatever language you speak."),
        field("Style", select("style", v.styles, v.style, styleLabels)),
        field("Patience", select("patience", v.patience_options, v.patience, patienceLabels), "How long it waits after you stop talking before it answers."),
        field("Your instructions", input("instructions", { multiline: true, value: v.instructions, max: v.limits.instructions, placeholder: "e.g. Call me Tibi. Confirm before starting anything that touches production. Keep summaries to one sentence." }), "Free text the voice reads at the start of every call, after the gateway's own rules."),
      ], "Save", (values) => ({ action: "voice.save", language: values.language, style: values.style, patience: values.patience, instructions: values.instructions })));
      return [prefs];
    },
    connections() {
      const c = data.connections, cards = [];
      cards.push(connections.mount());
      if (config.connectionsNew && c.composioMode === "sdk") return cards;
      if (c.composioMode !== "sdk") {
        const composio = card("Composio · your account", "Your own apps (Gmail, Calendar, HubSpot, …) as composio-user. Only your runs use it, in every conversation.");
        composio.append(row(c.composio.configured ? "Connected" + (c.composio.last4 ? " · ••••" + c.composio.last4 : "") : "Not connected", c.composio.label,
          c.composio.configured ? [button("Remove", confirmThen("Remove your Composio account? Runs in progress stop using it.", { action: "composio.remove" }), "settings-button danger")] : []));
        composio.append(form([field(c.composio.configured ? "Replace token" : "Token", input("token", { type: "password", max: 4096, placeholder: c.composio.configured ? "Leave blank to keep the current token" : "" })),
          field("Label", input("label", { value: c.composio.label, max: 80, placeholder: "e.g. Work account" }), "Optional. Shown here and in Slack Settings.")],
        "Save", (v) => ({ action: "composio.save", token: v.token, label: v.label })));
        cards.push(composio);
      }

      return cards;
    },
    email() {
      const c = data.connections;
      const email = card("Email accounts", "Mailboxes only your runs read and send from. Saving logs in to IMAP and SMTP first; passwords are never shown again.");
      for (const account of c.email) {
        email.append(row(account.name + " · " + account.address, "IMAP " + account.imap.host + ":" + account.imap.port + " · SMTP " + account.smtp.host + ":" + account.smtp.port + (account.sendEnabled ? "" : " · sending off"), [
          button("Edit", () => { editing = { kind: "email", value: account }; render(); }),
          button("Remove", confirmThen("Remove email account " + account.name + "?", { action: "email.remove", name: account.name }), "settings-button danger")]));
      }
      if (!c.email.length) email.append(node("p", "settings-empty", "No email accounts."));
      const current = editing?.kind === "email" ? editing.value : null;
      const v = (key, fallback = "") => current ? String(key.split(".").reduce((o, k) => o?.[k], current) ?? fallback) : fallback;
      const emailEditor = node("details", "settings-email-editor"); emailEditor.open = Boolean(current);
      emailEditor.append(node("summary", "", current ? "Edit " + current.name : "Add an email account"));
      emailEditor.append(form([
        ...(current ? [] : [field("Name", input("name", { max: 40, placeholder: "work" }), "Lowercase letters, digits and dashes.")]),
        field("Address", input("address", { type: "email", value: v("address"), max: 254 })),
        field("Display name", input("displayName", { value: v("displayName"), max: 120 })),
        field("IMAP host", input("imapHost", { value: v("imap.host"), max: 253 })), field("IMAP port", input("imapPort", { value: v("imap.port", "993"), max: 5 })),
        field("IMAP user", input("imapUser", { value: v("imap.user"), max: 254 })), field("IMAP password", input("imapPassword", { type: "password", max: 1024, placeholder: current ? "Leave blank to keep" : "" })),
        field("SMTP host", input("smtpHost", { value: v("smtp.host"), max: 253 })), field("SMTP port", input("smtpPort", { value: v("smtp.port", "587"), max: 5 })),
        field("SMTP user", input("smtpUser", { value: v("smtp.user"), max: 254 }), "Blank uses the IMAP user."), field("SMTP password", input("smtpPassword", { type: "password", max: 1024, placeholder: current ? "Leave blank to keep" : "Blank uses the IMAP password" })),
      ], current ? "Save changes" : "Connect", (values) => ({ action: "email.save", ...values, ...(current ? { name: current.name } : {}) }),
      current ? { cancel: () => { editing = null; render(); } } : {}));
      email.append(emailEditor);
      return [email];
    },
    mcps() {
      const m = data.mcps;
      const list = card("Your MCP servers", "Remote MCP servers only your runs connect to, as my-<name>. Up to " + m.limit + ". Tokens are write-only.");
      const auth = { bearer: "Bearer token", composio: "Composio consumer key", custom: "Custom headers (edit in Slack Settings)" };
      for (const server of m.servers) {
        list.append(row(server.serverName, String(server.url || "").replace(/^https:\/\//, "") + " · " + (auth[server.authType] || "Bearer token") + (server.tokenLast4 ? " · ••" + server.tokenLast4 : ""), [
          button("Edit", () => { editing = { kind: "mcp", value: server }; render(); }),
          button("Remove", confirmThen("Remove " + server.serverName + "? Runs stop receiving it, including any in progress.", { action: "mcp.remove", name: server.name }), "settings-button danger")]));
      }
      if (!m.servers.length) list.append(node("p", "settings-empty", "No MCP servers yet."));
      const current = editing?.kind === "mcp" ? editing.value : null;
      const add = card(current ? "Edit " + current.serverName : "Add a server", current ? "Leave the token blank to keep the stored one." : "The URL must be public HTTPS. Its tools reach your next run.");
      const authSelect = node("select", "settings-input"); authSelect.name = "authType"; authSelect.disabled = busy || ended;
      for (const [value, label] of [["bearer", "Bearer token"], ["composio", "Composio consumer key"]]) {
        const option = node("option", "", label); option.value = value; option.selected = (current?.authType || "bearer") === value; authSelect.append(option);
      }
      const fields = [
        ...(current ? [] : [field("Name", input("name", { max: 40, placeholder: "notion" }), "Lowercase letters, digits and dashes.")]),
        field("URL", input("url", { type: "url", value: current?.url || "", max: 2048, placeholder: "https://mcp.example.com/mcp" })),
        ...(current?.authType === "custom" ? [] : [field("Authentication", authSelect), field("Token", input("token", { type: "password", max: 8192, placeholder: current ? "Leave blank to keep" : "" }))]),
      ];
      add.append(form(fields, current ? "Save changes" : "Add server", (values) => ({ action: "mcp.save", name: current ? current.name : values.name, url: values.url,
        ...(values.token ? { token: values.token } : {}), ...(current?.authType === "custom" ? {} : { authType: values.authType }) }),
      current ? { cancel: () => { editing = null; render(); } } : {}));
      return [list, add];
    },
    variables() {
      const list = card("Your variables", "Environment variables only your runs receive, in every conversation. Values are write-only: nobody can read them back here.");
      for (const variable of data.variables) {
        const kind = variable.exposure === "hidden" ? "Hidden" + (variable.hosts.length ? " · " + variable.hosts.join(", ") : " · servers approved by an admin") : "Readable";
        list.append(row(variable.name, kind + (variable.last4 ? " · ••" + variable.last4 : "") + (variable.setAt ? " · " + when(variable.setAt) : ""), [
          button("Replace", () => { editing = { kind: "variable", value: variable }; render(); }),
          button("Remove", confirmThen("Remove " + variable.name + "?", { action: "variable.remove", name: variable.name }), "settings-button danger")]));
      }
      if (!data.variables.length) list.append(node("p", "settings-empty", "No variables yet."));
      const current = editing?.kind === "variable" ? editing.value : null;
      const add = card(current ? "Replace " + current.name : "Add a variable", current ? "The new value keeps the same type and allowed servers; the old one stops working now." : "Hidden values reach the container only as a placeholder the gateway swaps in on approved servers. Mark it readable only for a password or connection string used outside HTTPS.");
      const readable = node("input"); readable.type = "checkbox"; readable.name = "readable"; readable.disabled = busy || ended;
      const readableLabel = node("label", "settings-check"); readableLabel.append(readable, node("span", "", "Readable (the raw value is placed in the environment)"));
      add.append(form([
        ...(current ? [] : [field("Name", input("name", { max: 64, placeholder: "MY_API_KEY" }), "Uppercase letters, digits and underscores.")]),
        field("Value", input("value", { multiline: true, max: 16384 })),
        ...(current ? [] : [readableLabel]),
      ], current ? "Replace value" : "Add variable", (values) => ({ action: "variable.save", name: current ? current.name : values.name, value: values.value, ...(current ? {} : { readable: values.readable === true }) }),
      current ? { cancel: () => { editing = null; render(); } } : {}));
      return [list, add];
    },
    skills() {
      // Skills live on their own page now, with a conversation picker; "Only me" is this list.
      const pick = card("Skills", "Pick the skills that load for you in every conversation (“Only me”), or for any conversation you can access, on the Skills page.");
      const count = (data.skills?.selected || []).length;
      pick.append(node("p", "settings-row-meta", count ? "You have " + count + " personal skill" + (count === 1 ? "" : "s") + " on." : "You have no personal skills on yet."));
      const open = node("a", "settings-button primary", "Open the Skills page"); open.href = base + "/skills#me";
      pick.append(open);
      return [pick];
    },
    api() {
      const intro = card("API tokens", "A token lets an automation (Make.com, a script, a CI job) start runs in one conversation over the HTTP run API. Runs act as you, with your current access there, and stop working when you revoke the token or lose access. Channel managers and admins also see everyone’s tokens in their conversations.");
      // Loaded after this render returns, so the loader's own repaints never nest inside it.
      if (!tok.requested) { tok.requested = true; void Promise.resolve().then(tokLoadChannels); }
      if (!tok.channels) { intro.append(node("p", "settings-empty", "Loading your conversations…")); return [intro]; }
      if (!tok.channels.length) { intro.append(node("p", "settings-empty", tok.message || "There is no conversation you can create a token in yet.")); return [intro]; }
      const picker = node("select", "settings-input"); picker.name = "conversation"; picker.disabled = tok.loading || ended;
      for (const c of tok.channels) { const option = node("option", "", c.name + (c.count ? " (" + c.count + ")" : "")); option.value = c.channelId; option.selected = c.channelId === tok.channelId; picker.append(option); }
      picker.addEventListener("change", () => { tok.channelId = picker.value; tok.reveal = null; void tokLoadList(); });
      intro.append(field("Conversation", picker));
      const cards = [intro];
      if (tok.reveal && tok.reveal.channelId === tok.channelId) {
        const shown = card("Copy your new token now", "It is shown only this once; the gateway keeps no copy. Leaving this page hides it for good.");
        const value = input("token-value", { value: tok.reveal.token, max: 200 }); value.readOnly = true; value.disabled = false;
        value.addEventListener("focus", () => value.select());
        const copy = button("Copy", () => { void browser.navigator?.clipboard?.writeText(tok.reveal.token).then(() => { copy.textContent = "Copied"; }, () => { value.select(); }); }, "settings-button primary");
        shown.append(field(tok.reveal.name, value), copy);
        const example = node("pre", "settings-code", tok.reveal.example); shown.append(example);
        const done = button("I’ve copied it", () => { tok.reveal = null; render(); }, "settings-button ghost"); shown.append(done);
        cards.push(shown);
      }
      const list = card(tok.list?.manager ? "Tokens in this conversation" : "Your tokens here");
      if (tok.message) list.append(node("p", "settings-error", tok.message));
      if (!tok.list) list.append(node("p", "settings-empty", tok.message ? "" : "Loading tokens…"));
      else {
        for (const t of tok.list.tokens) {
          list.append(row(t.name, t.prefix + "…" + t.last4 + " · " + (t.mine ? "yours" : "created by " + (t.createdByName || t.createdBy)) + " · created " + when(t.createdAt) + " · " + (t.lastUsedAt ? "last used " + when(t.lastUsedAt) : "never used"), [
            button("Revoke", async () => {
              if (browser.confirm && !browser.confirm("Revoke “" + t.name + "”? Automations using it get 401 from the next request.")) return;
              const done = await tokMutate("/" + encodeURIComponent(tok.channelId) + "/" + encodeURIComponent(t.id) + "/revoke");
              if (done) { notice = "Revoked “" + t.name + "”."; noticeKind = "ok"; await tokLoadChannels(); } else render();
            }, "settings-button danger")]));
        }
        if (!tok.list.tokens.length) list.append(node("p", "settings-empty", tok.list.manager ? "No tokens in this conversation." : "You have no tokens in this conversation."));
      }
      cards.push(list);
      const add = card("Create a token", "Give it a name that says where it is used.");
      const nameInput = input("name", { max: 80, placeholder: "Make.com invoice flow" });
      const error = node("p", "settings-error"); error.setAttribute("role", "alert");
      const create = node("form", "settings-form");
      const submit = node("button", "settings-button primary", "Create token"); submit.type = "submit"; submit.disabled = tok.loading || ended;
      const footer = node("div", "settings-form-actions"); footer.append(submit);
      create.append(field("Name", nameInput), error, footer);
      create.addEventListener("submit", async (event) => {
        event.preventDefault();
        const channelId = tok.channelId;
        const minted = await tokMutate("/" + encodeURIComponent(channelId), { name: nameInput.value }, error);
        if (!minted) return;
        tok.reveal = { channelId, token: minted.token, name: minted.record.name, example: minted.example };
        notice = "Token “" + minted.record.name + "” created."; noticeKind = "ok";
        await tokLoadChannels();
      });
      add.append(create);
      cards.push(add);
      return cards;
    },
    ssh() {
      const k = data.ssh;
      const list = card("Your SSH keys", "Public keys that let you SSH into a channel's container once you enable access there (ask the agent: “enable SSH access for me”). Up to " + k.max + ".");
      for (const key of k.keys) {
        list.append(row(key.fingerprint, key.type + (key.label ? " · " + key.label : "") + " · added " + when(key.createdAt) + " · " + (key.lastUsedAt ? "last used " + when(key.lastUsedAt) : "never used"), [
          button("Remove", confirmThen("Remove " + key.fingerprint + "? Every channel grant stops working for it.", { action: "ssh.remove", id: key.id }), "settings-button danger")]));
      }
      if (!k.keys.length) list.append(node("p", "settings-empty", "No SSH keys registered."));
      const add = card("Add a public key", "Paste the single line of your .pub file. Never paste a private key.");
      add.append(form([field("Public key", input("publicKey", { multiline: true, max: 16384, placeholder: "ssh-ed25519 AAAA… you@laptop" })), field("Label", input("label", { max: 80, placeholder: "laptop" }))],
        "Add key", (values) => ({ action: "ssh.add", publicKey: values.publicKey, label: values.label })));
      return [list, add];
    },
  };

  function render() {
    document.documentElement.dataset.settingsSection = section;
    nav.replaceChildren(...SECTIONS.map(([id, label]) => {
      const item = node("button", "settings-tab", label);
      item.type = "button";
      if (id === section) item.setAttribute("aria-current", "page");
      item.addEventListener("click", () => { if (id === "skills") { location.assign(base + "/skills"); return; } section = id; editing = null; notice = ""; noticeKind = ""; tok.reveal = null; if (browser.history?.replaceState) browser.history.replaceState(null, "", base + "/settings" + (id === "email" ? "/email" : id === "connections" ? "/connections" : "#" + id)); render(); });
      return item;
    }));
    paintStatus();
    if (ended) { panel.replaceChildren(); return; }
    if (!data) { panel.replaceChildren(node("p", "settings-empty", noticeKind === "error" ? "" : "Loading your settings…")); return; }
    panel.replaceChildren(...BUILD[section]());
    panel.setAttribute("aria-busy", String(busy));
  }
  // Back/forward and edited links change only the hash; follow them without a reload.
  browser.addEventListener?.("hashchange", () => {
    const next = String(location?.hash || "").replace(/^#/, "");
    if (next !== section && SECTIONS.some(([id]) => id === next)) { section = next; editing = null; render(); }
  });
  render();
  void load();
}

const icon = (svg) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${svg}</svg>`)}")`;
const ICONS = {
  external: icon("<g fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M14 3h7v7M21 3 10 14M10 4H4v16h16v-6'/></g>"),
  call: icon("<path d='M6.6 2.6c.5-.5 1.3-.5 1.8 0l2.3 2.3c.5.5.5 1.3 0 1.8L9.4 8.1c-.3.3-.4.8-.1 1.2a13 13 0 0 0 5.4 5.4c.4.2.9.2 1.2-.1l1.4-1.3c.5-.5 1.3-.5 1.8 0l2.3 2.3c.5.5.5 1.3 0 1.8l-1.5 1.5c-1 1-2.5 1.4-3.9.9A20 20 0 0 1 4.2 8c-.5-1.4-.1-2.9.9-3.9l1.5-1.5Z'/>"),
  hide: icon("<g fill='none' stroke='white' stroke-width='2' stroke-linecap='round'><path d='M3 3l18 18M10 5a12 12 0 0 1 12 7 17 17 0 0 1-4 5M6 6a17 17 0 0 0-4 6 12 12 0 0 0 13 7'/><path d='M10 10a3 3 0 0 0 4 4'/></g>"),
  pin: icon("<path d='m15 2 7 7-2 2-2-1-4 4v3l-1 1-3-3-5 5-1-1 5-5-3-3 1-1h3l4-4-1-2 2-2Z'/>"),
  slack: icon("<path d='M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0v-6.31ZM8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31Zm10.13 2.52a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31Zm-2.52 10.13a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 1 1 0 5.05h-6.31Z'/>"),
  done: icon("<path d='M20.3 5.3a1 1 0 0 1 0 1.4l-10.5 10.5a1 1 0 0 1-1.4 0L3.7 12.5a1 1 0 1 1 1.4-1.4l4 4 9.8-9.8a1 1 0 0 1 1.4 0Z'/>"),
  reopen: icon("<path d='M12 4a8 8 0 1 1-7.4 5h2.2A6 6 0 1 0 12 6v3L7.5 5 12 1v3Z'/>"),
  later: icon("<path d='M7 4h3.5v16H7zM13.5 4H17v16h-3.5z'/>"),
  resume: icon("<path d='M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z'/>"),
  busy: icon("<circle cx='5' cy='12' r='2'/><circle cx='12' cy='12' r='2'/><circle cx='19' cy='12' r='2'/>"),
  more: icon("<circle cx='5' cy='12' r='2'/><circle cx='12' cy='12' r='2'/><circle cx='19' cy='12' r='2'/>"),
  less: icon("<path d='M5 13h14v-2H5z'/>"),
  menu: icon("<path d='M3 5.5h18v2H3zM3 11h18v2H3zM3 16.5h18v2H3z'/>"),
  close: icon("<path d='m5.6 4.2 14.2 14.2-1.4 1.4L4.2 5.6zM18.4 4.2l1.4 1.4L5.6 19.8l-1.4-1.4z'/>"),
  moon: icon("<path d='M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'/>"),
  sun: icon("<circle cx='12' cy='12' r='4.5'/><path d='M11 1.5h2V5h-2zM11 19h2v3.5h-2zM1.5 11H5v2H1.5zM19 11h3.5v2H19zM4.2 5.6l1.4-1.4 2.5 2.5-1.4 1.4zM15.9 17.3l1.4-1.4 2.5 2.5-1.4 1.4zM4.2 18.4l2.5-2.5 1.4 1.4-2.5 2.5zM15.9 6.7l2.5-2.5 1.4 1.4-2.5 2.5z'/>"),
};
const DARK = `color-scheme:dark;
  --bg:#080e0d;--panel:#0d1614;--panel-2:#142220;--panel-dark:#0b1311;--hover:rgba(238,242,238,.09);--band:rgba(238,242,238,.055);
  --ink:#f2f5f2;--ink-2:#dde5e2;--muted:#b3c0bc;--faint:#8d9d99;--line:rgba(238,242,238,.1);--line-soft:rgba(238,242,238,.08);--line-2:rgba(238,242,238,.16);
  --orange:#ff642f;--orange-soft:rgba(255,100,47,.2);--brand-ink:#1a0904;--teal:#142220;
  --s-working:#5aa9ff;--s-waiting:#f5b83d;--s-error:#ff6363;--s-idle:#a9b7b3;--s-later:#c58bff;--s-done:#62c98a;
  --ok:#62c98a;--warn:#f5b83d;--danger:#ff6363;--tint:16%;--shadow:rgba(0,0,0,.45);`;
const LIGHT = `color-scheme:light;
  --bg:#f6f7f4;--panel:#ffffff;--panel-2:#eaeee8;--panel-dark:#f0f2ee;--hover:rgba(16,32,28,.07);--band:rgba(16,32,28,.04);
  --ink:#0c1a17;--ink-2:#1f302c;--muted:#45544f;--faint:#5c6965;--line:rgba(16,32,28,.09);--line-soft:rgba(16,32,28,.06);--line-2:rgba(16,32,28,.17);
  --orange:#f0531c;--orange-soft:rgba(240,83,28,.16);--brand-ink:#fff;--teal:#eaeee8;
  --s-working:#1f6fd6;--s-waiting:#a8690a;--s-error:#d33434;--s-idle:#56635f;--s-later:#8a3fd1;--s-done:#23874d;
  --ok:#23874d;--warn:#c07c10;--danger:#d33434;--tint:11%;--shadow:rgba(16,32,28,.18);`;
// Column labels and the default track of each column when the viewer has not resized it.
const COLUMN_LABELS = Object.freeze({ conversation: "Conversation", comment: "Comment", channel: "Channel", status: "Status", last: "Last", actions: "Actions" });
const COLUMN_TEMPLATES = Object.freeze({ conversation: "minmax(0,1.6fr)", comment: "minmax(var(--col-comment-min),1fr)", channel: "var(--col-channel)", status: "124px", last: "44px", actions: "var(--col-actions)" });
// The narrowest each default track can get; a row (and a channel card) never gets narrower than
// the sum of these, so the table scrolls instead of letting cells spill out of it.
const COLUMN_FLOORS = Object.freeze({ conversation: "0px", comment: "var(--col-comment-min)", channel: "var(--col-channel-min)", status: "124px", last: "44px", actions: "var(--col-actions)" });
const COLUMN_CONFIG = Object.freeze({ ids: ACTIVITY_COLUMNS, hideable: ACTIVITY_HIDEABLE_COLUMNS, labels: COLUMN_LABELS, templates: COLUMN_TEMPLATES, floors: COLUMN_FLOORS,
  min: ACTIVITY_COLUMN_MIN_WIDTHS, max: ACTIVITY_COLUMN_MAX_WIDTH, commentMax: ACTIVITY_COMMENT_MAX });
const DEFAULT_COLUMN_TEMPLATE = ACTIVITY_COLUMNS.map((id) => COLUMN_TEMPLATES[id]).join(" ");
// Headers are draggable to reorder; every resizable header carries a focusable edge.
const tableHead = () => `<thead><tr>${ACTIVITY_COLUMNS.map((id) => `<th scope="col" data-col="${id}" draggable="true" title="Drag to move the ${COLUMN_LABELS[id]} column"><span class="col-label">${COLUMN_LABELS[id]}</span>${
  Object.hasOwn(ACTIVITY_COLUMN_MIN_WIDTHS, id) ? `<span class="col-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the ${COLUMN_LABELS[id]} column" title="Drag to resize · double-click to reset"></span>` : ""}</th>`).join("")}</tr></thead>`;
// Skills is a Settings section that keeps its own page: the same Settings shell, with static links.
const SETTINGS_SECTION_LINKS = [["general", "General"], ["voice", "Voice calls"], ["connections", "Connections"], ["email", "Email accounts"], ["mcps", "MCP servers"], ["variables", "Variables"], ["skills", "Skills"], ["ssh", "SSH keys"], ["api", "API tokens"]];
const skillsInSettings = (base, emailAccounts) => `<section class="settings-page" aria-label="Settings"><div class="settings-head"><h1>Settings</h1><p class="settings-copy">Your own preferences and connections. They follow you into every conversation; nobody else's runs use them.</p></div><div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections">${SETTINGS_SECTION_LINKS.filter(([id]) => id !== "email" || emailAccounts).map(([id, label]) => `<a class="settings-tab" href="${id === "skills" ? `${base}/skills` : `${base}/settings#${id}`}"${id === "skills" ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav><div class="settings-panel settings-skills">${SKILLS_HTML}</div></div></section>`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function activityPage({ sessionId, csrf, view = "activity", agent = "", theme = "system", teamId = "", voiceCalls = false, connectionsPage = false, connectionsNew = false, emailPage = false, callTarget = null, logoColor = getLogoColor(), emailAccounts = getEmailAccountsEnabled() }) {
  const subscriptionsView = view === "subscriptions", settingsView = view === "settings", callsView = view === "calls", roiView = view === "roi", automationsView = view === "automations" || roiView, skillsView = view === "skills";
  const base = `/activity/${encodeURIComponent(sessionId)}`;
  const nonce = crypto.randomBytes(16).toString("base64url");
  const launch = callTarget && /^[A-Z0-9_]{1,32}$/.test(String(callTarget.channelId || "")) && (!callTarget.threadTs || /^\d{1,13}\.\d{1,6}$/.test(String(callTarget.threadTs)))
    ? { channelId: String(callTarget.channelId), threadTs: String(callTarget.threadTs || "") } : null;
  const config = JSON.stringify({ base, csrf, view, page: roiView ? "roi" : "", roiHref: `${base}/roi`, boardHref: `${base}/automations`, connectionsPage, connectionsNew, emailPage: emailPage && emailAccounts, emailAccounts: emailAccounts === true, themeColors: ACTIVITY_APP_COLORS, teamId: /^[A-Z0-9]{2,32}$/.test(String(teamId)) ? String(teamId) : "", defaultGroupOrder: DEFAULT_ACTIVITY_GROUP_ORDER, defaultGrouping: DEFAULT_ACTIVITY_GROUPING, columns: COLUMN_CONFIG, voiceCalls: voiceCalls === true,
    ...(voiceCalls ? { ...callOverlayConfig({ base, csrf, agent }), callTarget: launch } : {}) }).replaceAll("<", "\\u003c");
  const agentName = String(agent || "").trim() || "ChannelGate";
  const pinned = theme === "dark" || theme === "light" ? ` data-theme="${theme}"` : "";
  const filters = [["active", "Active"], ["working", "Working"], ["waiting", "Waiting"], ["error", "Error"], ["idle", "Idle"], ["later", "Later"], ["done", "Completed"], ["open", "All open"], ["hidden", "Hidden"]];
  return { nonce, html: `<!doctype html>
<html lang="en"${pinned}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${skillsView ? "Skills" : roiView ? "ROI" : automationsView ? "Automations" : callsView ? "Calls" : subscriptionsView ? "Subscriptions" : settingsView ? "Settings" : "Activity"} · ChannelGate</title>${activityAppHead(logoColor, theme)}
<style nonce="${nonce}">
${ACTIVITY_THEME_CSS}
${SUBSCRIPTION_CSS}
${CALL_HISTORY_CSS}
${AUTOMATION_BOARD_CSS}
${SKILLS_CSS}
@font-face{font-family:Geist;font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/geist-latin.woff2") format("woff2")}
@font-face{font-family:"Geist Mono";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/geistmono-latin.woff2") format("woff2")}
:root{${DARK}--font:Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]){${LIGHT}}}
:root[data-theme=light]{${LIGHT}}
:root[data-theme=dark]{${DARK}}
body{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;font:13px/1.45 var(--font);background:var(--bg);color:var(--ink)}
main{display:flex;flex-direction:column;flex:1}
#activity-view{display:flex;flex-direction:column;flex:1}
#activity-view>section{flex:1}
a:hover{text-decoration:none}
.s-working,.pill.working{--c:var(--s-working)}.s-waiting,.pill.waiting{--c:var(--s-waiting)}.s-error,.pill.error{--c:var(--s-error)}.s-idle,.pill.idle{--c:var(--s-idle)}.s-later,.pill.later{--c:var(--s-later)}.s-done,.pill.done{--c:var(--s-done)}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;min-height:52px;padding:8px 16px;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.agent{display:flex;align-items:center;gap:10px;min-width:0;margin-right:auto}
.agent-mark{display:block;flex:none;width:28px;height:28px}.agent-mark svg{display:block;width:100%;height:100%}
.agent-name{display:block;font-size:14px;font-weight:600;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.connection{display:flex;align-items:center;gap:6px;white-space:nowrap;font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.connection::before{content:"";width:6px;height:6px;background:var(--warn);border-radius:50%}
.connection.live::before{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}
.connection.offline::before{background:var(--faint)}
.top .subscription-quick-list{display:flex;align-items:center;gap:14px;margin:0;grid-template-columns:none}
.top .subscription-quick{display:flex;align-items:center;gap:7px;padding:0;background:none;border:0;border-radius:0;font-size:11.5px;color:var(--muted);white-space:nowrap;--m:var(--ok)}
.top .subscription-quick.warning{--m:var(--warn)}.top .subscription-quick.critical{--m:var(--danger)}.top .subscription-quick.unavailable{--m:transparent}
.top .subscription-quick.stale{opacity:.6}
.top .subscription-quick-name{font-size:11.5px;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.top .subscription-quick-list{min-width:0;flex-wrap:wrap}
.top .subscription-quick progress{width:46px;height:4px;border-radius:4px;background:var(--line-2);accent-color:var(--m)}
.top .subscription-quick progress::-webkit-progress-bar{background:var(--line-2);border-radius:4px}
.top .subscription-quick progress::-webkit-progress-value{background:var(--m);border-radius:4px}
.top .subscription-quick progress::-moz-progress-bar{background:var(--m);border-radius:4px}
.top .subscription-quick strong{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--ink)}
.top .subscription-quick.unavailable strong{color:var(--faint)}
.subscription-ring{display:none;width:18px;height:18px;transform:rotate(-90deg)}
.subscription-ring circle{fill:none;stroke-width:3}.ring-track{stroke:var(--line-2)}.ring-value{stroke:var(--m);stroke-linecap:round}
#subscriptions-notice:empty{display:none}
.top #subscriptions-notice{margin:0;font-size:11px;color:var(--faint)}
.page-nav{display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px}
.page-nav a{padding:4px 9px;border-radius:6px;font-size:12px;color:var(--ink-2)}
.page-nav a:hover{color:var(--ink)}
.page-nav a[aria-current=page]{background:var(--panel-2);color:var(--ink);font-weight:600;box-shadow:none}
.icon-button{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:1px solid var(--line-2);border-radius:7px;background:transparent;color:var(--muted)}
.icon-button,.icon-button,.open-link,.call-link,.toggle,.more-toggle{position:relative}
.icon-button::before,.open-link::before,.call-link::before,.toggle::before,.more-toggle::before{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
#theme-toggle{--icon:${ICONS.moon}}#theme-toggle[data-theme=light]{--icon:${ICONS.sun}}
.icon-button:hover{color:var(--ink);border-color:var(--muted)}
/* Header: wide screens show every page link; narrow ones fold them and the theme switch into a menu. */
.page-menu{display:contents}
.page-nav{order:1}#call-agent{order:2}#theme-toggle{order:3}.nav-toggle{order:4}
.menu-text{display:none}
.nav-toggle{display:none;--icon:${ICONS.menu}}.nav-toggle[aria-expanded=true]{--icon:${ICONS.close};color:var(--ink);border-color:var(--muted)}
.filter-pick{display:none;flex:0 1 auto;min-width:0}
.filter-pick select,.bar-button{height:30px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);font:inherit;font-size:12px}
.filter-pick select{max-width:100%;padding:0 6px;font-weight:600}
.bar-button{flex:none;padding:0 10px;color:var(--ink-2);white-space:nowrap}
.bar-button:hover{color:var(--ink);border-color:var(--muted)}
.more-toggle{display:none;--icon:${ICONS.more}}.more-toggle[aria-expanded=true]{--icon:${ICONS.less}}
.columns-device{font-size:12px!important;margin:-4px 0 0}
.order-dialog .order-show{order:1;margin-left:auto;margin-right:10px;min-width:72px;min-height:36px}
.order-dialog .order-show[aria-pressed=true]{color:var(--ok)}
.order-list li .order-moves{order:2}
.order-list li[data-hidden="1"] .order-label{color:var(--faint);text-decoration:line-through}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-height:44px;padding:0 10px;border-bottom:1px solid var(--line)}
.filters{display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none;padding:0;border:0}
.filters button{display:flex;align-items:center;gap:6px;flex-shrink:0;height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--ink-2);font-size:12px;white-space:nowrap}
.filters button:hover{color:var(--ink);background:var(--hover)}
.filters button[aria-pressed=true]{color:var(--ink);background:var(--panel-2);font-weight:600;box-shadow:none}
.filters button i{width:6px;height:6px;border-radius:50%;background:var(--c)}
.filters span{margin-left:0;font-family:var(--mono);font-size:11px;color:var(--muted);opacity:1;font-weight:400}
.grouping{display:flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap;color:var(--ink-2);font-size:12px}
.grouping select{height:30px;padding:0 6px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);font:inherit}
.search-wrap{position:relative;flex:0 1 240px;min-width:140px;margin-left:auto}
.search-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
input{width:100%;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);font-size:12px}
input::placeholder{color:var(--faint)}
.notice{margin:10px 14px 0;padding:9px 12px;border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);background:color-mix(in srgb,var(--warn) 12%,transparent);color:var(--ink);border-radius:8px;font-size:12.5px}
table{display:block;width:100%;border-collapse:collapse}
thead,tbody{display:block}
:root{--col-channel-min:120px;--col-channel:minmax(var(--col-channel-min),190px);--col-gap:12px;--col-comment-min:110px;--col-actions:192px}
table{overflow-x:auto}
thead tr,tbody tr{display:grid;grid-template-columns:var(--cols,${DEFAULT_COLUMN_TEMPLATE});align-items:center;column-gap:var(--col-gap);padding:0 16px}
/* A row is never narrower than its tracks (--tracks-min, painted with --cols): resized columns
   scroll the table instead of spilling out of their row or card. The fixed part is the row
   chrome: 16px padding a side, or in a channel card the body's 12px padding + 1px border + the
   row's 44px indent on the left and 12px + 1px + 3px on the right. */
thead,tbody{min-width:calc(var(--tracks-min,0px) + var(--track-gaps,5) * var(--col-gap) + 32px)}
tbody[data-cards],table[data-cards] thead{min-width:calc(var(--tracks-min,0px) + var(--track-gaps,5) * var(--col-gap) + 73px)}
table[data-cards] thead tr{padding:0 16px 0 57px}
.pinned-section{margin:0 0 24px}
.pinned-heading{display:flex;align-items:center;gap:10px;margin:0;padding:12px 16px;font:600 13px var(--font);color:var(--ink)}
.pinned-channels{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}
.pinned-channel{display:flex;align-items:center;gap:8px;max-width:100%;padding:5px 8px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.pinned-channel[hidden],.pinned-channels[hidden]{display:none}
.load-more-row{display:flex;justify-content:center;margin:14px 0}.load-more[hidden]{display:none}
.load-more{font:500 13px var(--font);padding:8px 18px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.load-more:disabled{opacity:.6;cursor:default}
.pinned-channel .channel-link{overflow-wrap:anywhere;min-width:0;font-size:12px}
.pinned-channel-count{color:var(--muted);font:10px var(--mono)}
.pinned-channel .channel-pin{flex:none}
.pinned-heading span{font:500 11px var(--mono);color:var(--muted)}
thead tr{height:30px;border-bottom:1px solid var(--line)}
th{position:relative;min-width:0;padding:0;font:500 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left;cursor:grab;user-select:none}
th .col-label{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
th[data-col=actions]{text-align:right}
th[data-dragging]{opacity:.45}
th[data-drop=before]{box-shadow:inset 2px 0 var(--orange)}th[data-drop=after]{box-shadow:inset -2px 0 var(--orange)}
.col-resize{position:absolute;z-index:1;top:-6px;bottom:-6px;right:-9px;width:12px;cursor:col-resize;touch-action:none}
.col-resize::after{content:"";position:absolute;top:6px;bottom:6px;left:5px;width:2px;border-radius:2px;background:var(--line-2);opacity:0;transition:opacity .12s}
thead tr:hover .col-resize::after,.col-resize:focus-visible::after,.col-resize[data-active]::after{opacity:1}
.col-resize:hover::after,.col-resize[data-active]::after{background:var(--orange)}
.col-resize:focus-visible{outline:none}
:root.col-resizing,:root.col-resizing *{cursor:col-resize!important;user-select:none}
.comment-cell{min-width:0}
.comment-input{display:block;width:calc(100% + 9px);margin-left:-9px;height:28px;padding:0 8px;border-color:transparent;background:transparent;color:var(--ink-2);font:12px var(--font);text-overflow:ellipsis}
tbody tr:hover .comment-input,.comment-input:focus{border-color:var(--line-2)}
.comment-input:focus{outline:none;background:var(--panel);color:var(--ink);border-color:var(--muted)}
.comment-input:placeholder-shown:not(:focus){opacity:0;transition:opacity .12s}
tbody tr:hover .comment-input:placeholder-shown,tbody tr:focus-within .comment-input:placeholder-shown{opacity:1}
.comment-input[data-state=saving]{opacity:.6}
.comment-input[data-state=error]{border-color:var(--danger)}
td{display:block;padding:0;border:0;min-width:0}
tbody tr{min-height:40px;border-bottom:1px solid var(--line-soft);background-image:linear-gradient(90deg,var(--c) 0 3px,transparent 3px)}
tbody tr:nth-child(even){background-color:var(--band)}
tbody tr:hover,tbody tr:focus-within{background-color:var(--hover)}
tbody tr[data-group]::before{content:attr(data-group);overflow-wrap:anywhere;min-width:0;grid-column:1/-1;display:flex;align-items:center;min-height:30px;margin:0 -16px 0;padding:6px 16px;background:var(--panel);border-bottom:1px solid var(--line-soft);font:600 10.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2)}
tbody[data-group-by=status] tr.s-waiting[data-group]::before,tbody[data-group-by=status] tr.s-error[data-group]::before{color:var(--c)}
tbody[data-cards]{padding:2px 12px 14px}
tbody[data-cards] tr{--indent:44px;--pr:3px;--lx:21px;--head:42px;--g:var(--muted);--guide:linear-gradient(90deg,transparent var(--lx),color-mix(in srgb,var(--g) 50%,transparent) var(--lx) calc(var(--lx) + 2px),transparent calc(var(--lx) + 2px));position:relative;padding:0 var(--pr) 0 var(--indent);border:solid var(--line);border-width:0 1px 1px;border-bottom-color:var(--line-soft);background-color:var(--panel);background-image:var(--guide);background-clip:padding-box}
tbody[data-cards] .channel-cell .channel-link{color:var(--faint)}
tbody[data-cards] tr:nth-child(even){background-color:var(--panel)}
tbody[data-cards] tr:hover,tbody[data-cards] tr:focus-within{background-color:color-mix(in srgb,var(--g) 7%,var(--panel))}
tbody[data-cards] tr::after{content:"";position:absolute;left:calc(var(--lx) - 4px);top:calc(50% - 5px);width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 0 3px var(--panel)}
tbody[data-cards] tr[data-group]{margin-top:14px;border-top-width:1px;border-top-left-radius:11px;border-top-right-radius:11px}
tbody[data-cards] tr[data-group]::after{top:calc(var(--head) / 2 + 50% - 5px)}
tbody[data-cards] tr[data-group-end]{border-bottom-color:var(--line);border-bottom-left-radius:11px;border-bottom-right-radius:11px;background-size:100% 50%;background-repeat:no-repeat}
tbody[data-cards] tr[data-group][data-group-end]{background-size:100% calc(var(--head) / 2 + 50%)}
tbody[data-cards] tr[data-group]::before{display:block;height:var(--head);min-height:0;margin:0 calc(-1 * var(--pr)) 0 calc(-1 * var(--indent));padding:0 14px 0 var(--indent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:10px 10px 0 0;border-bottom:1px solid color-mix(in srgb,var(--g) 30%,var(--line));background:radial-gradient(circle at calc(var(--lx) + 1px) 50%,var(--g) 0 6px,transparent 6.5px),color-mix(in srgb,var(--g) 13%,var(--panel));font:600 13px/var(--head) var(--font);letter-spacing:0;text-transform:none;color:var(--ink)}
tbody[data-cards] tr[data-hue="0"]{--g:hsl(222 70% 56%)}tbody[data-cards] tr[data-hue="1"]{--g:hsl(155 70% 45%)}
tbody[data-cards] tr[data-hue="2"]{--g:hsl(28 70% 56%)}tbody[data-cards] tr[data-hue="3"]{--g:hsl(275 70% 56%)}
tbody[data-cards] tr[data-hue="4"]{--g:hsl(345 70% 56%)}tbody[data-cards] tr[data-hue="5"]{--g:hsl(190 70% 56%)}
tbody[data-cards] tr[data-hue="6"]{--g:hsl(52 60% 45%)}tbody[data-cards] tr[data-hue="7"]{--g:hsl(105 60% 45%)}
.thread-cell{padding:10px 0;min-width:0}
.thread-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;color:var(--ink);font-weight:500;line-height:1.4;overflow:hidden;overflow-wrap:anywhere}
tbody tr.s-done{background-color:color-mix(in srgb,var(--s-done) 10%,var(--panel))}
.s-done .thread-title{color:var(--s-done)}
.thread-title:hover{color:var(--ink);text-decoration:underline}
.channel-cell{font:11.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.channel-link{color:inherit}
.channel-cell .channel-link{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.channel-cell{display:flex;align-items:center;gap:6px}
.channel-cell .channel-pin{flex:none}
@media(hover:hover) and (pointer:fine){
  .channel-cell .channel-pin{opacity:0;transition:opacity .12s}
  tbody tr:hover .channel-pin,tbody tr:focus-within .channel-pin{opacity:1}
}
.channel-link[href]:hover{color:var(--ink);text-decoration:underline}
.status-cell{min-width:0}
.pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap;color:var(--c);background:color-mix(in srgb,var(--c) var(--tint),transparent);border:1px solid color-mix(in srgb,var(--c) 28%,transparent)}
.status-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.working .status-dot{animation:pulse 1.6s infinite}
.elapsed{font:10px var(--mono);opacity:.9}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c) 60%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
.time-cell{font:11.5px var(--mono);color:var(--ink-2);text-align:left;white-space:nowrap}
.actions{display:flex;flex-wrap:wrap;min-width:0;justify-content:flex-end;gap:4px;opacity:0;transition:opacity .12s}
tbody tr:hover .actions,tbody tr:focus-within .actions,.s-waiting .actions,.s-error .actions{opacity:1}
.action-links,.action-state{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;justify-content:flex-end;gap:4px;margin:0}
.open-link,.call-link,.toggle,.more-toggle{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;min-height:0;padding:0;border:1px solid var(--line-2);border-radius:7px;background:var(--panel);color:var(--ink-2);font-size:0;line-height:0;overflow:hidden;text-indent:-9999px}
.open-link:hover,.call-link:hover,.toggle:hover,.more-toggle:hover{border-color:var(--muted);background:var(--panel-2);color:var(--ink)}
.open-link{--icon:${ICONS.slack}}
.actions .more-toggle{display:none}
.open-link[data-platform=googlechat],.open-link[data-platform=msteams]{--icon:${ICONS.external}}
.call-link{--icon:${ICONS.call}}
${voiceCalls ? CALL_OVERLAY_CSS : ""}
.toggle[data-state=done]{--icon:${ICONS.done};color:var(--s-done)}
.toggle[data-state=reopen]{--icon:${ICONS.reopen}}
.toggle[data-state=later]{--icon:${ICONS.later};color:var(--s-later)}
.toggle[data-state=resume]{--icon:${ICONS.resume};color:var(--s-later)}
.toggle[data-state=hide]{--icon:${ICONS.hide}}
.toggle[data-state=show]{--icon:${ICONS.reopen}}
.toggle[data-state=busy]{--icon:${ICONS.busy}}
.toggle[data-state=pin],.toggle[data-state=unpin]{--icon:${ICONS.pin}}
.toggle[data-state=unpin]{color:var(--orange);background:var(--orange-soft)}
.empty{text-align:center;padding:56px 24px}
.empty-symbol{font-size:24px;color:var(--faint);margin-bottom:10px}
.empty h2{font-size:15px;margin:0 0 6px}.empty p{color:var(--muted);margin:0;font-size:12.5px}
.footer{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;padding:10px 16px;font:10.5px var(--mono);color:var(--faint);letter-spacing:.03em;margin:0}
.footer-actions{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap}
.link-button{padding:0;border:0;background:none;color:var(--muted);font:inherit;letter-spacing:inherit}
.link-button:hover:not(:disabled){color:var(--ink);text-decoration:underline}
.link-button:disabled{cursor:default;opacity:.5}
.summary{color:var(--faint)}
.privacy{padding:0 16px 18px;color:var(--faint);font-size:11px;margin:0}.js-needed{padding:24px;color:var(--warn)}
.order-dialog{width:min(420px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:22px;color:var(--ink);background:var(--panel);border:1px solid var(--line-2);border-radius:12px;box-shadow:0 20px 50px -20px var(--shadow)}
.order-dialog::backdrop{background:rgba(0,0,0,.55)}
.order-dialog h2{font-size:17px;margin:0 0 10px}.order-dialog p{font-size:13px;color:var(--muted);line-height:1.6}
.order-dialog button,.order-button{border:1px solid var(--line-2);border-radius:7px;padding:8px 12px;color:var(--ink);background:var(--panel-2);font-size:12px}
.order-dialog button:hover,.order-button:hover{border-color:var(--muted)}
.order-list{padding:0;list-style:none;margin:18px 0}.order-list li{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line-soft)}
.order-moves{display:flex;gap:6px}.order-dialog .order-move{min-width:40px;min-height:40px;font-size:16px;padding:6px}
.order-dialog button:disabled{opacity:.4;cursor:default}.order-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.order-dialog .order-save{background:var(--orange);border-color:var(--orange);color:var(--brand-ink)}
.order-dialog .order-error{color:var(--danger);min-height:1.6em}
.subscriptions-page{width:100%;max-width:1800px;margin:0 auto;padding:8px 16px 24px}
.settings-page{width:100%;max-width:1800px;margin:0 auto;padding:18px 16px 32px}
.settings-head h1{font-size:20px;margin:0 0 4px}
.settings-copy{color:var(--muted);font-size:12.5px;margin:0 0 12px;line-height:1.55}
.settings-status{margin:0 0 12px;padding:9px 12px;border-radius:8px;font-size:12.5px;border:1px solid color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.settings-status.error{border-color:color-mix(in srgb,var(--danger) 45%,transparent);background:color-mix(in srgb,var(--danger) 12%,transparent)}
.settings-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:24px;align-items:start}
.settings-nav{display:flex;flex-direction:column;gap:2px;position:sticky;top:64px}
.settings-tab{text-align:left;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px}
a.settings-tab{text-decoration:none}.settings-skills .skills-page{padding:0;max-width:none}
.settings-tab:hover{color:var(--ink);background:var(--hover)}
.settings-tab[aria-current=page]{color:var(--ink);background:var(--panel-2);font-weight:600}
.settings-panel{display:flex;flex-direction:column;gap:14px;min-width:0}
.settings-card{padding:16px 18px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
.settings-card h2{font-size:14.5px;margin:0 0 4px}.settings-card h3{font-size:13px;margin:16px 0 8px;color:var(--ink-2)}
.settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line-soft)}
.settings-row-text{min-width:0}.settings-row-title{font-weight:500;overflow-wrap:anywhere}
.settings-row-meta{display:block;font:11.5px var(--mono);color:var(--muted);overflow-wrap:anywhere;margin-top:2px}
.settings-row-actions{display:flex;gap:6px;flex:none}
.settings-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 14px;margin-top:10px}
.settings-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.settings-label{font-size:11.5px;color:var(--ink-2);font-weight:500}.settings-hint{font-size:11px;color:var(--faint)}
.settings-input{width:100%;min-height:32px;padding:6px 10px;border:1px solid var(--line-2);border-radius:7px;background:var(--panel-dark);color:var(--ink);font:12.5px var(--font)}
textarea.settings-input{min-height:72px;resize:vertical;font-family:var(--mono)}
select.settings-input{height:32px}
.settings-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-2);grid-column:1/-1}
.settings-check input,.settings-skill input{width:16px;height:16px;min-height:0;accent-color:var(--orange)}
.settings-form-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}
.settings-code{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.settings-error{grid-column:1/-1;margin:0;color:var(--danger);font-size:12px;min-height:0}.settings-error:empty{display:none}
.settings-warning{color:var(--warn);font-size:12px}
.settings-empty{color:var(--faint);font-size:12.5px;margin:8px 0 0}
.settings-button{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border:1px solid var(--line-2);border-radius:7px;background:var(--panel-2);color:var(--ink);font-size:12px;white-space:nowrap}
.settings-button:hover:not(:disabled){border-color:var(--muted)}
.settings-button:disabled{opacity:.5;cursor:default}
.settings-button.primary{background:var(--orange);border-color:var(--orange);color:var(--brand-ink)}
.settings-button.danger{color:var(--danger)}.settings-button.ghost{background:transparent}
.connections-card>.settings-row:first-child{border-top:0;padding-top:0;align-items:flex-start}
.connections-card .settings-row-actions{flex-wrap:wrap}
.connections-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:18px 0}
.connections-toolbar>.settings-input{max-width:320px;min-width:0}
.connections-tabs{display:flex;gap:4px;padding:4px;background:var(--panel-dark);border:1px solid var(--line-soft);border-radius:9px;flex-shrink:0}
.connections-tabs button{border:0;background:transparent;color:var(--muted);padding:7px 12px;border-radius:6px;font:12.5px var(--font)}
.connections-tabs button[aria-pressed=true],.connections-tabs button[aria-selected=true]{background:var(--panel-2);color:var(--ink);box-shadow:0 1px 3px #0002}
.connections-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr));gap:10px;margin:12px 0}
.connection-app-card{display:flex;align-items:center;gap:10px;width:100%;min-height:76px;padding:12px;text-align:left;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);cursor:pointer;min-width:0}
.connection-app-card:hover{border-color:var(--orange);background:var(--hover)}
.connection-app-card:focus-visible{outline:2px solid var(--orange);outline-offset:3px}
.connection-app-text{min-width:0}
.connection-app-icon img{display:block;max-width:28px;max-height:28px;object-fit:contain}
.connection-app-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;height:34px;border-radius:8px;background:var(--panel-2);color:var(--orange);font-size:17px;font-weight:700}
.connection-app-name{display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere;margin-bottom:5px}
.connection-app-status{display:block;font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.connections-pagination{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px;flex-wrap:wrap}.connections-pagination[hidden]{display:none}.connections-page-label{font-size:12px;color:var(--muted)}.connections-pagination [role=status]{font-size:12px;color:var(--muted)}
.connection-detail{margin-top:18px}
.connection-detail>.settings-row:first-child{padding:16px 0}
.connection-account-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;border-top:1px solid var(--line-soft);flex-wrap:wrap}
.connection-account-row>.settings-row-text{flex:1 1 180px}
.connection-account-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.connection-delete-confirm{flex-basis:100%;padding:14px;border:1px solid color-mix(in srgb,var(--danger) 40%,var(--line));border-radius:8px;background:var(--panel-dark)}
.connection-delete-confirm:empty{display:none}
.connection-delete-confirm .settings-copy{color:var(--ink-2);margin-bottom:12px}
.connection-delete-confirm button+button{margin-left:8px}
.connections-selection:empty{display:none}
.connections-selection .settings-form{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel-dark);margin:18px 0}
.connections-selection .settings-form h3{grid-column:1/-1;margin:0}
@media(max-width:640px){.connections-toolbar{align-items:stretch;flex-direction:column}.connections-toolbar>.settings-input{max-width:none}.connections-tabs{align-self:flex-start}.connections-card{padding:14px}.connection-app-card{min-height:72px}.connection-delete-confirm button{max-width:100%;white-space:normal;height:auto;min-height:32px}.connection-account-actions{width:100%}}
.settings-email-editor{margin-top:16px}.settings-email-editor summary{cursor:pointer;font-weight:500;font-size:13px}
.settings-skill-list{display:flex;flex-direction:column;max-height:420px;overflow:auto;margin:10px 0;border:1px solid var(--line);border-radius:8px}
.settings-skill{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-bottom:1px solid var(--line-soft)}
.settings-skill[hidden]{display:none}.settings-skill-text{display:flex;flex-direction:column;min-width:0}
.subscription-card{background:var(--panel)}
@media(prefers-reduced-motion:reduce){.pill.working .status-dot{animation:none}.actions{transition:none}}
@media(hover:none){.actions{opacity:1}.comment-input:placeholder-shown:not(:focus){opacity:1}}
@media(max-width:980px){
  :root{--col-channel-min:90px;--col-channel:minmax(var(--col-channel-min),125px);--col-gap:8px}
}
/* Tablets and phones: a row shows Open and Done plus a More button that unfolds a labelled strip
   of every action under the row, so seven 28px buttons never crowd out the conversation. */
@media(max-width:1100px){
  :root{--col-actions:96px;--col-comment-min:90px}
  .actions .more-toggle{display:inline-grid}
  tbody tr:not([data-more]) .actions .call-link,tbody tr:not([data-more]) .actions .toggle[data-operation]{display:none}
  .actions{opacity:1}
  tbody tr[data-more] .actions{grid-column:1/-1;grid-row:2;justify-content:flex-start;gap:6px;padding:2px 0 10px}
  tbody tr[data-group][data-more] .actions{grid-row:3}
  tbody tr[data-more] .action-links,tbody tr[data-more] .action-state{display:contents}
  tbody tr[data-more] .actions :is(.open-link,.call-link,.toggle,.more-toggle){width:auto;height:34px;padding:0 12px 0 32px;font-size:12.5px;line-height:32px;text-indent:0;white-space:nowrap}
  tbody tr[data-more] .actions :is(.open-link,.call-link,.toggle,.more-toggle)::before{inset:0 auto 0 11px;margin:auto 0}
}
/* Below 1500px (tablets, phones, small laptops): each subscription meter is a ring and its percentage (the name stays in
   its tooltip), so long account names never push the page wider than the screen. */
@media(max-width:1500px){
  .top .subscription-quick progress,.top .subscription-quick-name{display:none}
  .subscription-ring{display:block}
  .top .subscription-quick-list{gap:10px}
}
/* Narrow windows: status tabs become one menu, and the header folds into a menu button. */
@media(max-width:1100px){
  .filters{display:none}
  .filter-pick{display:block}
  .nav-toggle{display:grid}
  .page-menu{display:none;position:absolute;top:calc(100% + 4px);right:12px;z-index:20;flex-direction:column;min-width:220px;max-width:calc(100vw - 24px);padding:6px;background:var(--panel);border:1px solid var(--line-2);border-radius:12px;box-shadow:0 18px 40px -16px var(--shadow)}
  .top[data-menu=open] .page-menu{display:flex}
  .top .page-menu .page-nav{flex-direction:column;gap:2px;padding:0;margin:0;border:0;max-width:none;overflow:visible}
  .page-menu .page-nav a{padding:10px 12px;border-radius:8px;font-size:14px}
  .page-menu .page-nav a:hover{background:var(--hover)}
  .page-menu #theme-toggle{display:flex;align-items:center;width:100%;height:42px;margin-top:4px;padding:0 12px 0 40px;border:0;border-top:1px solid var(--line-soft);border-radius:0 0 8px 8px;color:var(--ink-2);font:inherit;font-size:14px}
  .page-menu #theme-toggle::before{inset:0 auto 0 13px;margin:auto 0;width:16px;height:16px}
  .page-menu .menu-text{display:inline}
}
@media(pointer:coarse){
  th{cursor:default}
  .col-resize{width:24px;right:-15px}
  .col-resize::after{left:11px}
}
@media(max-width:640px){
  .settings-layout{grid-template-columns:1fr}
  .settings-nav{position:static;flex-direction:row;overflow-x:auto}
  .settings-row{flex-wrap:wrap}
  .top{padding:8px 12px;gap:8px 10px}
  .agent-name{max-width:150px}
  .top .subscription-quick-list{order:1;gap:10px}
  .call-text{display:none}
  #call-agent{padding:0 9px}
  .bar{flex-wrap:wrap;padding:6px 8px;gap:6px}
  .search-wrap{flex:1 1 100%;margin:0;order:-1}
  thead{display:none}
  tbody,tbody[data-cards]{min-width:0}
  tbody tr{grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:10px;row-gap:5px;padding:9px 12px}
  tbody tr[data-group]::before{margin:-9px -12px 4px;padding:0 12px}
  .thread-cell{grid-column:1/3;grid-row:2;padding:0}
  tbody tr[data-group] .thread-cell{grid-row:2}
  .time-cell{grid-column:3;grid-row:2;text-align:right}
  .status-cell{grid-column:1;grid-row:3}
  .channel-cell{display:flex;grid-column:2;grid-row:3}
  .actions{grid-column:3;grid-row:3}
  .comment-cell{grid-column:1/-1;grid-row:4}
  tbody tr:not([data-group]) .comment-cell{grid-row:3}
  tbody tr:not([data-group]) .thread-cell{grid-row:1}tbody tr:not([data-group]) .time-cell{grid-row:1}
  tbody tr:not([data-group]) .status-cell,tbody tr:not([data-group]) .channel-cell,tbody tr:not([data-group]) .actions{grid-row:2}
  .pill{height:20px;font-size:11px;padding:0 8px}
  .open-link,.call-link,.toggle{width:32px;height:32px}
  tbody[data-cards]{padding:2px 8px 12px}
  tbody[data-cards] tr{--indent:34px;--pr:10px;--lx:15px;--head:38px;padding:9px var(--pr) 9px var(--indent)}
  tbody[data-cards] tr::after{top:14px}
  tbody[data-cards] tr[data-group]::before{margin:-9px calc(-1 * var(--pr)) 4px calc(-1 * var(--indent));padding:0 12px 0 var(--indent)}
  tbody[data-cards] tr[data-group]::after{top:calc(var(--head) + 9px)}
  tbody[data-cards] tr[data-group-end]{background-size:100% 19px}
  tbody[data-cards] tr[data-group][data-group-end]{background-size:100% calc(var(--head) + 14px)}
  .bar .filter-pick{flex:1 1 auto}
  .bar .filter-pick select{width:100%}
  .grouping label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  tbody tr[data-more] .actions{grid-column:1/-1;grid-row:3;padding:4px 0 2px}
  tbody tr[data-group][data-more] .actions{grid-row:4}
  tbody tr[data-more] .comment-cell{grid-row:4}
  tbody tr[data-group][data-more] .comment-cell{grid-row:5}
}
/* Only installed apps with the overlay enabled occupy the native title-bar area. The
   browser supplies both side insets, including macOS traffic lights and its app menu. */
@media(display-mode:window-controls-overlay){
  .top{padding-top:calc(env(titlebar-area-y,0px) + 8px);padding-left:calc(env(titlebar-area-x,0px) + 16px);padding-right:calc(100% - env(titlebar-area-x,0px) - env(titlebar-area-width,100%) + 16px);min-height:max(52px,calc(env(titlebar-area-y,0px) + env(titlebar-area-height,0px)));background:var(--bg);-webkit-app-region:drag;app-region:drag;user-select:none}
  .top a,.top button,.top input,.top select{-webkit-app-region:no-drag;app-region:no-drag}
  .top .page-nav{min-width:0;max-width:100%;flex-wrap:wrap}
}
</style></head><body>
<header class="top"><div class="agent"><span class="agent-mark" aria-hidden="true">${channelGateLogo(logoColor)}</span><div><span class="agent-name">${escapeHtml(agentName)}</span>${settingsView || callsView || automationsView || skillsView ? "" : '<div id="connection" class="connection reconnecting" role="status"><span id="connection-text">Connecting…</span></div>'}</div></div>
${subscriptionsView || settingsView || callsView || automationsView || skillsView ? "" : '<div id="subscription-quick" class="subscription-quick-list" aria-label="Subscription usage" hidden></div><div id="subscriptions-notice" role="status" aria-live="polite"></div>'}
<div id="page-menu" class="page-menu"><nav class="page-nav" aria-label="Dashboard"><a href="${base}"${view === "activity" ? ' aria-current="page"' : ''}>Activity</a><a href="${base}/calls"${callsView ? ' aria-current="page"' : ''}>Calls</a><a href="${base}/automations"${automationsView && !roiView ? ' aria-current="page"' : ''}>Automations</a><a href="${base}/roi"${roiView ? ' aria-current="page"' : ''}>ROI</a><a href="${base}/subscriptions"${subscriptionsView ? ' aria-current="page"' : ''}>Subscriptions</a><a href="${base}/settings"${settingsView || skillsView ? ' aria-current="page"' : ''}>Settings</a></nav>
<button id="theme-toggle" class="icon-button" type="button" aria-label="Switch theme" title="Switch theme"><span class="menu-text" aria-hidden="true">Switch theme</span></button></div>
${voiceCalls && view === "activity" ? '<button id="call-agent" type="button" title="Start a voice call with the agent" aria-label="Call the agent">📞<span class="call-text"> Call</span></button>' : ""}<button id="nav-toggle" class="icon-button nav-toggle" type="button" aria-expanded="false" aria-controls="page-menu" aria-label="Menu" title="Menu"></button></header>
<main>
${subscriptionsView ? `<section class="subscriptions-page" aria-label="Subscriptions"><div class="subscriptions-head"><h1>Subscriptions</h1><button id="subscriptions-refresh" class="order-button" type="button">Refresh</button></div><p class="subscriptions-copy">Account-wide usage · refreshes every 10 minutes.</p><div id="subscriptions-notice" role="status" aria-live="polite"></div><div id="subscriptions-cards" class="subscription-grid"></div></section>` : ""}
${skillsView ? skillsInSettings(base, emailAccounts) : roiView ? AUTOMATION_ROI_HTML : automationsView ? AUTOMATION_BOARD_HTML : callsView ? `<section class="calls-page" aria-label="Call history"><div class="calls-head"><h1>Calls</h1><button id="calls-refresh" class="order-button" type="button">Refresh</button></div><p class="calls-copy">Your completed calls · estimated voice cost in USD. Agent tasks dispatched during a call are billed separately. Expand a call for its summary and thread posts.</p><p class="calls-copy">History starts with calls completed after this update.</p><p id="calls-status" role="status" aria-live="polite">Loading calls…</p><div id="call-history"></div><button id="calls-more" class="order-button" type="button" hidden>Load older calls</button><noscript><p>Enable JavaScript to view call history.</p></noscript></section>` : settingsView ? `<section class="settings-page" aria-label="Settings"><div class="settings-head"><h1>Settings</h1><p class="settings-copy">Your own preferences and connections. They follow you into every conversation; nobody else's runs use them.</p></div><div id="settings-status" class="settings-status" role="status" aria-live="polite" hidden></div><div class="settings-layout"><nav id="settings-nav" class="settings-nav" aria-label="Settings sections"></nav><div id="settings-panel" class="settings-panel"></div></div><noscript><p class="js-needed">Enable JavaScript to manage your settings.</p></noscript></section>` : `<div id="activity-view"${subscriptionsView ? " hidden" : ""}>
<dialog id="order-dialog" class="order-dialog" aria-labelledby="order-title" aria-describedby="order-description"><h2 id="order-title">Arrange status groups</h2><p id="order-description">Move groups up or down. Newest conversations appear first within each group. Your order is saved to your account.</p><ol id="order-list" class="order-list"></ol><button id="order-reset" type="button">Reset to default</button><p id="order-error" class="order-error" role="alert"></p><div class="order-footer"><button id="order-cancel" type="button">Cancel</button><button id="order-save" class="order-save" type="button">Save order</button></div></dialog>
<dialog id="columns-dialog" class="order-dialog" aria-labelledby="columns-title" aria-describedby="columns-description"><h2 id="columns-title">Arrange columns</h2><p id="columns-description">Move columns up or down, or hide the ones you don’t need. On a computer you can also drag a column header to move it and drag its edge to resize it.</p><p id="columns-device" class="columns-device"></p><ol id="columns-list" class="order-list"></ol><button id="columns-reset" type="button">Reset order and widths</button><p id="columns-error" class="order-error" role="alert"></p><div class="order-footer"><button id="columns-cancel" type="button">Cancel</button><button id="columns-save" class="order-save" type="button">Save columns</button></div></dialog>
<dialog id="all-done-dialog" class="order-dialog" aria-labelledby="all-done-title" aria-describedby="all-done-description"><h2 id="all-done-title">Mark all threads you started done?</h2><p id="all-done-description">This marks tracked agent threads you started done and removes them from your Active view across all channels, including threads outside the current filter, search, or page. Hidden threads and conversations started by someone else stay unchanged. Slack main messages get ✅; Google Chat and Teams completion is saved in Activity. Running work continues.</p><p id="all-done-error" class="order-error" role="alert"></p><div class="order-footer"><button id="all-done-cancel" type="button" autofocus>Cancel</button><button id="all-done-confirm" class="order-save" type="button">Mark All Done</button></div></dialog>
<section aria-label="Conversations"><div class="bar"><div class="filter-pick"><label class="search-label" for="filter-select">Show conversations</label><select id="filter-select">${filters.map(([value, label]) => `<option value="${value}" data-label="${label}"${value === "active" ? " selected" : ""}>${label}</option>`).join("")}</select></div><div id="filters" class="filters" role="group" aria-label="Filter by status">${filters.map(([value, label]) => `<button type="button" class="s-${value}" data-filter="${value}" aria-pressed="${value === "active"}">${["working", "waiting", "error", "idle", "later", "done"].includes(value) ? '<i aria-hidden="true"></i>' : ""}${label}<span>0</span></button>`).join("")}</div>
<div class="grouping"><label for="group-by">Group by</label><select id="group-by"><option id="group-none" value="none" hidden disabled>None</option><option value="channel">Channel</option><option value="status">Status</option></select></div>
<button id="columns-quick" class="bar-button" type="button" aria-haspopup="dialog" title="Move, hide or resize columns">Columns</button>
<div class="search-wrap"><label class="search-label" for="search">Search conversations or channels</label><input type="search" id="search" placeholder="Filter threads…" autocomplete="off" maxlength="300"></div></div>
<div id="notice" class="notice" role="alert" hidden></div>
<section id="pinned-section" class="pinned-section" aria-labelledby="pinned-title" hidden><h2 id="pinned-title" class="pinned-heading">Pinned conversations <span id="pinned-count">0</span></h2>
<div id="pinned-channels" class="pinned-channels" aria-label="Pinned channels" hidden></div>
<table id="pinned-table" aria-label="Pinned conversations">${tableHead()}<tbody id="pinned-threads"></tbody></table></section>
<table id="table" hidden>${tableHead()}<tbody id="threads"></tbody></table><div class="load-more-row"><button type="button" id="load-more" class="load-more" hidden>Load more</button></div>
<div id="empty" class="empty" role="status"><div class="empty-symbol" aria-hidden="true">◎</div><h2 id="empty-title">Loading your activity…</h2><p id="empty-copy">Your latest conversations will appear here.</p></div>
<noscript><p class="js-needed">Enable JavaScript to view live activity.</p></noscript></section>
<footer class="footer"><div class="footer-actions"><span id="summary" class="summary">Loading activity…</span><button id="group-order" class="link-button" type="button" aria-haspopup="dialog">⇅ Group order</button><button id="columns-button" class="link-button" type="button" aria-haspopup="dialog">▤ Columns</button><button id="mark-all-done" class="link-button" type="button" aria-haspopup="dialog" disabled>✓ Mark All Done</button><button id="load-history" class="link-button" type="button" disabled>Load older threads</button></div><div class="footer-actions"><span id="result-count"></span><span id="updated">Waiting for updates</span></div></footer>
<p class="privacy">Your conversations are private. <a href="/activity/login">sign in again</a> when your session expires.</p>
</div>`}
</main>${voiceCalls && view === "activity" ? callOverlayMarkup({ agentName }) : ""}<script nonce="${nonce}">${skillsView ? `(${themeBrowser.toString()})(${config}, globalThis);(${skillsBrowser.toString()})(${config}, globalThis);` : automationsView ? `(${themeBrowser.toString()})(${config}, globalThis);(${automationBoardBrowser.toString()})(${config}, globalThis);` : callsView ? `(${themeBrowser.toString()})(${config}, globalThis);(${callHistoryBrowser.toString()})(${config}, globalThis);` : settingsView
    ? `(${settingsBrowser.toString()})(${config}, globalThis, (${themeBrowser.toString()})(${config}, globalThis), (${activityConnectionsBrowser.toString()})(${config}, globalThis));`
    : `(${themeBrowser.toString()})(${config}, globalThis);(${activityBrowser.toString()})(${config}, globalThis, (${createSubscriptionUi.toString()})()${voiceCalls && view === "activity" ? `, (${callOverlayBrowser.toString()})(${config}, globalThis)` : ""});`}</script></body></html>` };
}
