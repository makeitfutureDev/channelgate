// Pure Block Kit view of the public, read-only inventory. Account metadata is always plain text:
// provider aliases and owner names must never become Slack mentions, links, or formatting.
export const COMPOSIO_INVENTORY_ACTION_ID = "cg_channel_settings_composio_inventory";
export const COMPOSIO_INVENTORY_PAGE_SIZE = 6;

const SOURCE_LABELS = Object.freeze({
  user: "Personal connections",
  channel: "Channel connections",
  org: "Organization connections",
  "sdk-user": "Personal connections · organization Composio SDK",
  "sdk-channel": "Channel connections · organization Composio SDK",
  "none-dm": "Direct message · personal connections only",
  "none-no-org-default": "Organization fallback disabled",
  none: "No connection configured",
});

function boundedText(value, limit) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function plain(text, limit = 3000) {
  return { type: "plain_text", text: text.length > limit ? `${text.slice(0, limit - 1)}…` : text, emoji: false };
}

export function normalizeComposioInventoryPage(page, accountCount) {
  const count = Number.isFinite(accountCount) ? Math.max(0, Math.floor(accountCount)) : 0;
  const last = Math.max(0, Math.ceil(count / COMPOSIO_INVENTORY_PAGE_SIZE) - 1);
  const numeric = typeof page === "number" || typeof page === "string" ? Number(page) : NaN;
  return Number.isFinite(numeric) ? Math.max(0, Math.min(last, Math.floor(numeric))) : 0;
}

function accountText(account) {
  const app = boundedText(account?.app, 256) || "Unknown application";
  const alias = boundedText(account?.alias, 512);
  const owner = boundedText(account?.account, 512);
  const id = boundedText(account?.id, 512);
  const status = boundedText(account?.status, 80) || "Unknown status";
  const accountType = boundedText(account?.accountType, 80);
  const identity = [alias, owner && owner !== alias ? owner : ""].filter(Boolean).join(" · ") || id || "Account identity unavailable";
  return `${app} — ${identity}\n${[status, account?.isDefault === true ? "Default" : "", accountType].filter(Boolean).join(" · ")}`;
}

function defaultCommand(operation, extra = {}) {
  return JSON.stringify({ o: operation, ...extra });
}

export function composioInventoryBlocks(inventory, { page = 0, command = defaultCommand } = {}) {
  const loading = inventory == null;
  const state = loading ? "loading" : inventory.state;
  const accounts = Array.isArray(inventory?.accounts) ? inventory.accounts : [];
  const current = normalizeComposioInventoryPage(page, accounts.length);
  const pages = Math.max(1, Math.ceil(accounts.length / COMPOSIO_INVENTORY_PAGE_SIZE));
  const apps = new Set(accounts.map((account) => boundedText(account?.app, 256) || "Unknown application")).size;
  const source = Object.hasOwn(SOURCE_LABELS, inventory?.source) ? SOURCE_LABELS[inventory.source] : "Connection source unavailable";
  const count = `${apps} ${apps === 1 ? "application" : "applications"} · ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
  const summary = loading ? "*Connected apps and accounts*\nLoading connections…" : `*Connected apps and accounts*\n${count}\n${source}`;
  const button = (label, operation, extra) => ({
    type: "button", text: plain(label, 75), action_id: COMPOSIO_INVENTORY_ACTION_ID,
    value: command(operation, extra),
  });
  const blocks = [{
    type: "section", text: { type: "mrkdwn", text: summary },
    accessory: button("Refresh", "composio_refresh"),
  }];

  for (const account of accounts.slice(current * COMPOSIO_INVENTORY_PAGE_SIZE, (current + 1) * COMPOSIO_INVENTORY_PAGE_SIZE)) {
    blocks.push({ type: "section", text: plain(accountText(account)) });
  }

  const notices = [];
  if (state === "loading") notices.push("Loading the applications and accounts reported by Composio.");
  else if (state === "partial") notices.push("Some connections could not be loaded. This list is incomplete.");
  else if (state === "unconfigured") notices.push("No Composio connection is configured for this identity.");
  else if (state !== "ready") notices.push("Connections could not be loaded. Try Refresh.");
  else if (!accounts.length) notices.push("Composio reported no connected accounts.");
  const message = boundedText(inventory?.message, 1000);
  if (message && state !== "ready") notices.push(message);
  if (inventory?.mode === "personal") notices.push("Composio may omit inactive or unpublished connections.");
  if (accounts.length) {
    const first = current * COMPOSIO_INVENTORY_PAGE_SIZE + 1;
    const last = Math.min(accounts.length, first + COMPOSIO_INVENTORY_PAGE_SIZE - 1);
    notices.push(`Accounts ${first}–${last} of ${accounts.length} · Page ${current + 1} of ${pages}`);
  }
  if (notices.length) blocks.push({ type: "context", elements: [plain(notices.join("\n"), 2000)] });

  // Slack requires action_id uniqueness inside a block. Keep each navigation button in its own
  // small actions block so every control can share the controller's inventory action id.
  if (current > 0) blocks.push({ type: "actions", elements: [button("Previous accounts", "composio_page", { page: current - 1 })] });
  if (current + 1 < pages) blocks.push({ type: "actions", elements: [button("Next accounts", "composio_page", { page: current + 1 })] });
  return blocks;
}
