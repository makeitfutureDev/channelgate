// Read-only account metadata for the admin UI. Never creates SDK sessions, connected accounts,
// or authorization links. Consumer SEARCH session IDs correlate read-only discovery requests.
import { Composio } from "@composio/core";
import { getComposioMode, getComposioSdkApiKey, getDefaultComposioToken } from "../config/settings.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { composioIdentity } from "../ee/composio-sessions.js";
import { connectRemoteClient } from "../mcp/remote-relay.js";
import { publicPinnedFetch } from "../mcp/public-fetch.js";
import { composioUrl } from "./mcp-catalog.js";
import { resolveComposioConnections } from "./run-integrations.js";

const MAX_PAGES = 50;
const MAX_APPS = 200;
const MAX_ACCOUNTS = 10_000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FAILURE = "Composio connections could not be loaded. Try refreshing.";

function text(value, limit = 256) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit).trim() : "";
}

function safeAccount(app, value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id);
  if (!id) return null;
  // user_info may contain arbitrary business records. Only these scalar identity fields escape.
  const info = value.user_info;
  const account = text(value.state?.val?.displayName) ||
    text(info?.email) || text(info?.emailAddress) || text(info?.user?.emailAddress) ||
    text(info?.name) || text(info?.displayName) || text(info?.user?.displayName);
  return {
    app,
    id,
    alias: text(value.alias),
    account,
    status: value.isDisabled === true || value.is_disabled === true ? "DISABLED" : text(value.status, 40) || "UNKNOWN",
    isDefault: value.is_default === true || value.isDefault === true,
    accountType: text(value.account_type ?? value.experimental?.accountType ?? value.experimental?.account_type, 40),
  };
}

function addAccounts(target, app, values) {
  if (!Array.isArray(values)) throw new Error("invalid accounts");
  for (const value of values) {
    const account = safeAccount(app, value);
    if (!account) throw new Error("invalid account");
    target.set(`${app}\0${account.id}`, account);
    if (target.size > MAX_ACCOUNTS) throw new Error("account limit");
  }
}

async function bounded(work, timeoutMs, onLate) {
  const controller = new AbortController();
  let timer;
  let expired = false;
  const pending = Promise.resolve().then(() => work(controller.signal)).then((value) => {
    if (expired) onLate?.(value);
    return value;
  });
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new Error("inventory timeout"));
      }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function publishedApps(description) {
  const match = String(description || "").match(/User has manually connected the apps:\s*([^\n]*?)\.\s*Prefer these apps/i);
  if (!match) return null;
  const slugs = match[1].split(",").map((s) => s.trim());
  if (slugs.length === 1 && !slugs[0]) return [];
  if (slugs.length > MAX_APPS || slugs.some((slug) => !SLUG.test(slug))) return null;
  return [...new Set(slugs)];
}

function searchPayload(response) {
  // MCP servers can return JSON text, structuredContent, or nested data envelopes.
  const queue = [response];
  for (let i = 0; i < queue.length && i < 30; i++) {
    const item = queue[i];
    if (!item || typeof item !== "object") continue;
    if (item.isError === true || item.successful === false || item.success === false) throw new Error("search failed");
    if (Array.isArray(item.toolkit_connection_statuses)) return item.toolkit_connection_statuses;
    for (const key of ["structuredContent", "data", "result", "response"]) if (item[key]) queue.push(item[key]);
    for (const block of item.content || []) {
      if (block.type === "text") {
        try { queue.push(JSON.parse(block.text)); } catch { /* Other text is not inventory. */ }
      }
    }
  }
  throw new Error("missing inventory");
}

async function personalAccounts({ token, url, connect, timeoutMs, totalTimeoutMs }) {
  let client;
  const accounts = new Map();
  const deadline = Date.now() + totalTimeoutMs;
  let deadlineExpired = false;
  const request = (work, onLate) => {
    const remaining = deadline - Date.now();
    if (deadlineExpired || remaining <= 0) throw new Error("inventory deadline");
    return bounded(work, Math.min(timeoutMs, remaining), onLate).catch((error) => {
      if (remaining <= timeoutMs && error.message === "inventory timeout") deadlineExpired = true;
      throw error;
    });
  };
  try {
    client = await request((signal) => connect({ url, headers: { "x-consumer-api-key": token }, publicOnly: true, retryDelaysMs: [],
      // The transport's own signal and the connect deadline both abort the pinned HTTPS dial.
      fetch: (input, init = {}) => publicPinnedFetch(input, {
        ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
    }),
      (late) => Promise.resolve(late.close()).catch(() => {}));
    let cursor;
    let searchTool;
    const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error("tool page limit");
      const response = await request((signal) => client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs }));
      if (!Array.isArray(response?.tools)) throw new Error("invalid tool list");
      searchTool ||= response.tools.find((tool) => tool.name === "COMPOSIO_SEARCH_TOOLS");
      cursor = response.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("repeated tool cursor");
      seen.add(cursor);
    }
    const apps = searchTool && publishedApps(searchTool.description);
    if (!apps) return { state: "unavailable", message: "Composio does not publish a connected application list for this connection.", accounts: [] };
    let unresolved = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, apps.length) }, async () => {
      while (next < apps.length) {
        const app = apps[next++];
        try {
          const response = await request((signal) => client.callTool({
            name: "COMPOSIO_SEARCH_TOOLS",
            arguments: { queries: [{ use_case: `Inspect ${app} connected account status and aliases` }], search_strategy: "tool_search", session: { generate_id: true } },
          }, undefined, { signal, timeout: timeoutMs }));
          const statuses = searchPayload(response);
          const status = statuses.find((entry) => entry?.toolkit === app);
          if (!status || !Array.isArray(status.accounts) || !status.accounts.length) throw new Error("unresolved app");
          addAccounts(accounts, app, status.accounts);
        } catch { unresolved++; }
      }
    }));
    return {
      state: unresolved ? "partial" : "ready",
      message: unresolved
        ? "Some application accounts could not be loaded. Showing the accounts Composio reported."
        : "Applications and accounts reported by Composio. Inactive or unpublished connections may be omitted.",
      accounts: [...accounts.values()],
    };
  } finally {
    if (client) await bounded(() => client.close(), Math.min(timeoutMs, 2_000)).catch(() => {});
  }
}

async function sdkAccounts({ kind, id, config, sdkClient, timeoutMs, totalTimeoutMs }) {
  const identity = composioIdentity({ workspaceId: config.workspaceId, kind, id });
  const client = sdkClient || new Composio({
    apiKey: config.sdkApiKey, userApiKey: null, orgApiKey: null, allowTracking: false,
  });
  const accounts = new Map();
  const seen = new Set();
  const deadline = Date.now() + totalTimeoutMs;
  let cursor;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error("account page limit");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("inventory deadline");
    const result = await bounded((signal) => client.connectedAccounts.list({
      userIds: [identity], accountType: "ALL", limit: 100, ...(cursor ? { cursor } : {}),
    }, { signal }), Math.min(timeoutMs, remaining));
    if (!Array.isArray(result?.items)) throw new Error("invalid accounts");
    for (const item of result.items) {
      // Some SDK versions omit the owner field. If present, it must match our exact filter.
      for (const field of ["userId", "user_id"]) {
        if (item && Object.hasOwn(item, field) && item[field] !== identity) throw new Error("account identity mismatch");
      }
      const app = item?.toolkit?.slug;
      if (typeof app !== "string" || !SLUG.test(app)) throw new Error("invalid app");
      addAccounts(accounts, app, [item]);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
    if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("repeated account cursor");
    seen.add(cursor);
  }
  return { state: "ready", message: "Connected accounts for this Composio identity.", accounts: [...accounts.values()] };
}

/** Configuration and network clients can be injected without touching gateway state in tests. */
export async function loadComposioInventory({ kind, id, record = {} } = {}, options = {}) {
  const config = options.config || {
    mode: getComposioMode(), defaultToken: getDefaultComposioToken(), sdkApiKey: getComposioSdkApiKey(),
    url: composioUrl(), workspaceId: process.env.CG_SLACK_TEAM_ID || "",
  };
  const mode = config.mode === "sdk" ? "sdk" : "personal";
  const checkedAt = new Date((options.now || Date.now)()).toISOString();
  const timeoutMs = Math.max(10, Math.min(30_000, options.timeoutMs || 15_000));
  const totalTimeoutMs = Math.max(10, Math.min(60_000, options.totalTimeoutMs || 60_000));
  const isDM = Boolean(record.isDM || record.type === "im");
  let source = mode === "sdk" ? `sdk-${kind}` : "none";
  const secrets = [...new Set([record.composioToken, config.sdkApiKey, config.defaultToken])]
    .filter((value) => typeof value === "string" && value.length);
  const scrub = (value) => {
    if (typeof value === "string") return secrets.reduce((safe, secret) => safe.split(secret).join("[redacted]"), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)]));
    return value;
  };
  const answer = (result) => scrub({ mode, source, ...result, checkedAt });
  try {
    if (!["user", "channel"].includes(kind)) throw new Error("invalid kind");
    if (kind === "channel" && isDM) {
      source = "none-dm";
      return answer({ state: "unconfigured", message: "Direct messages use the author's personal connections.", accounts: [] });
    }
    if (mode === "sdk") {
      try { await (options.requireEntitlement || requireComposioSdkEntitlement)(); }
      catch { return answer({ state: "unavailable", message: "Composio SDK connections require an active Enterprise license.", accounts: [] }); }
      if (!config.sdkApiKey) return answer({ state: "unconfigured", message: "The organization Composio SDK key is not configured.", accounts: [] });
      if (typeof config.workspaceId !== "string" || !config.workspaceId.trim()) {
        return answer({ state: "unavailable", message: "The Slack workspace identity required for Composio SDK connections is not available.", accounts: [] });
      }
      return answer(await sdkAccounts({ kind, id, config, sdkClient: options.sdkClient, timeoutMs, totalTimeoutMs }));
    }
    const resolved = resolveComposioConnections({
      clean: false, userToken: kind === "user" ? record.composioToken : "",
      channelToken: kind === "channel" ? record.composioToken : "", defaultToken: config.defaultToken,
      noOrg: Boolean(record.noDefaultTokens), isDM,
    });
    const selected = kind === "user" ? resolved.user : resolved.shared;
    source = selected.source;
    if (!selected.token) return answer({ state: "unconfigured", message: "No Composio connection is configured for this identity.", accounts: [] });
    return answer(await personalAccounts({ token: selected.token, url: config.url || composioUrl(),
      connect: options.connect || connectRemoteClient, timeoutMs, totalTimeoutMs }));
  } catch {
    return answer({ state: "unavailable", message: FAILURE, accounts: [] });
  }
}
