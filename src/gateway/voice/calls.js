// Live voice calls with a channel's agent.
//
// A call is a browser session (web/activity.js serves the overlay and relays audio) bound to ONE
// Slack conversation and ONE thread at a time. The daemon holds the Gemini Live session, so the
// API key never reaches a browser and every tool the voice model calls runs here with the
// caller's own identity. The voice model only converses, navigates and dispatches: a `run_task`
// call becomes an ordinary engine turn in the bound thread, authored by the caller (origin
// `voice_call`), in the channel's own container under its mode, secrets and queue — exactly what
// a typed message in that thread would do.
//
// Navigation (phase 2): the voice sees what the caller sees on their Activity page — their own
// conversations — and can list, search and SWITCH the call to another thread or channel. Every
// switch is admitted by the same `accessContext().allows()` rule as the Dashboard button; nothing
// on this path widens access. Everything said is logged: spoken requests are posted into the
// thread as they are dispatched, each thread receives the transcript of the segment spent there
// when the call moves on or ends, and a one-line record of the call is saved to the caller's own
// DM memory.
import crypto from "node:crypto";
import fs from "node:fs";
import { getVoiceCallConfig, getProgressView } from "../../config/settings.js";
import { getChannelEntry, getChannelMeta, getUser, listChannels } from "../../config/store.js";
import { userReplyMentionsEnabled } from "../../config/user-preferences.js";
import { accessContext, activityThreadSnapshot } from "../../slack/home-threads.js";
import { postNotice } from "../../platforms/notify.js";
import { runMessage } from "../run.js";
import { runQueue } from "../../slack/message-lifecycle.js";
import { startProgress } from "../../slack/progress.js";
import { deliverResult } from "../../slack/deliver.js";
import { getDirectory } from "../../slack/directory.js";
import { mdToMrkdwn } from "../../slack/format.js";
import { recordUsage } from "../usage.js";
import { logEvent } from "../../util/logger.js";
import { effectiveWorkDir } from "../folders.js";
import { memoryEnabled, updateChannelMemory } from "../channel-memory.js";
import { createGeminiLiveSession, estimateVoiceCost } from "./gemini-live.js";

export const VOICE_CALL_ORIGIN = "voice_call";
export const VOICE_ENGINE = "gemini-live";
export const MAX_REQUEST_CHARS = 4_000;
export const MAX_TRANSCRIPT_POST_CHARS = 2_800;
export const INITIAL_CONVERSATIONS = 8;
export const MAX_LISTED_CONVERSATIONS = 20;
const MAX_TRANSCRIPT_ENTRIES = 400;
const MAX_TASKS_PER_CALL = 20;
const MAX_RUNNING_TASKS = 3;
const CONTEXT_MESSAGES = 20;
const CONTEXT_MESSAGE_CHARS = 400;
const RESULT_TO_MODEL_CHARS = 1_500;
const END_CALL_GRACE_MS = 4_000;
const STATUS_FILTERS = Object.freeze(["open", "working", "waiting", "error", "idle", "later", "done", "all"]);

export const TOOL_DECLARATIONS = Object.freeze([
  {
    name: "run_task", nonBlocking: true,
    description: "Give the channel agent a task or question to work on in the conversation the call is currently in. It runs in that channel's own environment with its files, tools, memory and credentials, and may take minutes. Returns immediately; the result arrives later as a message starting with [gateway].",
    parameters: { type: "object", properties: { request: { type: "string", description: "The complete request, in the caller's words, with every detail they gave." } }, required: ["request"] },
  },
  {
    name: "check_tasks",
    description: "List the tasks dispatched during this call with their status (queued, running, done, failed) and a short result summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_thread",
    description: "Read the most recent messages of the conversation the call is currently in, newest last.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "How many recent messages to read (1-40, default 15)." } } },
  },
  {
    name: "list_conversations",
    description: "List the caller's own conversations (what they see on their Activity page), most recent first. Default: open conversations, 8 of them. Use it when the caller asks what they are working on or wants to pick a conversation.",
    parameters: { type: "object", properties: {
      status: { type: "string", description: "open (default, everything not done), working, waiting, error, idle, later, done or all." },
      channel: { type: "string", description: "Only conversations in this channel (name or id)." },
      limit: { type: "integer", description: "How many to return (1-20, default 8)." },
    } },
  },
  {
    name: "search_conversations",
    description: "Search the caller's own conversations by words in the title or channel name, optionally within one channel. For anything beyond their own conversations, dispatch a search to the channel agent with run_task instead.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Words to look for in the conversation title or channel name." },
      channel: { type: "string", description: "Only conversations in this channel (name or id)." },
      limit: { type: "integer", description: "How many to return (1-20, default 8)." },
    }, required: ["query"] },
  },
  {
    name: "switch_conversation",
    description: "Move the call to another conversation: an id from list_conversations/search_conversations, or a channel name to start a new conversation there. The transcript so far is posted to the conversation being left. Returns the new conversation's recent messages.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "A conversation id from the list, like C0123ABC:1700000000.123456." },
      channel: { type: "string", description: "A channel name or id to open a NEW conversation in (ignored when id is given)." },
    } },
  },
  {
    name: "end_call",
    description: "Hang up. Call this only after the caller said goodbye or asked to end the call, after you said a short goodbye.",
    parameters: { type: "object", properties: {} },
  },
]);

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const httpError = (status, message) => Object.assign(new Error(message), { status });
const channelLabel = (entry, channelId) => entry?.isDM || entry?.type === "im" ? "your direct messages" : `#${String(entry?.name || channelId).replace(/^#/, "")}`;
const sameChannel = (needle, channelId, name) => {
  const n = String(needle || "").trim().replace(/^#/, "").toLowerCase();
  if (!n) return true;
  return String(channelId || "").toLowerCase() === n || String(name || "").replace(/^#/, "").toLowerCase().includes(n);
};

export function buildSystemInstruction({ callerName, channelName = "", agentName = "the channel agent", isAdmin = false, threadContext = "", conversations = [] }) {
  const bound = Boolean(channelName);
  const list = conversations.length
    ? `The caller's most recent open conversations (ids for switch_conversation):\n${conversations.map((c, i) => `${i + 1}. [${c.id}] ${c.channel} — ${c.title || "Untitled"} (${c.status}${c.lastActivity ? `, ${c.lastActivity}` : ""})`).join("\n")}\nUse list_conversations or search_conversations for more or for older ones.`
    : "The caller has no tracked conversations yet; list_conversations will say so.";
  return [
    `You are the voice of ${agentName}, the ChannelGate agent, on a live voice call with ${callerName}${isAdmin ? " (an organization admin)" : ""}. ${bound ? `The call is currently in the Slack conversation ${channelName}.` : "The call is not in any conversation yet: ask which one to open, or offer the list below."} Everything you dispatch runs in the current conversation and everything said is logged there when the call moves on or ends.`,
    "Speak briefly and naturally, like a colleague on the phone: one to three sentences per reply, no lists, no code read aloud, no markdown. Ask one clarifying question when a request is ambiguous; otherwise act.",
    "You discuss, answer from the context you have, and hand real work to the channel agent with run_task: it runs in the channel's own environment with its files, tools, memory and credentials, and can take minutes. Pass the caller's request completely and faithfully. Say in a few words that you started it, then keep talking; never pretend a result you do not have.",
    "A message starting with [gateway] is not from the caller: it is the gateway reporting a task result or event. Summarize it for the caller in one or two spoken sentences, mentioning anything they must decide. Use check_tasks when asked about progress and read_thread when asked what was said or produced in the current conversation.",
    "You can see the caller's own conversations, the same list as their Activity page: list_conversations and search_conversations show them (title, channel, status), and switch_conversation moves the call there — a different thread, or a different channel, in which case you work with that channel's agent. When the caller asks what they are working on, what is pending, or about another channel, use these tools; when they want to act on another conversation, switch to it first. Conversations started by other people or thread contents are not in that list: offer to dispatch a search to the channel agent with run_task. Never guess or claim that nothing else is happening.",
    "When the caller says goodbye or asks to hang up, say a short goodbye and call end_call.",
    list,
    threadContext ? `Recent messages in the current conversation, oldest first:\n${threadContext}` : bound ? "The current conversation is new and empty." : "",
  ].filter(Boolean).join("\n\n");
}

async function defaultReadThread(client, channelId, threadTs, { limit = CONTEXT_MESSAGES, botUserId = "" } = {}) {
  if (typeof client?.conversations?.replies !== "function") return [];
  const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: Math.min(Math.max(limit, 1), 100) });
  if (page?.ok === false || !Array.isArray(page?.messages)) return [];
  return page.messages.slice(-limit).map((message) => ({
    ts: String(message.ts || ""),
    from: message.bot_id || (botUserId && message.user === botUserId) ? "agent" : String(message.user || "someone"),
    text: clean(message.text, CONTEXT_MESSAGE_CHARS),
  })).filter((row) => row.text);
}

function renderContext(messages, names) {
  return messages.map((row) => `${row.from === "agent" ? "Agent" : names.get(row.from) || "Member"}: ${row.text}`).join("\n");
}

// The one-line record of a call saved to the caller's DM memory, when they have a DM folder.
async function defaultSaveCallMemory({ ownerId, text }, { channels = listChannels, loadMeta = getChannelMeta } = {}) {
  for (const entry of await channels()) {
    if (!entry?.isDM && entry?.type !== "im") continue;
    const meta = await loadMeta(entry.slug).catch(() => null);
    if (!meta || meta.dmUserId !== ownerId || !memoryEnabled(meta)) continue;
    const cwd = effectiveWorkDir(entry.slug, meta);
    if (!cwd || !fs.existsSync(cwd)) return { saved: false, reason: "no folder" };
    await updateChannelMemory(cwd, meta, { action: "add", section: "Project state", text });
    return { saved: true, slug: entry.slug };
  }
  return { saved: false, reason: "no DM" };
}

export function createCallManager({
  getConfig = getVoiceCallConfig, createSession = createGeminiLiveSession, runner = runMessage, queue = runQueue,
  progress = startProgress, deliver = deliverResult, record = recordUsage, post = postNotice, directory = getDirectory,
  loadEntry = getChannelEntry, loadUser = getUser, channels = listChannels, access = accessContext, readThread = defaultReadThread,
  snapshot = activityThreadSnapshot, saveMemory = defaultSaveCallMemory,
  log = logEvent, now = Date.now, maxCalls = 8, maxCallMs = 60 * 60_000, idleMs = 5 * 60_000, endCallGraceMs = END_CALL_GRACE_MS,
} = {}) {
  const calls = new Map();
  const config = () => {
    const c = getConfig() || {};
    return { enabled: c.enabled === true, apiKey: c.apiKey || "", model: c.model, voice: c.voice };
  };
  const available = () => { const c = config(); return c.enabled && Boolean(c.apiKey); };

  function broadcast(call, event) {
    for (const listener of call.listeners) { try { listener(event); } catch { /* a dead listener is dropped by its owner */ } }
  }
  function touch(call) { call.lastActivityMs = now(); }
  function appendTranscript(call, who, text) {
    const piece = String(text || "");
    if (!piece) return;
    const last = call.transcript[call.transcript.length - 1];
    if (last && last.who === who && last.open) last.text += piece;
    else {
      if (last) last.open = false;
      if (call.transcript.length >= MAX_TRANSCRIPT_ENTRIES) { call.transcript.shift(); call.transcriptTruncated = true; call.segmentStart = Math.max(0, call.segmentStart - 1); }
      call.transcript.push({ who, text: piece, ms: now(), open: true });
    }
    const entry = call.transcript[call.transcript.length - 1];
    broadcast(call, { type: "transcript", who, text: entry.text, ms: entry.ms, open: true });
  }
  function closeTranscriptTurn(call) {
    const last = call.transcript[call.transcript.length - 1];
    if (last) last.open = false;
  }
  function taskView(task) {
    return { id: task.id, status: task.status, request: task.request, summary: task.summary || "", startedMs: task.startedMs, endedMs: task.endedMs || 0, channelName: task.channelName, threadTs: task.threadTs };
  }
  function boundView(call) {
    return call.bound ? { channelId: call.bound.channelId, channelName: call.bound.channelName, threadTs: call.bound.threadTs, title: call.bound.title || "" } : null;
  }
  function snapshotView(call) {
    return { type: "state", status: call.status, callId: call.id, startedMs: call.startedMs, bound: boundView(call),
      transcript: call.transcript.map((row) => ({ who: row.who, text: row.text, ms: row.ms })), tasks: [...call.tasks.values()].map(taskView) };
  }

  // The caller's own conversations, most recent first — the Activity page's list, never wider.
  async function conversations(call, { status = "open", channel = "", query = "", limit = INITIAL_CONVERSATIONS } = {}) {
    const filter = STATUS_FILTERS.includes(status) ? status : "open";
    const data = await snapshot(call.client, call.ownerId, { filter: filter === "all" ? "all-statuses" : filter === "open" ? "all" : filter, search: clean(query, 200), pageSize: 1000 });
    const rows = (data?.rows || []).filter((row) => sameChannel(channel, row.channel_id, row.channelName))
      .sort((a, b) => (b.last_message_ms || 0) - (a.last_message_ms || 0) || Number(b.thread_ts) - Number(a.thread_ts));
    const size = Math.min(Math.max(Number(limit) || INITIAL_CONVERSATIONS, 1), MAX_LISTED_CONVERSATIONS);
    const list = rows.slice(0, size).map((row) => ({
      id: `${row.channel_id}:${row.thread_ts}`, title: clean(row.title, 160) || "Untitled conversation", channel: `#${String(row.channelName || "").replace(/^#/, "")}`,
      status: row.status, lastActivity: row.last_message_ms ? new Date(row.last_message_ms).toISOString().slice(0, 16).replace("T", " ") : "",
    }));
    return { conversations: list, total: rows.length, more: rows.length > size, unavailable: Boolean(data?.unavailable) };
  }

  async function contextFor(call, channelId, threadTs) {
    try {
      const rows = await readThread(call.client, channelId, threadTs, { botUserId: call.botUserId });
      const names = new Map();
      for (const row of rows) if (row.from !== "agent" && !names.has(row.from)) names.set(row.from, clean((await loadUser(row.from).catch(() => null))?.name || "Member", 60));
      return { text: renderContext(rows, names), messages: rows.map((row) => ({ from: row.from === "agent" ? "Agent" : names.get(row.from) || "Member", text: row.text })) };
    } catch { return { text: "", messages: [] }; }
  }

  // Bind (or re-bind) the call to a conversation. Posts the segment transcript to the thread being
  // left, announces the call in the new thread (or opens a root there), and loads its context.
  async function bind(call, { channelId, threadTs = "", title = "" }) {
    const entry = await loadEntry(channelId);
    if (!entry) throw httpError(404, "That conversation is not registered.");
    const ctx = await access(call.client, call.ownerId);
    if ((!ctx.user.approved && !ctx.user.isAdmin) || !await ctx.allows({ ...entry, channelId }, threadTs)) throw httpError(403, "You are not authorized to call the agent from that conversation.");
    if (call.bound) await leaveSegment(call, { moved: true });
    const channelName = channelLabel(entry, channelId);
    let boundThread = threadTs, opened = false;
    if (boundThread) {
      await post(call.client, { conversationId: channelId, threadKey: boundThread, text: `📞 *${call.callerName}* joined this thread by voice call.` });
    } else {
      const posted = await post(call.client, { conversationId: channelId, text: `📞 *Voice call* — ${call.callerName} is talking to the agent. Requests and the transcript land in this thread.` });
      if (!posted?.messageId) throw httpError(502, "Could not open a thread for the call.");
      boundThread = posted.messageId; opened = true;
    }
    const context = opened ? { text: "", messages: [] } : await contextFor(call, channelId, boundThread);
    // What was said while the call was in no conversation yet (the request to open this one,
    // typically) belongs to this first segment; a segment left behind was already posted.
    call.bound = { channelId, slug: entry.slug, isDM: Boolean(entry.isDM || entry.type === "im"), threadTs: boundThread, channelName, title: clean(title, 160), since: now() };
    closeTranscriptTurn(call);
    call.visited.push({ channelId, channelName, threadTs: boundThread, title: call.bound.title });
    broadcast(call, { type: "bound", ...boundView(call) });
    await log("voice_call_bound", { id: call.id, channelId, threadTs: boundThread, ownerId: call.ownerId, opened }).catch(() => {});
    return { channelName, threadTs: boundThread, title: call.bound.title, context, opened };
  }

  async function start({ ownerId, channelId = "", threadTs = "", client, teamId = "", botUserId = "" }) {
    const c = config();
    if (!c.enabled || !c.apiKey) throw httpError(503, "Voice calls are not configured. An administrator enables them under Settings → Voice calls.");
    if (!ownerId || !client) throw httpError(400, "A call needs a caller.");
    if (threadTs && !channelId) throw httpError(400, "A thread needs its conversation.");
    const user = (await loadUser(ownerId)) || {};
    if (!user.approved && !user.isAdmin) throw httpError(403, "You are not authorized to call the agent.");
    for (const existing of calls.values()) if (existing.ownerId === ownerId) await end(existing.id, ownerId, "replaced by a new call");
    if (calls.size >= maxCalls) throw httpError(429, "Too many calls are active right now. Try again in a few minutes.");
    const callerName = clean(user.name || user.realName || ownerId, 80);
    const startedMs = now();
    const id = crypto.randomBytes(12).toString("base64url");
    const call = {
      id, ownerId, client, teamId, botUserId, callerName, isAdmin: user.isAdmin === true, model: c.model, startedMs, lastActivityMs: startedMs, status: "connecting",
      bound: null, visited: [], segmentStart: 0, listeners: new Set(), transcript: [], transcriptTruncated: false,
      tasks: new Map(), nextTask: 1, usage: { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 }, session: null, ending: false, timers: [],
    };
    calls.set(id, call);
    let context = { text: "" };
    try {
      if (channelId) context = (await bind(call, { channelId, threadTs })).context;
    } catch (error) { calls.delete(id); throw error; }
    let recent = [];
    try { recent = (await conversations(call)).conversations; } catch { recent = []; }
    try {
      call.session = createSession({
        apiKey: c.apiKey, model: c.model, voice: c.voice, tools: TOOL_DECLARATIONS,
        systemInstruction: buildSystemInstruction({ callerName, channelName: call.bound?.channelName || "", isAdmin: call.isAdmin, threadContext: context.text, conversations: recent }),
      });
    } catch (error) {
      calls.delete(id);
      throw httpError(502, `Could not reach the voice service: ${error.message}`);
    }
    wire(call);
    const limit = setTimeout(() => { void end(id, ownerId, "maximum call length reached"); }, maxCallMs); limit.unref?.();
    const idle = setInterval(() => { if (now() - call.lastActivityMs > idleMs) void end(id, ownerId, "no audio for a while"); }, Math.min(idleMs, 30_000)); idle.unref?.();
    call.timers.push(limit, idle);
    await log("voice_call_started", { id, channelId: call.bound?.channelId || "", threadTs: call.bound?.threadTs || "", ownerId, model: c.model }).catch(() => {});
    return { id, threadTs: call.bound?.threadTs || "", channelName: call.bound?.channelName || "", callerName, model: c.model, bound: boundView(call) };
  }

  function wire(call) {
    const session = call.session;
    session.on("ready", () => { call.status = "live"; broadcast(call, { type: "ready" }); });
    session.on("audio", (buffer) => { broadcast(call, { type: "audio", data: buffer.toString("base64") }); });
    session.on("interrupted", () => { closeTranscriptTurn(call); broadcast(call, { type: "interrupted" }); });
    session.on("input_transcript", ({ text }) => appendTranscript(call, "caller", text));
    session.on("output_transcript", ({ text }) => appendTranscript(call, "agent", text));
    session.on("turn_complete", () => { closeTranscriptTurn(call); broadcast(call, { type: "turn_complete" }); });
    session.on("usage", ({ delta }) => { for (const key of Object.keys(call.usage)) call.usage[key] += delta[key] || 0; });
    session.on("tool_call", (tool) => { void handleTool(call, tool); });
    session.on("error", (error) => { broadcast(call, { type: "error", message: clean(error?.message || "voice service error", 300) }); });
    session.on("closed", ({ reason }) => { if (!call.ending) void end(call.id, call.ownerId, reason ? `voice service closed the connection (${clean(reason, 120)})` : "voice service closed the connection"); });
  }

  async function resolveSwitch(call, args) {
    const id = clean(args?.id, 120);
    if (id) {
      const m = /^([A-Z0-9_]{1,32}):(\d{1,13}\.\d{1,6})$/.exec(id);
      if (!m) throw new Error("That is not a conversation id; use one from list_conversations.");
      const [, channelId, threadTs] = m;
      let title = "";
      try { title = (await conversations(call, { status: "all", channel: channelId, limit: MAX_LISTED_CONVERSATIONS })).conversations.find((c) => c.id === id)?.title || ""; } catch { /* a title is a courtesy */ }
      return { channelId, threadTs, title };
    }
    const wanted = clean(args?.channel, 80);
    if (!wanted) throw new Error("Give a conversation id or a channel name.");
    const matches = (await channels()).filter((entry) => entry && !entry.isDM && entry.type !== "im" && !entry.archived && !entry.disabled && sameChannel(wanted, entry.channelId, entry.name));
    const exact = matches.find((entry) => String(entry.name || "").replace(/^#/, "").toLowerCase() === wanted.replace(/^#/, "").toLowerCase() || entry.channelId === wanted);
    const entry = exact || (matches.length === 1 ? matches[0] : null);
    if (!entry) throw new Error(matches.length ? `Several channels match "${wanted}": ${matches.slice(0, 5).map((e) => `#${String(e.name || "").replace(/^#/, "")}`).join(", ")}.` : `No channel named "${wanted}".`);
    return { channelId: entry.channelId, threadTs: "", title: "" };
  }

  async function handleTool(call, { id, name, args }) {
    const respond = (response, scheduling = "") => { try { call.session.sendToolResponse({ id, name, response, scheduling }); } catch { /* session gone */ } };
    try {
      if (name === "run_task") {
        if (!call.bound) return respond({ error: "The call is not in a conversation yet. Switch to one first (list_conversations, then switch_conversation)." }, "WHEN_IDLE");
        const request = clean(args?.request, MAX_REQUEST_CHARS);
        if (!request) return respond({ error: "The request was empty." }, "SILENT");
        if (call.tasks.size >= MAX_TASKS_PER_CALL) return respond({ error: "This call has reached its task limit; end the call and start a new one for more." }, "WHEN_IDLE");
        if ([...call.tasks.values()].filter((t) => ["queued", "running"].includes(t.status)).length >= MAX_RUNNING_TASKS) return respond({ error: "Three tasks are already in progress; wait for one to finish." }, "WHEN_IDLE");
        const task = { id: call.nextTask++, request, status: "queued", startedMs: now(), summary: "", channelId: call.bound.channelId, slug: call.bound.slug, isDM: call.bound.isDM, threadTs: call.bound.threadTs, channelName: call.bound.channelName };
        call.tasks.set(task.id, task);
        broadcast(call, { type: "task", ...taskView(task) });
        respond({ status: "started", task: task.id, conversation: call.bound.channelName }, "SILENT");
        void dispatch(call, task);
        return;
      }
      if (name === "check_tasks") return respond({ tasks: [...call.tasks.values()].map((t) => ({ task: t.id, status: t.status, conversation: t.channelName, request: t.request.slice(0, 200), summary: t.summary.slice(0, 600) })) });
      if (name === "read_thread") {
        if (!call.bound) return respond({ error: "The call is not in a conversation yet." });
        const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 40);
        const rows = await readThread(call.client, call.bound.channelId, call.bound.threadTs, { limit, botUserId: call.botUserId });
        const names = new Map();
        for (const row of rows) if (row.from !== "agent" && !names.has(row.from)) names.set(row.from, clean((await loadUser(row.from).catch(() => null))?.name || "Member", 60));
        return respond({ conversation: call.bound.channelName, messages: rows.map((row) => ({ from: row.from === "agent" ? "Agent" : names.get(row.from) || "Member", text: row.text })) });
      }
      if (name === "list_conversations") return respond(await conversations(call, { status: clean(args?.status, 20) || "open", channel: clean(args?.channel, 80), limit: args?.limit }));
      if (name === "search_conversations") {
        const query = clean(args?.query, 200);
        if (!query) return respond({ error: "Say what to search for." });
        return respond(await conversations(call, { status: "all", channel: clean(args?.channel, 80), query, limit: args?.limit }));
      }
      if (name === "switch_conversation") {
        const target = await resolveSwitch(call, args);
        if (call.bound && call.bound.channelId === target.channelId && target.threadTs && call.bound.threadTs === target.threadTs) return respond({ switched: false, note: "The call is already in that conversation.", conversation: call.bound.channelName });
        const result = await bind(call, target);
        return respond({ switched: true, conversation: result.channelName, title: result.title, opened: result.opened, recentMessages: result.context.messages.slice(-10) }, "INTERRUPT");
      }
      if (name === "end_call") {
        respond({ status: "ending" });
        const timer = setTimeout(() => { void end(call.id, call.ownerId, "the caller hung up"); }, endCallGraceMs); timer.unref?.();
        call.timers.push(timer);
        return;
      }
      respond({ error: `Unknown tool ${name}` });
    } catch (error) {
      respond({ error: clean(error?.message || "tool failed", 300) });
    }
  }

  async function dispatch(call, task) {
    const { client, ownerId } = call;
    const { channelId, threadTs } = task;
    const runKey = `${task.slug || channelId}::${threadTs}`;
    const controller = new AbortController();
    const handle = { aborted: false, controller, authorId: ownerId, voice: true };
    task.handle = handle;
    let status = null, result = null, failure = "";
    try {
      await post(client, { conversationId: channelId, threadKey: threadTs, text: `🎙️ *${call.callerName} (voice call):* ${mdToMrkdwn(task.request)}` });
      await queue.acquire(runKey, handle, () => { task.status = "queued"; broadcast(call, { type: "task", ...taskView(task) }); });
      if (handle.aborted || call.ending) throw Object.assign(new Error("call ended before the task started"), { name: "AbortError" });
      task.status = "running"; broadcast(call, { type: "task", ...taskView(task) });
      try {
        const dir = await directory(client).catch(() => null);
        status = progress(getProgressView(), client, channelId, threadTs, {
          isDM: task.isDM, authorId: ownerId, teamId: call.teamId || null, dir, menuOwnerId: ownerId,
          replyMentions: userReplyMentionsEnabled(await loadUser(ownerId).catch(() => null)),
        });
      } catch { status = null; }
      try {
        result = await runner({
          channelId, authorId: ownerId, workspaceId: call.teamId || "", text: task.request, threadKey: threadTs,
          origin: VOICE_CALL_ORIGIN, signal: controller.signal, progressReport: Boolean(status), onDelta: status?.onDelta, onEvent: status?.onEvent,
        });
      } catch (error) {
        failure = handle.aborted || controller.signal.aborted ? "stopped" : (error?.message || String(error));
      }
    } catch (error) {
      failure = error?.message || String(error);
    } finally {
      queue.release(runKey, handle);
    }
    task.endedMs = now();
    if (!result) {
      task.status = "failed"; task.summary = clean(failure, 600);
      await status?.stop?.().catch(() => {});
      if (!handle.aborted) await post(client, { conversationId: channelId, threadKey: threadTs, text: `⚠️ The voice-call task could not run: ${mdToMrkdwn(clean(failure, 500))}` }).catch(() => {});
    } else {
      task.status = "done"; task.summary = clean(result.content, 1_200);
      try { await record({ channelId, slug: task.slug, authorId: ownerId, engine: result.engine, taskKind: "voice-task", result }); } catch { /* best-effort accounting */ }
      try {
        if (status?.ownsFinal) await status.finalize(result);
        else { await status?.stop?.().catch(() => {}); await deliver(client, { channel: channelId, threadKey: threadTs, result, footer: true }); }
      } catch (error) {
        await log("voice_call_error", { id: call.id, stage: "deliver", error: error?.message || String(error) }).catch(() => {});
      }
    }
    broadcast(call, { type: "task", ...taskView(task) });
    if (call.ending || !call.session?.ready) return;
    const where = call.bound?.threadTs === threadTs ? "" : ` (in ${task.channelName}, not the current conversation)`;
    const outcome = result ? `Task ${task.id}${where} finished. Result: ${clean(result.content, RESULT_TO_MODEL_CHARS)}` : `Task ${task.id}${where} failed: ${clean(failure, 400)}`;
    call.session.sendText(`[gateway] ${outcome}`);
  }

  function subscribe(id, ownerId, listener) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    call.listeners.add(listener);
    listener(snapshotView(call));
    return () => { call.listeners.delete(listener); };
  }

  function audio(id, ownerId, chunk) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    touch(call);
    if (!call.session?.ready) return false;
    return call.session.sendAudio(chunk);
  }

  function transcriptLines(call, from) {
    const lines = [];
    let used = 0;
    for (const row of call.transcript.slice(from)) {
      const line = `> *${row.who === "caller" ? call.callerName : "Agent"}:* ${mdToMrkdwn(clean(row.text, 600))}`;
      if (used + line.length > MAX_TRANSCRIPT_POST_CHARS) { lines.push("> _(transcript truncated)_"); break; }
      lines.push(line); used += line.length + 1;
    }
    return lines;
  }

  // Post what was said in the current conversation to its thread: when the call moves on, as a
  // segment; when it ends, as the final summary with the whole call's figures.
  async function leaveSegment(call, { moved = false, durationMs = 0, costUSD = 0, reason = "" } = {}) {
    const bound = call.bound;
    if (!bound) return;
    const here = [...call.tasks.values()].filter((t) => t.threadTs === bound.threadTs && t.channelId === bound.channelId);
    const lines = [];
    if (moved) {
      lines.push(`📞 *Voice call moved on* — ${minutes(now() - bound.since)} min here · ${here.length} task${here.length === 1 ? "" : "s"}`);
    } else {
      const all = [...call.tasks.values()];
      lines.push(`📞 *Voice call ended* — ${minutes(durationMs)} min · ${all.length} task${all.length === 1 ? "" : "s"} · ~$${costUSD.toFixed(4)} voice${reason && reason !== "the caller hung up" ? ` · ${mdToMrkdwn(reason)}` : ""}`);
      const elsewhere = call.visited.filter((v) => !(v.channelId === bound.channelId && v.threadTs === bound.threadTs));
      if (elsewhere.length) lines.push("*Also visited:* " + [...new Map(elsewhere.map((v) => [`${v.channelId}:${v.threadTs}`, v])).values()].map((v) => `${v.channelName}${v.title ? ` — ${mdToMrkdwn(v.title)}` : ""}`).join(" · "));
    }
    if (here.length) lines.push("*Tasks here:* " + here.map((t) => `${t.id}. ${mdToMrkdwn(clean(t.request, 120))} — ${t.status}`).join(" · "));
    const transcript = transcriptLines(call, call.segmentStart);
    if (transcript.length) lines.push("*Transcript*" + (call.transcriptTruncated && call.segmentStart === 0 ? " _(earliest part dropped)_" : ""), transcript.join("\n"));
    try { await post(call.client, { conversationId: bound.channelId, threadKey: bound.threadTs, text: lines.join("\n") }); }
    catch (error) { await log("voice_call_error", { id: call.id, stage: moved ? "segment" : "summary", error: error?.message || String(error) }).catch(() => {}); }
    if (moved) { call.bound = null; call.segmentStart = call.transcript.length; }
  }

  function memoryLine(call, { durationMs }) {
    const date = new Date(call.startedMs).toISOString().slice(0, 10);
    const visited = [...new Map(call.visited.map((v) => [`${v.channelId}:${v.threadTs}`, v])).values()];
    const places = visited.length ? visited.map((v) => `${v.channelName}${v.title ? ` "${clean(v.title, 60)}"` : ""}`).join(", ") : "no conversation";
    const tasks = [...call.tasks.values()];
    const work = tasks.length ? `; tasks: ${tasks.map((t) => `"${clean(t.request, 70)}" (${t.status})`).join(", ")}` : "";
    return clean(`Voice call on ${date} (${minutes(durationMs)} min): worked in ${places}${work}`, 600);
  }

  async function end(id, ownerId, reason = "ended") {
    const call = calls.get(id);
    if (!call || (ownerId && call.ownerId !== ownerId)) return false;
    if (call.ending) return true;
    call.ending = true; call.status = "ended";
    calls.delete(id);
    for (const timer of call.timers) { clearTimeout(timer); clearInterval(timer); }
    try { call.session?.close(); } catch { /* fine */ }
    for (const task of call.tasks.values()) if (task.handle && ["queued", "running"].includes(task.status)) { task.handle.aborted = true; task.handle.controller?.abort(); }
    const durationMs = Math.max(0, now() - call.startedMs);
    const costUSD = estimateVoiceCost(call.model, call.usage);
    const first = call.visited[0] || null;
    try {
      await record({ channelId: call.bound?.channelId || first?.channelId || "", slug: call.bound?.slug || "", authorId: call.ownerId, engine: VOICE_ENGINE, model: call.model, taskKind: "voice-call",
        result: { usage: { input_tokens: call.usage.audioIn + call.usage.textIn, output_tokens: call.usage.audioOut + call.usage.textOut }, costUSD, durationMs, model: call.model } });
    } catch { /* accounting is best-effort */ }
    await leaveSegment(call, { durationMs, costUSD, reason });
    let memory = { saved: false };
    try { memory = await saveMemory({ ownerId: call.ownerId, text: memoryLine(call, { durationMs }) }); }
    catch (error) { await log("voice_call_error", { id, stage: "memory", error: error?.message || String(error) }).catch(() => {}); }
    broadcast(call, { type: "ended", reason: clean(reason, 200), durationMs });
    call.listeners.clear();
    await log("voice_call_ended", { id, channelId: call.bound?.channelId || "", threadTs: call.bound?.threadTs || "", ownerId: call.ownerId, durationMs, costUSD, tasks: call.tasks.size, visited: call.visited.length, memorySaved: memory?.saved === true, reason: clean(reason, 200) }).catch(() => {});
    return true;
  }

  async function endAll(reason = "gateway shutting down") {
    await Promise.all([...calls.keys()].map((id) => end(id, "", reason)));
  }

  return { available, start, subscribe, audio, end, endAll, get: (id) => calls.get(id) || null, size: () => calls.size };
}

let shared = null;
export function callManager() { return shared || (shared = createCallManager()); }
export function resetCallManagerForTests(manager = null) { shared = manager; }
