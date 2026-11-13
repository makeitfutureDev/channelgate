// Cookie-authenticated browser dashboard with self-hosted brand assets and no browser storage.
import crypto from "node:crypto";
import { getLogoColor } from "../config/settings.js";
import { channelGateLogo } from "../config/appearance.js";
import { ACTIVITY_THEME_CSS } from "./activity-theme.js";
import { createSubscriptionUi, SUBSCRIPTION_CSS } from "../../public/subscription-ui.js";
import { DEFAULT_ACTIVITY_GROUP_ORDER } from "./activity-order.js";
import { activityAppHead } from "./activity-app.js";

// The header's theme switch, shared by every dashboard view. Matching the system choice clears
// the override, so the page follows the OS again; a failed save keeps the theme for this page only.
function themeBrowser(config, browser) {
  "use strict";
  const { base, csrf } = config;
  const { document } = browser;
  const themeButton = document.getElementById("theme-toggle"), root = document.documentElement, scheme = browser.matchMedia?.("(prefers-color-scheme: light)");
  const effectiveTheme = () => root?.dataset.theme || (scheme?.matches ? "light" : "dark");
  function paintTheme() {
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
  return { saveTheme, current: () => root?.dataset.theme || "system" };
}

// Kept as an ordinary function so the exact script served to browsers is testable without a bundler.
function activityBrowser(config, browser, subscriptionUi) {
  "use strict";
  const { base, csrf, defaultGroupOrder } = config;
  const voiceCalls = config.voiceCalls === true;
  const teamId = typeof config.teamId === "string" && /^[A-Z0-9]{2,32}$/.test(config.teamId) ? config.teamId : "";
  const { document, location, EventSource } = browser;
  const el = (id) => document.getElementById(id);
  const body = el("threads"), search = el("search"), tabs = el("filters");
  const pinnedBody = el("pinned-threads");
  const states = { working: "Working", waiting: "Waiting", error: "Error", done: "Done", later: "Later", idle: "Idle" };
  const pending = new Set(), nodes = new Map();
  const orderDialog = el("order-dialog"), orderList = el("order-list"), orderButton = el("group-order");
  const orderNodes = new Map();
  const grouping = el("group-by");
  let groupBy = "status", groupByVersion = -1, savingGrouping = false;
  const allDoneButton = el("mark-all-done"), allDoneDialog = el("all-done-dialog");
  const historyButton = el("load-history");
  let loadingHistory = false, moreHistory = true;
  let completingAll = false;
  let groupOrder = [...defaultGroupOrder], groupOrderVersion = -1, draftOrder = [], savingOrder = false;
  let rows = [], filter = "active", ended = false, loaded = false, stream = null;
  let revision = 0, requestId = 0, lastUpdated = 0, connected = false;
  let unavailable = false, message = "", actionMessage = "";
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
    if (subscriptionRoot) subscriptionRoot.innerHTML = subscriptions.map(subscriptionUi.card).join("");
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
    pending.clear();
    lastUpdated = 0;
    search.value = "";
    search.disabled = true;
    orderButton.disabled = true;
    grouping.disabled = true;
    orderDialog.close();
    allDoneDialog.close();
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
      .map((row) => ({ ...row, status: Object.hasOwn(states, row.status) ? row.status : "idle" }));
    acceptOrder(data);
    acceptGrouping(data);
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
    const channelCell = node("td", "channel-cell"), channel = node("a", "channel-link");
    channelCell.append(channel);
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
    // A voice call bound to this thread (web/call-page.js), only while the gateway offers calls.
    const call = node("a", "call-link", "Call the agent");
    if (voiceCalls) links.append(call);
    state.append(toggle, delay, pin);
    actions.append(links, state);
    tr.append(titleCell, channelCell, statusCell, timeCell, actions);
    return { tr, title, channel, pill, statusText, elapsed, time, open, call, toggle, delay, pin, since: 0, stamp: 0 };
  }
  function matches(row) {
    if (!row.pinned) {
      if (filter === "active" && ["done", "later"].includes(row.status)) return false;
      if (filter === "open" && row.status === "done") return false;
      if (filter !== "active" && filter !== "open" && row.status !== filter) return false;
    }
    const query = search.value.trim().toLocaleLowerCase();
    return !query || (String(row.title || "") + " " + String(row.channelName || "")).toLocaleLowerCase().includes(query);
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
    const counts = { active: 0, open: 0, working: 0, waiting: 0, error: 0, idle: 0, later: 0, done: 0 };
    for (const row of rows) { counts[row.status]++; if (row.status !== "done") { counts.open++; if (row.status !== "later") counts.active++; } }
    for (const button of tabs.querySelectorAll("button")) {
      const selected = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(selected));
      button.querySelector("span").textContent = String(counts[button.dataset.filter]);
    }
    el("summary").textContent = counts.active + " active · " + counts.later + " later · " + counts.working + " working · " + counts.waiting + " waiting";
    const rank = (status) => status === "done" ? groupOrder.length + 1 : status === "later" ? groupOrder.length : groupOrder.indexOf(status);
    grouping.disabled = ended || savingGrouping;
    if (!savingGrouping) grouping.value = groupBy;
    body.dataset.groupBy = groupBy;
    pinnedBody.dataset.groupBy = groupBy;
    const channelName = (row) => String(row.channelName || "Conversation");
    const compareChannel = (a, b) => channelName(a).localeCompare(channelName(b)) || a.channelId.localeCompare(b.channelId);
    const groupKey = (row) => groupBy === "channel" ? row.channelId : row.status;
    const filtered = ended ? [] : rows.filter(matches);
    const newest = (a, b) => (Number(b.lastMessageMs) || 0) - (Number(a.lastMessageMs) || 0);
    const compareRows = (a, b) => (groupBy === "channel" ? compareChannel(a, b) : 0) || rank(a.status) - rank(b.status) || newest(a, b);
    const pinned = filtered.filter((row) => row.pinned).sort(groupBy === "channel" ? compareRows : newest);
    const ordinary = filtered.filter((row) => !row.pinned).sort(compareRows);
    const groupPinned = groupBy === "channel" && new Set(pinned.map((row) => row.channelId)).size > 1;
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
      const app = Boolean(url && new URL(url).origin === location.origin);
      entry.title.textContent = title;
      entry.title.title = title;
      link(entry.title, url, app);
      entry.channel.textContent = String(row.channelName || "Conversation");
      channelLink(entry.channel, row.channelId);
      entry.tr.className = "row s-" + row.status;
      // Label each group on its first conversation, preserving row controls and focus.
      const localIndex = row.pinned ? index : index - pinned.length;
      const sectionRows = row.pinned ? pinned : ordinary, sizes = row.pinned ? pinnedGroupSize : groupSize;
      if ((!row.pinned || groupPinned) && (localIndex === 0 || groupKey(sectionRows[localIndex - 1]) !== groupKey(row))) entry.tr.dataset.group = (groupBy === "channel" ? channelName(row) : states[row.status]) + " · " + sizes.get(groupKey(row));
      else delete entry.tr.dataset.group;
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
      entry.open.setAttribute("aria-label", "Open in Slack: " + title);
      entry.open.title = app ? "Open in Slack · Ctrl/⌘-click opens it in the browser" : "Open in Slack";
      if (voiceCalls && /^[A-Z0-9_]{1,32}$/.test(String(row.channelId)) && /^\d{1,13}\.\d{1,6}$/.test(String(row.threadTs))) {
        entry.call.href = base + "/call?channel=" + encodeURIComponent(row.channelId) + "&thread=" + encodeURIComponent(row.threadTs);
        entry.call.title = "Call the agent about this conversation";
        entry.call.setAttribute("aria-label", "Call the agent: " + title);
      }
      const busy = pending.has(rowKey);
      entry.delay.hidden = row.status === "done";
      entry.delay.disabled = busy || completingAll || ended;
      entry.delay.textContent = busy ? "Saving…" : row.status === "later" ? "Resume" : "Later";
      entry.delay.dataset.state = busy ? "busy" : row.status === "later" ? "resume" : "later";
      entry.delay.title = row.status === "later" ? "Resume" : "Later";
      entry.delay.setAttribute("aria-label", (row.status === "later" ? "Resume: " : "Delay for later: ") + title);
      entry.toggle.disabled = busy || completingAll || ended;
      entry.toggle.textContent = busy ? "Saving…" : row.status === "done" ? "Reopen" : "Done";
      entry.toggle.dataset.state = busy ? "busy" : row.status === "done" ? "reopen" : "done";
      entry.toggle.title = row.status === "done" ? "Reopen" : "Mark done";
      entry.toggle.setAttribute("aria-label", (row.status === "done" ? "Reopen: " : "Mark done: ") + title);
      entry.pin.disabled = busy || completingAll || ended;
      entry.pin.textContent = row.pinned ? "Unpin" : "Pin";
      entry.pin.dataset.state = row.pinned ? "unpin" : "pin";
      entry.pin.title = row.pinned ? "Unpin conversation" : "Pin conversation";
      entry.pin.setAttribute("aria-label", (row.pinned ? "Unpin: " : "Pin: ") + title);
      entry.pin.setAttribute("aria-pressed", String(Boolean(row.pinned)));
      const target = row.pinned ? pinnedBody : body;
      if (target.children[localIndex] !== entry.tr) target.insertBefore(entry.tr, target.children[localIndex] || null);
    });
    el("pinned-section").hidden = pinned.length === 0;
    el("pinned-count").textContent = String(pinned.length);
    el("table").hidden = ordinary.length === 0;
    el("empty").hidden = shown.length > 0 || ended;
    el("empty-title").textContent = !loaded ? "Loading your activity…" : search.value.trim() ? "No matching conversations" : filter === "later" ? "Nothing saved for later" : filter === "done" ? "No completed conversations" : "You’re all caught up";
    el("empty-copy").textContent = !loaded ? "Your latest conversations will appear here." : search.value.trim() ? "Try a different title or channel name." : filter === "later" ? "Use Delay for later or the agent’s 👎 button to postpone a conversation. Resume it when you’re ready." : filter === "done" ? "Conversations you mark Done will appear here." : "Conversations matching this view will appear as activity arrives.";
    el("result-count").textContent = ended ? "" : shown.length + (shown.length === 1 ? " conversation" : " conversations");
    historyButton.disabled = ended || !loaded || loadingHistory || !moreHistory;
    historyButton.textContent = loadingHistory ? "Loading older threads…" : moreHistory ? "Load older threads" : "History loaded";
    historyButton.setAttribute("aria-busy", String(loadingHistory));
    renderAllDone();
    notice();
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
  async function complete(rowKey, operation = "completion") {
    if (ended || completingAll || pending.has(rowKey)) return;
    const row = rows.find((item) => key(item) === rowKey);
    if (!row) return;
    const field = operation === "pin" ? "pinned" : operation === "later" ? "later" : "done";
    const value = operation === "pin" ? !row.pinned : operation === "later" ? row.status !== "later" : row.status !== "done";
    pending.add(rowKey);
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
      await refresh();
    } catch {
      if (!ended) actionMessage = "That change couldn’t be saved. Please try again.";
    } finally {
      pending.delete(rowKey);
      render();
    }
  }
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
  search.addEventListener("input", render);
  function rowClick(event) {
    const button = event.target.closest("button[data-key]");
    if (button) { void complete(button.dataset.key, button.dataset.operation); return; }
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
  body.addEventListener("click", rowClick);
  pinnedBody.addEventListener("click", rowClick);
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
function settingsBrowser(config, browser, theme) {
  "use strict";
  const { base, csrf } = config;
  const { document, location } = browser;
  const el = (id) => document.getElementById(id);
  const panel = el("settings-panel"), nav = el("settings-nav"), status = el("settings-status");
  const SECTIONS = [["general", "General"], ["connections", "Connections"], ["mcps", "MCP servers"], ["variables", "Variables"], ["skills", "Skills"], ["ssh", "SSH keys"]];
  const wanted = String(location?.hash || "").replace(/^#/, "");
  let section = SECTIONS.some(([id]) => id === wanted) ? wanted : "general";
  let data = null, busy = false, ended = false, notice = "", noticeKind = "", editing = null, skillQuery = "";
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
      notice = String(result.notice || "Saved."); noticeKind = "ok";
      render();
    } catch { settle("That change couldn’t be saved. Please try again."); }
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
      const keys = card("Passkeys", "Sign back in to this dashboard without a new Slack link.");
      const link = node("a", "settings-button", "Manage passkeys"); link.href = base + "/passkeys";
      keys.append(link);
      return [account, appearance, reminders, mentions, keys];
    },
    connections() {
      const c = data.connections, cards = [];
      const composio = card("Composio · your account", "Your own apps (Gmail, Calendar, HubSpot, …) as composio-user. Only your runs use it, in every conversation.");
      if (c.composioMode === "sdk") composio.append(node("p", "settings-copy", "This gateway runs Composio in SDK mode: your session is created automatically. Nothing to configure."));
      else {
        composio.append(row(c.composio.configured ? "Connected" + (c.composio.last4 ? " · ••••" + c.composio.last4 : "") : "Not connected", c.composio.label,
          c.composio.configured ? [button("Remove", confirmThen("Remove your Composio account? Runs in progress stop using it.", { action: "composio.remove" }), "settings-button danger")] : []));
        composio.append(form([field(c.composio.configured ? "Replace token" : "Token", input("token", { type: "password", max: 4096, placeholder: c.composio.configured ? "Leave blank to keep the current token" : "" })),
          field("Label", input("label", { value: c.composio.label, max: 80, placeholder: "e.g. Work account" }), "Optional. Shown here and in Slack Settings.")],
        "Save", (v) => ({ action: "composio.save", token: v.token, label: v.label })));
      }
      cards.push(composio);
      const toolbox = card("Toolbox", "Your personal token for the gateway's Toolbox server" + (c.toolboxServer ? " (" + c.toolboxServer + ")" : "") + ".");
      toolbox.append(row(c.toolbox.configured ? "Configured" + (c.toolbox.last4 ? " · ••••" + c.toolbox.last4 : "") : "Not set", "",
        c.toolbox.configured ? [button("Remove", confirmThen("Remove your Toolbox token?", { action: "toolbox.remove" }), "settings-button danger")] : []));
      toolbox.append(form([field(c.toolbox.configured ? "Replace token" : "Token", input("token", { type: "password", max: 4096 }))], "Save", (v) => ({ action: "toolbox.save", token: v.token })));
      cards.push(toolbox);
      const email = card("Email accounts", "Mailboxes only your runs read and send from. Saving logs in to IMAP and SMTP first; passwords are never shown again.");
      for (const account of c.email) {
        email.append(row(account.name + " · " + account.address, "IMAP " + account.imap.host + ":" + account.imap.port + " · SMTP " + account.smtp.host + ":" + account.smtp.port + (account.sendEnabled ? "" : " · sending off"), [
          button("Edit", () => { editing = { kind: "email", value: account }; render(); }),
          button("Remove", confirmThen("Remove email account " + account.name + "?", { action: "email.remove", name: account.name }), "settings-button danger")]));
      }
      if (!c.email.length) email.append(node("p", "settings-empty", "No email accounts."));
      const current = editing?.kind === "email" ? editing.value : null;
      const v = (key, fallback = "") => current ? String(key.split(".").reduce((o, k) => o?.[k], current) ?? fallback) : fallback;
      email.append(node("h3", "", current ? "Edit " + current.name : "Add an account"));
      email.append(form([
        ...(current ? [] : [field("Name", input("name", { max: 40, placeholder: "work" }), "Lowercase letters, digits and dashes.")]),
        field("Address", input("address", { type: "email", value: v("address"), max: 254 })),
        field("Display name", input("displayName", { value: v("displayName"), max: 120 })),
        field("IMAP host", input("imapHost", { value: v("imap.host"), max: 253 })), field("IMAP port", input("imapPort", { value: v("imap.port", "993"), max: 5 })),
        field("IMAP user", input("imapUser", { value: v("imap.user"), max: 254 })), field("IMAP password", input("imapPassword", { type: "password", max: 1024, placeholder: current ? "Leave blank to keep" : "" })),
        field("SMTP host", input("smtpHost", { value: v("smtp.host"), max: 253 })), field("SMTP port", input("smtpPort", { value: v("smtp.port", "587"), max: 5 })),
        field("SMTP user", input("smtpUser", { value: v("smtp.user"), max: 254 }), "Blank uses the IMAP user."), field("SMTP password", input("smtpPassword", { type: "password", max: 1024, placeholder: current ? "Leave blank to keep" : "Blank uses the IMAP password" })),
      ], current ? "Save changes" : "Connect", (values) => ({ action: "email.save", ...values, ...(current ? { name: current.name } : {}) }),
      current ? { cancel: () => { editing = null; render(); } } : {}));
      cards.push(email);
      return cards;
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
      const s = data.skills;
      const pick = card("Your skills", "Skills added here load into every run you start, in any conversation. Channel and organization skills are managed by their owners.");
      if (s.foreign?.length) pick.append(node("p", "settings-warning", "Not loaded: " + s.foreign.join(", ") + " — another person's personal skill. Saving here removes it."));
      const search = input("skill-search", { type: "search", value: skillQuery, max: 120, placeholder: "Filter skills…" });
      search.disabled = ended;
      const list = node("div", "settings-skill-list");
      const selected = new Set(s.selected.map((slug) => slug.toLowerCase()));
      const boxes = [];
      function paintSkills() {
        const query = skillQuery.trim().toLowerCase();
        for (const entry of boxes) entry.item.hidden = Boolean(query) && !(entry.option.label + " " + entry.option.description).toLowerCase().includes(query);
      }
      for (const option of s.options) {
        const item = node("label", "settings-skill"), box = node("input");
        box.type = "checkbox"; box.value = option.key; box.checked = selected.has(option.key.toLowerCase()); box.disabled = busy || ended;
        const text = node("span", "settings-skill-text");
        text.append(node("span", "settings-row-title", option.label), node("span", "settings-row-meta", option.description));
        item.append(box, text); list.append(item); boxes.push({ item, box, option });
      }
      search.addEventListener("input", () => { skillQuery = search.value; paintSkills(); });
      paintSkills();
      if (!s.options.length) list.append(node("p", "settings-empty", "No skills are available to you yet."));
      const error = node("p", "settings-error"); error.setAttribute("role", "alert");
      pick.append(search, list, error, button("Save skills", () => { void send({ action: "skills.save", selected: boxes.filter((entry) => entry.box.checked).map((entry) => entry.option.key) }, error); }, "settings-button primary"));
      return [pick];
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
    nav.replaceChildren(...SECTIONS.map(([id, label]) => {
      const item = node("button", "settings-tab", label);
      item.type = "button";
      if (id === section) item.setAttribute("aria-current", "page");
      item.addEventListener("click", () => { section = id; editing = null; notice = ""; noticeKind = ""; if (browser.history?.replaceState) browser.history.replaceState(null, "", "#" + id); render(); });
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
  call: icon("<path d='M6.6 2.6c.5-.5 1.3-.5 1.8 0l2.3 2.3c.5.5.5 1.3 0 1.8L9.4 8.1c-.3.3-.4.8-.1 1.2a13 13 0 0 0 5.4 5.4c.4.2.9.2 1.2-.1l1.4-1.3c.5-.5 1.3-.5 1.8 0l2.3 2.3c.5.5.5 1.3 0 1.8l-1.5 1.5c-1 1-2.5 1.4-3.9.9A20 20 0 0 1 4.2 8c-.5-1.4-.1-2.9.9-3.9l1.5-1.5Z'/>"),
  pin: icon("<path d='m15 2 7 7-2 2-2-1-4 4v3l-1 1-3-3-5 5-1-1 5-5-3-3 1-1h3l4-4-1-2 2-2Z'/>"),
  slack: icon("<path d='M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0v-6.31ZM8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.31Zm10.13 2.52a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.31Zm-2.52 10.13a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 1 1 0 5.05h-6.31Z'/>"),
  done: icon("<path d='M20.3 5.3a1 1 0 0 1 0 1.4l-10.5 10.5a1 1 0 0 1-1.4 0L3.7 12.5a1 1 0 1 1 1.4-1.4l4 4 9.8-9.8a1 1 0 0 1 1.4 0Z'/>"),
  reopen: icon("<path d='M12 4a8 8 0 1 1-7.4 5h2.2A6 6 0 1 0 12 6v3L7.5 5 12 1v3Z'/>"),
  later: icon("<path d='M7 4h3.5v16H7zM13.5 4H17v16h-3.5z'/>"),
  resume: icon("<path d='M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z'/>"),
  busy: icon("<circle cx='5' cy='12' r='2'/><circle cx='12' cy='12' r='2'/><circle cx='19' cy='12' r='2'/>"),
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
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function activityPage({ sessionId, csrf, view = "activity", agent = "", theme = "system", teamId = "", voiceCalls = false, logoColor = getLogoColor() }) {
  const subscriptionsView = view === "subscriptions", settingsView = view === "settings";
  const base = `/activity/${encodeURIComponent(sessionId)}`;
  const nonce = crypto.randomBytes(16).toString("base64url");
  const config = JSON.stringify({ base, csrf, view, teamId: /^[A-Z0-9]{2,32}$/.test(String(teamId)) ? String(teamId) : "", defaultGroupOrder: DEFAULT_ACTIVITY_GROUP_ORDER, voiceCalls: voiceCalls === true }).replaceAll("<", "\\u003c");
  const agentName = String(agent || "").trim() || "ChannelGate";
  const pinned = theme === "dark" || theme === "light" ? ` data-theme="${theme}"` : "";
  const filters = [["active", "Active"], ["working", "Working"], ["waiting", "Waiting"], ["error", "Error"], ["idle", "Idle"], ["later", "Later"], ["done", "Completed"], ["open", "All open"]];
  return { nonce, html: `<!doctype html>
<html lang="en"${pinned}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${subscriptionsView ? "Subscriptions" : settingsView ? "Settings" : "Activity"} · ChannelGate</title>${activityAppHead(logoColor)}
<style nonce="${nonce}">
${ACTIVITY_THEME_CSS}
${SUBSCRIPTION_CSS}
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
.top .subscription-quick-name{font-size:11.5px}
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
.icon-button,.open-link,.call-link,.toggle{position:relative}
.icon-button::before,.open-link::before,.call-link::before,.toggle::before{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}
#theme-toggle{--icon:${ICONS.moon}}#theme-toggle[data-theme=light]{--icon:${ICONS.sun}}
.icon-button:hover{color:var(--ink);border-color:var(--muted)}
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
thead tr,tbody tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,190px) 124px 44px 136px;align-items:center;column-gap:12px;padding:0 16px}
.pinned-section{margin:0 0 24px}
.pinned-heading{display:flex;align-items:center;gap:10px;margin:0;padding:12px 16px;font:600 13px var(--font);color:var(--ink)}
.pinned-heading span{font:500 11px var(--mono);color:var(--muted)}
thead tr{height:30px;border-bottom:1px solid var(--line)}
th{padding:0;font:500 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left}
th:last-child{text-align:right}
td{display:block;padding:0;border:0;min-width:0}
tbody tr{min-height:40px;border-bottom:1px solid var(--line-soft);background-image:linear-gradient(90deg,var(--c) 0 3px,transparent 3px)}
tbody tr:nth-child(even){background-color:var(--band)}
tbody tr:hover,tbody tr:focus-within{background-color:var(--hover)}
tbody tr[data-group]::before{content:attr(data-group);overflow-wrap:anywhere;min-width:0;grid-column:1/-1;display:flex;align-items:center;min-height:30px;margin:0 -16px 0;padding:6px 16px;background:var(--panel);border-bottom:1px solid var(--line-soft);font:600 10.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2)}
tbody[data-group-by=status] tr.s-waiting[data-group]::before,tbody[data-group-by=status] tr.s-error[data-group]::before{color:var(--c)}
.thread-cell{padding:10px 0;min-width:0}
.thread-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;color:var(--ink);font-weight:500;line-height:1.4;overflow:hidden;overflow-wrap:anywhere}
.s-done .thread-title{color:var(--ink-2)}
.thread-title:hover{color:var(--ink);text-decoration:underline}
.channel-cell{font:11.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.channel-link{color:inherit}
.channel-link[href]:hover{color:var(--ink);text-decoration:underline}
.status-cell{min-width:0}
.pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap;color:var(--c);background:color-mix(in srgb,var(--c) var(--tint),transparent);border:1px solid color-mix(in srgb,var(--c) 28%,transparent)}
.status-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.working .status-dot{animation:pulse 1.6s infinite}
.elapsed{font:10px var(--mono);opacity:.9}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c) 60%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
.time-cell{font:11.5px var(--mono);color:var(--ink-2);text-align:left;white-space:nowrap}
.actions{display:flex;justify-content:flex-end;gap:4px;opacity:0;transition:opacity .12s}
tbody tr:hover .actions,tbody tr:focus-within .actions,.s-waiting .actions,.s-error .actions{opacity:1}
.action-links,.action-state{display:flex;gap:4px;margin:0}
.open-link,.call-link,.toggle{display:inline-grid;place-items:center;width:28px;height:28px;min-height:0;padding:0;border:1px solid var(--line-2);border-radius:7px;background:var(--panel);color:var(--ink-2);font-size:0;line-height:0;overflow:hidden;text-indent:-9999px}
.open-link:hover,.call-link:hover,.toggle:hover{border-color:var(--muted);background:var(--panel-2);color:var(--ink)}
.open-link{--icon:${ICONS.slack}}
.call-link{--icon:${ICONS.call}}
.toggle[data-state=done]{--icon:${ICONS.done};color:var(--s-done)}
.toggle[data-state=reopen]{--icon:${ICONS.reopen}}
.toggle[data-state=later]{--icon:${ICONS.later};color:var(--s-later)}
.toggle[data-state=resume]{--icon:${ICONS.resume};color:var(--s-later)}
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
.subscriptions-page{padding:8px 16px 24px}
.settings-page{max-width:1080px;margin:0 auto;padding:18px 16px 32px}
.settings-head h1{font-size:20px;margin:0 0 4px}
.settings-copy{color:var(--muted);font-size:12.5px;margin:0 0 12px;line-height:1.55}
.settings-status{margin:0 0 12px;padding:9px 12px;border-radius:8px;font-size:12.5px;border:1px solid color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.settings-status.error{border-color:color-mix(in srgb,var(--danger) 45%,transparent);background:color-mix(in srgb,var(--danger) 12%,transparent)}
.settings-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:20px;align-items:start}
.settings-nav{display:flex;flex-direction:column;gap:2px;position:sticky;top:64px}
.settings-tab{text-align:left;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:13px}
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
.settings-error{grid-column:1/-1;margin:0;color:var(--danger);font-size:12px;min-height:0}.settings-error:empty{display:none}
.settings-warning{color:var(--warn);font-size:12px}
.settings-empty{color:var(--faint);font-size:12.5px;margin:8px 0 0}
.settings-button{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border:1px solid var(--line-2);border-radius:7px;background:var(--panel-2);color:var(--ink);font-size:12px;white-space:nowrap}
.settings-button:hover:not(:disabled){border-color:var(--muted)}
.settings-button:disabled{opacity:.5;cursor:default}
.settings-button.primary{background:var(--orange);border-color:var(--orange);color:var(--brand-ink)}
.settings-button.danger{color:var(--danger)}.settings-button.ghost{background:transparent}
.settings-skill-list{display:flex;flex-direction:column;max-height:420px;overflow:auto;margin:10px 0;border:1px solid var(--line);border-radius:8px}
.settings-skill{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-bottom:1px solid var(--line-soft)}
.settings-skill[hidden]{display:none}.settings-skill-text{display:flex;flex-direction:column;min-width:0}
.subscription-card{background:var(--panel)}
@media(prefers-reduced-motion:reduce){.pill.working .status-dot{animation:none}.actions{transition:none}}
@media(hover:none){.actions{opacity:1}}
@media(max-width:980px){
  thead tr,tbody tr{grid-template-columns:minmax(0,1fr) 124px 44px 136px}
  .channel-cell,th:nth-child(2){display:none}
}
@media(max-width:640px){
  .settings-layout{grid-template-columns:1fr}
  .settings-nav{position:static;flex-direction:row;overflow-x:auto}
  .settings-row{flex-wrap:wrap}
  .top{padding:8px 12px;gap:8px 10px}
  .agent-name{max-width:150px}
  .top .subscription-quick-list{order:1;gap:10px}
  #theme-toggle{order:2}
  .top .subscription-quick progress,.top .subscription-quick-name{display:none}
  .subscription-ring{display:block}
  .page-nav{order:3;margin-left:auto}
  .bar{flex-wrap:wrap;padding:6px 8px;gap:6px}
  .search-wrap{flex:1 1 100%;margin:0;order:-1}
  thead{display:none}
  tbody tr{grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:10px;row-gap:5px;padding:9px 12px}
  tbody tr[data-group]::before{margin:-9px -12px 4px;padding:0 12px}
  .thread-cell{grid-column:1/3;grid-row:2;padding:0}
  tbody tr[data-group] .thread-cell{grid-row:2}
  .time-cell{grid-column:3;grid-row:2;text-align:right}
  .status-cell{grid-column:1;grid-row:3}
  .channel-cell{display:block;grid-column:2;grid-row:3}
  .actions{grid-column:3;grid-row:3}
  tbody tr:not([data-group]) .thread-cell{grid-row:1}tbody tr:not([data-group]) .time-cell{grid-row:1}
  tbody tr:not([data-group]) .status-cell,tbody tr:not([data-group]) .channel-cell,tbody tr:not([data-group]) .actions{grid-row:2}
  .pill{height:20px;font-size:11px;padding:0 8px}
  .open-link,.call-link,.toggle{width:32px;height:32px}
}
</style></head><body>
<header class="top"><div class="agent"><span class="agent-mark" aria-hidden="true">${channelGateLogo(logoColor)}</span><div><span class="agent-name">${escapeHtml(agentName)}</span>${settingsView ? "" : '<div id="connection" class="connection reconnecting" role="status"><span id="connection-text">Connecting…</span></div>'}</div></div>
${subscriptionsView || settingsView ? "" : '<div id="subscription-quick" class="subscription-quick-list" aria-label="Subscription usage" hidden></div><div id="subscriptions-notice" role="status" aria-live="polite"></div>'}
<nav class="page-nav" aria-label="Dashboard"><a href="${base}"${view === "activity" ? ' aria-current="page"' : ''}>Activity</a><a href="${base}/subscriptions"${subscriptionsView ? ' aria-current="page"' : ''}>Subscriptions</a><a href="${base}/settings"${settingsView ? ' aria-current="page"' : ''}>Settings</a></nav>
<a href="${base}/passkeys" class="link-button">Passkeys</a>
<button id="theme-toggle" class="icon-button" type="button" aria-label="Switch theme" title="Switch theme"></button></header>
<main>
${subscriptionsView ? `<section class="subscriptions-page" aria-label="Subscriptions"><div class="subscriptions-head"><h1>Subscriptions</h1><button id="subscriptions-refresh" class="order-button" type="button">Refresh</button></div><p class="subscriptions-copy">Account-wide usage · refreshes every 10 minutes.</p><div id="subscriptions-notice" role="status" aria-live="polite"></div><div id="subscriptions-cards" class="subscription-grid"></div></section>` : ""}
${settingsView ? `<section class="settings-page" aria-label="Settings"><div class="settings-head"><h1>Settings</h1><p class="settings-copy">Your own preferences and connections. They follow you into every conversation; nobody else's runs use them.</p></div><div id="settings-status" class="settings-status" role="status" aria-live="polite" hidden></div><div class="settings-layout"><nav id="settings-nav" class="settings-nav" aria-label="Settings sections"></nav><div id="settings-panel" class="settings-panel"></div></div><noscript><p class="js-needed">Enable JavaScript to manage your settings.</p></noscript></section>` : `<div id="activity-view"${subscriptionsView ? " hidden" : ""}>
<dialog id="order-dialog" class="order-dialog" aria-labelledby="order-title" aria-describedby="order-description"><h2 id="order-title">Arrange status groups</h2><p id="order-description">Move groups up or down. Newest conversations appear first within each group. Your order is saved to your account.</p><ol id="order-list" class="order-list"></ol><button id="order-reset" type="button">Reset to default</button><p id="order-error" class="order-error" role="alert"></p><div class="order-footer"><button id="order-cancel" type="button">Cancel</button><button id="order-save" class="order-save" type="button">Save order</button></div></dialog>
<dialog id="all-done-dialog" class="order-dialog" aria-labelledby="all-done-title" aria-describedby="all-done-description"><h2 id="all-done-title">Mark all your threads done?</h2><p id="all-done-description">This marks all your open tracked agent threads done across all channels, including threads outside the current filter, search, or page. Their main Slack messages get ✅. Running work continues.</p><p id="all-done-error" class="order-error" role="alert"></p><div class="order-footer"><button id="all-done-cancel" type="button" autofocus>Cancel</button><button id="all-done-confirm" class="order-save" type="button">Mark All Done</button></div></dialog>
<section aria-label="Conversations"><div class="bar"><div id="filters" class="filters" role="group" aria-label="Filter by status">${filters.map(([value, label]) => `<button type="button" class="s-${value}" data-filter="${value}" aria-pressed="${value === "active"}">${["working", "waiting", "error", "idle", "later", "done"].includes(value) ? '<i aria-hidden="true"></i>' : ""}${label}<span>0</span></button>`).join("")}</div>
<div class="grouping"><label for="group-by">Group by</label><select id="group-by"><option value="status">Status</option><option value="channel">Channel</option></select></div>
<div class="search-wrap"><label class="search-label" for="search">Search conversations or channels</label><input type="search" id="search" placeholder="Filter threads…" autocomplete="off" maxlength="300"></div></div>
<div id="notice" class="notice" role="alert" hidden></div>
<section id="pinned-section" class="pinned-section" aria-labelledby="pinned-title" hidden><h2 id="pinned-title" class="pinned-heading">Pinned conversations <span id="pinned-count">0</span></h2>
<table aria-label="Pinned conversations"><thead><tr><th scope="col">Conversation</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead><tbody id="pinned-threads"></tbody></table></section>
<table id="table" hidden><thead><tr><th scope="col">Conversation</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead><tbody id="threads"></tbody></table>
<div id="empty" class="empty" role="status"><div class="empty-symbol" aria-hidden="true">◎</div><h2 id="empty-title">Loading your activity…</h2><p id="empty-copy">Your latest conversations will appear here.</p></div>
<noscript><p class="js-needed">Enable JavaScript to view live activity.</p></noscript></section>
<footer class="footer"><div class="footer-actions"><span id="summary" class="summary">Loading activity…</span><button id="group-order" class="link-button" type="button" aria-haspopup="dialog">⇅ Group order</button><button id="mark-all-done" class="link-button" type="button" aria-haspopup="dialog" disabled>✓ Mark All Done</button><button id="load-history" class="link-button" type="button" disabled>Load older threads</button></div><div class="footer-actions"><span id="result-count"></span><span id="updated">Waiting for updates</span></div></footer>
<p class="privacy">Your conversations are private. <a href="${base}/passkeys">Manage passkeys</a> or <a href="/activity/login">sign in again</a> when your session expires.</p>
</div>`}
</main><script nonce="${nonce}">${settingsView
    ? `(${settingsBrowser.toString()})(${config}, globalThis, (${themeBrowser.toString()})(${config}, globalThis));`
    : `(${themeBrowser.toString()})(${config}, globalThis);(${activityBrowser.toString()})(${config}, globalThis, (${createSubscriptionUi.toString()})());`}</script></body></html>` };
}
