import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startLiveDaemonStub, ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const daemonStub = await startLiveDaemonStub();
after(() => daemonStub.close());

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
      CG_PORT: String(daemonStub.port),
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
    assert.doesNotMatch(client.getInstructions() || "", /report_progress/, "never advertise a tool this run does not have");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

// codex-cli 0.170 defers EVERY MCP tool behind its tool search and shows the model only the
// namespace line `mcp__gateway: <server instructions>`. With no instructions the line was bare, so
// a model following gateway-usage ("only when report_progress is actually available") saw no such
// tool and told the user the progress plan was unavailable (2026-11-25 overnight QA, 2 of 3 runs).
// The server's own instructions are what that namespace line carries: they must name the progress
// tool when this run has it, and say that a deferred tool is found by searching, not by absence.
test("gateway MCP instructions name the progress tool so a deferred namespace still advertises it", async () => {
  const { client, transport } = gatewayClient({ progressReport: true });

  try {
    await client.connect(transport);
    const instructions = client.getInstructions() || "";
    assert.match(instructions, /ChannelGate/);
    assert.match(instructions, /report_progress/);
    assert.match(instructions, /deferred.*search/is);
    assert.doesNotMatch(instructions, /\n/, "codex-cli shows only the first line of the namespace description");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

// codex-cli 0.170 renders the namespace description as its FIRST LINE cut at 247 characters + "..."
// (reproduced with `codex debug prompt-input`, PR #392 review). Every clause a model needs — the
// progress tool when registered, and "search before calling one unavailable" — must end inside
// that window for every toolset; only the trailing tool-family list may be cut.
test("gateway MCP instructions keep their critical clauses inside Codex's namespace-line window", async () => {
  ensureTestEnv();
  const { gatewayServerInstructions, NAMESPACE_LINE_WINDOW, SSH_TOOLSET } = await import("../src/mcp/gateway-server.js");
  assert.equal(NAMESPACE_LINE_WINDOW, 247);
  const search = "search this namespace by name before calling one unavailable.";
  const cases = [
    { toolset: "full", progressReport: true, progress: true },
    { toolset: "full", progressReport: false, progress: false },
    { toolset: SSH_TOOLSET, progressReport: true, progress: false },
    { toolset: "agent-message", progressReport: true, progress: false },
    { toolset: "memory-review", progressReport: false, progress: false },
  ];
  for (const { toolset, progressReport, progress } of cases) {
    const text = gatewayServerInstructions({ toolset, progressReport });
    assert.doesNotMatch(text, /\n/, `${toolset}: one line`);
    const searchEnd = text.indexOf(search) + search.length;
    assert.ok(text.indexOf(search) >= 0 && searchEnd <= NAMESPACE_LINE_WINDOW, `${toolset}: search clause ends inside the window (${searchEnd})`);
    if (progress) {
      const at = text.indexOf("`report_progress`");
      assert.ok(at >= 0 && at < text.indexOf(search), `${toolset}: report_progress named before the search clause`);
    } else {
      assert.doesNotMatch(text, /report_progress/, `${toolset}: never advertise a tool this run does not have`);
    }
    if (toolset === SSH_TOOLSET) assert.doesNotMatch(text, /background work|approvals/, "SSH sessions have no background or approval tools");
  }
});
