import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");

function gatewayClient({ progressReport }) {
  const scratch = ensureTestEnv();
  const secret = "progress-report-signing-secret";
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
      CG_GATEWAY_CAPABILITY: mintGatewayCapability({ secret, channelId: "C_PROGRESS_REPORT_TEST", slug: "progress-report-test", authorId: "U_PROGRESS_REPORT_TEST", threadKey: "1.000", origin: "slack_foreground", engine: "claude" }),
      CG_APPROVAL_SECRET: secret,
      ...(progressReport ? { CG_PROGRESS_REPORT: "1" } : {}),
    },
  });
  const client = new Client(
    { name: "progress-report-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  return { client, transport };
}

async function assertValidationError(client, args) {
  const result = await client.callTool({ name: "report_progress", arguments: args });
  assert.equal(result.isError, true);
  assert.match(result.content?.map((item) => item.text || "").join("\n") || "", /invalid|validation/i);
}

test("live gateway MCP advertises and validates the progress report contract", async () => {
  const { client, transport } = gatewayClient({ progressReport: true });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const reportTool = tools.tools.find((tool) => tool.name === "report_progress");
    assert.ok(reportTool);
    assert.equal(reportTool.inputSchema.type, "object");
    assert.ok(reportTool.inputSchema.properties.title);
    assert.ok(reportTool.inputSchema.properties.steps);
    assert.equal(reportTool.inputSchema.properties.title.type, "string");
    assert.equal(reportTool.inputSchema.properties.title.minLength, 1);
    assert.equal(reportTool.inputSchema.properties.title.maxLength, 80);

    const stepsSchema = reportTool.inputSchema.properties.steps;
    assert.equal(stepsSchema.type, "array");
    assert.equal(stepsSchema.minItems, 1);
    assert.equal(stepsSchema.maxItems, 20);
    assert.equal(stepsSchema.items.type, "object");
    assert.deepEqual(
      Object.keys(stepsSchema.items.properties).sort(),
      ["details", "id", "output", "sources", "status", "title"],
    );
    assert.deepEqual(stepsSchema.items.properties.status.enum, ["pending", "in_progress", "complete", "error"]);

    const valid = await client.callTool({
      name: "report_progress",
      arguments: {
        title: "Prepare launch",
        steps: [{ id: "ship", title: "Ship release", status: "in_progress" }],
      },
    });
    assert.notEqual(valid.isError, true);
    assert.deepEqual(valid.content, [{ type: "text", text: "Foreground Slack Plan accepted." }]);

    await assertValidationError(client, {
      title: "   ",
      steps: [{ id: "step", title: "Step", status: "pending" }],
    });
    await assertValidationError(client, {
      title: "Duplicate IDs",
      steps: [
        { id: "same", title: "First", status: "pending" },
        { id: " same ", title: "Second", status: "complete" },
      ],
    });
    await assertValidationError(client, {
      title: "Multiple active",
      steps: [
        { id: "first", title: "First", status: "in_progress" },
        { id: "second", title: "Second", status: "in_progress" },
      ],
    });
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test("live gateway MCP omits progress report without a foreground Slack surface", async () => {
  const { client, transport } = gatewayClient({ progressReport: false });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "report_progress"), false);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
