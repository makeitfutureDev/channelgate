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
