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

test("instruction replacement requires an admin requester and admin approver; oversized rules never post", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, pending: true, approvalId: "replacement" };
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const denied = await client.callTool({ name: "update_channel_instructions", arguments: { text: "replacement", mode: "replace" } });
    assert.match(resultText(denied), /Only admins can replace/);
  });
  assert.equal(approvalRequests.length, 0);
  await withGateway({}, async (client) => {
    await client.callTool({ name: "update_channel_instructions", arguments: { text: "replacement", mode: "replace" } });
    assert.equal(approvalRequests[0].body.requiredTier, "admin");
    approvalRequests.length = 0;
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

test("a denied approval blocks the change and carries the human-readable card", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "Denied by <@U_CTRL_ADMIN>" };
  await withGateway({}, async (client) => {
    const result = await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } });
    assert.match(resultText(result), /not approved/i);
    assert.doesNotMatch(resultText(result), approvalReceipt);
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
    assert.match(resultText(result), approvalReceipt);
  });
  assert.equal((await getChannelMeta(SLUG))?.allowBash, true);
  assert.equal(approvalRequests.length, 1);
  // restore
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), allowBash: false });
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

test("token tools are gated and the approval card never carries the token value", async () => {
  approvalRequests.length = 0;
  approvalResponse = { allow: false, reason: "denied" };
  await withGateway({ author: "U_CTRL_MEMBER" }, async (client) => {
    const result = await client.callTool({ name: "set_my_composio_token", arguments: { token: "sk-super-secret-value" } });
    assert.match(resultText(result), /not approved/i);
    assert.doesNotMatch(resultText(result), approvalReceipt);
  });
  assert.equal(approvalRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(approvalRequests[0].body), /sk-super-secret-value/);
});

test("an unreachable approval endpoint fails closed", async () => {
  approvalRequests.length = 0;
  await withGateway({ port: 1 }, async (client) => {
    const result = await client.callTool({ name: "set_channel_admin_mode", arguments: { enabled: true } });
    assert.match(resultText(result), /not approved/i);
    assert.doesNotMatch(resultText(result), approvalReceipt);
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
      assert.doesNotMatch(resultText(result), approvalReceipt);
    });
    assert.equal(approvalRequests.length, 1, "read mode keeps the explicit approval gate");

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

test("every registered gateway tool is consciously classified as gated or open (drift tripwire)", async () => {
  // A NEW state-changing tool that nobody adds to CONTROL_PLANE ships approval-free by
  // omission. This inventory forces the classification to be a reviewed decision: an
  // unclassified tool fails here until it is added to exactly one of these lists.
  const GATED = new Set([
    "set_channel_admin_mode", "set_channel_network", "set_channel_bash", "set_channel_auto_mode",
    "set_channel_workdir", "clear_channel_workdir", "set_channel_drive_folder", "clear_channel_drive_folder",
    "add_channel_mcps", "remove_channel_mcps", "update_channel_instructions",
    "update_gateway", "restart_gateway", "update_gateway_guide", "reset_gateway_guide",
    "set_my_composio_token", "clear_my_composio_token",
    "set_my_toolbox_token", "clear_my_toolbox_token",
    "set_license_key", "clear_license_key", // gateway-wide licensing state (src/ee/)
    // skills platform: grants, templates, catalog writes and admin decisions are persistent state
    "add_channel_skills", "remove_channel_skills", "set_channel_skill_template",
    "create_skill", "update_skill", "decide_skill_proposal", "sync_skill_sources",
    "delete_skill", "publish_skill", "add_org_skills", "remove_org_skills",
    "add_skill_source", "set_skill_source", "remove_skill_source", "set_skill_excluded", "set_skill_governance", "set_skill_scope",
  ]);
  const OPEN = new Set([
    // read-only
    "list_available_mcps", "list_channel_mcps", "list_schedules", "list_folders",
    "get_channel_workdir", "get_channel_drive_folder", "get_gateway_guide",
    "workspace_list", "workspace_read", "workspace_search",
    "search_channel_memory", "read_channel_memory", // channel-scoped read-only retrieval
    "get_license_status", // read-only; exposes the tier/limits and the key's last 4, never the key
    // writes that land visibly in the current thread, or run inside normal confinement
    "slack_post_chart", "slack_post_table", "slack_upload_snippet",
    "slack_list_create", "slack_list_add_item", "slack_list_update_item", "slack_list_info", "slack_list_items",
    "slack_channel_history", "slack_thread_replies",
    "slack_download_file", // lands only in this thread's uploads/ folder, this channel's files only
    "run_in_background", "run_agent_in_background", // shell kind has its own admin-click gate in background.js
    "request_approval", "permission_prompt", "report_progress",
    "update_channel_memory", // operator decision 2026-08-07: memory is agent-owned, never approval-gated
    // operator decision 2026-08-19: reminders/scheduled tasks are an ordinary channel request and
    // are never approval-gated. A schedule fires with origin "schedule" (cannot escalate — A2), in
    // this channel, as its creator, and stays inspectable/reversible via list_/delete_schedule.
    "create_schedule", "delete_schedule",
    // skills platform reads/previews; a proposal only queues a review for an admin
    "list_skills", "show_channel_skills", "list_skill_templates", "preview_skill_template",
    "get_skill_file", "get_skill_info", "propose_skill_change", "list_skill_proposals", "skill_usage_report",
    "list_skill_sources", // admin read
    // operator decision 2026-09-05: a member's OWN skill tier (what only their runs carry) is
    // self-service like starring in a skill library — reversible, affects nobody else, no card.
    "add_my_skills", "remove_my_skills",
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

const creationVariants = [
  { key: "default", args: {}, visibility: "org", channelGrant: true, details: /shared library.*grant it in this channel/i },
  { key: "shared-grant", args: { personal: false, scope: "library", grant_here: true }, visibility: "org", channelGrant: true, details: /shared library.*grant it in this channel/i },
  { key: "shared-ungranted", args: { personal: false, scope: "library", grant_here: false }, visibility: "org", channelGrant: false, details: /shared library.*without.*grant/i },
  { key: "personal-grant", args: { personal: true, scope: "library", grant_here: true }, visibility: "personal", channelGrant: false, details: /personal skill.*your own runs/i },
  { key: "personal-ungranted-flag", args: { personal: true, scope: "library", grant_here: false }, visibility: "personal", channelGrant: false, details: /personal skill.*your own runs/i },
  { key: "channel-grant", args: { personal: false, scope: "channel", grant_here: true }, visibility: "org", channelGrant: false, channelScope: true, details: /this channel.s section.*automatically/i },
  { key: "channel-ungranted-flag", args: { personal: false, scope: "channel", grant_here: false }, visibility: "org", channelGrant: false, channelScope: true, details: /this channel.s section.*automatically/i },
];
const creationFiles = slug => [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Harmless approval preview fixture.\n---\n\nReturn the fixture name.\n` }];

test("both engine approval previews describe actual creation visibility and grants before denial", async () => {
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  for (const engine of ["claude", "codex"]) {
    await withGateway({ engine }, async client => {
      for (const variant of creationVariants) {
        approvalRequests.length = 0;
        approvalResponse = { allow: false, reason: "preview only" };
        const slug = `preview-${engine}-${variant.key}`;
        const args = { slug, files: creationFiles(slug), ...variant.args };
        const result = await client.callTool({ name: "create_skill", arguments: args });
        assert.match(resultText(result), /not approved/);
        assert.equal(approvalRequests.length, 1);
        const preview = approvalRequests[0].body.toolInput.details;
        assert.match(preview, variant.details, variant.key);
        assert.match(preview, new RegExp(slug));
        assert.match(preview, /1 file/);
        if (variant.visibility === "personal") assert.doesNotMatch(preview, /shared catalog|grant it here|grant it in this channel/);
        assert.equal(getSkill(slug), null, "a preview denial creates no skill");
      }
    });
  }
});

test("approved creation matches preview semantics and invalid personal channel scope stays rejected", async () => {
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  const { getUser } = await import("../src/config/store.js");
  for (const engine of ["claude", "codex"]) {
    await withGateway({ engine }, async client => {
      for (const variant of creationVariants) {
        approvalRequests.length = 0;
        approvalResponse = { allow: true };
        const slug = `created-${engine}-${variant.key}`;
        const result = await client.callTool({ name: "create_skill", arguments: { slug, files: creationFiles(slug), ...variant.args } });
        assert.match(resultText(result), /Created/);
        assert.match(approvalRequests[0].body.toolInput.details, variant.details);
        const actual = getSkill(slug);
        assert.equal(actual.visibility, variant.visibility);
        assert.equal(actual.channelScope || "", variant.channelScope ? CHANNEL : "");
        assert.equal((await getUser("U_CTRL_ADMIN")).skills?.includes(slug) || false, variant.visibility === "personal");
        assert.equal((await getChannelMeta(SLUG)).skills?.includes(slug) || false, variant.channelGrant);
        if (variant.visibility === "personal") assert.match(resultText(result), /granted to your own runs/);
        if (variant.channelScope) assert.match(resultText(result), /granted here automatically/);
      }
      const invalid = `invalid-personal-channel-${engine}`;
      approvalRequests.length = 0;
      const result = await client.callTool({ name: "create_skill", arguments: { slug: invalid, files: creationFiles(invalid), personal: true, scope: "channel", grant_here: false } });
      assert.match(approvalRequests[0].body.toolInput.details, /personal.*cannot.*channel/i);
      assert.match(resultText(result), /personal skill cannot be scoped to a channel/);
      assert.equal(getSkill(invalid), null);
    });
  }
});


test("Auto mode skill receipts attest an explicit human decision in both engine contexts", async () => {
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  const original = await getChannelMeta(SLUG);
  await saveChannelMeta(SLUG, { ...original, autoMode: true });
  try {
    for (const engine of ["claude", "codex"]) {
      approvalRequests.length = 0;
      await withGateway({ engine, author: "U_CTRL_MEMBER" }, async client => {
        const slug = `explicit-human-${engine}`;
        const request = { name: "create_skill", arguments: { slug, files: creationFiles(slug), personal: true } };
        approvalResponse = { allow: false, reason: "denied by the human" };
        const denied = await client.callTool(request);
        assert.match(resultText(denied), /not approved/);
        assert.doesNotMatch(resultText(denied), approvalReceipt);
        assert.equal(getSkill(slug), null, "Auto cannot create the denied skill");

        approvalResponse = { allow: true };
        const approved = await client.callTool(request);
        assert.match(resultText(approved), /Created/);
        assert.match(resultText(approved), /This receipt records an explicit human decision; channel Auto mode did not supply it\./);
        assert.deepEqual(approvalRequests.map(r => r.body.approvalType), ["agent", "agent"]);
        assert.equal(getSkill(slug).createdBy, "U_CTRL_MEMBER");
      });
    }
  } finally {
    await saveChannelMeta(SLUG, original);
  }
});

test("both engine contexts receive an approval receipt for actual skill creation, update and deletion", async () => {
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  for (const engine of ["claude", "codex"]) {
    approvalRequests.length = 0;
    approvalResponse = { allow: true, reason: "private decision context must not be repeated", decidedBy: "PRIVATE_ACTOR" };
    await withGateway({ engine, author: "U_CTRL_MEMBER" }, async client => {
      const slug = `approval-receipt-${engine}`;
      for (const [name, args, expected] of [
        ["create_skill", { slug, files: creationFiles(slug), personal: true }, /Created/],
        ["update_skill", { skill: slug, files: [{ path: "references/marker.md", content: "approved update fixture" }] }, /now revision 2/],
        ["delete_skill", { skill: slug }, /Removed/],
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.match(resultText(result), expected);
        assert.match(resultText(result), approvalReceipt);
        assert.match(resultText(result), /does not mean approval was bypassed/);
        assert.doesNotMatch(resultText(result), /private decision context|PRIVATE_ACTOR/);
        assert.notEqual(result.isError, true);
      }
      assert.equal(getSkill(slug).deleted, true);
      assert.deepEqual(approvalRequests.map(r => [r.body.toolName, r.body.approvalType, r.body.requiredTier]), [
        ["create_skill", "agent", ""], ["update_skill", "agent", ""], ["delete_skill", "agent", ""],
      ]);
      const rejected = await client.callTool({ name: "delete_skill", arguments: { skill: slug } });
      assert.match(resultText(rejected), /No catalog skill/);
      assert.match(resultText(rejected), approvalReceipt, "approval is distinct from the handler's refusal");
      assert.equal(rejected.content[0].text, `No catalog skill named "${slug}".`);
      approvalRequests.length = 0;
      const open = await client.callTool({ name: "remove_my_skills", arguments: { slugs: [slug] } });
      assert.doesNotMatch(resultText(open), approvalReceipt);
      assert.equal(approvalRequests.length, 0, "own grant cleanup remains ungated");
    });
  }
});

test("a durable instruction approval never reports a live handler as approved even if IPC returns allow", async () => {
  approvalResponse = { allow: true };
  const file = path.join(DEFAULT_WORKDIR, "CLAUDE.md");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  await withGateway({}, async client => {
    const result = await client.callTool({ name: "update_channel_instructions", arguments: { text: "- Must stay unapplied." } });
    assert.match(resultText(result), /Couldn't save the instruction approval/);
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
  server.registerTool("set_channel_bash", {}, async () => original);
  const client = new Client({ name: "receipt-contract", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "set_channel_bash", arguments: {} });
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
