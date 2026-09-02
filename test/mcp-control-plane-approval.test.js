// Control-plane approval gate (the 2026-08 update plan (internal repo) A3): gateway MCP tools that change future
// privileges or persistent state require a human Approve click in Slack on top of the handler's
// own authz. Exercised end-to-end over the real stdio server with a local HTTP stub standing in
// for the daemon's /internal/approval endpoint.
import path from "node:path";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv } from "./helpers.js";

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

test.before(async () => {
  await setUser("U_CTRL_ADMIN", { name: "Ctrl Admin", approved: true, isAdmin: true });
  await setUser("U_CTRL_MEMBER", { name: "Ctrl Member", approved: true, isAdmin: false });
  await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
  await saveChannelMeta(SLUG, { channelId: CHANNEL, allowBash: false, adminMode: false });
});

test("a denied approval blocks the change and carries the human-readable card", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "Denied by <@U_CTRL_ADMIN>" };
  await withGateway({}, async (client) => {
    const result = await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } });
    assert.match(resultText(result), /not approved/i);
    assert.match(resultText(result), /Denied by <@U_CTRL_ADMIN>/);
  });
  assert.equal((await getChannelMeta(SLUG))?.allowBash, false, "the denied change must not persist");
  assert.equal(approvalRequests.length, 1);
  const req = approvalRequests[0];
  assert.equal(req.secret, "ctrl-test-secret");
  assert.equal(req.body.approvalType, "agent"); // never auto-approved — auto mode can't bypass
  assert.equal(req.body.toolName, "set_channel_bash");
  assert.match(req.body.toolInput.details, /shell access/i);
  // The gate's own authz tier rides the request so the CLICKER must independently hold it —
  // set_channel_bash is a "manage" tool, so a manager (or admin) click is required to approve.
  assert.equal(req.body.requiredTier, "manage");
});

test("an approved click lets the control-plane change through", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: true, reason: "Approved by <@U_CTRL_ADMIN>" };
  await withGateway({}, async (client) => {
    const result = await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } });
    assert.match(resultText(result), /Bash \+ file edits ON/i);
  });
  assert.equal((await getChannelMeta(SLUG))?.allowBash, true);
  assert.equal(approvalRequests.length, 1);
  // restore
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), allowBash: false });
});

test("token tools are gated and the approval card never carries the token value", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "denied" };
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const result = await client.callTool({ name: "set_my_composio_token", arguments: { token: "sk-super-secret-value" } });
    assert.match(resultText(result), /not approved/i);
  });
  assert.equal(approvalRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(approvalRequests[0].body), /sk-super-secret-value/);
});

test("an unreachable approval endpoint fails closed", async () => {
  approvalRequests.length = 0;
  await withGateway({ port: 1 }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /not approved/i);
  });
  assert.equal((await getChannelMeta(SLUG))?.adminMode, false);
});

test("update_gateway skips the extra card in Admin/Auto mode but stays admin-only", async () => {
  const reserved = reserveUpdate({ root: scratch, source: "approval-policy-test" });
  assert.equal(reserved.ok, true);
  try {
    approvalResponse = { allow: false, reason: "should be requested only in read mode" };

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({ engine: "claude" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /not approved/i);
    });
    assert.equal(approvalRequests.length, 1, "read mode keeps the explicit approval gate");

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: true, autoMode: false });
    approvalRequests.length = 0;
    await withGateway({ engine: "claude" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /already active/i);
    });
    assert.equal(approvalRequests.length, 0, "Admin mode starts without the extra card");

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, autoMode: true });
    approvalRequests.length = 0;
    await withGateway({ engine: "codex" }, async (client) => {
      const result = await client.callTool({ name: "update_gateway", arguments: {} });
      assert.match(resultText(result), /already active/i);
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

test("restart_gateway requires approval in Auto mode and skips it only in Admin mode", async () => {
  const original = await getChannelMeta(SLUG);
  restartResponse = { ok: true, id: "restart-test", waitMs: 300_000, pollMs: 30_000 };
  try {
    approvalResponse = { allow: true, reason: "approved in test" };
    await saveChannelMeta(SLUG, { ...original, adminMode: false, autoMode: true });
    approvalRequests.length = 0;
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "restart_gateway", arguments: {} });
      assert.match(resultText(result), /Safe restart queued/i);
    });
    assert.deepEqual(approvalRequests.map((request) => request.url), ["/internal/approval", "/internal/restart"]);

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
      assert.match(resultText(result), new RegExp(DEFAULT_WORKDIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(resultText(result), new RegExp(ISOLATED_HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    await saveChannelMeta(SLUG, { ...original, workDir: CUSTOM_WORKDIR });
    await withGateway({}, async (client) => {
      const result = await client.callTool({ name: "update_channel_memory", arguments: { action: "add", text: "- custom-workdir fact" } });
      assert.match(resultText(result), /Memory updated/i);
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

test("every registered gateway tool is consciously classified as gated or open (drift tripwire)", async () => {
  // A NEW state-changing tool that nobody adds to CONTROL_PLANE ships approval-free by
  // omission. This inventory forces the classification to be a reviewed decision: an
  // unclassified tool fails here until it is added to exactly one of these lists.
  const GATED = new Set([
    "set_channel_admin_mode", "set_channel_network", "set_channel_bash", "set_channel_auto_mode",
    "set_channel_runtime", // where the channel's engine RUNS (host vs its own container)
    "set_channel_workdir", "clear_channel_workdir", "set_channel_drive_folder", "clear_channel_drive_folder",
    "add_channel_mcps", "remove_channel_mcps", "update_channel_instructions",
    "update_gateway", "restart_gateway", "update_gateway_guide", "reset_gateway_guide",
    "set_my_composio_token", "clear_my_composio_token", "set_my_skills_token", "clear_my_skills_token",
    "set_my_toolbox_token", "clear_my_toolbox_token",
    "set_license_key", "clear_license_key", // gateway-wide licensing state (src/ee/)
  ]);
  const OPEN = new Set([
    // read-only
    "list_available_mcps", "list_channel_mcps", "list_schedules", "list_folders",
    "get_channel_workdir", "get_channel_drive_folder", "get_gateway_guide",
    "workspace_list", "workspace_read", "workspace_search",
    "get_license_status", // read-only; exposes the tier/limits and the key's last 4, never the key
    // writes that land visibly in the current thread, or run inside normal confinement
    "slack_post_chart", "slack_post_table", "slack_upload_snippet",
    "slack_list_create", "slack_list_add_item", "slack_list_update_item", "slack_list_info", "slack_list_items",
    "slack_channel_history", "slack_thread_replies",
    "run_in_background", "run_agent_in_background", // shell kind has its own admin-click gate in background.js
    "request_approval", "permission_prompt", "report_progress",
    "request_network_domain", // carries its own any-authorized-user approval gate
    "update_channel_memory", // operator decision 2026-08-07: memory is agent-owned, never approval-gated
    // operator decision 2026-08-19: reminders/scheduled tasks are an ordinary channel request and
    // are never approval-gated. A schedule fires with origin "schedule" (cannot escalate — A2), in
    // this channel, as its creator, and stays inspectable/reversible via list_/delete_schedule.
    "create_schedule", "delete_schedule",
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

// ── set_channel_runtime (v0.8) ────────────────────────────────────────────────────────────────
// Where a channel's engine processes RUN is an isolation decision, so it is admin-tier and gated
// like the mode switches — and the reply must state the runtime the NEXT turn actually gets, not
// the one that was asked for, because two things outrank the pin.
test("set_channel_runtime pins the channel and names the runtime the next turn will really use", async () => {
  approvalResponse = { allow: true, reason: "Approved by <@U_CTRL_ADMIN>" };
  await saveSettings({ containerRuntimeEnabled: true, containerDefaultBackend: "host" });
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false, runtime: "" });

  await withGateway({}, async (client) => {
    const pinned = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "container" } });
    assert.match(resultText(pinned), /Next turn runs on: `container`/);
  });
  assert.equal((await getChannelMeta(SLUG))?.runtime, "container");

  // The gateway-wide kill switch outranks the pin — the tool says so instead of quietly lying.
  await saveSettings({ containerRuntimeEnabled: false });
  await withGateway({}, async (client) => {
    const killed = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "container" } });
    assert.match(resultText(killed), /Next turn runs on: `host`/);
    assert.match(resultText(killed), /container runtime is switched OFF/);
  });
  assert.equal((await getChannelMeta(SLUG))?.runtime, "container", "the pin survives the kill switch");

  // Admin mode does too: an admin channel is deliberately unconfined on the host.
  await saveSettings({ containerRuntimeEnabled: true });
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: true });
  await withGateway({}, async (client) => {
    const adminPinned = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "container" } });
    assert.match(resultText(adminPinned), /ADMIN MODE/);
    assert.match(resultText(adminPinned), /Next turn runs on: `host`/);
  });
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), adminMode: false });

  // Clearing it returns the channel to the gateway default.
  await withGateway({}, async (client) => {
    const cleared = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "" } });
    assert.match(resultText(cleared), /the gateway default/);
  });
  assert.equal((await getChannelMeta(SLUG))?.runtime, "");
  await saveSettings({ containerRuntimeEnabled: false });
});

test("set_channel_runtime is admin-only and needs the human click like every other isolation change", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: true, reason: "Approved" };
  await saveSettings({ containerRuntimeEnabled: true });
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), runtime: "" });

  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const refused = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "container" } });
    assert.match(resultText(refused), /Only admins/i);
  });
  assert.equal(approvalRequests.length, 0, "an unauthorized caller must not spam an approval card");
  assert.equal((await getChannelMeta(SLUG))?.runtime, "");

  approvalResponse = { allow: false, reason: "Denied by <@U_CTRL_ADMIN>" };
  await withGateway({}, async (client) => {
    const denied = await client.callTool({ name: "set_channel_runtime", arguments: { runtime: "container" } });
    assert.match(resultText(denied), /not approved/i);
  });
  assert.equal((await getChannelMeta(SLUG))?.runtime, "", "a denied change must not persist");
  assert.equal(approvalRequests.at(-1).body.requiredTier, "admin");
  assert.match(approvalRequests.at(-1).body.toolInput.details, /CONTAINER/);
  await saveSettings({ containerRuntimeEnabled: false });
});
