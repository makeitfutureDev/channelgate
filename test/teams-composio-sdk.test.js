import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
testLicenseEnv();
const [{ composioIdentity, composioSubjectPlatform }, { composioWorkspaceId, composioWorkspaceMissing }, { resolveSdkSession }, { saveSettings }, { resolveRunIntegrations }, { loadComposioInventory }] = await Promise.all([
  import("../src/ee/composio-sessions.js"),
  import("../src/gateway/composio-workspace.js"),
  import("../src/ee/composio-sdk.js"),
  import("../src/config/settings.js"),
  import("../src/gateway/run-integrations.js"),
  import("../src/gateway/composio-inventory.js"),
]);

const TENANT = "6F1C2A3B-1111-4222-8333-944455556666";
const AUTHOR = "29:1AbC-dEf_GhIjKlMnOp";
const CHANNEL = "teams:19:Q3plan@thread.tacv2";

test("Teams authors and conversations get tenant-scoped Composio identities; Slack ones are unchanged", () => {
  assert.equal(composioIdentity({ workspaceId: "T1", kind: "user", id: "U1" }), "slack:T1:user:U1");
  assert.equal(composioIdentity({ workspaceId: "T1", kind: "channel", id: "C1" }), "slack:T1:channel:C1");
  assert.equal(composioIdentity({ workspaceId: TENANT, kind: "user", id: AUTHOR }), `msteams:${TENANT.toLowerCase()}:user:${AUTHOR}`);
  assert.equal(composioIdentity({ workspaceId: TENANT, kind: "channel", id: CHANNEL }), `msteams:${TENANT.toLowerCase()}:channel:19:Q3plan@thread.tacv2`);
  assert.equal(composioSubjectPlatform({ kind: "user", id: AUTHOR }), "msteams");
  assert.equal(composioSubjectPlatform({ kind: "channel", id: "C1" }), "slack");
  assert.throws(() => composioIdentity({ workspaceId: "T1", kind: "user", id: AUTHOR }), /Microsoft Teams tenant/, "a Slack team never stands in for a tenant");
  assert.throws(() => composioIdentity({ workspaceId: TENANT, kind: "channel", id: "teams:19:x y" }), /Microsoft Teams channel identifier/);
  assert.throws(() => composioIdentity({ workspaceId: TENANT, kind: "channel", id: "teams:" }), /Microsoft Teams channel identifier/);
  assert.throws(() => composioIdentity({ workspaceId: TENANT, kind: "user", id: "29:a/b" }), /invalid Composio (workspace|user) identifier/, "not a Teams id falls back to Slack rules and fails them");
});

test("the workspace of a Teams subject is the configured tenant, of a Slack subject the Slack team", () => {
  saveSettings({ teamsTenantId: TENANT });
  assert.equal(composioWorkspaceId({ kind: "user", id: AUTHOR, slackTeamId: "T1" }), TENANT);
  assert.equal(composioWorkspaceId({ kind: "channel", id: CHANNEL }), TENANT);
  assert.equal(composioWorkspaceId({ kind: "user", id: "U1", slackTeamId: "T1" }), "T1");
  assert.match(composioWorkspaceMissing({ kind: "channel", id: CHANNEL }), /Microsoft Teams tenant ID/);
  assert.match(composioWorkspaceMissing({ kind: "channel", id: "C1" }), /Slack workspace/);
});

function fakeClient(calls) {
  const remote = id => ({ sessionId: id, update: async () => {}, mcp: { url: `https://backend.composio.dev/tool_router/v3/${id}/mcp` } });
  return { sessions: { create: async (identity, config) => { calls.push({ identity, config }); return remote(`trs_${calls.length}`); }, use: async id => remote(id) } };
}

test("an SDK session for a Teams author is created under the Teams identity", async () => {
  const calls = [];
  const endpoint = await resolveSdkSession({ workspaceId: TENANT, kind: "user", id: AUTHOR, threadKey: "teams-thread-1",
    accessKind: "owner", manageConnections: true, client: fakeClient(calls) });
  assert.equal(endpoint.mode, "sdk");
  assert.equal(calls[0].identity, `msteams:${TENANT.toLowerCase()}:user:${AUTHOR}`);
});

test("a Teams turn in SDK mode resolves both Composio identities from the tenant", async () => {
  saveSettings({ teamsTenantId: TENANT, composioMode: "sdk", composioSdkApiKey: "ak_teams_fixture" });
  const { setUser } = await import("../src/config/store.js");
  await setUser(AUTHOR, { name: "Teams author", approved: true, platform: "msteams" });
  const ee = await import("../src/ee/composio-sdk.js");
  const created = [];
  // The run path uses the production SDK client; intercept its HTTP calls at the edge.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: "0.22.0" });
    const body = ["POST", "PATCH"].includes(request.method) ? await request.json() : null;
    if (body?.user_id) created.push(body.user_id);
    const id = `trs_${created.length || 1}`;
    return Response.json({ session_id: id, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/v3/${id}/mcp` },
      config: { user_id: body?.user_id || "x", manage_connections: { enable: false } } });
  };
  try {
    const result = await resolveRunIntegrations({ meta: { channelId: CHANNEL, access: "approved" }, channelId: CHANNEL, authorId: AUTHOR, threadKey: "1700000000001" });
    assert.equal(result.composio.mode, "sdk");
    assert.equal(result.composio.user.source, "sdk-user");
    assert.equal(result.composio.shared.source, "sdk-channel");
    assert.deepEqual(created.sort(), [`msteams:${TENANT.toLowerCase()}:channel:19:Q3plan@thread.tacv2`, `msteams:${TENANT.toLowerCase()}:user:${AUTHOR}`].sort());
    assert.ok(result.composioUserEndpoint?.url && result.composioEndpoint?.url);
    assert.ok(ee.resolveSdkSession);
  } finally {
    globalThis.fetch = originalFetch;
    saveSettings({ composioMode: "personal" });
  }
});

test("the connection inventory of a Teams subject names the missing tenant instead of the Slack workspace", async () => {
  saveSettings({ teamsTenantId: "" });
  const result = await loadComposioInventory({ kind: "channel", id: CHANNEL, record: {} },
    { config: { mode: "sdk", sdkApiKey: "ak_fixture", workspaceId: "T1" }, requireEntitlement: () => {} });
  assert.equal(result.state, "unavailable");
  assert.match(result.message, /Microsoft Teams tenant ID/);
  saveSettings({ teamsTenantId: TENANT });
});
