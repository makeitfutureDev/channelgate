// Control-plane approval gate (the 2026-08 update plan (internal repo) A3): gateway MCP tools that change future
// privileges or persistent state require a human Approve click in Slack on top of the handler's
// own authz. Exercised end-to-end over the real stdio server with a local HTTP stub standing in
// for the daemon's /internal/approval endpoint.
import path from "node:path";
import http from "node:http";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { releaseUpdate, reserveUpdate } = await import("../src/gateway/update-state.js");
const { saveSettings } = await import("../src/config/settings.js");

// Stub daemon approval endpoint: records every request, answers with the scripted decision.
const approvalRequests = [];
let approvalResponse = { allow: false, reason: "denied in test" };
let restartResponse = { ok: true, id: "restart-test", waitMs: 300_000, pollMs: 30_000 };
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    approvalRequests.push({ url: req.url, secret: req.headers["x-cg-secret"], body: JSON.parse(body || "{}") });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/internal/restart" ? restartResponse : approvalResponse));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;
after(() => stub.close());

const SLUG = "mcp-ctrl-test";
const CHANNEL = "C_MCP_CTRL";
const ISOLATED_HOME = path.join(scratch, "isolated-engine-home");
const DEFAULT_WORKSPACE_ROOT = path.join(scratch, "daemon-workspaces");
// Default channel folders are namespaced by platform: <workspace root>/<platform>/<slug>.
const DEFAULT_WORKDIR = path.join(DEFAULT_WORKSPACE_ROOT, "slack", SLUG);
const CUSTOM_WORKDIR = path.join(scratch, "custom-workdir");
mkdirSync(ISOLATED_HOME, { recursive: true });
mkdirSync(CUSTOM_WORKDIR, { recursive: true });

function gatewayClient({ author = "U_CTRL_ADMIN", port = stubPort, engine = "claude" } = {}) {
  const secret = "ctrl-test-secret";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp/gateway-server.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH || "",
      NODE_ENV: "test",
      CHANNELGATE_LICENSE_PUBLIC_KEY: process.env.CHANNELGATE_LICENSE_PUBLIC_KEY,
      CHANNELGATE_LICENSE_PAYLOAD: process.env.CHANNELGATE_LICENSE_PAYLOAD,
      CHANNELGATE_LICENSE_KEY: process.env.CHANNELGATE_LICENSE_KEY,
      CHANNELGATE_PLATFORM_URL: "http://127.0.0.1:9/channelgate/api",
      CG_TEST_SCRATCH: scratch,
      CHANNELGATE_DIR: scratch,
      CHANNELGATE_DB: path.join(scratch, "gateway.db"),
      CG_GATEWAY_CAPABILITY: mintGatewayCapability({ secret, channelId: CHANNEL, slug: SLUG, authorId: author, threadKey: "1.000", origin: "slack_foreground", engine }),
      CG_APPROVAL_SECRET: secret,
      CG_PORT: String(port),
      CG_FS_ROOT: scratch,
      CG_WORKSPACE_DIR: DEFAULT_WORKSPACE_ROOT,
      HOME: ISOLATED_HOME,
    },
  });
  const client = new Client({ name: "mcp-control-plane-test", version: "1.0.0" }, { capabilities: {} });
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

const resultText = (r) => r.content?.map((i) => i.text || "").join("\n") || "";
const approvalReceipt = /Human approval was received before this tool executed/;
const awaitingCard = /awaiting approval \(request .*\)\. The exact change is saved with no deadline/;

// Apply a saved control-plane approval the way the daemon does on a click (server.js): in-process,
// as the original requester, through the same gateway MCP server a turn uses. The stdio child
// above only POSTs the exact action to the stub; this is the other half.
const { executeControlPlaneApproval, setControlPlaneInvoker, CONTROL_PLANE_ACTION } = await import("../src/gateway/control-plane-approvals.js");
const { createGatewayMcpServer: createInProcessServer, ctxFromClaims: ctxForSaved, createDirectDaemonIpc } = await import("../src/mcp/gateway-server.js");
setControlPlaneInvoker(async ({ tool, args, channelId, slug, authorId, threadKey }) => {
  const ctx = ctxForSaved({ channelId, slug, authorId, threadKey, origin: "approval", principalTrusted: true, toolset: "full" }, { daemon: createDirectDaemonIpc({}) });
  return createInProcessServer(ctx).invokeApproved(tool, args);
});
let savedSeq = 0;
async function applySaved(body, decidedBy) {
  const action = body.durableAction;
  assert.equal(action?.kind, CONTROL_PLANE_ACTION, "the request carried a saved control-plane action");
  return executeControlPlaneApproval({ id: `saved-${++savedSeq}`, status: "executing", channelId: action.channelId, slug: action.slug, authorId: action.authorId, decidedBy, action });
}

test("both engine contexts save exact instruction updates and return pending without writing", async () => {
  for (const engine of ["claude", "codex"]) {
    approvalRequests.length = 0;
    approvalResponse = { allow: false, pending: true, approvalId: `instruction-${engine}` };
    const rule = `- Use the ${engine} acceptance marker in test summaries.`;
    const file = path.join(DEFAULT_WORKDIR, "CLAUDE.md");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    await withGateway({ engine }, async (client) => {
      const result = await client.callTool({ name: "update_channel_instructions", arguments: { text: `${" ".repeat(3000)}${rule}\n` } });
      assert.match(resultText(result), /no deadline.*survives gateway restarts/);
      assert.match(resultText(result), /Nothing has changed yet/);
      assert.doesNotMatch(resultText(result), approvalReceipt);
    });
    assert.equal(approvalRequests.length, 1);
    assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before);
    const action = approvalRequests[0].body.durableAction;
    assert.equal(action.kind, "channel_instructions");
    assert.equal(action.text, rule);
    assert.equal(action.mode, "append");
    assert.equal(action.workDir, DEFAULT_WORKDIR);
    assert.equal(action.channelId, CHANNEL);
    assert.equal(action.authorId, "U_CTRL_ADMIN");
    assert.match(action.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(approvalRequests[0].body.toolInput.details.length < 2800, "preview uses the exact normalized text, not hidden leading whitespace");
    assert.match(approvalRequests[0].body.toolInput.details, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("instruction replacement is an admin's call and applies at once, quoted in the reply; oversized rules never post", async () => {
  // Operator decision 2026-10-07: replacing the whole section is channel-scoped and visible, so it
  // is automatic for an admin — the handler makes the model quote the complete new text in the
  // thread instead of parking it on a card. Appending stays a durable card anyone here approves.
  approvalRequests.length = 0;
  approvalResponse = { allow: false, pending: true, approvalId: "replacement" };
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const denied = await client.callTool({ name: "update_channel_instructions", arguments: { text: "replacement", mode: "replace" } });
    assert.match(resultText(denied), /Only admins can replace/);
  });
  assert.equal(approvalRequests.length, 0);
  const file = path.join(DEFAULT_WORKDIR, "CLAUDE.md");
  await withGateway({}, async (client) => {
    const replaced = await client.callTool({ name: "update_channel_instructions", arguments: { text: "- Replacement rule for the whole section.", mode: "replace" } });
    assert.match(resultText(replaced), /Replaced this channel's standing instructions/);
    assert.match(resultText(replaced), /Quote the complete new instructions in your reply/);
    assert.doesNotMatch(resultText(replaced), approvalReceipt);
    assert.equal(approvalRequests.length, 0, "an admin's replacement posts no card");
    assert.match(readFileSync(file, "utf8"), /Replacement rule for the whole section\./);
    const oversized = await client.callTool({ name: "update_channel_instructions", arguments: { text: "x".repeat(2401) } });
    assert.match(resultText(oversized), /at most 2400/);
  });
  assert.equal(approvalRequests.length, 0);
});

test.before(async () => {
  await setUser("U_CTRL_ADMIN", { name: "Ctrl Admin", approved: true, isAdmin: true });
  await setUser("U_CTRL_MEMBER", { name: "Ctrl Member", approved: true, isAdmin: false });
  await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
  await saveChannelMeta(SLUG, { channelId: CHANNEL, allowBash: false, adminMode: false });
});

test("a surviving card is durable: the exact call is saved, never applied inline, and a refusal leaves state untouched", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "Denied by <@U_CTRL_ADMIN>" };
  await withGateway({}, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /Couldn't save the approval for `set_channel_admin_mode`/);
    assert.match(resultText(result), /Denied by <@U_CTRL_ADMIN>/);
    assert.doesNotMatch(resultText(result), approvalReceipt);
  });
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false, "the refused change must not persist");
  assert.equal(approvalRequests.length, 1);
  const req = approvalRequests[0];
  assert.equal(req.secret, "ctrl-test-secret");
  assert.equal(req.body.approvalType, "agent"); // never auto-approved — auto mode can't bypass
  assert.equal(req.body.toolName, "set_channel_admin_mode");
  assert.match(req.body.toolInput.details, /ADMIN MODE/);
  assert.equal(req.body.requiredTier, "admin");
  assert.deepEqual({ kind: req.body.durableAction.kind, tool: req.body.durableAction.tool, args: req.body.durableAction.args, tier: req.body.durableAction.tier, authorId: req.body.durableAction.authorId },
    { kind: CONTROL_PLANE_ACTION, tool: "set_channel_admin_mode", args: { enabled: true }, tier: "admin", authorId: "U_CTRL_ADMIN" });

  // A pending answer parks the call with no deadline and no change.
  approvalRequests.length = 0;
  approvalResponse = { allow: false, pending: true, approvalId: "admin-mode-1" };
  await withGateway({}, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), awaitingCard);
    assert.match(resultText(result), /when a gateway admin clicks Approve/);
    assert.match(resultText(result), /Nothing has changed yet/);
  });
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
  assert.equal(approvalRequests.length, 1);
});

test("channel settings are automatic for whoever holds their authority — admins, and managers where the channel lets members manage", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "no card may be posted" };
  const original = await getChannelMeta(SLUG);
  try {
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } });
      assert.match(resultText(result), /Bash \+ file edits ON/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
      assert.match(resultText(await client.callTool({ name: "set_channel_network", arguments: { enabled: true } })), /✅/);
      assert.match(resultText(await client.callTool({ name: "set_channel_bash", arguments: { enabled: false } })), /✅/);
      assert.match(resultText(await client.callTool({ name: "set_channel_network", arguments: { enabled: false } })), /✅/);
    });
    assert.equal(approvalRequests.length, 0, "an admin's channel settings post no card");
    // This fixture row predates the members default (no manageAccess stored → admins only).
    await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
      assert.match(resultText(await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } })), /Only this channel's managers/);
      assert.match(resultText(await client.callTool({ name: "set_channel_network", arguments: { enabled: true } })), /Only admins/);
    });
    assert.equal((await getChannelMeta(SLUG))?.allowBash, false);
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), manageAccess: "members" });
    await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
      assert.match(resultText(await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } })), /Bash \+ file edits ON/i);
      assert.match(resultText(await client.callTool({ name: "set_channel_auto_mode", arguments: { enabled: true } })), /✅/);
    });
    assert.equal((await getChannelMeta(SLUG))?.allowBash, true);
    assert.equal((await getChannelMeta(SLUG))?.autoMode, true);
    assert.equal(approvalRequests.length, 0, "a manager's channel settings post no card either");
  } finally {
    await saveChannelMeta(SLUG, original);
  }
});

test("a saved control-plane approval is applied on the click, as the requester, by whoever holds its tier", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, pending: true, approvalId: "admin-mode-2" };
  await withGateway({}, async (client) => {
    await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
  });
  const [req] = approvalRequests;
  // A member's click does not count for an admin-tier card; neither does a lapsed admin.
  const bystander = await applySaved(req.body, "U_CTRL_MEMBER");
  assert.equal(bystander.ok, false);
  assert.match(bystander.error, /Only a gateway admin can approve this/);
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
  await setUser("U_CTRL_ADMIN", { name: "Ctrl Admin", approved: true, isAdmin: false });
  try {
    const lapsed = await applySaved(req.body, "U_CTRL_ADMIN");
    assert.equal(lapsed.ok, false);
    assert.match(lapsed.error, /no longer an admin/);
  } finally {
    await setUser("U_CTRL_ADMIN", { name: "Ctrl Admin", approved: true, isAdmin: true });
  }
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
  // The admin's click applies exactly the saved call.
  const applied = await applySaved(req.body, "U_CTRL_ADMIN");
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.completed, true);
  assert.match(applied.message, /Admin mode ON/);
  assert.equal((await getChannelMeta(SLUG))?.adminMode, true);
  // The admin UI's session is an admin; a tampered row is refused.
  assert.equal((await applySaved({ ...req.body, durableAction: { ...req.body.durableAction, args: { enabled: false } } }, "admin UI")).ok, true);
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
  const tampered = await executeControlPlaneApproval({ id: "x", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: "U_CTRL_MEMBER", decidedBy: "U_CTRL_ADMIN", action: { ...req.body.durableAction } });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /Invalid saved control-plane approval/);
  const notControlPlane = await executeControlPlaneApproval({ id: "y", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: "U_CTRL_ADMIN", decidedBy: "U_CTRL_ADMIN", action: { ...req.body.durableAction, tool: "list_schedules" } });
  assert.equal(notControlPlane.ok, false);
  assert.match(notControlPlane.error, /not a control-plane tool/);
});

test("memory search and read handlers use the injected MCP text formatter", async () => {
  mkdirSync(DEFAULT_WORKDIR, { recursive: true });
  writeFileSync(path.join(DEFAULT_WORKDIR, "MEMORY.md"), "# Channel memory\n\nRelease workflow uses the canary fixture.\n");

  await withGateway({}, async (client) => {
    const search = await client.callTool({ name: "search_channel_memory", arguments: { query: "canary fixture" } });
    assert.match(resultText(search), /MEMORY\.md/);
    assert.doesNotMatch(resultText(search), /text is not defined/);

    const read = await client.callTool({ name: "read_channel_memory", arguments: { source: "MEMORY.md" } });
    assert.match(resultText(read), /Release workflow uses the canary fixture/);
    assert.doesNotMatch(resultText(read), /text is not defined/);
  });
});

test("a member's own connector token is self-service: no card, and the value never leaves the handler", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "no card may be posted" };
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const result = await client.callTool({ name: "set_my_composio_token", arguments: { token: "sk-super-secret-value" } });
    assert.match(resultText(result), /✅/);
    assert.doesNotMatch(resultText(result), /sk-super-secret-value/);
    assert.doesNotMatch(resultText(result), approvalReceipt);
    assert.match(resultText(await client.callTool({ name: "clear_my_composio_token", arguments: {} })), /✅|Removed|removed/);
  });
  assert.equal(approvalRequests.length, 0);
});

test("an unreachable approval endpoint fails closed", async () => {
  approvalRequests.length = 0;
  await withGateway({ port: 1 }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /Couldn't save the approval/i);
    assert.doesNotMatch(resultText(result), approvalReceipt);
  });
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
});

test("update_gateway is automatic for an admin in every mode and stays admin-only", async () => {
  const reserved = reserveUpdate({ root: scratch, source: "approval-policy-test" });
  assert.equal(reserved.ok, true);
  try {
    approvalResponse = { allow: false, reason: "no card may be posted" };

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({ engine: "claude" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /already active/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
    });
    assert.equal(approvalRequests.length, 0, "read mode no longer posts a card for an admin");

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: true, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({ engine: "claude" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /already active/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
    });
    assert.equal(approvalRequests.length, 0, "Admin mode starts without the extra card");

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, autoMode: true });
    approvalRequests.length = 0;
    await withGateway({ engine: "codex" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /already active/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
    });
    assert.equal(approvalRequests.length, 0, "Auto mode starts without the extra card");

    approvalRequests.length = 0;
    await withGateway({ author: "U_CTRL_MEMBER", engine: "codex" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /Only admins/i);
    });
    assert.equal(approvalRequests.length, 0, "non-admin callers remain refused without approval spam");
  } finally {
    releaseUpdate({ root: scratch, owner: reserved.owner });
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, autoMode: false });
  }
});

test("both engine MCP contexts refuse managed updates for a free license", async () => {
  try {
    testLicenseEnv({ tier: "free" });
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: true });
    for (const engine of ["claude", "codex"]) {
      await withGateway({ engine }, async (client) => {
        const result = await client.callTool({ name: "update_gateway", arguments: {} });
        assert.match(resultText(result), /Enterprise/);
        assert.match(resultText(result), /manually/);
      });
    }
  } finally {
    testLicenseEnv();
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false });
  }
});

test("restart_gateway is automatic for an admin in every mode and stays admin-only", async () => {
  const original = await getChannelMeta(SLUG);
  restartResponse = { ok: true, id: "restart-test", waitMs: 300_000, pollMs: 30_000 };
  try {
    approvalResponse = { allow: false, reason: "no card may be posted" };
    await saveChannelMeta(SLUG, { ...original, adminMode: false, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "restart_gateway", arguments: {} });
      assert.match(resultText(result), /Safe restart queued/i);
    });
    assert.deepEqual(approvalRequests.map((request) => request.url), ["/internal/restart"], "read mode: a safe restart drains work and needs no card");

    await saveChannelMeta(SLUG, { ...original, adminMode: true, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "restart_gateway", arguments: {} });
      assert.match(resultText(result), /Safe restart queued/i);
    });
    assert.deepEqual(approvalRequests.map((request) => request.url), ["/internal/restart"]);

    approvalRequests.length = 0;
    await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
      const result = await client.callTool({ name: "restart_gateway", arguments: {} });
      assert.match(resultText(result), /Only admins/i);
    });
    assert.equal(approvalRequests.length, 0);
  } finally {
    await saveChannelMeta(SLUG, original);
  }
});

test("read-only tools and memory writes in default or custom workdirs never hit the approval endpoint", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "should never be asked" };
  const original = await getChannelMeta(SLUG);
  try {
    await saveChannelMeta(SLUG, { ...original, workDir: "" });
    await withGateway({}, async (client) => {
      await client.callTool({ name: "list_schedules", arguments: {} });
      await client.callTool({ name: "list_channel_mcps", arguments: {} });
      await client.callTool({ name: "get_channel_workdir", arguments: {} });
      const result = await client.callTool({ name: "update_channel_memory", arguments: { action: "add", text: "- default-workdir fact" } });
      assert.match(resultText(result), /Memory updated/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
      assert.match(resultText(result), new RegExp(DEFAULT_WORKDIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(resultText(result), new RegExp(ISOLATED_HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    await saveChannelMeta(SLUG, { ...original, workDir: CUSTOM_WORKDIR });
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "update_channel_memory", arguments: { action: "add", text: "- custom-workdir fact" } });
      assert.match(resultText(result), /Memory updated/i);
      assert.doesNotMatch(resultText(result), approvalReceipt);
      assert.match(resultText(result), new RegExp(CUSTOM_WORKDIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  } finally {
    await saveChannelMeta(SLUG, original);
  }
  assert.equal(approvalRequests.length, 0);
});

test("an unauthorized caller gets the handler refusal, not an approval card", async () => {
  approvalRequests.length = 0;
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /Only admins/i);
  });
  assert.equal(approvalRequests.length, 0, "no approval spam for callers who could never pass authz");
});

test("both engine contexts enable own SSH without approvals; other-user changes keep the manager gate", async () => {
  const original = await getChannelMeta(SLUG);
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ssh-self-service-fixture";
  approvalResponse = { allow: false, reason: "self-service must not ask" };
  try {
    for (const engine of ["claude", "codex"]) {
      approvalRequests.length = 0;
      await saveChannelMeta(SLUG, { ...original, sshUsers: [], manageAccess: "admins" });
      await withGateway({ author: "U_CTRL_MEMBER", engine }, async client => {
        const registered = await client.callTool({ name: "add_my_ssh_key", arguments: { public_key: publicKey } });
        assert.match(resultText(registered), /Registered your ED25519 key/);
        for (const args of [{}, { user: "U_CTRL_MEMBER" }, { user: "<@U_CTRL_MEMBER|member>" }]) {
          const granted = await client.callTool({ name: "grant_channel_ssh", arguments: args });
          assert.match(resultText(granted), /may now SSH|already has SSH access/);
          assert.doesNotMatch(resultText(granted), approvalReceipt);
        }
        assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, ["U_CTRL_MEMBER"]);
        const other = await client.callTool({ name: "grant_channel_ssh", arguments: { user: "U_CTRL_ADMIN" } });
        assert.match(resultText(other), /Only this channel's managers/);
        assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, ["U_CTRL_MEMBER"]);
        const revoked = await client.callTool({ name: "revoke_channel_ssh", arguments: {} });
        assert.match(resultText(revoked), /revoked here/);
        assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, []);
        const keys = await client.callTool({ name: "list_my_ssh_keys", arguments: {} });
        const fingerprint = resultText(keys).match(/SHA256:[A-Za-z0-9+/]+/)[0];
        assert.match(resultText(await client.callTool({ name: "remove_my_ssh_key", arguments: { key: fingerprint } })), /Removed your key/);
      });
      assert.equal(approvalRequests.length, 0, `${engine}: own SSH never contacts the approval service`);
      await withGateway({ engine }, async client => {
        assert.match(resultText(await client.callTool({ name: "grant_channel_ssh", arguments: { user: "U_CTRL_MEMBER" } })), /may now SSH/);
        assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, ["U_CTRL_MEMBER"]);
        assert.match(resultText(await client.callTool({ name: "revoke_channel_ssh", arguments: { user: "U_CTRL_MEMBER" } })), /revoked/);
      });
      assert.equal(approvalRequests.length, 0, `${engine}: a manager's grant for someone else is automatic (operator decision 2026-10-07)`);
      assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, []);
      approvalRequests.length = 0;
      await saveChannelMeta(SLUG, { ...original, sshUsers: [], access: "admins", allowedUsers: [] });
      await withGateway({ author: "U_CTRL_MEMBER", engine }, async client => {
        assert.match(resultText(await client.callTool({ name: "grant_channel_ssh", arguments: {} })), /not allowed in this channel/);
      });
      assert.equal(approvalRequests.length, 0);
      assert.deepEqual((await getChannelMeta(SLUG)).sshUsers, []);
    }
  } finally {
    await saveChannelMeta(SLUG, original);
  }
});

test("every registered gateway tool is consciously classified as gated or open (drift tripwire)", async () => {
  // A NEW state-changing tool that nobody adds to CONTROL_PLANE ships approval-free by
  // omission. This inventory forces the classification to be a reviewed decision: an
  // unclassified tool fails here until it is added to exactly one of these lists.
  const GATED = new Set([
    "set_channel_vpn", "set_channel_admin_mode", "set_channel_network", "set_channel_bash", "set_channel_auto_mode",
    "set_channel_workdir", "clear_channel_workdir", "set_channel_drive_folder", "clear_channel_drive_folder",
    "add_channel_mcps", "remove_channel_mcps", "update_channel_instructions",
    "update_gateway", "restart_gateway", "update_gateway_guide", "reset_gateway_guide",
    "set_my_composio_token", "clear_my_composio_token",
    "set_my_toolbox_token", "clear_my_toolbox_token",
    // environment secret scopes that are not the channel's: each changes which account future runs
    // authenticate as, and the organization one does it for every conversation at once
    "set_secret", "remove_secret",
    // hidden/readable and approved servers: readable hands containers the raw value, an approved
    // server is where the real value may go (src/gateway/secret-host-approvals.js)
    "set_secret_mode", "allow_secret_host",
    "set_license_key", "clear_license_key", // gateway-wide licensing state (src/ee/)
    // SSH grants for OTHER people retain the manager approval; own changes return null details.
    "grant_channel_ssh", "revoke_channel_ssh",
    // skills platform: the ORGANIZATION tier (admin decisions, org grants, sources, governance,
    // moving a skill in or out of the shared library) and Git publishing keep their card
    "decide_skill_proposal", "sync_skill_sources",
    "publish_skill", "add_org_skills", "remove_org_skills", "update_skill_template",
    "add_skill_source", "set_skill_source", "remove_skill_source", "set_skill_excluded", "set_skill_governance", "set_skill_scope",    // Publishing bytes outside the gateway: a "share" link puts a channel file at an
    // unauthenticated URL for up to 48h and cannot be recalled once fetched. Its `details()`
    // returns null for the short machine-facing "upload" purpose, the same conditional shape
    // update_gateway/restart_gateway use for their admin-mode exception.
    "create_public_file_link",
  ]);
  const OPEN = new Set([
    // read-only
    "get_channel_vpn_status", "query_channel_database", "list_available_mcps", "list_channel_mcps", "list_schedules", "get_schedule_runs", "update_schedule", "list_folders",
    "get_channel_workdir", "get_channel_drive_folder", "get_gateway_guide",
    "workspace_list", "workspace_read", "workspace_search",
    "search_channel_memory", "read_channel_memory", // channel-scoped read-only retrieval
    "get_license_status", // read-only; exposes the tier/limits and the key's last 4, never the key
    // writes that land visibly in the current thread, or run inside normal confinement
    "slack_post_chart", "slack_post_table", "slack_upload_snippet",
    "slack_compose_reply", // validates + acknowledges only; the daemon renders the observed call under THIS thread's answer
    "slack_share_file", // one confined channel file into THIS thread, like the explorer's Share button
    "slack_list_create", "slack_list_add_item", "slack_list_update_item", "slack_list_info", "slack_list_items",
    "slack_channel_history", "slack_thread_replies",
    "slack_download_file", // lands only in this thread's uploads/ folder, this channel's files only
    "run_in_background", "run_agent_in_background", // shell kind has its own admin-click gate in background.js
    "request_approval", "permission_prompt", "report_progress", "ask_questions",
    "update_channel_memory", // operator decision 2026-08-07: memory is agent-owned, never approval-gated
    // operator decision 2026-08-19: reminders/scheduled tasks are an ordinary channel request and
    // are never approval-gated. A schedule fires with origin "schedule" (cannot escalate — A2), in
    // this channel, as its creator, and stays inspectable/reversible via list_/delete_schedule.
    "create_schedule", "delete_schedule",
    // skills platform reads/previews; a proposal only queues a review for an admin
    "list_skills", "show_channel_skills", "list_skill_templates", "preview_skill_template",
    "get_skill_file", "get_skill_info", "propose_skill_change", "list_skill_proposals", "skill_usage_report",
    "list_skill_sources", // admin read
    "list_secrets", // one masked name listing across the three scopes; there is no reveal path anywhere
    "list_my_ssh_keys", "show_channel_ssh", // the requester's own keys; this channel's SSH state and the connection block
    "add_my_ssh_key", "remove_my_ssh_key", // personal keys are self-service
    // operator decision 2026-09-05: a member's OWN skill tier (what only their runs carry) is
    // self-service like starring in a skill library — reversible, affects nobody else, no card.
    "add_my_skills", "remove_my_skills",
    // operator decision 2026-09-27: personal and CHANNEL skills are their author's / the channel
    // members' and never wait for anyone. The handlers enforce the tier (a non-admin's organization
    // request becomes a channel skill plus an admin proposal; a full catalog delete is an admin's)
    // and tell the model to announce every change in its reply.
    "create_skill", "update_skill", "delete_skill",
    "add_channel_skills", "remove_channel_skills", "set_channel_skill_template",
    // sends ONE already-readable channel file to Composio's storage for a tool call the user asked
    // for; publishes nothing, spends only the identity the caller named, and the destination tool
    // call is separately visible. Path is confined to the channel folder.
    "stage_file_for_composio",
    "list_public_file_links", // read-only; shows ids and expiries, never reprints a minted URL
    // strictly de-escalating: it REMOVES public access. Gating a revocation would stall the one
    // action someone takes when a link should not have gone out.
    "revoke_public_file_link",
        // runs this channel's ALREADY-linked Drive sync early — the same pass the schedule runs anyway,
    // this channel only, obeying the admin's global switch; linking/unlinking stays gated
    "sync_channel_drive",
  ]);
  await withGateway({}, async (client) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 20, `expected the full tool inventory, got ${tools.length}`);
    for (const tool of tools) {
      const gated = GATED.has(tool.name);
      const open = OPEN.has(tool.name);
      assert.ok(gated || open, `unclassified gateway tool "${tool.name}" — decide: CONTROL_PLANE gate or explicitly open, then add it to the matching list here`);
      assert.ok(!(gated && open), `"${tool.name}" is in both lists`);
    }
  });
});

const creationFiles = slug => [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Harmless skill authoring fixture.\n---\n\nReturn the fixture name.\n` }];
const announce = /Mention this skill change in your reply/;

test("both engines: an admin's skill writes land at once with no approval card, channel by default", async () => {
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  const { getUser } = await import("../src/config/store.js");
  const { channelSkillGrants } = await import("../src/gateway/skills/templates.js");
  for (const engine of ["claude", "codex"]) {
    approvalRequests.length = 0;
    approvalResponse = { allow: false, reason: "no card may be posted" };
    await withGateway({ engine }, async client => {
      const call = async (name, args) => resultText(await client.callTool({ name, arguments: args }));
      const channelSkill = `admin-channel-${engine}`;
      let out = await call("create_skill", { slug: channelSkill, files: creationFiles(channelSkill) });
      assert.match(out, /Created channel skill/);
      assert.match(out, announce);
      assert.equal(getSkill(channelSkill).channelScope, CHANNEL, "no scope named = this channel's own skill");
      assert.equal(getSkill(channelSkill).visibility, "org");

      const orgSkill = `admin-org-${engine}`;
      out = await call("create_skill", { slug: orgSkill, files: creationFiles(orgSkill), scope: "organization" });
      assert.match(out, /Created organization skill/);
      assert.equal(getSkill(orgSkill).channelScope, "", "an admin's organization skill goes straight into the shared library");
      assert.ok((await getChannelMeta(SLUG)).skills.includes(orgSkill));

      const personalSkill = `admin-personal-${engine}`;
      out = await call("create_skill", { slug: personalSkill, files: creationFiles(personalSkill), personal: true });
      assert.match(out, /Created personal skill/);
      assert.ok((await getUser("U_CTRL_ADMIN")).skills.includes(personalSkill));

      const invalid = `invalid-personal-channel-${engine}`;
      out = await call("create_skill", { slug: invalid, files: creationFiles(invalid), personal: true, scope: "channel" });
      assert.match(out, /personal skill cannot be scoped to a channel/);
      assert.equal(getSkill(invalid), null);

      for (const skill of [channelSkill, orgSkill]) {
        out = await call("update_skill", { skill, files: [{ path: "references/marker.md", content: "edit" }] });
        assert.match(out, /now revision 2/);
        assert.match(out, announce);
      }
      out = await call("remove_channel_skills", { slugs: [channelSkill] });
      assert.match(out, /Deactivated here: `/);
      assert.ok(!channelSkillGrants(await getChannelMeta(SLUG)).includes(channelSkill), "a channel skill deactivates in this conversation");
      assert.equal(getSkill(channelSkill).deleted, false, "deactivating is not deleting");
      out = await call("add_channel_skills", { slugs: [channelSkill] });
      assert.match(out, /turned back on/);
      assert.ok(channelSkillGrants(await getChannelMeta(SLUG)).includes(channelSkill));
      assert.deepEqual((await getChannelMeta(SLUG)).skillsOff, [], "turning a section skill back on clears its deactivation");

      out = await call("delete_skill", { skill: orgSkill });
      assert.match(out, /Removed `/);
      assert.equal(getSkill(orgSkill).deleted, true);
    });
    assert.equal(approvalRequests.length, 0, `${engine}: no skill write by an admin posted an approval card`);
  }
});

test("both engines: a member owns channel and personal skills without approval; the organization tier goes to an admin", async () => {
  const { getSkill, getProposal } = await import("../src/gateway/skills/catalog.js");
  const { channelSkillGrants } = await import("../src/gateway/skills/templates.js");
  for (const engine of ["claude", "codex"]) {
    const adminChannelSkill = `shared-channel-${engine}`;
    const adminOrgSkill = `shared-org-${engine}`;
    await withGateway({ engine }, async client => {
      await client.callTool({ name: "create_skill", arguments: { slug: adminChannelSkill, files: creationFiles(adminChannelSkill) } });
      await client.callTool({ name: "create_skill", arguments: { slug: adminOrgSkill, files: creationFiles(adminOrgSkill), scope: "organization" } });
    });
    approvalRequests.length = 0;
    approvalResponse = { allow: false, reason: "no card may be posted" };
    let deleteRequest = 0;
    await withGateway({ engine, author: "U_CTRL_MEMBER" }, async client => {
      const call = async (name, args) => resultText(await client.callTool({ name, arguments: args }));
      const own = `member-channel-${engine}`;
      let out = await call("create_skill", { slug: own, files: creationFiles(own) });
      assert.match(out, /Created channel skill/);
      assert.equal(getSkill(own).createdBy, "U_CTRL_MEMBER");

      out = await call("update_skill", { skill: adminChannelSkill, files: [{ path: "references/member.md", content: "member edit" }] });
      assert.match(out, /now revision 2/, "any member edits the channel's skills, whoever wrote them");

      const wantedOrg = `member-org-${engine}`;
      out = await call("create_skill", { slug: wantedOrg, files: creationFiles(wantedOrg), scope: "organization" });
      assert.match(out, /Created channel skill/);
      assert.match(out, /promotion request #(\d+) is filed/);
      assert.equal(getSkill(wantedOrg).channelScope, CHANNEL, "a member's organization request starts as a channel skill");
      const promote = getProposal(Number(out.match(/promotion request #(\d+)/)[1]));
      assert.equal(promote.kind, "promote");
      assert.equal(promote.status, "pending");

      const orgRevision = getSkill(adminOrgSkill).currentRevisionId;
      out = await call("update_skill", { skill: adminOrgSkill, files: [{ path: "references/member.md", content: "member edit" }] });
      assert.match(out, /change proposal #\d+ is filed/);
      assert.equal(getSkill(adminOrgSkill).currentRevisionId, orgRevision);
      assert.doesNotMatch(out, /now revision/, "an organization skill does not change on a member's word");

      out = await call("delete_skill", { skill: adminChannelSkill });
      assert.match(out, /Deactivated `/);
      assert.match(out, /delete request #(\d+) is filed/);
      deleteRequest = Number(out.match(/delete request #(\d+)/)[1]);
      assert.equal(getSkill(adminChannelSkill).deleted, false, "only an admin deletes from the whole catalog");
      assert.ok(!channelSkillGrants(await getChannelMeta(SLUG)).includes(adminChannelSkill));

      out = await call("set_skill_scope", { skill: own, scope: "library" });
      assert.match(out, /Only admins/);
    });
    assert.equal(approvalRequests.length, 0, `${engine}: nothing a member did with channel/personal skills posted a card`);

    // Approving a proposal is the one skill step that still carries a card: durable, applied on
    // the admin's click, never inline.
    approvalResponse = { allow: false, pending: true, approvalId: `decide-${engine}` };
    await withGateway({ engine }, async client => {
      const out = resultText(await client.callTool({ name: "decide_skill_proposal", arguments: { id: deleteRequest, decision: "approve" } }));
      assert.match(out, awaitingCard);
      assert.doesNotMatch(out, approvalReceipt);
    });
    assert.deepEqual(approvalRequests.map(r => [r.body.toolName, r.body.requiredTier]), [["decide_skill_proposal", "admin"]]);
    assert.equal(getSkill(adminChannelSkill).deleted, false, "nothing changes until the click");
    const applied = await applySaved(approvalRequests[0].body, "U_CTRL_ADMIN");
    assert.equal(applied.ok, true, applied.error);
    assert.match(applied.message, /removed from the catalog/);
    assert.equal(getSkill(adminChannelSkill).deleted, true);
  }
});

test("both engines: a member asks for a template change; only an admin edits a template, with its card", async () => {
  const { getTemplate, upsertTemplate } = await import("../src/gateway/skills/catalog.js");
  for (const engine of ["claude", "codex"]) {
    const tpl = `ctrl-tpl-${engine}`;
    upsertTemplate({ slug: tpl, name: `Ctrl Tpl ${engine}`, skills: [] });
    const wanted = `tpl-wanted-${engine}`;
    await withGateway({ engine }, async client => {
      await client.callTool({ name: "create_skill", arguments: { slug: wanted, files: creationFiles(wanted), scope: "organization" } });
    });
    approvalRequests.length = 0;
    let requestId = 0;
    await withGateway({ engine, author: "U_CTRL_MEMBER" }, async client => {
      const refused = resultText(await client.callTool({ name: "update_skill_template", arguments: { template: tpl, add: [wanted] } }));
      assert.match(refused, /Only admins/);
      const asked = resultText(await client.callTool({ name: "propose_skill_change", arguments: { skill: wanted, kind: "template", template: tpl, note: "our team needs it" } }));
      assert.match(asked, new RegExp(`template → template ${tpl}`));
      requestId = Number(asked.match(/Proposal #(\d+)/)[1]);
    });
    assert.equal(approvalRequests.length, 0, "a member's refusal and request post no card");
    assert.deepEqual(getTemplate(tpl).skills, []);

    // Approving the proposal and ADDING to a template push content into every following
    // conversation: both keep a durable admin card. Rejecting and removing are automatic.
    approvalResponse = { allow: false, pending: true, approvalId: `tpl-${engine}` };
    await withGateway({ engine }, async client => {
      const parked = resultText(await client.callTool({ name: "decide_skill_proposal", arguments: { id: requestId, decision: "approve" } }));
      assert.match(parked, awaitingCard);
      assert.deepEqual(getTemplate(tpl).skills, []);
      const applied = await applySaved(approvalRequests[0].body, "U_CTRL_ADMIN");
      assert.equal(applied.ok, true, applied.error);
      assert.match(applied.message, /added to the .* template/);
      assert.deepEqual(getTemplate(tpl).skills, [wanted]);
      const edited = resultText(await client.callTool({ name: "update_skill_template", arguments: { template: tpl, remove: [wanted] } }));
      assert.match(edited, /template updated/);
      assert.doesNotMatch(edited, approvalReceipt);
      assert.deepEqual(getTemplate(tpl).skills, []);
      const parkedAdd = resultText(await client.callTool({ name: "update_skill_template", arguments: { template: tpl, add: [wanted] } }));
      assert.match(parkedAdd, awaitingCard);
      assert.deepEqual(getTemplate(tpl).skills, [], "adding waits for the click");
      const rejectedProposal = resultText(await client.callTool({ name: "decide_skill_proposal", arguments: { id: requestId, decision: "reject" } }));
      assert.doesNotMatch(rejectedProposal, awaitingCard);
    });
    assert.deepEqual(approvalRequests.map(r => [r.body.toolName, r.body.requiredTier]), [["decide_skill_proposal", "admin"], ["update_skill_template", "admin"]]);
    assert.match(approvalRequests[1].body.toolInput.details, /Add to the .* skill template/);
  }
});

test("a durable instruction approval never reports a live handler as approved even if IPC returns allow", async () => {
  approvalResponse = { allow: true };
  const file = path.join(DEFAULT_WORKDIR, "CLAUDE.md");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  await withGateway({}, async client => {
    const result = await client.callTool({ name: "update_channel_instructions", arguments: { text: "- Must stay unapplied." } });
    assert.match(resultText(result), /Couldn't save the approval for `update_channel_instructions`/);
    assert.doesNotMatch(resultText(result), approvalReceipt);
  });
  assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before);
});

test("the approved-result wrapper preserves mixed content, structured data, metadata and error status", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createGatewayMcpServer, ctxFromClaims } = await import("../src/mcp/gateway-server.js");
  const ctx = ctxFromClaims({ channelId: CHANNEL, slug: SLUG, authorId: "U_CTRL_ADMIN", threadKey: "receipt-contract", principalTrusted: true }, {
    toolset: "memory-review", daemon: { available: () => true, call: async () => ({ allow: true }) },
  });
  const server = createGatewayMcpServer(ctx);
  const original = Object.freeze({
    isError: true,
    content: Object.freeze([
      Object.freeze({ type: "text", text: "The approved operation failed; no change was made.", annotations: { audience: ["user"] } }),
      Object.freeze({ type: "image", data: "aGVsbG8=", mimeType: "image/png" }),
    ]),
    structuredContent: Object.freeze({ changed: false, diagnostic: "fixture failure" }),
    _meta: Object.freeze({ trace: "receipt-test" }),
  });
  // The public-link card is the one gated call still answered inline (the model needs the URL).
  const { z } = await import("zod");
  server.registerTool("create_public_file_link", { inputSchema: { path: z.string(), purpose: z.string(), minutes: z.number() } }, async () => original);
  const client = new Client({ name: "receipt-contract", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "create_public_file_link", arguments: { path: "report.pdf", purpose: "share", minutes: 30 } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content.slice(0, 2), original.content);
    assert.deepEqual(result.structuredContent, original.structuredContent);
    assert.deepEqual(result._meta, original._meta);
    assert.equal(result.content.length, 3);
    assert.match(result.content[2].text, approvalReceipt);
    assert.match(result.content[2].text, /does not establish whether the requested change succeeded/);
    assert.equal(original.content.length, 2, "the handler result is not mutated");
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_channel_mcps names the conversation's custom MCP servers, never their URL or token", async () => {
  const original = await getChannelMeta(SLUG);
  try {
    await saveChannelMeta(SLUG, { ...original, customMcps: [{ name: "linear", url: "https://mcp.example.com/mcp?key=url-secret", token: "list-token-secret" }] });
    await withGateway({}, async (client) => {
      const listed = resultText(await client.callTool({ name: "list_channel_mcps", arguments: {} }));
      assert.match(listed, /Custom MCP servers here .*custom-linear/);
      assert.doesNotMatch(listed, /url-secret|list-token-secret|mcp\.example\.com/);
    });
  } finally {
    await saveChannelMeta(SLUG, original);
  }
});
