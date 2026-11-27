import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ createTeamsHistory, teamsHtmlToText, HISTORY_UNAVAILABLE, HISTORY_PERMISSION }, { register }, { registerTransport, resetTransports }, { ensureConversation }, { startTeams }] = await Promise.all([
  import("../src/platforms/msteams/history.js"),
  import("../src/mcp/tools/conversation-history.js"),
  import("../src/platforms/live.js"),
  import("../src/platforms/ingest.js"),
  import("../src/platforms/msteams/transport.js"),
]);

const GRAPH = "https://graph.microsoft.com/v1.0";
const CHANNEL = "teams:19:general@thread.tacv2";
const CHAT = "teams:19:group@thread.v2";
const store = { list: async () => [
  { conversationId: CHANNEL, resource: "/teams/team-1/channels/19%3Ageneral%40thread.tacv2/messages" },
  { conversationId: CHAT, resource: "/chats/19%3Agroup%40thread.v2/messages" },
  { conversationId: "teams:19:forged@thread.v2", resource: "/users/someone/messages" },
] };
const message = (id, at, html, extra = {}) => ({ id, messageType: "message", createdDateTime: at,
  from: { user: { displayName: `Person ${id}` } }, body: { contentType: "html", content: html }, attachments: [], ...extra });
function graph(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, redirect: init.redirect });
    const body = routes[url];
    if (typeof body === "number") return new Response("{}", { status: body });
    if (!body) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}
const auth = { token: async () => "graph-token" };

test("Teams HTML bodies become text with mentions, breaks and entities kept and markup dropped", () => {
  assert.equal(teamsHtmlToText('<p>Hi <at id="0">Ana Pop</at>,</p><p>see&nbsp;&lt;this&gt; &amp; <b>that</b><br>ok &#128512;</p><attachment id="a"></attachment>'),
    "Hi Ana Pop,\nsee <this> & that\nok 😀");
});

test("a channel's history comes from its own subscription resource, oldest first, without system or deleted messages", async () => {
  const resource = `${GRAPH}/teams/team-1/channels/19%3Ageneral%40thread.tacv2/messages`;
  const { seen, fetchImpl } = graph({
    [`${resource}?$top=50`]: { value: [
      message("300", "2026-11-22T10:03:00Z", "<p>third</p>", { attachments: [{ contentType: "reference", name: "plan.xlsx", contentUrl: "https://contoso.sharepoint.com/sites/x/plan.xlsx" }] }),
      message("200", "2026-11-22T10:02:00Z", "<p>gone</p>", { deletedDateTime: "2026-11-22T10:05:00Z" }),
      { id: "150", messageType: "systemEventMessage", createdDateTime: "2026-11-22T10:01:30Z", body: { content: "<systemEventMessage/>" } },
      message("100", "2026-11-22T10:01:00Z", "<p>first</p>"),
    ], "@odata.nextLink": "https://evil.example/next" },
  });
  const history = createTeamsHistory({ auth, store, fetchImpl });
  const rows = await history.readHistory({ conversationId: CHANNEL });
  assert.deepEqual(rows.map(row => [row.id, row.text, row.thread]), [["100", "first", "100"], ["300", "third", "300"]]);
  assert.deepEqual(rows[1].attachments, [{ name: "plan.xlsx", type: "file" }]);
  assert.equal(rows[0].sender, "Person 100");
  assert.deepEqual(seen.map(call => call.url), [`${resource}?$top=50`], "a nextLink off Graph is never followed");
  assert.equal(seen[0].auth, "Bearer graph-token");
  assert.equal(seen[0].redirect, "error");
});

test("a reply chain reads its root and replies; a chat reads newest first and pages only on Graph", async () => {
  const channel = `${GRAPH}/teams/team-1/channels/19%3Ageneral%40thread.tacv2/messages`;
  const chat = `${GRAPH}/chats/19%3Agroup%40thread.v2/messages`;
  const { seen, fetchImpl } = graph({
    [`${channel}/100`]: message("100", "2026-11-22T10:01:00Z", "root"),
    [`${channel}/100/replies?$top=50`]: { value: [message("102", "2026-11-22T10:03:00Z", "reply two"), message("101", "2026-11-22T10:02:00Z", "reply one")] },
    [`${chat}?$top=50&$orderby=createdDateTime%20desc`]: { value: [message("9", "2026-11-22T09:09:00Z", "nine")], "@odata.nextLink": `${chat}?page=2` },
    [`${chat}?page=2`]: { value: [message("8", "2026-11-22T09:08:00Z", "eight")] },
  });
  const history = createTeamsHistory({ auth, store, fetchImpl });
  assert.deepEqual((await history.readHistory({ conversationId: CHANNEL, threadKey: "100" })).map(row => row.text), ["root", "reply one", "reply two"]);
  assert.deepEqual((await history.readHistory({ conversationId: CHAT, limit: 2 })).map(row => [row.text, row.thread]), [["eight", ""], ["nine", ""]]);
  assert.ok(seen.some(call => call.url === `${chat}?page=2`));
  await assert.rejects(history.readHistory({ conversationId: CHANNEL, threadKey: "../../users" }), /not a Teams thread id/);
  await assert.rejects(history.readHistory({ conversationId: CHAT, threadKey: "100" }), /Only Teams channels have reply chains/);
});

test("no subscription record, a forged resource or a Graph refusal answer with the remedy", async () => {
  const { fetchImpl } = graph({ [`${GRAPH}/chats/19%3Agroup%40thread.v2/messages?$top=50&$orderby=createdDateTime%20desc`]: 403 });
  const history = createTeamsHistory({ auth, store, fetchImpl });
  await assert.rejects(history.readHistory({ conversationId: "teams:a:personal" }), error => error.message === HISTORY_UNAVAILABLE);
  await assert.rejects(history.readHistory({ conversationId: "teams:19:forged@thread.v2" }), error => error.message === HISTORY_UNAVAILABLE);
  await assert.rejects(history.readHistory({ conversationId: CHAT }), error => error.message === HISTORY_PERMISSION);
});

test("a historical file is fetched only from a message of this conversation, through the drive allowlist", async () => {
  const channel = `${GRAPH}/teams/team-1/channels/19%3Ageneral%40thread.tacv2/messages`;
  const files = [
    { contentType: "reference", name: "plan.xlsx", contentUrl: "https://contoso.sharepoint.com/sites/x/plan.xlsx" },
    { contentType: "reference", name: "notes.txt", contentUrl: "https://contoso.sharepoint.com/sites/x/notes.txt" },
  ];
  const { seen, fetchImpl } = graph({
    [`${channel}/100/replies/101`]: message("101", "2026-11-22T10:02:00Z", "files", { attachments: files }),
    [`${channel}/300`]: message("300", "2026-11-22T10:03:00Z", "one", { attachments: [files[0]] }),
  });
  const resolved = [];
  const resolveFile = descriptor => { resolved.push(descriptor); return descriptor.contentUrl.endsWith("plan.xlsx") ? async () => Buffer.from("xlsx") : null; };
  const history = createTeamsHistory({ auth, store, fetchImpl, resolveFile });
  const found = await history.historyFile({ conversationId: CHANNEL, message: "101", thread: "100", file: "PLAN.xlsx" });
  assert.equal(found.name, "plan.xlsx");
  assert.deepEqual(resolved, [{ contentUrl: files[0].contentUrl }], "only the canonical URL reaches the allowlisted resolver");
  assert.ok(seen.some(call => call.url === `${channel}/100/replies/101`));
  assert.equal((await history.historyFile({ conversationId: CHANNEL, message: "300" })).name, "plan.xlsx", "a single file needs no name");
  await assert.rejects(history.historyFile({ conversationId: CHANNEL, message: "101", thread: "100" }), /several files; name one: plan.xlsx, notes.txt/);
  await assert.rejects(history.historyFile({ conversationId: CHANNEL, message: "101", thread: "100", file: "notes.txt" }), /not in a SharePoint location the gateway may read/);
  await assert.rejects(history.historyFile({ conversationId: CHANNEL, message: "999" }), /not in this Teams conversation/);
  await assert.rejects(history.historyFile({ conversationId: CHANNEL, message: "1/../../x" }), /Use a message id/);
  await assert.rejects(createTeamsHistory({ auth, store, fetchImpl }).historyFile({ conversationId: CHANNEL, message: "300" }), /file downloads are off/);
});

function tools(ctx, connector) {
  resetTransports();
  if (connector) registerTransport("msteams", { getConnector: () => connector });
  const registered = new Map();
  register({ registerTool: (name, _schema, handler) => registered.set(name, handler) }, {
    text: value => ({ content: [{ type: "text", text: value }] }), requireChannelAccess: async () => true, ...ctx,
  });
  return registered;
}
const out = result => result.content[0].text;

test("Teams conversation_history names a file's message, and conversation_download_file saves it under this thread's uploads", async () => {
  const { slug } = (await ensureConversation({ conversationId: CHANNEL, rawConversationId: "19:general@thread.tacv2", conversationName: "General",
    kind: "channel", isDM: false, platform: "msteams", userId: "29:member" })).entry;
  const calls = [];
  const connector = { threadFor: key => /^\d+$/.test(key) ? key : null, ready: () => true,
    async readHistory(args) { calls.push(["read", args]); return [{ id: "101", thread: "100", createTime: "2026-11-22T10:02:00Z", sender: "Ana", text: "the plan", attachments: [{ name: "plan.xlsx", type: "file" }] }]; },
    async historyFile(args) { calls.push(["file", args]); return { name: "plan.xlsx", contentType: "application/octet-stream", download: async () => Buffer.from("spreadsheet") }; } };
  const registered = tools({ channelId: CHANNEL, slug, threadKey: "100::agent-3", loadMeta: async () => ({}) }, connector);
  assert.match(out(await registered.get("conversation_history")({ thread: "current" })), /\[file: plan.xlsx · file\] \(message 101, thread 100\)$/);
  assert.deepEqual(calls[0][1], { conversationId: CHANNEL, threadKey: "100", limit: 30 });

  const saved = out(await registered.get("conversation_download_file")({ message: "101", thread: "100", file: "plan.xlsx" }));
  assert.deepEqual(calls[1][1], { conversationId: CHANNEL, message: "101", thread: "100", file: "plan.xlsx" }, "the conversation is the run's own, never an argument");
  const path = saved.match(/Downloaded: (\S+)\./)?.[1];
  assert.ok(path && path.includes("/uploads/100/"), saved);
  assert.equal(await readFile(path, "utf8"), "spreadsheet");

  const refused = tools({ channelId: CHANNEL, slug, threadKey: "100" }, { ...connector, async historyFile() { throw new Error("That message is not in this Teams conversation."); } });
  assert.match(out(await refused.get("conversation_download_file")({ message: "5" })), /Couldn't download that file: That message is not in this Teams conversation/);

  const noFiles = tools({ channelId: CHANNEL, slug }, { ...connector, historyFile: undefined });
  assert.ok(noFiles.has("conversation_history"));
  assert.equal(noFiles.has("conversation_download_file"), false, "no download tool without Teams file access");
  assert.match(out(await noFiles.get("conversation_history")({})), /\[file: plan.xlsx · file\]\n?.*\(thread 100\)$/s);
  resetTransports();
});

test("the Teams transport offers history only with Graph events, and file reads only with file access", async () => {
  const deps = (extra = {}) => ({ auth: { token: async () => "bot" }, api: {}, connector: {}, jwks: {}, graphAuth: auth,
    eventStore: store, createGraphEvents: () => ({ start() {}, async stop() {}, async ensure() {}, handle() {} }),
    botInbox: { start() {}, stop() {}, accept() {} }, botControlInbox: { start() {}, stop() {}, accept() {} },
    botNoticeInbox: { start() {}, stop() {}, accept() {} }, graphControlInbox: { start() {}, stop() {}, accept() {} },
    graphInbox: { start() {}, stop() {}, accept() {} }, graphDispatchInbox: { start() {}, stop() {}, accept() {} },
    graphNotificationInbox: { start() {}, stop() {}, accept() {} }, ...extra });
  const plain = await startTeams({ appId: "app", tenantId: "tenant", onMessage: async () => {}, deps: deps() });
  assert.equal(plain.connector.readHistory, undefined);
  await plain.stop();
  const events = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async () => {}, deps: deps() });
  assert.equal(typeof events.connector.readHistory, "function");
  assert.equal(events.connector.historyFile, undefined);
  await events.stop();
  const withFiles = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, filesEnabled: true, fileDriveIds: ["drive-1"],
    publicUrl: "https://gateway.example", onMessage: async () => {}, deps: deps() });
  assert.equal(typeof withFiles.connector.historyFile, "function");
  await withFiles.stop();
});
