// Activity self-service connections. A browser supplies an app/alias, never a Composio
// owner, project key, session URL, auth-config ID, callback, or shared-account ACL.
import { Composio } from "@composio/core";
import { getComposioMode, getComposioSdkApiKey, getComposioSdkPolicy } from "../config/settings.js";
import { getUser } from "../config/store.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { composioIdentity } from "../ee/composio-sessions.js";
import { composioWorkspaceId } from "./composio-workspace.js";
import { resolveSdkSession } from "../ee/composio-sdk.js";
import { loadComposioInventory } from "./composio-inventory.js";
import { connectRemoteClient } from "../mcp/remote-relay.js";
import { publicPinnedFetch } from "../mcp/public-fetch.js";
import { composioUrl } from "./mcp-catalog.js";

const API = "https://backend.composio.dev/api/v3.1/toolkits";
const ACCOUNTS_API = "https://backend.composio.dev/api/v3.1/connected_accounts";
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CATALOG_PAGE_SIZE = 24;
const creating = new Set();
const deleting = new Set();
const clean = (v, max = 256) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
export class ActivityConnectionsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new ActivityConnectionsError(message, status); };
const currentConfig = () => ({ mode: getComposioMode(), sdkApiKey: getComposioSdkApiKey(), policy: getComposioSdkPolicy() });
const fingerprint = (config) => JSON.stringify([config.mode, config.sdkApiKey, config.policy]);
function sdkConfig(options) {
  const config = (options.getConfig || currentConfig)();
  if (config.mode !== "sdk") fail("Adding connections here requires Composio SDK mode. Manage personal-token apps in Composio.", 409);
  try { (options.requireEntitlement || requireComposioSdkEntitlement)(); }
  catch { fail("Composio SDK connections require an active Enterprise license.", 409); }
  if (!config.sdkApiKey) fail("The organization Composio SDK key is not configured.", 409);
  return config;
}
function checkCurrent(config, options) {
  if (fingerprint(config) !== fingerprint(sdkConfig(options))) fail("Connection settings changed. Refresh and try again.", 409);
}

export async function activityConnectionInventory({ ownerId, teamId }, options = {}) {
  const selected = (options.getConfig || currentConfig)();
  const record = await (options.getUser || getUser)(ownerId);
  const inventory = await (options.inventory || loadComposioInventory)({ kind: "user", id: ownerId, record }, {
    ...(options.inventoryOptions || {}),
    // The authenticated Activity session supplies the workspace, exactly as SDK runs do.
    ...(selected.mode === "sdk" ? { config: { mode: "sdk", sdkApiKey: selected.sdkApiKey, workspaceId: teamId } } : {}),
  });
  let config;
  try { config = sdkConfig(options); } catch { /* A read remains useful without SDK creation. */ }
  // Visibility is not ownership: SDK list() drops user_id in some versions, and shared
  // accounts may be visible. Join a bounded raw PRIVATE-owner inventory before offering Delete.
  let owned = new Map();
  if (config && inventory.mode === "sdk" && inventory.accounts?.length) {
    try { owned = await ownedSdkAccounts(config, { ownerId, teamId }, options); checkCurrent(config, options); }
    catch { owned = new Map(); /* The read still works; an unverified account must never offer deletion. */ }
  } else if (inventory.mode === "personal" && record?.composioToken && inventory.accounts?.length) {
    try {
      await personalClient(record.composioToken, options, async () => {});
      const current = await (options.getUser || getUser)(ownerId);
      if ((options.getConfig || currentConfig)().mode === "personal" && current?.composioToken === record.composioToken) {
        for (const account of inventory.accounts) if (account.accountType === "PRIVATE") owned.set(account.id, account.app);
      }
    } catch { /* Consumer endpoints without exact-ID removal remain read-only. */ }
  }
  return { ...inventory, accounts: (inventory.accounts || []).map(account => ({ ...account,
    canDelete: owned.get(account.id) === account.app })),
    deleteMessage: inventory.mode === "personal"
      ? "Only your verified private accounts can be deleted. Other accounts can be managed in Composio."
      : "Only your verified private accounts can be deleted.",
    canAdd: Boolean(config) && inventory.mode === "sdk" && inventory.state === "ready",
    ...(config ? { policy: { multiAccount: config.policy.multiAccount, maxAccountsPerToolkit: config.policy.maxAccountsPerToolkit } } : {}) };
}

// A consumer credential selects its owner in the provider; never use the organization token.
// A PRIVATE account from that token-scoped API is owned by that consumer. The linked mailbox
// email is not the consumer identity and must not be used as an ownership check.
async function personalClient(token, options, work) {
  const controller = new AbortController();
  const timeout = Math.max(10, Math.min(20_000, options.timeoutMs || 20_000));
  let client, timer, expired = false;
  const pending = Promise.resolve().then(async () => {
    client = await (options.connect || connectRemoteClient)({ url: composioUrl(), headers: { "x-consumer-api-key": token }, publicOnly: true, retryDelaysMs: [],
      fetch: (input, init = {}) => publicPinnedFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }),
    });
    if (expired) { await client.close().catch(() => {}); throw new Error("consumer timeout"); }
    let cursor; const seen = new Set(); let manage, search;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal: controller.signal, timeout });
      controller.signal.throwIfAborted();
      if (!Array.isArray(result?.tools)) throw new Error("invalid consumer tools");
      manage ||= result.tools.find(tool => tool.name === "COMPOSIO_MANAGE_CONNECTIONS");
      search ||= result.tools.find(tool => tool.name === "COMPOSIO_SEARCH_TOOLS");
      cursor = result.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== "string" || seen.has(cursor) || page === 49) throw new Error("invalid tools cursor"); seen.add(cursor);
    }
    const fields = manage?.inputSchema?.properties?.toolkits?.items?.properties;
    if (!search || !fields?.action?.enum?.includes("remove") || !fields.action.enum.includes("list") || fields.account_id?.type !== "string") {
      fail("This Composio connection does not support account deletion here. Manage it in Composio.", 409);
    }
    controller.signal.throwIfAborted();
    return work((name, args) => { controller.signal.throwIfAborted(); return client.callTool({ name, arguments: args }, undefined, { signal: controller.signal, timeout }); });
  });
  try {
    return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error("consumer timeout")); }, timeout); })]);
  } finally { clearTimeout(timer); controller.abort(); if (client) await Promise.race([Promise.resolve(client.close()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 100))]); }
}
function consumerPayload(response, accepts = value => value.results && typeof value.results === "object") {
  const queue = [response];
  for (let i = 0; i < queue.length && i < 30; i++) {
    const value = queue[i]; if (!value || typeof value !== "object") continue;
    if (value.isError === true || value.successful === false || value.success === false) throw new Error("consumer request failed");
    if (accepts(value)) return value;
    for (const key of ["structuredContent", "data", "result", "response"]) if (value[key]) queue.push(value[key]);
    for (const block of value.content || []) if (block.type === "text" && typeof block.text === "string" && block.text.length <= 2_000_000) {
      try { queue.push(JSON.parse(block.text)); } catch { /* Non-JSON tool text is not proof. */ }
    }
  }
  throw new Error("missing consumer result");
}
async function deletePersonalConnection({ ownerId, connectionId, authorize }, options) {
  const deadline = Date.now() + Math.max(10, Math.min(20_000, options.timeoutMs || 20_000));
  const record = await (options.getUser || getUser)(ownerId), token = record?.composioToken;
  if (!token) fail("No personal Composio connection is configured.", 409);
  const check = async () => {
    await authorize();
    const current = await (options.getUser || getUser)(ownerId);
    if ((options.getConfig || currentConfig)().mode !== "personal" || current?.composioToken !== token) fail("Connection settings changed. Refresh and try again.", 409);
  };
  await check();
  const inventory = await (options.inventory || loadComposioInventory)({ kind: "user", id: ownerId, record }, {
    ...options.inventoryOptions, timeoutMs: Math.max(10, deadline - Date.now()), totalTimeoutMs: Math.max(10, deadline - Date.now()),
  });
  if (Date.now() >= deadline) throw new Error("consumer timeout");
  const matches = (inventory.accounts || []).filter(account => account.id === connectionId && account.accountType === "PRIVATE" && SLUG.test(account.app));
  if (inventory.mode !== "personal" || !["ready", "partial"].includes(inventory.state) || matches.length !== 1) fail("This connection is unavailable or is not your private account.", 404);
  const app = matches[0].app;
  return personalClient(token, { ...options, timeoutMs: deadline - Date.now() }, async call => {
    await check();
    const search = consumerPayload(await call("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: `Inspect ${app} connected account status and aliases` }], search_strategy: "tool_search", session: { generate_id: true } }), value => typeof value.session?.id === "string");
    const sessionId = search.session.id;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new Error("invalid consumer session");
    const listed = consumerPayload(await call("COMPOSIO_MANAGE_CONNECTIONS", { session_id: sessionId, toolkits: [{ name: app, action: "list" }] }));
    const result = listed.results[app];
    const own = result?.accounts?.filter(account => account.id === connectionId && account.account_type === "PRIVATE");
    if (result?.toolkit !== app || !Array.isArray(own) || own.length !== 1) fail("This connection is unavailable or is not your private account.", 404);
    await check();
    const removed = consumerPayload(await call("COMPOSIO_MANAGE_CONNECTIONS", { session_id: sessionId, toolkits: [{ name: app, action: "remove", account_id: connectionId }] }));
    const outcome = removed.results[app];
    if (outcome?.toolkit !== app || outcome.error || ["failed", "error"].includes(outcome.status)) throw new Error("consumer deletion failed");
    await check();
    // Provider remove statuses vary. Confirm the exact ID disappeared from the same token's
    // fresh account list instead of inferring success from a message or alias.
    const confirmed = consumerPayload(await call("COMPOSIO_MANAGE_CONNECTIONS", { session_id: sessionId, toolkits: [{ name: app, action: "list" }] })).results[app];
    if (confirmed?.toolkit !== app || !Array.isArray(confirmed.accounts) || confirmed.accounts.some(account => account.id === connectionId)) throw new Error("consumer deletion not confirmed");
    await check();
    return { deleted: true };
  });
}

async function accountRequest(config, path, init, options, signal) {
  const response = await (options.fetch || globalThis.fetch)(path, {
    ...init, redirect: "error", signal, headers: { "x-api-key": config.sdkApiKey },
  });
  if (response.status === 404) fail("This connection is unavailable or is not your private account.", 404);
  if (!response.ok) throw new Error("account request failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing account response");
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > 2_000_000) throw new Error("account response too large"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const privateOwner = (account, identity) => account?.user_id === identity
  && account?.experimental?.account_type === "PRIVATE";
async function ownedSdkAccounts(config, { ownerId, teamId }, options) {
  const identity = composioIdentity({ workspaceId: composioWorkspaceId({ kind: "user", id: ownerId, slackTeamId: teamId }), kind: "user", id: ownerId });
  const signal = AbortSignal.timeout(Math.max(10, Math.min(20_000, options.timeoutMs || 20_000)));
  const owned = new Map(), seen = new Set(); let cursor = "";
  for (let page = 0; page < 50; page++) {
    const url = new URL(ACCOUNTS_API);
    url.searchParams.set("user_ids", identity); url.searchParams.set("account_type", "PRIVATE"); url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const result = await accountRequest(config, url, {}, options, signal);
    if (!Array.isArray(result?.items) || result.items.length > 200) throw new Error("invalid account page");
    for (const item of result.items) {
      if (privateOwner(item, identity) && typeof item.id === "string" && ACCOUNT_ID.test(item.id)
        && typeof item.toolkit?.slug === "string" && SLUG.test(item.toolkit.slug)) owned.set(item.id, item.toolkit.slug);
      if (owned.size > 10_000) throw new Error("account limit");
    }
    cursor = result.next_cursor;
    if (!cursor) return owned;
    if (typeof cursor !== "string" || cursor.length > 2048 || seen.has(cursor)) throw new Error("invalid account cursor");
    seen.add(cursor);
  }
  throw new Error("account page limit");
}

/** Deletes only a current user's verified PRIVATE account; never a visible shared account. */
export async function deleteActivityConnection({ ownerId, teamId, connectionId, authorize }, options = {}) {
  if (typeof connectionId !== "string" || !ACCOUNT_ID.test(connectionId)) fail("Choose a valid connection.");
  const mode = (options.getConfig || currentConfig)().mode;
  const config = mode === "sdk" ? sdkConfig(options) : null;
  const key = `${teamId}:${ownerId}:${connectionId}`;
  if (deleting.has(key)) fail("This connection is already being deleted. Refresh when it finishes.", 409);
  deleting.add(key);
  const checkAccess = async () => {
    try { await authorize(); }
    catch (error) { fail("Your Activity session has ended.", error.status === 401 ? 401 : 403); }
  };
  try {
    await checkAccess();
    if (!config) return await deletePersonalConnection({ ownerId, connectionId, authorize: checkAccess }, options);
    const identity = composioIdentity({ workspaceId: composioWorkspaceId({ kind: "user", id: ownerId, slackTeamId: teamId }), kind: "user", id: ownerId });
    const signal = AbortSignal.timeout(Math.max(10, Math.min(20_000, options.timeoutMs || 20_000)));
    const url = `${ACCOUNTS_API}/${encodeURIComponent(connectionId)}`;
    const account = await accountRequest(config, url, {}, options, signal);
    if (account?.id !== connectionId || !privateOwner(account, identity)) fail("This connection is unavailable or is not your private account.", 404);
    await checkAccess(); checkCurrent(config, options);
    // The connection alone is removed. Do not request upstream credential revocation, which
    // can affect other connections sharing the provider's grant.
    const result = await accountRequest(config, url, { method: "DELETE" }, options, signal);
    if (result?.success !== true) throw new Error("delete not confirmed");
    await checkAccess(); checkCurrent(config, options);
    return { deleted: true };
  } catch (error) {
    if (error instanceof ActivityConnectionsError) throw error;
    fail("The connection could not be deleted. Refresh your connections and try again.", 503);
  } finally { deleting.delete(key); }
}

function catalogLogo(value, credential) {
  // Logos are passive browser images from the provider's fixed asset hosts. Reject URL
  // normalization tricks, credentials, ports and parameters rather than broadening CSP.
  if (typeof value !== "string" || value.length > 1024 || value !== value.trim() || value.includes(credential)
    || !/^https:\/\/(?:logos|assets)\.composio\.dev\/[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/.test(value)
    || value.split("/").some(segment => segment === "." || segment === "..")) return "";
  return value;
}

async function catalogRequest(config, { query = "", cursor = "", ownerId, teamId }, options) {
  if (typeof query !== "string" || query.length > 120 || typeof cursor !== "string" || cursor.length > 2048) fail("Invalid app search or page.");
  const identity = composioIdentity({ workspaceId: composioWorkspaceId({ kind: "user", id: ownerId, slackTeamId: teamId }), kind: "user", id: ownerId });
  const allowed = config.policy.allowedApps;
  if (Array.isArray(allowed) && !allowed.length) return { apps: [], nextCursor: null };
  const selected = Array.isArray(allowed), signal = AbortSignal.timeout(20_000);
  const seen = new Set(), apps = new Map(); let next = cursor;
  // SDK 0.28's toolkits.get() drops next_cursor. The raw API retains pagination and its
  // user_id filter includes custom toolkits registered for this exact user, not other users.
  for (let page = 0; page < 50; page++) {
    const url = new URL(API);
    const search = query.trim() || (selected && allowed.length === 1 ? allowed[0] : "");
    for (const [key, value] of Object.entries({ limit: CATALOG_PAGE_SIZE, type: "all", sort_by: "alphabetically", include_deprecated: false, user_id: identity,
      ...(next ? { cursor: next } : {}), ...(search ? { search } : {}) })) url.searchParams.set(key, String(value));
    if (seen.has(next)) throw new Error("repeated page"); seen.add(next);
    const response = await (options.fetch || globalThis.fetch)(url, {
      redirect: "error", signal, headers: { "x-api-key": config.sdkApiKey },
    });
    if (!response.ok) throw new Error("catalog failed");
    const reader = response.body.getReader(); let total = 0; const chunks = [];
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 2_000_000) throw new Error("catalog too large"); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // Do not truncate an oversized page: its cursor would skip undisplayed applications.
    if (!Array.isArray(result?.items) || result.items.length > CATALOG_PAGE_SIZE) throw new Error("invalid catalog");
    const previous = next; next = result.next_cursor;
    if (next != null && (typeof next !== "string" || next.length > 2048 || next === previous || next.includes(config.sdkApiKey))) throw new Error("invalid page");
    for (const item of result.items) {
      const slug = clean(item?.slug, 128).toLowerCase();
      if (!SLUG.test(slug) || slug.includes(config.sdkApiKey.toLowerCase())) throw new Error("invalid toolkit");
      if (selected && !allowed.includes(slug)) continue;
      const safe = value => clean(typeof value === "string" ? value.split(config.sdkApiKey).join("[redacted]") : "", 500);
      const name = safe(item.name).slice(0, 160) || slug, description = safe(item.meta?.description);
      const logo = catalogLogo(item.meta?.logo, config.sdkApiKey);
      // The API also calls its legacy metadata object `deprecated`; that object is not
      // evidence that an app is retired (ordinary Gmail has deprecated.toolkitId).
      const deprecated = item.deprecated === true;
      apps.set(slug, { slug, name, description, ...(logo ? { logo } : {}), canConnect: item.no_auth !== true && !deprecated,
        reason: item.no_auth === true ? "Available without a connection" : deprecated ? "No longer supported" : "" });
    }
    // Skip pages containing only apps excluded by the gateway policy. Keep the provider's
    // cursor so every allowed result can still be reached; never treat page one as all apps.
    if (apps.size || !next) return { apps: [...apps.values()], nextCursor: next || null };
  }
  throw new Error("catalog page limit");
}

export async function activityConnectionApps(input, options = {}) {
  const config = sdkConfig(options);
  try {
    const result = await catalogRequest(config, input, options);
    checkCurrent(config, options);
    return result;
  } catch (error) {
    if (error instanceof ActivityConnectionsError) throw error;
    fail("Available apps could not be loaded. Try again.", 503);
  }
}

export async function createActivityConnection({ ownerId, teamId, sessionId, callbackUrl, app, alias = "", authorize }, options = {}) {
  if (typeof app !== "string" || !SLUG.test(app) || typeof alias !== "string" || alias.length > 80 || /[\u0000-\u001f\u007f]/.test(alias)) fail("Choose an app and an alias of up to 80 characters.");
  const config = sdkConfig(options);
  if (config.policy.allowedApps !== null && !config.policy.allowedApps.includes(app)) fail("This app is not available under the gateway's connection policy.", 409);
  const key = `${teamId}:${ownerId}`;
  if (creating.has(key)) fail("A connection request is already in progress. Wait for it to finish.", 409);
  creating.add(key);
  try {
    const checkAccess = async () => {
      try { await authorize(); }
      catch (error) { fail("Your Activity session has ended.", error.status === 401 ? 401 : 403); }
    };
    await checkAccess();
    const client = options.sdkClient || new Composio({ apiKey: config.sdkApiKey, userApiKey: null, orgApiKey: null, allowTracking: false });
    const requestOptions = { signal: AbortSignal.timeout(Math.max(10, Math.min(30_000, options.timeoutMs || 30_000))), maxRetries: 0 };
    const boundedClient = { sessions: {
      create: (id, policy) => client.sessions.create(id, policy, requestOptions),
      use: async (id, opts) => {
        const remote = await client.sessions.use(id, opts, requestOptions);
        return { sessionId: remote.sessionId, mcp: remote.mcp, update: policy => remote.update(policy, requestOptions) };
      },
    } };
    const endpoint = await (options.resolveSession || resolveSdkSession)({ workspaceId: composioWorkspaceId({ kind: "user", id: ownerId, slackTeamId: teamId }), kind: "user", id: ownerId,
      threadKey: `activity-connections:${sessionId}`, accessKind: "owner", manageConnections: true, client: boundedClient });
    const session = await client.sessions.use(endpoint.sessionId, undefined, requestOptions);
    await checkAccess(); checkCurrent(config, options);
    // The provider enforces the session's multi-account limits and alias uniqueness. Omit
    // experimental account/ACL options: self-service connections are PRIVATE by default.
    const request = await session.authorize(app, { ...(alias.trim() ? { alias: alias.trim() } : {}), callbackUrl }, requestOptions);
    await checkAccess(); checkCurrent(config, options);
    const redirect = new URL(request.redirectUrl);
    if (redirect.protocol !== "https:" || redirect.hostname !== "connect.composio.dev" || redirect.port || redirect.username || redirect.password) throw new Error("invalid authorization link");
    return { redirectUrl: redirect.href };
  } catch (error) {
    if (error instanceof ActivityConnectionsError) throw error;
    fail("The connection link could not be created. Check the alias and account limit, refresh your connections, then try again.", 503);
  } finally { creating.delete(key); }
}
