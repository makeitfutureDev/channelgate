import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
import { invalidateConversationMembers } from "../src/slack/members.js";
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
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "usage", "events", "thread_overrides", "followup_done"]) getDb().exec(`DELETE FROM ${table}`);
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

test("a call without a thread binds at the channel's top level and posts nothing, with a thread announces itself there and reads the context, and the voice gets the caller's recent conversations", async () => {
  await channel();
  const f = fixture();
  const fresh = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client, teamId: "T_WORK" });
  assert.equal(fresh.threadTs, "");
  assert.equal(f.posted.length, 0, "no placeholder root: the first task becomes the visible channel message");
  assert.equal(fresh.channelName, "#c_work"); assert.equal(fresh.callerName, "Tiberiu"); assert.equal(fresh.model, "gemini-3.8-live");
  assert.deepEqual(fresh.bound, { channelId: "C_WORK", channelName: "#c_work", threadTs: "", title: "", topLevel: true });
  const session = FakeSession.instances[0];
  assert.equal(session.options.apiKey, "AIzaTestKey_0123456789abc");
  assert.deepEqual(session.options.tools, TOOL_DECLARATIONS);
  assert.match(session.options.systemInstruction, /voice connection between Tiberiu and/);
  assert.match(session.options.systemInstruction, /currently in the Slack conversation #c_work, at the channel's top level/);
  assert.doesNotMatch(session.options.systemInstruction, /new and empty/);
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
  assert.match(second.options.systemInstruction, /only knowledge of it; it may not be complete — use read_thread for more/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x", isAdmin: true }), /organization admin/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x" }), /offer to dispatch a search.*never guess/i);
  assert.match(buildSystemInstruction({ callerName: "A" }), /not in any conversation yet/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x" }), /new and empty/, "a thread without readable messages is said to be empty");
  // The relay contract: the voice is the line between the caller and the agent, not the agent.
  const relay = buildSystemInstruction({ callerName: "A", channelName: "#x", agentName: "Atlas" });
  assert.match(relay, /You are NOT that agent and you do not have its knowledge, files, tools or memory/);
  assert.match(relay, /Assume nothing\. You know exactly three things/);
  assert.match(relay, /not in a message you have read, do not answer from your own knowledge: dispatch the question to the channel agent with run_task/);
  assert.match(relay, /call read_thread with a larger limit first, then run_task/);
  assert.match(relay, /Every action and every question for the agent goes through run_task/);
  assert.match(relay, /never announce an outcome before the \[gateway\] message brings it/);
  assert.match(relay, /Relay it for the caller in one or two spoken sentences without adding anything of your own/);
  assert.match(TOOL_DECLARATIONS.find((t) => t.name === "run_task").description, /only source of truth.*every question whose answer is not literally in a message you have read/);
  assert.match(TOOL_DECLARATIONS.find((t) => t.name === "read_thread").description, /only report what the messages literally say/);
  await f.manager.end(bound.id, "U_MINE");
});

test("at a channel's top level the first spoken task is posted as a new channel message whose thread the call follows", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client, teamId: "T_WORK" });
  const session = FakeSession.instances[0];
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  session.live();
  session.emit("input_transcript", { text: "Please build the export" });
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Build the export and run the tests" } });
  session.emit("tool_call", { id: "c2", name: "run_task", args: { request: "Then deploy it" } });
  // Wait for both turns rather than a fixed 80 ms: on a loaded host the second can start later.
  for (const deadline = Date.now() + 10_000; (f.runs.length < 2 || f.delivered.length < 2) && Date.now() < deadline;) await tick(10);
  // One root message carrying the request itself; the second request lands inside its thread.
  const roots = f.posted.filter((p) => p.conversationId === "C_WORK" && !p.threadKey);
  assert.equal(roots.length, 1);
  assert.match(roots[0].text, /^🎙️ \*Tiberiu \(voice call\):\* Build the export and run the tests$/);
  assert.doesNotMatch(f.posted.map((p) => p.text).join("\n"), /Voice call\* — Tiberiu is talking/, "no placeholder root is ever posted");
  const rootTs = "100.000100";
  const inThread = f.posted.filter((p) => p.threadKey === rootTs && /voice call\)/.test(p.text));
  assert.equal(inThread.length, 1); assert.match(inThread[0].text, /Then deploy it/);
  assert.deepEqual(f.runs.map((r) => r.threadKey), [rootTs, rootTs]);
  assert.equal(f.runs[0].authorId, "U_MINE"); assert.equal(f.runs[0].origin, VOICE_CALL_ORIGIN);
  assert.equal(f.delivered.length, 2); assert.equal(f.delivered[0].threadKey, rootTs);
  const started = session.responses.find((r) => r.id === "c1");
  assert.equal(started.response.task, 1); assert.match(started.response.note, /Posted as a new message in the channel; the call now follows that thread/);
  assert.equal(session.responses.find((r) => r.id === "c2").response.note, undefined);
  const live = f.manager.get(call.id);
  assert.equal(live.bound.threadTs, rootTs); assert.equal(live.bound.title, "Build the export and run the tests");
  assert.deepEqual(seen.filter((e) => e.type === "bound").at(-1), { type: "bound", channelId: "C_WORK", channelName: "#c_work", threadTs: rootTs, title: "Build the export and run the tests", topLevel: false });
  assert.ok(f.logs.some(([name, data]) => name === "voice_call_bound" && data.topLevel === true && data.threadTs === ""));
  assert.ok(f.logs.some(([name, data]) => name === "voice_call_bound" && data.opened === true && data.threadTs === rootTs));
  // Hang-up: one visit, so the summary lands in the task's thread and the receipt names it once.
  await f.manager.end(call.id, "U_MINE", "the caller hung up");
  const summary = f.posted.at(-1);
  assert.equal(summary.threadKey, rootTs); assert.match(summary.text, /Voice call ended\* — 1 min · 2 tasks/);
  assert.match(summary.text, /\*Tasks here:\* 1\. Build the export and run the tests — done · 2\. Then deploy it — done/);
  assert.doesNotMatch(summary.text, /Also visited/);
  const { readCallHistory } = await import("../src/gateway/voice/history.js");
  const saved = readCallHistory(call.id, "U_MINE", "T_WORK");
  assert.equal(saved.threads.length, 1); assert.equal(saved.threads[0].threadTs, rootTs); assert.equal(saved.threads[0].title, "Build the export and run the tests");
  assert.match(f.memories[0].text, /worked in #c_work "Build the export and run the tests"; tasks: "Build the export and run the tests" \(done\), "Then deploy it" \(done\)$/);
});

test("the in-flight task cap is per conversation: a fourth task in one thread is refused while another thread starts at once", async () => {
  await channel(); await channel("C_SALES");
  let release; const held = new Promise((resolve) => { release = resolve; });
  const started = [];
  const f = fixture({ runner: async (args) => { started.push(args); await held; return { content: "ok", engine: "claude" }; } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  for (const id of ["a", "b", "c", "d"]) { session.emit("tool_call", { id, name: "run_task", args: { request: `Task ${id}` } }); await tick(10); }
  assert.equal(session.responses.find((r) => r.id === "c").response.status, "started");
  assert.match(session.responses.find((r) => r.id === "d").response.error, /Three tasks are already in progress in this conversation.*switch to another conversation/);
  session.emit("tool_call", { id: "s", name: "switch_conversation", args: { id: "C_SALES:44.000001" } });
  await tick(20);
  session.emit("tool_call", { id: "e", name: "run_task", args: { request: "Task e" } });
  await tick(20);
  assert.equal(session.responses.find((r) => r.id === "e").response.status, "started", "another conversation is not held back by the first one's backlog");
  assert.equal(started.length, 2, "one turn per thread runs; the rest of #c_work's tasks wait on its own queue");
  assert.deepEqual(started.map((r) => r.threadKey).sort(), ["44.000001", "55.000001"]);
  release(); await tick(60);
  await f.manager.end(call.id, "U_MINE");
});

test("a top-level segment with nothing said is left silently, one with speech is posted into the channel", async () => {
  await channel(); await channel("C_SALES");
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "t1", name: "switch_conversation", args: { channel: "c_sales" } });
  await tick(20);
  const moved = session.responses.at(-1).response;
  assert.equal(moved.topLevel, true); assert.match(moved.note, /top level of the channel: the next run_task is posted as a new channel message/);
  assert.equal(f.posted.length, 0, "leaving an empty top-level binding posts nothing");
  session.emit("input_transcript", { text: "Just thinking aloud here" }); session.emit("turn_complete");
  await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_WORK" });
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].conversationId, "C_SALES"); assert.equal(f.posted[0].threadKey, "");
  assert.match(f.posted[0].text, /Voice call moved on[\s\S]*Just thinking aloud here/);
  assert.match(session.texts.at(-1), /now at the top level of #c_work: the next run_task is posted as a new channel message[\s\S]*You have read no messages here/);
  await f.manager.end(call.id, "U_MINE", "the caller hung up");
  const summary = f.posted.at(-1);
  assert.equal(summary.conversationId, "C_WORK"); assert.equal(summary.threadKey, "", "the end summary is always posted, at the top level when no thread was opened");
  assert.match(summary.text, /Voice call ended\* — 1 min · 0 tasks[\s\S]*\*Also visited:\* #c_sales/);
});

test("a hidden phone suspends the call for a grace window that audio or a new event stream cancels", async () => {
  await channel();
  const f = fixture({ suspendGraceMs: 40 });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.throws(() => f.manager.suspend(call.id, "U_OTHER"), (e) => e.status === 404);
  assert.equal(f.manager.suspend(call.id, "U_MINE"), true);
  assert.equal(f.manager.suspend(call.id, "U_MINE"), true, "a repeated beacon does not shorten the window");
  assert.deepEqual(seen.at(-1), { type: "suspended", graceMs: 40 });
  await tick(15);
  f.manager.audio(call.id, "U_MINE", Buffer.from([1, 2]));
  assert.equal(seen.at(-1).type, "resumed");
  await tick(60);
  assert.ok(f.manager.get(call.id), "resumed audio keeps the call alive past the grace window");
  f.manager.suspend(call.id, "U_MINE", 30);
  f.manager.subscribe(call.id, "U_MINE", () => {});
  await tick(50);
  assert.ok(f.manager.get(call.id), "a reconnecting event stream also cancels the suspension");
  f.manager.suspend(call.id, "U_MINE", 20);
  await tick(50);
  assert.equal(f.manager.get(call.id), null);
  assert.equal(seen.at(-1).type, "ended"); assert.match(seen.at(-1).reason, /device went away/);
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
  assert.deepEqual(seen.at(-1), { type: "bound", channelId: "C_SALES", channelName: "#c_sales", threadTs: "44.000001", title: "Pipeline review for Q4", topLevel: false });
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
  assert.equal(moved.switched, true); assert.equal(moved.conversation, "#c_work"); assert.equal(moved.topLevel, true); assert.deepEqual(moved.recentMessages, []);
  const segment = f.posted.find((p) => /Voice call moved on/.test(p.text));
  assert.equal(segment.threadKey, "44.000001");
  assert.match(segment.text, /moved on\* — 1 min here · 1 task/);
  assert.match(segment.text, /\*Tasks here:\* 1\. Summarize the pipeline — done/);
  assert.match(segment.text, /> \*Tiberiu:\* Open the pipeline review\n> \*Agent:\* Started the summary\./);
  assert.equal(f.posted.filter((p) => p.conversationId === "C_WORK").length, 0, "a top-level binding posts nothing until a task or the summary");
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
  assert.equal(summary.conversationId, "C_WORK"); assert.equal(summary.threadKey, "", "no thread was opened in #c_work, so the summary is a channel message");
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
  const listed = session.responses.at(-1).response.tasks;
  assert.equal(typeof listed[0].seconds, "number", "check_tasks says how long each task has run");
  assert.deepEqual(listed.map(({ seconds: _seconds, ...rest }) => rest), [{ task: 1, status: "done", conversation: "#c_work", request: "Build the voice page and run the tests", summary: "Done: I built it and ran the tests." }]);
  // The agent got the request as spoken plus the voice note: mishearings, the spoken-answer shape.
  assert.match(f.runs[0].text, /^Build the voice page and run the tests\n\n\[Voice call note/);
  assert.match(f.runs[0].text, /spoken by Tiberiu on a live voice call/);
  assert.match(f.runs[0].text, /start with one plain sentence that states the outcome/);
  assert.equal(f.runs[0].overrides, undefined, "normal task speed keeps the thread's own effort");
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

test("a task finishing after the call moved elsewhere is announced without its result, which check_tasks still returns", async () => {
  await channel(); await channel("C_SALES");
  const f = fixture({ runner: async (args) => { await tick(30); return { content: "Pipeline summarized: revenue up 12%.", engine: "claude" }; } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_SALES", threadTs: "44.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Summarize" } });
  await tick(5);
  session.emit("tool_call", { id: "c2", name: "switch_conversation", args: { id: "C_WORK:55.000001" } });
  await tick(60);
  const notice = session.texts.at(-1);
  assert.match(notice, /^\[gateway\] Task 1 \("Summarize"\) in #c_sales has finished, but the call is no longer in that conversation\. Do NOT read its result now/);
  assert.doesNotMatch(notice, /revenue up 12%/, "the content stays out of the announcement");
  session.emit("tool_call", { id: "c3", name: "check_tasks", args: {} });
  await tick();
  assert.match(session.responses.at(-1).response.tasks[0].summary, /revenue up 12%/);
  assert.match(session.options.systemInstruction, /a conversation the call has LEFT, do not read the result/);
  // Back in the thread the task ran in, a result is relayed in full.
  session.emit("tool_call", { id: "c4", name: "switch_conversation", args: { id: "C_SALES:44.000001" } });
  await tick(20);
  session.emit("tool_call", { id: "c5", name: "run_task", args: { request: "Summarize again" } });
  await tick(60);
  assert.match(session.texts.at(-1), /^\[gateway\] Task 2 finished\. Result: Pipeline summarized: revenue up 12%/);
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
  const started = [], audio = [], ended = [], suspended = [], listeners = new Map();
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
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "T_WORK", getBaseUrl: () => base, getBotIdentity: () => ({ userId: "B_GATEWAY", handle: "atlas" }), calls, voiceAvailable: () => true, pollMs: 20,
    snapshot: async () => ({ rows: ROWS, total: ROWS.length }) }));
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
  return { base, client, request, login, started, audio, ended, suspended, listeners, calls };
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
  // Phone behaviour kept in the overlay: the screen wake lock and a pagehide beacon that only
  // suspends. The audio path is the plain AudioContext player (fixed-rate contexts, 20 ms lead,
  // straight to the destination): the media-element and jitter-buffer variants were rolled back.
  assert.match(html, /wakeLock\.request\("screen"\)/);
  assert.match(html, /\/end\?csrf=" \+ encodeURIComponent\(csrf\) \+ "&grace=1"/);
  assert.match(html, /new AudioContext\(\{ sampleRate: outputRate \}\)/);
  assert.match(html, /Math\.max\(player\.currentTime \+ 0\.02, playhead\)/);
  assert.match(html, /source\.connect\(player\.destination\)/);
  assert.doesNotMatch(html, /createMediaStreamDestination|keepalive|JITTER_S|watchAudioRoute|devicechange|mediaSession/);
  assert.doesNotMatch(csp, /media-src/);
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
  // The pagehide beacon only suspends when the manager can; this fixture cannot, so it hangs up.
  f.calls.suspend = (id, ownerId) => { f.suspended.push([id, ownerId]); return true; };
  const grace = await f.request(`${s.sessionBase}/call/call-1/end?csrf=${s.csrf}&grace=1`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } });
  assert.deepEqual(await grace.json(), { ok: true });
  assert.deepEqual(f.suspended, [["call-1", "U_MINE"]]); assert.deepEqual(f.ended, []);
  delete f.calls.suspend;
  assert.deepEqual(await (await f.request(`${s.sessionBase}/call/call-1/end?csrf=${s.csrf}&grace=1`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } })).json(), { ok: true });
  assert.deepEqual(f.ended, [["call-1", "U_MINE", "the caller hung up"]]);
  f.ended.length = 0;
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

test("dashboard switches keep the voice session and reauthorize the caller and destination", async (t) => {
  await channel(); await channel("C_SALES"); await channel("C_PRIVATE", { access: "admins" });
  const f = fixture(); t.after(() => f.manager.endAll());
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  const session = FakeSession.instances[0];
  await assert.rejects(f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "44.000001" }), { status: 409 });
  session.live(); session.emit("input_transcript", { text: "First conversation" });
  await assert.rejects(f.manager.switchConversation(call.id, "U_NOPE", { channelId: "C_SALES", threadTs: "44.000001" }), { status: 404 });
  await assert.rejects(f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_PRIVATE", threadTs: "1.1" }), { status: 403 });
  assert.equal(f.manager.get(call.id).bound.channelId, "C_WORK");
  const switched = await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "44.000001" });
  assert.equal(switched.id, call.id); assert.equal(switched.bound.title, "Pipeline review for Q4");
  assert.equal(session.closed, false); assert.equal(FakeSession.instances.length, 1);
  assert.match(session.texts.at(-1), /now in #c_sales, thread 44.000001/);
  assert.match(session.texts.at(-1), /Earlier message/);
  const segment = f.posted.find(p => /Voice call moved on/.test(p.text));
  assert.equal(segment.threadKey, "55.000001"); assert.match(segment.text, /First conversation/);
  const count = f.posted.length;
  assert.equal((await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "44.000001" })).switched, false);
  assert.equal(f.posted.length, count);
  session.emit("tool_call", { id: "task", name: "run_task", args: { request: "Reply MOVED_OK" } });
  await tick(40);
  assert.equal(f.runs[0].channelId, "C_SALES"); assert.equal(f.runs[0].threadKey, "44.000001");
  assert.equal(f.runs[0].authorId, "U_MINE");
  await setUser("U_MINE", { approved: false });
  await assert.rejects(f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_WORK", threadTs: "55.000001" }), { status: 403 });
});

test("the dashboard switch route requires session, CSRF, owner and an authorized destination", async (t) => {
  await channel(); await channel("C_SALES"); await channel("C_PRIVATE", { access: "admins" });
  const managerFixture = fixture(); t.after(() => managerFixture.manager.endAll());
  const f = await webFixture(t, { manager: managerFixture.manager });
  const s = await f.login();
  const call = await managerFixture.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  FakeSession.instances[0].live();
  const path = `${s.sessionBase}/call/${call.id}/switch`;
  const options = { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_SALES", threadTs: "44.000001" }) };
  assert.equal((await f.request(path, { ...options, headers: { Origin: f.base, "Content-Type": "application/json" } })).status, 401);
  assert.equal((await f.request(path, { ...options, headers: { cookie: s.cookie, Origin: f.base, "Content-Type": "application/json" } })).status, 403);
  for (const body of [{}, { channelId: "bad!" }, { channelId: "C_SALES", threadTs: "bad" }]) assert.equal((await f.request(path, { ...options, body: JSON.stringify(body) })).status, 400);
  assert.equal((await f.request(`${s.sessionBase}/call/foreign/switch`, options)).status, 404);
  assert.equal((await f.request(path, { ...options, body: JSON.stringify({ channelId: "C_PRIVATE", threadTs: "1.1" }) })).status, 403);
  const moved = await f.request(path, options);
  assert.equal(moved.status, 200); assert.equal((await moved.json()).bound.threadTs, "44.000001");
});

test("Activity keeps a call in a docked side panel the header Call button shows and hides, switches it from a row and keeps transcript and controls", { skip: !process.env.CG_BROWSER_MODULE, timeout: 40_000 }, async (t) => {
  await channel(); await channel("C_SALES");
  const managerFixture = fixture(); t.after(() => managerFixture.manager.endAll());
  const f = await webFixture(t, { manager: managerFixture.manager });
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(createActivityGrantUrl({ baseUrl: f.base, ownerId: "U_MINE", teamId: "T_WORK" }));
  const panel = page.locator("#call-overlay"), top = page.locator("#call-agent"), hide = page.getByRole("button", { name: "Hide call panel", exact: true });
  assert.equal(await top.textContent(), "📞 Call");
  await page.locator('a.call-link[data-channel-id="C_WORK"][data-thread-ts="55.000001"]').click();
  // A docked panel, never a modal: no dialog role, no backdrop, and the dashboard narrows beside it.
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  assert.equal(await top.getAttribute("aria-pressed"), "true");
  const docked = await page.evaluate(() => ({ pad: parseFloat(globalThis.getComputedStyle(globalThis.document.body).paddingRight), width: globalThis.document.querySelector("#call-overlay").getBoundingClientRect().width }));
  assert.ok(docked.pad > 300 && Math.abs(docked.pad - docked.width) < 2, JSON.stringify(docked));
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await page.getByRole("button", { name: "Hang up", exact: true }).waitFor();
  const session = FakeSession.instances[0]; session.live();
  session.emit("input_transcript", { text: "Keep this transcript" });
  await page.getByText("Keep this transcript", { exact: true }).waitFor();
  // A burst of 60 reply chunks (about 1.2 s of 24 kHz PCM arriving at once) and an interruption
  // must play through without a page error.
  for (let i = 0; i < 60; i++) session.emit("audio", Buffer.alloc(960, i % 2 ? 0x10 : 0xf0));
  session.emit("interrupted");
  for (let i = 0; i < 5; i++) session.emit("audio", Buffer.alloc(960, 0x20));
  await page.waitForTimeout(300);
  await page.waitForFunction(() => globalThis.document.querySelector("#call-agent").dataset.live === "");
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await hide.click();
  assert.equal(await panel.isVisible(), false); assert.equal(session.closed, false, "hiding the panel keeps the call");
  assert.match(await top.getAttribute("aria-label"), /In a call \(muted\).*show the transcript/);
  assert.match(await top.textContent(), /🔇 In call \d\d:\d\d/);
  assert.equal(await page.evaluate(() => parseFloat(globalThis.getComputedStyle(globalThis.document.body).paddingRight)), 0);
  // The dashboard stays usable, and a row's call action switches the hidden call in place.
  await page.locator("#search").fill("Pipeline");
  await page.locator('a.call-link[data-channel-id="C_SALES"]').click();
  await page.waitForFunction(() => globalThis.document.querySelector('[data-call="binding"]').textContent.includes("Pipeline review"));
  assert.equal(await panel.isVisible(), false);
  assert.equal(FakeSession.instances.length, 1); assert.equal(session.closed, false);
  assert.match(session.texts.at(-1), /now in #c_sales/);
  await page.waitForFunction(() => /In call (?!00:00)/.test(globalThis.document.querySelector("#call-agent").textContent));
  await top.click();
  assert.equal(await panel.isVisible(), true); assert.equal(await top.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByText("Keep this transcript", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Unmute", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Hang up", exact: true }).focus(); await page.keyboard.press("Escape");
  assert.equal(await panel.isVisible(), false);
  // A denied switch reopens the panel with the error and retains the current call.
  await page.route("**/call/*/switch", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Destination access denied" }) }));
  await page.locator("#search").fill("");
  await page.locator('a.call-link[data-channel-id="C_WORK"][data-thread-ts="55.000001"]').click();
  await page.getByText("Destination access denied", { exact: true }).waitFor();
  assert.equal(await panel.isVisible(), true);
  assert.match(await page.locator('[data-call="binding"]').textContent(), /Pipeline review/);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 850 });
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5 && box.height <= 850, JSON.stringify(box));
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    await hide.click(); assert.equal(await top.isVisible(), true);
    await top.click(); assert.equal(await panel.isVisible(), true);
  }
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).waitFor();
  assert.equal(await top.textContent(), "📞 Call"); assert.equal(await top.getAttribute("data-live"), null);
  assert.equal(session.closed, true);
  assert.deepEqual(errors, []);
});

test("queued switches finish in order and a failed join preserves the current binding", async (t) => {
  await channel(); await channel("C_SALES");
  const posted = [];
  let release, entered;
  const joined = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ post: async (_client, args) => {
    if (args.threadKey === "44.000001" && /joined/.test(args.text)) { entered(); await held; }
    if (args.threadKey === "99.000001") throw new Error("Join failed");
    posted.push(args); return { messageId: "1.1" };
  } });
  t.after(() => f.manager.endAll());
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  FakeSession.instances[0].live();
  const first = f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "44.000001" });
  await joined;
  const second = f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_WORK", threadTs: "33.000001" });
  assert.equal(f.manager.get(call.id).bound.threadTs, "55.000001");
  release(); await Promise.all([first, second]);
  assert.equal(f.manager.get(call.id).bound.threadTs, "33.000001");
  assert.deepEqual(posted.filter(p => /Voice call moved on/.test(p.text)).map(p => p.threadKey), ["55.000001", "44.000001"]);
  await assert.rejects(f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "99.000001" }), /Join failed/);
  assert.equal(f.manager.get(call.id).bound.threadTs, "33.000001");
  await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_WORK", threadTs: "55.000001" });
  assert.equal(f.manager.get(call.id).bound.threadTs, "55.000001");
});

test("the caller's voice preferences and recent calls shape the prompt and the turn-taking", async () => {
  await channel();
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu", voicePreferences: { language: "Romanian", style: "thinking-partner", patience: "patient", instructions: "Call me Tibi.\nConfirm before production changes." } });
  const f = fixture({ loadHistory: async ({ ownerId }) => ownerId === "U_MINE" ? ["Voice call on 2026-11-13 (3 min): worked in #c_work \"Build the voice page\"", "Voice call on 2026-11-14 (1 min): worked in #c_sales"] : [] });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0];
  assert.equal(session.options.patience, "patient");
  const prompt = session.options.systemInstruction;
  assert.match(prompt, /uses you to think out loud\. Listen more than you talk/);
  assert.match(prompt, /Speak Romanian by default; if the caller switches language, follow them\./);
  assert.match(prompt, /The caller may pause mid-thought\. Wait for them to finish/);
  assert.match(prompt, /The caller's own instructions[^\n]*\nCall me Tibi\.\nConfirm before production changes\./);
  assert.match(prompt, /their recent calls[^\n]*\n- Voice call on 2026-11-13 \(3 min\): worked in #c_work "Build the voice page"\n- Voice call on 2026-11-14 \(1 min\): worked in #c_sales/);
  assert.doesNotMatch(prompt, /one to three sentences per reply/, "the brief style is replaced, not stacked");
  await f.manager.end(call.id, "U_MINE");
  // Defaults: brief, follow the caller's language, Gemini's own turn-taking, no history block.
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu", voicePreferences: {} });
  const plain = fixture();
  const second = await plain.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: plain.client });
  const defaults = FakeSession.instances.at(-1);
  assert.equal(defaults.options.patience, "normal");
  assert.match(defaults.options.systemInstruction, /one to three sentences per reply/);
  assert.match(defaults.options.systemInstruction, /Speak the language the caller uses\./);
  assert.doesNotMatch(defaults.options.systemInstruction, /own instructions|recent calls|pause mid-thought/);
  await plain.manager.end(second.id, "U_MINE");
  // The recent-call history comes from the caller's own DM folder and nobody else's.
  const path = await import("node:path"), fs = await import("node:fs");
  const { effectiveWorkDir } = await import("../src/gateway/folders.js");
  const { getChannelMeta } = await import("../src/config/store.js");
  await upsertChannelEntry("D_MINE", { name: "dm", type: "im", isDM: true });
  const dm = await getChannelEntry("D_MINE");
  await saveChannelMeta(dm.slug, { isDM: true, dmUserId: "U_MINE", memory: true });
  const cwd = effectiveWorkDir(dm.slug, await getChannelMeta(dm.slug));
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "MEMORY.md"), "# Memory\n\n## Project state\n- Something else entirely\n- Voice call on 2026-11-10 (2 min): worked in #old\n- Voice call on 2026-11-11 (2 min): worked in #a\n- Voice call on 2026-11-12 (2 min): worked in #b\n- Voice call on 2026-11-13 (2 min): worked in #c\n- Voice call on 2026-11-14 (2 min): worked in #d\n- Voice call on 2026-11-15 (2 min): worked in #e\n");
  const real = fixture({ loadHistory: undefined });
  const third = await real.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: real.client });
  const withHistory = FakeSession.instances.at(-1).options.systemInstruction;
  assert.match(withHistory, /- Voice call on 2026-11-11 \(2 min\): worked in #a\n[\s\S]*#e/);
  assert.doesNotMatch(withHistory, /#old|Something else entirely/, "at most the last five call lines, nothing else from memory");
  await real.manager.end(third.id, "U_MINE");
  await setUser("U_OTHER", { approved: true, name: "Other" });
  const other = fixture({ loadHistory: undefined });
  const fourth = await other.manager.start({ ownerId: "U_OTHER", channelId: "C_WORK", client: other.client });
  assert.doesNotMatch(FakeSession.instances.at(-1).options.systemInstruction, /Voice call on/, "another person's DM memory is never read");
  await other.manager.end(fourth.id, "U_OTHER");
});

test("voice conversation lists use readable DM labels without channel prefixes", async () => {
  const f = fixture({ snapshot: async () => ({ rows: [{ channel_id: "D12345678", thread_ts: "55.000001", title: "Private task", channelName: "Personal conversation with Alex Example", isDM: true, status: "idle", last_message_ms: 3000 }] }) });
  const started = await f.manager.start({ ownerId: "U_MINE", client: f.client });
  const session = FakeSession.instances[0];
  assert.match(session.options.systemInstruction, /Personal conversation with Alex Example/);
  assert.doesNotMatch(session.options.systemInstruction, /#Personal conversation/);
  assert.match(session.options.systemInstruction, /Never read conversation IDs aloud/);
  assert.equal(await f.manager.end(started.id, "U_MINE"), true);
});

test("completed calls persist caller-owned receipts with exact duration, voice cost and deduplicated segment posts", async () => {
  await channel(); await channel("C_SALES");
  let time = Date.now();
  const f = fixture({ now: () => time });
  const { readCallHistory, listCallHistory } = await import("../src/gateway/voice/history.js");
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", teamId: "T_WORK", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("input_transcript", { text: "Discuss the quarterly plan" });
  session.emit("usage", { delta: { audioIn: 1000, textIn: 100, audioOut: 500, textOut: 50 } });
  time += 25_000;
  await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_SALES", threadTs: "44.000001" });
  time += 35_000;
  await f.manager.switchConversation(call.id, "U_MINE", { channelId: "C_WORK", threadTs: "55.000001" });
  time += 15_250;
  await f.manager.end(call.id, "U_MINE", "the caller hung up");
  const saved = readCallHistory(call.id, "U_MINE", "T_WORK");
  assert.equal(saved.durationMs, 75_250); assert.equal(saved.costUSD, 0.0093);
  assert.match(saved.summary, /Discuss the quarterly plan/);
  assert.equal(saved.threads.length, 2);
  assert.equal(saved.threads[0].durationMs, 40_250); assert.equal(saved.threads[1].durationMs, 35_000);
  assert.equal(saved.threads[0].messageTs, `${f.posted.length}00.000100`);
  assert.equal(readCallHistory(call.id, "U_OTHER", "T_WORK"), null);
  assert.equal(readCallHistory(call.id, "U_MINE", "T_OTHER"), null);
  assert.ok(listCallHistory("U_MINE", "T_WORK").calls.some((row) => row.id === call.id));
  assert.equal(f.manager.get(call.id), null, "receipt survives disposal of the live call");
  assert.equal(await f.manager.end(call.id, "U_MINE"), false, "repeated hangup cannot duplicate a receipt");
});

test("hangup duration excludes slow accounting and a failed summary post still saves history", async () => {
  await channel();
  let time = Date.now();
  const f = fixture({ now: () => time, record: async () => { time += 9000; },
    post: async (_client, args) => { if (/Voice call ended/.test(args.text)) throw new Error("post unavailable"); return { messageId: "100.000002" }; } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", teamId: "T_WORK", client: f.client });
  time += 20_000;
  await f.manager.end(call.id, "U_MINE");
  const { readCallHistory } = await import("../src/gateway/voice/history.js");
  const saved = readCallHistory(call.id, "U_MINE", "T_WORK");
  assert.equal(saved.durationMs, 20_000); assert.equal(saved.threads[0].durationMs, 20_000);
  assert.equal(saved.threads[0].messageTs, "");
  assert.ok(f.logs.some(([event, data]) => event === "voice_call_error" && data.stage === "summary"));
});

async function doneFixture(t, { owner = "U_MINE", type = "channel", ...managerOverrides } = {}) {
  const { indexSlackThread } = await import("../src/gateway/slack-threads.js");
  const entry = await channel("C_WORK", { type });
  const root = { ts: "55.000001", user: owner, text: "Closeable thread" };
  indexSlackThread({ channelId: "C_WORK", slug: entry.slug, root, agentEngaged: true });
  const f = fixture(managerOverrides);
  f.client.conversations.replies = async () => ({ messages: [root] });
  f.client.conversations.members = async () => ({ members: ["U_MINE"] });
  f.client.auth = { test: async () => ({ user_id: "B_VOICE_DONE" }) };
  f.markers = [];
  f.client.reactions = { add: async (args) => { f.markers.push(args); return { ok: true }; }, remove: async () => ({ ok: true }) };
  f.call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: root.ts, client: f.client });
  t.after(() => f.manager.end(f.call.id, "U_MINE"));
  f.session = FakeSession.instances[0]; f.session.live();
  f.root = root; f.entry = entry;
  return f;
}
async function completionResponse(f, id, args = { id: "C_WORK:55.000001" }) {
  f.session.emit("tool_call", { id, name: "mark_thread_done", args });
  for (let i = 0; i < 100; i++) {
    const response = f.session.responses.find((r) => r.id === id);
    if (response) return response.response;
    await tick(5);
  }
  assert.fail("completion tool did not respond");
}

test("voice completion uses the caller's existing Done state and keeps the call open without an engine task", async (t) => {
  const { getSlackThread, setSlackThreadDone } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t);
  const result = await completionResponse(f, "done1", { id: "C_WORK:55.000001", userId: "U_NOPE" });
  assert.equal(result.done, true); assert.equal(result.markerPending, false);
  assert.equal(result.id, "C_WORK:55.000001"); assert.equal(result.title, f.root.text);
  assert.ok(getSlackThread("C_WORK", f.root.ts).done_ms > 0);
  assert.ok(getDb().prepare("SELECT 1 FROM followup_done WHERE user_id='U_MINE' AND thread_key=?").get(`C_WORK::${f.root.ts}`));
  assert.equal(f.markers[0].timestamp, f.root.ts); assert.equal(f.markers[0].name, "white_check_mark");
  assert.equal(f.runs.length, 0); assert.equal(f.manager.size(), 1);
  assert.equal(f.logs.find(([name]) => name === "voice_thread_done")[1].ownerId, "U_MINE");
  const stamp = getSlackThread("C_WORK", f.root.ts).done_ms;
  assert.equal((await completionResponse(f, "done2")).alreadyDone, true);
  assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, stamp, "already-done requests keep the saved watermark");
  setSlackThreadDone("C_WORK", f.root.ts, "U_MINE", false);
  f.session.responses = [];
  assert.equal((await completionResponse(f, "done1")).done, true, "redelivery returns the original receipt");
  assert.ok(getSlackThread("C_WORK", f.root.ts).done_ms < 0, "redelivery cannot re-close a reopened thread");
});

test("voice completion requires an exact current target and refuses another starter even for an admin", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t, { owner: "U_OTHER" });
  await setUser("U_MINE", { isAdmin: true });
  assert.match((await completionResponse(f, "foreign")).error, /starter/);
  for (const [id, target] of [["wrong", "C_OTHER:55.000001"], ["missing", undefined], ["malformed", 55]]) {
    assert.match((await completionResponse(f, id, { id: target })).error, /exact current thread/);
  }
  assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, 0);
  assert.equal(f.markers.length, 0);
  const top = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances.at(-1); session.live();
  const topFixture = { session };
  assert.match((await completionResponse(topFixture, "top", { id: "C_WORK:55.000001" })).error, /exact current thread/);
  await f.manager.end(top.id, "U_MINE");
});

test("voice completion rechecks authorization after Slack root reads", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t);
  f.client.conversations.replies = async () => {
    await setUser("U_MINE", { approved: false });
    return { messages: [f.root] };
  };
  assert.match((await completionResponse(f, "revoked")).error, /current conversation access/);
  assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, 0);
  assert.equal(f.markers.length, 0);
});

test("voice completion refuses mismatched roots and lost private membership", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t, { type: "group" });
  f.client.conversations.replies = async () => ({ messages: [{ ...f.root, user: "U_OTHER" }] });
  assert.match((await completionResponse(f, "root-changed")).error, /starter/);
  f.client.conversations.replies = async () => {
    f.client.conversations.members = async () => ({ members: [] });
    invalidateConversationMembers(); // Slack's member_left_channel event clears the cache
    return { messages: [f.root] };
  };
  assert.match((await completionResponse(f, "membership-lost")).error, /current conversation access/);
  assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, 0);
});

test("voice completion refuses a call that moved or ended while its root read awaited", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  for (const action of ["move", "end"]) {
    const f = await doneFixture(t);
    await channel("C_SALES");
    let release, reading;
    const started = new Promise((resolve) => { reading = resolve; });
    f.client.conversations.replies = async () => { reading(); await new Promise((resolve) => { release = resolve; }); return { messages: [f.root] }; };
    const pending = completionResponse(f, "await-" + action);
    await started;
    if (action === "move") await f.manager.switchConversation(f.call.id, "U_MINE", { channelId: "C_SALES" });
    else await f.manager.end(f.call.id, "U_MINE");
    release();
    assert.match((await pending).error, /moved or ended/);
    assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, 0);
    await f.manager.end(f.call.id, "U_MINE");
  }
});

test("voice completion reports durable Done with a pending Slack marker rather than losing the choice", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t);
  f.client.reactions.add = async () => { throw new Error("Slack unavailable"); };
  const result = await completionResponse(f, "marker-error");
  assert.equal(result.done, true); assert.equal(result.markerPending, true);
  assert.ok(getSlackThread("C_WORK", f.root.ts).completion_marker_retry_ms > 0);
});

test("voice briefing routes explicit completion to the direct tool and never infers acceptance from task success", () => {
  const prompt = buildSystemInstruction({ callerName: "Member", channelName: "#work", conversationId: "C_WORK:55.000001" });
  assert.match(prompt, /use mark_thread_done directly, not run_task/);
  assert.match(prompt, /Never infer completion from an agent saying its task finished/);
  assert.match(prompt, /Current conversation id for mark_thread_done: C_WORK:55\.000001/);
  assert.match(prompt, /Only say it is Done if the tool returns done:true/);
  assert.deepEqual(TOOL_DECLARATIONS.find((tool) => tool.name === "mark_thread_done").parameters.required, ["id"]);
});

test("a thread created during the voice call records caller ownership and can be completed directly", async (t) => {
  const { getSlackThread, slackThreadRootOwner } = await import("../src/gateway/slack-threads.js");
  await channel();
  const f = fixture();
  const botUserId = "B_VOICE_CREATED";
  f.client.auth = { test: async () => ({ user_id: botUserId }) };
  f.client.reactions = { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) };
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client, botUserId });
  t.after(() => f.manager.end(call.id, "U_MINE"));
  f.session = FakeSession.instances[0]; f.session.live();
  f.session.emit("tool_call", { id: "start-task", name: "run_task", args: { request: "Reply with the canary" } });
  await tick(30);
  const rootTs = f.manager.get(call.id).bound.threadTs;
  const root = { ts: rootTs, user: botUserId, bot_id: "B_APP", text: "Voice request" };
  f.client.conversations.replies = async () => ({ messages: [root] });
  assert.equal(slackThreadRootOwner("C_WORK", root), "U_MINE");
  assert.equal(getSlackThread("C_WORK", rootTs).title, "Reply with the canary");
  const runs = f.runs.length;
  assert.equal((await completionResponse(f, "finish-created", { id: `C_WORK:${rootTs}` })).done, true);
  assert.equal(f.runs.length, runs, "completion does not dispatch another task");
  assert.equal(f.manager.size(), 1);
});

test("voice reports a concurrent Reopen during marker delivery as open", async (t) => {
  const { getSlackThread, setSlackThreadDone } = await import("../src/gateway/slack-threads.js");
  const f = await doneFixture(t);
  f.client.reactions.add = async () => { setSlackThreadDone("C_WORK", f.root.ts, "U_MINE", false); return { ok: true }; };
  const result = await completionResponse(f, "reopened-during-marker");
  assert.equal(result.done, false);
  assert.match(result.note, /open now/);
  assert.ok(getSlackThread("C_WORK", f.root.ts).done_ms < 0);
});

test("voice refuses an unindexed thread or sudo thread after caller demotion", async (t) => {
  const { getSlackThread } = await import("../src/gateway/slack-threads.js");
  const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
  const f = await doneFixture(t);
  await setUser("U_MINE", { isAdmin: true });
  await setThreadSudo(f.entry.slug, f.root.ts, true);
  f.client.conversations.replies = async () => { await setUser("U_MINE", { isAdmin: false }); return { messages: [f.root] }; };
  assert.match((await completionResponse(f, "sudo-demoted")).error, /current conversation access/);
  assert.equal(getSlackThread("C_WORK", f.root.ts).done_ms, 0);
  getDb().prepare("DELETE FROM slack_threads WHERE channel_id=? AND thread_ts=?").run("C_WORK", f.root.ts);
  assert.match((await completionResponse(f, "unknown")).error, /starter/);
});

test("a new successfully posted spoken request reopens Done and resumes work in the same call", async (t) => {
  const { getSlackThread, slackThreadIsDone } = await import("../src/gateway/slack-threads.js");
  const postedTs = (Date.now() / 1000 + 1).toFixed(6);
  const f = await doneFixture(t, { post: async () => ({ messageId: postedTs }) });
  assert.equal((await completionResponse(f, "close-before-new-work")).done, true);
  f.session.emit("tool_call", { id: "new-work", name: "run_task", args: { request: "Please continue with the next change" } });
  await tick(40);
  assert.equal(slackThreadIsDone(getSlackThread("C_WORK", f.root.ts)), false);
  assert.equal(getDb().prepare("SELECT 1 FROM followup_done WHERE user_id='U_MINE' AND thread_key=?").get(`C_WORK::${f.root.ts}`), undefined);
  assert.equal(f.runs.length, 1);
  assert.equal(f.manager.size(), 1);
});


test("an answered incoming call greets with its recorded reason only once the phone audio is ready", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, teamId: "T_WORK", openingReason: "Review this conversation" });
  const voice = FakeSession.instances[0];
  assert.equal(voice.texts.length, 0);
  assert.equal(f.manager.audio(call.id, "U_MINE", Buffer.alloc(320)), false);
  voice.live();
  assert.equal(voice.texts.length, 0, "provider readiness alone must not speak before the phone is listening");
  f.manager.audio(call.id, "U_MINE", Buffer.alloc(320));
  assert.equal(voice.texts.length, 1);
  assert.match(voice.texts[0], /Review this conversation/);
  f.manager.audio(call.id, "U_MINE", Buffer.alloc(320));
  assert.equal(voice.texts.length, 1, "later audio never repeats the opening");
  await f.manager.end(call.id, "U_MINE");
});

// ── ChatGPT sign-in (GPT-Live): WebRTC offer, delegations, activity, accounting ──────────────
class FakeChatgptSession extends EventEmitter {
  constructor() { super(); this.ready = false; this.texts = []; this.context = []; this.responses = []; this.closed = false; }
  sendText(text) { this.texts.push(text); return true; }
  sendContext(text) { this.context.push(text); return true; }
  sendToolResponse(response) { this.responses.push(response); return true; }
  sendAudio() { return false; }
  close() { this.closed = true; }
  live() { this.ready = true; this.emit("ready"); }
}
function chatgptFixture(overrides = {}) {
  const offers = [], minuteRecords = [], limitRecords = [];
  let session = null;
  const both = { enabled: true, apiKey: "AIzaTestKey_0123456789abc", model: "gemini-3.8-live", voice: "Kore", chatgpt: { enabled: true, login: "codex-lic-0a1b2c3d", model: "gpt-live-1.1-codex", allowanceMinutes: 30 }, defaultProvider: "chatgpt" };
  const f = fixture({
    getConfig: () => both,
    startChatgpt: async (options) => { offers.push(options); session = new FakeChatgptSession(); return { session, answer: "v=0\r\nanswer", planType: "pro" }; },
    meter: ({ login, ownerId, allowanceMinutes }) => ({ login, windowMs: 18_000_000, usedMs: 12 * 60_000, ownUsedMs: 3 * 60_000, weekMs: 40 * 60_000, calls: 2, allowanceMs: allowanceMinutes * 60_000, remainingMs: allowanceMinutes ? (allowanceMinutes - 12) * 60_000 : null, limit: null, ownerId }),
    recordMinutes: async (row) => { minuteRecords.push(row); }, recordLimit: async (row) => { limitRecords.push(row); },
    runner: async (args) => {
      f.runs.push(args);
      args.onEvent?.({ kind: "tool_use", name: "Bash", target: "npm test -- --token=sk-secret" });
      await tick(25);
      return { content: "Done: the export is built.", engine: "claude", usage: { input_tokens: 10, output_tokens: 5 } };
    },
    ...overrides,
  });
  return Object.assign(f, { offers, minuteRecords, limitRecords, session: () => session });
}

test("a ChatGPT call waits for the browser's WebRTC offer, routes delegations to the call's tools and is accounted to the plan", async () => {
  await channel();
  await channel("C_SALES", { name: "#c_sales" });
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu", voicePreferences: { style: "brief", patience: "normal", provider: "chatgpt", taskSpeed: "quick" } });
  const f = chatgptFixture();
  // A client without WebRTC (the iPhone app) gets Gemini even though ChatGPT is preferred.
  const phone = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  assert.equal(phone.provider, "gemini"); assert.equal(phone.awaitingOffer, false);
  await f.manager.end(phone.id, "U_MINE", "test");
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, webrtc: true });
  assert.equal(call.provider, "chatgpt"); assert.equal(call.awaitingOffer, true); assert.equal(call.model, "gpt-live-1.1-codex");
  assert.equal(call.minutes.text, "12 min used in the last 5 hours (3 min by you) · about 18 min left of 30 min", "the caller sees the plan's recent voice use");
  assert.equal(phone.minutes, undefined, "a Gemini call carries no ChatGPT meter");
  await assert.rejects(f.manager.offer(call.id, "U_OTHER", "v=0"), (e) => e.status === 404, "only the caller's browser completes the call");
  const answer = await f.manager.offer(call.id, "U_MINE", "v=0\r\noffer");
  assert.deepEqual(answer, { sdp: "v=0\r\nanswer" });
  assert.equal(f.offers[0].loginId, "codex-lic-0a1b2c3d"); assert.equal(f.offers[0].sdp, "v=0\r\noffer");
  assert.match(f.offers[0].instructions, /Delegation policy/);
  assert.match(f.offers[0].instructions, /1\. #c_work — Build the voice page/);
  await assert.rejects(f.manager.offer(call.id, "U_MINE", "v=0"), (e) => e.status === 409, "one offer per call");
  const session = f.session();
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  session.live();
  assert.ok(f.manager.heartbeat(call.id, "U_MINE"));
  assert.deepEqual(f.manager.liveChatgpt().map(({ login, ownerId }) => ({ login, ownerId })), [{ login: "codex-lic-0a1b2c3d", ownerId: "U_MINE" }], "a running call counts toward the meter");
  // Listing and picking by number.
  session.emit("delegation", { id: "d1", text: "What am I working on?" });
  await tick();
  const listed = session.responses.at(-1);
  assert.equal(listed.id, "d1");
  assert.deepEqual(listed.response.conversations.map((c) => c.number), [1, 2]);
  assert.equal(listed.response.conversations[0].id, undefined, "GPT-Live gets numbers, never routing ids");
  session.emit("delegation", { id: "d2", text: "Open the second one." });
  await tick(20);
  assert.equal(session.responses.at(-1).response.switched, true);
  assert.equal(session.responses.at(-1).response.conversation, "#c_sales");
  session.emit("delegation", { id: "d2", text: "Open the second one." });
  await tick();
  assert.equal(session.responses.filter((r) => r.id === "d2").length, 1, "a redelivered delegation is answered once");
  // Work goes to the agent with the voice note, at quick effort; activity is tracked without the command line.
  session.emit("input_transcript", { text: "Build the export and run the tests" });
  session.emit("delegation", { id: "d3", text: "Build the export and run the tests" });
  await tick(15);
  assert.equal(session.responses.at(-1).response.status, "started");
  assert.equal(f.runs.length, 1);
  assert.match(f.runs[0].text, /^Build the export and run the tests\n\n\[Voice call note/);
  assert.match(f.runs[0].text, /caller's own words as speech recognition heard them/);
  assert.match(f.runs[0].text, /Tiberiu: Build the export and run the tests/);
  assert.deepEqual(f.runs[0].overrides, { effort: "low" });
  session.emit("delegation", { id: "d4", text: "How's it going?" });
  await tick();
  const status = session.responses.at(-1).response.tasks[0];
  assert.equal(status.status, "running"); assert.equal(status.activity, "running a command");
  assert.ok(seen.some((e) => e.type === "task" && e.activity === "running a command"), "the overlay shows the activity");
  assert.deepEqual(session.context, ["[gateway] Task 1 is still running; the agent is running a command."]);
  assert.ok(!JSON.stringify(seen).includes("sk-secret") && !session.context.join("").includes("sk-secret"));
  await tick(40);
  assert.match(session.texts.at(-1), /^\[gateway\] Task 1 finished\. Result: Done: the export is built\./);
  // Unknown places are refused with a reason; goodbye hangs up.
  session.emit("delegation", { id: "d5", text: "Switch to the nowhere channel" });
  await tick();
  assert.match(session.responses.at(-1).response.error, /No channel named|No conversation or channel/);
  session.emit("usage", { audioMs: 125_000, limit: { status: "ok" } });
  assert.equal(f.limitRecords.length, 0);
  session.emit("usage", { audioMs: 125_000, limit: { status: "exceeded", resetSeconds: 900 } });
  session.emit("usage", { audioMs: 125_000, limit: { status: "exceeded", resetSeconds: 890 } });
  assert.deepEqual(f.limitRecords, [{ login: "codex-lic-0a1b2c3d", ownerId: "U_MINE", status: "exceeded", resetSeconds: 900 }], "a used-up allowance is recorded once");
  session.emit("delegation", { id: "d6", text: "Goodbye" });
  await tick(30);
  assert.equal(f.manager.get(call.id), null, "the call ended");
  assert.ok(session.closed);
  assert.equal(f.minuteRecords.length, 1);
  assert.equal(f.minuteRecords[0].login, "codex-lic-0a1b2c3d"); assert.equal(f.minuteRecords[0].ownerId, "U_MINE");
  assert.equal(f.minuteRecords[0].audioMs, 125_000); assert.equal(f.minuteRecords[0].planType, "pro"); assert.ok(f.minuteRecords[0].connectedMs >= 0);
  assert.equal(f.manager.liveChatgpt().length, 0);
  const usage = f.records.find((r) => r.engine === "chatgpt-live");
  assert.equal(usage.taskKind, "voice-call"); assert.equal(usage.result.costUSD, 0); assert.equal(usage.result.audioMs, 125_000); assert.equal(usage.model, "gpt-live-1.1-codex");
  assert.match(f.posted.at(-1).text, /Voice call ended\* — \d+ min · 1 task · ChatGPT plan voice/);
});

test("a ChatGPT call with no offer is dropped, and a failed offer ends the call with the reason", async () => {
  await channel();
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu", voicePreferences: { provider: "chatgpt" } });
  const quiet = chatgptFixture({ offerTimeoutMs: 15 });
  const pending = await quiet.manager.start({ ownerId: "U_MINE", client: quiet.client, webrtc: true });
  await tick(40);
  assert.equal(quiet.manager.get(pending.id), null);
  assert.equal(quiet.records.length, 0, "a call that never connected records no voice usage");
  assert.equal(quiet.minuteRecords.length, 0, "and no voice minutes");
  const failing = chatgptFixture({ startChatgpt: async () => { throw Object.assign(new Error("ChatGPT voice refused the call: HTTP 401"), { status: 502 }); } });
  const call = await failing.manager.start({ ownerId: "U_MINE", client: failing.client, webrtc: true });
  await assert.rejects(failing.manager.offer(call.id, "U_MINE", "v=0"), (e) => e.status === 502 && /HTTP 401/.test(e.message));
  await tick();
  assert.equal(failing.manager.get(call.id), null);
  // Only ChatGPT on, and a client without WebRTC: refused with the remedy.
  const only = chatgptFixture({ getConfig: () => ({ enabled: true, apiKey: "", chatgpt: { enabled: true, login: "codex", model: "gpt-live-1.1-codex" }, defaultProvider: "chatgpt" }) });
  assert.equal(only.manager.available(), true);
  await assert.rejects(only.manager.start({ ownerId: "U_MINE", client: only.client }), (e) => e.status === 503 && /WebRTC/.test(e.message));
});

test("the offer and alive routes are the session owner's, CSRF-protected, and take a full-size SDP offer", async (t) => {
  await channel();
  const offers = [], beats = [];
  const f = await webFixture(t);
  f.calls.offer = async (id, ownerId, sdp) => { offers.push([id, ownerId, sdp.length]); return { sdp: "v=0\r\nanswer" }; };
  f.calls.heartbeat = (id, ownerId) => { beats.push([id, ownerId]); return true; };
  const s = await f.login();
  const sdp = "v=0\r\n" + "a=candidate:x\r\n".repeat(900);
  assert.ok(Buffer.byteLength(sdp) > 8 * 1024, "larger than the default JSON limit");
  const offer = await f.request(`${s.sessionBase}/call/call-1/offer`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ sdp }) });
  assert.equal(offer.status, 200);
  assert.deepEqual(await offer.json(), { sdp: "v=0\r\nanswer" });
  assert.deepEqual(offers, [["call-1", "U_MINE", sdp.length]]);
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/offer`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ sdp }) })).status, 403, "the offer needs the CSRF token");
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/offer`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: "{}" })).status, 400);
  const alive = await f.request(`${s.sessionBase}/call/call-1/alive`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: "{}" });
  assert.deepEqual(await alive.json(), { ok: true });
  assert.deepEqual(beats, [["call-1", "U_MINE"]]);
  // The start route passes the browser's WebRTC capability through.
  await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_WORK", webrtc: true }) });
  assert.equal(f.started.at(-1).webrtc, true);
  const page = await (await f.request(s.sessionBase, { headers: { cookie: s.cookie } })).text();
  assert.match(page, /data-call="minutes"/); assert.match(page, /"ChatGPT plan voice: " \+ data\.minutes\.text/);
  assert.match(page, /RTCPeerConnection/); assert.match(page, /createDataChannel\("oai-events"\)/); assert.match(page, /\/call\/" \+ id \+ "\/offer"/);
});
