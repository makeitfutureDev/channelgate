import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
const { getUser, setUser } = await import("../src/config/store.js");
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");

// Allow-all approval stub: this file tests per-tool AUTHZ, not the A3 control-plane approval gate
// (that has its own suite in mcp-control-plane-approval.test.js) — so approvals always pass here.
const approvalStub = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ allow: true, reason: "auto-approved by test stub" }));
});
await new Promise((resolve) => approvalStub.listen(0, "127.0.0.1", resolve));
after(() => approvalStub.close());

function gatewayClient({ author = "U_MCP_CALLER", channel = "C_MCP_CURRENT", capability = null } = {}) {
  const secret = "authz-test-secret";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp/gateway-server.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH || "",
      NODE_ENV: "test",
      CG_TEST_SCRATCH: scratch,
      CHANNELGATE_DIR: scratch,
      CHANNELGATE_DB: path.join(scratch, "gateway.db"),
      CG_GATEWAY_CAPABILITY: capability ?? mintGatewayCapability({ secret, channelId: channel, slug: "mcp-authz-test", authorId: author, threadKey: "1.000", origin: "slack_foreground", engine: "claude" }),
      CG_APPROVAL_SECRET: secret,
      CG_PORT: String(approvalStub.address().port),
    },
  });
  const client = new Client({ name: "gateway-mcp-authz-test", version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

async function withGateway(options, fn) {
  const { client, transport } = gatewayClient(options);
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function resultText(result) {
  return result.content?.map((item) => item.text || "").join("\n") || "";
}

test("every gateway tool call fails closed without an authentic capability", async () => {
  await withGateway({ capability: "forged.payload" }, async (client) => {
    const result = await client.callTool({ name: "slack_channel_history", arguments: { limit: 1 } });
    assert.match(resultText(result), /Gateway capability rejected/i);
  });
});

test("Slack history MCP exposes no foreign-channel input and remains pinned to the signed channel", async () => {
  await withGateway({}, async (client) => {
    const tools = await client.listTools();
    const history = tools.tools.find((tool) => tool.name === "slack_channel_history");
    assert.ok(history);
    assert.deepEqual(Object.keys(history.inputSchema.properties), ["limit"]);

    const result = await client.callTool({
      name: "slack_channel_history",
      arguments: { channel_id: "C_FOREIGN", limit: 1 },
    });
    assert.match(resultText(result), /Slack bot token isn't configured/i);
    assert.doesNotMatch(resultText(result), /C_FOREIGN/);
  });
});

test("admin-only MCP tools refuse a non-admin signed principal", async () => {
  await setUser("U_MCP_NONADMIN", { approved: true, isAdmin: false });
  await withGateway({ author: "U_MCP_NONADMIN" }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /Only admins/i);
  });
});

test("API-spoofed admin ids cannot use any user/channel gateway authority", async () => {
  await setUser("U_MCP_API_SPOOF", { approved: true, isAdmin: true });
  const capability = mintGatewayCapability({
    secret: "authz-test-secret",
    channelId: "C_MCP_CURRENT",
    slug: "mcp-authz-test",
    authorId: "U_MCP_API_SPOOF",
    threadKey: "1.000",
    origin: "api_foreground",
    engine: "claude",
    principalTrusted: false,
  });
  await withGateway({ author: "U_MCP_API_SPOOF", capability }, async (client) => {
    const result = await client.callTool({ name: "list_folders", arguments: {} });
    assert.match(resultText(result), /trusted Slack principal/i);
    assert.doesNotMatch(resultText(result), /\/Users\/|\/home\/|Slack Agent/i);
  });
});

test("set_my_composio_token writes only the signed principal's record", async () => {
  await setUser("U_MCP_CALLER", { name: "Caller", composioToken: "caller-old" });
  await setUser("U_MCP_OTHER", { name: "Other", composioToken: "other-unchanged" });

  await withGateway({ author: "U_MCP_CALLER" }, async (client) => {
    const result = await client.callTool({
      name: "set_my_composio_token",
      arguments: { token: "caller-new-secret" },
    });
    assert.match(resultText(result), /Saved your Composio token/i);
    assert.doesNotMatch(resultText(result), /caller-new-secret/);
  });

  assert.equal((await getUser("U_MCP_CALLER")).composioToken, "caller-new-secret");
  assert.equal((await getUser("U_MCP_OTHER")).composioToken, "other-unchanged");
});
