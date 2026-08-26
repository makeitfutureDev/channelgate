import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const discovery = await import("../src/gateway/mcp-discovery.js");

test("Codex discovery exposes runtime app families and configured servers separately", () => {
  assert.equal(typeof discovery.catalogFromCodexStatus, "function");

  const catalog = discovery.catalogFromCodexStatus([
    {
      name: "codex_apps",
      authStatus: "bearerToken",
      tools: {
        "github.fetch_issue": { name: "github.fetch_issue", inputSchema: { type: "object" }, _meta: { connector_id: "connector_github" } },
        "boost_space.list_spaces": { name: "boost_space.list_spaces", inputSchema: { type: "object" }, _meta: { connector_id: "asdk_app_boost" } },
        "github.create_issue": { name: "github.create_issue", inputSchema: { type: "object" }, _meta: { connector_id: "connector_github" } },
      },
    },
    {
      name: "local-docs",
      authStatus: "unsupported",
      tools: {
        search: { name: "search", inputSchema: { type: "object" } },
      },
    },
  ]);

  assert.deepEqual(
    catalog.map(({ id, kind, serverName }) => [id, kind, serverName]),
    [
      ["boost_space", "tool-group", "codex_apps"],
      ["github", "tool-group", "codex_apps"],
      ["local-docs", "server", "local-docs"],
    ],
  );
  assert.deepEqual(catalog[0].tools, ["boost_space.list_spaces"]);
  assert.deepEqual(catalog[0].connectorIds, ["asdk_app_boost"]);
  assert.deepEqual(catalog[1].tools, ["github.create_issue", "github.fetch_issue"]);
  assert.deepEqual(catalog[1].connectorIds, ["connector_github"]);
  assert.equal(catalog[0].authStatus, undefined);
  assert.equal(catalog[0].inputSchema, undefined);
});

test("Codex discovery deduplicates valid connector IDs within a selected tool family", () => {
  const catalog = discovery.catalogFromCodexStatus([{
    name: "codex_apps",
    tools: {
      "example.one": { _meta: { connector_id: "connector_one" } },
      "example.two": { _meta: { connector_id: "connector_two" } },
      "example.duplicate": { _meta: { connector_id: "connector_one" } },
      "example.invalid": { _meta: { connector_id: "bad.connector" } },
      "example.missing": {},
    },
  }]);

  assert.deepEqual(catalog[0].connectorIds, ["connector_one", "connector_two"]);
});

test("Codex app-server inventory performs initialize then requests tool status", async () => {
  assert.equal(typeof discovery.listCodexRuntimeMcps, "function");

  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0);
  child.stdin = {
    write(chunk) {
      const message = JSON.parse(String(chunk));
      requests.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "codex", platformFamily: "unix", platformOs: "macos", codexHome: "/tmp/codex" } })}\n`));
      } else if (message.method === "mcpServerStatus/list") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: {
            data: [{
              name: "codex_apps",
              authStatus: "bearerToken",
              tools: { "boost_space.list_spaces": { name: "boost_space.list_spaces", inputSchema: {} } },
              resources: [],
              resourceTemplates: [],
            }],
            nextCursor: null,
          },
        })}\n`));
      }
      return true;
    },
    end() {},
  };

  const result = await discovery.listCodexRuntimeMcps({
    spawnImpl: () => child,
    timeoutMs: 250,
  });

  assert.deepEqual(result.map((entry) => entry.id), ["boost_space"]);
  assert.deepEqual(requests.map((message) => message.method), [
    "initialize",
    "initialized",
    "mcpServerStatus/list",
  ]);
  assert.equal(requests[0].params.capabilities.experimentalApi, true);
  assert.equal(requests[2].params.detail, "toolsAndAuthOnly");
});

test("Codex app-server discovery fails closed on a cold timeout", async () => {
  assert.equal(typeof discovery.listCodexRuntimeMcps, "function");

  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: () => true, end() {} };
  child.kill = () => child.emit("close", 0);

  // The discovery timeout is deliberately unref'd (it must never keep the daemon alive), and this
  // fake child has no live libuv handle — so without a ref'd keep-alive the event loop can drain
  // before the 10ms timer fires, leaving this promise pending forever. Hold the loop open until
  // the fail-closed race settles, then release it.
  const keepAlive = setTimeout(() => {}, 30_000);
  try {
    const result = await discovery.listCodexRuntimeMcps({
      spawnImpl: () => child,
      timeoutMs: 10,
    });

    assert.deepEqual(result, []);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("Codex app-server failures use a semantic message when diagnostics are requested", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: () => true, end() {} };
  child.kill = () => {};
  const pending = discovery.listCodexRuntimeMcps({
    spawnImpl: () => child,
    timeoutMs: 1_000,
    failClosed: false,
  });
  queueMicrotask(() => {
    child.stderr.write("app-server configuration is invalid\n");
    child.emit("close", 1, null);
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "Codex MCP discovery failed because it reported a general error: app-server configuration is invalid");
    assert.doesNotMatch(error.message, /exit code|code 1/i);
    return true;
  });
});

test("Codex policy resolves selected app families and explicitly gates every discovered server", () => {
  assert.equal(typeof discovery.codexMcpPolicyFor, "function");
  const catalog = [
    { id: "boost_space", kind: "tool-group", serverName: "codex_apps", connectorIds: ["asdk_app_boost"], tools: ["boost_space.list_spaces", "boost_space.list_products"] },
    { id: "github", kind: "tool-group", serverName: "codex_apps", connectorIds: ["connector_github"], tools: ["github.fetch_issue"] },
    { id: "local-docs", kind: "server", serverName: "local-docs" },
    { id: "browser", kind: "server", serverName: "browser" },
  ];

  assert.deepEqual(
    discovery.codexMcpPolicyFor(catalog, [
      { id: "boost_space", kind: "tool-group", serverName: "codex_apps", toolPrefix: "boost_space" },
      { id: "local-docs", kind: "server", serverName: "local-docs" },
    ]),
    {
      apps: ["asdk_app_boost"],
      servers: [
        { name: "browser", enabled: false },
        { name: "local-docs", enabled: true },
      ],
    },
  );
  assert.deepEqual(
    discovery.codexMcpPolicyFor(catalog, []),
    {
      apps: [],
      servers: [
        { name: "browser", enabled: false },
        { name: "local-docs", enabled: false },
      ],
    },
  );
});

test("Codex optional MCP definitions are complete and credential-safe under ignore-user-config", () => {
  assert.deepEqual(discovery.safeCodexMcpDefinition({ command: "node", args: ["server.js"] }), {
    transport: "stdio", command: "node", args: ["server.js"],
  });
  assert.deepEqual(discovery.safeCodexMcpDefinition({ url: "https://mcp.example.test/rpc" }), {
    transport: "http", url: "https://mcp.example.test/rpc",
  });
  assert.equal(discovery.safeCodexMcpDefinition({ command: "node", env: { TOKEN: "secret" } }), null);
  assert.equal(discovery.safeCodexMcpDefinition({ url: "https://user:pass@example.test" }), null);
});

test("channel MCP helpers preserve the engine-specific persisted selection shape", () => {
  assert.equal(discovery.selectionFieldForEngine("claude"), "allowedMcps");
  assert.equal(discovery.selectionFieldForEngine("codex"), "allowedCodexMcps");

  assert.deepEqual(
    discovery.persistedSelectionForEngine("claude", {
      name: "local-docs",
      match: { serverName: "local-docs" },
      namespace: "mcp__local_docs",
    }),
    {
      name: "local-docs",
      match: { serverName: "local-docs" },
      namespace: "mcp__local_docs",
    },
  );
  assert.deepEqual(
    discovery.persistedSelectionForEngine("codex", {
      id: "boost_space",
      name: "Boost.space",
      kind: "tool-group",
      serverName: "codex_apps",
      toolPrefix: "boost_space",
      connectorIds: ["must_not_persist"],
      tools: ["must.not.persist"],
    }),
    {
      id: "boost_space",
      name: "Boost.space",
      kind: "tool-group",
      serverName: "codex_apps",
      toolPrefix: "boost_space",
    },
  );
});
