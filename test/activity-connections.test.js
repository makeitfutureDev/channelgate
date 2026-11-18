import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { activityConnectionInventory, activityConnectionApps: loadApps, createActivityConnection } = await import("../src/gateway/activity-connections.js");
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
