import test from "node:test";
import assert from "node:assert/strict";
import { Composio } from "@composio/core";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";

ensureTestEnv();

const { resolveSdkSession } = await import("../src/ee/composio-sdk.js");
const {
  composioIdentity,
  composioSessionKey,
  saveComposioSession,
  getComposioSession,
} = await import("../src/ee/composio-sessions.js");

function remoteSession(id) {
  return {
    sessionId: id,
    mcp: {
      url: `https://app.composio.dev/tool_router/v3/${id}/mcp`,
      headers: { "x-api-key": "must-never-leave-the-sdk-client" },
    },
  };
}

function fakeClient({ create, use } = {}) {
  return {
    sessions: {
      create: create || (async () => remoteSession("trs_created")),
      use: use || (async (id) => remoteSession(id)),
    },
  };
}

test("installed SDK creates and resumes gateway sessions with the correct identity and no key exposure", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://registry.npmjs.org/@composio/core/latest") {
      assert.equal(request.headers.get("x-api-key"), null);
      return Response.json({ version: "0.22.0" });
    }
    assert.equal(new URL(request.url).origin, "https://backend.composio.dev");
    const body = request.method === "POST" ? await request.json() : null;
    calls.push({ url: request.url, method: request.method, body, key: request.headers.get("x-api-key") });
    return Response.json({
      session_id: "trs_sdk_contract",
      mcp: { type: "http", url: "https://backend.composio.dev/tool_router/v3/trs_sdk_contract/mcp" },
      config: { user_id: body?.user_id || "test-user", manage_connections: { enable: false } },
    });
  });
  const apiKey = "ak_sdk_contract_fixture";
  const client = new Composio({ apiKey, userApiKey: null, orgApiKey: null, allowTracking: false });
  const options = {
    workspaceId: "TSDKCONTRACT", kind: "user", id: "UCONTRACT", threadKey: "installed-sdk",
    accessKind: "owner", manageConnections: false, client,
  };
  const created = await resolveSdkSession(options);
  const resumed = await resolveSdkSession(options);
  assert.deepEqual(resumed, created);
  assert.equal(created.url, "https://backend.composio.dev/tool_router/v3/trs_sdk_contract/mcp");
  assert.equal(created.source, "sdk-user");
  assert.equal(JSON.stringify(created).includes(apiKey), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.user_id, composioIdentity(options));
  assert.equal(calls[0].body.manage_connections.enable, false);
  assert.equal(calls[1].method, "GET");
  assert.ok(calls[1].url.endsWith("/tool_router/session/trs_sdk_contract"));
  assert.ok(calls.every((call) => call.key === apiKey));
});

test("personal and shared sessions use stable identities with explicit management rights", async () => {
  const calls = [];
  const client = fakeClient({
    create: async (identity, config) => {
      calls.push({ identity, config });
      return remoteSession(`trs_${calls.length}`);
    },
  });

  const personal = await resolveSdkSession({
    workspaceId: "T1",
    kind: "user",
    id: "U1",
    threadKey: "sdk-personal",
    accessKind: "owner",
    manageConnections: true,
    client,
  });
  const manager = await resolveSdkSession({
    workspaceId: "T1",
    kind: "channel",
    id: "C1",
    threadKey: "sdk-channel",
    accessKind: "manager",
    manageConnections: true,
    client,
  });
  const member = await resolveSdkSession({
    workspaceId: "T1",
    kind: "channel",
    id: "C1",
    threadKey: "sdk-channel",
    accessKind: "member",
    manageConnections: false,
    client,
  });

  assert.deepEqual(calls.map((call) => call.identity), [
    "slack:T1:user:U1",
    "slack:T1:channel:C1",
    "slack:T1:channel:C1",
  ]);
  assert.deepEqual(calls.map((call) => call.config), [
    { mcp: true, manageConnections: true },
    { mcp: true, manageConnections: true },
    { mcp: true, manageConnections: false },
  ]);
  assert.equal(personal.mode, "sdk");
  assert.equal(manager.mode, "sdk");
  assert.equal(member.mode, "sdk");
  assert.doesNotMatch(JSON.stringify([personal, manager, member]), /must-never-leave/);
});

test("stored sessions are resumed and retain their persisted mapping", async () => {
  const identityId = composioIdentity({ workspaceId: "T2", kind: "user", id: "U2" });
  const sessionKey = composioSessionKey({ identityId, threadKey: "sdk-reuse", accessKind: "owner" });
  saveComposioSession({
    sessionKey,
    identityId,
    scopeKind: "user",
    threadKey: "sdk-reuse",
    accessKind: "owner",
    sessionId: "trs_existing",
    mcpUrl: "https://app.composio.dev/tool_router/v3/trs_existing/mcp",
  });
  const used = [];
  const client = fakeClient({
    use: async (id, options) => {
      used.push({ id, options });
      return remoteSession(id);
    },
    create: async () => {
      throw new Error("must not create");
    },
  });

  const endpoint = await resolveSdkSession({
    workspaceId: "T2",
    kind: "user",
    id: "U2",
    threadKey: "sdk-reuse",
    accessKind: "owner",
    manageConnections: true,
    client,
  });

  assert.deepEqual(used, [{ id: "trs_existing", options: { mcp: true } }]);
  assert.equal(endpoint.sessionId, "trs_existing");
  assert.equal(getComposioSession(sessionKey).sessionId, "trs_existing");
});

test("a missing stored session is replaced exactly once", async () => {
  const identityId = composioIdentity({ workspaceId: "T3", kind: "channel", id: "C3" });
  const sessionKey = composioSessionKey({ identityId, threadKey: "sdk-stale", accessKind: "member" });
  saveComposioSession({
    sessionKey,
    identityId,
    scopeKind: "channel",
    threadKey: "sdk-stale",
    accessKind: "member",
    sessionId: "trs_stale",
    mcpUrl: "https://app.composio.dev/tool_router/v3/trs_stale/mcp",
  });
  let creates = 0;
  const client = fakeClient({
    use: async () => {
      const error = new Error("session not found");
      error.statusCode = 404;
      throw error;
    },
    create: async () => {
      creates += 1;
      return remoteSession("trs_replacement");
    },
  });

  const endpoint = await resolveSdkSession({
    workspaceId: "T3",
    kind: "channel",
    id: "C3",
    threadKey: "sdk-stale",
    accessKind: "member",
    manageConnections: false,
    client,
  });

  assert.equal(creates, 1);
  assert.equal(endpoint.sessionId, "trs_replacement");
  assert.equal(getComposioSession(sessionKey).sessionId, "trs_replacement");
});

test("concurrent resolution shares one remote create", async () => {
  let creates = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = fakeClient({
    create: async () => {
      creates += 1;
      await gate;
      return remoteSession("trs_singleflight");
    },
  });
  const input = {
    workspaceId: "T4",
    kind: "user",
    id: "U4",
    threadKey: "sdk-concurrent",
    accessKind: "owner",
    manageConnections: true,
    client,
  };

  const first = resolveSdkSession(input);
  const second = resolveSdkSession(input);
  await Promise.resolve();
  assert.equal(creates, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(creates, 1);
});


test("SDK session entrypoint fails before contacting Composio without Enterprise", async () => {
  let calls = 0;
  const client = { sessions: { create: async () => { calls++; }, use: async () => { calls++; } } };
  try {
    clearTestLicense();
    await assert.rejects(resolveSdkSession({ workspaceId: "T1", kind: "user", id: "U1", threadKey: "1.001", accessKind: "owner", client }), /Enterprise/);
    assert.equal(calls, 0);
  } finally { testLicenseEnv(); }
});
