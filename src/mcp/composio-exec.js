// The Composio script relay: lets code running in a channel container (a Node script, a saved
// automation, a background job) call Composio tools in SDK mode WITHOUT any Composio key in the
// container. The daemon holds the organization SDK key and executes each call itself, as a user id
// the run's signed capability fixes:
//   identity "user"  → the message author's SDK identity (only for a trusted principal)
//   identity "agent" → this conversation's SDK identity
//   userId "<any>"   → any user id in the organization project — ONLY while the capability's author
//                      is a current admin AND the channel is in Admin mode (both re-read live on
//                      every request, never taken from the token).
// Every request re-verifies the capability (signature, expiry, liveness), the Composio mode, the
// organization's allowed-apps policy, that the chosen connected account belongs to that user id,
// and routes Slack membership changes through the same one-use approval card as the MCP tools.
// A personal identity (the author's own, or another person's for an admin) is refused while a
// DIFFERENT person has live work in the channel: the container is shared, and its grant file must
// not become anyone else's way into those accounts.
//
// Wire protocol (after the socket hello, see socket-server.js), newline-delimited JSON:
//   → {"id":1,"op":"whoami"}
//   → {"id":2,"op":"accounts","identity":"user"|"agent"|undefined,"userId":"…","toolkit":"gmail"}
//   → {"id":3,"op":"users","toolkit":"gmail"}                     (admin in an Admin channel only)
//   → {"id":4,"op":"schema","tool":"GMAIL_FETCH_EMAILS"}
//   → {"id":5,"op":"execute","identity":"user","tool":"GMAIL_FETCH_EMAILS","arguments":{…},
//      "account":"ca_…","version":"20250909_00"}
//   ← {"id":…,"ok":true,"result":…}  |  {"id":…,"ok":false,"error":"…"}
import { Composio } from "@composio/core";
import { getComposioMode, getComposioSdkApiKey, getComposioSdkPolicy } from "../config/settings.js";
import { normalizeComposioSdkPolicy } from "../config/composio-sdk-policy.js";
import { getChannelMeta, isAdmin } from "../config/store.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { otherOwnerActive } from "../gateway/egress/liveness.js";
import { composioApprovalDetails } from "./composio-approval.js";
import { logEvent } from "../util/logger.js";

export const COMPOSIO_EXEC_SERVICE = "composio-exec";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const USER_ID_RE = /^[\x21-\x7e]{1,400}$/;
const SLUG_RE = /^[A-Z0-9][A-Z0-9_]{1,127}$/;
const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class RelayError extends Error {}
const fail = (message) => { throw new RelayError(message); };

let cachedKey = "";
let cachedClient = null;
function productionClient() {
  const apiKey = getComposioSdkApiKey();
  if (!apiKey) fail("Composio SDK mode has no organization API key configured.");
  if (!cachedClient || apiKey !== cachedKey) {
    cachedKey = apiKey;
    cachedClient = new Composio({ apiKey });
  }
  return cachedClient;
}

// Only these connected-account fields ever leave the daemon: an account record also carries the
// connection's auth state (access/refresh tokens), which must never reach a container.
export function safeAccount(item = {}) {
  return {
    id: String(item.id || ""),
    toolkit: String(item.toolkit?.slug || item.toolkitSlug || ""),
    status: String(item.status || ""),
    userId: String(item.userId ?? item.user_id ?? ""),
    ...(item.alias || item.wordId || item.word_id ? { alias: String(item.alias || item.wordId || item.word_id) } : {}),
    ...(item.createdAt || item.created_at ? { createdAt: String(item.createdAt || item.created_at) } : {}),
    ...(item.isDisabled === true || item.is_disabled === true ? { disabled: true } : {}),
  };
}

const grantIds = (claims) => {
  const out = {};
  for (const grant of claims?.composioSessions || []) {
    if (typeof grant?.id !== "string" || !grant.id) continue;
    if (grant.kind === "user" && claims.principalTrusted === true) out.user = grant.id;
    if (grant.kind === "channel") out.agent = grant.id;
  }
  return out;
};

/**
 * The relay's request handler, independent of the socket (tests drive it directly).
 * `verify()` returns the live capability check; `client()` the Composio SDK client; `requestApproval`
 * posts the one-use membership approval card.
 */
export function createComposioExecHandler({
  verify,
  client = productionClient,
  requestApproval = async () => ({ allow: false }),
  mode = getComposioMode,
  policy = () => normalizeComposioSdkPolicy(getComposioSdkPolicy()),
  entitlement = requireComposioSdkEntitlement,
  loadMeta = getChannelMeta,
  loadIsAdmin = isAdmin,
  otherPersonActive = otherOwnerActive,
  log = logEvent,
} = {}) {
  const toolkitBySlug = new Map();

  function claimsNow() {
    const checked = verify();
    if (!checked?.ok) fail("This script's Composio grant is no longer active (its turn has ended). Re-run the script from a new turn.");
    if (mode() !== "sdk") fail("The Composio script relay is available only when the gateway runs Composio in SDK mode.");
    entitlement();
    return checked.claims;
  }

  async function adminWide(claims) {
    if (claims.principalTrusted !== true) return false;
    const [admin, meta] = await Promise.all([loadIsAdmin(claims.authorId), loadMeta(claims.slug)]);
    return Boolean(admin) && meta?.adminMode === true;
  }

  // Which Composio user id this request acts as, and why it may.
  async function resolveUser(claims, request) {
    const ids = grantIds(claims);
    const identity = request.identity === undefined ? "" : String(request.identity);
    const explicit = request.userId === undefined ? "" : String(request.userId);
    if (identity && explicit) fail("Pass either identity or userId, not both.");
    let userId = "";
    let kind = "";
    if (identity === "user") {
      if (!ids.user) fail("This run has no personal Composio identity (composio-user).");
      userId = ids.user; kind = "user";
    } else if (identity === "agent") {
      if (!ids.agent) fail("This conversation has no shared Composio identity (composio-agent) in this run.");
      userId = ids.agent; kind = "agent";
    } else if (identity) {
      fail('identity must be "user" or "agent".');
    } else if (explicit) {
      if (!USER_ID_RE.test(explicit)) fail("Invalid Composio user id.");
      if (explicit === ids.user) { userId = explicit; kind = "user"; }
      else if (explicit === ids.agent) { userId = explicit; kind = "agent"; }
      else {
        if (!(await adminWide(claims))) fail("Another Composio user id can only be used by an admin, in a channel with Admin mode on.");
        userId = explicit; kind = "admin";
      }
    } else {
      fail('Choose the identity: "user" (the requester) or "agent" (this conversation).');
    }
    // A person's accounts are theirs: never while someone else is working in this container.
    if (kind !== "agent" && otherPersonActive(claims.channelId, claims.authorId)) {
      fail("Another person is working in this conversation right now; personal Composio identities pause until they finish. Retry later.");
    }
    return { userId, kind };
  }

  async function toolkitOf(sdk, slug) {
    if (toolkitBySlug.has(slug)) return toolkitBySlug.get(slug);
    let tool;
    try {
      tool = await sdk.tools.getRawComposioToolBySlug(slug);
    } catch {
      fail(`Unknown Composio tool ${slug}.`);
    }
    const toolkit = String(tool?.toolkit?.slug || "").toLowerCase();
    if (!toolkit) fail(`Composio did not say which app ${slug} belongs to.`);
    toolkitBySlug.set(slug, { toolkit, tool });
    return toolkitBySlug.get(slug);
  }

  function assertAppAllowed(toolkit) {
    const { allowedApps } = policy();
    if (allowedApps !== null && !allowedApps.includes(toolkit)) fail(`The app ${toolkit} is not enabled for Composio in this organization.`);
  }

  async function accountsFor(sdk, userId, toolkit = "") {
    const query = { userIds: [userId], ...(toolkit ? { toolkitSlugs: [toolkit] } : {}) };
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const response = await sdk.connectedAccounts.list({ ...query, ...(cursor ? { cursor } : {}) });
      out.push(...(response?.items || []).map(safeAccount));
      cursor = response?.nextCursor || response?.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function pickAccount(sdk, userId, toolkit, requested) {
    const accounts = (await accountsFor(sdk, userId, toolkit)).filter((a) => a.status === "ACTIVE" && !a.disabled);
    if (requested) {
      if (!ACCOUNT_RE.test(requested)) fail("Invalid connected account id.");
      const match = accounts.find((a) => a.id === requested || a.alias === requested);
      if (!match) fail(`Connected account ${requested} is not an active ${toolkit} account of this identity.`);
      return match.id;
    }
    if (!accounts.length) fail(`This identity has no active ${toolkit} connection.`);
    if (accounts.length > 1) fail(`This identity has ${accounts.length} active ${toolkit} accounts: pass "account" (${accounts.map((a) => a.alias || a.id).join(", ")}).`);
    return accounts[0].id;
  }

  const ops = {
    async whoami(claims) {
      const ids = grantIds(claims);
      return { mode: "sdk", ...(ids.user ? { user: ids.user } : {}), ...(ids.agent ? { agent: ids.agent } : {}), adminWide: await adminWide(claims) };
    },
    async accounts(claims, request, sdk) {
      const { userId } = await resolveUser(claims, request);
      const toolkit = request.toolkit === undefined ? "" : String(request.toolkit).toLowerCase();
      if (toolkit && !TOOLKIT_RE.test(toolkit)) fail("Invalid toolkit slug.");
      return { userId, accounts: await accountsFor(sdk, userId, toolkit) };
    },
    async users(claims, request, sdk) {
      if (!(await adminWide(claims))) fail("Listing every user's connections is only for an admin, in a channel with Admin mode on.");
      if (otherPersonActive(claims.channelId, claims.authorId)) fail("Another person is working in this conversation right now; retry when they finish.");
      const toolkit = request.toolkit === undefined ? "" : String(request.toolkit).toLowerCase();
      if (toolkit && !TOOLKIT_RE.test(toolkit)) fail("Invalid toolkit slug.");
      const out = [];
      let cursor;
      for (let page = 0; page < 50; page += 1) {
        const response = await sdk.connectedAccounts.list({ ...(toolkit ? { toolkitSlugs: [toolkit] } : {}), ...(cursor ? { cursor } : {}) });
        out.push(...(response?.items || []).map(safeAccount));
        cursor = response?.nextCursor || response?.next_cursor;
        if (!cursor) break;
      }
      return { accounts: out };
    },
    async schema(claims, request, sdk) {
      const slug = String(request.tool || "");
      if (!SLUG_RE.test(slug) || slug.startsWith("COMPOSIO_")) fail("Pass an app tool slug, e.g. GMAIL_FETCH_EMAILS.");
      const { toolkit, tool } = await toolkitOf(sdk, slug);
      assertAppAllowed(toolkit);
      return { slug, toolkit, name: tool?.name || "", description: tool?.description || "", inputParameters: tool?.inputParameters ?? tool?.input_parameters ?? null, outputParameters: tool?.outputParameters ?? tool?.output_parameters ?? null, version: tool?.version || "" };
    },
    async execute(claims, request, sdk) {
      const slug = String(request.tool || "");
      // Meta tools (search, multi-execute, workbench, connection management) stay on the MCP
      // session, where they belong; the relay runs app tools only.
      if (!SLUG_RE.test(slug) || slug.startsWith("COMPOSIO_")) fail("Pass an app tool slug, e.g. GMAIL_FETCH_EMAILS (Composio meta tools are not available to scripts).");
      const args = request.arguments === undefined ? {} : request.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) fail("arguments must be a JSON object.");
      const version = request.version === undefined ? "" : String(request.version);
      if (version && !VERSION_RE.test(version)) fail("Invalid toolkit version.");
      const { userId, kind } = await resolveUser(claims, request);
      const { toolkit } = await toolkitOf(sdk, slug);
      assertAppAllowed(toolkit);
      const connectedAccountId = await pickAccount(sdk, userId, toolkit, request.account === undefined ? "" : String(request.account));
      // Channel membership (Slack join/invite/create) needs a one-use human approval, as on MCP.
      let details = null;
      try {
        details = composioApprovalDetails({ name: slug, arguments: args }, kind === "agent" ? "composio-agent" : kind === "user" ? "composio-user" : `composio ${userId}`);
      } catch (error) {
        fail(`Not executed: ${error.message}.`);
      }
      if (details) {
        const decision = await requestApproval({
          approvalType: "agent", channelId: claims.channelId, slug: claims.slug, authorId: claims.authorId, threadKey: claims.threadKey,
          toolName: "Approve connector access change", toolInput: { details }, approveText: "Approve once", denyText: "Deny",
        }).catch(() => null);
        if (decision?.allow !== true) fail("Not executed: channel membership changes need a one-use human approval, which was not granted.");
        claimsNow(); // a click is not reusable authority: revocation or expiry while waiting wins
        await resolveUser(claims, request);
      }
      const result = await sdk.tools.execute(slug, {
        userId, connectedAccountId, arguments: args,
        ...(version ? { version } : { dangerouslySkipVersionCheck: true }),
      });
      await Promise.resolve(log("composio_exec", { channel: claims.channelId, slug: claims.slug, author: claims.authorId, identity: kind, ...(kind === "admin" ? { userId } : {}), tool: slug, ok: result?.successful !== false })).catch(() => {});
      return { successful: result?.successful !== false, data: result?.data ?? null, error: result?.error ?? null, userId, account: connectedAccountId };
    },
  };

  return async function handle(request) {
    const op = typeof request?.op === "string" ? request.op : "";
    if (!Object.hasOwn(ops, op)) fail(`Unknown op "${op.slice(0, 40)}" (whoami, accounts, users, schema, execute).`);
    const claims = claimsNow();
    return ops[op](claims, request, client());
  };
}

// Upstream SDK errors can quote request URLs; keep only a bounded first line, and never a header.
function publicError(error) {
  if (error instanceof RelayError) return error.message;
  const text = String(error?.message || "Composio request failed").split("\n")[0].replace(/x-api-key\S*/gi, "").slice(0, 300);
  return `Composio request failed: ${text}`;
}

/** Serve the relay on an accepted socket whose hello has already been verified. */
export function serveComposioExec(socket, rest, options) {
  const handle = createComposioExecHandler(options);
  let buffer = Buffer.alloc(0);
  let inFlight = 0;
  const send = (frame) => {
    let line = JSON.stringify(frame);
    if (Buffer.byteLength(line) > MAX_RESULT_BYTES) line = JSON.stringify({ id: frame.id, ok: false, error: "The result is larger than 16 MB; request fewer records (paginate)." });
    try { socket.write(`${line}\n`); } catch { /* peer gone */ }
  };
  const onLine = (text) => {
    let request;
    try { request = JSON.parse(text); } catch { return send({ id: null, ok: false, error: "Malformed request: send one JSON object per line." }); }
    const id = request && (typeof request.id === "number" || typeof request.id === "string") ? request.id : null;
    if (inFlight >= MAX_IN_FLIGHT) return send({ id, ok: false, error: `At most ${MAX_IN_FLIGHT} requests at once per connection.` });
    inFlight += 1;
    handle(request)
      .then((result) => send({ id, ok: true, result }))
      .catch((error) => send({ id, ok: false, error: publicError(error) }))
      .finally(() => { inFlight -= 1; });
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let nl;
    while ((nl = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, nl).toString("utf8").trim();
      buffer = buffer.subarray(nl + 1);
      if (line) onLine(line);
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = Buffer.alloc(0);
      send({ id: null, ok: false, error: "Request line too large (1 MB max)." });
    }
  };
  socket.on("data", onData);
  if (rest?.length) onData(rest);
  socket.resume?.();
  return handle;
}
