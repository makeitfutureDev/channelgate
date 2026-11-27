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

// ── Historical files: conversation_download_file on Google Chat ───────────────────────────────

const fileMessage = (extra = {}) => ({ name: "spaces/AAA/messages/m1", thread: { name: "spaces/AAA/threads/T1" }, text: "the plan",
  attachment: [
    { contentName: "plan.pdf", contentType: "application/pdf", attachmentDataRef: { resourceName: "spaces/AAA/attachments/a1" } },
    { contentName: "notes.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", driveDataRef: { driveFileId: "d1" } },
  ], ...extra });
const status = (code, message = `failed (${code})`) => Object.assign(new Error(message), { status: code });

function fileConnector({ bot = {}, app = null } = {}) {
  const calls = [];
  const wrap = (label, client) => Object.fromEntries(Object.entries(client).map(([key, fn]) => [key, async (...args) => { calls.push([label, key, ...args]); return fn(...args); }]));
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities,
    api: wrap("bot", { async listMembers() { return []; }, ...bot }), historyApi: app ? () => wrap("app", app) : null });
  return { connector, calls };
}

test("historyFile fetches the named message with the bot client and downloads its upload by resource name", async () => {
  const { connector, calls } = fileConnector({ bot: { async getMessage() { return fileMessage(); }, async downloadAttachment() { return Buffer.from("pdf bytes"); } } });
  const found = await connector.historyFile({ conversationId: "gchat:spaces/AAA", message: "spaces/AAA/messages/m1", thread: "spaces/AAA/threads/T1", file: "PLAN.pdf" });
  assert.equal(found.name, "plan.pdf");
  assert.equal(found.contentType, "application/pdf");
  assert.deepEqual(calls, [["bot", "getMessage", "spaces/AAA/messages/m1"]], "nothing downloads before the intake asks");
  assert.equal(String(await found.download()), "pdf bytes");
  assert.deepEqual(calls.at(-1), ["bot", "downloadAttachment", "spaces/AAA/attachments/a1"]);
});

test("historyFile falls back to the app-scope client for a message, and for its bytes, the bot cannot reach", async () => {
  const { connector, calls } = fileConnector({
    bot: { async getMessage() { throw status(404); }, async downloadAttachment() { throw status(403); } },
    app: { async getMessage() { return fileMessage(); }, async downloadAttachment() { return Buffer.from("via app"); } },
  });
  const found = await connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", file: "plan.pdf" });
  assert.equal(String(await found.download()), "via app");
  assert.deepEqual(calls.map(([who, what]) => `${who}.${what}`), ["bot.getMessage", "app.getMessage", "bot.downloadAttachment", "app.downloadAttachment"]);

  const unapproved = fileConnector({ bot: { async getMessage() { throw status(404); } },
    app: { async getMessage() { throw status(401, "Google token exchange failed (401): unauthorized_client"); } } }).connector;
  await assert.rejects(unapproved.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), (e) => e.message === HISTORY_SCOPE_REMEDY);
  const gone = fileConnector({ bot: { async getMessage() { throw status(404); } } }).connector;
  await assert.rejects(gone.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), /not in this Google Chat conversation, or the app cannot read it/);
  const broken = fileConnector({ bot: { async getMessage() { throw status(500, "boom"); } } }).connector;
  await assert.rejects(broken.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), /boom/, "a real failure is not reported as a missing message");
});

test("historyFile stays inside this space and thread and refuses private, deleted and Drive-picker files", async () => {
  let reads = 0;
  const reply = (extra) => fileConnector({ bot: { async getMessage() { reads += 1; return fileMessage(extra); } } }).connector;
  const connector = reply();
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/BBB/messages/m1" }), /not in this Google Chat conversation/);
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "../../media/x" }), /Use a message id/);
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", thread: "spaces/BBB/threads/T1" }), /thread is not in this Google Chat conversation/);
  await assert.rejects(connector.historyFile({ conversationId: "C123", message: "spaces/AAA/messages/m1" }), /not a Google Chat space/);
  assert.equal(reads, 0, "a foreign or malformed name never reaches the API");

  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", thread: "spaces/AAA/threads/OTHER" }), /not in that thread/);
  await assert.rejects(reply({ name: "spaces/AAA/messages/other" }).historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), /not in this Google Chat conversation/);
  await assert.rejects(reply({ privateMessageViewer: { name: "users/1" } }).historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", file: "plan.pdf" }), /cannot read it/);
  await assert.rejects(reply({ deleteTime: "2026-11-22T10:00:00Z" }).historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", file: "plan.pdf" }), /cannot read it/);
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), /several files; name one: plan.pdf, notes.docx/);
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", file: "x.txt" }), /no file named "x.txt". Its files: plan.pdf, notes.docx/);
  await assert.rejects(reply({ attachment: [] }).historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1" }), /no file attached/);
  await assert.rejects(connector.historyFile({ conversationId: "spaces/AAA", message: "spaces/AAA/messages/m1", file: "notes.docx" }),
    /notes.docx was shared from Google Drive.*upload it directly/);
});

test("Google Chat history names each file's message, and conversation_download_file saves it under this thread's uploads within the cap", async () => {
  const { readFile } = await import("node:fs/promises");
  const { ensureConversation } = await import("../src/platforms/ingest.js");
  const { slug } = (await ensureConversation({ conversationId: "gchat:spaces/FILES1", rawConversationId: "spaces/FILES1", conversationName: "Files",
    kind: "channel", isDM: false, platform: "googlechat", userId: "ana@example.com" })).entry;
  const message = { name: "spaces/FILES1/messages/m7", thread: { name: "spaces/FILES1/threads/T7" }, createTime: "2026-11-22T10:07:00Z",
    sender: { name: "users/1", type: "HUMAN" }, text: "budget attached",
    attachment: [{ contentName: "budget.csv", contentType: "text/csv", attachmentDataRef: { resourceName: "spaces/FILES1/attachments/b7" } }] };
  let body = () => new Response("a,b\n1,2\n");
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities,
    api: { async listMembers() { return [{ id: "users/1", name: "Ana Pop" }]; }, async getMessage() { return message; }, async downloadAttachment() { return body(); } },
    historyApi: () => ({ async listMessages() { return [message]; } }) });
  resetTransports();
  registerTransport("googlechat", { getConnector: () => connector });
  const tools = new Map();
  register({ registerTool: (name, _schema, handler) => tools.set(name, handler) }, {
    text: (t) => ({ content: [{ type: "text", text: t }] }), requireChannelAccess: async () => true,
    channelId: "gchat:spaces/FILES1", slug, threadKey: "spaces/FILES1/threads/T7::agent-2", loadMeta: async () => ({}) });
  assert.ok(tools.has("conversation_download_file"), "registered wherever the Google Chat connector is live");

  const listed = out(await tools.get("conversation_history")({ thread: "current" }));
  assert.match(listed, /\[file: budget.csv · text\/csv\] \(message spaces\/FILES1\/messages\/m7, thread spaces\/FILES1\/threads\/T7\)$/);

  const saved = out(await tools.get("conversation_download_file")({ message: "spaces/FILES1/messages/m7", thread: "spaces/FILES1/threads/T7" }));
  const file = saved.match(/Downloaded: (\S+)\./)?.[1];
  assert.ok(file && file.includes("/uploads/spaces_FILES1_threads_T7/"), saved);
  assert.equal(await readFile(file, "utf8"), "a,b\n1,2\n");

  // The intake's per-file cap applies to the stream exactly as it does to a live upload.
  body = () => ({ headers: { get: (name) => (name === "content-length" ? String(10 ** 12) : null) }, body: null });
  assert.match(out(await tools.get("conversation_download_file")({ message: "spaces/FILES1/messages/m7" })), /Couldn't download budget.csv \(.*\)\. Do NOT pretend/);
  resetTransports();
});
