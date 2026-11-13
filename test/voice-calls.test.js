import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createRunQueue } = await import("../src/slack/util.js");
const { createCallManager, buildSystemInstruction, TOOL_DECLARATIONS, VOICE_CALL_ORIGIN, VOICE_ENGINE } = await import("../src/gateway/voice/calls.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, activityCallPath } = await import("../src/web/activity.js");
const { CALL_WORKLET_PATH } = await import("../src/web/call-overlay.js");
const { menuButtons } = await import("../src/slack/footer.js");
const { handleReplyCallAction, REPLY_CALL_ACTION_ID } = await import("../src/slack/call-button.js");
const { RUN_ORIGINS, PRINCIPAL_KIND_BY_ORIGIN } = await import("../src/engines/contract.js");

class FakeSession extends EventEmitter {
  static instances = [];
  constructor(options) { super(); this.options = options; this.ready = false; this.audio = []; this.texts = []; this.responses = []; this.closed = false; FakeSession.instances.push(this); }
  sendAudio(buffer) { if (!this.ready) return false; this.audio.push(buffer); return true; }
  sendText(text) { if (!this.ready) return false; this.texts.push(text); return true; }
  sendToolResponse(response) { this.responses.push(response); return true; }
  close() { this.closed = true; }
  live() { this.ready = true; this.emit("ready"); }
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function channel(id = "C_WORK", { type = "channel", access = "approved", name } = {}) {
  await upsertChannelEntry(id, { name: name || `#${id.toLowerCase()}`, type, isDM: type === "im" });
  const entry = await getChannelEntry(id);
  await saveChannelMeta(entry.slug, { access, isDM: type === "im" });
  return entry;
}
const ROWS = [
  { channel_id: "C_WORK", thread_ts: "55.000001", title: "Build the voice page", channelName: "#c_work", status: "working", last_message_ms: 3_000 },
  { channel_id: "C_SALES", thread_ts: "44.000001", title: "Pipeline review for Q4", channelName: "#c_sales", status: "waiting", last_message_ms: 2_000 },
  { channel_id: "C_WORK", thread_ts: "33.000001", title: "Old deploy fix", channelName: "#c_work", status: "done", last_message_ms: 1_000 },
];
function fixture(overrides = {}) {
  FakeSession.instances = [];
  const posted = [], records = [], delivered = [], runs = [], logs = [], memories = [], snapshots = [];
  const client = { chat: { postMessage: async () => ({ ts: "1.1" }) }, conversations: { replies: async () => ({ messages: [] }) } };
  const manager = createCallManager({
    getConfig: () => ({ enabled: true, apiKey: "AIzaTestKey_0123456789abc", model: "gemini-3.8-live", voice: "Kore" }),
    createSession: (options) => new FakeSession(options),
    runner: async (args) => { runs.push(args); await tick(5); return { content: "Done: I built it and ran the tests.", engine: "claude", usage: { input_tokens: 10, output_tokens: 5 } }; },
    queue: createRunQueue(), progress: () => null,
    deliver: async (_client, args) => { delivered.push(args); }, record: async (row) => { records.push(row); },
    post: async (_client, args) => { posted.push(args); return { messageId: `${posted.length}00.000100` }; },
    directory: async () => null, log: async (...args) => { logs.push(args); },
    readThread: async (_client, _channel, _thread, { limit } = {}) => [{ ts: "1", from: "U_MINE", text: "Earlier message" }, { ts: "2", from: "agent", text: "Earlier reply" }].slice(0, limit),
    snapshot: async (_client, _owner, requested) => {
      snapshots.push(requested);
      const needle = String(requested.search || "").toLowerCase();
      const rows = ROWS.filter((row) => requested.filter === "all-statuses" || (requested.filter === "all" ? row.status !== "done" : row.status === requested.filter))
        .filter((row) => !needle || `${row.title} ${row.channelName}`.toLowerCase().includes(needle));
      return { rows, total: rows.length, unavailable: false };
    },
    saveMemory: async (entry) => { memories.push(entry); return { saved: true, slug: "dm-u-mine" }; },
    endCallGraceMs: 5, idleMs: 60_000, ...overrides,
  });
  return { manager, posted, records, delivered, runs, logs, memories, snapshots, client };
}

beforeEach(async () => {
  resetActivityStateForTests();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "usage", "events"]) getDb().exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu" });
  await setUser("U_NOPE", { approved: false, isAdmin: false, name: "Stranger" });
  saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" });
});

test("both Google key shapes are accepted and anything that could break the URL is refused", async () => {
  const { isGeminiApiKey, getVoiceCallConfig } = await import("../src/config/settings.js");
  for (const key of ["AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r", "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i"]) assert.equal(isGeminiApiKey(key), true, key);
  for (const key of ["short", "AQ.key with space 0123456789", "AQ.key&x=1_0123456789abcdef", "AQ.key\"0123456789abcdefgh", "x".repeat(257), 42, null]) assert.equal(isGeminiApiKey(key), false, String(key));
  saveSettings({ voiceCallsEnabled: true, geminiApiKey: "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i" });
  assert.equal(getVoiceCallConfig().apiKey, "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i");
  saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" });
});

test("voice_call is a registered interactive user origin that never escalates", async () => {
  assert.ok(RUN_ORIGINS.includes(VOICE_CALL_ORIGIN));
  assert.equal(PRINCIPAL_KIND_BY_ORIGIN[VOICE_CALL_ORIGIN], "user");
  const { mayEscalate } = await import("../src/gateway/run.js");
  assert.equal(mayEscalate({ meta: { adminMode: true }, isAdminAuthor: true, origin: VOICE_CALL_ORIGIN }), false);
});

test("a call is refused without configuration, for an unknown conversation and for an unapproved caller", async () => {
  await channel();
  const off = fixture({ getConfig: () => ({ enabled: true, apiKey: "" }) });
  await assert.rejects(off.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: off.client }), (e) => e.status === 503);
  assert.equal(off.manager.available(), false);
  const f = fixture();
  assert.equal(f.manager.available(), true);
  await assert.rejects(f.manager.start({ ownerId: "U_MINE", channelId: "C_NOPE", client: f.client }), (e) => e.status === 404);
  await assert.rejects(f.manager.start({ ownerId: "U_NOPE", channelId: "C_WORK", client: f.client }), (e) => e.status === 403);
  await assert.rejects(f.manager.start({ ownerId: "U_NOPE", client: f.client }), (e) => e.status === 403, "an unbound call still needs an approved caller");
  await assert.rejects(f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK" }), (e) => e.status === 400);
  await assert.rejects(f.manager.start({ ownerId: "U_MINE", threadTs: "1.1", client: f.client }), (e) => e.status === 400, "a thread needs its conversation");
  assert.equal(f.posted.length, 0, "a refused call posts nothing");
  assert.equal(FakeSession.instances.length, 0);
});

test("a call without a thread opens one, with a thread announces itself there and reads the context, and the voice gets the caller's recent conversations", async () => {
  await channel();
  const f = fixture();
  const fresh = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client, teamId: "T_WORK" });
  assert.equal(fresh.threadTs, "100.000100");
  assert.equal(f.posted[0].threadKey, undefined);
  assert.match(f.posted[0].text, /Voice call.*Tiberiu/);
  assert.equal(fresh.channelName, "#c_work"); assert.equal(fresh.callerName, "Tiberiu"); assert.equal(fresh.model, "gemini-3.8-live");
  assert.deepEqual(fresh.bound, { channelId: "C_WORK", channelName: "#c_work", threadTs: "100.000100", title: "" });
  const session = FakeSession.instances[0];
  assert.equal(session.options.apiKey, "AIzaTestKey_0123456789abc");
  assert.deepEqual(session.options.tools, TOOL_DECLARATIONS);
  assert.match(session.options.systemInstruction, /voice call with Tiberiu/);
  assert.match(session.options.systemInstruction, /currently in the Slack conversation #c_work/);
  assert.match(session.options.systemInstruction, /new and empty/);
  // The initial list: the caller's open conversations, most recent first, done ones excluded.
  assert.match(session.options.systemInstruction, /1\. \[C_WORK:55\.000001\] #c_work — Build the voice page \(working/);
  assert.match(session.options.systemInstruction, /2\. \[C_SALES:44\.000001\] #c_sales — Pipeline review for Q4 \(waiting/);
  assert.doesNotMatch(session.options.systemInstruction, /Old deploy fix/);
  assert.equal(f.snapshots[0].filter, "all");
  assert.equal(f.manager.size(), 1);
  // The same person calling again replaces their earlier call.
  const bound = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, teamId: "T_WORK" });
  assert.equal(f.manager.size(), 1);
  assert.equal(f.manager.get(fresh.id), null);
  assert.equal(bound.threadTs, "55.000001");
  const joined = f.posted.find((p) => p.threadKey === "55.000001");
  assert.match(joined.text, /joined this thread by voice call/);
  const second = FakeSession.instances[1];
  assert.match(second.options.systemInstruction, /Tiberiu: Earlier message\nAgent: Earlier reply/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x", isAdmin: true }), /organization admin/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x" }), /offer to dispatch a search.*never guess/i);
  assert.match(buildSystemInstruction({ callerName: "A" }), /not in any conversation yet/);
  await f.manager.end(bound.id, "U_MINE");
});

test("an unbound call lists, searches and switches conversations, posting each segment where it happened", async () => {
  await channel(); await channel("C_SALES");
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", client: f.client, teamId: "T_WORK" });
  assert.equal(call.bound, null); assert.equal(call.threadTs, ""); assert.equal(f.posted.length, 0, "an unbound call posts nothing until it joins a conversation");
  const session = FakeSession.instances[0];
  assert.match(session.options.systemInstruction, /not in any conversation yet/);
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.equal(seen[0].bound, null);
  session.live();
  session.emit("tool_call", { id: "t0", name: "run_task", args: { request: "do it" } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /not in a conversation yet/);
  session.emit("tool_call", { id: "t1", name: "list_conversations", args: {} });
  await tick();
  const listed = session.responses.at(-1).response;
  assert.deepEqual(listed.conversations.map((c) => c.id), ["C_WORK:55.000001", "C_SALES:44.000001"]);
  assert.equal(listed.conversations[0].channel, "#c_work"); assert.equal(listed.conversations[0].status, "working");
  assert.equal(listed.total, 2); assert.equal(listed.more, false);
  session.emit("tool_call", { id: "t2", name: "list_conversations", args: { status: "all", channel: "c_work", limit: 1 } });
  await tick();
  const filtered = session.responses.at(-1).response;
  assert.deepEqual(filtered.conversations.map((c) => c.id), ["C_WORK:55.000001"]); assert.equal(filtered.total, 2); assert.equal(filtered.more, true);
  session.emit("tool_call", { id: "t3", name: "search_conversations", args: { query: "pipeline" } });
  await tick();
  assert.deepEqual(session.responses.at(-1).response.conversations.map((c) => c.title), ["Pipeline review for Q4"]);
  session.emit("tool_call", { id: "t4", name: "search_conversations", args: { query: "   " } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /what to search/);
  // Switch to the sales thread: it is announced there and its context comes back to the voice.
  session.emit("input_transcript", { text: "Open the pipeline review" });
  session.emit("tool_call", { id: "t5", name: "switch_conversation", args: { id: "C_SALES:44.000001" } });
  await tick(20);
  const switched = session.responses.at(-1);
  assert.equal(switched.scheduling, "INTERRUPT");
  assert.equal(switched.response.switched, true); assert.equal(switched.response.conversation, "#c_sales"); assert.equal(switched.response.title, "Pipeline review for Q4");
  assert.deepEqual(switched.response.recentMessages, [{ from: "Tiberiu", text: "Earlier message" }, { from: "Agent", text: "Earlier reply" }]);
  assert.deepEqual(seen.at(-1), { type: "bound", channelId: "C_SALES", channelName: "#c_sales", threadTs: "44.000001", title: "Pipeline review for Q4" });
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].threadKey, "44.000001"); assert.match(f.posted[0].text, /joined this thread by voice call/);
  // A task runs in the current conversation; then the call moves to a new thread in #c_work.
  session.emit("tool_call", { id: "t6", name: "run_task", args: { request: "Summarize the pipeline" } });
  await tick(40);
  assert.equal(f.runs[0].channelId, "C_SALES"); assert.equal(f.runs[0].threadKey, "44.000001");
  assert.equal(f.delivered[0].channel, "C_SALES");
  session.emit("output_transcript", { text: "Started the summary." }); session.emit("turn_complete");
  session.emit("tool_call", { id: "t7", name: "switch_conversation", args: { channel: "c_work" } });
  await tick(20);
  const moved = session.responses.at(-1).response;
  assert.equal(moved.switched, true); assert.equal(moved.conversation, "#c_work"); assert.equal(moved.opened, true); assert.deepEqual(moved.recentMessages, []);
  const segment = f.posted.find((p) => /Voice call moved on/.test(p.text));
  assert.equal(segment.threadKey, "44.000001");
  assert.match(segment.text, /moved on\* — 1 min here · 1 task/);
  assert.match(segment.text, /\*Tasks here:\* 1\. Summarize the pipeline — done/);
  assert.match(segment.text, /> \*Tiberiu:\* Open the pipeline review\n> \*Agent:\* Started the summary\./);
  const root = f.posted.at(-1);
  assert.equal(root.conversationId, "C_WORK"); assert.equal(root.threadKey, undefined); assert.match(root.text, /Voice call.*Tiberiu/);
  session.emit("tool_call", { id: "t8", name: "switch_conversation", args: { channel: "nowhere" } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /No channel named "nowhere"/);
  session.emit("tool_call", { id: "t9", name: "switch_conversation", args: { id: "garbage" } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /not a conversation id/);
  session.emit("tool_call", { id: "t10", name: "switch_conversation", args: {} });
  await tick();
  assert.match(session.responses.at(-1).response.error, /conversation id or a channel name/);
  // Switching to a conversation the caller may not post in is refused by the access rule.
  await channel("C_PRIVATE", { access: "admins" });
  session.emit("tool_call", { id: "t11", name: "switch_conversation", args: { channel: "c_private" } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /not authorized/);
  // Hang up: the final summary lands in the current thread, names the other places, and the DM memory gets one line.
  session.emit("usage", { delta: { audioIn: 1000, textIn: 100, audioOut: 500, textOut: 50 } });
  await f.manager.end(call.id, "U_MINE", "the caller hung up");
  const summary = f.posted.at(-1);
  assert.equal(summary.conversationId, "C_WORK"); assert.equal(summary.threadKey, root.threadKey ?? `${f.posted.indexOf(root) + 1}00.000100`);
  assert.match(summary.text, /Voice call ended\* — 1 min · 1 task · ~\$0\.0093 voice/);
  assert.match(summary.text, /\*Also visited:\* #c_sales — Pipeline review for Q4/);
  assert.doesNotMatch(summary.text, /Tasks here/);
  assert.equal(f.memories.length, 1);
  assert.equal(f.memories[0].ownerId, "U_MINE");
  assert.match(f.memories[0].text, /^Voice call on \d{4}-\d{2}-\d{2} \(1 min\): worked in #c_sales "Pipeline review for Q4", #c_work; tasks: "Summarize the pipeline" \(done\)$/);
  const usage = f.records.find((r) => r.engine === VOICE_ENGINE);
  assert.equal(usage.channelId, "C_WORK"); assert.equal(usage.result.costUSD, 0.0093);
  assert.ok(f.logs.some(([name, data]) => name === "voice_call_ended" && data.visited === 2 && data.memorySaved === true));
});

test("run_task posts the spoken request, runs a turn as the caller in the bound thread and reports back to the voice", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, teamId: "T_WORK" });
  const session = FakeSession.instances[0];
  const seen = [];
  const unsubscribe = f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.equal(seen[0].type, "state"); assert.equal(seen[0].status, "connecting"); assert.equal(seen[0].bound.channelName, "#c_work");
  session.live();
  assert.equal(seen.at(-1).type, "ready");
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Build the voice page and run the tests" } });
  await tick(40);
  assert.deepEqual(session.responses[0], { id: "c1", name: "run_task", response: { status: "started", task: 1, conversation: "#c_work" }, scheduling: "SILENT" });
  const request = f.posted.find((p) => /voice call\)/.test(p.text));
  assert.equal(request.threadKey, "55.000001");
  assert.match(request.text, /Tiberiu \(voice call\):\* Build the voice page/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].authorId, "U_MINE"); assert.equal(f.runs[0].origin, VOICE_CALL_ORIGIN);
  assert.equal(f.runs[0].threadKey, "55.000001"); assert.equal(f.runs[0].channelId, "C_WORK"); assert.equal(f.runs[0].workspaceId, "T_WORK");
  assert.equal(f.runs[0].untrustedPrincipal, undefined, "the caller is a trusted, authenticated person");
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].footer, true); assert.equal(f.delivered[0].threadKey, "55.000001");
  assert.equal(f.records[0].taskKind, "voice-task"); assert.equal(f.records[0].authorId, "U_MINE"); assert.equal(f.records[0].engine, "claude");
  assert.match(session.texts[0], /^\[gateway\] Task 1 finished\. Result: Done: I built it/);
  const tasks = seen.filter((e) => e.type === "task");
  assert.deepEqual(tasks.map((t) => t.status), ["queued", "running", "done"]);
  assert.match(tasks.at(-1).summary, /Done: I built it/);
  session.emit("tool_call", { id: "c2", name: "check_tasks", args: {} });
  await tick();
  assert.deepEqual(session.responses.at(-1).response.tasks, [{ task: 1, status: "done", conversation: "#c_work", request: "Build the voice page and run the tests", summary: "Done: I built it and ran the tests." }]);
  session.emit("tool_call", { id: "c3", name: "read_thread", args: { limit: 1 } });
  await tick();
  assert.deepEqual(session.responses.at(-1).response, { conversation: "#c_work", messages: [{ from: "Tiberiu", text: "Earlier message" }] });
  session.emit("tool_call", { id: "c4", name: "run_task", args: { request: "   " } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /empty/);
  session.emit("tool_call", { id: "c5", name: "mystery", args: {} });
  await tick();
  assert.match(session.responses.at(-1).response.error, /Unknown tool/);
  unsubscribe();
  await f.manager.end(call.id, "U_MINE", "test over");
});

test("a task finishing after the call moved elsewhere says where it ran", async () => {
  await channel(); await channel("C_SALES");
  const f = fixture({ runner: async (args) => { await tick(30); return { content: "Pipeline summarized.", engine: "claude" }; } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_SALES", threadTs: "44.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Summarize" } });
  await tick(5);
  session.emit("tool_call", { id: "c2", name: "switch_conversation", args: { id: "C_WORK:55.000001" } });
  await tick(60);
  assert.match(session.texts.at(-1), /^\[gateway\] Task 1 \(in #c_sales, not the current conversation\) finished/);
  await f.manager.end(call.id, "U_MINE");
});

test("a failed task is reported in the thread and to the voice without an answer being invented", async () => {
  await channel();
  const f = fixture({ runner: async () => { throw new Error("engine exploded"); } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Do the thing" } });
  await tick(30);
  assert.equal(f.delivered.length, 0);
  assert.match(f.posted.at(-1).text, /could not run: engine exploded/);
  assert.match(session.texts[0], /^\[gateway\] Task 1 failed: engine exploded/);
  await f.manager.end(call.id, "U_MINE");
});

test("transcript, audio, hang-up summary and accounting", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0];
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.throws(() => f.manager.subscribe(call.id, "U_OTHER", () => {}), (e) => e.status === 404);
  assert.throws(() => f.manager.audio(call.id, "U_OTHER", Buffer.from([1])), (e) => e.status === 404);
  assert.equal(f.manager.audio(call.id, "U_MINE", Buffer.from([1, 2])), false, "audio before the voice is ready is dropped");
  session.live();
  assert.equal(f.manager.audio(call.id, "U_MINE", Buffer.from([1, 2])), true);
  assert.equal(session.audio.length, 1);
  session.emit("audio", Buffer.from([9, 9]));
  assert.deepEqual(seen.at(-1), { type: "audio", data: Buffer.from([9, 9]).toString("base64") });
  session.emit("input_transcript", { text: "Hello " }); session.emit("input_transcript", { text: "agent" });
  session.emit("output_transcript", { text: "Hi Tiberiu" }); session.emit("turn_complete");
  session.emit("interrupted");
  session.emit("input_transcript", { text: "Wait" });
  session.emit("usage", { delta: { audioIn: 1000, textIn: 100, audioOut: 500, textOut: 50 } });
  assert.deepEqual(seen.filter((e) => e.type === "transcript").map((e) => [e.who, e.text]), [["caller", "Hello "], ["caller", "Hello agent"], ["agent", "Hi Tiberiu"], ["caller", "Wait"]]);
  assert.equal(await f.manager.end(call.id, "U_OTHER"), false, "only the caller hangs up");
  assert.equal(await f.manager.end(call.id, "U_MINE", "the caller hung up"), true);
  assert.equal(await f.manager.end(call.id, "U_MINE"), false);
  assert.equal(session.closed, true);
  assert.equal(seen.at(-1).type, "ended"); assert.equal(seen.at(-1).reason, "the caller hung up");
  const summary = f.posted.at(-1);
  assert.equal(summary.threadKey, call.threadTs);
  assert.match(summary.text, /Voice call ended.*1 min · 0 tasks · ~\$0\.0093 voice/);
  assert.doesNotMatch(summary.text, /Also visited/);
  assert.match(summary.text, /> \*Tiberiu:\* Hello agent\n> \*Agent:\* Hi Tiberiu\n> \*Tiberiu:\* Wait/);
  const usage = f.records.find((r) => r.engine === VOICE_ENGINE);
  assert.equal(usage.taskKind, "voice-call"); assert.equal(usage.model, "gemini-3.8-live"); assert.equal(usage.authorId, "U_MINE");
  assert.deepEqual(usage.result.usage, { input_tokens: 1100, output_tokens: 550 });
  assert.equal(usage.result.costUSD, 0.0093);
  assert.match(f.memories[0].text, /worked in #c_work$/);
  assert.ok(f.logs.some(([name]) => name === "voice_call_ended"));
});

test("end_call hangs up after a short goodbye, and a dead voice connection ends the call with its reason", async () => {
  await channel();
  const f = fixture();
  const first = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "end_call", args: {} });
  assert.deepEqual(session.responses[0].response, { status: "ending" });
  assert.equal(f.manager.get(first.id)?.status, "live");
  await tick(25);
  assert.equal(f.manager.get(first.id), null);
  await setUser("U_OTHER", { approved: true, name: "Other" });
  const second = await f.manager.start({ ownerId: "U_OTHER", channelId: "C_WORK", client: f.client });
  const seen = [];
  f.manager.subscribe(second.id, "U_OTHER", (event) => seen.push(event));
  FakeSession.instances[1].emit("closed", { reason: "quota exceeded" });
  await tick(10);
  assert.equal(f.manager.get(second.id), null);
  assert.match(seen.at(-1).reason, /voice service closed the connection \(quota exceeded\)/);
  const third = await f.manager.start({ ownerId: "U_OTHER", channelId: "C_WORK", client: f.client });
  await f.manager.endAll("shutdown");
  assert.equal(f.manager.get(third.id), null); assert.equal(f.manager.size(), 0);
});

test("the call memory line goes to the caller's own DM folder only", async () => {
  const { createCallManager: make } = await import("../src/gateway/voice/calls.js");
  void make;
  const path = await import("node:path"), fs = await import("node:fs");
  const { effectiveWorkDir } = await import("../src/gateway/folders.js");
  await upsertChannelEntry("D_MINE", { name: "dm", type: "im", isDM: true });
  const dm = await getChannelEntry("D_MINE");
  await saveChannelMeta(dm.slug, { isDM: true, dmUserId: "U_MINE", memory: true });
  await upsertChannelEntry("D_OTHER", { name: "dm", type: "im", isDM: true });
  await saveChannelMeta((await getChannelEntry("D_OTHER")).slug, { isDM: true, dmUserId: "U_OTHER", memory: true });
  const { getChannelMeta } = await import("../src/config/store.js");
  const cwd = effectiveWorkDir(dm.slug, await getChannelMeta(dm.slug));
  fs.mkdirSync(cwd, { recursive: true });
  await channel();
  const f = fixture({ saveMemory: undefined });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  FakeSession.instances[0].live();
  await f.manager.end(call.id, "U_MINE");
  const memory = fs.readFileSync(path.join(cwd, "MEMORY.md"), "utf8");
  assert.match(memory, /Voice call on \d{4}-\d{2}-\d{2} \(1 min\): worked in #c_work/);
  assert.equal(fs.existsSync(path.join(effectiveWorkDir((await getChannelEntry("D_OTHER")).slug, {}), "MEMORY.md")), false);
  assert.ok(f.logs.some(([name, data]) => name === "voice_call_ended" && data.memorySaved === true));
});

// ── Browser routes and the Slack button ─────────────────────────────────────────
async function webFixture(t, { manager } = {}) {
  let base;
  const started = [], audio = [], ended = [], listeners = new Map();
  const calls = manager || {
    available: () => true,
    start: async (args) => { started.push(args); return { id: "call-1", threadTs: args.threadTs || "100.000100", channelName: args.channelId ? "#c_work" : "", callerName: "Tiberiu", model: "gemini-3.8-live", bound: args.channelId ? { channelId: args.channelId, channelName: "#c_work", threadTs: args.threadTs || "100.000100", title: "" } : null }; },
    subscribe: (id, ownerId, listener) => { if (id !== "call-1" || ownerId !== "U_MINE") throw Object.assign(new Error("no"), { status: 404 }); listeners.set(id, listener); listener({ type: "state", status: "live", transcript: [], tasks: [], bound: null }); return () => listeners.delete(id); },
    audio: (id, ownerId, chunk) => { if (ownerId !== "U_MINE") throw Object.assign(new Error("no"), { status: 404 }); audio.push(chunk.length); return true; },
    end: async (id, ownerId, reason) => { ended.push([id, ownerId, reason]); listeners.get(id)?.({ type: "ended", reason }); return true; },
  };
  const client = { auth: { test: async () => ({ user_id: "B_GATEWAY" }) }, chat: { postEphemeral: async () => ({}), postMessage: async () => ({ ts: "1.1" }) },
    conversations: { replies: async () => ({ messages: [] }), members: async () => ({ members: ["U_MINE"] }) }, users: { info: async () => ({ user: { profile: { display_name: "Atlas" } } }) } };
  const app = express();
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "T_WORK", getBaseUrl: () => base, getBotIdentity: () => ({ userId: "B_GATEWAY", handle: "atlas" }), calls, voiceAvailable: () => true, pollMs: 20 }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { resetActivityStateForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = (url, init = {}) => fetch(base + url, { ...init, redirect: "manual" });
  const login = async (next = "") => {
    const launch = createActivityGrantUrl({ baseUrl: base, ownerId: "U_MINE", teamId: "T_WORK", next });
    const response = await request("/activity/exchange", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(launch).hash.slice(1) }) });
    assert.equal(response.status, 200);
    const { url } = await response.json(), cookie = response.headers.get("set-cookie").split(";")[0];
    const sessionBase = url.replace(/\?.*$/, "");
    const page = await request(sessionBase, { headers: { cookie } });
    const csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1];
    return { url, sessionBase, cookie, csrf, headers: { cookie, Origin: base, "X-CG-CSRF": csrf } };
  };
  return { base, client, request, login, started, audio, ended, listeners };
}

test("a launch may carry the call destination, and the dashboard serves the overlay, its worklet and the auto-open target", async (t) => {
  await channel();
  const f = await webFixture(t);
  assert.equal(activityCallPath("C_WORK", "100.000001"), "?call=C_WORK&thread=100.000001");
  assert.equal(activityCallPath("C_WORK"), "?call=C_WORK");
  assert.equal(activityCallPath("../etc", "1.1"), "");
  assert.equal(createActivityGrantUrl({ baseUrl: f.base, ownerId: "U_MINE", teamId: "T_WORK", next: "/settings" }), "", "only the call overlay may be a launch destination");
  assert.equal(createActivityGrantUrl({ baseUrl: f.base, ownerId: "U_MINE", teamId: "T_WORK", next: "https://evil.example/" }), "");
  const s = await f.login("?call=C_WORK&thread=100.000001");
  assert.match(s.url, /^\/activity\/[A-Za-z0-9_-]{16}\?call=C_WORK&thread=100\.000001$/);
  const page = await f.request(s.url, { headers: { cookie: s.cookie } });
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+' 'self'/, "the dashboard admits the same-origin AudioWorklet module");
  const html = await page.text();
  assert.match(html, /id="call-overlay"/); assert.match(html, /id="call-agent"/); assert.match(html, /"voiceCalls":true/);
  assert.match(html, /"callTarget":\{"channelId":"C_WORK","threadTs":"100.000001"\}/);
  assert.match(html, /"callAgent":"Atlas"/);
  assert.match(html, /registerProcessor|callOverlayBrowser|data-call="start"/);
  const plain = await (await f.request(s.sessionBase, { headers: { cookie: s.cookie } })).text();
  assert.match(plain, /"callTarget":null/);
  assert.match(await (await f.request(`${s.sessionBase}?call=bad!`, { headers: { cookie: s.cookie } })).text(), /"callTarget":null/, "a malformed target is ignored, never echoed");
  const settings = await f.request(`${s.sessionBase}/settings`, { headers: { cookie: s.cookie } });
  assert.match(settings.headers.get("content-security-policy"), /script-src 'nonce-[A-Za-z0-9_-]+'; /, "only the Activity view carries the worklet allowance");
  assert.doesNotMatch(await settings.text(), /id="call-overlay"/);
  const worklet = await f.request(CALL_WORKLET_PATH);
  assert.equal(worklet.status, 200); assert.match(worklet.headers.get("content-type"), /javascript/);
  assert.match(await worklet.text(), /registerProcessor\("cg-capture"/);
  // Older standalone-page links land on the dashboard with the overlay.
  const legacy = await f.request(`${s.sessionBase}/call?channel=C_WORK&thread=100.000001`, { headers: { cookie: s.cookie } });
  assert.equal(legacy.status, 303); assert.equal(legacy.headers.get("location"), `${s.sessionBase}?call=C_WORK&thread=100.000001`);
  assert.equal((await f.request(`${s.sessionBase}/call?channel=bad!`, { headers: { cookie: s.cookie } })).status, 400);
  assert.equal((await f.request(`${s.sessionBase}/call?channel=C_WORK`)).status, 401, "no session, no redirect");
});

test("the call routes start (bound or not), stream, relay audio and end a call for the session owner only", async (t) => {
  await channel();
  const f = await webFixture(t);
  const s = await f.login();
  const noCsrf = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_WORK" }) });
  assert.equal(noCsrf.status, 403);
  const bad = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "nope!" }) });
  assert.equal(bad.status, 400);
  const orphan = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ threadTs: "1.1" }) });
  assert.equal(orphan.status, 400, "a thread without its conversation is malformed");
  const unbound = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unbound.status, 200);
  assert.equal((await unbound.json()).bound, null);
  assert.equal(f.started[0].channelId, ""); assert.equal(f.started[0].threadTs, "");
  const start = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001" }) });
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.equal(started.id, "call-1"); assert.deepEqual(started.bound, { channelId: "C_WORK", channelName: "#c_work", threadTs: "100.000001", title: "" });
  assert.equal(f.started[1].ownerId, "U_MINE"); assert.equal(f.started[1].teamId, "T_WORK"); assert.equal(f.started[1].botUserId, "B_GATEWAY");
  const events = await f.request(`${s.sessionBase}/call/call-1/events`, { headers: { cookie: s.cookie } });
  assert.equal(events.status, 200); assert.match(events.headers.get("content-type"), /text\/event-stream/);
  const reader = events.body.getReader(), decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"type":"state"')) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  assert.match(text, /data: \{"type":"state","status":"live"/);
  const pcm = Buffer.alloc(3200, 7);
  const audio = await f.request(`${s.sessionBase}/call/call-1/audio`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/octet-stream" }, body: pcm });
  assert.deepEqual(await audio.json(), { ok: true, accepted: true });
  assert.deepEqual(f.audio, [3200]);
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/audio`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/octet-stream" } })).status, 400);
  assert.equal((await f.request(`${s.sessionBase}/call/call-9/events`, { headers: { cookie: s.cookie } })).status, 404);
  const end = await f.request(`${s.sessionBase}/call/call-1/end?csrf=${s.csrf}`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } });
  assert.deepEqual(await end.json(), { ok: true });
  assert.deepEqual(f.ended, [["call-1", "U_MINE", "the caller hung up"]]);
  while (!text.includes('"type":"ended"')) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  assert.match(text, /"type":"ended","reason":"the caller hung up"/);
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/end`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } })).status, 403, "hang-up needs the CSRF token");
});

test("the reply menu grows a Call button only while voice calls are configured, and its click mints a private launch to the overlay", async (t) => {
  await channel();
  assert.deepEqual(menuButtons({ channel: "C_WORK", threadTs: "1.2", authorId: "U_MINE" }).map((b) => b.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings", "📊 Dashboard"]);
  saveSettings({ voiceCallsEnabled: true, geminiApiKey: "AIzaTestKey_0123456789abc" });
  t.after(() => saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" }));
  const buttons = menuButtons({ channel: "C_WORK", threadTs: "100.000002", authorId: "U_OTHER" });
  assert.deepEqual(buttons.map((b) => b.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings", "📊 Dashboard", "📞 Call"]);
  const button = buttons.at(-1);
  assert.equal(button.action_id, REPLY_CALL_ACTION_ID);
  assert.deepEqual(JSON.parse(button.value), { o: "open", c: "C_WORK", t: "100.000002", u: "U_OTHER" });
  const f = await webFixture(t);
  const sent = [];
  f.client.chat.postEphemeral = async (payload) => { sent.push(payload); };
  f.client.chat.postMessage = async () => assert.fail("a launch credential must never be public");
  const click = (user, overrides = {}) => handleReplyCallAction({ ack: async () => {}, client: f.client,
    body: { user: { id: user }, channel: { id: "C_WORK" }, team: { id: "T_WORK" } }, action: button }, { teamId: "T_WORK", baseUrl: f.base, ...overrides });
  await click("U_MINE");
  const post = sent.at(-1);
  assert.equal(post.user, "U_MINE"); assert.equal(post.thread_ts, "100.000002");
  const url = post.blocks[1].elements[0].url;
  assert.match(url, /\/activity\/open#[A-Za-z0-9_-]{43}$/);
  const response = await f.request("/activity/exchange", { method: "POST", headers: { Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^\/activity\/[A-Za-z0-9_-]{16}\?call=C_WORK&thread=100\.000002$/);
  await click("U_NOPE");
  assert.match(sent.at(-1).text, /not authorized/); assert.equal(sent.at(-1).blocks, undefined);
  await click("U_MINE", { available: () => false });
  assert.match(sent.at(-1).text, /not enabled/);
  await click("U_MINE", { baseUrl: "" });
  assert.match(sent.at(-1).text, /Public URL/);
  await handleReplyCallAction({ ack: async () => {}, client: f.client, body: { user: { id: "U_MINE" }, channel: { id: "C_ELSE" }, team: { id: "T_WORK" } }, action: button }, { teamId: "T_WORK", baseUrl: f.base });
  assert.match(sent.at(-1).text, /unavailable/);
});
