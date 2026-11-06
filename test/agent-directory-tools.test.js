import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc, createHttpDaemonIpc } = await import("../src/mcp/gateway-server.js");
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { readEvents } = await import("../src/util/logger.js");
const { createWebApp } = await import("../src/web/app.js");
const actor = "U_DIRECTORY_ACTOR";
const channel = "C_DIRECTORY_TOOLS";
let slug;
const bodyText = (result) => result.content.map((entry) => entry.text || "").join("\n");

test.before(async () => {
  await setUser(actor, { approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(channel, { name: "directory-tools", type: "channel", isDM: false });
  slug = entry.slug;
  await saveChannelMeta(slug, { channelId: channel, type: "channel", isDM: false, manageAccess: "members", agentDirectory: { description: "Original", examples: ["Original task"], hidden: false }, skills: ["unchanged"] });
});

async function withClient(engine, run, { claims = {}, overrides = {}, handlers = {} } = {}) {
  const ctx = ctxFromClaims({ channelId: channel, slug, authorId: actor, engine, origin: "slack_foreground", principalTrusted: true, toolset: "full", ...claims }, {
    daemon: createDirectDaemonIpc(handlers),
  });
  Object.assign(ctx, overrides);
  const server = createGatewayMcpServer(ctx);
  const client = new Client({ name: `directory-${engine}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client); }
  finally { await client.close(); await server.close(); }
}

for (const engine of ["claude", "codex"]) {
  test(`${engine} directory tools bind requester and source to verified context`, async () => {
    const calls = [];
    await withClient(engine, async (client) => {
      const tools = (await client.listTools()).tools;
      assert.ok(tools.some((tool) => tool.name === "search_agents"));
      assert.ok(tools.some((tool) => tool.name === "set_channel_agent_profile"));
      const result = await client.callTool({ name: "search_agents", arguments: { query: "presentation", offset: 20, limit: 10, createdBy: "U_FORGED", channelId: "C_FORGED" } });
      assert.deepEqual(JSON.parse(bodyText(result)), { agents: [], returned: 0, hasMore: false, nextOffset: null });
      assert.deepEqual(calls, [{ query: "presentation", offset: 20, limit: 10, createdBy: actor, channelId: channel }]);
    }, { handlers: { "agent-directory": (body) => { calls.push(body); return { agents: [], returned: 0, hasMore: false, nextOffset: null }; } } });
  });
}

test("profile edits are current-channel-only, preserve omitted fields and audit keys without content", async () => {
  await withClient("codex", async (client) => {
    const result = bodyText(await client.callTool({ name: "set_channel_agent_profile", arguments: { description: "Presentation specialist", slug: "other-channel" } }));
    assert.match(result, /profile saved/i);
    const meta = await getChannelMeta(slug);
    assert.deepEqual(meta.agentDirectory, { description: "Presentation specialist", examples: ["Original task"], hidden: false });
    assert.deepEqual(meta.skills, ["unchanged"]);
    const audit = readEvents().find((entry) => entry.event === "agent_directory_profile_changed");
    assert.equal(audit.channel, channel);
    assert.equal(audit.author, actor);
    assert.deepEqual(audit.keys, ["description"]);
    assert.doesNotMatch(JSON.stringify(audit), /Presentation specialist/);
    await client.callTool({ name: "set_channel_agent_profile", arguments: { description: "", examples: [], hidden: true } });
    assert.deepEqual((await getChannelMeta(slug)).agentDirectory, { description: "", examples: [], hidden: true });
  });
});

test("untrusted/API principals, revoked callers and non-managers cannot spend another identity", async () => {
  for (const overrides of [{ principalTrusted: false }, { apiPrincipal: true }, { requireChannelAccess: async () => false }]) {
    await withClient("codex", async (client) => {
      assert.match(bodyText(await client.callTool({ name: "search_agents", arguments: {} })), /authenticated conversation member/);
      assert.match(bodyText(await client.callTool({ name: "set_channel_agent_profile", arguments: { hidden: false } })), /authenticated managers/);
    }, { overrides, handlers: { "agent-directory": () => assert.fail("unauthorized daemon call") } });
  }
  await withClient("claude", async (client) => {
    assert.match(bodyText(await client.callTool({ name: "set_channel_agent_profile", arguments: { hidden: false } })), /Only this channel's managers/);
  }, { overrides: { requireManage: async () => false } });
});

test("unavailable transport and connector errors return no raw metadata or provider error", async () => {
  await withClient("claude", async (client) => {
    assert.match(bodyText(await client.callTool({ name: "search_agents", arguments: {} })), /unavailable/);
  });
  await withClient("codex", async (client) => {
    const result = bodyText(await client.callTool({ name: "search_agents", arguments: {} }));
    assert.match(result, /unavailable/);
    assert.doesNotMatch(result, /private-provider-token/);
  }, { handlers: { "agent-directory": () => { throw new Error("private-provider-token"); } } });
});

test("reduced memory-review toolset never exposes discovery or profile mutation", async () => {
  await withClient("claude", async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("search_agents"));
    assert.ok(!names.includes("set_channel_agent_profile"));
  }, { claims: { toolset: "memory-review" } });
});

test("host HTTP directory IPC requires loopback secret and shares the daemon service", async () => {
  const previous = process.env.CG_APPROVAL_SECRET;
  process.env.CG_APPROVAL_SECRET = "agent-directory-ipc-test";
  const app = createWebApp({});
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/agent-directory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
    const ipc = createHttpDaemonIpc({ secret: () => "agent-directory-ipc-test", port: () => port });
    assert.deepEqual(await ipc.call("agent-directory", { createdBy: actor, channelId: channel, query: "presentation" }), { agents: [], returned: 0, hasMore: false, nextOffset: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.CG_APPROVAL_SECRET;
    else process.env.CG_APPROVAL_SECRET = previous;
  }
});
