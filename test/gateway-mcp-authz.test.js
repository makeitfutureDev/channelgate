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
// It records what each daemon IPC call carried, so a test can see WHO a tool asked on behalf of.
const ipcCalls = [];
const approvalStub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try { ipcCalls.push({ path: req.url, body: JSON.parse(body || "{}") }); } catch { /* not JSON */ }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ allow: true, reason: "auto-approved by test stub" }));
  });
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

test("slack_download_file takes only a file id, stays pinned to the signed channel, and never leaks a URL", async () => {
  await withGateway({}, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "slack_download_file");
    assert.ok(tool, "the on-demand download tool is registered in the full toolset");
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ["file_id"]);
    assert.match(tool.description, /THIS channel/);

    // No bot token in the test scratch: the refusal names the remedy and nothing else — no
    // channel id from the arguments, no private Slack URL.
    const result = await client.callTool({
      name: "slack_download_file",
      arguments: { file_id: "F0BV4TU6T5L", channel_id: "C_FOREIGN" },
    });
    assert.match(resultText(result), /Slack bot token isn't configured/i);
    assert.doesNotMatch(resultText(result), /C_FOREIGN|files\.slack\.com|url_private/);
  });
});

test("admin-only MCP tools refuse a non-admin signed principal", async () => {
  await setUser("U_MCP_NONADMIN", { approved: true, isAdmin: false });
  await withGateway({ author: "U_MCP_NONADMIN" }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /Only admins/i);
  });
});

// An HTTP run API capability names an author the API key never proved. The run gets the channel's
// gateway tools like any member's message, but acts as the fixed API principal: the named (even
// admin) id is attribution only and never becomes admin rank or anybody's personal scope.
function apiCapability(author = "U_MCP_API_SPOOF") {
  return mintGatewayCapability({
    secret: "authz-test-secret",
    channelId: "C_MCP_CURRENT",
    slug: "mcp-authz-test",
    authorId: author,
    threadKey: "1.000",
    origin: "api_foreground",
    engine: "claude",
    principalTrusted: false,
  });
}

test("API-spoofed admin ids get no admin or personal authority from the gateway tools", async () => {
  await setUser("U_MCP_API_SPOOF", { approved: true, isAdmin: true, composioToken: "spoofed-unchanged" });
  await withGateway({ author: "U_MCP_API_SPOOF", capability: apiCapability() }, async (client) => {
    const folders = await client.callTool({ name: "list_folders", arguments: {} });
    assert.match(resultText(folders), /Only admins|admin/i);
    assert.doesNotMatch(resultText(folders), /\/Users\/|\/home\/|Slack Agent/i);

    const adminMode = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(adminMode), /Only admins/i);

    const token = await client.callTool({ name: "set_my_composio_token", arguments: { token: "api-planted-token" } });
    assert.match(resultText(token), /No verified user context/i);

    const mySkills = await client.callTool({ name: "add_my_skills", arguments: { slugs: ["anything"] } });
    assert.match(resultText(mySkills), /Only approved members have personal skill grants/i);
  });
  const spoofed = await getUser("U_MCP_API_SPOOF");
  assert.equal(spoofed.composioToken, "spoofed-unchanged");
  assert.equal(await getUser("api"), null, "no personal record is ever created for the API principal");
});

test("an API run's gateway tools work like a member's (no blanket refusal)", async () => {
  await withGateway({ author: "U_MCP_API_SPOOF", capability: apiCapability() }, async (client) => {
    const tools = await client.listTools();
    for (const name of ["search_channel_memory", "read_channel_memory", "update_channel_memory", "permission_prompt", "create_schedule", "run_agent_in_background", "list_skills"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} is exposed to an API run`);
    }
    const memory = await client.callTool({ name: "search_channel_memory", arguments: { query: "anything" } });
    assert.doesNotMatch(resultText(memory), /trusted Slack principal|capability rejected/i);
  });
});

test("an API run's permission prompt asks on behalf of the API principal, never the named admin", async () => {
  ipcCalls.length = 0;
  await withGateway({ author: "U_MCP_API_SPOOF", capability: apiCapability() }, async (client) => {
    const result = await client.callTool({ name: "permission_prompt", arguments: { tool_name: "Bash", input: { command: "true" } } });
    const decision = JSON.parse(resultText(result));
    assert.equal(decision.behavior, "allow", "the stub's decision is returned in the shape Claude Code parses");
  });
  const asked = ipcCalls.find((call) => call.path === "/internal/approval");
  assert.ok(asked, "the permission prompt reached the daemon's approval path");
  assert.equal(asked.body.authorId, "api", "the approval path must not see the spoofed admin id (admin-mode auto-approval keys on it)");
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
