import test from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { createToolHandlers, validateSessionUrl, authorizeSdkSession } = await import("../src/ee/composio-sdk-bridge.js");

test("SDK bridge forwards tool listing and calls without changing payloads", async () => {
  const calls = [];
  const remote = {
    listTools: async () => ({ tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] }),
    callTool: async (params) => {
      calls.push(params);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  let checked = 0;
  const handlers = createToolHandlers(remote, () => { checked++; });

  assert.deepEqual(await handlers.listTools(), {
    tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }],
  });
  assert.deepEqual(
    await handlers.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "gmail" } }),
    { content: [{ type: "text", text: "ok" }] }
  );
  assert.equal(checked, 2, "both listing and calling must reauthorize");
  assert.deepEqual(calls, [
    { name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "gmail" } },
  ]);
});

test("SDK bridge accepts only hosted HTTPS Composio session URLs", () => {
  assert.equal(
    validateSessionUrl("https://app.composio.dev/tool_router/v3/trs_1/mcp").hostname,
    "app.composio.dev"
  );
  assert.throws(() => validateSessionUrl("http://app.composio.dev/tool_router/v3/trs_1/mcp"), /HTTPS/i);
  assert.throws(() => validateSessionUrl("https://composio.dev.evil.example/mcp"), /Composio/i);
  assert.throws(() => validateSessionUrl("file:///etc/passwd"), /HTTPS/i);
});


const SESSION = "https://app.composio.dev/tool_router/v3/trs_owner/mcp";
function checkedGrant({ principalTrusted = true, composioSessions = [{ kind: "user", url: SESSION }], now = Date.now(), ttlMs = 10000 } = {}) {
  const secret = "test-sdk-capability-secret";
  const cap = mintGatewayCapability({ secret, channelId: "C1", slug: "channel", authorId: "U1", threadKey: "1.001", origin: "api_foreground", principalTrusted, composioSessions, now, ttlMs });
  return verifyGatewayCapability(cap, { secret });
}

test("SDK bridge binds the exact session and identity to its signed run grant", () => {
  assert.equal(authorizeSdkSession(SESSION, checkedGrant()), SESSION);
  assert.throws(() => authorizeSdkSession(SESSION.replace("trs_owner", "trs_other"), checkedGrant()), /not authorized/);
  assert.throws(() => authorizeSdkSession(SESSION, checkedGrant({ composioSessions: [] })), /not authorized/);
  assert.throws(() => checkedGrant({ principalTrusted: false }), /Invalid Composio/);
  assert.equal(authorizeSdkSession(SESSION, checkedGrant({ principalTrusted: false, composioSessions: [{ kind: "channel", url: SESSION }] })), SESSION);
  assert.throws(() => authorizeSdkSession(SESSION, checkedGrant({ now: Date.now() - 20000, ttlMs: 1 })), /not authorized/);
});

test("existing SDK handlers stop before remote calls when entitlement is removed", async () => {
  const grant = checkedGrant();
  let calls = 0;
  const handlers = createToolHandlers({ listTools: async () => { calls++; return { tools: [] }; }, callTool: async () => { calls++; } }, () => authorizeSdkSession(SESSION, grant));
  await handlers.listTools();
  try {
    clearTestLicense();
    assert.throws(() => handlers.listTools(), /Enterprise/);
    assert.throws(() => handlers.callTool({ name: "example" }), /Enterprise/);
    testLicenseEnv({ tier: "free" });
    assert.throws(() => authorizeSdkSession(SESSION, grant), /Enterprise/);
    assert.equal(calls, 1);
  } finally { testLicenseEnv(); }
});
