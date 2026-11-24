// The Composio script relay (src/mcp/composio-exec.js): container scripts call Composio in SDK mode
// with no key, as exactly the identity the run's capability signs; any user id only for a current
// admin in an Admin-mode channel. Also the composio-exec capability scope, the per-turn grant file
// and the bundled client over a real unix socket.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "composio-exec-signing-secret";
const SECRET = "composio-exec-signing-secret";
const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { createComposioExecHandler, safeAccount } = await import("../src/mcp/composio-exec.js");
const { serveMcpConnection } = await import("../src/mcp/socket-server.js");
const { writeComposioExecGrant, composioExecGrants } = await import("../src/gateway/composio-exec-grant.js");
const { markLive } = await import("../src/gateway/egress/liveness.js");
const { connectComposio } = await import("../src/gateway/gateway-usage/scripts/composio.mjs");

const CHANNEL = "C_EXEC";
const USER_ID = "slack:T1:user:U_AUTHOR";
const AGENT_ID = "slack:T1:channel:C_EXEC";
const sessions = [
  { kind: "user", url: "https://backend.composio.dev/tool_router/u/mcp", id: USER_ID },
  { kind: "channel", url: "https://backend.composio.dev/tool_router/c/mcp", id: AGENT_ID },
];
const claims = (over = {}) => ({ channelId: CHANNEL, slug: "exec", authorId: "U_AUTHOR", threadKey: "1.1", principalTrusted: true, composioSessions: sessions, ...over });

function fakeSdk({ accounts = {}, toolkits = { GMAIL_FETCH_EMAILS: "gmail", SLACK_JOIN_CONVERSATION: "slack", NOTION_SEARCH: "notion" } } = {}) {
  const calls = [];
  return {
    calls,
    tools: {
      async getRawComposioToolBySlug(slug) {
        if (!toolkits[slug]) throw new Error("not found");
        return { slug, name: slug, toolkit: { slug: toolkits[slug] }, inputParameters: { type: "object" } };
      },
      async execute(slug, body) { calls.push({ slug, body }); return { successful: true, data: { ok: slug }, error: null }; },
    },
    connectedAccounts: {
      async list(query) {
        const users = query.userIds || Object.keys(accounts);
        const items = users.flatMap((u) => (accounts[u] || []).map((a) => ({ ...a, user_id: u, state: { access_token: "SECRET-TOKEN" }, data: { refresh: "SECRET" } })))
          .filter((a) => !query.toolkitSlugs || query.toolkitSlugs.includes(a.toolkit.slug));
        return { items, nextCursor: null };
      },
    },
  };
}

function handler({ sdk = fakeSdk(), claimsOver = {}, admin = false, adminMode = false, other = false, allowedApps = null, mode = "sdk", ok = true, approval = { allow: false } } = {}) {
  const approvals = [];
  const handle = createComposioExecHandler({
    verify: () => (ok ? { ok: true, claims: claims(claimsOver) } : { ok: false, reason: "idle" }),
    client: () => sdk,
    requestApproval: async (body) => { approvals.push(body); return approval; },
    mode: () => mode,
    policy: () => ({ allowedApps }),
    entitlement: () => {},
    loadMeta: async () => ({ adminMode }),
    loadIsAdmin: async () => admin,
    otherPersonActive: () => other,
    log: () => {},
  });
  return { handle, sdk, approvals };
}

const gmail = (id, alias) => ({ id, alias, status: "ACTIVE", isDisabled: false, toolkit: { slug: "gmail" } });

test("capability scopes are disjoint: an exec grant opens only the relay", () => {
  const base = { secret: SECRET, channelId: CHANNEL, slug: "exec", authorId: "U_AUTHOR", threadKey: "1.1", origin: "slack_foreground", engine: "claude", composioSessions: sessions };
  const exec = mintGatewayCapability({ ...base, scope: "composio-exec" });
  const tools = mintGatewayCapability(base);
  assert.equal(verifyGatewayCapability(exec, { secret: SECRET }).ok, false, "exec token is not a gateway-tools token");
  assert.equal(verifyGatewayCapability(exec, { secret: SECRET, scope: "composio-exec" }).ok, true);
  assert.equal(verifyGatewayCapability(tools, { secret: SECRET, scope: "composio-exec" }).ok, false, "a run token does not open the relay");
  assert.throws(() => mintGatewayCapability({ ...base, scope: "anything" }), /scope/);
  assert.throws(() => mintGatewayCapability({ ...base, composioSessions: [{ kind: "user", url: "https://x", id: 5 }] }), /Composio/);
});

test("identity user/agent executes as the signed user id, with the single active account", async () => {
  const sdk = fakeSdk({ accounts: { [USER_ID]: [gmail("ca_1")], [AGENT_ID]: [gmail("ca_2")] } });
  const { handle } = handler({ sdk });
  const who = await handle({ op: "whoami" });
  assert.deepEqual(who, { mode: "sdk", user: USER_ID, agent: AGENT_ID, adminWide: false });
  const r = await handle({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS", arguments: { max_results: 2 } });
  assert.equal(r.successful, true);
  assert.deepEqual(sdk.calls[0], { slug: "GMAIL_FETCH_EMAILS", body: { userId: USER_ID, connectedAccountId: "ca_1", arguments: { max_results: 2 }, dangerouslySkipVersionCheck: true } });
  await handle({ op: "execute", identity: "agent", tool: "GMAIL_FETCH_EMAILS", version: "20250909_00" });
  assert.equal(sdk.calls[1].body.userId, AGENT_ID);
  assert.equal(sdk.calls[1].body.version, "20250909_00");
});

test("account listing never carries connection credentials", async () => {
  const sdk = fakeSdk({ accounts: { [USER_ID]: [gmail("ca_1", "work")] } });
  const { handle } = handler({ sdk });
  const { accounts } = await handle({ op: "accounts", identity: "user", toolkit: "gmail" });
  assert.equal(accounts.length, 1);
  assert.doesNotMatch(JSON.stringify(accounts), /SECRET/);
  assert.deepEqual(Object.keys(safeAccount({ id: "x", state: { a: 1 }, data: {}, params: {} })).sort(), ["id", "status", "toolkit", "userId"]);
});

test("refusals: no identity, unknown identity, missing grant, meta tools, apps policy, accounts", async () => {
  const sdk = fakeSdk({ accounts: { [USER_ID]: [gmail("ca_1"), gmail("ca_9", "home")], [AGENT_ID]: [] } });
  const { handle } = handler({ sdk, allowedApps: ["gmail", "slack"] });
  await assert.rejects(handle({ op: "execute", tool: "GMAIL_FETCH_EMAILS" }), /Choose the identity/);
  await assert.rejects(handle({ op: "execute", identity: "boss", tool: "GMAIL_FETCH_EMAILS" }), /identity must be/);
  await assert.rejects(handle({ op: "execute", identity: "user", tool: "COMPOSIO_REMOTE_WORKBENCH" }), /meta tools/);
  await assert.rejects(handle({ op: "execute", identity: "user", tool: "NOTION_SEARCH" }), /not enabled/);
  await assert.rejects(handle({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS" }), /2 active gmail accounts: pass "account"/);
  await assert.rejects(handle({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS", account: "ca_other" }), /not an active gmail account of this identity/);
  await handle({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS", account: "home" });
  assert.equal(sdk.calls.at(-1).body.connectedAccountId, "ca_9");
  await assert.rejects(handle({ op: "execute", identity: "agent", tool: "GMAIL_FETCH_EMAILS" }), /no active gmail connection/);
  await assert.rejects(handle({ op: "nope" }), /Unknown op/);
  const untrusted = handler({ claimsOver: { principalTrusted: false } }).handle;
  await assert.rejects(untrusted({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS" }), /no personal Composio identity/);
});

test("mode, entitlement and liveness are re-checked on every request", async () => {
  await assert.rejects(handler({ mode: "personal" }).handle({ op: "whoami" }), /only when the gateway runs Composio in SDK mode/);
  await assert.rejects(handler({ ok: false }).handle({ op: "whoami" }), /no longer active/);
});

test("a personal identity pauses while another person works here; the channel identity does not", async () => {
  const sdk = fakeSdk({ accounts: { [USER_ID]: [gmail("ca_1")], [AGENT_ID]: [gmail("ca_2")] } });
  const { handle } = handler({ sdk, other: true });
  await assert.rejects(handle({ op: "execute", identity: "user", tool: "GMAIL_FETCH_EMAILS" }), /Another person is working/);
  assert.equal((await handle({ op: "execute", identity: "agent", tool: "GMAIL_FETCH_EMAILS" })).successful, true);
});

test("any user id only for a current admin in an Admin-mode channel", async () => {
  const OTHER = "slack:T1:user:U_COLLEAGUE";
  const sdk = fakeSdk({ accounts: { [OTHER]: [gmail("ca_c")] } });
  await assert.rejects(handler({ sdk }).handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /only be used by an admin, in a channel with Admin mode on/);
  await assert.rejects(handler({ sdk, admin: true }).handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /Admin mode on/);
  await assert.rejects(handler({ sdk, adminMode: true }).handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /Admin mode on/);
  await assert.rejects(handler({ sdk, admin: true, adminMode: true, claimsOver: { principalTrusted: false } }).handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /Admin mode on/);
  await assert.rejects(handler({ sdk, admin: true, adminMode: true, other: true }).handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /Another person is working/);
  const { handle } = handler({ sdk, admin: true, adminMode: true });
  assert.equal((await handle({ op: "whoami" })).adminWide, true);
  const r = await handle({ op: "execute", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" });
  assert.equal(r.userId, OTHER);
  assert.equal(sdk.calls.at(-1).body.connectedAccountId, "ca_c");
  assert.ok((await handle({ op: "users", toolkit: "gmail" })).accounts.length >= 1);
  await assert.rejects(handler({ sdk }).handle({ op: "users" }), /only for an admin/);
  await assert.rejects(handle({ op: "execute", identity: "user", userId: OTHER, tool: "GMAIL_FETCH_EMAILS" }), /either identity or userId/);
});

test("Slack membership changes need the one-use approval card", async () => {
  const sdk = fakeSdk({ accounts: { [USER_ID]: [{ id: "ca_s", status: "ACTIVE", toolkit: { slug: "slack" } }] } });
  const denied = handler({ sdk });
  await assert.rejects(denied.handle({ op: "execute", identity: "user", tool: "SLACK_JOIN_CONVERSATION", arguments: { channel: "C9" } }), /one-use human approval/);
  assert.equal(denied.approvals.length, 1);
  assert.equal(sdk.calls.length, 0);
  const allowed = handler({ sdk, approval: { allow: true } });
  assert.equal((await allowed.handle({ op: "execute", identity: "user", tool: "SLACK_JOIN_CONVERSATION", arguments: { channel: "C9" } })).successful, true);
});

test("grant file: SDK-only, 0600, scoped, and the bundled client works end to end over the socket", async (t) => {
  assert.deepEqual(composioExecGrants({ composioUserEndpoint: { mode: "personal", url: "x" } }), []);
  assert.deepEqual(composioExecGrants({ principalTrusted: false, composioUserEndpoint: { mode: "sdk", url: sessions[0].url, identityId: USER_ID } }), []);
  const dir = trackTempDir(mkdtempSync("/tmp/cgexec-"));
  const none = await writeComposioExecGrant({ artifactRoot: dir, channelId: CHANNEL, slug: "exec", authorId: "U_AUTHOR", threadKey: "1.1", origin: "slack_foreground", engine: "claude" });
  assert.equal(none, null);
  const grant = await writeComposioExecGrant({
    artifactRoot: dir, cwd: "/work", channelId: CHANNEL, slug: "exec", authorId: "U_AUTHOR", threadKey: "1.1", origin: "slack_foreground", engine: "claude",
    composioUserEndpoint: { mode: "sdk", url: sessions[0].url, identityId: USER_ID },
    composioEndpoint: { mode: "sdk", url: sessions[1].url, identityId: AGENT_ID },
  });
  assert.equal(statSync(grant.file).mode & 0o777, 0o600);
  assert.match(grant.prefix, /Composio script relay for THIS turn/);
  assert.match(grant.prefix, /\/work\/\.claude\/skills\/gateway-usage\/scripts\/composio\.mjs/);
  const body = JSON.parse(readFileSync(grant.file, "utf8"));
  assert.equal(verifyGatewayCapability(body.capability, { secret: SECRET }).ok, false);
  assert.equal(verifyGatewayCapability(body.capability, { secret: SECRET, scope: "composio-exec" }).claims.composioSessions[0].id, USER_ID);

  // Point the grant at a test socket served by the real connection handler.
  const socketPath = path.join(dir, "mcp.sock");
  const sdk = fakeSdk({ accounts: { [USER_ID]: [gmail("ca_1")] } });
  const { saveSettings } = await import("../src/config/settings.js");
  saveSettings({ composioMode: "sdk" });
  markLive({ channelId: CHANNEL, ownerId: "U_AUTHOR", kind: "turn", id: "exec-turn" });
  const server = net.createServer((socket) => serveMcpConnection(socket, { secret: () => SECRET, log: null, composioExec: { client: () => sdk, entitlement: () => {} } }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const { writeFileSync } = await import("node:fs");
  const grantFile = path.join(dir, "grant.json");
  writeFileSync(grantFile, JSON.stringify({ ...body, socket: socketPath }), { mode: 0o600 });
  const composio = await connectComposio({ grant: grantFile });
  try {
    assert.equal((await composio.whoami()).user, USER_ID);
    const r = await composio.execute({ identity: "user", tool: "GMAIL_FETCH_EMAILS", arguments: { max_results: 1 } });
    assert.equal(r.successful, true);
    await assert.rejects(composio.execute({ identity: "user", tool: "COMPOSIO_SEARCH_TOOLS" }), /meta tools/);
  } finally {
    composio.close();
  }
  // A run (gateway-tools) token is refused by the relay at the hello.
  const runToken = mintGatewayCapability({ secret: SECRET, channelId: CHANNEL, slug: "exec", authorId: "U_AUTHOR", threadKey: "1.1", origin: "slack_foreground", engine: "claude" });
  writeFileSync(grantFile, JSON.stringify({ v: 1, socket: socketPath, capability: runToken }), { mode: 0o600 });
  await assert.rejects(connectComposio({ grant: grantFile }), /capability rejected/);
});
