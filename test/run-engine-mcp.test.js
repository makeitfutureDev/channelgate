import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { buildEngineMcpRuntime } = await import("../src/gateway/run-engine-mcp.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");

test("Claude to Codex fallback remints an engine-scoped signed capability", async () => {
  const input = {
    channelId: "C_FALLBACK",
    slug: "fallback",
    authorId: "U_FALLBACK",
    threadKey: "123.456",
    origin: "slack_foreground",
    principalTrusted: false,
  };
  const claude = await buildEngineMcpRuntime({ ...input, engine: "claude" });
  const codex = await buildEngineMcpRuntime({ ...input, engine: "codex" });
  assert.notEqual(claude.gatewayCapability, codex.gatewayCapability);
  const secret = process.env.CG_APPROVAL_SECRET;
  const claudeClaims = verifyGatewayCapability(claude.gatewayCapability, { secret });
  const codexClaims = verifyGatewayCapability(codex.gatewayCapability, { secret });
  assert.equal(claudeClaims.ok, true);
  assert.equal(codexClaims.ok, true);
  assert.equal(claudeClaims.claims.engine, "claude");
  assert.equal(codexClaims.claims.engine, "codex");
  assert.equal(codexClaims.claims.principalTrusted, false);
});

test("clean engine runtime carries no gateway capability", async () => {
  const runtime = await buildEngineMcpRuntime({ clean: true, engine: "codex" });
  assert.equal(runtime.gatewayCapability, "");
  assert.deepEqual(JSON.parse(runtime.mcpConfigJson), { mcpServers: {} });
  assert.equal(runtime.mcpConfigFingerprint, runtime.mcpConfigJson);
});

test("engine MCP runtime preserves daemon-canonical path context", async () => {
  const runtime = await buildEngineMcpRuntime({
    channelId: "C_PATHS",
    slug: "paths",
    authorId: "U_PATHS",
    threadKey: "2.000",
    origin: "slack_foreground",
    gatewayFsRoot: "/daemon/home",
    gatewayWorkspaceRoot: "/daemon/home/Slack Agent",
  });
  const env = JSON.parse(runtime.mcpConfigJson).mcpServers.gateway.env;
  assert.equal(env.CG_FS_ROOT, "/daemon/home");
  assert.equal(env.CG_WORKSPACE_DIR, "/daemon/home/Slack Agent");
});

test("warm MCP fingerprint ignores capability nonce but retains scoped authority and renewal", async () => {
  const input = {
    channelId: "C_WARM",
    slug: "warm",
    authorId: "U_WARM",
    threadKey: "222.333",
    origin: "slack_foreground",
    principalTrusted: true,
    engine: "claude",
    fingerprintNow: 10_000,
  };
  const first = await buildEngineMcpRuntime(input);
  const second = await buildEngineMcpRuntime(input);
  assert.notEqual(first.gatewayCapability, second.gatewayCapability, "each run still gets a fresh signed grant");
  assert.equal(first.mcpConfigFingerprint, second.mcpConfigFingerprint, "nonce alone must not tear down a warm process");

  const otherAuthor = await buildEngineMcpRuntime({ ...input, authorId: "U_OTHER" });
  const otherOrigin = await buildEngineMcpRuntime({ ...input, origin: "recovery" });
  const untrusted = await buildEngineMcpRuntime({ ...input, principalTrusted: false });
  const renewed = await buildEngineMcpRuntime({ ...input, fingerprintNow: 6 * 60 * 60 * 1000 });
  for (const runtime of [otherAuthor, otherOrigin, untrusted, renewed]) {
    assert.notEqual(runtime.mcpConfigFingerprint, first.mcpConfigFingerprint);
  }
});

test("selected Claude MCP definitions reach the isolated payload and warm fingerprint", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cg-selected-mcp-"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = temp;
  try {
    const file = path.join(temp, ".claude.json");
    const definition = { type: "stdio", command: "node", args: ["/workspace/echo.mjs"], env: {} };
    await fs.writeFile(file, JSON.stringify({ mcpServers: { echo: definition, unselected: { command: "never" } } }));
    const input = { engine: "claude", channelId: "C_PICK", slug: "pick", authorId: "U_PICK", threadKey: "1.2", origin: "slack_foreground", fingerprintNow: 10000 };
    const allowedMcps = [{ name: "echo", namespace: "mcp__echo", match: { serverName: "echo" } }];
    const beforeGrant = await buildEngineMcpRuntime(input);
    const granted = await buildEngineMcpRuntime({ ...input, allowedMcps });
    assert.deepEqual(JSON.parse(granted.mcpConfigJson).mcpServers.echo, { type: "stdio", command: "node", args: ["/workspace/echo.mjs"] });
    assert.equal(JSON.parse(granted.mcpConfigJson).mcpServers.unselected, undefined);
    assert.notEqual(granted.mcpConfigFingerprint, beforeGrant.mcpConfigFingerprint);
    const resumed = await buildEngineMcpRuntime({ ...input, allowedMcps });
    assert.equal(resumed.mcpConfigFingerprint, granted.mcpConfigFingerprint);
    definition.args = ["/workspace/echo-v2.mjs"];
    await fs.writeFile(file, JSON.stringify({ mcpServers: { echo: definition } }));
    const changed = await buildEngineMcpRuntime({ ...input, allowedMcps });
    assert.notEqual(changed.mcpConfigFingerprint, granted.mcpConfigFingerprint);
    const revoked = await buildEngineMcpRuntime(input);
    assert.equal(revoked.mcpConfigFingerprint, beforeGrant.mcpConfigFingerprint);
    assert.equal(JSON.parse(revoked.mcpConfigJson).mcpServers.echo, undefined);
    const clean = await buildEngineMcpRuntime({ ...input, allowedMcps, clean: true });
    assert.deepEqual(JSON.parse(clean.mcpConfigJson), { mcpServers: {} });
    const fallback = await buildEngineMcpRuntime({ ...input, engine: "codex", allowedMcps });
    assert.equal(JSON.parse(fallback.mcpConfigJson).mcpServers.echo, undefined, "fallback engine never inherits Claude definitions");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
