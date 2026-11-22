// Google Chat conversation history: the Chat API list call, the connector's scoped read and the
// conversation_history MCP tool (hard-scoped to the run's own conversation).
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { createChatApi } = await import("../src/platforms/googlechat/api.js");
const { createGoogleChatConnector, HISTORY_SCOPE_REMEDY } = await import("../src/platforms/googlechat/connector.js");
const { googleChatAdapter } = await import("../src/platforms/googlechat.js");
const { registerTransport, resetTransports } = await import("../src/platforms/live.js");
const { register, currentThreadFor } = await import("../src/mcp/tools/conversation-history.js");

const fakeAuth = () => ({ token: async () => "tok", reset() {} });
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const msg = (n, extra = {}) => ({ name: `spaces/AAA/messages/m${n}`, createTime: `2026-11-22T10:0${n}:00Z`,
  sender: { name: `users/${n}`, type: "HUMAN" }, text: `message ${n}`, thread: { name: "spaces/AAA/threads/T1" }, ...extra });

test("listMessages reads newest first under the cap, pages, filters one thread and returns oldest first", async () => {
  const calls = [];
  const pages = [{ messages: [msg(4), msg(3)], nextPageToken: "p2" }, { messages: [msg(2), msg(1)], nextPageToken: "p3" }];
  const api = createChatApi({ auth: fakeAuth(), fetchImpl: async (url) => { calls.push(new URL(url)); return ok(pages[calls.length - 1] || {}); } });
  const rows = await api.listMessages("spaces/AAA", { threadName: "spaces/AAA/threads/T1", limit: 3, pageSize: 2 });
  assert.deepEqual(rows.map((m) => m.name), ["spaces/AAA/messages/m2", "spaces/AAA/messages/m3", "spaces/AAA/messages/m4"]);
  assert.equal(calls.length, 2, "stops paging once the limit is reached");
  assert.equal(calls[0].pathname, "/v1/spaces/AAA/messages");
  assert.equal(calls[0].searchParams.get("orderBy"), "createTime desc");
  assert.equal(calls[0].searchParams.get("filter"), "thread.name = spaces/AAA/threads/T1");
  assert.equal(calls[1].searchParams.get("pageToken"), "p2");
  assert.equal(calls[1].searchParams.get("pageSize"), "1", "never asks for more than the remaining cap");
  await assert.rejects(api.listMessages("spaces/AAA", { threadName: "spaces/EVIL/threads/T" }), /another space/);
  await assert.rejects(api.listMessages("spaces/AAA", { threadName: "spaces/AAA/threads/T\" OR x" }), /not a valid resource name/);
  await assert.rejects(api.listMessages("../x"), /not a valid resource name/);
});

function connectorWith(historyApi) {
  return createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, historyApi,
    api: { async listMembers() { return [{ id: "users/1", name: "Ana Pop" }]; } } });
}

test("the connector names authors, labels apps, lists files and stays inside its own space", async () => {
  const seen = [];
  const connector = connectorWith(() => ({ async listMessages(space, opts) { seen.push({ space, ...opts }); return [
    msg(1, { sender: { name: "users/1", type: "HUMAN" }, attachment: [{ contentName: "plan.pdf", contentType: "application/pdf" }] }),
    msg(2, { sender: { name: "users/99", type: "BOT", displayName: "ChannelGate" } }),
  ]; } }));
  const rows = await connector.readHistory({ conversationId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T1", limit: 10 });
  assert.deepEqual(seen, [{ space: "spaces/AAA", threadName: "spaces/AAA/threads/T1", limit: 10 }]);
  assert.equal(rows[0].sender, "Ana Pop");
  assert.deepEqual(rows[0].attachments, [{ name: "plan.pdf", type: "application/pdf" }]);
  assert.equal(rows[1].sender, "ChannelGate [app]");
  await assert.rejects(connector.readHistory({ conversationId: "gchat:spaces/AAA", threadKey: "spaces/BBB/threads/T" }), /another space/);
  await assert.rejects(connector.readHistory({ conversationId: "gchat:spaces/AAA", threadKey: "1700000000.0001" }), /not a Google Chat thread/);
});

test("an unapproved app scope answers with the remedy, never a raw token error", async () => {
  const refused = Object.assign(new Error("Google token exchange failed (401): unauthorized_client"), { status: 401 });
  const connector = connectorWith(() => ({ async listMessages() { throw refused; } }));
  await assert.rejects(connector.readHistory({ conversationId: "gchat:spaces/AAA" }), (e) => e.message === HISTORY_SCOPE_REMEDY);
  await assert.rejects(connectorWith(null).readHistory({ conversationId: "gchat:spaces/AAA" }), (e) => e.message === HISTORY_SCOPE_REMEDY);
  const transient = Object.assign(new Error("boom"), { status: 503 });
  await assert.rejects(connectorWith(() => ({ async listMessages() { throw transient; } })).readHistory({ conversationId: "gchat:spaces/AAA" }), /boom/);
});

function toolFor(ctx, connector) {
  resetTransports();
  if (connector) registerTransport("googlechat", { getConnector: () => connector });
  const tools = new Map();
  register({ registerTool: (name, _schema, handler) => tools.set(name, handler) }, {
    text: (t) => ({ content: [{ type: "text", text: t }] }), requireChannelAccess: async () => true, ...ctx,
  });
  return tools.get("conversation_history");
}
const out = (res) => res.content[0].text;

test("conversation_history reads only the run's own conversation and resolves the current thread", async () => {
  const reads = [];
  const connector = { threadFor: (k) => (/^spaces\/[^/]+\/threads\/[^/]+$/.test(k) ? k : null), ready: () => true,
    async readHistory(args) { reads.push(args); return [{ createTime: "2026-11-22T10:01:00Z", sender: "Ana Pop", text: "hello", thread: "spaces/AAA/threads/T1", attachments: [] }]; } };
  const tool = toolFor({ channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T1::agent-7" }, connector);
  assert.ok(tool, "registered on a connected Google Chat conversation");

  assert.match(out(await tool({ thread: "current" })), /\[2026-11-22 10:01\] Ana Pop: hello$/);
  assert.deepEqual(reads.at(-1), { conversationId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T1", limit: 30 });
  assert.match(out(await tool({ limit: 5 })), /\(thread spaces\/AAA\/threads\/T1\)/, "the whole conversation names each thread");
  assert.deepEqual(reads.at(-1), { conversationId: "gchat:spaces/AAA", threadKey: "", limit: 5 });

  const flat = toolFor({ channelId: "gchat:spaces/AAA", threadKey: "sched-4-1700000000" }, connector);
  assert.match(out(await flat({ thread: "current" })), /not in a thread/);
});

test("conversation_history is absent on Slack and on a disconnected or history-less surface, and re-checks access", async () => {
  const connector = { threadFor: () => null, async readHistory() { return []; } };
  assert.equal(toolFor({ channelId: "C123" }, connector), undefined, "Slack keeps its own read tools");
  assert.equal(toolFor({ channelId: "gchat:spaces/AAA" }, null), undefined);
  assert.equal(toolFor({ channelId: "gchat:spaces/AAA" }, { threadFor: () => null }), undefined);
  const tool = toolFor({ channelId: "gchat:spaces/AAA", requireChannelAccess: async () => false }, connector);
  assert.match(out(await tool({})), /no longer allowed/);
  const failing = toolFor({ channelId: "gchat:spaces/AAA" }, { threadFor: () => null, async readHistory() { throw new Error(HISTORY_SCOPE_REMEDY); } });
  assert.match(out(await failing({})), /administrator approval/);
  resetTransports();
});
