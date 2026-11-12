// Cookie-authenticated browser dashboard with self-hosted brand assets and no browser storage.
import crypto from "node:crypto";
import { ACTIVITY_THEME_CSS, ACTIVITY_BRAND } from "./activity-theme.js";
import { DEFAULT_ACTIVITY_GROUP_ORDER } from "./activity-order.js";

// Kept as an ordinary function so the exact script served to browsers is testable without a bundler.
function activityBrowser(config, browser) {
  "use strict";
  const { base, csrf, defaultGroupOrder } = config;
  const { document, location, EventSource } = browser;
  const el = (id) => document.getElementById(id);
  const body = el("threads"), search = el("search"), tabs = el("filters");
  const states = { working: "Working", waiting: "Waiting", error: "Error", done: "Done", idle: "Idle" };
  const pending = new Set(), nodes = new Map();
  const orderDialog = el("order-dialog"), orderList = el("order-list"), orderButton = el("group-order");
  const orderNodes = new Map();
  const allDoneButton = el("mark-all-done"), allDoneDialog = el("all-done-dialog");
  let completingAll = false;
  let groupOrder = [...defaultGroupOrder], groupOrderVersion = -1, draftOrder = [], savingOrder = false;
  let rows = [], filter = "active", ended = false, loaded = false, stream = null;
  let revision = 0, requestId = 0, lastUpdated = 0, connected = false;
  let unavailable = false, message = "", actionMessage = "";
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

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
  function link(anchor, url) {
    if (url) {
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.removeAttribute("aria-disabled");
    } else {
      anchor.removeAttribute("href");
      anchor.setAttribute("aria-disabled", "true");
    }
  }
  function connection() {
    const stale = lastUpdated && Date.now() - lastUpdated > 90_000;
    el("connection").className = "connection " + (ended ? "offline" : connected && !stale ? "live" : "reconnecting");
    el("connection-text").textContent = ended ? "Session ended" : stale ? "Updates delayed" : connected ? "Live updates" : "Reconnecting…";
    el("updated").textContent = lastUpdated ? "Updated " + timeFormat.format(lastUpdated) : "Waiting for updates";
  }
  function notice() {
    const text = ended ? "Your access has ended or this session has expired. Open My Activity again from Slack." :
      actionMessage || message || (unavailable ? "Some activity is temporarily unavailable. We’ll keep trying to refresh it." : "");
    el("notice").textContent = text;
    el("notice").hidden = !text;
  }
  function endAccess() {
    ended = true;
    connected = false;
    stream?.close();
    rows = [];
    pending.clear();
    lastUpdated = 0;
    search.value = "";
    search.disabled = true;
    orderButton.disabled = true;
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
    const channel = node("td", "channel-cell");
    const statusCell = node("td", "status-cell"), pill = node("span", "pill");
    const dot = node("span", "status-dot"), statusText = node("span");
    dot.setAttribute("aria-hidden", "true");
    pill.append(dot, statusText);
    statusCell.append(pill);
    const timeCell = node("td", "time-cell"), time = node("time");
    timeCell.append(time);
    const actions = node("td", "actions"), open = node("a", "open-link", "Open thread ↗"), toggle = node("button", "toggle");
    toggle.type = "button";
    toggle.dataset.key = rowKey;
    actions.append(open, toggle);
    tr.append(titleCell, channel, statusCell, timeCell, actions);
    return { tr, title, channel, pill, statusText, time, open, toggle };
  }
  function matches(row) {
    if ((filter === "active" || filter === "open") && row.status === "done") return false;
    if (filter !== "active" && filter !== "open" && row.status !== filter) return false;
    const query = search.value.trim().toLocaleLowerCase();
    return !query || (String(row.title || "") + " " + String(row.channelName || "")).toLocaleLowerCase().includes(query);
  }
  function render() {
    const counts = { active: 0, open: 0, working: 0, waiting: 0, error: 0, idle: 0, done: 0 };
    for (const row of rows) { counts[row.status]++; if (row.status !== "done") { counts.active++; counts.open++; } }
    for (const button of tabs.querySelectorAll("button")) {
      const selected = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(selected));
      button.querySelector("span").textContent = String(counts[button.dataset.filter]);
    }
    el("summary").textContent = counts.active + " open · " + counts.working + " working · " + counts.waiting + " waiting";
    const rank = (status) => status === "done" ? groupOrder.length : groupOrder.indexOf(status);
    const shown = ended ? [] : rows.filter(matches).sort((a, b) => rank(a.status) - rank(b.status)
      || (Number(b.lastMessageMs) || 0) - (Number(a.lastMessageMs) || 0));
    const visible = new Set(shown.map(key));
    for (const [rowKey, entry] of nodes) {
      if (!visible.has(rowKey)) { entry.tr.remove(); nodes.delete(rowKey); }
    }
    shown.forEach((row, index) => {
      const rowKey = key(row);
      let entry = nodes.get(rowKey);
      if (!entry) { entry = makeRow(rowKey); nodes.set(rowKey, entry); }
      const title = String(row.title || "Untitled conversation"), url = safeUrl(row.url);
      entry.title.textContent = title;
      entry.title.title = title;
      link(entry.title, url);
      entry.channel.textContent = String(row.channelName || "Conversation");
      entry.pill.className = "pill " + row.status;
      entry.statusText.textContent = states[row.status];
      const stamp = Number(row.lastMessageMs), date = new Date(stamp);
      const validDate = stamp > 0 && Number.isFinite(date.getTime());
      entry.time.textContent = validDate ? dateFormat.format(date) : "—";
      if (validDate) {
        entry.time.dateTime = date.toISOString();
        entry.time.title = date.toLocaleString();
      } else {
        entry.time.removeAttribute("datetime");
        entry.time.removeAttribute("title");
      }
      link(entry.open, url);
      const busy = pending.has(rowKey);
      entry.toggle.disabled = busy || completingAll || ended;
      entry.toggle.textContent = busy ? "Saving…" : row.status === "done" ? "Reopen" : "Done";
      entry.toggle.setAttribute("aria-label", (row.status === "done" ? "Reopen: " : "Mark done: ") + title);
      if (body.children[index] !== entry.tr) body.insertBefore(entry.tr, body.children[index] || null);
    });
    el("table").hidden = shown.length === 0;
    el("empty").hidden = shown.length > 0 || ended;
    el("empty-title").textContent = !loaded ? "Loading your activity…" : search.value.trim() ? "No matching conversations" : filter === "done" ? "No completed conversations" : "You’re all caught up";
    el("empty-copy").textContent = !loaded ? "Your latest conversations will appear here." : search.value.trim() ? "Try a different title or channel name." : filter === "done" ? "Conversations you mark Done will appear here." : "Conversations matching this view will appear as activity arrives.";
    el("result-count").textContent = ended ? "" : shown.length + (shown.length === 1 ? " conversation" : " conversations");
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
  async function complete(rowKey) {
    if (ended || completingAll || pending.has(rowKey)) return;
    const row = rows.find((item) => key(item) === rowKey);
    if (!row) return;
    const done = row.status !== "done";
    pending.add(rowKey);
    actionMessage = "";
    render();
    try {
      const response = await fetch(base + "/api/completion", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CG-CSRF": csrf },
        body: JSON.stringify({ channelId: row.channelId, threadTs: row.threadTs, done }),
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
  search.addEventListener("input", render);
  body.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-key]");
    if (button) void complete(button.dataset.key);
  });
  render();
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
  browser.addEventListener("pagehide", () => { stream.close(); clearInterval(timer); });
  browser.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
}

export function activityPage({ sessionId, csrf }) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const config = JSON.stringify({ base: `/activity/${encodeURIComponent(sessionId)}`, csrf, defaultGroupOrder: DEFAULT_ACTIVITY_GROUP_ORDER }).replaceAll("<", "\\u003c");
  return { nonce, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>My Activity · ChannelGate</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style nonce="${nonce}">
${ACTIVITY_THEME_CSS}
.shell{max-width:1440px;margin:0 auto;padding:36px 32px 20px}
.heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:30px 0 22px}
.heading-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap}
.order-button,.order-dialog button{border:1px solid var(--line);border-radius:7px;padding:9px 12px;color:var(--ink);background:var(--panel-2);font-size:12px}
.order-button:hover,.order-dialog button:hover{border-color:var(--muted)}
.order-dialog{width:min(420px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:12px}
.order-dialog::backdrop{background:rgba(0,0,0,.65)}
.order-dialog h2{font-size:18px;margin:0 0 10px}.order-dialog p{font-size:13px;color:var(--muted);line-height:1.6}
.order-list{padding:0;list-style:none;margin:20px 0}.order-list li{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-soft)}
.order-moves{display:flex;gap:6px}.order-dialog .order-move{min-width:44px;min-height:44px;font-size:18px;padding:6px}
.order-dialog button:disabled{opacity:.4;cursor:default}.order-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.order-dialog .order-save{background:var(--orange);color:var(--panel-dark)}
.order-dialog .order-error{color:#ffb3a9;min-height:1.6em}
.subtitle{margin:14px 0 0;color:var(--muted)}
.connection{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:12px;color:var(--muted)}
.connection::before{content:"";width:7px;height:7px;background:var(--warn);border-radius:50%}
.connection.live::before{background:var(--ok);box-shadow:0 0 0 4px rgba(78,199,122,.1)}
.connection.offline::before{background:var(--faint)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:28px 0 16px}
.summary{color:var(--muted);font-size:13px}
.search-wrap{position:relative;min-width:280px;width:34%}
.search-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
input{width:100%;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--ink)}
input::placeholder{color:var(--faint)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.filters{display:flex;gap:5px;padding:13px 16px;border-bottom:1px solid var(--line);overflow-x:auto}
.filters button{flex-shrink:0;border:1px solid transparent;border-radius:7px;padding:8px 10px;background:transparent;color:var(--muted);font-size:12px;white-space:nowrap}
.filters button:hover{color:var(--ink);background:var(--panel-2)}
.filters button[aria-pressed=true]{color:var(--ink);background:var(--panel-2);border-color:var(--line);box-shadow:inset 0 -2px 0 var(--orange)}
.filters span{margin-left:6px;font-size:11px;opacity:.8;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;table-layout:fixed}
thead{background:var(--panel-dark);text-align:left;color:var(--muted);font-size:10px;letter-spacing:.06em;text-transform:uppercase}
th{padding:13px 18px;font-weight:600}
th:first-child{width:35%}th:nth-child(2){width:17%}th:nth-child(3){width:12%}th:nth-child(4){width:16%}th:last-child{width:20%}
td{padding:18px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--panel-2)}
.thread-title{color:var(--ink);font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.5}
.channel-cell{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.time-cell{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 9px;border-radius:100px;font-size:10px;font-weight:600;white-space:nowrap;background:rgba(145,201,206,.1);color:var(--muted)}
.status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.working{color:#b5e3e7;background:rgba(49,123,128,.3)}
.working .status-dot{width:10px;height:10px;border:1.5px solid currentColor;border-right-color:transparent;background:none;animation:spin .85s linear infinite}
.pill.waiting{background:rgba(232,176,75,.15);color:#f1ca83}
.pill.error{background:rgba(229,96,77,.15);color:#ffb3a9}
.pill.done{background:rgba(78,199,122,.15);color:#9ce2b6}
.actions{white-space:nowrap;text-align:right}
.open-link{font-size:12px;margin-right:14px}
.toggle{border:1px solid var(--line);background:var(--panel-2);color:var(--ink);font-size:12px;border-radius:7px;padding:6px 12px;min-width:66px}
.toggle:hover{background:var(--teal);border-color:var(--muted)}
.empty{text-align:center;padding:64px 24px}
.empty-symbol{font-size:26px;color:var(--muted);margin-bottom:12px}
.empty h2{font-size:16px;margin:0 0 7px}.empty p{color:var(--muted);margin:0;font-size:13px}
.notice{padding:13px 16px;margin-bottom:18px;border:1px solid rgba(232,176,75,.35);background:rgba(232,176,75,.1);color:#f1ca83;border-radius:8px;font-size:13px}
.footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;color:var(--muted);font-size:11px}
.privacy{color:var(--faint);font-size:11px;margin-top:24px}.js-needed{padding:24px;color:#f1ca83}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.working .status-dot{animation:none}}
@media(max-width:1100px){.shell{padding:28px 20px}th,td{padding:15px 12px}.open-link{display:block;margin:0 0 6px}.actions{text-align:center}}
@media(max-width:700px){
  .shell{padding:22px 16px}.heading{align-items:flex-start;flex-direction:column;gap:18px;margin:26px 0 20px}h1{font-size:27px}
  .toolbar{align-items:stretch;flex-direction:column-reverse;gap:12px;margin:20px 0 13px}.search-wrap{width:100%;min-width:0}
  .filters{padding:12px;gap:3px}table,tbody{display:block}thead{display:none}
  tbody tr{display:grid;grid-template-columns:1fr auto;gap:9px 12px;padding:18px 16px;border-bottom:1px solid var(--line)}
  tbody tr:last-child{border-bottom:0}td{display:block;padding:0;border:0}
  .thread-cell{grid-column:1/-1;grid-row:1}.thread-title{-webkit-line-clamp:3;font-size:14px}
  .channel-cell{grid-column:1;grid-row:2}.status-cell{grid-column:2;grid-row:2/4;align-self:center}.time-cell{grid-column:1;grid-row:3;font-size:11px}
  .actions{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;margin-top:5px}
  .open-link{display:inline;margin:0;padding:7px 0}.toggle{padding:8px 16px}.empty{padding:45px 18px}.footer{font-size:10px}.subtitle{font-size:13px}
}
</style></head><body><main class="shell">
${ACTIVITY_BRAND}
<header class="heading"><div><h1>My Activity</h1><p class="subtitle">Your conversations, with the latest status in one place.</p></div><div class="heading-actions"><div id="connection" class="connection reconnecting" role="status"><span id="connection-text">Connecting…</span></div><button id="mark-all-done" class="order-button" type="button" aria-haspopup="dialog" disabled>Mark All Done</button><button id="group-order" class="order-button" type="button" aria-haspopup="dialog">⇅ Group order</button></div></header>
<dialog id="order-dialog" class="order-dialog" aria-labelledby="order-title" aria-describedby="order-description"><h2 id="order-title">Arrange status groups</h2><p id="order-description">Move groups up or down. Newest conversations appear first within each group. Your order is saved to your account.</p><ol id="order-list" class="order-list"></ol><button id="order-reset" type="button">Reset to default</button><p id="order-error" class="order-error" role="alert"></p><div class="order-footer"><button id="order-cancel" type="button">Cancel</button><button id="order-save" class="order-save" type="button">Save order</button></div></dialog>
<dialog id="all-done-dialog" class="order-dialog" aria-labelledby="all-done-title" aria-describedby="all-done-description"><h2 id="all-done-title">Mark all your threads done?</h2><p id="all-done-description">This marks all your open tracked agent threads done across all channels, including threads outside the current filter, search, or page. Their main Slack messages get ✅. Running work continues.</p><p id="all-done-error" class="order-error" role="alert"></p><div class="order-footer"><button id="all-done-cancel" type="button" autofocus>Cancel</button><button id="all-done-confirm" class="order-save" type="button">Mark All Done</button></div></dialog>
<div id="notice" class="notice" role="alert" hidden></div>
<div class="toolbar"><div id="summary" class="summary">Loading activity…</div><div class="search-wrap"><label class="search-label" for="search">Search conversations or channels</label><input type="search" id="search" placeholder="Search conversations or channels…" autocomplete="off" maxlength="300"></div></div>
<section class="panel" aria-label="Conversations"><div id="filters" class="filters" role="group" aria-label="Filter by status">${[["active", "Active"], ["working", "Working"], ["waiting", "Waiting"], ["error", "Error"], ["idle", "Idle"], ["done", "Completed"], ["open", "All open"]].map(([value, label]) => `<button type="button" data-filter="${value}" aria-pressed="${value === "active"}">${label}<span>0</span></button>`).join("")}</div>
<table id="table" hidden><thead><tr><th scope="col">Conversation</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col">Last message</th><th scope="col">Actions</th></tr></thead><tbody id="threads"></tbody></table>
<div id="empty" class="empty" role="status"><div class="empty-symbol" aria-hidden="true">◎</div><h2 id="empty-title">Loading your activity…</h2><p id="empty-copy">Your latest conversations will appear here.</p></div>
<noscript><p class="js-needed">Enable JavaScript to view live activity.</p></noscript></section>
<footer class="footer"><span id="result-count"></span><span id="updated">Waiting for updates</span></footer>
<p class="privacy">This view is personal to you. If your session expires, open My Activity again from Slack.</p>
</main><script nonce="${nonce}">(${activityBrowser.toString()})(${config}, globalThis);</script></body></html>` };
}
