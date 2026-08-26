import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

process.env.CG_APPROVAL_SECRET = "mcp-config-signing-secret";
const { buildMcpConfig: buildRawMcpConfig } = await import("../src/gateway/mcp.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");
const buildMcpConfig = (options = {}) => buildRawMcpConfig({
  channelId: "C_CONFIG",
  slug: "mcp-config-test",
  authorId: "U_CONFIG",
  threadKey: "1.000",
  origin: "slack_foreground",
  gatewayFsRoot: allowedFsRoot(),
  gatewayWorkspaceRoot: workspaceRoot(),
  ...options,
});

test("Claude MCP config exposes personal and agent Composio with separate credentials", async () => {
  const config = JSON.parse(await buildMcpConfig({
    composioUserToken: "ck_user_secret",
    composioToken: "ck_shared_secret",
  }));

  assert.equal(config.mcpServers["composio-user"].type, "http");
  assert.equal(config.mcpServers["composio-user"].headers["x-consumer-api-key"], "ck_user_secret");
  assert.equal(config.mcpServers["composio-user"].default_tools_approval_mode, "approve");

  assert.equal(config.mcpServers["composio-agent"].type, "http");
  assert.equal(config.mcpServers["composio-agent"].headers["x-consumer-api-key"], "ck_shared_secret");
  assert.equal(config.mcpServers["composio-agent"].default_tools_approval_mode, "approve");
  // The bare legacy name is gone: nothing may still be reachable as `mcp__composio__*`.
  assert.equal(config.mcpServers.composio, undefined);
});

test("Claude MCP config independently omits unavailable Composio identities", async () => {
  const personalOnly = JSON.parse(await buildMcpConfig({ composioUserToken: "ck_user_secret" }));
  const sharedOnly = JSON.parse(await buildMcpConfig({ composioToken: "ck_shared_secret" }));
  const config = JSON.parse(await buildMcpConfig());

  assert.ok(personalOnly.mcpServers["composio-user"]);
  assert.equal(personalOnly.mcpServers["composio-agent"], undefined);
  assert.equal(sharedOnly.mcpServers["composio-user"], undefined);
  assert.ok(sharedOnly.mcpServers["composio-agent"]);
  assert.equal(config.mcpServers["composio-user"], undefined);
  assert.equal(config.mcpServers["composio-agent"], undefined);
});

test("Claude MCP config bridges SDK sessions without exposing the organization key", async () => {
  const config = JSON.parse(await buildMcpConfig({
    composioUserEndpoint: {
      mode: "sdk",
      url: "https://app.composio.dev/tool_router/v3/trs_user/mcp",
    },
    composioEndpoint: {
      mode: "sdk",
      url: "https://app.composio.dev/tool_router/v3/trs_channel/mcp",
    },
  }));

  for (const name of ["composio-user", "composio-agent"]) {
    const server = config.mcpServers[name];
    assert.equal(server.command, process.execPath);
    assert.match(server.args[0], /composio-sdk-bridge\.js$/);
    assert.match(server.args[1], /^https:\/\/app\.composio\.dev\//);
    assert.equal(server.env.CHANNELGATE_DIR, process.env.CHANNELGATE_DIR);
    assert.equal(server.default_tools_approval_mode, "approve");
  }
  assert.doesNotMatch(JSON.stringify(config), /sdk-super-secret|x-api-key/i);
});

test("Claude MCP config exposes progress report only for opted-in foreground runs", async () => {
  const foreground = JSON.parse(await buildMcpConfig({ progressReport: true }));
  const hidden = JSON.parse(await buildMcpConfig({ progressReport: false }));
  const defaulted = JSON.parse(await buildMcpConfig());

  assert.equal(foreground.mcpServers.gateway.env.CG_PROGRESS_REPORT, "1");
  assert.equal(hidden.mcpServers.gateway.env.CG_PROGRESS_REPORT, undefined);
  assert.equal(defaulted.mcpServers.gateway.env.CG_PROGRESS_REPORT, undefined);
});

test("gateway MCP config receives the resolved run engine", async () => {
  const claude = JSON.parse(await buildMcpConfig({ engine: "claude" }));
  const codex = JSON.parse(await buildMcpConfig({ engine: "codex" }));

  assert.equal(claude.mcpServers.gateway.env.CG_ENGINE, "claude");
  assert.equal(codex.mcpServers.gateway.env.CG_ENGINE, "codex");
});

test("Claude gateway MCP receives daemon-canonical filesystem and workspace roots", async () => {
  const config = JSON.parse(await buildMcpConfig());
  const env = config.mcpServers.gateway.env;

  assert.equal(env.CG_FS_ROOT, allowedFsRoot());
  assert.equal(env.CG_WORKSPACE_DIR, workspaceRoot());
});

test("gateway identity is carried only by a signed run capability", async () => {
  const config = JSON.parse(await buildMcpConfig());
  const env = config.mcpServers.gateway.env;
  assert.ok(env.CG_GATEWAY_CAPABILITY);
  assert.equal(env.CG_CHANNEL_ID, undefined);
  assert.equal(env.CG_SLUG, undefined);
  assert.equal(env.CG_AUTHOR_ID, undefined);
  assert.equal(env.CG_THREAD_KEY, undefined);
});

test("gateway MCP capability signs trusted versus API-only principal provenance", async () => {
  const trusted = JSON.parse(await buildMcpConfig());
  const untrusted = JSON.parse(await buildMcpConfig({ principalTrusted: false, origin: "api_foreground" }));
  const secret = process.env.CG_APPROVAL_SECRET;
  assert.equal(verifyGatewayCapability(trusted.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret }).claims.principalTrusted, true);
  assert.equal(verifyGatewayCapability(untrusted.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret }).claims.principalTrusted, false);
});

test("Claude MCP config injects only a complete Make toolbox with Bearer authentication", async () => {
  const enabled = JSON.parse(await buildMcpConfig({
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/abc-123",
    makeToolboxKey: "make-secret",
  }));
  const noKey = JSON.parse(await buildMcpConfig({
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc-123",
  }));
  const noUrl = JSON.parse(await buildMcpConfig({ makeToolboxKey: "make-secret" }));

  assert.deepEqual(enabled.mcpServers["make-toolbox"], {
    type: "http",
    url: "https://eu1.make.celonis.com/mcp/server/abc-123",
    headers: { Authorization: "Bearer make-secret" },
  });
  assert.equal(noKey.mcpServers["make-toolbox"], undefined);
  assert.equal(noUrl.mcpServers["make-toolbox"], undefined);
});
