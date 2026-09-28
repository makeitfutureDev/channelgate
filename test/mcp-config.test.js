import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

process.env.CG_APPROVAL_SECRET = "mcp-config-signing-secret";
const { buildMcpConfig: buildRawMcpConfig } = await import("../src/gateway/mcp.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const withIdentity = (options = {}) => ({
  channelId: "C_CONFIG",
  slug: "mcp-config-test",
  authorId: "U_CONFIG",
  threadKey: "1.000",
  origin: "slack_foreground",
  gatewayFsRoot: allowedFsRoot(),
  gatewayWorkspaceRoot: workspaceRoot(),
  ...options,
});
const buildMcpConfig = (options = {}) => buildRawMcpConfig(withIdentity(options));

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

// ── Runtime targets (v0.8) ────────────────────────────────────────────────────────────────────
// A containerized run reaches the gateway control plane over the daemon's unix socket, so its MCP
// entry is the image's bridge with the signed capability and NOTHING else. The host entry must not
// move a byte in the process.
test("an isolated target swaps the gateway entry for the image bridge and strips every host secret and path", async () => {
  const fake = createFakeRuntime();
  const target = fake.target();
  const isolated = JSON.parse(await buildMcpConfig({ target, toolset: "memory-review", progressReport: true }));
  const gateway = isolated.mcpServers.gateway;

  assert.deepEqual(gateway.command, "/usr/local/bin/node");
  assert.deepEqual(gateway.args, ["/opt/channelgate/bin/cg-mcp-bridge.js"]);
  // The complete env — anything else would be a host path or a host credential inside a container.
  assert.deepEqual(Object.keys(gateway.env).sort(), ["CG_ENGINE", "CG_GATEWAY_CAPABILITY", "CG_PROGRESS_REPORT", "CG_TOOLSET"]);
  for (const forbidden of ["CG_APPROVAL_SECRET", "CG_PORT", "CG_FS_ROOT", "CG_WORKSPACE_DIR", "CHANNELGATE_DIR", "PATH"]) {
    assert.equal(gateway.env[forbidden], undefined, `${forbidden} must never cross into a container`);
  }
  // The reduced tool surface and the progress opt-in ride the SIGNED grant, not just the env: the
  // socket server has no environment of its own to read.
  const claims = verifyGatewayCapability(gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  assert.equal(claims.toolset, "memory-review");
  assert.equal(claims.progressReport, true);
});

test("the daemon's own local target (or none) produces the checkout-script config, byte for byte", async () => {
  // The daemon's OWN turns (the update smoke probe, memory review's direct path) have no container
  // and reach the control plane through this checkout's script run by this node. Passing the
  // local spawner as the target must change nothing against passing no target at all.
  const stable = (json) => {
    const parsed = JSON.parse(json);
    parsed.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY = "<signed>"; // iat/exp/jti move every call
    return JSON.stringify(parsed);
  };
  const none = stable(await buildMcpConfig());
  const local = stable(await buildMcpConfig({ target: localRuntimeTarget("/work") }));
  assert.equal(local, none);
  assert.match(none, /gateway-server\.js/);
  assert.doesNotMatch(none, /cg-mcp-bridge/, "the socket bridge is the image's, never a local child's");
});

test("SDK-mode Composio rides the same socket bridge in a container, and the plain script when there is no target", async () => {
  const endpoint = { mode: "sdk", url: "https://backend.composio.dev/api/v3/tool_router/session-1/mcp" };
  const host = JSON.parse(await buildMcpConfig({ composioUserEndpoint: endpoint }));
  assert.equal(host.mcpServers["composio-user"].command, process.execPath);
  assert.match(host.mcpServers["composio-user"].args[0], /composio-sdk-bridge\.js$/);
  assert.ok(host.mcpServers["composio-user"].env.CHANNELGATE_DIR);

  const fake = createFakeRuntime();
  const isolated = JSON.parse(await buildMcpConfig({ composioUserEndpoint: endpoint, target: fake.target() }));
  const entry = isolated.mcpServers["composio-user"];
  // The SDK bridge reads the ORG Composio key from gateway settings — unreachable from a container,
  // so it is served over the socket as a second service rather than run inside the image.
  assert.deepEqual(entry.args, ["/opt/channelgate/bin/cg-mcp-bridge.js", endpoint.url]);
  assert.equal(entry.env.CG_MCP_SERVICE, "composio-sdk");
  assert.ok(entry.env.CG_GATEWAY_CAPABILITY);
  assert.equal(entry.env.CHANNELGATE_DIR, undefined);
});

// Container-secrets P1: on an isolated target the four header-bearing remotes are relayed by the
// daemon. The config (a file in the artifact dir every container process can read) carries the
// socket bridge + the signed capability only; the URL and header live in the daemon's registry.
test("an isolated target relays every header-bearing remote through the socket bridge, with no token in the config", async () => {
  const { buildMcpRuntimePayload } = await import("../src/gateway/mcp.js");
  const { lookupRemoteMcp } = await import("../src/mcp/remote-mcp-registry.js");
  const fake = createFakeRuntime();
  const opts = {
    composioUserToken: "ck_user_relay_secret",
    composioToken: "ck_shared_relay_secret",
    toolboxToken: "tb-relay-secret",
    makeToolboxUrl: "https://eu1.make.com/mcp/server/x",
    makeToolboxKey: "mk-relay-secret",
  };
  const payload = await buildMcpRuntimePayload(withIdentity({ ...opts, target: fake.target() }));
  const json = payload.configJson;
  for (const secret of Object.values(opts).filter((v) => !v.startsWith("https://"))) {
    assert.ok(!json.includes(secret), "no relayed credential reaches the container's config file");
  }
  assert.doesNotMatch(json, /x-consumer-api-key|Bearer |"headers"/);
  const servers = JSON.parse(json).mcpServers;
  const names = ["composio-user", "composio-agent", "makeitfuture-toolbox", "make-toolbox"];
  const cap = servers.gateway.env.CG_GATEWAY_CAPABILITY;
  for (const name of names) {
    assert.deepEqual(servers[name], {
      command: "/usr/local/bin/node",
      args: ["/opt/channelgate/bin/cg-mcp-bridge.js", name],
      env: { CG_MCP_SERVICE: "remote-mcp", CG_GATEWAY_CAPABILITY: cap },
      default_tools_approval_mode: "approve",
    }, name);
  }
  assert.deepEqual(payload.relayedMcps, names);
  assert.equal(payload.gatewayCapability, cap);

  // The signed claim names exactly those servers, and the daemon's registry holds the real URL and
  // header under the capability's own jti — the one place the credential exists for this run.
  const claims = verifyGatewayCapability(cap, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  assert.deepEqual(claims.remoteMcps, names);
  assert.deepEqual(lookupRemoteMcp(claims.jti, "composio-user"), { url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_user_relay_secret" } });
  assert.deepEqual(lookupRemoteMcp(claims.jti, "composio-agent").headers, { "x-consumer-api-key": "ck_shared_relay_secret" });
  assert.deepEqual(lookupRemoteMcp(claims.jti, "makeitfuture-toolbox").headers, { Authorization: "Bearer tb-relay-secret" });
  assert.deepEqual(lookupRemoteMcp(claims.jti, "make-toolbox"), { url: "https://eu1.make.com/mcp/server/x", headers: { Authorization: "Bearer mk-relay-secret" } });
  // The fingerprint digest names every relayed server and carries no value.
  assert.deepEqual(Object.keys(payload.relayDigest), names);
  for (const digest of Object.values(payload.relayDigest)) assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(payload.relayDigest).includes("secret"));
});

test("a non-SDK Composio endpoint with its own headers is relayed too, while SDK mode keeps its own service", async () => {
  const { lookupRemoteMcp } = await import("../src/mcp/remote-mcp-registry.js");
  const fake = createFakeRuntime();
  const config = JSON.parse(await buildMcpConfig({
    composioUserEndpoint: { url: "https://composio.example/mcp", headers: { "x-consumer-api-key": "endpoint-secret" } },
    composioEndpoint: { mode: "sdk", url: "https://backend.composio.dev/api/v3/tool_router/s/mcp" },
    target: fake.target(),
  }));
  assert.equal(config.mcpServers["composio-user"].env.CG_MCP_SERVICE, "remote-mcp");
  assert.equal(config.mcpServers["composio-agent"].env.CG_MCP_SERVICE, "composio-sdk");
  assert.doesNotMatch(JSON.stringify(config), /endpoint-secret/);
  const claims = verifyGatewayCapability(config.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  assert.deepEqual(claims.remoteMcps, ["composio-user"], "an SDK session is granted by composioSessions, not relayed");
  assert.deepEqual(lookupRemoteMcp(claims.jti, "composio-user"), { url: "https://composio.example/mcp", headers: { "x-consumer-api-key": "endpoint-secret" } });
});

test("an isolated run drops (and reports) a remote whose URL the relay cannot dial, never falling back to the token", async () => {
  const { buildMcpRuntimePayload } = await import("../src/gateway/mcp.js");
  const before = process.env.TOOLBOX_MCP_URL;
  process.env.TOOLBOX_MCP_URL = "http://toolbox.internal/mcp";
  try {
    const payload = await buildMcpRuntimePayload(withIdentity({ toolboxToken: "tb-plain-http", composioToken: "ck_ok", target: createFakeRuntime().target() }));
    const servers = JSON.parse(payload.configJson).mcpServers;
    assert.equal(servers["makeitfuture-toolbox"], undefined);
    assert.equal(servers["composio-agent"].env.CG_MCP_SERVICE, "remote-mcp");
    assert.doesNotMatch(payload.configJson, /tb-plain-http|toolbox\.internal/);
    assert.deepEqual(payload.rejectedRemotes.map((r) => r.name), ["makeitfuture-toolbox"]);
    assert.deepEqual(payload.relayedMcps, ["composio-agent"]);
    // The host keeps today's behaviour for the same URL: the engine dials it itself.
    const host = JSON.parse(await buildMcpConfig({ toolboxToken: "tb-plain-http" }));
    assert.equal(host.mcpServers["makeitfuture-toolbox"].url, "http://toolbox.internal/mcp");
  } finally {
    if (before === undefined) delete process.env.TOOLBOX_MCP_URL; else process.env.TOOLBOX_MCP_URL = before;
  }
});

test("one malformed header drops only that server (announced), never the whole container turn", async () => {
  const { buildMcpRuntimePayload } = await import("../src/gateway/mcp.js");
  const { hasRemoteMcps } = await import("../src/mcp/remote-mcp-registry.js");
  for (const headers of [
    { "x-consumer-api-key": "ck_ok\r\nX-Injected: 1" },
    { "x-consumer-api-key": 42 },
    { "x-consumer-api-key": "k".repeat(8 * 1024 + 1) },
    { "bad header": "v" },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`h${i}`, "v"])),
  ]) {
    const payload = await buildMcpRuntimePayload(withIdentity({
      composioUserEndpoint: { url: "https://composio.example/mcp", headers },
      composioToken: "ck_shared_fine",
      toolboxToken: "tb-fine",
      target: createFakeRuntime().target(),
    }));
    const servers = JSON.parse(payload.configJson).mcpServers;
    assert.equal(servers["composio-user"], undefined, "the bad server is dropped");
    assert.equal(servers["composio-agent"].env.CG_MCP_SERVICE, "remote-mcp", "the others still relay");
    assert.equal(servers["makeitfuture-toolbox"].env.CG_MCP_SERVICE, "remote-mcp");
    assert.deepEqual(payload.rejectedRemotes.map((r) => r.name), ["composio-user"]);
    assert.doesNotMatch(payload.rejectedRemotes[0].reason, /ck_ok|composio\.example|kkkk/);
    assert.deepEqual(payload.relayedMcps, ["composio-agent", "makeitfuture-toolbox"]);
    assert.ok(hasRemoteMcps(payload.relayJti));
  }
});

test("a host target keeps today's direct http entries, byte for byte, and registers nothing", async () => {
  const { remoteMcpRegistryStats } = await import("../src/mcp/remote-mcp-registry.js");
  const { toolboxUrl } = await import("../src/gateway/mcp-catalog.js");
  const opts = { composioUserToken: "ck_user", toolboxToken: "tb-1", composioToken: "ck_shared", makeToolboxUrl: "https://eu1.make.com/mcp/server/x", makeToolboxKey: "mk" };
  const before = remoteMcpRegistryStats().registrations;
  const host = JSON.parse(await buildMcpConfig(opts));
  const local = JSON.parse(await buildMcpConfig({ ...opts, target: localRuntimeTarget("/work") }));
  assert.equal(remoteMcpRegistryStats().registrations, before, "a host run never touches the relay registry");
  for (const config of [host, local]) {
    assert.equal(JSON.stringify(config.mcpServers["composio-user"]), JSON.stringify({ type: "http", url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_user" }, default_tools_approval_mode: "approve" }));
    assert.equal(JSON.stringify(config.mcpServers["composio-agent"]), JSON.stringify({ type: "http", url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_shared" }, default_tools_approval_mode: "approve" }));
    assert.equal(JSON.stringify(config.mcpServers["makeitfuture-toolbox"]), JSON.stringify({ type: "http", url: toolboxUrl(), headers: { Authorization: "Bearer tb-1" } }));
    assert.equal(JSON.stringify(config.mcpServers["make-toolbox"]), JSON.stringify({ type: "http", url: "https://eu1.make.com/mcp/server/x", headers: { Authorization: "Bearer mk" } }));
    assert.deepEqual(Object.keys(config.mcpServers), ["gateway", "composio-user", "composio-agent", "makeitfuture-toolbox", "make-toolbox"]);
    const claims = verifyGatewayCapability(config.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
    assert.equal(claims.remoteMcps, undefined, "a host capability carries no relay claim");
  }
});

test("untrusted run MCP config omits personal endpoints and cannot grant their URLs", async () => {
  const personalUrl = "https://app.composio.dev/tool_router/v3/trs_personal/mcp";
  const sharedUrl = "https://app.composio.dev/tool_router/v3/trs_shared/mcp";
  const config = JSON.parse(await buildMcpConfig({ principalTrusted: false,
    composioUserEndpoint: { mode: "sdk", url: personalUrl }, composioUserToken: "personal-token",
    composioEndpoint: { mode: "sdk", url: sharedUrl },
  }));
  assert.equal(config.mcpServers["composio-user"], undefined);
  const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
  const verified = verifyGatewayCapability(config.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.claims.composioSessions, [{ kind: "channel", url: sharedUrl }]);
  assert.doesNotMatch(JSON.stringify(config), /personal-token|trs_personal/);
});
