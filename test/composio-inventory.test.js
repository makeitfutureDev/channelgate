import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { loadComposioInventory } = await import("../src/gateway/composio-inventory.js");
const config = { mode: "personal", defaultToken: "org-secret", url: "https://connect.composio.dev/mcp", workspaceId: "T123" };

function fixture({ apps = ["gmail", "slack"], search, pages } = {}) {
  const calls = [];
  let closed = 0;
  const client = {
    async listTools(params) {
      calls.push({ method: "list", params });
      if (pages) return pages(params);
      return { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: `User has manually connected the apps: ${apps.join(", ")}. Prefer these apps when intent is unclear.` }] };
    },
    async callTool(params, _schema, options) {
      calls.push({ method: "call", params, timeout: options.timeout });
      const app = params.arguments.queries[0].use_case.split(" ")[1];
      if (search) return search(app);
      return { content: [{ type: "text", text: JSON.stringify({ data: { successful: true, data: {
        toolkit_connection_statuses: [{ toolkit: app, has_active_connection: true, accounts: [
          { id: `${app}-1`, alias: "work", status: "ACTIVE", is_default: true, account_type: "PRIVATE", user_info: { email: "one@example.test", token: "provider-secret", data: ["business-record"] } },
          { id: `${app}-2`, alias: "personal", status: "EXPIRED", user_info: { user: { emailAddress: "two@example.test" } } },
        ] }, { toolkit: "unrelated", accounts: [{ id: "never-show" }] }],
      } } }) }] };
    },
    async close() { closed++; },
  };
  return { calls, client, closed: () => closed, connect: async (args) => { calls.push({ method: "connect", args }); return client; } };
}

test("personal inventory uses all published applications and accounts, exposes only safe metadata and closes", async () => {
  const remote = fixture();
  const result = await loadComposioInventory({ kind: "user", id: "U123", record: { composioToken: "user-secret", cleanMode: true } }, { config, connect: remote.connect, now: () => 0 });
  assert.equal(result.state, "ready");
  assert.equal(result.source, "user");
  assert.equal(result.checkedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(result.accounts.length, 4);
  assert.deepEqual(result.accounts[0], { app: "gmail", id: "gmail-1", alias: "work", account: "one@example.test", status: "ACTIVE", isDefault: true, accountType: "PRIVATE" });
  assert.equal(result.accounts[1].account, "two@example.test");
  assert.doesNotMatch(JSON.stringify(result), /secret|business-record|never-show|user_info/);
  assert.equal(remote.calls[0].args.headers["x-consumer-api-key"], "user-secret");
  assert.equal(remote.calls[0].args.publicOnly, true);
  assert.ok(remote.calls.filter((c) => c.method === "call").every((c) => c.params.name === "COMPOSIO_SEARCH_TOOLS"));
  assert.ok(remote.calls.filter((c) => c.method === "call").every((c) => c.params.arguments.session.generate_id === true));
  assert.equal(remote.closed(), 1);
});

test("personal scope matches runtime user-only, channel override, org fallback, no-default and DM rules", async () => {
  for (const [kind, record, expected, token] of [
    ["user", {}, "none", null],
    ["channel", { composioToken: "channel-secret" }, "channel", "channel-secret"],
    ["channel", {}, "org", "org-secret"],
    ["channel", { noDefaultTokens: true }, "none-no-org-default", null],
    ["channel", { isDM: true, composioToken: "channel-secret" }, "none-dm", null],
    ["channel", { type: "im" }, "none-dm", null],
  ]) {
    const remote = fixture({ apps: [] });
    const result = await loadComposioInventory({ kind, id: "C123", record }, { config, connect: remote.connect });
    assert.equal(result.source, expected);
    assert.equal(result.state, token ? "ready" : "unconfigured");
    assert.equal(remote.calls.find((c) => c.method === "connect")?.args.headers["x-consumer-api-key"] ?? null, token);
  }
});

test("tools/list pagination locates the publication and rejects repeated cursor", async () => {
  const remote = fixture({ pages: ({ cursor }) => cursor
    ? { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "User has manually connected the apps: gmail. Prefer these apps when intent is unclear." }] }
    : { tools: [], nextCursor: "page2" } });
  assert.equal((await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect })).state, "ready");
  assert.deepEqual(remote.calls.filter((c) => c.method === "list").map((c) => c.params), [{}, { cursor: "page2" }]);
  const looping = fixture({ pages: () => ({ tools: [], nextCursor: "same" }) });
  assert.equal((await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: looping.connect })).state, "unavailable");
  assert.equal(looping.closed(), 1);
});

test("truthy legacy DM and no-default flags suppress shared inventory exactly as runtime does", async () => {
  for (const [record, source] of [[{ noDefaultTokens: "legacy-true" }, "none-no-org-default"], [{ isDM: 1, composioToken: "channel-secret" }, "none-dm"]]) {
    const result = await loadComposioInventory({ kind: "channel", id: "C123", record }, {
      config, connect: async () => assert.fail("suppressed shared credentials must never be used"),
    });
    assert.equal(result.state, "unconfigured");
    assert.equal(result.source, source);
    assert.deepEqual(result.accounts, []);
  }
});

test("missing or invalid provider publication is unavailable instead of a false empty inventory", async () => {
  for (const description of ["search tools", "User has manually connected the apps: gmail, https://secret.invalid. Prefer these apps when intent is unclear."]) {
    const remote = fixture({ pages: () => ({ tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description }] }) });
    const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect });
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.accounts, []);
    assert.equal(remote.calls.filter((c) => c.method === "call").length, 0);
    assert.equal(remote.closed(), 1);
  }
});

test("one unresolved toolkit keeps successful metadata and returns partial without provider errors", async () => {
  const remote = fixture({ search: (app) => {
    if (app === "gmail") throw new Error("Authorization: user-secret");
    return { structuredContent: { data: { toolkit_connection_statuses: [{ toolkit: "slack", accounts: [{ id: "slack-1", status: "ACTIVE" }] }] } } };
  } });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect });
  assert.equal(result.state, "partial");
  assert.equal(result.accounts.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Authorization|user-secret/);
  assert.equal(remote.closed(), 1);
});

test("provider failures are generic and always close the established connection", async () => {
  const remote = fixture({ pages: () => { throw new Error("credential-in-error"); } });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect });
  assert.equal(result.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /credential-in-error/);
  assert.equal(remote.closed(), 1);
});

test("consumer account requests are bounded to four concurrent calls", async () => {
  let live = 0;
  let max = 0;
  const remote = fixture({ apps: Array.from({ length: 9 }, (_, i) => `app${i}`), search: async (app) => {
    max = Math.max(max, ++live);
    await new Promise((resolve) => setTimeout(resolve, 2));
    live--;
    return { structuredContent: { toolkit_connection_statuses: [{ toolkit: app, accounts: [{ id: app }] }] } };
  } });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect });
  assert.equal(result.accounts.length, 9);
  assert.equal(max, 4);
});

test("SDK reads all pages using the exact stable user identity without creating sessions", async () => {
  const calls = [];
  let checked = 0;
  const sdkClient = { connectedAccounts: { list: async (query) => {
    assert.equal(checked, 1);
    calls.push(query);
    return { items: [{ id: query.cursor ? "ca2" : "ca1", toolkit: { slug: "gmail" }, alias: "work", status: "ACTIVE", isDisabled: Boolean(query.cursor),
      state: { val: { displayName: "Account Name", access_token: "private-token" } }, data: { token: "private-token" } }], nextCursor: query.cursor ? null : "page2" };
  } } };
  const result = await loadComposioInventory({ kind: "user", id: "U123" }, {
    config: { ...config, mode: "sdk", sdkApiKey: "sdk-secret" }, sdkClient,
    requireEntitlement: () => checked++,
  });
  assert.equal(result.state, "ready");
  assert.equal(result.source, "sdk-user");
  assert.deepEqual(calls, [
    { userIds: ["slack:T123:user:U123"], accountType: "ALL", limit: 100 },
    { userIds: ["slack:T123:user:U123"], accountType: "ALL", limit: 100, cursor: "page2" },
  ]);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].account, "Account Name");
  assert.equal(result.accounts[1].status, "DISABLED");
  assert.doesNotMatch(JSON.stringify(result), /sdk-secret|private-token|access_token/);
});

test("SDK entitlement denial prevents every client call", async () => {
  let calls = 0;
  const result = await loadComposioInventory({ kind: "channel", id: "C123" }, {
    config: { ...config, mode: "sdk", sdkApiKey: "secret" },
    sdkClient: { connectedAccounts: { list: async () => { calls++; } } },
    requireEntitlement: () => { throw new Error("private-entitlement-error"); },
  });
  assert.equal(result.state, "unavailable");
  assert.equal(calls, 0);
  assert.match(result.message, /Enterprise license/);
  assert.doesNotMatch(JSON.stringify(result), /private-entitlement-error/);
});

test("SDK channel identity is distinct and repeated account cursors fail closed", async () => {
  const calls = [];
  const result = await loadComposioInventory({ kind: "channel", id: "C123" }, {
    config: { ...config, mode: "sdk", sdkApiKey: "secret" }, requireEntitlement() {},
    sdkClient: { connectedAccounts: { list: async (query) => {
      calls.push(query);
      return { items: [{ id: "ca1", toolkit: { slug: "gmail" } }], nextCursor: "repeat" };
    } } },
  });
  assert.equal(result.state, "unavailable");
  assert.deepEqual(result.accounts, []);
  assert.ok(calls.every((call) => call.userIds[0] === "slack:T123:channel:C123"));
  assert.equal(calls.length, 2);
});

test("SDK empty inventory is ready; missing key and DM inventory never touch the client", async () => {
  let calls = 0;
  const options = { config: { ...config, mode: "sdk", sdkApiKey: "key" }, requireEntitlement() {},
    sdkClient: { connectedAccounts: { list: async () => { calls++; return { items: [], nextCursor: null }; } } } };
  assert.equal((await loadComposioInventory({ kind: "user", id: "U123" }, options)).state, "ready");
  assert.equal((await loadComposioInventory({ kind: "channel", id: "D123", record: { isDM: true } }, options)).source, "none-dm");
  assert.equal((await loadComposioInventory({ kind: "user", id: "U123" }, { ...options, config: { ...options.config, sdkApiKey: "" } })).state, "unconfigured");
  assert.equal(calls, 1);
});

test("consumer search timeouts return partial and release the client", async () => {
  const remote = fixture({ apps: ["gmail"], search: () => new Promise(() => {}) });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, { config, connect: remote.connect, timeoutMs: 10 });
  assert.equal(result.state, "partial");
  assert.equal(remote.closed(), 1);
});

test("a connection completing after timeout is still closed", async () => {
  const remote = fixture();
  let finish;
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, {
    config, timeoutMs: 10, connect: () => new Promise((resolve) => { finish = resolve; }),
  });
  assert.equal(result.state, "unavailable");
  finish(remote.client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remote.closed(), 1);
});

test("SDK pagination has a finite page limit even with unique cursors", async () => {
  let calls = 0;
  const result = await loadComposioInventory({ kind: "user", id: "U123" }, {
    config: { ...config, mode: "sdk", sdkApiKey: "key" }, requireEntitlement() {},
    sdkClient: { connectedAccounts: { list: async () => ({ items: [], nextCursor: `page-${++calls}` }) } },
  });
  assert.equal(result.state, "unavailable");
  assert.equal(calls, 50);
});

test("malicious account metadata cannot echo known configuration credentials", async () => {
  const remote = fixture({ apps: ["gmail"], search: () => ({ structuredContent: { toolkit_connection_statuses: [{
    toolkit: "gmail", accounts: [{ id: "user-secret", alias: "org-secret", user_info: { email: "sdk-secret" }, status: "ACTIVE" }],
  }] } }) });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "user-secret" } }, {
    config: { ...config, sdkApiKey: "sdk-secret" }, connect: remote.connect,
  });
  assert.equal(result.state, "ready");
  assert.doesNotMatch(JSON.stringify(result), /user-secret|org-secret|sdk-secret/);
  assert.deepEqual(result.accounts.map(({ id, alias, account }) => ({ id, alias, account })), [{ id: "[redacted]", alias: "[redacted]", account: "[redacted]" }]);
});

test("SDK rejects mismatched and nonstring owner fields, and requires the workspace identity", async () => {
  for (const owner of [{ userId: "somebody-else" }, { user_id: "somebody-else" }, { userId: 123 }]) {
    const result = await loadComposioInventory({ kind: "user", id: "U123" }, {
      config: { ...config, mode: "sdk", sdkApiKey: "key" }, requireEntitlement() {},
      sdkClient: { connectedAccounts: { list: async () => ({ items: [{ id: "ca1", toolkit: { slug: "gmail" }, ...owner }] }) } },
    });
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.accounts, []);
  }
  const missing = await loadComposioInventory({ kind: "user", id: "U123" }, {
    config: { mode: "sdk", sdkApiKey: "key" }, requireEntitlement() {},
    sdkClient: { connectedAccounts: { list: async () => assert.fail("must not call without workspace") } },
  });
  assert.equal(missing.state, "unavailable");
  assert.match(missing.message, /workspace identity/);
});

test("an overall consumer deadline preserves collected rows and stops starting further searches", async () => {
  let started = 0;
  const remote = fixture({ apps: Array.from({ length: 12 }, (_, i) => `app${i}`), search: (app) => {
    started++;
    if (app !== "app0") return new Promise(() => {});
    return { structuredContent: { toolkit_connection_statuses: [{ toolkit: app, accounts: [{ id: "kept" }] }] } };
  } });
  const result = await loadComposioInventory({ kind: "user", record: { composioToken: "key" } }, {
    config, connect: remote.connect, timeoutMs: 1_000, totalTimeoutMs: 20,
  });
  assert.equal(result.state, "partial");
  assert.deepEqual(result.accounts.map(({ id }) => id), ["kept"]);
  assert.ok(started <= 5, `only the first wave and one completed-slot replacement should start: ${started}`);
  assert.equal(remote.closed(), 1);
});

test("SDK total deadline aborts pagination and never presents an incomplete list as complete", async () => {
  let calls = 0;
  let finalSignal;
  const result = await loadComposioInventory({ kind: "user", id: "U123" }, {
    config: { ...config, mode: "sdk", sdkApiKey: "key" }, requireEntitlement() {},
    timeoutMs: 1_000, totalTimeoutMs: 15,
    sdkClient: { connectedAccounts: { list: async (_query, { signal }) => {
      calls++;
      if (calls === 1) return { items: [{ id: "partial-account", toolkit: { slug: "gmail" } }], nextCursor: "page2" };
      finalSignal = signal;
      return new Promise(() => {});
    } } },
  });
  assert.equal(result.state, "unavailable");
  assert.deepEqual(result.accounts, []);
  assert.equal(calls, 2);
  assert.equal(finalSignal.aborted, true);
});
