import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { activityConnectionInventory, activityConnectionApps: loadApps, createActivityConnection, deleteActivityConnection } = await import("../src/gateway/activity-connections.js");
const { saveSettings } = await import("../src/config/settings.js");
const activityConnectionApps = (input, options) => loadApps({ ownerId: "UOWNER", teamId: "TTEAM", ...input }, options);
const policy = (allowedApps = null) => ({ multiAccount: true, maxAccountsPerToolkit: 3, allowedApps });
const config = (overrides = {}) => ({ mode: "sdk", sdkApiKey: "ak_private_fixture", policy: policy(), ...overrides });
const input = (overrides = {}) => ({ ownerId: "UOWNER", teamId: "TTEAM", sessionId: "session", callbackUrl: "https://gateway.example/activity/session/settings/connections", app: "gmail", alias: "work", authorize: async () => {}, ...overrides });
const toolkit = (slug, overrides = {}) => ({ slug, name: slug, meta: { description: "Description" }, no_auth: false, ...overrides });
const api = (data, status = 200) => Response.json(data, { status });

test("catalog preserves provider pagination, custom apps and strips credentials and arbitrary metadata", async () => {
  const calls = [];
  const result = await activityConnectionApps({ query: "mail", cursor: "opaque-next" }, {
    getConfig: () => config(), fetch: async (url, init) => {
      calls.push({ url, init });
      return api({ items: [toolkit("gmail"), toolkit("custom_test", { name: "<script>app</script>", auth: { secret: "never" } })], next_cursor: "page-2" });
    },
  });
  assert.deepEqual(result.apps.map(a => a.slug), ["gmail", "custom_test"]);
  assert.equal(result.nextCursor, "page-2");
  assert.equal(calls[0].url.origin, "https://backend.composio.dev");
  assert.equal(calls[0].url.searchParams.get("cursor"), "opaque-next");
  assert.equal(calls[0].url.searchParams.get("search"), "mail");
  assert.equal(calls[0].init.redirect, "error");
  assert.doesNotMatch(JSON.stringify(result), /ak_private_fixture|auth|never/);
});

test("selected catalog uses owner visibility and filters unexpected provider rows", async () => {
  let params;
  const result = await activityConnectionApps({ query: "gmail" }, {
    getConfig: () => config({ policy: policy(["gmail", "custom_test"]) }),
    fetch: async (url, init) => { assert.equal(url.pathname, "/api/v3.1/toolkits"); params = url.searchParams;
      return api({ items: [toolkit("gmail"), toolkit("slack"), toolkit("custom_test")], next_cursor: null }); },
  });
  assert.equal(params.get("user_id"), "slack:TTEAM:user:UOWNER");
  assert.deepEqual(result.apps.map(a => a.slug), ["gmail", "custom_test"]);
  const empty = await activityConnectionApps({}, { getConfig: () => config({ policy: policy([]) }), fetch: () => assert.fail("deny-all must not fetch all apps") });
  assert.deepEqual(empty, { apps: [], nextCursor: null });
});

test("no-auth and deprecated apps explain why no connection can be created", async () => {
  const result = await activityConnectionApps({}, { getConfig: () => config(), fetch: async () => api({ items: [toolkit("public_app", { no_auth: true }), toolkit("retired", { deprecated: true })] }) });
  assert.ok(result.apps.every(a => a.canConnect === false && a.reason));
  const normal = await activityConnectionApps({}, { getConfig: () => config(), fetch: async () => api({ items: [toolkit("gmail", { deprecated: { toolkitId: "legacy-id" } })] }) });
  assert.equal(normal.apps[0].canConnect, true, "legacy metadata is not a retirement flag");
});

test("real provider underscore slugs remain available and excluded catalog pages are skipped", async () => {
  const cursors = [];
  const result = await activityConnectionApps({}, { getConfig: () => config({ policy: policy(["_1password", "gmail"]) }), fetch: async url => {
    assert.equal(url.searchParams.get("user_id"), "slack:TTEAM:user:UOWNER");
    const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
    return api(cursor ? { items: [toolkit("_1password")], next_cursor: null } : { items: [toolkit("slack")], next_cursor: "allowed-page" });
  } });
  assert.deepEqual(cursors, [null, "allowed-page"]);
  assert.deepEqual(result.apps.map(a => a.slug), ["_1password"]);
});

test("personal mode, missing key and Enterprise expiry refuse catalog/creation before contacting provider", async () => {
  for (const c of [config({ mode: "personal" }), config({ sdkApiKey: "" })]) {
    const options = { getConfig: () => c, fetch: () => assert.fail("no fetch"), resolveSession: () => assert.fail("no session") };
    await assert.rejects(activityConnectionApps({}, options), /SDK mode|key/);
    await assert.rejects(createActivityConnection(input(), options), /SDK mode|key/);
  }
  try {
    clearTestLicense();
    await assert.rejects(activityConnectionApps({}, { getConfig: () => config() }), /Enterprise/);
    await assert.rejects(createActivityConnection(input(), { getConfig: () => config() }), /Enterprise/);
  } finally { testLicenseEnv(); }
});

test("catalog time/provider/pagination/size errors fail closed without exposing raw provider messages", async () => {
  for (const fetch of [async () => api({ error: "ak_private_fixture secret" }, 500), async () => api({ items: [], next_cursor: "same" }), async () => api({ items: [toolkit("invalid slug")] }), async () => new Response("x".repeat(2_000_001))]) {
    await assert.rejects(activityConnectionApps({ cursor: "same" }, { getConfig: () => config(), fetch }), error => error.status === 503 && !/private_fixture|secret/.test(error.message));
  }
  for (const query of [["array"], "x".repeat(121)]) await assert.rejects(activityConnectionApps({ query }, { getConfig: () => config() }), /Invalid app search/);
});

test("a policy save while catalog is in flight cannot publish older availability", async () => {
  let current = config();
  await assert.rejects(activityConnectionApps({}, { getConfig: () => current, fetch: async () => { current = config({ policy: policy([]) }); return api({ items: [toolkit("gmail")] }); } }), /settings changed/);
});

test("create binds exact authenticated owner, workspace, callback and alias with private defaults", async () => {
  const calls = []; let checks = 0;
  const result = await createActivityConnection(input({ authorize: async () => { checks++; } }), {
    getConfig: () => config(),
    resolveSession: async opts => { calls.push(opts); return { sessionId: "trs_owned" }; },
    sdkClient: { sessions: { use: async id => { assert.equal(id, "trs_owned"); return { authorize: async (app, opts, requestOptions) => {
      calls.push({ app, opts }); assert.equal(requestOptions.maxRetries, 0); return { redirectUrl: "https://connect.composio.dev/link/owned" };
    } }; } } },
  });
  assert.equal(calls[0].workspaceId, "TTEAM"); assert.equal(calls[0].id, "UOWNER"); assert.equal(calls[0].kind, "user");
  assert.equal(calls[0].threadKey, "activity-connections:session"); assert.equal(calls[0].manageConnections, true);
  assert.deepEqual(calls[1], { app: "gmail", opts: { alias: "work", callbackUrl: input().callbackUrl } });
  assert.equal(checks, 3); assert.deepEqual(result, { redirectUrl: "https://connect.composio.dev/link/owned" });
  assert.doesNotMatch(JSON.stringify(result), /ak_private_fixture|trs_owned|owner|callback|client/);
});

test("disallowed app, malformed aliases and concurrent creation cannot initiate extra links", async () => {
  const options = { getConfig: () => config({ policy: policy([]) }), resolveSession: () => assert.fail("no session") };
  await assert.rejects(createActivityConnection(input(), options), /not available/);
  for (const values of [{ app: "GMAIL" }, { app: "../gmail" }, { alias: "x".repeat(81) }, { alias: "hidden\nline" }]) await assert.rejects(createActivityConnection(input(values), options), /Choose an app/);
  let release; const held = new Promise(done => { release = done; });
  const pending = createActivityConnection(input(), { getConfig: () => config(), resolveSession: async () => { await held; throw new Error("fixture failure"); }, sdkClient: {} });
  await assert.rejects(createActivityConnection(input(), { getConfig: () => config() }), /already in progress/);
  release(); await assert.rejects(pending, /could not be created/);
});

test("revocation and a policy change after preparation prevent provider authorize", async () => {
  for (const change of ["role", "policy"]) {
    let checks = 0, current = config();
    await assert.rejects(createActivityConnection(input({ authorize: async () => { if (++checks === 2 && change === "role") throw Object.assign(new Error("revoked"), { status: 403 }); } }), {
      getConfig: () => current, resolveSession: async () => { if (change === "policy") current = config({ policy: policy([]) }); return { sessionId: "trs_owned" }; },
      sdkClient: { sessions: { use: async () => ({ authorize: () => assert.fail("revoked before link") }) } },
    }), /session has ended|settings changed/);
  }
});

test("untrusted link destinations and raw provider errors never escape to the browser", async () => {
  for (const redirectUrl of ["http://connect.composio.dev/link/x", "https://evil.example/link/x", "https://user:pass@connect.composio.dev/link/x", "https://connect.composio.dev:444/link/x"]) {
    await assert.rejects(createActivityConnection(input(), { getConfig: () => config(), resolveSession: async () => ({ sessionId: "trs" }), sdkClient: { sessions: { use: async () => ({ authorize: async () => ({ redirectUrl }) }) } } }), error => error.status === 503 && !error.message.includes(redirectUrl));
  }
});

test("a preparation timeout cancels SDK work and releases the owner creation lock", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let signal;
    await assert.rejects(createActivityConnection(input(), { getConfig: () => config(), timeoutMs: 20, sdkClient: { sessions: {
      create: async (_id, _policy, options) => { signal = options.signal; assert.equal(options.maxRetries, 0);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
    } } }), /link could not be created/);
    assert.equal(signal.aborted, true);
    const result = await createActivityConnection(input(), { getConfig: () => config(), resolveSession: async () => ({ sessionId: "trs_retry" }), sdkClient: { sessions: { use: async () => ({ authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link/retry" }) }) } } });
    assert.ok(result.redirectUrl.endsWith("retry"));
  } finally { clearTimeout(keepAlive); }
});

test("inventory delegates only the selected personal record, never an org token", async () => {
  saveSettings({ composioMode: "personal" });
  let selection;
  const result = await activityConnectionInventory({ ownerId: "UOWNER", teamId: "TTEAM" }, { getUser: async id => ({ name: id, composioToken: "personal-private-token" }), getConfig: () => config({ mode: "personal" }), inventory: async input => { selection = input; return { mode: "personal", state: "ready", accounts: [{ app: "gmail" }] }; } });
  assert.equal(selection.kind, "user"); assert.equal(selection.id, "UOWNER"); assert.equal(selection.record.composioToken, "personal-private-token");
  assert.equal(result.canAdd, false); assert.doesNotMatch(JSON.stringify(result), /personal-private-token/);
});

const ownAccount = overrides => ({ id: "ca_owned", user_id: "slack:TTEAM:user:UOWNER", toolkit: { slug: "gmail" }, experimental: { account_type: "PRIVATE" }, ...overrides });
const deleteInput = overrides => ({ ownerId: "UOWNER", teamId: "TTEAM", connectionId: "ca_owned", authorize: async () => {}, ...overrides });
test("SDK delete verifies exact private owner then deletes one account without revoking upstream credentials", async () => {
  const calls = []; let authorized = 0;
  assert.deepEqual(await deleteActivityConnection(deleteInput({ authorize: async () => { authorized++; } }), {
    getConfig: () => config(), fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return api(init.method === "DELETE" ? { success: true } : ownAccount());
    },
  }), { deleted: true });
  assert.equal(authorized, 3); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://backend.composio.dev/api/v3.1/connected_accounts/ca_owned");
  assert.equal(calls[1].url, calls[0].url); assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].init.redirect, "error"); assert.ok(calls[1].init.signal instanceof AbortSignal);
  assert.doesNotMatch(calls[1].url, /revoke|user_id/);
});
test("SDK delete refuses other owners, shared accounts, omitted ownership and mismatched IDs without mutation", async () => {
  for (const account of [ownAccount({ user_id: "slack:TTEAM:user:UOTHER" }), ownAccount({ experimental: { account_type: "SHARED" } }), ownAccount({ user_id: undefined }), ownAccount({ experimental: undefined }), ownAccount({ id: "ca_else" })]) {
    await assert.rejects(deleteActivityConnection(deleteInput(), { getConfig: () => config(), fetch: async (_url, init) => {
      assert.notEqual(init.method, "DELETE"); return api(account);
    } }), error => error.status === 404 && !error.message.includes("UOTHER"));
  }
  for (const connectionId of ["../ca_else", "bad/id", "ca?revoke_on_delete=true", ["ca_owned"], "x".repeat(161)]) {
    await assert.rejects(deleteActivityConnection(deleteInput({ connectionId }), { getConfig: () => config(), fetch: () => assert.fail("invalid ID cannot fetch") }), /valid connection/);
  }
});
test("SDK deletion rechecks Activity access and configuration immediately before mutation", async () => {
  for (const change of ["token", "policy", "mode", "access"]) {
    let current = config(), checks = 0;
    await assert.rejects(deleteActivityConnection(deleteInput({ authorize: async () => {
      if (++checks === 2 && change === "access") throw Object.assign(new Error("revoked"), { status: 401 });
    } }), { getConfig: () => current, fetch: async (_url, init) => {
      assert.notEqual(init.method, "DELETE");
      if (change === "token") current = config({ sdkApiKey: "rotated-secret" });
      if (change === "policy") current = config({ policy: policy([]) });
      if (change === "mode") current = config({ mode: "personal" });
      return api(ownAccount());
    } }), /settings changed|SDK mode|session has ended/);
  }
});
test("SDK missing and failed deletions do not expose provider details or claim success", async () => {
  for (const [status, result] of [[404, {}], [500, { error: "ak_private_fixture upstream-secret" }], [200, { success: false }]]) {
    await assert.rejects(deleteActivityConnection(deleteInput(), { getConfig: () => config(), fetch: async (_url, init) => api(init.method === "DELETE" ? result : ownAccount(), init.method === "DELETE" ? status : 200) }), error => [404, 503].includes(error.status) && !/upstream-secret|private_fixture/.test(error.message));
  }
});
test("SDK duplicate delete is refused while in flight and its lock releases after failure", async () => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const pending = deleteActivityConnection(deleteInput(), { getConfig: () => config(), fetch: async () => { enter(); await gate; throw new Error("fixture"); } });
  await entered;
  await assert.rejects(deleteActivityConnection(deleteInput(), { getConfig: () => config() }), error => error.status === 409);
  release(); await assert.rejects(pending, error => error.status === 503);
  await assert.rejects(deleteActivityConnection(deleteInput(), { getConfig: () => config(), fetch: async () => api({}, 404) }), error => error.status === 404);
});
test("SDK inventory joins paginated raw ownership evidence and fails closed on in-flight policy changes", async () => {
  const visible = [{ id: "ca_owned", app: "gmail" }, { id: "ca_other", app: "slack" }, { id: "ca_shared", app: "gmail" }];
  let current = config(); const calls = [];
  const options = { getConfig: () => current, getUser: async () => ({}), inventory: async () => ({ mode: "sdk", state: "ready", accounts: visible }), fetch: async url => {
    calls.push(url); assert.equal(url.searchParams.get("user_ids"), "slack:TTEAM:user:UOWNER"); assert.equal(url.searchParams.get("account_type"), "PRIVATE");
    return api(url.searchParams.has("cursor") ? { items: [ownAccount({ id: "ca_other", user_id: "another-user", toolkit: { slug: "slack" } })] } : { items: [ownAccount(), ownAccount({ id: "ca_shared", experimental: { account_type: "SHARED" } })], next_cursor: "page2" });
  } };
  const result = await activityConnectionInventory({ ownerId: "UOWNER", teamId: "TTEAM" }, options);
  assert.deepEqual(result.accounts.map(a => a.canDelete), [true, false, false]); assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /user_id|another-user|private_fixture/);
  const changed = await activityConnectionInventory({ ownerId: "UOWNER", teamId: "TTEAM" }, { ...options, fetch: async () => { current = config({ policy: policy([]) }); return api({ items: [ownAccount()] }); } });
  assert.ok(changed.accounts.every(a => a.canDelete === false));
});

const consumerTools = () => [{ name: "COMPOSIO_SEARCH_TOOLS" }, { name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: { properties: { toolkits: { items: { properties: {
  action: { enum: ["list", "remove"] }, account_id: { type: "string" },
} } } } } }];
const personalInventory = () => ({ mode: "personal", state: "ready", accounts: [{ id: "gmail_owned", app: "gmail", accountType: "PRIVATE" }] });
const personalOptions = (overrides = {}) => ({ getConfig: () => config({ mode: "personal" }), getUser: async () => ({ composioToken: "consumer-secret" }), inventory: async () => personalInventory(), ...overrides });
function consumerFixture({ listing = [{ id: "gmail_owned", account_type: "PRIVATE" }], tools = consumerTools(), onCall = () => {}, outcome = "removed" } = {}) {
  const calls = []; let closed = 0, removed = false;
  return { calls, get closed() { return closed; }, connect: async args => {
    assert.deepEqual(args.headers, { "x-consumer-api-key": "consumer-secret" }); assert.equal(args.publicOnly, true);
    return { close: async () => { closed++; }, listTools: async () => ({ tools }), callTool: async call => {
      calls.push(call); await onCall(call);
      if (call.name === "COMPOSIO_SEARCH_TOOLS") return { data: { session: { id: "session" } } };
      const entry = call.arguments.toolkits[0];
      const accounts = removed ? [] : listing;
      if (entry.action === "remove" && outcome === "removed") removed = true;
      return { data: { results: { gmail: { toolkit: "gmail", status: entry.action === "list" ? "active" : outcome, accounts } } } };
    } };
  } };
}
test("personal delete uses the selected consumer token, verified private list and exact stable account ID", async () => {
  const consumer = consumerFixture(); let checks = 0;
  const result = await deleteActivityConnection(deleteInput({ connectionId: "gmail_owned", authorize: async () => { checks++; } }), personalOptions({ connect: consumer.connect }));
  assert.deepEqual(result, { deleted: true }); assert.ok(checks >= 4); assert.equal(consumer.closed, 1);
  assert.deepEqual(consumer.calls.map(call => call.name), ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MANAGE_CONNECTIONS"]);
  assert.deepEqual(consumer.calls[2].arguments, { session_id: "session", toolkits: [{ name: "gmail", action: "remove", account_id: "gmail_owned" }] });
});
test("personal shared, missing, ambiguous, and unverified accounts cannot be removed", async () => {
  for (const listing of [[{ id: "gmail_owned", account_type: "SHARED" }], [{ id: "gmail_owned" }], [{ id: "gmail_other", account_type: "PRIVATE" }], [{ id: "gmail_owned", account_type: "PRIVATE" }, { id: "gmail_owned", account_type: "PRIVATE" }]]) {
    const consumer = consumerFixture({ listing });
    await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ connect: consumer.connect })), error => error.status === 404);
    assert.equal(consumer.calls.some(call => call.arguments.toolkits?.[0]?.action === "remove"), false);
  }
  await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ inventory: async () => ({ ...personalInventory(), accounts: [{ id: "gmail_owned", app: "gmail", accountType: "SHARED" }] }), connect: () => assert.fail("no discovery for shared account") })), error => error.status === 404);
});
test("personal unsupported remove schema and token or session revocation stop deletion", async () => {
  const unsupported = consumerFixture({ tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] });
  await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ connect: unsupported.connect })), error => error.status === 409);
  assert.equal(unsupported.calls.length, 0);
  for (const reason of ["token", "access", "mode"]) {
    let token = "consumer-secret", mode = "personal", revoked = false;
    const consumer = consumerFixture({ onCall: call => {
      if (call.arguments.toolkits?.[0]?.action === "list") {
        if (reason === "token") token = "different-consumer";
        if (reason === "mode") mode = "sdk";
        if (reason === "access") revoked = true;
      }
    } });
    await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned", authorize: async () => { if (revoked) throw Object.assign(new Error("ended"), { status: 403 }); } }), personalOptions({ getConfig: () => config({ mode }), getUser: async () => ({ composioToken: token }), connect: consumer.connect })), error => [403, 409].includes(error.status));
    assert.equal(consumer.calls.some(call => call.arguments.toolkits?.[0]?.action === "remove"), false);
  }
});
test("personal inventory offers deletion only for PRIVATE accounts with supported provider schema", async () => {
  const consumer = consumerFixture();
  const result = await activityConnectionInventory({ ownerId: "UOWNER", teamId: "TTEAM" }, personalOptions({ connect: consumer.connect }));
  assert.equal(result.accounts[0].canDelete, true);
  const unsupported = consumerFixture({ tools: [] });
  const readOnly = await activityConnectionInventory({ ownerId: "UOWNER", teamId: "TTEAM" }, personalOptions({ connect: unsupported.connect }));
  assert.equal(readOnly.accounts[0].canDelete, false);
});
test("a late consumer discovery cannot remove an account after its bounded request has timed out", async () => {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const pending = deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ timeoutMs: 20, connect: async () => ({
    listTools: async () => { await held; return { tools: consumerTools() }; },
    close: async () => {}, callTool: async () => { calls++; return {}; },
  }) }));
  await assert.rejects(pending, error => error.status === 503);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});
test("personal errors and unconfirmed remove outcomes never report deletion or expose credentials", async () => {
  const consumer = consumerFixture({ outcome: "ak_private_fixture consumer-secret error" });
  await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ connect: consumer.connect })), error => error.status === 503 && !/consumer-secret|private_fixture/.test(error.message));
  await assert.rejects(deleteActivityConnection(deleteInput({ connectionId: "gmail_owned" }), personalOptions({ getUser: async () => ({}), connect: () => assert.fail("no organization fallback") })), error => error.status === 409);
});
