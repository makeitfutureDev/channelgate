import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
testLicenseEnv();
const [{ composioIdentity, composioSubjectPlatform }, workspace, { resolveSdkSession }, settings, { resolveRunIntegrations }, { loadComposioInventory }, store, activity] = await Promise.all([
  import("../src/ee/composio-sessions.js"),
  import("../src/gateway/composio-workspace.js"),
  import("../src/ee/composio-sdk.js"),
  import("../src/config/settings.js"),
  import("../src/gateway/run-integrations.js"),
  import("../src/gateway/composio-inventory.js"),
  import("../src/config/store.js"),
  import("../src/gateway/activity-connections.js"),
]);
const { composioWorkspaceId, composioWorkspaceMissing, composioSubject, GOOGLE_CHAT_AUTHOR_UNRECORDED } = workspace;
const { saveSettings, googleChatProjectId } = settings;

const PROJECT = "cg-chat-app-4821";
const KEY = JSON.stringify({ type: "service_account", project_id: PROJECT, client_email: `chat-bot@${PROJECT}.iam.gserviceaccount.com` });
const EMAIL = "ana@example.com";
const RESOURCE = "users/108374615293847561234";
const SPACE = "gchat:spaces/AAAAq1w2E3r";
const DM = "gchat:spaces/DMaaa1bb2";

test("Google Chat authors and spaces get project-scoped Composio identities; Slack and Teams ones are unchanged", () => {
  assert.equal(composioIdentity({ workspaceId: "T1", kind: "user", id: "U1" }), "slack:T1:user:U1");
  assert.equal(composioIdentity({ workspaceId: "T1", kind: "channel", id: "C1" }), "slack:T1:channel:C1");
  const tenant = "6f1c2a3b-1111-4222-8333-944455556666";
  assert.equal(composioIdentity({ workspaceId: tenant, kind: "user", id: "29:1AbC" }), `msteams:${tenant}:user:29:1AbC`);
  assert.equal(composioIdentity({ workspaceId: tenant, kind: "channel", id: "teams:19:x@thread.tacv2" }), `msteams:${tenant}:channel:19:x@thread.tacv2`);
  assert.equal(composioIdentity({ workspaceId: PROJECT, kind: "user", id: RESOURCE }), `googlechat:${PROJECT}:user:${RESOURCE}`);
  assert.equal(composioIdentity({ workspaceId: PROJECT, kind: "channel", id: SPACE }), `googlechat:${PROJECT}:channel:spaces/AAAAq1w2E3r`);
  assert.equal(composioSubjectPlatform({ kind: "user", id: RESOURCE }), "googlechat");
  assert.equal(composioSubjectPlatform({ kind: "user", id: EMAIL }), "googlechat");
  assert.equal(composioSubjectPlatform({ kind: "channel", id: SPACE }), "googlechat");
  assert.equal(composioSubjectPlatform({ kind: "channel", id: "C1" }), "slack");
  // The e-mail is never an identity: it can be renamed or reassigned to another person.
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "user", id: EMAIL }), /Google Chat user identifier/);
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "user", id: "users/a/b" }), /Google Chat user identifier/);
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "channel", id: "gchat:spaces/x y" }), /Google Chat channel identifier/);
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "channel", id: "gchat:spaces/A/messages/B" }), /Google Chat channel identifier/);
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "channel", id: "gchat:" }), /Google Chat channel identifier/);
  for (const workspaceId of ["T1", tenant, "Cg-Chat-App", "example.com:legacy-project", "", "a:b"]) {
    assert.throws(() => composioIdentity({ workspaceId, kind: "user", id: RESOURCE }), /Google Chat project identifier/, workspaceId);
  }
  // A Google Chat project never stands in for a Slack team or a Teams tenant.
  assert.throws(() => composioIdentity({ workspaceId: PROJECT, kind: "user", id: "29:1AbC" }), /Microsoft Teams tenant/);
  assert.throws(() => composioIdentity({ workspaceId: "cg-chat-app-4821", kind: "user", id: "U1" }), /workspace identifier/);
});

test("the workspace of a Google Chat subject is the service account's Cloud project", () => {
  saveSettings({ googleChatServiceAccountJson: "" });
  assert.equal(googleChatProjectId(), "");
  assert.equal(composioWorkspaceId({ kind: "channel", id: SPACE, slackTeamId: "T1" }), "");
  assert.match(composioWorkspaceMissing({ kind: "user", id: EMAIL }), /Google Cloud project ID.*Settings → Google Chat/);
  saveSettings({ googleChatServiceAccountJson: "not json" });
  assert.equal(googleChatProjectId(), "");
  saveSettings({ googleChatServiceAccountJson: KEY });
  assert.equal(googleChatProjectId(), PROJECT);
  assert.equal(composioWorkspaceId({ kind: "channel", id: SPACE, slackTeamId: "T1" }), PROJECT);
  assert.equal(composioWorkspaceId({ kind: "user", id: RESOURCE }), PROJECT);
  assert.equal(composioWorkspaceId({ kind: "user", id: "U1", slackTeamId: "T1" }), "T1");
  assert.match(composioWorkspaceMissing({ kind: "channel", id: "C1" }), /Slack workspace/);
});

test("a Google Chat author is named by the recorded users/<id>, never by e-mail; unknown resolves to no subject", async () => {
  saveSettings({ googleChatServiceAccountJson: KEY });
  const users = { [EMAIL]: { googleChatUserName: RESOURCE }, "bo@example.com": {}, "eve@example.com": { googleChatUserName: "users/x y" } };
  const loadUser = async id => users[id] || null;
  assert.deepEqual(await composioSubject({ kind: "user", id: EMAIL }, { loadUser }), { workspaceId: PROJECT, id: RESOURCE, missing: "" });
  assert.deepEqual(await composioSubject({ kind: "user", id: RESOURCE }, { loadUser: () => assert.fail("no lookup") }), { workspaceId: PROJECT, id: RESOURCE, missing: "" });
  for (const id of ["bo@example.com", "eve@example.com", "nobody@example.com"]) {
    assert.deepEqual(await composioSubject({ kind: "user", id }, { loadUser }), { workspaceId: PROJECT, id: "", missing: GOOGLE_CHAT_AUTHOR_UNRECORDED });
  }
  assert.deepEqual(await composioSubject({ kind: "channel", id: SPACE }, { loadUser: () => assert.fail("no lookup") }), { workspaceId: PROJECT, id: SPACE, missing: "" });
  assert.deepEqual(await composioSubject({ kind: "user", id: "U1", slackTeamId: "T1" }, { loadUser: () => assert.fail("no lookup") }), { workspaceId: "T1", id: "U1", missing: "" });
});

function fakeClient(calls) {
  const remote = id => ({ sessionId: id, update: async () => {}, mcp: { url: `https://backend.composio.dev/tool_router/v3/${id}/mcp` } });
  return { sessions: { create: async (identity, config) => { calls.push({ identity, config }); return remote(`trs_${calls.length}`); }, use: async id => remote(id) } };
}

test("an SDK session for a Google Chat author is created under the Google Chat identity", async () => {
  const calls = [];
  const endpoint = await resolveSdkSession({ workspaceId: PROJECT, kind: "user", id: RESOURCE, threadKey: "spaces/AAAAq1w2E3r/threads/t0",
    accessKind: "owner", manageConnections: true, client: fakeClient(calls) });
  assert.equal(endpoint.mode, "sdk");
  assert.equal(calls[0].identity, `googlechat:${PROJECT}:user:${RESOURCE}`);
  await assert.rejects(resolveSdkSession({ workspaceId: PROJECT, kind: "user", id: EMAIL, threadKey: "t", accessKind: "owner", client: fakeClient([]) }), /Google Chat user identifier/);
});

// The run path uses the production SDK client; intercept its HTTP calls at the edge.
async function withComposioHttp(work) {
  const created = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: "0.22.0" });
    const body = ["POST", "PATCH"].includes(request.method) ? await request.json() : null;
    if (body?.user_id) created.push(body.user_id);
    const id = `trs_g${created.length || 1}`;
    return Response.json({ session_id: id, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/v3/${id}/mcp` },
      config: { user_id: body?.user_id || "x", manage_connections: { enable: false } } });
  };
  try { return await work(created); }
  finally { globalThis.fetch = originalFetch; }
}

test("a Google Chat turn in SDK mode resolves both identities; a DM gets only the author's; no fallback between them", async () => {
  saveSettings({ googleChatServiceAccountJson: KEY, composioMode: "sdk", composioSdkApiKey: "ak_gchat_fixture" });
  await store.setUser(EMAIL, { name: "Ana", approved: true, platform: "googlechat", googleChatUserName: RESOURCE });
  await store.setUser("new@example.com", { name: "New", approved: true, platform: "googlechat" });
  try {
    await withComposioHttp(async created => {
      const space = await resolveRunIntegrations({ meta: { channelId: SPACE, access: "approved" }, channelId: SPACE, authorId: EMAIL, threadKey: "spaces/AAAAq1w2E3r/threads/t1" });
      assert.equal(space.composio.user.source, "sdk-user");
      assert.equal(space.composio.shared.source, "sdk-channel");
      assert.deepEqual([...created].sort(), [`googlechat:${PROJECT}:channel:spaces/AAAAq1w2E3r`, `googlechat:${PROJECT}:user:${RESOURCE}`].sort());
      assert.ok(space.composioUserEndpoint?.url && space.composioEndpoint?.url);
      assert.doesNotMatch(created.join(" "), /@/, "the e-mail never reaches Composio");

      created.length = 0;
      const dm = await resolveRunIntegrations({ meta: { channelId: DM, isDM: true }, channelId: DM, authorId: EMAIL, threadKey: DM });
      assert.equal(dm.composio.user.source, "sdk-user");
      assert.equal(dm.composio.shared.source, "none-dm");
      assert.equal(dm.composioEndpoint, null);
      assert.deepEqual(created, [`googlechat:${PROJECT}:user:${RESOURCE}`]);

      // An author whose users/<id> is not recorded gets no personal identity, and the shared one
      // is not offered in its place.
      created.length = 0;
      const unknown = await resolveRunIntegrations({ meta: { channelId: SPACE, access: "approved" }, channelId: SPACE, authorId: "new@example.com", threadKey: "spaces/AAAAq1w2E3r/threads/t2" });
      assert.equal(unknown.composio.user.source, "sdk-unavailable");
      assert.equal(unknown.composioUserEndpoint, null);
      assert.equal(unknown.composio.shared.source, "sdk-channel");
      assert.deepEqual(created, [`googlechat:${PROJECT}:channel:spaces/AAAAq1w2E3r`]);

      // The HTTP run API never names a personal identity, on Google Chat either.
      created.length = 0;
      const api = await resolveRunIntegrations({ meta: { channelId: SPACE, access: "approved" }, channelId: SPACE, authorId: EMAIL, threadKey: "t3", untrustedPrincipal: true });
      assert.equal(api.composio.user.source, "none-untrusted-principal");
      assert.deepEqual(created, [`googlechat:${PROJECT}:channel:spaces/AAAAq1w2E3r`]);
    });
  } finally {
    saveSettings({ composioMode: "personal" });
  }
});

test("the connection inventory names a Google Chat subject's identity, or what is missing", async () => {
  const options = (listed) => ({ config: { mode: "sdk", sdkApiKey: "ak_fixture", workspaceId: "T1" }, requireEntitlement: () => {},
    getUser: async id => (id === EMAIL ? { googleChatUserName: RESOURCE } : null),
    sdkClient: { connectedAccounts: { list: async query => { listed.push(...query.userIds); return { items: [] }; } } } });
  saveSettings({ googleChatServiceAccountJson: "" });
  let result = await loadComposioInventory({ kind: "channel", id: SPACE, record: {} }, options([]));
  assert.equal(result.state, "unavailable");
  assert.match(result.message, /Google Cloud project ID/);
  saveSettings({ googleChatServiceAccountJson: KEY });
  const listed = [];
  result = await loadComposioInventory({ kind: "user", id: EMAIL, record: {} }, options(listed));
  assert.equal(result.state, "ready");
  result = await loadComposioInventory({ kind: "channel", id: SPACE, record: {} }, options(listed));
  assert.equal(result.state, "ready");
  assert.deepEqual(listed, [`googlechat:${PROJECT}:user:${RESOURCE}`, `googlechat:${PROJECT}:channel:spaces/AAAAq1w2E3r`]);
  result = await loadComposioInventory({ kind: "user", id: "new@example.com", record: {} }, options([]));
  assert.equal(result.state, "unavailable");
  assert.equal(result.message, GOOGLE_CHAT_AUTHOR_UNRECORDED);
  result = await loadComposioInventory({ kind: "channel", id: DM, record: { isDM: true } }, options([]));
  assert.equal(result.source, "none-dm");
});

test("Activity connections for a Google Chat owner connect under the users/<id> identity and refuse an unrecorded one", async () => {
  saveSettings({ googleChatServiceAccountJson: KEY });
  const config = () => ({ mode: "sdk", sdkApiKey: "ak_private_fixture", policy: { multiAccount: true, maxAccountsPerToolkit: 3, allowedApps: null } });
  const getUser = async id => (id === EMAIL ? { approved: true, googleChatUserName: RESOURCE } : { approved: true });
  const calls = [];
  const input = ownerId => ({ ownerId, teamId: "TTEAM", sessionId: "session", callbackUrl: "https://gateway.example/activity/session/settings/connections", app: "gmail", alias: "", authorize: async () => {} });
  const result = await activity.createActivityConnection(input(EMAIL), {
    getConfig: config, getUser, resolveSession: async opts => { calls.push(opts); return { sessionId: "trs_owned" }; },
    sdkClient: { sessions: { use: async () => ({ authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link/owned" }) }) } },
  });
  assert.equal(result.redirectUrl, "https://connect.composio.dev/link/owned");
  assert.equal(calls[0].workspaceId, PROJECT);
  assert.equal(calls[0].id, RESOURCE);
  await assert.rejects(activity.createActivityConnection(input("new@example.com"), { getConfig: config, getUser,
    resolveSession: async () => assert.fail("no session for an unknown subject") }), error => error.status === 409 && error.message === GOOGLE_CHAT_AUTHOR_UNRECORDED);
  // Deleting checks ownership against the same users/<id> identity.
  const seen = [];
  await assert.rejects(activity.deleteActivityConnection({ ownerId: EMAIL, teamId: "TTEAM", connectionId: "ca_1", authorize: async () => {} }, {
    getConfig: config, getUser, fetch: async url => { seen.push(String(url)); return Response.json({ id: "ca_1", user_id: "slack:TTEAM:user:U1", experimental: { account_type: "PRIVATE" } }); },
  }), /not your private account/);
  assert.equal(seen.length, 1);
});
