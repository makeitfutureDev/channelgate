// Activity self-service connections. A browser supplies an app/alias, never a Composio
// owner, project key, session URL, auth-config ID, callback, or shared-account ACL.
import { Composio } from "@composio/core";
import { getComposioMode, getComposioSdkApiKey, getComposioSdkPolicy } from "../config/settings.js";
import { getUser } from "../config/store.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { composioIdentity } from "../ee/composio-sessions.js";
import { resolveSdkSession } from "../ee/composio-sdk.js";
import { loadComposioInventory } from "./composio-inventory.js";

const API = "https://backend.composio.dev/api/v3.1/toolkits";
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,127}$/;
const creating = new Set();
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
  const record = await (options.getUser || getUser)(ownerId);
  const inventory = await (options.inventory || loadComposioInventory)({ kind: "user", id: ownerId, record }, {
    ...(options.inventoryOptions || {}),
    // The authenticated Activity session supplies the workspace, exactly as SDK runs do.
    ...(getComposioMode() === "sdk" ? { config: { mode: "sdk", sdkApiKey: getComposioSdkApiKey(), workspaceId: teamId } } : {}),
  });
  let config;
  try { config = sdkConfig(options); } catch { /* A read remains useful without SDK creation. */ }
  return { ...inventory, canAdd: Boolean(config) && inventory.mode === "sdk" && inventory.state === "ready",
    ...(config ? { policy: { multiAccount: config.policy.multiAccount, maxAccountsPerToolkit: config.policy.maxAccountsPerToolkit } } : {}) };
}

async function catalogRequest(config, { query = "", cursor = "", ownerId, teamId }, options) {
  if (typeof query !== "string" || query.length > 120 || typeof cursor !== "string" || cursor.length > 2048) fail("Invalid app search or page.");
  const identity = composioIdentity({ workspaceId: teamId, kind: "user", id: ownerId });
  const allowed = config.policy.allowedApps;
  if (Array.isArray(allowed) && !allowed.length) return { apps: [], nextCursor: null };
  const selected = Array.isArray(allowed), signal = AbortSignal.timeout(20_000);
  const seen = new Set(), apps = new Map(); let next = cursor;
  // SDK 0.28's toolkits.get() drops next_cursor. The raw API retains pagination and its
  // user_id filter includes custom toolkits registered for this exact user, not other users.
  for (let page = 0; page < 50; page++) {
    const url = new URL(API);
    const search = query.trim() || (selected && allowed.length === 1 ? allowed[0] : "");
    for (const [key, value] of Object.entries({ limit: 100, type: "all", sort_by: "alphabetically", include_deprecated: false, user_id: identity,
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
    if (!Array.isArray(result?.items) || result.items.length > 200) throw new Error("invalid catalog");
    const previous = next; next = result.next_cursor;
    if (next != null && (typeof next !== "string" || next.length > 2048 || next === previous)) throw new Error("invalid page");
    for (const item of result.items) {
      const slug = clean(item?.slug, 128).toLowerCase();
      if (!SLUG.test(slug)) throw new Error("invalid toolkit");
      if (selected && !allowed.includes(slug)) continue;
      const safe = value => clean(value, 500).split(config.sdkApiKey).join("[redacted]");
      const name = safe(item.name).slice(0, 160) || slug, description = safe(item.meta?.description);
      // The API also calls its legacy metadata object `deprecated`; that object is not
      // evidence that an app is retired (ordinary Gmail has deprecated.toolkitId).
      const deprecated = item.deprecated === true;
      apps.set(slug, { slug, name, description, canConnect: item.no_auth !== true && !deprecated,
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
    const endpoint = await (options.resolveSession || resolveSdkSession)({ workspaceId: teamId, kind: "user", id: ownerId,
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
