// The gateway MCP license tools, over the real stdio server.
//
// Two separate gates have to hold, and this file proves both independently:
//   * the HANDLER's own authz — only a gateway admin may set or clear the key;
//   * the CONTROL-PLANE approval gate — even an admin needs a human Approve click, because
//     changing the license key changes persistent, gateway-wide state and an authorized turn is
//     exactly where injected content spends someone's authority (gateway-server.js A3).
// `get_license_status` is read-only and deliberately open to any allowed user.
import path from "node:path";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clearTestLicense, ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
// This file asserts on the STORED key, so the scratch environment's bootstrap key and offline
// payload have to be out of the way — the MCP child is spawned with neither.
clearTestLicense();
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { saveSettings, getLicenseKey } = await import("../src/config/settings.js");

const approvals = [];
let approvalResponse = { allow: true };
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    approvals.push({ url: req.url, body: JSON.parse(body || "{}") });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(approvalResponse));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;
after(() => stub.close());

const SLUG = "mcp-license-test";
const CHANNEL = "C_MCP_LICENSE";
const ISOLATED_HOME = path.join(scratch, "license-engine-home");
mkdirSync(ISOLATED_HOME, { recursive: true });

function gatewayClient({ author = "U_LIC_ADMIN" } = {}) {
  const secret = "license-test-secret";
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
      CG_GATEWAY_CAPABILITY: mintGatewayCapability({ secret, channelId: CHANNEL, slug: SLUG, authorId: author, threadKey: "1.000", origin: "slack_foreground", engine: "claude" }),
      CG_APPROVAL_SECRET: secret,
      CG_PORT: String(stubPort),
      CG_FS_ROOT: scratch,
      CG_WORKSPACE_DIR: path.join(scratch, "license-workspaces"),
      // An unroutable platform: the tool must still answer, from the cached state.
      CHANNELGATE_PLATFORM_URL: "http://127.0.0.1:9/channelgate/api",
      HOME: ISOLATED_HOME,
    },
  });
  const client = new Client({ name: "mcp-license-test", version: "1.0.0" }, { capabilities: {} });
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
  await setUser("U_LIC_ADMIN", { name: "License Admin", approved: true, isAdmin: true });
  await setUser("U_LIC_MEMBER", { name: "License Member", approved: true, isAdmin: false });
  await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
  await saveChannelMeta(SLUG, { channelId: CHANNEL, allowBash: false, adminMode: false });
  saveSettings({ licenseKey: "" });
});

test("all three license tools are registered on a full run", async () => {
  await withGateway({}, async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["get_license_status", "set_license_key", "clear_license_key"]) {
      assert.ok(names.includes(name), `${name} should be registered`);
    }
  });
});

test("get_license_status is readable by a non-admin and never shows the key", async () => {
  saveSettings({ licenseKey: "cg_live_mcp_key_ABCD9876" });
  approvals.length = 0;
  await withGateway({ author: "U_LIC_MEMBER" }, async (client) => {
    const text = resultText(await client.callTool({ name: "get_license_status", arguments: {} }));
    assert.match(text, /ChannelGate license/);
    assert.match(text, /state:/);
    assert.match(text, /…9876/, "the last four identify which key is installed");
    assert.ok(!text.includes("cg_live_mcp_key_ABCD9876"), "the key value is never echoed");
  });
  assert.equal(approvals.length, 0, "a read-only tool must not raise an approval card");
});

test("a non-admin cannot set or clear the key, and gets the refusal rather than an approval card", async () => {
  saveSettings({ licenseKey: "cg_live_mcp_key_ABCD9876" });
  approvals.length = 0;
  await withGateway({ author: "U_LIC_MEMBER" }, async (client) => {
    const set = resultText(await client.callTool({ name: "set_license_key", arguments: { key: "cg_live_stolen_key_0000" } }));
    assert.match(set, /Only admins/i);
    const cleared = resultText(await client.callTool({ name: "clear_license_key", arguments: {} }));
    assert.match(cleared, /Only admins/i);
  });
  assert.equal(getLicenseKey(), "cg_live_mcp_key_ABCD9876", "nothing was changed");
  assert.equal(approvals.length, 0, "no approval spam for a caller who could never pass authz");
});

test("an admin still needs a human Approve click, and a denial changes nothing", async () => {
  saveSettings({ licenseKey: "cg_live_mcp_key_ABCD9876" });
  approvals.length = 0;
  approvalResponse = { allow: false, reason: "not now" };
  await withGateway({ author: "U_LIC_ADMIN" }, async (client) => {
    const text = resultText(await client.callTool({ name: "set_license_key", arguments: { key: "cg_live_new_key_1111" } }));
    assert.match(text, /needs a human Approve click/i);
    assert.match(text, /Nothing was changed/);
  });
  assert.equal(getLicenseKey(), "cg_live_mcp_key_ABCD9876");
  assert.equal(approvals.length, 1, "the admin's call raised exactly one approval card");
  assert.equal(approvals[0].body.toolName, "set_license_key");
  // The card describes the change without ever quoting the key.
  assert.match(approvals[0].body.toolInput.details, /LICENSE KEY \(value hidden\)/);
  assert.ok(!JSON.stringify(approvals[0].body).includes("cg_live_new_key_1111"), "the key must not ride the approval payload");
  assert.equal(approvals[0].body.requiredTier, "admin", "an admin-tier change needs an admin clicker");
});

test("an approved admin call sets the key and reports the verification outcome", async () => {
  saveSettings({ licenseKey: "" });
  approvals.length = 0;
  approvalResponse = { allow: true };
  await withGateway({ author: "U_LIC_ADMIN" }, async (client) => {
    const text = resultText(await client.callTool({ name: "set_license_key", arguments: { key: "cg_live_new_key_2222" } }));
    assert.match(text, /Saved the license key \(…2222\)/);
    // The platform is unroutable here — the tool still answers, with the honest outcome.
    assert.match(text, /verified it: `unreachable`/);
    assert.match(text, /DELETE the message/);
    assert.ok(!text.includes("cg_live_new_key_2222"), "not even the successful reply echoes the key");
  });
  assert.equal(getLicenseKey(), "cg_live_new_key_2222");

  approvals.length = 0;
  await withGateway({ author: "U_LIC_ADMIN" }, async (client) => {
    const text = resultText(await client.callTool({ name: "clear_license_key", arguments: {} }));
    assert.match(text, /Removed the license key/);
  });
  assert.equal(getLicenseKey(), "");
  assert.equal(approvals.length, 1, "clearing is gated too");
});

test("an obviously wrong key is refused before anything is saved", async () => {
  saveSettings({ licenseKey: "" });
  approvalResponse = { allow: true };
  await withGateway({ author: "U_LIC_ADMIN" }, async (client) => {
    const text = resultText(await client.callTool({ name: "set_license_key", arguments: { key: "short" } }));
    assert.match(text, /doesn't look like a ChannelGate license key/);
  });
  assert.equal(getLicenseKey(), "");
});
