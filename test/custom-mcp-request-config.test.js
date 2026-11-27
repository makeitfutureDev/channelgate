// Custom request credentials are materialized only at the daemon relay, including host turns.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "custom-request-test-capability-secret";
const { patchCustomMcps, listCustomMcps, resolveCustomMcpsForRun, customMcpTokens } = await import("../src/gateway/custom-mcps.js");
const { buildMcpRuntimePayload } = await import("../src/gateway/mcp.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { lookupRemoteMcp, clearRemoteMcps } = await import("../src/mcp/remote-mcp-registry.js");
const { buildCodexArgs, codexSecretBundle } = await import("../src/engines/codex.js");
const { hostBackend } = await import("../src/runtimes/host.js");
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");
const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
const { connectRemoteClient } = await import("../src/mcp/remote-relay.js");

const headerSecret = "private-header-test-value";
const querySecret = "query-key /+?é";
const stored = () => patchCustomMcps([], { set: { name: "generic", url: "https://remote.example/mcp", authType: "custom", headers: [{ name: "X-Api-Key", value: headerSecret }, { name: "X-Tenant", value: "tenant-test" }], queryParams: [{ name: "api_key", value: querySecret }] } });
const identity = { channelId: "C_GENERIC", slug: "generic-request-test", authorId: "U_GENERIC", threadKey: "1.000", origin: "slack_foreground", gatewayFsRoot: allowedFsRoot(), gatewayWorkspaceRoot: workspaceRoot() };

test("both engines relay arbitrary credentials on container and host without serializing values", async () => {
  const customMcps = resolveCustomMcpsForRun({ channelList: stored() });
  const container = createFakeRuntime().target();
  const host = hostBackend.prepareTarget({ slug: "sudo", cwd: "/work", workDir: "/work", cleanWorkDir: "", meta: { sudoMode: true }, settings: {} });
  for (const target of [container, host]) {
    for (const engine of ["claude", "codex"]) {
      const payload = await buildMcpRuntimePayload({ ...identity, engine, customMcps, target });
      const config = JSON.parse(payload.configJson).mcpServers;
      const claim = verifyGatewayCapability(config.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
      const remote = lookupRemoteMcp(claim.jti, "custom-generic");
      assert.deepEqual(remote.headers, { "X-Api-Key": headerSecret, "X-Tenant": "tenant-test" });
      assert.equal(new URL(remote.url).searchParams.get("api_key"), querySecret);
      assert.equal(remote.publicOnly, true);
      assert.equal(config["custom-generic"].env.CG_MCP_SERVICE, "remote-mcp");
      const helpers = [];
      const args = buildCodexArgs({ prompt: "test", sessionId: "t", isNewSession: true, cwd: target.cwd || "/work", outFile: "/tmp/test-output.txt", target, customMcps, secretBundlePath: "/tmp/test-bundle.json", headerHelpers: helpers });
      assert.equal(helpers.length, 0);
      const artifacts = JSON.stringify({ config, args, bundle: codexSecretBundle({ isolated: target === container, gatewayCapability: "test-cap", customMcps }), listing: listCustomMcps(stored(), "channel") });
      for (const secret of [headerSecret, querySecret, encodeURIComponent(querySecret), new URL(remote.url).searchParams.toString().split("=")[1]]) assert.ok(!artifacts.includes(secret), "credential is absent from engine/listing artifacts");
      clearRemoteMcps(claim.jti);
    }
  }
  const secrets = customMcpTokens(customMcps);
  assert.ok(secrets.includes(querySecret));
  assert.ok(secrets.includes(headerSecret));
  assert.ok(secrets.includes(encodeURIComponent(querySecret)));
});

test("the HTTP transport receives custom headers and encoded query parameters on real MCP requests", async (t) => {
  const seen = [];
  const active = new Set();
  const httpServer = http.createServer(async (req, res) => {
    seen.push({ key: req.headers["x-api-key"], tenant: req.headers["x-tenant"], url: new URL(req.url, "http://fixture") });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new Server({ name: "generic-auth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    active.add(server);
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "identity", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "fixture-identity-ok" }] }));
    res.on("close", () => { transport.close(); server.close(); active.delete(server); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const server of active) await server.close(); httpServer.closeAllConnections(); await new Promise((resolve) => httpServer.close(resolve)); });
  const { customMcpRemotes } = await import("../src/gateway/custom-mcps.js");
  const request = customMcpRemotes(resolveCustomMcpsForRun({ channelList: stored() }))["custom-generic"];
  const client = await connectRemoteClient({ url: request.url, headers: request.headers, fetch: (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href || input.url);
    assert.equal(url.protocol, "https:");
    return fetch(`http://127.0.0.1:${httpServer.address().port}${url.pathname}${url.search}`, init);
  } });
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools[0].name, "identity");
  assert.equal((await client.callTool({ name: "identity", arguments: {} })).content[0].text, "fixture-identity-ok");
  assert.ok(seen.length >= 3);
  for (const request of seen) {
    assert.equal(request.key, headerSecret);
    assert.equal(request.tenant, "tenant-test");
    assert.equal(request.url.searchParams.get("api_key"), querySecret);
  }
});


test("query names with unpaired surrogates cannot silently alias another field", () => {
  assert.throws(() => patchCustomMcps([], { set: { name: "invalid", url: "https://remote.example/mcp", authType: "custom", queryParams: [{ name: "\ud800", value: "test-value" }] } }), /Query parameter names/);
});
