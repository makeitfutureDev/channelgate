import { api } from "./admin-api.js";
import { createSubscriptionUi, SUBSCRIPTION_CSS } from "./subscription-ui.js";
const subscriptionUi = createSubscriptionUi();
export const subscriptionReset = subscriptionUi.reset;
export const subscriptionCard = subscriptionUi.card;

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
    } catch (failure) {
      if (turn === generation && active && (failure?.status === 401 || failure?.status === 403)) data = null;
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
    const style = document.createElement("style");
    style.textContent = SUBSCRIPTION_CSS;
    root.innerHTML = `<div class="view-head dash-head"><div><h2>Subscriptions</h2><p class="hint">Usage and resets for every enabled harness.</p></div><button type="button" class="ghost" id="subscriptions-refresh">Refresh</button></div>
      <p class="hint">Account-wide usage · refreshes every 5 minutes.</p>
      <div id="subscriptions-notice" role="status" aria-live="polite"></div><div id="subscriptions-cards" class="subscription-grid"></div>
`;
    root.append(style);
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
