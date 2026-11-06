import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc, createHttpDaemonIpc, AGENT_MESSAGE_TOOLSET } = await import("../src/mcp/gateway-server.js");
const { agentPrincipal, isAgentPrincipal, agentPrincipalSlug, isApiPrincipal } = await import("../src/config/api-principal.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { createWebApp } = await import("../src/web/app.js");

const actor = "U_MAIL_ACTOR";
const channel = "C_MAIL_TOOLS";
const thread = "1700000000.000500";
let slug;
const bodyText = (result) => result.content.map((entry) => entry.text || "").join("\n");

test.before(async () => {
  await setUser(actor, { approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(channel, { name: "mail-tools", type: "channel", isDM: false });
  slug = entry.slug;
  await saveChannelMeta(slug, { channelId: channel, type: "channel", isDM: false, agentDirectory: { description: "Marketing" } });
});

async function withClient(engine, run, { claims = {}, handlers = {} } = {}) {
  const ctx = ctxFromClaims({ channelId: channel, slug, authorId: actor, threadKey: thread, engine, origin: "slack_foreground", principalTrusted: true, toolset: "full", ...claims }, {
    daemon: createDirectDaemonIpc(handlers),
  });
  const server = createGatewayMcpServer(ctx);
  const client = new Client({ name: `mail-${engine}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client, ctx, server); }
  finally { await client.close(); await server.close(); }
}

test("agent principal helpers", () => {
  assert.equal(agentPrincipal("marketing"), "agent:marketing");
  assert.ok(isAgentPrincipal("agent:marketing"));
  assert.ok(!isAgentPrincipal("agent:"));
  assert.ok(!isAgentPrincipal("api"));
  assert.ok(!isAgentPrincipal("U123"));
  assert.ok(!isApiPrincipal("agent:marketing"));
  assert.equal(agentPrincipalSlug("agent:sales-emea"), "sales-emea");
  assert.equal(agentPrincipalSlug("U123"), "");
  assert.throws(() => agentPrincipal(""));
});

for (const engine of ["claude", "codex"]) {
  test(`${engine}: send_agent_message is saved behind the requester's card and binds identity to the verified context`, async () => {
    const sends = [];
    const approvals = [];
    await withClient(engine, async (client, _ctx, server) => {
      const tools = (await client.listTools()).tools;
      assert.ok(tools.some((tool) => tool.name === "send_agent_message"));
      const result = bodyText(await client.callTool({ name: "send_agent_message", arguments: { to: "C_SALES", message: "What is the Q4 pipeline?", createdBy: "U_FORGED", channelId: "C_FORGED", threadKey: "9.9" } }));
      // Durable: the exact call is saved on the card; nothing is sent until the requester clicks.
      assert.match(result, /awaiting approval \(request mail-card\)/);
      assert.equal(sends.length, 0);
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].toolName, "send_agent_message");
      assert.equal(approvals[0].approvalType, "agent");
      assert.equal(approvals[0].requiredTier, "owner");
      assert.equal(approvals[0].durableAction.kind, "control_plane");
      assert.equal(approvals[0].durableAction.tool, "send_agent_message");
      assert.equal(approvals[0].durableAction.authorId, actor);
      assert.match(approvals[0].toolInput.details, /Send a message to the agent in C_SALES on your behalf/);
      assert.match(approvals[0].toolInput.details, /What is the Q4 pipeline\?/);
      // The click: the daemon replays the saved call through the same handler, as the requester.
      const applied = await server.invokeApproved("send_agent_message", approvals[0].durableAction.args);
      assert.equal(applied.ok, true);
      assert.match(applied.text, /Asked the #sales agent/);
      assert.match(applied.text, /replies land in this thread/);
      assert.equal(sends.length, 1);
      assert.equal(sends[0].createdBy, actor);
      assert.equal(sends[0].channelId, channel);
      assert.equal(sends[0].threadKey, thread);
      assert.equal(sends[0].slug, slug);
      assert.equal(sends[0].to, "C_SALES");
      assert.equal(sends[0].message, "What is the Q4 pipeline?");
    }, { handlers: {
      approval: (body) => { approvals.push(body); return { allow: false, pending: true, approvalId: "mail-card" }; },
      "agent-mail": (body) => { sends.push(body); return { ok: true, id: "m1", to: { channelId: "C_SALES", name: "sales", slug: "sales" } }; },
    } });
  });
}

test("a daemon refusal and an unavailable transport are relayed without sending", async () => {
  await withClient("claude", async (_client, _ctx, server) => {
    const refused = await server.invokeApproved("send_agent_message", { to: "C_SALES", message: "hi" });
    assert.match(refused.text, /🚫 Agent message not sent: You must be a current member of #sales/);
  }, { handlers: { "agent-mail": () => ({ ok: false, code: "membership", error: "You must be a current member of #sales for your agent to message it on your behalf." }) } });
  await withClient("claude", async (_client, _ctx, server) => {
    assert.match((await server.invokeApproved("send_agent_message", { to: "C_SALES", message: "hi" })).text, /unavailable/);
  });
});

test("only a verified human member may send: API runs and delivered agent turns are refused", async () => {
  const sends = [];
  const handlers = { approval: () => ({ allow: true }), "agent-mail": (body) => { sends.push(body); return { ok: true, id: "x" }; } };
  for (const claims of [{ principalTrusted: false }, { authorId: "api" }, { authorId: "agent:sales", principalTrusted: false, origin: "agent_message" }]) {
    await withClient("claude", async (client, _ctx, server) => {
      // Both the live call (behind the gate) and a replayed saved call refuse at the handler.
      const live = bodyText(await client.callTool({ name: "send_agent_message", arguments: { to: "C_SALES", message: "hi" } }));
      assert.doesNotMatch(live, /Sent to the agent/);
      assert.match((await server.invokeApproved("send_agent_message", { to: "C_SALES", message: "hi" })).text, /authenticated conversation member/);
    }, { claims, handlers });
  }
  assert.equal(sends.length, 0);
});

test("a delivered agent message's context has no rank and is scoped to its registered channel", async () => {
  const ctx = ctxFromClaims({ channelId: channel, slug, authorId: agentPrincipal("sales"), threadKey: thread, engine: "claude", origin: "agent_message", principalTrusted: false, toolset: AGENT_MESSAGE_TOOLSET }, { daemon: createDirectDaemonIpc({}) });
  assert.equal(ctx.createdBy, "agent:sales");
  assert.equal(ctx.principalTrusted, false);
  assert.equal(ctx.apiPrincipal, false);
  assert.equal(ctx.agentPrincipal, true);
  assert.equal(ctx.toolset, AGENT_MESSAGE_TOOLSET);
  assert.equal(await ctx.requireAdmin(), false);
  assert.equal(await ctx.requireManage(), false);
  assert.equal(await ctx.requireChannelAccess(), true);
  const unregistered = ctxFromClaims({ channelId: "C_NOPE", slug: "nope-slug", authorId: agentPrincipal("sales"), threadKey: thread, engine: "claude", origin: "agent_message", principalTrusted: false, toolset: AGENT_MESSAGE_TOOLSET }, { daemon: createDirectDaemonIpc({}) });
  assert.equal(await unregistered.requireChannelAccess(), false);
  // An untrusted claim naming a real-looking person still maps to the API principal, as before.
  const api = ctxFromClaims({ channelId: channel, slug, authorId: "U_SOMEONE", principalTrusted: false }, { daemon: createDirectDaemonIpc({}) });
  assert.equal(api.createdBy, "api");
  assert.equal(api.apiPrincipal, true);
  assert.equal(api.agentPrincipal, false);
});

test("the agent-message toolset keeps the channel's knowledge and approvals but nothing that reaches beyond the thread", async () => {
  await withClient("claude", async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const kept of ["workspace_read", "workspace_search", "search_channel_memory", "read_channel_memory", "update_channel_memory", "permission_prompt", "slack_post_table", "slack_channel_history"]) {
      assert.ok(names.includes(kept), `${kept} available to a delivered agent message`);
    }
    for (const gone of ["send_agent_message", "search_agents", "set_channel_agent_profile", "run_in_background", "run_agent_in_background", "create_schedule", "request_approval", "set_channel_admin_mode", "set_channel_network", "update_channel_instructions", "set_my_composio_token", "ask_questions", "open_code_channel", "update_gateway", "report_progress"]) {
      assert.ok(!names.includes(gone), `${gone} withheld from a delivered agent message`);
    }
  }, { claims: { authorId: agentPrincipal("sales"), principalTrusted: false, origin: "agent_message", toolset: AGENT_MESSAGE_TOOLSET } });
  // The reduced memory-review toolset is untouched by the new tool.
  await withClient("claude", async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("send_agent_message"));
    assert.ok(!names.includes("permission_prompt"));
  }, { claims: { toolset: "memory-review" } });
});

test("host HTTP agent-mail IPC requires the loopback secret and answers 503 when the daemon service is absent", async () => {
  const previous = process.env.CG_APPROVAL_SECRET;
  process.env.CG_APPROVAL_SECRET = "agent-mail-ipc-test";
  const calls = [];
  const app = createWebApp({ sendAgentMail: async (body) => { calls.push(body); return { ok: true, id: "m9", to: { channelId: "C_SALES", name: "sales", slug: "sales" } }; } });
  const bare = createWebApp({});
  const server = http.createServer(app);
  const bareServer = http.createServer(bare);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const forbidden = await fetch(`http://127.0.0.1:${port}/internal/agent-mail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(forbidden.status, 403);
    const ipc = createHttpDaemonIpc({ secret: () => "agent-mail-ipc-test", port: () => port });
    const sent = await ipc.call("agent-mail", { channelId: channel, slug, createdBy: actor, threadKey: thread, origin: "slack_foreground", to: "C_SALES", message: "hi", forged: true });
    assert.equal(sent.ok, true);
    assert.equal(sent.id, "m9");
    assert.deepEqual(calls, [{ channelId: channel, slug, createdBy: actor, threadKey: thread, origin: "slack_foreground", to: "C_SALES", message: "hi" }]);
    const picked = await ipc.call("agent-mail", { action: "continue", channelId: channel, slug, createdBy: actor, threadKey: thread, message: "more" });
    assert.equal(picked.ok, true);
    assert.deepEqual(calls[1], { action: "continue", channelId: channel, slug, createdBy: actor, threadKey: thread, message: "more" });
    const absent = createHttpDaemonIpc({ secret: () => "agent-mail-ipc-test", port: () => bareServer.address().port });
    assert.match((await absent.call("agent-mail", {})).error, /unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => bareServer.close(resolve));
    if (previous === undefined) delete process.env.CG_APPROVAL_SECRET;
    else process.env.CG_APPROVAL_SECRET = previous;
  }
});

test("continue_agent_conversation is open (no card), identity-bound, and refused for API and agent principals", async () => {
  const calls = [];
  const handlers = { "agent-mail": (body) => { calls.push(body); return body.message ? { ok: true, mode: "sent", to: "#sales" } : { ok: true, mode: "flag", to: "#sales" }; } };
  await withClient("claude", async (client) => {
    const flag = bodyText(await client.callTool({ name: "continue_agent_conversation", arguments: { createdBy: "U_FORGED", threadKey: "9.9" } }));
    assert.match(flag, /delivered to the #sales agent when this turn ends/);
    const sent = bodyText(await client.callTool({ name: "continue_agent_conversation", arguments: { message: "ten slides" } }));
    assert.match(sent, /Delivered to the #sales agent/);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { action: "continue", channelId: channel, slug, createdBy: actor, threadKey: thread, message: "" });
    assert.equal(calls[1].message, "ten slides");
  }, { handlers });
  for (const claims of [{ authorId: "api" }, { authorId: "agent:sales", principalTrusted: false, origin: "agent_message" }]) {
    await withClient("claude", async (client) => {
      assert.match(bodyText(await client.callTool({ name: "continue_agent_conversation", arguments: {} })), /authenticated person/);
    }, { claims, handlers });
  }
  assert.equal(calls.length, 2);
  await withClient("claude", async (client) => {
    assert.match(bodyText(await client.callTool({ name: "continue_agent_conversation", arguments: {} })), /🚫 no conversation/);
  }, { handlers: { "agent-mail": () => ({ ok: false, error: "no conversation" }) } });
});
