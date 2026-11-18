import test from "node:test";
import assert from "node:assert/strict";
import { Composio } from "@composio/core";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";

ensureTestEnv();

const { resolveSdkSession } = await import("../src/ee/composio-sdk.js");
const { saveSettings } = await import("../src/config/settings.js");
const { composioSessionPolicy } = await import("../src/config/composio-sdk-policy.js");
const {
  composioIdentity,
  composioSessionKey,
  saveComposioSession,
  getComposioSession,
} = await import("../src/ee/composio-sessions.js");

function remoteSession(id) {
  return {
    sessionId: id,
    update: async () => {},
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
    const body = ["POST", "PATCH"].includes(request.method) ? await request.json() : null;
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
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.user_id, composioIdentity(options));
  assert.equal(calls[0].body.manage_connections.enable, false);
  assert.equal(calls[1].method, "GET");
  assert.ok(calls[1].url.endsWith("/tool_router/session/trs_sdk_contract"));
  assert.equal(calls[2].method, "PATCH");
  for (const call of [calls[0], calls[2]]) {
    assert.deepEqual(call.body.multi_account, { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true });
    assert.deepEqual(call.body.toolkits, { disable: [] });
  }
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
    { mcp: true, manageConnections: true, ...composioSessionPolicy() },
    { mcp: true, manageConnections: true, ...composioSessionPolicy() },
    { mcp: true, manageConnections: false, ...composioSessionPolicy() },
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

test("policy changes update persisted sessions before reuse, including deny-all and unrestricted", async () => {
  let creates = 0;
  const updates = [];
  const client = fakeClient({
    create: async () => { creates++; return remoteSession("trs_policy"); },
    use: async () => ({ ...remoteSession("trs_policy"), update: async (policy) => updates.push(policy) }),
  });
  const input = { workspaceId: "TPOLICY", kind: "user", id: "UPOLICY", threadKey: "policy-update", accessKind: "owner", manageConnections: true, client };
  try {
    await resolveSdkSession(input);
    for (const allowedApps of [["gmail", "custom_aioutreach"], [], null]) {
      saveSettings({ composioSdkPolicy: { multiAccount: true, maxAccountsPerToolkit: 3, allowedApps } });
      await resolveSdkSession(input);
    }
    saveSettings({ composioSdkPolicy: { multiAccount: false } });
    await resolveSdkSession(input);
    assert.equal(creates, 1, "updates preserve the existing session and connected accounts");
    assert.deepEqual(updates.map((p) => p.toolkits), [{ enable: ["custom_aioutreach", "gmail"] }, { enable: [] }, { disable: [] }, { disable: [] }]);
    assert.deepEqual(updates[0].multiAccount, { enable: true, maxAccountsPerToolkit: 3, requireExplicitSelection: true });
    assert.deepEqual(updates[3].multiAccount, { enable: false });
    assert.ok(updates.every((p) => p.manageConnections.enable === true));
  } finally { saveSettings({ composioSdkPolicy: {} }); }
});

test("failed policy updates never expose an old endpoint or create an unrestricted replacement", async () => {
  const input = { workspaceId: "TFAIL", kind: "channel", id: "CFAIL", threadKey: "policy-failure", accessKind: "member", client: fakeClient() };
  await resolveSdkSession(input);
  let creates = 0;
  input.client = fakeClient({
    use: async () => ({ ...remoteSession("trs_created"), update: async () => { throw new Error("policy update refused"); } }),
    create: async () => { creates++; return remoteSession("unsafe"); },
  });
  await assert.rejects(resolveSdkSession(input), /policy update refused/);
  assert.equal(creates, 0);
});

test("policy changes refresh cached engine tool schemas without replacing the remote session", async () => {
  const { buildEngineMcpRuntime } = await import("../src/gateway/run-engine-mcp.js");
  const input = { workspaceId: "TCACHE", kind: "user", id: "UCACHE", threadKey: "policy-cache", accessKind: "owner", client: fakeClient() };
  try {
    const first = await resolveSdkSession(input);
    const same = await resolveSdkSession(input);
    assert.equal(first.policyDigest, same.policyDigest);
    for (const policy of [{ multiAccount: false }, { allowedApps: ["gmail"] }, { allowedApps: [] }]) {
      saveSettings({ composioSdkPolicy: policy });
      const changed = await resolveSdkSession(input);
      assert.equal(changed.url, first.url);
      assert.notEqual(changed.policyDigest, first.policyDigest);
      for (const engine of ["claude", "codex"]) {
        for (const identity of ["composioUserEndpoint", "composioEndpoint"]) {
          const runtimeInput = { engine, channelId: "CCACHE", slug: "cache", authorId: "UCACHE", threadKey: "policy-cache", origin: "slack_foreground", fingerprintNow: 10000 };
          const before = await buildEngineMcpRuntime({ ...runtimeInput, [identity]: first });
          const stable = await buildEngineMcpRuntime({ ...runtimeInput, [identity]: same });
          const after = await buildEngineMcpRuntime({ ...runtimeInput, [identity]: changed });
          assert.equal(before.mcpConfigFingerprint, stable.mcpConfigFingerprint);
          assert.notEqual(before.mcpConfigFingerprint, after.mcpConfigFingerprint);
        }
      }
    }
  } finally { saveSettings({ composioSdkPolicy: {} }); }
});

test("a caller joining an in-flight preparation after a policy change never receives the old policy", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const updates = [];
  const input = { workspaceId: "TRACE", kind: "user", id: "URACE", threadKey: "policy-race", accessKind: "owner", client: fakeClient({
    create: async () => { await gate; return remoteSession("trs_race"); },
    use: async () => ({ ...remoteSession("trs_race"), update: async (p) => updates.push(p) }),
  }) };
  try {
    const first = resolveSdkSession(input);
    await Promise.resolve();
    saveSettings({ composioSdkPolicy: { allowedApps: [] } });
    const second = resolveSdkSession(input);
    const refused = Promise.all([assert.rejects(first, /policy changed/), assert.rejects(second, /policy changed/)]);
    release();
    await refused;
    await resolveSdkSession(input);
    assert.deepEqual(updates[0].toolkits, { enable: [] }, "the next attempt repairs the persisted session");
  } finally { release(); saveSettings({ composioSdkPolicy: {} }); }
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
