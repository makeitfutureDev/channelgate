// Read-only connection inventory shared by the user drawer and channel Connections page.
import { api } from "./admin-api.js";
import { escapeHtml } from "./admin-view.js";

const SOURCES = {
  user: "Personal connections · composio-user",
  channel: "Channel connections · composio-agent",
  org: "Organization default · composio-agent",
  "sdk-user": "Personal connections · composio-user · SDK",
  "sdk-channel": "Channel connections · composio-agent · SDK",
  "none-dm": "Direct message · personal connections only",
  "none-no-org-default": "Organization defaults disabled",
};

export function composioInventoryMarkup(result) {
  const accounts = Array.isArray(result.accounts) ? result.accounts : [];
  const rows = accounts.map((account) => {
    const label = account.alias || account.account || account.id || "Account label unavailable";
    const details = [account.alias && account.account ? account.account : "", account.id, account.accountType].filter(Boolean);
    return `<tr><td>${escapeHtml(account.app || "Unknown app")}</td><td><strong>${escapeHtml(label)}</strong>${account.isDefault ? " <small>· default</small>" : ""}${details.length ? `<br><small>${details.map(escapeHtml).join(" · ")}</small>` : ""}</td><td>${escapeHtml(account.status || "UNKNOWN")}</td></tr>`;
  }).join("");
  const count = `${new Set(accounts.map((account) => account.app)).size} apps · ${accounts.length} accounts`;
  const stamp = result.checkedAt ? new Date(result.checkedAt) : null;
  const checked = stamp && Number.isFinite(stamp.getTime()) ? ` · Checked ${stamp.toLocaleTimeString()}` : "";
  const source = SOURCES[result.source] || "Composio connections";
  return `<p class="desc">${escapeHtml(source)}</p>
    <p class="state">${escapeHtml(result.message || "")}</p>
    ${accounts.length ? `<p class="state">${escapeHtml(count + checked)}</p><div class="composio-table-wrap"><table class="composio-table"><thead><tr><th scope="col">Application</th><th scope="col">Account</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : result.state === "ready" ? "<p class=\"state\">No accounts reported by Composio.</p>" : ""}
    ${result.mode === "personal" ? "<p class=\"hint\">Shows the apps and accounts Composio publishes for this key. Inactive or unpublished connections may not appear.</p>" : ""}`;
}

export function mountComposioInventory(root, endpoint, { request = api, autoLoad = true } = {}) {
  root.innerHTML = `<div class="card-foot"><h4>Connected Composio apps</h4><button type="button" class="ghost composio-refresh">Refresh connections</button></div><div class="composio-inventory-result" role="status" aria-live="polite"><p class="state">Open this section to load connections.</p></div>`;
  const button = root.querySelector(".composio-refresh");
  const output = root.querySelector(".composio-inventory-result");
  let loading = false;
  let loaded = false;
  let refreshPending = false;
  const load = async (refresh = false) => {
    if (loading) {
      // Saving a new key while the previous lookup runs must not leave the old inventory shown.
      if (refresh) refreshPending = true;
      return;
    }
    if (loaded && !refresh) return;
    loading = true;
    button.disabled = true;
    output.textContent = "Loading Composio apps and accounts…";
    try {
      const result = await request(endpoint + (refresh ? "?refresh=1" : ""));
      if (!refreshPending) {
        output.innerHTML = composioInventoryMarkup(result);
        loaded = true;
      }
    } catch {
      if (!refreshPending) output.textContent = "Could not load Composio connections. Try Refresh connections.";
    } finally {
      loading = false;
      button.disabled = false;
      if (refreshPending) {
        refreshPending = false;
        void load(true);
      }
    }
  };
  button.addEventListener("click", () => load(true));
  if (autoLoad) void load();
  return load;
}
