import { api } from "./admin-api.js";
import { escapeHtml as esc } from "./admin-view.js";

const stamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not yet checked";
export function subscriptionReset(value, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Reset time unavailable";
  const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return "Reset time passed · awaiting provider update";
  const duration = minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  return `Resets in ${duration} · ${stamp(value)}`;
}

export function subscriptionCard(subscription) {
  const labels = { ok: "Connected", expired: "Login expired", "not-connected": "Not connected", "api-key": "API billing", unavailable: "Usage unavailable" };
  const status = Object.hasOwn(labels, subscription.status) ? subscription.status : "unavailable";
  const windows = (subscription.windows || []).map((window) => {
    const used = window.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return "";
    const severity = used >= 90 ? "critical" : used >= 75 ? "warning" : "normal";
    const formatted = used.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `<div class="subscription-window ${severity}">
      <div class="subscription-window-head"><span>${esc(window.label)}</span><strong>${esc(formatted)}% used</strong></div>
      <progress max="100" value="${used}" aria-label="${esc(window.label)} usage">${esc(formatted)}%</progress>
      <div class="subscription-window-foot"><span>${esc((100 - used).toLocaleString(undefined, { maximumFractionDigits: 1 }))}% remaining</span><span>${esc(subscriptionReset(window.resetsAt))}</span></div>
    </div>`;
  }).join("");
  return `<article class="subscription-card">
    <div class="subscription-card-head"><div><h3>${esc(subscription.name)}</h3><p class="hint">${esc(subscription.plan || "Subscription plan unavailable")}</p></div><span class="subscription-status ${status}">${subscription.stale ? "Stale data" : labels[status]}</span></div>
    ${subscription.message ? `<p class="status-banner${status === "expired" ? " bad" : ""}">${esc(subscription.message)}</p>` : ""}
    ${subscription.stale ? `<p class="hint">Showing the last successful provider reading. These limits may have changed.</p>` : ""}
    ${windows || `<p class="hint">No subscription usage data available.</p>`}
    <p class="subscription-updated">Last successful reading: ${esc(stamp(subscription.updatedAt))}<br>Last check: ${esc(stamp(subscription.checkedAt))}</p>
  </article>`;
}

// Poll only on the visible page; ignore late responses after leaving or hiding it.
export function createSubscriptionPoller({ request = api, render, visible = () => !document.hidden, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let active = false, timer = null, pending = false, generation = 0, loading = false;
  let data = null, error = "";
  const paint = () => render({ data, error, loading });
  const clear = () => { if (timer !== null) unschedule(timer); timer = null; };
  async function refresh() {
    clear();
    if (!active || !visible() || pending) return;
    const turn = generation;
    pending = true; loading = true; error = ""; paint();
    try {
      const result = await request("/api/subscriptions");
      if (turn === generation && active) data = result;
    } catch {
      if (turn === generation && active) error = data ? "Could not refresh subscription usage. Showing the previous reading; limits may have changed." : "Could not load subscription usage. Try again.";
    } finally {
      pending = false;
      if (active && visible()) {
        if (turn !== generation) void refresh();
        else { loading = false; paint(); timer = schedule(refresh, 300_000); }
      }
    }
  }
  return {
    enter() { if (active) return; active = true; generation += 1; data = null; error = ""; loading = true; paint(); void refresh(); },
    leave() { active = false; generation += 1; clear(); },
    refresh,
    visibilityChanged() { if (!visible()) { generation += 1; clear(); } else void refresh(); },
  };
}

let controller;
export function setSubscriptionsActive(active) {
  if (!controller && active) {
    const root = document.getElementById("view-subscriptions");
    root.innerHTML = `<div class="view-head dash-head"><div><h2>Subscriptions</h2><p class="hint">Live plan limits for the Claude and Codex logins used by this gateway.</p></div><button type="button" class="ghost" id="subscriptions-refresh">Refresh</button></div>
      <p class="hint">Includes usage across each provider account, including activity outside ChannelGate. Updates every 5 minutes while this page is visible.</p>
      <div id="subscriptions-notice" role="status" aria-live="polite"></div><div id="subscriptions-cards" class="subscription-grid"></div>
      <p class="hint">Provider limits are separate from the token counts and estimated API costs on <a href="/overview">Overview</a>. Providers may change these usage endpoints.</p>`;
    const button = root.querySelector("#subscriptions-refresh");
    controller = createSubscriptionPoller({ render({ data, error, loading }) {
      button.disabled = loading;
      button.textContent = loading ? "Refreshing…" : "Refresh";
      root.querySelector("#subscriptions-notice").textContent = error || (loading ? "Checking subscription usage…" : "");
      const cards = root.querySelector("#subscriptions-cards");
      cards.setAttribute("aria-busy", String(loading));
      cards.innerHTML = data ? data.subscriptions.map(subscriptionCard).join("") : "";
    } });
    button.addEventListener("click", () => void controller.refresh());
    document.addEventListener("visibilitychange", () => controller.visibilityChanged());
  }
  if (active) controller?.enter();
  else controller?.leave();
}
