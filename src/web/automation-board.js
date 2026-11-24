// The Automations health board: ONE browser component mounted by both the admin console
// (served as an ES module at /automation-board.js) and the Activity dashboard (serialized inline).
// Admins and members get the same page, filters and actions; only the server-side scope differs.
// Everything the server sends is rendered as text — never as markup.

// `config`: { boardApi, boardHeaders, adminConsole, teamId, base, csrf, rootId, page, roiHref,
// boardHref }. Mounts into #ab-root (or `rootId`); `page: "roi"` renders the ROI page instead of
// the board — the same component, so both surfaces get the same numbers and the same edit forms.
export function automationBoardBrowser(config, browser) {
  "use strict";
  const { document } = browser;
  const root = document.getElementById(config.rootId || "ab-root");
  if (!root) return;
  const api = config.boardApi || (config.base + "/api/automations");
  const headers = config.boardHeaders || (config.csrf ? { "X-CG-CSRF": config.csrf } : {});
  const store = (() => { try { return browser.localStorage; } catch { return null; } })();
  const remembered = Number(store?.getItem("cg-ab-days"));
  const state = {
    board: null, error: "", loading: true, days: [1, 7, 30].includes(remembered) ? remembered : 7,
    view: "attention", q: "", sort: "urgent", conv: new Set(), trigger: new Set(), kind: new Set(), problem: new Set(), owner: new Set(),
    detail: null, tab: "overview", runs: new Map(), openRun: "", busy: new Set(),
    roi: null, roiDays: [7, 30, 90].includes(Number(store?.getItem("cg-roi-days"))) ? Number(store.getItem("cg-roi-days")) : 30, roiEdit: "", dirty: false,
  };
  const roiPage = config.page === "roi";

  // ── tiny DOM helpers ──────────────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const ICONS = {
    alert: "<path d='M8 2.2 14.5 13.5h-13z'/><path d='M8 6.5v3M8 11.4v.1'/>",
    inbox: "<path d='M2 9.5 4 3.5h8l2 6v3H2z'/><path d='M2 9.5h3.5l1 1.5h3l1-1.5H14'/>",
    x: "<circle cx='8' cy='8' r='6'/><path d='m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4'/>",
    check: "<circle cx='8' cy='8' r='6'/><path d='m5.3 8.2 1.8 1.8 3.6-3.8'/>",
    pause: "<path d='M6 4v8M10 4v8'/>",
    user: "<circle cx='8' cy='5.5' r='2.6'/><path d='M3 13.5c.6-2.6 2.6-3.8 5-3.8s4.4 1.2 5 3.8'/>",
    layers: "<path d='m8 2 6 3.2-6 3.2-6-3.2z'/><path d='m2 8.2 6 3.2 6-3.2M2 11l6 3.2 6-3.2'/>",
    hash: "<path d='M6 2.5 5 13.5M11 2.5l-1 11M2.8 6h11M2.2 10.5h11'/>",
    clock: "<circle cx='8' cy='8' r='6'/><path d='M8 4.8V8l2.3 1.5'/>",
    send: "<path d='M14 2 7 9M14 2 9.6 14 7 9 2 6.4z'/>",
    spark: "<path d='M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12'/>",
    play: "<path d='M5 3.2v9.6L12.8 8z'/>",
    edit: "<path d='M10.6 2.8 13.2 5.4 6 12.6l-3.2.6.6-3.2z'/>",
    dots: "<circle cx='3.5' cy='8' r='.9'/><circle cx='8' cy='8' r='.9'/><circle cx='12.5' cy='8' r='.9'/>",
    back: "<path d='M13 8H3M7 4 3 8l4 4'/>",
    search: "<circle cx='7' cy='7' r='4.5'/><path d='m10.5 10.5 3 3'/>",
    copy: "<rect x='5.5' y='5.5' width='8' height='8' rx='1.5'/><path d='M3.5 10.5h-1v-8h8v1'/>",
    ext: "<path d='M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4'/>",
    task: "<rect x='2.5' y='2.5' width='11' height='11' rx='2.5'/><path d='m5.5 8.2 1.7 1.7 3.4-3.6'/>",
    bell: "<path d='M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1 1H3z'/><path d='M6.6 14h2.8'/>",
    loop: "<path d='M3 8a5 5 0 0 1 8.6-3.5L13 6M13 8a5 5 0 0 1-8.6 3.5L3 10'/><path d='M13 2.5V6H9.5M3 13.5V10h3.5'/>",
    api: "<path d='M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5'/>",
    refresh: "<path d='M13 8a5 5 0 1 1-1.5-3.6L13 6'/><path d='M13 2.5V6H9.5'/>",
    trend: "<path d='M2 12.5 6 8l2.5 2.5L14 4.5'/><path d='M10.5 4.5H14V8'/>",
    trash: "<path d='M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9'/>",
  };
  function icon(name, cls) {
    const span = h("span", { class: "ab-ico" + (cls ? " " + cls : ""), "aria-hidden": "true" });
    span.innerHTML = "<svg viewBox='0 0 16 16'>" + (ICONS[name] || "") + "</svg>"; // constant markup only
    return span;
  }
  const kindIcon = (kind) => kind === "Reminder" ? "bell" : kind === "Thread loop" ? "loop" : kind === "API" ? "api" : "task";

  // ── formatting ────────────────────────────────────────────────────────────────────────────
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  function span(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 1) return "less than a minute";
    if (m < 60) return m + "m";
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
    const d = Math.floor(hrs / 24);
    return d + "d" + (hrs % 24 && d < 3 ? " " + (hrs % 24) + "h" : "");
  }
  const rel = (iso) => { if (!iso) return ""; const ms = Date.parse(iso) - Date.now(); return ms >= 0 ? "in " + span(ms) : span(ms) + " ago"; };
  const stamp = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  const money = (n, digits) => typeof n === "number" ? "$" + n.toFixed(digits ?? (n >= 10 ? 2 : n >= 1 ? 2 : 4)) : "—";
  // ROI figures: whole dollars from 1,000 up, hours as minutes below one hour, ROI as a multiple.
  const usd = (n) => typeof n !== "number" ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", Math.abs(n) >= 1000 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hrs = (n) => typeof n !== "number" ? "—" : n > 0 && n < 1 ? Math.round(n * 60) + " min" : (n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 10) / 10)) + " h";
  const mult = (n) => typeof n !== "number" ? "—" : (n < 0 ? "−" : "") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 }) + "×";
  const netTone = (n) => typeof n !== "number" ? "idle" : n > 0 ? "ok" : n < 0 ? "fail" : "idle";
  const pct = (r) => r === null || r === undefined ? "—" : Math.round(r * 100) + "%";
  const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"; };
  const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const RUN_LABEL = { succeeded: "Succeeded", "no-op": "Nothing to do", failed: "Failed", blocked: "Blocked", interrupted: "Interrupted", unreported: "Unreported", completed: "Completed", skipped: "Skipped", running: "Running", queued: "Queued" };
  const DELIVERY_LABEL = { delivered: "Delivered", suppressed: "Not posted (by rule)", pending: "Pending", failed: "Not delivered" };
  const HEALTH_LABEL = { broken: "Broken", degraded: "Degraded", healthy: "Healthy", paused: "Paused" };
  const runTone = (s) => s === "succeeded" || s === "no-op" ? "ok" : s === "running" || s === "queued" ? "live" : s === "blocked" || s === "unreported" ? "warn" : s === "failed" || s === "interrupted" ? "fail" : "idle";
  const deliveryTone = (d) => d === "delivered" ? "ok" : d === "failed" ? "fail" : d === "pending" ? "warn" : "idle";
  const pill = (text, tone) => h("span", { class: "ab-pill ab-" + tone }, h("i"), text);
  function statusPill(a) {
    if (a.health === "paused") return pill("Paused", "idle");
    if (a.problem?.key === "undeliverable") return pill("Undeliverable", "fail");
    if (a.problem?.outcome === "delivery") return pill(a.problem.key === "delivery_retrying" ? "Retrying delivery" : "Not delivered", a.health === "broken" ? "fail" : "warn");
    if (a.problem?.key === "blocked") return pill("Blocked", "warn");
    if (a.problem?.key === "interrupted") return pill("Interrupted", "fail");
    if (a.problem) return pill(a.health === "broken" ? "Failing" : "Degraded", a.health === "broken" ? "fail" : "warn");
    if (a.running) return pill("Running", "live");
    return pill(a.lastRun ? "Healthy" : "No runs yet", a.lastRun ? "ok" : "idle");
  }
  function asideNote(a) {
    if (a.streak > 1) return a.streak + " in a row";
    if (a.problem?.key === "blocked" && a.problem.since) return "Waiting " + span(Date.now() - Date.parse(a.problem.since));
    if (a.health === "paused") return "";
    if (a.running) return "Running now";
    return "";
  }

  // ── data ──────────────────────────────────────────────────────────────────────────────────
  async function request(path, init = {}) {
    const response = await browser.fetch(api + path, { credentials: "same-origin", cache: "no-store", ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...headers, ...(init.headers || {}) } });
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) {
      throw new Error(body && typeof body.error === "string" && response.status !== 503 && body.error.length < 300 && !/^(unavailable|forbidden)$/i.test(body.error) ? body.error
        : [401, 403].includes(response.status) ? "Your session or access to this conversation has ended. Reload the page."
          : response.status === 404 ? "That automation no longer exists." : "Couldn’t reach the gateway. Try again.");
    }
    return body;
  }
  const itemPath = (a, action) => "/" + encodeURIComponent(a.channelId) + "/" + encodeURIComponent(a.id) + "/" + action;
  async function load(quiet) {
    if (!quiet) { state.loading = true; paint(); }
    try {
      if (roiPage) state.roi = await request("/roi?days=" + state.roiDays);
      else state.board = await request("/board?days=" + state.days);
      state.error = "";
    } catch (error) { state.error = error.message; }
    state.loading = false;
    if (state.detail && state.board && !findItem(state.detail)) state.detail = null;
    paint();
  }
  const keyOf = (a) => a.channelId + "/" + a.id;
  const findItem = (key) => state.board?.automations.find((a) => keyOf(a) === key) || null;
  async function loadRuns(a, force) {
    const key = keyOf(a);
    if (state.runs.has(key) && !force) return;
    state.runs.set(key, { loading: true, runs: [] });
    paint();
    try { state.runs.set(key, { loading: false, runs: (await request(itemPath(a, "runs"))).runs || [] }); }
    catch (error) { state.runs.set(key, { loading: false, runs: [], error: error.message }); }
    paint();
  }

  // ── toasts and confirmation ───────────────────────────────────────────────────────────────
  const toastHost = h("div", { class: "ab-toasts", role: "status", "aria-live": "polite" });
  function toast(text, tone) {
    const t = h("div", { class: "ab-toast" + (tone ? " ab-" + tone : "") }, text);
    toastHost.append(t);
    browser.setTimeout(() => t.remove(), 5200);
  }
  function confirmBox({ title, body, ok, danger }) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); resolve(v); };
      const okBtn = h("button", { type: "button", class: "ab-btn " + (danger ? "ab-danger" : "ab-primary"), onclick: () => close(true) }, ok);
      const overlay = h("div", { class: "ab-modal", role: "dialog", "aria-modal": "true", "aria-label": title, onclick: (e) => { if (e.target === overlay) close(false); }, onkeydown: (e) => { if (e.key === "Escape") close(false); } },
        h("div", { class: "ab-modal-card" }, h("h3", { text: title }), h("p", { text: body }),
          h("div", { class: "ab-modal-actions" }, h("button", { type: "button", class: "ab-btn", onclick: () => close(false) }, "Cancel"), okBtn)));
      root.append(overlay);
      okBtn.focus();
    });
  }

  // ── actions (every one is re-authorized by the server) ────────────────────────────────────
  async function act(a, action, body, done) {
    const key = keyOf(a) + ":" + action;
    if (state.busy.has(key)) return;
    state.busy.add(key); paint();
    try {
      await request(itemPath(a, action), { method: "POST", body: JSON.stringify(body || {}) });
      if (done) toast(done, "ok");
      await load(true);
      if (state.runs.has(keyOf(a))) void loadRuns(a, true);
    } catch (error) { toast(error.message, "fail"); }
    finally { state.busy.delete(key); paint(); }
  }
  const setEnabled = (a, enabled) => act(a, "update", { enabled }, enabled ? "“" + a.title + "” is on again." : "“" + a.title + "” is paused.");
  async function runNow(a) {
    const yes = await confirmBox({ title: "Run “" + a.title + "” now?",
      body: "The agent runs this automation again right away and posts the result in " + a.conversation + ". It costs a run" + (a.problem?.key === "interrupted" ? ", and actions the interrupted run already took (emails, updates) can happen twice." : " and may repeat external actions such as emails or record updates."),
      ok: "Run now" });
    if (yes) await act(a, "run", {}, "Started. The result is posted in " + a.conversation + " when the run finishes.");
    browser.setTimeout(() => { void load(true); }, 4000);
  }
  async function remove(a) {
    const yes = await confirmBox({ title: "Delete “" + a.title + "”?", body: "It stops running for good. Its run history is kept.", ok: "Delete", danger: true });
    if (!yes) return;
    if (state.detail === keyOf(a)) state.detail = null;
    await act(a, "delete", {}, "Deleted “" + a.title + "”.");
  }
  // Acknowledge: the error was looked at and handled, so the automation shows healthy again.
  // The run history keeps every outcome; only the verdict changes.
  async function acknowledge(a, opts) {
    const { runId, undo, quiet } = opts || {};
    const key = keyOf(a) + ":acknowledge";
    if (state.busy.has(key)) return false;
    state.busy.add(key); if (!quiet) paint();
    try {
      const out = await request(itemPath(a, "acknowledge"), { method: "POST", body: JSON.stringify({ ...(runId ? { runId } : {}), ...(undo ? { undo: true } : {}) }) });
      if (!quiet) {
        toast(undo ? "The error is open again." : runId ? "Error acknowledged." : out.acknowledged > 1 ? plural(out.acknowledged, "error") + " acknowledged on “" + a.title + "”." : "“" + a.title + "” is marked as handled.", "ok");
        await load(true);
        if (state.runs.has(keyOf(a))) void loadRuns(a, true);
      }
      return true;
    } catch (error) { toast(error.message, "fail"); return false; }
    finally { state.busy.delete(key); if (!quiet) paint(); }
  }
  async function acknowledgeMany(items) {
    const yes = await confirmBox({ title: "Acknowledge " + plural(items.length, "automation") + "?",
      body: "Marks every open error on " + (items.length === 1 ? "“" + items[0].title + "”" : "these automations") + " as handled, so they show healthy until a new run fails. Nothing runs, and the run history keeps the errors.", ok: "Acknowledge" });
    if (!yes) return;
    let done = 0;
    for (const a of items) if (await acknowledge(a, { quiet: true })) done += 1;
    if (done) toast(plural(done, "automation") + " marked as handled.", "ok");
    await load(true);
  }
  const ackBusy = (a) => state.busy.has(keyOf(a) + ":acknowledge");
  function doFixAction(a, action) {
    if (action === "run-now") return runNow(a);
    if (action === "enable") return setEnabled(a, true);
    if (action === "pause") return setEnabled(a, false);
    if (action === "edit") return openDetail(a, "settings");
    if (action === "open-runs") return openDetail(a, "runs");
    if (action === "details") return openDetail(a, "overview");
    return undefined;
  }
  const ACTION_LABEL = { "run-now": "Run now", enable: "Turn back on", pause: "Pause", edit: "Edit instructions", "open-runs": "Open runs" };
  const allowed = (a, action) => action === "open-runs" || action === "details" || (action === "run-now" ? a.canRunNow : a.canEdit);
  function primaryAction(a) {
    // When the first step is something only a person can do (re-invite the bot, renew a login),
    // the button opens the fix steps instead of skipping ahead to a later action.
    if (a.fix?.length && !a.fix[0].action) return { action: "details", label: "How to fix" };
    const step = (a.fix || []).find((s) => s.action && allowed(a, s.action) && s.action !== "open-runs") || (a.fix || []).find((s) => s.action);
    if (!step) return null;
    return { action: step.action, label: step.action === "open-runs" ? "Review" : a.problem?.key === "interrupted" && step.action === "enable" ? "Review & turn on" : ACTION_LABEL[step.action] };
  }

  // ── navigation ────────────────────────────────────────────────────────────────────────────
  // The open automation lives in the URL hash, so Back returns to the board and a link opens it.
  function openDetail(a, tab) {
    state.detail = keyOf(a); state.tab = tab || "overview"; state.openRun = "";
    const target = "#automation=" + encodeURIComponent(state.detail);
    if (browser.location.hash !== target) { try { browser.history.pushState(null, "", target); } catch { /* ignore */ } }
    if (state.tab === "runs" || state.tab === "overview") void loadRuns(a);
    paint();
    browser.scrollTo?.(0, 0);
  }
  function closeDetail() {
    state.detail = null;
    if (browser.location.hash) { try { browser.history.pushState(null, "", browser.location.pathname + browser.location.search); } catch { /* ignore */ } }
    paint();
  }
  function fromHash() {
    if (roiPage) return;
    const m = /^#automation=(.+)$/.exec(browser.location.hash || "");
    let key = null;
    if (m) { try { key = decodeURIComponent(m[1]); } catch { key = null; } }
    if (key === state.detail) return;
    state.detail = key; state.tab = "overview"; state.openRun = "";
    const a = key && findItem(key);
    if (a) void loadRuns(a);
    paint();
  }
  browser.addEventListener("popstate", fromHash);
  browser.addEventListener("hashchange", fromHash);

  // ── filtering ─────────────────────────────────────────────────────────────────────────────
  const VIEWS = [
    { id: "attention", label: "Needs attention", icon: "alert", test: (a) => a.attention },
    { id: "not-delivered", label: "Not delivered", icon: "inbox", test: (a) => a.group === "not-delivered" },
    { id: "failing", label: "Failing", icon: "x", test: (a) => a.group === "failing" },
    { id: "mine", label: "Created by me", icon: "user", test: (a) => a.mine },
    { id: "paused", label: "Paused", icon: "pause", test: (a) => a.health === "paused" },
    { id: "all", label: "Everything", icon: "layers", test: () => true },
  ];
  const TRIGGER_LABEL = { api: "API", scheduled: "Scheduled" };
  const triggerOf = (a) => TRIGGER_LABEL[a.trigger] || "Scheduled";
  const owner = (a) => a.createdByName || (a.kind === "API" ? "API" : a.createdBy ? "Unknown person" : "—");
  function facetsMatch(a, skip) {
    if (skip !== "conv" && state.conv.size && !state.conv.has(a.channelId)) return false;
    if (skip !== "trigger" && state.trigger.size && !state.trigger.has(triggerOf(a))) return false;
    if (skip !== "kind" && state.kind.size && !state.kind.has(a.kind)) return false;
    if (skip !== "problem" && state.problem.size && !state.problem.has(a.problem?.label || "No problem")) return false;
    if (skip !== "owner" && state.owner.size && !state.owner.has(owner(a))) return false;
    const q = state.q.trim().toLowerCase();
    if (q && ![a.title, a.conversation, a.instructions, a.problem?.message, a.problem?.label, a.lastRun?.error, a.lastRun?.id, owner(a), a.kind].join("\n").toLowerCase().includes(q)) return false;
    return true;
  }
  const HEALTH_RANK = { broken: 0, degraded: 1, healthy: 2, paused: 3 };
  const SORTS = {
    urgent: (x, y) => HEALTH_RANK[x.health] - HEALTH_RANK[y.health] || Number(y.group === "not-delivered") - Number(x.group === "not-delivered") || y.streak - x.streak || String(x.problem?.since || "").localeCompare(String(y.problem?.since || "")) || x.title.localeCompare(y.title),
    name: (x, y) => x.title.localeCompare(y.title),
    next: (x, y) => String(x.nextRun || "9").localeCompare(String(y.nextRun || "9")),
    success: (x, y) => (x.stats.successRate ?? 2) - (y.stats.successRate ?? 2),
    cost: (x, y) => y.stats.costUsd - x.stats.costUsd,
    roi: (x, y) => Number(y.roi.configured) - Number(x.roi.configured) || y.roi.valueUsd - x.roi.valueUsd || x.title.localeCompare(y.title),
  };
  function visibleItems() {
    const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
    return (state.board?.automations || []).filter((a) => view.test(a) && facetsMatch(a)).sort(SORTS[state.sort] || SORTS.urgent);
  }

  // ── painting ──────────────────────────────────────────────────────────────────────────────
  function strip(cells, big) {
    const wrap = h("div", { class: "ab-strip" + (big ? " ab-strip-big" : ""), role: "img", "aria-label": "Last " + cells.length + " runs: top row is the run, bottom row the delivery" });
    const top = h("div", { class: "ab-strip-row" }), bottom = h("div", { class: "ab-strip-row" });
    const pad = Math.max(0, 30 - cells.length);
    for (let i = 0; i < pad; i++) { top.append(h("i", { class: "c-empty" })); bottom.append(h("i", { class: "c-empty" })); }
    for (const c of cells) {
      const title = stamp(c.at) + " · " + (RUN_LABEL[c.status] || c.status || "Run") + " · " + (DELIVERY_LABEL[c.deliveryStatus] || "No delivery");
      const t = c.ack ? title + " · Acknowledged" : title;
      top.append(h("i", { class: "c-" + c.run + (c.ack ? " is-ack" : ""), title: t }));
      bottom.append(h("i", { class: "c-" + c.delivery + (c.ack ? " is-ack" : ""), title: t }));
    }
    wrap.append(top, bottom, h("div", { class: "ab-strip-axis" }, h("span", { text: cells.length ? shortDate(cells[0].at) : "No runs yet" }), h("span", { text: cells.length ? "latest" : "" })));
    return wrap;
  }
  function successCell(a) {
    const r = a.stats.successRate;
    const tone = r === null ? "idle" : r >= 0.9 ? "ok" : r >= 0.6 ? "warn" : "fail";
    return h("div", { class: "ab-rate" }, h("strong", { class: "ab-t-" + tone, text: pct(r) }), h("span", { text: state.days === 1 ? "24h success" : state.days + "d success" }));
  }
  function toggle(a) {
    const busy = state.busy.has(keyOf(a) + ":update");
    if (a.kind === "API") return null;
    const input = h("input", { type: "checkbox", role: "switch", checked: a.enabled, disabled: !a.canEdit || busy, "aria-label": (a.enabled ? "Pause " : "Turn on ") + a.title,
      title: a.canEdit ? (a.enabled ? "On — click to pause" : "Paused — click to turn on") : "Only the creator or an admin can change this automation",
      onchange: (e) => { e.stopPropagation(); void setEnabled(a, e.target.checked); }, onclick: (e) => e.stopPropagation() });
    return h("label", { class: "ab-switch", onclick: (e) => e.stopPropagation() }, input, h("span"));
  }
  function menu(a) {
    const items = [];
    if (a.canRunNow) items.push(["play", "Run now", () => runNow(a)]);
    items.push(["edit", a.canEdit ? "Edit" : "View settings", () => openDetail(a, "settings")]);
    items.push(["clock", "Runs", () => openDetail(a, "runs")]);
    if (a.canAcknowledge && (a.problem || a.openErrors)) items.push(["check", a.openErrors > 1 ? "Acknowledge all " + a.openErrors + " errors" : "Acknowledge error", () => acknowledge(a)]);
    if (config.teamId && /^[CDG][A-Z0-9]+$/.test(a.channelId)) items.push(["ext", "Open in Slack", () => browser.open("https://app.slack.com/client/" + encodeURIComponent(config.teamId) + "/" + encodeURIComponent(a.channelId), "_blank", "noopener")]);
    if (a.canDelete) items.push(["trash", "Delete", () => remove(a), true]);
    const details = h("details", { class: "ab-menu", onclick: (e) => e.stopPropagation() });
    details.append(h("summary", { class: "ab-icon-btn", "aria-label": "More actions for " + a.title, title: "More actions" }, icon("dots")));
    const list = h("div", { class: "ab-menu-list", role: "menu" });
    for (const [ic, label, fn, danger] of items) list.append(h("button", { type: "button", role: "menuitem", class: danger ? "ab-menu-danger" : "", onclick: () => { details.open = false; void fn(); } }, icon(ic), label));
    details.append(list);
    return details;
  }
  function metaLine(a, full) {
    const parts = [
      h("span", {}, icon("hash"), a.conversation.replace(/^#/, "")),
      h("span", {}, icon("clock"), a.recurrence),
    ];
    if (a.nextRun) parts.push(h("span", { class: "ab-next" }, "Next ", h("b", { text: stamp(a.nextRun) }), " · " + rel(a.nextRun)));
    parts.push(h("span", {}, icon("send"), a.deliveryWords + (a.posting ? " · " + a.posting : "")));
    if (a.engine?.model || a.engine?.engine) parts.push(h("span", {}, icon("spark"), a.engine.model || a.engine.engine));
    if (a.roi?.configured) parts.push(h("span", { class: "ab-roi-chip", title: "ROI in this window: " + plural(a.roi.counted, "run") + " × " + a.roi.minutes + " min at " + usd(a.roi.effectiveRate) + "/h, against " + usd(a.roi.costUsd) + " AI cost" },
      icon("trend"), "Saved " + hrs(a.roi.hoursSaved) + " · " + usd(a.roi.valueUsd) + (a.roi.multiple !== null ? " · " + mult(a.roi.multiple) + " ROI" : "")));
    if (a.createdByName) parts.push(h("span", { class: "ab-owner" }, h("i", { class: "ab-avatar", text: initials(a.createdByName) }), a.createdByName + (a.mine ? " (you)" : "")));
    if (full && a.sudo) parts.push(h("span", { class: "ab-sudo" }, "Host access"));
    return h("div", { class: "ab-meta" }, parts);
  }
  function card(a) {
    const tone = a.health === "broken" ? "fail" : a.health === "degraded" ? "warn" : a.health === "paused" ? "idle" : "ok";
    const el = h("article", { class: "ab-card ab-edge-" + tone, tabindex: "0", "aria-label": a.title + " — " + HEALTH_LABEL[a.health],
      onclick: () => openDetail(a), onkeydown: (e) => { if (e.key === "Enter" && e.target === el) openDetail(a); } });
    const head = h("div", { class: "ab-card-head" },
      h("div", { class: "ab-kind" }, icon(kindIcon(a.kind))),
      h("div", { class: "ab-card-title" }, h("h3", { text: a.title }), statusPill(a), asideNote(a) ? h("span", { class: "ab-aside", text: asideNote(a) }) : null),
      h("div", { class: "ab-card-strip" }, strip(a.strip)), successCell(a));
    el.append(head, metaLine(a));
    const foot = h("div", { class: "ab-card-foot" });
    if (a.problem) foot.append(h("p", { class: "ab-problem ab-t-" + (a.health === "broken" ? "fail" : "warn") }, icon(a.problem.outcome === "delivery" ? "inbox" : a.problem.key === "blocked" ? "alert" : "x"),
      h("span", { text: a.problem.message }), a.problem.code && !["execution", "delivery", "failed"].includes(a.problem.code) ? h("code", { text: a.problem.code }) : null));
    else if (a.lastRun) foot.append(h("p", { class: "ab-last" }, "Last run " + rel(a.lastRun.startedAt) + " · " + (RUN_LABEL[a.lastRun.status] || a.lastRun.status) + (a.lastRun.deliveryStatus ? " · " + (DELIVERY_LABEL[a.lastRun.deliveryStatus] || a.lastRun.deliveryStatus) : "")));
    else foot.append(h("p", { class: "ab-last" }, a.nextRun ? "Hasn't run yet. First run " + rel(a.nextRun) + "." : "No runs recorded yet."));
    const actions = h("div", { class: "ab-card-actions" });
    const primary = a.problem ? primaryAction(a) : null;
    if (primary) {
      const may = allowed(a, primary.action);
      actions.append(h("button", { type: "button", class: "ab-btn ab-primary", disabled: !may || state.busy.has(keyOf(a) + ":" + (primary.action === "run-now" ? "run" : "update")),
        title: may ? "" : "Only the creator or an admin can do this", onclick: (e) => { e.stopPropagation(); void doFixAction(a, primary.action); } }, primary.label));
    }
    if (a.problem && a.canAcknowledge) actions.append(h("button", { type: "button", class: "ab-btn", disabled: ackBusy(a), title: "Already handled? Mark the error as acknowledged so it shows healthy again",
      onclick: (e) => { e.stopPropagation(); void acknowledge(a); } }, icon("check"), "Acknowledge"));
    actions.append(toggle(a) || "", menu(a));
    foot.append(actions);
    el.append(foot);
    return el;
  }
  const GROUPS = [
    { id: "not-delivered", title: "Not delivered", icon: "inbox", tone: "fail", copy: "The run worked, but the answer never reached the conversation" },
    { id: "failing", title: "Failing", icon: "alert", tone: "warn", copy: "Run errors, failing streaks and blocked runs" },
    { id: "healthy", title: "Healthy", icon: "check", tone: "ok", copy: "Running as expected" },
    { id: "paused", title: "Paused", icon: "pause", tone: "idle", copy: "Turned off. Nothing runs until someone turns it back on" },
  ];
  function hero(board) {
    const n = board.attention;
    const nd = board.automations.filter((a) => a.group === "not-delivered").length;
    const k = board.kpis;
    const total = board.automations.length || 1;
    const bar = h("div", { class: "ab-bar", role: "img", "aria-label": `${board.counts.broken} broken, ${board.counts.degraded} degraded, ${board.counts.healthy} healthy, ${board.counts.paused} paused` });
    for (const [key, tone] of [["broken", "fail"], ["degraded", "warn"], ["healthy", "ok"], ["paused", "idle"]]) if (board.counts[key]) bar.append(h("i", { class: "ab-bg-" + tone, style: "flex:" + board.counts[key] / total }));
    const legend = h("div", { class: "ab-legend" });
    for (const [key, tone] of [["broken", "fail"], ["degraded", "warn"], ["healthy", "ok"], ["paused", "idle"]]) {
      legend.append(h("button", { type: "button", class: "ab-legend-item", onclick: () => { state.view = key === "paused" ? "paused" : key === "healthy" ? "all" : "attention"; paint(); } },
        h("i", { class: "ab-bg-" + tone }), h("b", { text: String(board.counts[key]) }), HEALTH_LABEL[key]));
    }
    const headline = h("h2", { class: "ab-headline" });
    if (n) headline.append(h("span", { class: "ab-t-fail", text: String(n) }), " " + (n === 1 ? "automation needs" : "automations need") + " you");
    else headline.append(board.automations.length ? "Every automation is running as expected" : "No automations yet");
    if (nd) headline.append(h("span", { class: "ab-dot", text: " · " }), h("span", { class: "ab-t-warn", text: String(nd) }), " not delivered");
    const label = state.days === 1 ? "Last 24 hours" : "Last " + state.days + " days";
    const kpis = h("p", { class: "ab-kpis" }, label + " ", h("b", { text: String(k.runs) }), " runs · ", h("b", { text: pct(k.successRate) }), " succeeded · ",
      h("b", { text: String(k.notDelivered) }), " not delivered · ", h("b", { text: String(k.failed) }), " failed · ", h("b", { text: money(k.costUsd, 2) }), " spent");
    const main = h("div", { class: "ab-hero-main" },
      h("p", { class: "ab-eyebrow" }, h("i", { class: "ab-live" }), "Automation health · " + (board.viewer.adminConsole ? "all conversations" : "conversations you can access") + " · updated " + new Date(board.generatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })),
      headline, kpis, bar, legend);
    const out = h("section", { class: "ab-hero" }, main);
    out.append(roiBand(board));
    const first = board.automations.filter((a) => a.attention).sort(SORTS.urgent)[0];
    if (first) {
      const primary = primaryAction(first);
      out.append(h("aside", { class: "ab-start" }, h("p", { class: "ab-eyebrow" }, icon("spark"), "Start here"), h("h3", { text: first.title }),
        h("p", { text: first.conversation + " · " + first.problem.label + (first.problem.since ? " since " + stamp(first.problem.since) : "") }),
        h("div", { class: "ab-row" },
          primary && allowed(first, primary.action) ? h("button", { type: "button", class: "ab-btn ab-primary", onclick: () => doFixAction(first, primary.action) }, primary.label) : null,
          h("button", { type: "button", class: "ab-btn", onclick: () => openDetail(first) }, "Details"))));
    }
    return out;
  }
  // ── ROI ───────────────────────────────────────────────────────────────────────────────────
  const windowWords = (days) => days === 1 ? "last 24 hours" : "last " + days + " days";
  function roiTiles(t, opts) {
    const o = opts || {};
    const tile = (label, value, note, tone) => h("div", { class: "ab-roi-tile" }, h("p", { class: "ab-side-label", text: label }), h("strong", { class: tone ? "ab-t-" + tone : "", text: value }), note ? h("small", { text: note }) : null);
    return h("div", { class: "ab-roi-tiles" },
      tile("Time saved", hrs(t.hoursSaved), o.runsNote || ""),
      tile("Value of that time", usd(t.valueUsd), o.valueNote || ""),
      tile("AI cost", usd(t.costUsd), o.costNote || ""),
      tile("Net value", usd(t.netUsd), "value − AI cost", netTone(t.netUsd)),
      tile("ROI", mult(t.multiple), t.multiple === null ? (t.costUsd ? "" : "no AI cost recorded") : "net value ÷ AI cost", netTone(t.multiple)));
  }
  // The Automations page's own ROI dashboard: what the automations in scope returned in the
  // window, and how many of them have the two inputs it needs.
  function roiBand(board) {
    const r = board.roi;
    const head = h("div", { class: "ab-row ab-between" },
      h("p", { class: "ab-eyebrow" }, icon("trend"), "Return on investment · " + windowWords(board.windowDays) + (r.limited ? " (from " + shortDate(r.since) + ", where cost history starts)" : "")),
      config.roiHref ? h("a", { class: "ab-link", href: config.roiHref }, "Open the ROI page", icon("ext")) : null);
    const band = h("section", { class: "ab-roi-band", "aria-label": "Return on investment" }, head);
    if (!r.configured) {
      band.append(h("p", { class: "ab-muted", text: board.automations.length
        ? "No automation has ROI values yet. Open an automation and say how many minutes one successful run saves and what an hour of that work costs — the time saved, its value and the ROI appear here."
        : "ROI appears here once an automation has run and has ROI values." }));
      return band;
    }
    band.append(roiTiles(r, { runsNote: plural(r.counted, "successful run"), costNote: "of those automations" }),
      h("p", { class: "ab-muted ab-roi-note", text: r.configured + " of " + r.items + " automations have ROI values" + (r.unconfiguredCostUsd ? "; the others cost " + usd(r.unconfiguredCostUsd) + " in this window and are not counted." : ".") }));
    return band;
  }
  // Minutes + hourly rate for one item. `save(body)` posts them; the server re-checks who may.
  function roiForm(input, save, opts) {
    const o = opts || {};
    const minutes = h("input", { type: "number", min: "0", max: "100000", step: "any", inputmode: "decimal", value: input.minutes || "", placeholder: "0", "aria-label": "Minutes saved per " + (o.unit || "successful run"), oninput: () => { state.dirty = true; } });
    const rate = h("input", { type: "number", min: "0", max: "100000", step: "any", inputmode: "decimal", value: input.rate || "", placeholder: o.defaultRate ? String(o.defaultRate) + " (default)" : "0", "aria-label": "Hourly rate in US dollars", oninput: () => { state.dirty = true; } });
    const err = h("p", { class: "ab-form-error", role: "alert", hidden: true });
    const btn = h("button", { type: "submit", class: "ab-btn ab-primary ab-small" }, "Save");
    const form = h("form", { class: "ab-roi-form", onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true; btn.disabled = true;
      try {
        await save({ minutesSaved: minutes.value === "" ? 0 : Number(minutes.value), hourlyRate: rate.value === "" ? 0 : Number(rate.value) });
        state.dirty = false; state.roiEdit = "";
        toast("ROI values saved.", "ok");
        await load(true);
      } catch (error) { err.textContent = error.message; err.hidden = false; btn.disabled = false; }
    } },
      h("label", { class: "ab-field" }, h("span", { text: "Minutes saved per " + (o.unit || "successful run") }), minutes),
      h("label", { class: "ab-field" }, h("span", { text: "Hourly rate (USD)" }), rate),
      h("div", { class: "ab-row" }, btn, o.cancel ? h("button", { type: "button", class: "ab-btn ab-small", onclick: () => { state.dirty = false; state.roiEdit = ""; paint(); } }, "Cancel") : null),
      err);
    return form;
  }
  function roiPanel(a) {
    const r = a.roi;
    const panel = h("aside", { class: "ab-panel ab-facts" }, h("h3", { text: "ROI" }));
    if (r.configured) panel.append(h("dl", {},
      fact("Each successful run saves", r.minutes + " min", h("small", { text: " at " + usd(r.effectiveRate) + "/h" + (r.usesDefaultRate ? " (default rate)" : "") })),
      fact("Time saved", hrs(r.hoursSaved), h("small", { text: " · " + plural(r.counted, "successful run") + ", " + windowWords(state.days) })),
      fact("Value", usd(r.valueUsd)),
      fact("AI cost", usd(r.costUsd)),
      fact("Net value", h("span", { class: "ab-t-" + netTone(r.netUsd), text: usd(r.netUsd) })),
      fact("ROI", h("span", { class: "ab-t-" + netTone(r.multiple), text: mult(r.multiple) }), r.multiple === null ? h("small", { text: " no AI cost recorded" }) : null)));
    else panel.append(h("p", { class: "ab-muted", text: r.minutes ? "Add an hourly rate (or ask an admin to set the default rate) to see what the saved time is worth."
      : "Say how many minutes of work one successful run saves and what an hour of that work costs. The board then shows the time saved, its value and the ROI against the AI cost." }));
    if (a.canEditRoi) panel.append(roiForm(r, (body) => request(itemPath(a, "roi"), { method: "POST", body: JSON.stringify(body) }), { defaultRate: state.board?.roi.defaultRate }));
    else panel.append(h("p", { class: "ab-note", text: "Only " + (a.createdByName || "the person who created it") + " or an admin can change these values." }));
    return panel;
  }
  // The ROI page: totals, where the value comes from, then every item with its inputs.
  function roiTable(title, sec, kind, copy) {
    const o = state.roi;
    const skills = kind === "skill";
    const head = h("tr", {}, ...[skills ? "Skill" : kind === "api" ? "API source" : "Automation", skills ? "Used by" : "Conversation", skills ? "Uses" : "Successful runs", "Saves", "Rate", "Time saved", "Value", "AI cost", "Net", "ROI", ""]
      .map((label, i) => h("th", { scope: "col", class: i >= 2 && i <= 9 ? "ab-num" : "", text: label })));
    const body = h("tbody");
    for (const item of sec.items) {
      const r = item.roi;
      const key = kind + ":" + (item.channelId || "") + "/" + item.id;
      const name = !skills && config.boardHref ? h("a", { class: "ab-roi-name", href: config.boardHref + "#automation=" + encodeURIComponent(item.channelId + "/" + item.id), text: item.title }) : h("span", { class: "ab-roi-name", text: item.title });
      const where = skills ? (item.people || item.channels ? plural(item.people, "person").replace("persons", "people") + " · " + plural(item.channels, "conversation") : "—") : item.conversation;
      body.append(h("tr", { class: r.configured ? "" : "is-unset" },
        h("th", { scope: "row" }, name, !skills && item.kind !== "Task" && item.kind !== "API" ? h("small", { text: " " + item.kind }) : null, item.enabled === false ? h("small", { text: " paused" }) : null),
        h("td", { text: where }),
        h("td", { class: "ab-num", text: String(r.counted) }),
        h("td", { class: "ab-num", text: r.minutes ? r.minutes + " min" : "—" }),
        h("td", { class: "ab-num", text: r.effectiveRate ? usd(r.effectiveRate) + "/h" + (r.usesDefaultRate ? "*" : "") : "—", title: r.usesDefaultRate ? "The default hourly rate" : "" }),
        h("td", { class: "ab-num", text: r.minutes ? hrs(r.hoursSaved) : "—" }),
        h("td", { class: "ab-num", text: r.configured ? usd(r.valueUsd) : "—" }),
        h("td", { class: "ab-num", text: r.costUsd === null ? "n/a" : usd(r.costUsd), title: r.costUsd === null ? "The AI cost of a skill use is part of its run and is not split out" : "" }),
        h("td", { class: "ab-num ab-t-" + netTone(r.netUsd), text: usd(r.netUsd) }),
        h("td", { class: "ab-num ab-t-" + netTone(r.multiple), text: mult(r.multiple) }),
        h("td", { class: "ab-roi-act" }, item.canEditRoi ? h("button", { type: "button", class: "ab-btn ab-small" + (r.configured ? "" : " ab-primary"), "aria-expanded": String(state.roiEdit === key), "aria-label": (r.configured ? "Edit ROI values of " : "Set ROI values of ") + item.title,
          onclick: () => { state.roiEdit = state.roiEdit === key ? "" : key; state.dirty = false; paint(); } }, r.configured ? "Edit" : "Set ROI") : null)));
      if (state.roiEdit === key && item.canEditRoi) {
        const save = (values) => skills ? request("/roi/skill", { method: "POST", body: JSON.stringify({ slug: item.id, ...values }) }) : request(itemPath(item, "roi"), { method: "POST", body: JSON.stringify(values) });
        body.append(h("tr", { class: "ab-roi-edit" }, h("td", { colspan: "11" }, roiForm(r, save, { unit: skills ? "use" : "successful run", defaultRate: o.defaultRate, cancel: true }))));
      }
    }
    const t = sec.totals;
    return h("section", { class: "ab-panel ab-roi-section", "aria-label": title },
      h("div", { class: "ab-row ab-between" }, h("div", {}, h("h3", { text: title }), h("p", { class: "ab-muted", text: copy })),
        h("p", { class: "ab-roi-sum" }, h("b", { text: usd(t.valueUsd) }), " value · ", h("b", { text: hrs(t.hoursSaved) }), " saved" + (t.costKnown && t.configured ? " · " : ""), t.costKnown && t.configured ? h("b", { class: "ab-t-" + netTone(t.multiple), text: mult(t.multiple) }) : null, t.costKnown && t.configured ? " ROI" : "",
          h("small", { text: "  " + t.configured + " of " + t.items + " set" }))),
      sec.items.length ? h("div", { class: "ab-roi-scroll" }, h("table", { class: "ab-roi-table" }, h("thead", {}, head), body))
        : h("p", { class: "ab-muted", text: skills ? "No skill was used in this window." : kind === "api" ? "No API source in the conversations you can see." : "No automations yet." }));
  }
  function paintRoi() {
    if (state.loading && !state.roi) { root.replaceChildren(h("p", { class: "ab-muted ab-loading", text: "Loading ROI…" }), toastHost); return; }
    const o = state.roi;
    if (!o) { root.replaceChildren(h("div", { class: "ab-empty" }, h("h3", { text: "Couldn’t load ROI" }), h("p", { text: state.error }), h("button", { type: "button", class: "ab-btn", onclick: () => load() }, "Try again")), toastHost); return; }
    const seg = h("div", { class: "ab-seg", role: "group", "aria-label": "Time window" });
    for (const d of [7, 30, 90]) seg.append(h("button", { type: "button", class: state.roiDays === d ? "is-active" : "", "aria-pressed": String(state.roiDays === d),
      onclick: () => { state.roiDays = d; try { store?.setItem("cg-roi-days", String(d)); } catch { /* ignore */ } void load(true); } }, d + "d"));
    let rateBox;
    if (o.viewer.isAdmin) {
      const rate = h("input", { type: "number", min: "0", max: "100000", step: "any", inputmode: "decimal", value: o.defaultRate || "", placeholder: "0", "aria-label": "Default hourly rate in US dollars", oninput: () => { state.dirty = true; } });
      rateBox = h("form", { class: "ab-roi-default", title: "Used for every item that has minutes saved but no hourly rate of its own", onsubmit: async (e) => {
        e.preventDefault();
        try { await request("/roi/default", { method: "POST", body: JSON.stringify({ hourlyRate: rate.value === "" ? 0 : Number(rate.value) }) }); state.dirty = false; toast("Default hourly rate saved.", "ok"); await load(true); }
        catch (error) { toast(error.message, "fail"); }
      } }, h("label", {}, h("span", { text: "Default rate" }), h("span", { class: "ab-roi-money" }, "$", rate, "/h")), h("button", { type: "submit", class: "ab-btn ab-small" }, "Save"));
    } else rateBox = h("span", { class: "ab-muted", text: o.defaultRate ? "Default rate " + usd(o.defaultRate) + "/h" : "No default rate set" });
    const t = o.totals;
    const parts = [["Automations", o.automations.totals.valueUsd, "accent"], ["API runs", o.api.totals.valueUsd, "live"], ["Skills", o.skills.totals.valueUsd, "ok"]];
    const split = h("div", { class: "ab-roi-split" });
    if (t.valueUsd > 0) {
      const bar = h("div", { class: "ab-bar", role: "img", "aria-label": parts.map(([label, v]) => label + " " + usd(v)).join(", ") });
      for (const [, v, tone] of parts) if (v > 0) bar.append(h("i", { class: "ab-src-" + tone, style: "flex:" + v / t.valueUsd }));
      const legend = h("div", { class: "ab-legend" });
      for (const [label, v, tone] of parts) legend.append(h("span", { class: "ab-legend-item" }, h("i", { class: "ab-src-" + tone }), h("b", { text: usd(v) }), label + " · " + Math.round((v / t.valueUsd) * 100) + "%"));
      split.append(h("p", { class: "ab-side-label", text: "Where the value comes from" }), bar, legend);
    }
    const hero = h("section", { class: "ab-hero ab-roi-hero" }, h("div", { class: "ab-hero-main" },
      h("p", { class: "ab-eyebrow" }, icon("trend"), "Return on investment · " + (o.viewer.adminConsole ? "all conversations" : o.viewer.isAdmin ? "all conversations you can access, every skill use" : "conversations you can access") + " · " + windowWords(o.windowDays) + (o.limited ? " (from " + shortDate(o.since) + ", where cost history starts)" : "")),
      h("h2", { class: "ab-headline" }, t.configured ? [h("span", { class: "ab-t-" + netTone(t.netUsd), text: usd(t.netUsd) }), " net value from ", h("span", { text: hrs(t.hoursSaved) }), " of saved work"] : "Set ROI values to see what your automations are worth"),
      roiTiles(t, { runsNote: t.configured + " of " + t.items + " items have ROI values", valueNote: "automations, API runs and skills", costNote: "automations and API runs" }), split));
    root.replaceChildren(
      state.error ? h("p", { class: "ab-banner", text: state.error }) : "",
      h("div", { class: "ab-toolbar ab-roi-toolbar" }, h("h2", { class: "ab-view-title" }, icon("trend"), "ROI"), rateBox, seg,
        h("button", { type: "button", class: "ab-icon-btn", title: "Refresh", "aria-label": "Refresh", onclick: () => load(true) }, icon("refresh"))),
      hero,
      roiTable("Automations", o.automations, "automation", "Scheduled tasks, reminders and loops. A run counts when it succeeded and its answer arrived."),
      roiTable("API runs", o.api, "api", "Runs started over the HTTP run API, by token" + (o.viewer.isAdmin ? "." : " — the ones your own tokens started.")),
      roiTable("Skills", o.skills, "skill", "One use per run that loaded the skill. A skill’s AI cost is part of its run and is not split out, so skills show value without a cost." + (o.viewer.isAdmin ? "" : " Only an admin sets a skill’s values.")),
      h("p", { class: "ab-muted ab-roi-note", text: "How it is calculated: time saved = successful runs × minutes saved per run; value = time saved × hourly rate (* = the default rate); net = value − AI cost; ROI = net ÷ AI cost. The minutes and rates are estimates people entered. Items without them are listed but not counted." }),
      toastHost);
  }

  function facet(title, key, values) {
    if (values.length < 2 && !state[key].size) return null;
    const box = h("details", { class: "ab-facet", open: true }, h("summary", { text: title }));
    for (const [value, label, count] of values) {
      const id = "ab-f-" + key + "-" + Math.abs([...value].reduce((x, c) => (x * 31 + c.charCodeAt(0)) | 0, 7));
      box.append(h("label", { class: "ab-check", for: id },
        h("input", { id, type: "checkbox", checked: state[key].has(value), onchange: (e) => { if (e.target.checked) state[key].add(value); else state[key].delete(value); paint(); } }),
        h("span", { text: label }), h("em", { text: String(count) })));
    }
    return box;
  }
  function counts(key, pick) {
    const map = new Map();
    for (const a of state.board.automations) {
      if (!facetsMatch(a, key)) continue;
      const [value, label] = pick(a);
      const cur = map.get(value) || [value, label, 0];
      cur[2] += 1; map.set(value, cur);
    }
    for (const v of state[key]) if (!map.has(v)) map.set(v, [v, key === "conv" ? (state.board.conversations.find((c) => c.channelId === v)?.name || v) : v, 0]);
    return [...map.values()].sort((x, y) => y[2] - x[2] || x[1].localeCompare(y[1]));
  }
  function sidebar(board) {
    const search = h("input", { type: "search", class: "ab-search", placeholder: "Search name, error, run id", "aria-label": "Search automations", value: state.q,
      oninput: (e) => { state.q = e.target.value; paintList(); } });
    const views = h("nav", { class: "ab-views", "aria-label": "Views" }, h("p", { class: "ab-side-label", text: "Views" }));
    for (const v of VIEWS) {
      const count = board.automations.filter((a) => v.test(a) && facetsMatch(a)).length;
      views.append(h("button", { type: "button", class: "ab-view" + (state.view === v.id ? " is-active" : ""), "aria-pressed": String(state.view === v.id), onclick: () => { state.view = v.id; paint(); } },
        icon(v.icon), h("span", { text: v.label }), h("em", { class: v.id === "attention" && count ? "ab-t-fail" : "", text: String(count) })));
    }
    const filters = h("div", { class: "ab-filters" }, h("p", { class: "ab-side-label", text: "Filter" }),
      facet("Conversation", "conv", counts("conv", (a) => [a.channelId, a.conversation])),
      facet("Problem", "problem", counts("problem", (a) => [a.problem?.label || "No problem", a.problem?.label || "No problem"])),
      facet("Trigger", "trigger", counts("trigger", (a) => [triggerOf(a), triggerOf(a)])),
      facet("Type", "kind", counts("kind", (a) => [a.kind, a.kind])),
      facet("Created by", "owner", counts("owner", (a) => [owner(a), owner(a)])));
    return h("aside", { class: "ab-side" }, h("div", { class: "ab-search-wrap" }, icon("search"), search), views, filters);
  }
  function chips() {
    const out = h("div", { class: "ab-chips" });
    const add = (key, value, label) => out.append(h("button", { type: "button", class: "ab-chip", "aria-label": "Remove filter " + label, onclick: () => { state[key].delete(value); paint(); } }, label, h("b", { text: "×" })));
    for (const v of state.conv) add("conv", v, state.board.conversations.find((c) => c.channelId === v)?.name || v);
    for (const key of ["problem", "trigger", "kind", "owner"]) for (const v of state[key]) add(key, v, v);
    if (state.q) out.append(h("button", { type: "button", class: "ab-chip", onclick: () => { state.q = ""; paint(); } }, "“" + state.q + "”", h("b", { text: "×" })));
    if (!out.childNodes.length) return null;
    out.append(h("button", { type: "button", class: "ab-link", onclick: () => { for (const k of ["conv", "problem", "trigger", "kind", "owner"]) state[k].clear(); state.q = ""; paint(); } }, "Clear all"));
    return out;
  }
  function toolbar() {
    const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
    const bulk = state.board ? visibleItems().filter((a) => a.problem && a.canAcknowledge) : [];
    const seg = h("div", { class: "ab-seg", role: "group", "aria-label": "Time window" });
    for (const [d, label] of [[1, "24h"], [7, "7d"], [30, "30d"]]) seg.append(h("button", { type: "button", class: state.days === d ? "is-active" : "", "aria-pressed": String(state.days === d),
      onclick: () => { state.days = d; try { store?.setItem("cg-ab-days", String(d)); } catch { /* ignore */ } void load(true); } }, label));
    const sort = h("select", { class: "ab-select", "aria-label": "Sort", onchange: (e) => { state.sort = e.target.value; paintList(); } });
    for (const [v, label] of [["urgent", "Most urgent"], ["next", "Next run"], ["success", "Lowest success"], ["cost", "Most expensive"], ["roi", "Highest value"], ["name", "Name"]]) sort.append(h("option", { value: v, selected: state.sort === v }, label));
    return h("div", { class: "ab-toolbar" }, h("h2", { class: "ab-view-title" }, icon(view.icon), view.label),
      h("span", { class: "ab-key", title: "Each square is one run: top row the run, bottom row its delivery" }, h("i", { class: "c-ok" }), h("i", { class: "c-ok" }), " run / delivery"),
      bulk.length ? h("button", { type: "button", class: "ab-btn ab-small", title: "Mark every open error in this list as handled", onclick: () => acknowledgeMany(bulk) }, icon("check"), "Acknowledge all (" + bulk.length + ")") : null,
      seg, sort, h("button", { type: "button", class: "ab-icon-btn", title: "Refresh", "aria-label": "Refresh", onclick: () => load(true) }, icon("refresh")));
  }
  let listHost = null;
  function paintList() {
    if (!listHost) return;
    const items = visibleItems();
    const out = [];
    if (!items.length) {
      const all = state.board.automations.length;
      out.push(h("div", { class: "ab-empty" }, icon(state.view === "attention" && all ? "check" : "layers"),
        h("h3", { text: !all ? "No automations yet" : state.view === "attention" && !state.q && !state.conv.size ? "Nothing needs you right now" : "No automation matches" }),
        h("p", { text: !all ? "Ask the agent in any conversation, for example: “every weekday at 9:00, summarize yesterday’s emails”." : state.view === "attention" ? "Every automation in scope ran and delivered as expected." : "Change the view or clear the filters." }),
        state.view !== "all" && all ? h("button", { type: "button", class: "ab-btn", onclick: () => { state.view = "all"; paint(); } }, "Show everything") : null));
    } else {
      for (const g of GROUPS) {
        const inGroup = items.filter((a) => a.group === g.id);
        if (!inGroup.length) continue;
        const broken = inGroup.filter((a) => a.health === "broken").length, degraded = inGroup.filter((a) => a.health === "degraded").length;
        out.push(h("section", { class: "ab-group", "aria-label": g.title },
          h("header", { class: "ab-group-head" }, h("span", { class: "ab-group-ico ab-t-" + g.tone }, icon(g.icon)), h("h3", { text: g.title }), h("em", { text: String(inGroup.length) }), h("span", { class: "ab-group-copy", text: g.copy }),
            broken || degraded ? h("span", { class: "ab-group-sum", text: [broken ? broken + " broken" : "", degraded ? degraded + " degraded" : ""].filter(Boolean).join(" · ") }) : null),
          inGroup.map(card)));
      }
    }
    listHost.replaceChildren(...out);
  }

  // ── detail ────────────────────────────────────────────────────────────────────────────────
  function fact(label, ...value) { return h("div", { class: "ab-fact" }, h("dt", { text: label }), h("dd", {}, ...value)); }
  function issueCard(a) {
    if (!a.problem) {
      const ack = a.acknowledgement;
      if (ack && a.health !== "paused") {
        return h("section", { class: "ab-panel ab-issue ab-issue-ok" }, h("p", { class: "ab-eyebrow ab-t-ok" }, icon("check"), "Error acknowledged"),
          h("h3", { text: "Marked as handled" }),
          h("p", { text: "The last run’s error (" + ack.label + ") was acknowledged" + (ack.byName ? " by " + ack.byName : "") + " " + rel(ack.at) + ". The automation shows healthy until a new run fails." }),
          a.canAcknowledge ? h("div", { class: "ab-row" }, h("button", { type: "button", class: "ab-btn", disabled: ackBusy(a), onclick: () => acknowledge(a, { runId: ack.runId, undo: true }) }, "Undo"),
            h("button", { type: "button", class: "ab-btn", onclick: () => openDetail(a, "runs") }, "Open runs")) : null);
      }
      return h("section", { class: "ab-panel ab-issue ab-issue-ok" }, h("p", { class: "ab-eyebrow ab-t-ok" }, icon("check"), "No open issue"),
        h("h3", { text: a.health === "paused" ? "Paused" : a.lastRun ? "Running as expected" : "Waiting for its first run" }),
        h("p", { text: a.health === "paused" ? "Nothing runs until it is turned back on." + (a.lastRun ? " Its last run " + (RUN_LABEL[a.lastRun.status] || a.lastRun.status).toLowerCase() + " " + rel(a.lastRun.startedAt) + "." : "")
          : a.lastRun ? "Last run " + rel(a.lastRun.startedAt) + ": " + (RUN_LABEL[a.lastRun.status] || a.lastRun.status) + (a.lastRun.summary ? " — " + a.lastRun.summary : ".") : a.nextRun ? "First run " + rel(a.nextRun) + "." : "" }),
        a.health === "paused" && a.canEdit ? h("div", { class: "ab-row" }, h("button", { type: "button", class: "ab-btn ab-primary", onclick: () => setEnabled(a, true) }, "Turn back on")) : null);
    }
    const tone = a.health === "broken" ? "fail" : "warn";
    const steps = h("ol", { class: "ab-steps" });
    (a.fix || []).forEach((s) => {
      const li = h("li", {}, h("h4", { text: s.title }), s.body ? h("p", { text: s.body }) : null);
      if (s.copy) li.append(h("div", { class: "ab-copy" }, h("code", { text: s.copy }), h("button", { type: "button", class: "ab-btn ab-small", onclick: () => { browser.navigator.clipboard?.writeText(s.copy).then(() => toast("Copied “" + s.copy + "”."), () => toast("Copy it by hand: " + s.copy)); } }, icon("copy"), "Copy")));
      if (s.action) {
        const may = allowed(a, s.action);
        li.append(h("button", { type: "button", class: "ab-btn" + (s.action === "open-runs" ? "" : " ab-primary"), disabled: !may, title: may ? "" : "Only the creator or an admin can do this", onclick: () => doFixAction(a, s.action) },
          s.action === "run-now" ? "Run now (runs the agent again)" : ACTION_LABEL[s.action]));
      }
      steps.append(li);
    });
    return h("section", { class: "ab-panel ab-issue ab-issue-" + tone },
      h("div", { class: "ab-issue-top" }, h("p", { class: "ab-eyebrow ab-t-" + tone }, icon(a.problem.outcome === "delivery" ? "inbox" : "x"), a.problem.label), pill("Open", tone)),
      h("h3", { text: a.problem.key === "webhook_failed" ? "The result didn’t reach the caller’s webhook" : a.problem.outcome === "delivery" ? "The answer didn’t reach " + a.conversation : a.problem.label }),
      h("p", { class: "ab-issue-when" }, a.problem.since ? "Since " + stamp(a.problem.since) : "", a.streak > 1 ? " · " + plural(a.streak, "run") + " in a row" : "", a.lastRun?.id ? h("code", { text: a.lastRun.id.slice(0, 8) }) : null),
      h("p", { class: "ab-issue-msg", text: a.problem.message }),
      a.fix?.length ? h("p", { class: "ab-side-label", text: "How to fix" }) : null, steps,
      a.canAcknowledge ? h("div", { class: "ab-ack" },
        h("div", {}, h("h4", { text: "Already handled?" }), h("p", { text: "Acknowledge the error to put the automation back to healthy. Nothing runs, and the run stays in the history. A new failure opens it again." })),
        h("div", { class: "ab-row" },
          a.lastRun?.id && a.openErrors > 1 ? h("button", { type: "button", class: "ab-btn", disabled: ackBusy(a), onclick: () => acknowledge(a, { runId: a.lastRun.id }) }, "Acknowledge latest") : null,
          h("button", { type: "button", class: "ab-btn ab-primary", disabled: ackBusy(a), onclick: () => acknowledge(a) }, icon("check"), a.openErrors > 1 ? "Acknowledge all " + a.openErrors + " errors" : "Acknowledge error"))) : null,
      !a.canEdit && a.kind !== "API" ? h("p", { class: "ab-note", text: "Only " + (a.createdByName || "the person who created it") + " or an admin can change or run this automation, because it runs with their accounts." }) : null);
  }
  function keyFacts(a) {
    const notify = a.kind === "API" ? "The API caller receives the result"
      : [a.notify === "channel" ? "Pings the conversation" : a.notify === "user" ? "Pings one person" : "No ping", a.failureNotify ? "posts a notice when a run fails" : "no failure notices"].join(", ");
    const avg = a.stats.runs ? a.stats.costUsd / a.stats.runs : null;
    return h("aside", { class: "ab-panel ab-facts" }, h("h3", { text: "Key facts" }), h("dl", {},
      fact("Schedule", a.recurrence, a.timing.cron ? h("code", { text: a.timing.cron }) : null),
      a.nextRun ? fact("Next run", stamp(a.nextRun), h("small", { text: " " + rel(a.nextRun) })) : fact("Next run", a.kind === "API" ? "When the API is called" : a.enabled ? "None scheduled" : "Paused"),
      fact("Delivery", a.deliveryWords + " in " + a.conversation + (a.posting ? " · " + a.posting : "")),
      fact("Notifications", notify),
      fact("Created by", a.createdByName || (a.kind === "API" ? "API token" : "Unknown") + (a.mine ? " (you)" : "")),
      fact("Engine", a.engine ? [a.engine.engine, a.engine.model].filter(Boolean).join(" · ") : "Not recorded yet"),
      fact("Average cost", avg === null ? "—" : money(avg) + " / run"),
      a.instructions ? fact("Instructions", h("span", { class: "ab-clip", text: a.instructions.slice(0, 280) + (a.instructions.length > 280 ? "…" : "") })) : null));
  }
  // The run API's limits as this source met them: how close it runs to the cap, and what the
  // gateway refused or answered without starting anything.
  function limitsPanel(a) {
    const l = a.limits;
    if (!l) return null;
    const win = state.days === 1 ? "last 24 hours" : "last " + state.days + " days";
    return h("aside", { class: "ab-panel ab-facts" }, h("h3", { text: "API limits" }), h("dl", {},
      fact("In flight now", l.inFlight + " from this source", h("small", { text: " · " + l.inFlightAll + " of " + l.cap + " across the gateway" })),
      fact("Rejected at the limit", h("span", { class: l.rejected ? "ab-t-fail" : "", text: String(l.rejected) }), h("small", { text: " " + win })),
      fact("Deduplicated", String(l.deduplicated), h("small", { text: " repeated calls, " + win }))));
  }
  function runList(a) {
    const entry = state.runs.get(keyOf(a));
    if (!entry || entry.loading) return h("p", { class: "ab-muted", text: "Loading runs…" });
    if (entry.error) return h("p", { class: "ab-t-fail", text: entry.error });
    if (!entry.runs.length) return h("p", { class: "ab-muted", text: a.kind === "API" ? "No API runs recorded in the last 90 days." : "No runs recorded in the last 90 days." });
    const list = h("ul", { class: "ab-runs" });
    for (const r of entry.runs) {
      const open = state.openRun === r.id;
      const row = h("li", { class: "ab-run" + (open ? " is-open" : "") + (r.acknowledgedAt && r.problem ? " is-ack" : "") });
      const line = h("div", { class: "ab-run-line" });
      row.append(line);
      line.append(h("button", { type: "button", class: "ab-run-head", "aria-expanded": String(open), onclick: () => { state.openRun = open ? "" : r.id; paint(); } },
        pill(RUN_LABEL[r.status] || r.status || "Run", runTone(r.status)),
        r.deliveryStatus && DELIVERY_LABEL[r.deliveryStatus] ? pill(DELIVERY_LABEL[r.deliveryStatus], deliveryTone(r.deliveryStatus)) : h("span"),
        h("span", { class: "ab-run-when", text: stamp(r.startedAt) }),
        h("span", { class: "ab-mono", text: r.durationMs ? dur(r.durationMs) : "" }),
        h("span", { class: "ab-mono", text: typeof r.costUsd === "number" ? money(r.costUsd) : "" }),
        h("span", { class: "ab-run-trigger", text: r.trigger === "manual" ? "Run now" : r.trigger === "schedule" ? "Scheduled" : r.trigger === "api" ? "API call" : "" })));
      if (r.problem && r.acknowledgedAt) line.append(h("span", { class: "ab-run-ack", title: "Acknowledged" + (r.acknowledgedByName ? " by " + r.acknowledgedByName : "") + " · " + stamp(r.acknowledgedAt) }, icon("check"), "Acknowledged",
        a.canAcknowledge ? h("button", { type: "button", class: "ab-link", disabled: ackBusy(a), "aria-label": "Reopen this run's error", onclick: () => acknowledge(a, { runId: r.id, undo: true }) }, "Undo") : null));
      else if (r.problem && a.canAcknowledge) line.append(h("button", { type: "button", class: "ab-btn ab-small ab-run-ack-btn", disabled: ackBusy(a), title: "Mark this run's error as handled", onclick: () => acknowledge(a, { runId: r.id }) }, icon("check"), "Acknowledge"));
      if (open) {
        const body = h("div", { class: "ab-run-body" });
        if (r.problem && r.acknowledgedAt) body.append(h("p", { class: "ab-muted", text: "Acknowledged" + (r.acknowledgedByName ? " by " + r.acknowledgedByName : "") + " on " + stamp(r.acknowledgedAt) + "." }));
        if (r.error) body.append(h("p", { class: "ab-run-error" }, h("b", { text: (r.errorKind ? r.errorKind.replaceAll("_", " ") : "Error") + ": " }), r.error));
        if (r.deliveryError) body.append(h("p", { class: "ab-run-error" }, h("b", { text: "Webhook: " }), r.deliveryError));
        if (r.rejectedCount) body.append(h("p", { class: "ab-muted", text: plural(r.rejectedCount, "call") + " refused here because the run API was at its limit of concurrent runs." }));
        if (r.duplicates) body.append(h("p", { class: "ab-muted", text: plural(r.duplicates, "repeated call") + " with the same idempotency key answered with this run instead of starting another." }));
        if (r.request) body.append(h("p", { class: "ab-run-summary" }, h("b", { text: "Request: " }), r.request));
        if (r.summary) body.append(h("p", { class: "ab-run-summary", text: r.summary }));
        body.append(h("dl", { class: "ab-run-facts" },
          fact("Run id", h("code", { text: r.id })),
          fact("Engine", [r.engine, r.model].filter(Boolean).join(" · ") || "—"),
          fact("Tokens in / out", (r.tokensIn ?? "—") + " / " + (r.tokensOut ?? "—")),
          fact("Tool calls", String(r.toolUseCount ?? "—")),
          fact("Delivery attempts", String(r.deliveryAttempts ?? "—"))));
        const bad = (r.connections || []).filter((c) => c.status !== "available");
        if (bad.length) body.append(h("p", { class: "ab-t-warn", text: "Connections: " + bad.map((c) => c.name + " " + c.status).join(", ") }));
        if (r.events?.length) {
          const tl = h("ol", { class: "ab-timeline" });
          for (const ev of r.events) tl.append(h("li", { class: /fail|abandon|interrupt|exhaust/.test(ev.kind) ? "is-bad" : /deliver/.test(ev.kind) && !/attempt/.test(ev.kind) ? "is-good" : "" },
            h("time", { text: new Date(ev.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }),
            h("span", { text: String(ev.kind).replaceAll("_", " ") + (ev.name ? " · " + ev.name : "") + (ev.status ? " (" + ev.status + ")" : "") })));
          body.append(h("p", { class: "ab-side-label", text: "Timeline" }), tl);
          if (r.eventsDropped) body.append(h("p", { class: "ab-muted", text: r.eventsDropped + " earlier events not kept." }));
        }
        row.append(body);
      }
      list.append(row);
    }
    return list;
  }
  function cronParts(cron) {
    const m = String(cron || "").trim().split(/\s+/);
    if (m.length !== 5) return { freq: "custom" };
    const [mi, hr, dom, mon, dow] = m;
    const num = (v) => /^\d+$/.test(v);
    const time = num(mi) && num(hr) ? String(hr).padStart(2, "0") + ":" + String(mi).padStart(2, "0") : "";
    if (num(mi) && hr === "*" && dom === "*" && mon === "*" && dow === "*") return { freq: "hourly", minute: mi };
    if (!time || mon !== "*") return { freq: "custom" };
    if (dom === "*" && dow === "*") return { freq: "daily", time };
    if (dom === "*" && dow === "1-5") return { freq: "weekdays", time };
    if (dom === "*" && /^[0-6]$/.test(dow)) return { freq: "weekly", time, day: dow };
    if (num(dom) && dow === "*") return { freq: "monthly", time, monthDay: dom };
    return { freq: "custom" };
  }
  function localInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function settingsForm(a) {
    if (a.kind === "API") return h("section", { class: "ab-panel" }, h("h3", { text: "Started by the HTTP API" }), h("p", { class: "ab-muted", text: "API runs have no schedule to edit. Manage or revoke the token in Settings → API tokens." }));
    const ro = !a.canEdit;
    const task = a.kind === "Task";
    const field = (label, control, hint) => h("label", { class: "ab-field" }, h("span", { text: label }), control, hint ? h("small", { text: hint }) : null);
    const name = h("input", { type: "text", maxlength: "200", value: a.title, disabled: ro });
    const enabled = h("input", { type: "checkbox", checked: a.enabled, disabled: ro });
    const prompt = h("textarea", { rows: "8", disabled: ro }); prompt.value = a.instructions;
    const criteria = h("textarea", { rows: "3", disabled: ro, placeholder: "For example: a summary was posted, or every unread client email has a draft reply." }); criteria.value = a.successCriteria;
    const parts = cronParts(a.timing.cron);
    const freq = h("select", { disabled: ro });
    for (const [v, label] of [["daily", "Every day"], ["weekdays", "Weekdays"], ["weekly", "Once a week"], ["monthly", "Once a month"], ["hourly", "Every hour"], ["custom", "Custom (cron)"]]) freq.append(h("option", { value: v, selected: parts.freq === v }, label));
    const time = h("input", { type: "time", value: parts.time || "09:00", disabled: ro });
    const day = h("select", { disabled: ro });
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].forEach((d, i) => day.append(h("option", { value: String(i), selected: String(parts.day ?? "1") === String(i) }, d)));
    const monthDay = h("input", { type: "number", min: "1", max: "28", value: parts.monthDay || "1", disabled: ro });
    const minute = h("input", { type: "number", min: "0", max: "59", value: parts.minute || "0", disabled: ro });
    const cron = h("input", { type: "text", value: a.timing.cron, disabled: ro, class: "ab-mono", "aria-label": "Cron expression" });
    const runAt = h("input", { type: "datetime-local", value: localInput(a.timing.runAt), disabled: ro });
    const timingWrap = h("div", { class: "ab-timing" });
    const syncTiming = () => {
      const f = freq.value;
      timingWrap.replaceChildren(...[field("Repeats", freq),
        f !== "hourly" && f !== "custom" ? field("At (server time)", time) : null,
        f === "weekly" ? field("Day", day) : null, f === "monthly" ? field("Day of month", monthDay) : null,
        f === "hourly" ? field("Minutes past the hour", minute) : null, f === "custom" ? field("Cron (minute hour day month weekday)", cron) : null].filter(Boolean));
    };
    freq.addEventListener("change", syncTiming);
    const cronValue = () => {
      const f = freq.value, [hh = "0", mm = "0"] = time.value.split(":");
      const t = Number(mm) + " " + Number(hh);
      return f === "daily" ? t + " * * *" : f === "weekdays" ? t + " * * 1-5" : f === "weekly" ? t + " * * " + day.value : f === "monthly" ? t + " " + Number(monthDay.value) + " * *" : f === "hourly" ? Number(minute.value) + " * * * *" : cron.value.trim();
    };
    const delivery = h("select", { disabled: ro });
    for (const [v, label] of [["standard", "New thread for each run"], ["daily-thread", "One thread per day"], ["channel", "Post in the channel"], ["thread", "Reply in an existing thread"], ["dm-on-match", "DM me only when something is found"]]) {
      if (v === "daily-thread" && a.timing.once) continue;
      if (v === "dm-on-match" && !a.hasMatchPrefix) continue;
      delivery.append(h("option", { value: v, selected: a.delivery === v }, label));
    }
    const thread = h("input", { type: "text", value: a.deliveryThread, disabled: ro, placeholder: "Thread timestamp, e.g. 1732443600.123456", class: "ab-mono" });
    const threadWrap = field("Thread", thread);
    const syncDelivery = () => { threadWrap.hidden = delivery.value !== "thread"; };
    delivery.addEventListener("change", syncDelivery);
    const policy = h("select", { disabled: ro });
    for (const [v, label] of [["always", "Every run"], ["on-result", "Only when there is a result"], ["on-failure", "Only when it fails"]]) policy.append(h("option", { value: v, selected: a.resultPolicy === v }, label));
    const silent = h("input", { type: "checkbox", checked: a.executionVisibility === "silent", disabled: ro });
    const notify = h("select", { disabled: ro });
    for (const [v, label] of [["channel", "Ping the conversation"], ["user", "Ping one person"], ["none", "Don’t ping anyone"]]) notify.append(h("option", { value: v, selected: a.notify === v }, label));
    const notifyUser = h("input", { type: "text", value: a.notifyUserId, disabled: ro, placeholder: "Slack user ID, e.g. U012AB3CD", class: "ab-mono" });
    const notifyUserWrap = field("Person", notifyUser);
    const syncNotify = () => { notifyUserWrap.hidden = notify.value !== "user"; };
    notify.addEventListener("change", syncNotify);
    const failureNotify = h("input", { type: "checkbox", checked: a.failureNotify, disabled: ro });
    const sudo = h("input", { type: "checkbox", checked: a.sudo, disabled: ro });
    const err = h("p", { class: "ab-form-error", role: "alert", hidden: true });
    const save = h("button", { type: "submit", class: "ab-btn ab-primary", disabled: ro }, "Save changes");
    const form = h("form", { class: "ab-panel ab-form", onsubmit: async (e) => {
      e.preventDefault();
      if (ro) return;
      const body = { description: name.value.trim(), enabled: enabled.checked, prompt: prompt.value, notify: notify.value, failureNotify: failureNotify.checked };
      if (notify.value === "user") body.notifyUserId = notifyUser.value.trim();
      if (task) Object.assign(body, { successCriteria: criteria.value, delivery: delivery.value, resultPolicy: policy.value, executionVisibility: silent.checked ? "silent" : "visible" });
      if (task && delivery.value === "thread") body.deliveryThread = thread.value.trim();
      if (!a.timing.loop) {
        if (a.timing.once) { if (runAt.value) body.runAt = new Date(runAt.value).toISOString(); }
        else if (!a.timing.intervalDays) body.cron = cronValue();
      }
      if (config.adminConsole && task && sudo.checked !== a.sudo) body.sudo = sudo.checked;
      err.hidden = true; save.disabled = true; save.textContent = "Saving…";
      try {
        await request(itemPath(a, "update"), { method: "POST", body: JSON.stringify(body) });
        toast("Saved “" + (body.description || a.title) + "”.", "ok");
        await load(true);
      } catch (error) { err.textContent = error.message; err.hidden = false; }
      finally { save.disabled = false; save.textContent = "Save changes"; }
    } });
    syncTiming(); syncDelivery(); syncNotify();
    form.append(...[
      ro ? h("p", { class: "ab-note", text: "Read only. Only " + (a.createdByName || "the person who created it") + " or an admin can change this automation, because it runs with their accounts." }) : null,
      h("div", { class: "ab-form-grid" }, field("Name", name), h("label", { class: "ab-field ab-inline" }, enabled, h("span", { text: "On (runs on its schedule)" }))),
      field(a.kind === "Reminder" ? "Reminder text" : "Instructions", prompt, a.kind === "Reminder" ? "" : "What the agent does on every run. It runs as " + (a.createdByName || "the creator") + ", with their accounts."),
      task ? field("Success criteria", criteria, "How the agent decides a run succeeded. Leave empty to let it judge.") : null,
      h("h4", { class: "ab-form-head", text: "When" }),
      a.timing.loop ? h("p", { class: "ab-muted", text: "A thread loop paces itself in its thread." }) : a.timing.once ? field("Runs once at", runAt) : a.timing.intervalDays ? h("p", { class: "ab-muted", text: a.recurrence + ". Ask the agent to change the interval." }) : timingWrap,
      task ? h("h4", { class: "ab-form-head", text: "Where the result goes" }) : null,
      task ? h("div", { class: "ab-form-grid" }, field("Delivery", delivery), threadWrap, field("Post", policy)) : null,
      task ? h("label", { class: "ab-field ab-inline" }, silent, h("span", { text: "Silent start (no “working on it” message)" })) : null,
      h("h4", { class: "ab-form-head", text: "Notifications" }),
      h("div", { class: "ab-form-grid" }, field("When it posts", notify), notifyUserWrap),
      h("label", { class: "ab-field ab-inline" }, failureNotify, h("span", { text: "Post a notice in the conversation when a run fails" })),
      config.adminConsole && task ? h("label", { class: "ab-field ab-inline" }, sudo, h("span", { text: "Host access (/sudo): runs on the gateway host instead of the container. Creator must be an admin." })) : null,
      err, h("div", { class: "ab-row ab-form-actions" }, save, h("button", { type: "button", class: "ab-btn", onclick: () => { state.tab = "overview"; paint(); } }, "Cancel"),
        a.canDelete ? h("button", { type: "button", class: "ab-btn ab-danger ab-push", onclick: () => remove(a) }, icon("trash"), "Delete automation") : null)].filter(Boolean));
    return form;
  }
  function detail(a) {
    const tone = a.health === "broken" ? "fail" : a.health === "degraded" ? "warn" : a.health === "paused" ? "idle" : "ok";
    const runsEntry = state.runs.get(keyOf(a));
    const summary = a.problem ? a.problem.message
      : a.health === "paused" ? "Paused. Nothing runs until it is turned back on."
        : a.lastRun ? "Running as expected. Last run " + rel(a.lastRun.startedAt) + "." : "No runs yet.";
    const actions = h("div", { class: "ab-detail-actions" }, toggle(a) ? h("span", { class: "ab-toggle-label" }, toggle(a), a.enabled ? "On" : "Paused") : null,
      a.canRunNow ? h("button", { type: "button", class: "ab-btn", disabled: state.busy.has(keyOf(a) + ":run"), onclick: () => runNow(a) }, icon("play"), "Run now") : null,
      a.kind !== "API" ? h("button", { type: "button", class: "ab-btn", onclick: () => { state.tab = "settings"; paint(); } }, icon("edit"), a.canEdit ? "Edit" : "Settings") : null, menu(a));
    const k = a.stats;
    const stats = h("div", { class: "ab-stats" },
      h("div", { class: "ab-stat ab-stat-strip" }, h("p", { class: "ab-side-label", text: "Last " + Math.max(a.strip.length, 1) + " runs" }), strip(a.strip, true)),
      h("div", { class: "ab-stat" }, h("p", { class: "ab-side-label", text: (state.days === 1 ? "24h" : state.days + "-day") + " success" }), h("strong", { class: "ab-t-" + (k.successRate === null ? "idle" : k.successRate >= 0.9 ? "ok" : k.successRate >= 0.6 ? "warn" : "fail"), text: pct(k.successRate) }), h("small", { text: plural(k.runs, "run") })),
      h("div", { class: "ab-stat" }, h("p", { class: "ab-side-label", text: "Next run" }), h("strong", { text: a.nextRun ? rel(a.nextRun) : a.kind === "API" ? "On call" : "—" }), h("small", { text: a.nextRun ? stamp(a.nextRun) : a.enabled ? "" : "Paused" })),
      h("div", { class: "ab-stat" }, h("p", { class: "ab-side-label", text: "Not delivered" }), h("strong", { class: k.notDelivered ? "ab-t-fail" : "", text: String(k.notDelivered) }), h("small", { text: "in this window" })),
      h("div", { class: "ab-stat" }, h("p", { class: "ab-side-label", text: "Spent" }), h("strong", { text: money(k.costUsd, 2) }), h("small", { text: k.runs ? "avg " + money(k.costUsd / k.runs) + " / run" : "" })));
    const tabs = h("div", { class: "ab-tabs", role: "tablist" });
    for (const [id, label, count] of [["overview", "Overview"], ["runs", "Runs", runsEntry && !runsEntry.loading ? runsEntry.runs.length : null], ["settings", a.canEdit ? "Settings" : "Settings (read only)"]]) {
      tabs.append(h("button", { type: "button", role: "tab", class: state.tab === id ? "is-active" : "", "aria-selected": String(state.tab === id), onclick: () => { state.tab = id; if (id !== "settings") void loadRuns(a); paint(); } },
        label, count !== null && count !== undefined ? h("em", { text: String(count) }) : null, id === "overview" && a.problem ? h("em", { class: "ab-bg-" + tone, text: "1" }) : null));
    }
    const body = state.tab === "runs" ? h("section", { class: "ab-panel" }, h("div", { class: "ab-row ab-between" }, h("h3", { text: "Recent runs" }), h("div", { class: "ab-row" },
      a.canAcknowledge && a.openErrors ? h("button", { type: "button", class: "ab-btn ab-small", disabled: ackBusy(a), onclick: () => acknowledge(a) }, icon("check"), a.openErrors > 1 ? "Acknowledge all " + a.openErrors + " errors" : "Acknowledge error") : null,
      h("button", { type: "button", class: "ab-btn ab-small", onclick: () => loadRuns(a, true) }, icon("refresh"), "Refresh"))), runList(a))
      : state.tab === "settings" ? settingsForm(a)
        : h("div", { class: "ab-overview" }, issueCard(a), h("div", { class: "ab-side-stack" }, keyFacts(a), roiPanel(a), limitsPanel(a)));
    return h("div", { class: "ab-detail" },
      h("button", { type: "button", class: "ab-link ab-back", onclick: closeDetail }, icon("back"), "All automations"),
      h("section", { class: "ab-panel ab-detail-head ab-edge-" + tone },
        h("div", { class: "ab-detail-top" }, h("div", { class: "ab-kind ab-kind-lg" }, icon(kindIcon(a.kind))),
          h("div", { class: "ab-detail-title" }, h("h2", {}, a.title, " ", statusPill(a), asideNote(a) ? h("span", { class: "ab-aside", text: asideNote(a) }) : null), metaLine(a, true)), actions),
        h("p", { class: "ab-detail-summary", text: summary }), stats),
      tabs, body);
  }

  // ── frame ─────────────────────────────────────────────────────────────────────────────────
  function paint() {
    if (roiPage) return paintRoi();
    const keepFocus = document.activeElement?.classList?.contains("ab-search") ? document.activeElement.selectionStart : null;
    listHost = null;
    if (state.loading && !state.board) { root.replaceChildren(h("p", { class: "ab-muted ab-loading", text: "Loading automations…" }), toastHost); return; }
    if (!state.board) { root.replaceChildren(h("div", { class: "ab-empty" }, h("h3", { text: "Couldn’t load automations" }), h("p", { text: state.error }), h("button", { type: "button", class: "ab-btn", onclick: () => load() }, "Try again")), toastHost); return; }
    const a = state.detail ? findItem(state.detail) : null;
    if (a) { root.replaceChildren(detail(a), toastHost); return; }
    listHost = h("div", { class: "ab-list" });
    root.replaceChildren(
      state.error ? h("p", { class: "ab-banner", text: state.error }) : "",
      hero(state.board),
      h("div", { class: "ab-body" }, sidebar(state.board), h("div", { class: "ab-main" }, toolbar(), chips() || "", listHost)),
      toastHost);
    paintList();
    if (keepFocus !== null) { const s = root.querySelector(".ab-search"); s?.focus(); try { s?.setSelectionRange(keepFocus, keepFocus); } catch { /* ignore */ } }
  }
  const hash = roiPage ? null : /^#automation=(.+)$/.exec(browser.location?.hash || "");
  if (hash) { try { state.detail = decodeURIComponent(hash[1]); } catch { state.detail = null; } }
  void load().then(() => { const a = state.detail && findItem(state.detail); if (a) void loadRuns(a); });
  browser.setInterval(() => { if (document.visibilityState !== "hidden" && !state.dirty && !root.querySelector(".ab-form :focus, .ab-roi-form :focus, .ab-roi-default :focus, .ab-modal")) void load(true); }, 60_000);
}

export const AUTOMATION_BOARD_HTML = `<section class="ab-page" aria-label="Automations"><div class="ab-page-head"><h1>Automations</h1><p>Scheduled tasks, reminders, loops and API runs. What didn’t run or didn’t arrive comes first, with how to fix it.</p></div><div id="ab-root" class="ab"><p class="ab-muted">Loading automations…</p></div><noscript><p>Enable JavaScript to view automations.</p></noscript></section>`;

export const AUTOMATION_ROI_HTML = `<section class="ab-page" aria-label="ROI"><div class="ab-page-head"><h1>ROI</h1><p>What automations, API runs and skills are worth: the time each successful run or use saves, at an hourly rate, against what the runs cost.</p></div><div id="ab-root" class="ab"><p class="ab-muted">Loading ROI…</p></div><noscript><p>Enable JavaScript to view ROI.</p></noscript></section>`;

export const AUTOMATION_BOARD_CSS = `
.ab-page{width:100%;min-width:0;max-width:1480px;margin:0 auto;padding:22px 24px 60px}
.ab-page-head h1{margin:0;font-size:20px;letter-spacing:-.01em}.ab-page-head p{margin:4px 0 18px;color:var(--muted);font-size:13px}
.ab{--ab-fail:var(--s-error,var(--danger,#ff6363));--ab-warn:var(--s-waiting,var(--warn,#f5b83d));--ab-ok:var(--s-done,var(--ok,#62c98a));--ab-live:var(--s-working,#5aa9ff);--ab-idle:var(--s-idle,#a9b7b3);
  --ab-panel:var(--panel,#0d1614);--ab-panel-2:var(--panel-2,#111c19);--ab-line:var(--line,rgba(238,242,238,.1));--ab-ink:var(--ink,#f2f5f2);--ab-muted:var(--muted,#b3c0bc);--ab-faint:var(--faint,#8d9d99);--ab-accent:var(--orange,#ff642f);
  color:var(--ab-ink);font-size:13px;line-height:1.45;position:relative}
.ab *{box-sizing:border-box}
.ab button,.ab input,.ab select,.ab textarea{font:inherit;color:inherit}
.ab-ico{display:inline-grid;place-items:center;width:15px;height:15px;flex:none}.ab-ico svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.ab-muted{color:var(--ab-muted)}.ab-mono,.ab code{font-family:var(--mono,ui-monospace,monospace)}
.ab-t-fail{color:var(--ab-fail)}.ab-t-warn{color:var(--ab-warn)}.ab-t-ok{color:var(--ab-ok)}.ab-t-idle{color:var(--ab-idle)}
.ab-bg-fail{background:var(--ab-fail)}.ab-bg-warn{background:var(--ab-warn)}.ab-bg-ok{background:var(--ab-ok)}.ab-bg-idle{background:var(--ab-idle)}
.ab-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap;--c:var(--ab-idle);color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.ab-pill i{width:6px;height:6px;border-radius:50%;background:var(--c)}
.ab-pill.ab-fail{--c:var(--ab-fail)}.ab-pill.ab-warn{--c:var(--ab-warn)}.ab-pill.ab-ok{--c:var(--ab-ok)}.ab-pill.ab-live{--c:var(--ab-live)}
.ab-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--ab-line);background:var(--ab-panel-2);cursor:pointer;font-weight:500;white-space:nowrap}
.ab-btn:hover:not(:disabled){border-color:var(--ab-muted)}.ab-btn:disabled{opacity:.5;cursor:not-allowed}
.ab-btn.ab-primary{background:var(--ab-accent);border-color:var(--ab-accent);color:#fff}.ab-btn.ab-primary:hover:not(:disabled){filter:brightness(1.08)}
.ab-btn.ab-danger{color:var(--ab-fail);border-color:color-mix(in srgb,var(--ab-fail) 40%,transparent);background:transparent}
.ab-btn.ab-small{padding:3px 8px;font-size:12px}
.ab-link{background:none;border:0;padding:0;color:var(--ab-accent);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ab-icon-btn{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--ab-line);background:transparent;cursor:pointer;color:var(--ab-muted);list-style:none}
.ab-icon-btn::-webkit-details-marker{display:none}.ab-icon-btn:hover{color:var(--ab-ink)}
.ab-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ab-between{justify-content:space-between}.ab-push{margin-left:auto}
.ab-eyebrow{display:flex;align-items:center;gap:7px;margin:0 0 8px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ab-muted);font-weight:600}
.ab-live{width:7px;height:7px;border-radius:50%;background:var(--ab-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ab-ok) 25%,transparent)}
.ab-side-label{margin:0 0 8px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ab-faint);font-weight:600}
.ab-panel h3{margin:0}.ab-panel{background:var(--ab-panel);border:1px solid var(--ab-line);border-radius:14px;padding:18px 20px}
.ab-banner{padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--ab-warn) 14%,transparent);color:var(--ab-warn)}
.ab-loading{padding:40px 0}
/* hero */
.ab-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,330px);gap:22px;padding:22px 24px;border:1px solid var(--ab-line);border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--ab-panel) 92%,var(--ab-fail)),var(--ab-panel));margin-bottom:18px}
.ab-headline{margin:0 0 8px;font-size:clamp(20px,2.4vw,28px);letter-spacing:-.02em;line-height:1.15;font-weight:700}.ab-headline .ab-dot{color:var(--ab-faint)}
.ab-kpis{margin:0 0 16px;color:var(--ab-muted)}.ab-kpis b{color:var(--ab-ink);font-weight:600}
.ab-bar{display:flex;gap:3px;height:8px;border-radius:6px;overflow:hidden;margin-bottom:12px;background:var(--ab-line)}.ab-bar i{display:block;min-width:6px}
.ab-legend{display:flex;flex-wrap:wrap;gap:6px 18px}
.ab-legend-item{display:inline-flex;align-items:center;gap:7px;background:none;border:0;padding:0;color:var(--ab-muted);cursor:pointer}.ab-legend-item i{width:9px;height:9px;border-radius:3px}.ab-legend-item b{color:var(--ab-ink)}
.ab-start{border:1px solid var(--ab-line);border-radius:12px;padding:14px 16px;background:var(--ab-panel)}.ab-start h3{margin:0 0 4px;font-size:15px}.ab-start p:not(.ab-eyebrow){margin:0 0 12px;color:var(--ab-muted)}
/* layout */
.ab-body{display:grid;grid-template-columns:232px minmax(0,1fr);gap:22px;align-items:start}.ab-main,.ab-hero-main,.ab-card-title,.ab-card-strip,.ab-detail-title{min-width:0}
#view-schedules .ab-side{top:16px}.ab-side,.ab-views{min-width:0;max-width:100%}
.ab-side{position:sticky;top:64px;display:flex;flex-direction:column;gap:16px}
.ab-search-wrap{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--ab-line);border-radius:9px;background:var(--ab-panel);color:var(--ab-muted)}
.ab .ab-search{flex:1;min-width:0;width:auto;height:auto;padding:0;border:0;border-radius:0;background:transparent;outline:none;font-size:13px}
.ab-views{display:flex;flex-direction:column;gap:2px}
.ab-view{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;border:1px solid transparent;background:none;cursor:pointer;color:var(--ab-muted);text-align:left}
.ab-view span:not(.ab-ico){flex:1}.ab-view em{font-style:normal;font-family:var(--mono,monospace);font-size:12px}
.ab-view:hover{background:var(--ab-panel);color:var(--ab-ink)}.ab-view.is-active{background:var(--ab-panel-2);border-color:var(--ab-line);color:var(--ab-ink);font-weight:600}
.ab-facet{border-top:1px solid var(--ab-line);padding:8px 2px}.ab-facet summary{cursor:pointer;font-weight:600;padding:2px 0 6px}
.ab-check{display:flex;align-items:center;gap:8px;padding:3px 0;color:var(--ab-muted);cursor:pointer;font-size:13px}.ab-check span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ab-check em{font-style:normal;font-size:12px;color:var(--ab-faint)}
.ab .ab-check input,.ab .ab-field input[type=checkbox]{appearance:auto;-webkit-appearance:checkbox;flex:none;width:14px;height:14px;min-width:0;min-height:0;margin:0;padding:0;border:0;background:none;box-shadow:none;accent-color:var(--ab-accent)}
.ab-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.ab-view-title{display:flex;align-items:center;gap:8px;margin:0 auto 0 0;font-size:14px;font-weight:600;color:var(--ab-muted)}
.ab-key{display:inline-flex;align-items:center;gap:2px;font-size:11.5px;color:var(--ab-faint)}.ab-key i{width:7px;height:7px;border-radius:2px;background:var(--ab-ok);display:inline-block}.ab-key i+i{margin-right:6px;opacity:.6}
.ab-seg{display:inline-flex;padding:2px;border:1px solid var(--ab-line);border-radius:8px}.ab-seg button{border:0;background:none;padding:4px 10px;border-radius:6px;cursor:pointer;color:var(--ab-muted)}.ab-seg .is-active{background:var(--ab-panel-2);color:var(--ab-ink);font-weight:600}
.ab-select{padding:6px 8px;border:1px solid var(--ab-line);border-radius:8px;background:var(--ab-panel)}
.ab-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
.ab-chip{display:inline-flex;gap:8px;align-items:center;padding:3px 10px;border-radius:999px;border:1px solid var(--ab-line);background:var(--ab-panel-2);cursor:pointer;font-size:12px}.ab-chip b{color:var(--ab-faint)}
/* groups and cards */
.ab-group{margin-bottom:22px}
.ab-group-head{display:flex;align-items:center;gap:10px;margin:0 0 10px;flex-wrap:wrap}.ab-group-head h3{margin:0;font-size:14px}
.ab-group-head em{font-style:normal;font-size:11.5px;padding:1px 7px;border-radius:6px;background:var(--ab-panel-2);color:var(--ab-muted)}
.ab-group-ico{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:color-mix(in srgb,currentColor 14%,transparent)}
.ab-group-copy{color:var(--ab-faint)}.ab-group-sum{margin-left:auto;color:var(--ab-muted);font-size:12px}
.ab-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:14px 18px 14px 20px;margin-bottom:10px;border:1px solid var(--ab-line);border-radius:14px;background:var(--ab-panel);cursor:pointer;transition:border-color .12s}
.ab-card:hover,.ab-card:focus-visible{border-color:color-mix(in srgb,var(--ab-ink) 25%,transparent)}
.ab-card::before,.ab-detail-head::before{content:"";position:absolute;left:-1px;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--edge,transparent)}
.ab-edge-fail{--edge:var(--ab-fail)}.ab-edge-warn{--edge:var(--ab-warn)}.ab-edge-idle{--edge:var(--ab-idle)}
.ab-card-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:14px;align-items:center}
.ab-kind{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;border:1px solid var(--ab-line);background:var(--ab-panel-2);color:var(--ab-muted)}.ab-kind-lg{width:44px;height:44px}
.ab-card-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}.ab-card-title h3{margin:0;font-size:14.5px;font-weight:650}
.ab-aside{color:var(--ab-muted);font-size:12px}
.ab-meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--ab-muted);font-size:12.5px;padding-left:48px}.ab-meta>span{display:inline-flex;align-items:center;gap:5px}.ab-meta b{color:var(--ab-ink);font-weight:500}
.ab-avatar{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--ab-accent);color:#fff;font-size:8.5px;font-style:normal;font-weight:700}
.ab-sudo{color:var(--ab-warn);font-weight:600}
.ab-card-foot{display:flex;align-items:center;gap:12px;padding-left:48px;flex-wrap:wrap}
.ab-problem,.ab-last{display:flex;align-items:center;gap:7px;margin:0;flex:1;min-width:220px}.ab-problem span:not(.ab-ico){color:var(--ab-ink);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ab-problem code{font-size:11px;padding:1px 6px;border-radius:5px;border:1px solid currentColor;opacity:.85;white-space:nowrap}
.ab-last{color:var(--ab-muted)}
.ab-card-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.ab-rate{text-align:right;min-width:72px}.ab-rate strong{display:block;font-size:18px;font-weight:700}.ab-rate span{font-size:11px;color:var(--ab-faint)}
/* run strip */
.ab-strip{display:flex;flex-direction:column;gap:3px}
.ab-strip-row{display:grid;grid-template-columns:repeat(30,8px);gap:3px}
.ab-strip-row i{height:8px;border-radius:2px;background:var(--ab-line)}
.ab-strip-big .ab-strip-row{grid-template-columns:repeat(30,minmax(6px,12px))}.ab-strip-big .ab-strip-row i{height:12px}
.ab-strip .c-ok{background:var(--ab-ok)}.ab-strip .c-noop{background:color-mix(in srgb,var(--ab-ok) 55%,transparent)}.ab-strip .c-fail{background:var(--ab-fail)}.ab-strip .c-warn{background:var(--ab-warn)}
.ab-strip .c-done{background:color-mix(in srgb,var(--ab-idle) 70%,transparent)}.ab-side-stack{display:grid;gap:16px;align-content:start}
.ab-strip .c-live{background:var(--ab-live)}.ab-strip .c-skip{background:color-mix(in srgb,var(--ab-idle) 45%,transparent)}.ab-strip .c-quiet{background:color-mix(in srgb,var(--ab-idle) 35%,transparent)}
.ab-strip .c-none{background:var(--ab-line)}.ab-strip .c-empty{background:color-mix(in srgb,var(--ab-line) 45%,transparent)}
.ab-strip-axis{display:flex;justify-content:space-between;font-family:var(--mono,monospace);font-size:10px;color:var(--ab-faint)}
/* switch and menu */
.ab-switch{position:relative;display:inline-block;width:34px;height:20px;flex:none}.ab-switch input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.ab-switch span{position:absolute;inset:0;border-radius:999px;background:var(--ab-line);transition:background .15s;pointer-events:none}
.ab-switch span::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
.ab-switch input:checked+span{background:var(--ab-ok)}.ab-switch input:checked+span::after{transform:translateX(14px)}
.ab-switch input:focus-visible+span{outline:2px solid var(--ab-accent);outline-offset:2px}.ab-switch input:disabled+span{opacity:.45}
.ab-menu{position:relative}.ab-menu-list{position:absolute;right:0;top:34px;z-index:20;min-width:180px;padding:5px;border:1px solid var(--ab-line);border-radius:10px;background:var(--ab-panel-2);box-shadow:0 12px 30px var(--shadow,rgba(0,0,0,.4))}
.ab-menu-list button{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:none;cursor:pointer;text-align:left}.ab-menu-list button:hover{background:var(--hover,rgba(238,242,238,.07))}
.ab-menu-list .ab-menu-danger{color:var(--ab-fail)}
/* empty */
.ab-empty{display:grid;justify-items:center;gap:6px;padding:48px 20px;border:1px dashed var(--ab-line);border-radius:14px;text-align:center;color:var(--ab-muted)}.ab-empty .ab-ico{width:26px;height:26px;color:var(--ab-ok)}.ab-empty h3{margin:4px 0 0;color:var(--ab-ink)}.ab-empty p{margin:0 0 6px;max-width:460px}
/* detail */
.ab-back{margin:0 0 14px;color:var(--ab-muted)}.ab-back:hover{color:var(--ab-ink)}
.ab-detail-head{position:relative;margin-bottom:16px}
.ab-detail-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:16px;align-items:start}
.ab-detail-title h2{margin:2px 0 8px;font-size:22px;letter-spacing:-.01em;display:flex;flex-wrap:wrap;align-items:center;gap:10px}.ab-detail-title .ab-meta{padding-left:0}
.ab-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.ab-toggle-label{display:inline-flex;align-items:center;gap:8px;margin-right:4px;color:var(--ab-muted)}
.ab-detail-summary{margin:14px 0 16px;font-size:14px}
.ab-stats{display:grid;grid-template-columns:minmax(260px,2fr) repeat(4,minmax(110px,1fr));border:1px solid var(--ab-line);border-radius:12px;overflow:hidden}
.ab-stat{padding:12px 16px;border-left:1px solid var(--ab-line);display:flex;flex-direction:column;gap:2px}.ab-stat:first-child{border-left:0}
.ab-stat strong{font-size:20px;font-weight:700}.ab-stat small{color:var(--ab-muted)}
.ab-tabs{display:flex;gap:4px;border-bottom:1px solid var(--ab-line);margin-bottom:16px}
.ab-tabs button{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;border:0;background:none;cursor:pointer;color:var(--ab-muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.ab-tabs .is-active{color:var(--ab-ink);border-color:var(--ab-accent);font-weight:600}.ab-tabs em{font-style:normal;font-size:11px;padding:0 6px;border-radius:5px;background:var(--ab-panel-2)}.ab-tabs em.ab-bg-fail,.ab-tabs em.ab-bg-warn{color:#fff}
.ab-overview{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:16px;align-items:start}
.ab-issue{border-color:color-mix(in srgb,var(--c,var(--ab-line)) 45%,var(--ab-line))}.ab-issue-fail{--c:var(--ab-fail)}.ab-issue-warn{--c:var(--ab-warn)}
.ab-issue-top{display:flex;justify-content:space-between;align-items:center}.ab-issue h3{margin:0 0 4px;font-size:17px}
.ab-issue-when{display:flex;gap:10px;align-items:center;color:var(--ab-muted);margin:0 0 10px;font-size:12.5px}.ab-issue-when code{font-size:11px;color:var(--ab-faint)}
.ab-issue-msg{margin:0 0 16px;padding-bottom:16px;border-bottom:1px solid var(--ab-line)}
.ab-steps{list-style:none;counter-reset:s;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.ab-steps li{counter-increment:s;position:relative;padding-left:40px;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.ab-steps li::before{content:counter(s);position:absolute;left:0;top:-2px;width:26px;height:26px;border-radius:50%;border:1px solid var(--ab-line);display:grid;place-items:center;font-size:12px;font-weight:600}
.ab-steps h4{margin:0;font-size:13.5px}.ab-steps p{margin:0;color:var(--ab-muted)}
.ab-copy{display:inline-flex;align-items:center;gap:8px;padding:4px 4px 4px 10px;border:1px solid var(--ab-line);border-radius:8px;background:var(--ab-panel-2)}
.ab-note{margin:14px 0 0;padding:8px 12px;border-radius:8px;background:var(--ab-panel-2);color:var(--ab-muted)}
.ab-facts h3{margin:0 0 10px;font-size:14px}.ab-facts dl,.ab-run-facts{margin:0;display:flex;flex-direction:column;gap:10px}
.ab-fact{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px}.ab-fact dt{color:var(--ab-faint)}.ab-fact dd{margin:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}.ab-fact code{font-size:11.5px;color:var(--ab-muted)}
.ab-clip{white-space:pre-wrap;color:var(--ab-muted)}
.ab-runs{list-style:none;margin:10px 0 0;padding:0}.ab-run{border-top:1px solid var(--ab-line)}
.ab-run-line{display:flex;align-items:center;gap:8px}.ab-run-line .ab-run-head{flex:1;min-width:0}
.ab-run-ack{display:inline-flex;align-items:center;gap:5px;color:var(--ab-ok);font-size:12px;font-weight:600;white-space:nowrap;padding-right:4px}.ab-run-ack .ab-link{font-weight:500;font-size:12px}
.ab-run-ack-btn{white-space:nowrap;flex:none}.ab-run.is-ack .ab-run-head .ab-pill{opacity:.55}
.ab-strip .is-ack{opacity:.35}
.ab-ack{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--ab-line)}.ab-ack h4{margin:0 0 2px;font-size:14px}.ab-ack p{margin:0;color:var(--ab-muted);font-size:13px;max-width:560px}
.ab-run-head{display:grid;grid-template-columns:120px 150px minmax(140px,1fr) 70px 80px 80px;gap:10px;align-items:center;width:100%;padding:10px 4px;border:0;background:none;cursor:pointer;text-align:left}
.ab-run-head:hover{background:var(--hover,rgba(238,242,238,.04))}.ab-run-when{color:var(--ab-ink)}.ab-run-trigger{color:var(--ab-faint);font-size:12px}
.ab-run-body{padding:4px 4px 16px 8px;display:flex;flex-direction:column;gap:10px}
.ab-run-error{margin:0;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--ab-fail) 12%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}
.ab-run-summary{margin:0;white-space:pre-wrap;color:var(--ab-muted)}
.ab-timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--ab-line);display:flex;flex-direction:column;gap:6px}
.ab-timeline li{position:relative;display:flex;gap:12px}.ab-timeline li::before{content:"";position:absolute;left:-19px;top:6px;width:8px;height:8px;border-radius:50%;background:var(--ab-idle)}
.ab-timeline li.is-bad::before{background:var(--ab-fail)}.ab-timeline li.is-good::before{background:var(--ab-ok)}.ab-timeline time{font-family:var(--mono,monospace);font-size:11.5px;color:var(--ab-faint)}
/* form */
.ab-form{display:flex;flex-direction:column;gap:14px;max-width:880px}
.ab-form-head{margin:8px 0 0;font-size:13px;color:var(--ab-muted);text-transform:uppercase;letter-spacing:.06em}
.ab-form-grid,.ab-timing{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.ab-field{display:flex;flex-direction:column;gap:5px}.ab-field>span{font-weight:600}.ab-field small{color:var(--ab-faint)}
.ab-field input[type=text],.ab-field input[type=time],.ab-field input[type=number],.ab-field input[type=datetime-local],.ab-field select,.ab-field textarea{padding:8px 10px;border:1px solid var(--ab-line);border-radius:8px;background:var(--ab-panel-2);width:100%}
.ab-field textarea{resize:vertical;line-height:1.5}
.ab-field.ab-inline{flex-direction:row;align-items:center;gap:9px}.ab-field.ab-inline>span{font-weight:400}
.ab-form-error{margin:0;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--ab-fail) 14%,transparent);color:var(--ab-fail)}
.ab-form-actions{padding-top:6px;border-top:1px solid var(--ab-line)}
/* roi */
.ab-roi-band{grid-column:1/-1;padding-top:16px;border-top:1px solid var(--ab-line);display:flex;flex-direction:column;gap:10px;min-width:0}
.ab-roi-band .ab-eyebrow,.ab-roi-band p{margin:0}.ab-roi-band .ab-link{text-decoration:none;font-size:12.5px}
.ab-roi-tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.ab-roi-tile{padding:10px 12px;border:1px solid var(--ab-line);border-radius:10px;background:var(--ab-panel-2);min-width:0}
.ab-roi-tile .ab-side-label{margin:0 0 4px}.ab-roi-tile strong{display:block;font-size:19px;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ab-roi-tile small{display:block;color:var(--ab-faint);font-size:11.5px}
.ab-roi-note{margin:0;font-size:12px}
.ab-roi-chip{color:var(--ab-ok)}
.ab-roi-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end;margin-top:12px;padding-top:12px;border-top:1px solid var(--ab-line)}
.ab-roi-form .ab-form-error{grid-column:1/-1}.ab-roi-edit .ab-roi-form{margin:0;padding:4px 0;border:0;max-width:640px}
.ab-roi-hero{grid-template-columns:minmax(0,1fr)}.ab-roi-hero .ab-hero-main{gap:14px;display:flex;flex-direction:column}.ab-roi-hero .ab-headline{margin:0}
.ab-roi-split{display:flex;flex-direction:column;gap:8px}.ab-roi-split .ab-side-label{margin:0}.ab-roi-split .ab-legend-item{cursor:default}
.ab-src-accent{background:var(--ab-accent)}.ab-src-live{background:var(--ab-live)}.ab-src-ok{background:var(--ab-ok)}
.ab-roi-toolbar{margin-bottom:14px}.ab-roi-toolbar .ab-view-title{margin-right:auto}
.ab-roi-default{display:flex;align-items:center;gap:8px}.ab-roi-default label{display:flex;align-items:center;gap:8px;color:var(--ab-muted)}
.ab-roi-money{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--ab-line);border-radius:8px;background:var(--ab-panel-2);color:var(--ab-ink)}
.ab-roi-money input{width:72px;border:0;background:transparent;outline:0;text-align:right;-moz-appearance:textfield}
.ab-roi-section{margin-top:14px;display:flex;flex-direction:column;gap:12px}.ab-roi-section h3{margin:0}.ab-roi-section p{margin:2px 0 0}
.ab-roi-sum{white-space:nowrap}.ab-roi-sum small{color:var(--ab-faint)}
.ab-roi-scroll{overflow-x:auto;margin:0 -4px}
.ab-roi-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;min-width:860px}
.ab-roi-table th,.ab-roi-table td{padding:8px 10px;text-align:left;border-top:1px solid var(--ab-line);vertical-align:middle;white-space:nowrap}
.ab-roi-table thead th{border-top:0;color:var(--ab-faint);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.ab-roi-table tbody th{font-weight:600;white-space:normal;min-width:180px}.ab-roi-table tbody th small{color:var(--ab-faint);font-weight:400}
.ab-roi-table .ab-num{text-align:right}.ab-roi-table tr.is-unset td{color:var(--ab-faint)}
.ab-roi-name{color:inherit;text-decoration:none}a.ab-roi-name:hover{text-decoration:underline}
.ab-roi-act{text-align:right}.ab-roi-edit td{background:var(--ab-panel-2)}
@media (max-width:1100px){.ab-roi-tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:520px){.ab-roi-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.ab-roi-toolbar{flex-wrap:wrap}}
/* modal, toast */
.ab-modal{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.5)}
.ab-modal-card{width:min(460px,100%);padding:20px;border-radius:14px;border:1px solid var(--ab-line);background:var(--ab-panel)}.ab-modal-card h3{margin:0 0 8px}.ab-modal-card p{margin:0 0 18px;color:var(--ab-muted)}
.ab-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.ab-toasts{position:fixed;right:20px;bottom:20px;z-index:70;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 40px))}
.ab-toast{padding:10px 14px;border-radius:10px;border:1px solid var(--ab-line);background:var(--ab-panel-2);box-shadow:0 10px 28px var(--shadow,rgba(0,0,0,.4))}.ab-toast.ab-ok{border-color:color-mix(in srgb,var(--ab-ok) 50%,transparent)}.ab-toast.ab-fail{border-color:color-mix(in srgb,var(--ab-fail) 55%,transparent);color:var(--ab-fail)}
/* responsive */
@media (max-width:1100px){.ab-hero{grid-template-columns:minmax(0,1fr)}.ab-stats{grid-template-columns:repeat(2,1fr)}.ab-stat-strip{grid-column:1/-1}.ab-stat{border-left:0;border-top:1px solid var(--ab-line)}.ab-stat:first-child{border-top:0}.ab-overview{grid-template-columns:1fr}}
@media (max-width:860px){.ab-page{padding:16px 12px 40px}.ab-body{grid-template-columns:minmax(0,1fr)}.ab-eyebrow{flex-wrap:wrap}.ab-card{padding:12px 12px 12px 14px}.ab-rate{min-width:0}.ab-key{display:none}.ab-overview{grid-template-columns:minmax(0,1fr)}.ab-stats{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.ab-side{position:static}.ab-views{flex-direction:row;overflow-x:auto}.ab-views>.ab-side-label{display:none}.ab-view{flex:none}.ab-filters{display:none}
  .ab-card-head{grid-template-columns:auto minmax(0,1fr) auto}.ab-card-strip{grid-column:1/-1;grid-row:2;overflow:hidden}.ab-meta,.ab-card-foot{padding-left:0}.ab-detail-top{grid-template-columns:auto minmax(0,1fr)}.ab-detail-actions{grid-column:1/-1;justify-content:flex-start}
  .ab-run-head{grid-template-columns:auto auto 1fr}.ab-run-head .ab-mono,.ab-run-trigger{display:none}
  .ab-run-line{flex-wrap:wrap;gap:0}.ab-run-line .ab-run-head{flex-basis:100%}.ab-run-ack,.ab-run-ack-btn{margin:-4px 0 10px 4px}}
@media (max-width:520px){.ab-strip-row{grid-template-columns:repeat(30,minmax(2px,7px));gap:2px}.ab-hero{padding:16px}.ab-headline{font-size:20px}.ab-card-head{gap:10px;grid-template-columns:minmax(0,1fr) auto}.ab-card-head>.ab-kind{display:none}.ab-rate span{font-size:10px}.ab-card-actions{margin-left:0;width:100%}.ab-card-actions .ab-primary{flex:1;justify-content:center}.ab-toolbar .ab-select{flex:1}}
`;

// The admin console loads the same component as a module (src/web/app.js serves this text).
export function automationBoardModuleSource() {
  return `export const automationBoardBrowser = ${automationBoardBrowser.toString()};\nexport const AUTOMATION_BOARD_CSS = ${JSON.stringify(AUTOMATION_BOARD_CSS)};\nexport const AUTOMATION_BOARD_HTML = ${JSON.stringify(AUTOMATION_BOARD_HTML)};\nexport const AUTOMATION_ROI_HTML = ${JSON.stringify(AUTOMATION_ROI_HTML)};\n`;
}
