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
import { reserveVoiceTurn, beginVoiceExecution } from "./turn-recovery.ts";
import { isForceStopping } from "../shutdown.js";
import { finishActiveRun } from "../active-runs.js";
import { deliverTurnAnswer, slackAnswer, slackDeliveryIdentity } from "../turn-answer.ts";
import { footerText } from "../reply-stats.js";
import { turnReplyCallbacks } from "../turn-replies.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getVoiceCallConfig, getProgressView, voiceProviderState } from "../../config/settings.js";
import { getChannelEntry, getChannelMeta, getUser, listChannels } from "../../config/store.js";
import { userReplyMentionsEnabled, userVoicePreferences } from "../../config/user-preferences.js";
import { accessContext, activityThreadSnapshot } from "../../slack/home-threads.js";
import { postNotice } from "../../platforms/notify.js";
import { runMessage } from "../run.js";
import { runQueue } from "../thread-turn-owner.ts";
import { startProgress } from "../../slack/progress.js";
import { deliverResult } from "../../slack/deliver.js";
import { getDirectory } from "../../slack/directory.js";
import { mdToMrkdwn } from "../../slack/format.js";
import { recordUsage } from "../usage.js";
import { logEvent } from "../../util/logger.js";
import { effectiveWorkDir } from "../folders.js";
import { memoryEnabled, updateChannelMemory } from "../channel-memory.js";
import { createGeminiLiveSession, estimateVoiceCost } from "./gemini-live.js";
import { startChatgptLiveCall } from "./chatgpt-live.ts";
import { CHATGPT_VOICE_ENGINE, GEMINI_VOICE_ENGINE, VOICE_PROVIDER_LABELS, chooseVoiceProvider } from "./providers.ts";
import { channelNameFrom, routeDelegation } from "./delegation-router.ts";
import { VOICE_TASK_EFFORT, buildVoiceTaskText, describeActivity } from "./voice-task.ts";
import { saveCallHistory } from "./history.js";
import { completeThreadForCaller, recordVoiceThreadRequest } from "../../slack/thread-done-action.js";
import { indexSlackVoiceThread } from "../slack-threads.js";

export const VOICE_CALL_ORIGIN = "voice_call";
export const VOICE_ENGINE = GEMINI_VOICE_ENGINE;
export const MAX_REQUEST_CHARS = 4_000;
export const MAX_TRANSCRIPT_POST_CHARS = 2_800;
export const INITIAL_CONVERSATIONS = 8;
export const MAX_LISTED_CONVERSATIONS = 20;
const MAX_TRANSCRIPT_ENTRIES = 400;
const MAX_TASKS_PER_CALL = 20;
// Tasks in ONE thread wait on that thread's run queue like typed messages, so more than three
// pending there only delays them; tasks in different threads run in parallel and must never be
// held back by another thread's backlog (the global run slots are the only shared limit).
const MAX_RUNNING_TASKS_PER_THREAD = 3;
const CONTEXT_MESSAGES = 40;
const CONTEXT_MESSAGE_CHARS = 600;
const RESULT_TO_MODEL_CHARS = 1_500;
const END_CALL_GRACE_MS = 4_000;
export const SUSPEND_GRACE_MS = 45_000;
const STATUS_FILTERS = Object.freeze(["open", "working", "waiting", "error", "idle", "later", "done", "all"]);
// A ChatGPT call waits this long for the browser's WebRTC offer before it is dropped.
const OFFER_TIMEOUT_MS = 30_000;
// Quiet "the agent is <doing X>" context pushed to a ChatGPT voice at most this often per task.
const ACTIVITY_CONTEXT_MS = 20_000;
const MAX_DELEGATIONS_REMEMBERED = 200;

export const TOOL_DECLARATIONS = Object.freeze([
  {
    name: "run_task", nonBlocking: true,
    description: "Hand the channel agent a task OR a question in the conversation the call is currently in. The channel agent is the only source of truth: use this for every agent action except explicit mark_thread_done completion, and for every question whose answer is not literally in a message you have read. It runs in that channel's own environment with its files, tools, memory and credentials, and may take minutes. When the call is at the top level of a channel (no thread yet), the request is posted as a new message in the channel and the call follows its thread. Returns immediately; the result arrives later as a message starting with [gateway].",
    parameters: { type: "object", properties: { request: { type: "string", description: "The complete request or question, in the caller's words, with every detail they gave." } }, required: ["request"] },
  },
  {
    name: "check_tasks",
    description: "List the tasks dispatched during this call with their status (queued, running, done, failed), how long each has been going, what the agent is doing right now (activity) and a short result summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_thread",
    description: "Read the most recent messages of the conversation the call is currently in, newest last. Use it before saying anything about what the thread contains, and only report what the messages literally say.",
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
    description: "Move the call to another conversation: an id from list_conversations/search_conversations, or a channel name to go to the top level of that channel, where the next run_task starts a new thread as a visible channel message. The transcript so far is posted to the conversation being left. Returns the new conversation's recent messages.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "A conversation id from the list, like C0123ABC:1700000000.123456." },
      channel: { type: "string", description: "A channel name or id to open a NEW conversation in (ignored when id is given)." },
    } },
  },
  {
    name: "mark_thread_done",
    description: "Mark the current thread Done only when the caller explicitly asks to close/complete it. Only its starter may do this; participants can Hide it in Activity instead. Use the exact conversation id from the current binding or list; switch to a different requested thread first. This saves shared completion and mirrors the Slack checkmark, does not cancel running tasks, delete messages, or end the call. Report only the returned outcome.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "Exact current conversation id, channel:thread timestamp. Must match the thread the call is in." },
    }, required: ["id"] },
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

const STYLE_RULES = Object.freeze({
  brief: "Speak briefly and naturally, like a colleague on the phone: one to three sentences per reply, no lists, no code read aloud, no markdown. Ask one clarifying question when a request is ambiguous; otherwise act.",
  conversational: "Speak naturally and warmly, like a colleague on the phone: a few sentences per reply, more when the caller asks for detail; no lists, no code read aloud, no markdown. Ask one clarifying question when a request is ambiguous; otherwise act.",
  "thinking-partner": "The caller uses you to think out loud. Listen more than you talk: acknowledge in a few words, reflect back what you heard, ask one question at a time, and offer proposals or summaries only when asked or when the caller asks what you think. Never rush them to a decision; a pause is not the end of their turn. No lists, no code read aloud, no markdown.",
});
const PATIENCE_RULES = Object.freeze({
  quick: "Answer as soon as the caller stops; they prefer a fast back-and-forth.",
  normal: "",
  patient: "The caller may pause mid-thought. Wait for them to finish; if a pause runs long, ask gently whether they are done rather than answering a half-sentence.",
});

export function buildSystemInstruction({ callerName, channelName = "", conversationId = "", topLevel = false, agentName = "the channel agent", isAdmin = false, threadContext = "", conversations = [], preferences = null, history = [] }) {
  const prefs = preferences || {};
  const style = Object.hasOwn(STYLE_RULES, prefs.style) ? STYLE_RULES[prefs.style] : STYLE_RULES.brief;
  const language = prefs.language ? `Speak ${prefs.language} by default; if the caller switches language, follow them.` : "Speak the language the caller uses.";
  const patience = Object.hasOwn(PATIENCE_RULES, prefs.patience) ? PATIENCE_RULES[prefs.patience] : "";
  const own = prefs.instructions ? `The caller's own instructions for how to treat them on a call (follow them unless they conflict with the rules above):\n${prefs.instructions}` : "";
  const recent = Array.isArray(history) && history.length ? `From the caller's own memory, their recent calls (use for continuity, never read aloud unless asked):\n${history.map((line) => `- ${line}`).join("\n")}` : "";
  const bound = Boolean(channelName);
  const list = conversations.length
    ? `The caller's most recent open conversations (ids for switch_conversation):\n${conversations.map((c, i) => `${i + 1}. [${c.id}] ${c.channel} — ${c.title || "Untitled"} (${c.status}${c.lastActivity ? `, ${c.lastActivity}` : ""})`).join("\n")}\nUse list_conversations or search_conversations for more or for older ones.`
    : "The caller has no tracked conversations yet; list_conversations will say so.";
  return [
    `You are the voice connection between ${callerName}${isAdmin ? " (an organization admin)" : ""} and ${agentName}, the ChannelGate agent working in their Slack conversations. You are NOT that agent and you do not have its knowledge, files, tools or memory: you are the phone line between the caller and the agent running in the current conversation. ${bound ? `The call is currently in the Slack conversation ${channelName}${topLevel ? ", at the channel's top level: the first task you dispatch is posted as a new message in the channel and the call then follows that thread" : ""}.` : "The call is not in any conversation yet: ask which one to open, or offer the list below."} Everything you dispatch runs in the current conversation as a visible message there, and everything said is logged there when the call moves on or ends.`,
    "Assume nothing. You know exactly three things: this briefing, the messages you have read with read_thread (or that are quoted below), and what tools return. Never infer, extend, complete or guess beyond them, and never present a plausible answer as fact. When you report what a conversation contains, say only what its messages literally say and attribute it (\"the agent wrote…\", \"you asked…\"). If the caller asks for any detail, status, reason, file, number or decision that is not in a message you have read, do not answer from your own knowledge: dispatch the question to the channel agent with run_task, say that you asked it, and relay its reply when the [gateway] message arrives. If the caller refers to something earlier than the messages you have, call read_thread with a larger limit first, then run_task if it is still not there.",
    "Every action and every question for the agent goes through run_task, except the explicit thread-completion action described below, in the caller's own words with every detail they gave. The request is posted in the conversation so the caller can see it, and the agent's work and answer appear in that thread like any typed message. Say in a few words that you sent it, then keep talking; never pretend a result you do not have and never announce an outcome before the [gateway] message brings it.",
    "Use the readable conversation label and title when speaking. Never read conversation IDs aloud; IDs are only routing keys for tools.",
    [style, language, patience].filter(Boolean).join(" "),
    "A message starting with [gateway] is not from the caller: it is the gateway reporting a task result or event. Relay it for the caller in one or two spoken sentences without adding anything of your own, mentioning anything they must decide. When it says a task finished in a conversation the call has LEFT, do not read the result: say in one short sentence that an answer is waiting there and offer to switch back; give the content only after switching or when asked through check_tasks. Use check_tasks when asked about progress and read_thread when asked what was said or produced in the current conversation.",
    "You can see the caller's own conversations, the same list as their Activity page: list_conversations and search_conversations show them (title, channel, status), and switch_conversation moves the call there — a different thread, or a different channel, in which case you work with that channel's agent. When the caller asks what they are working on, what is pending, or about another channel, use these tools; when they want to act on another conversation, switch to it first. Conversations you have not participated in or their thread contents are not in that list: offer to dispatch a search to the channel agent with run_task. Never guess or claim that nothing else is happening.",
    "When the caller explicitly asks to close this thread or mark a conversation Done, use mark_thread_done directly, not run_task. Resolve an ambiguous reference first; for another thread switch to it first. Use the exact current conversation id and mention its readable title/channel in your spoken acknowledgement. Only say it is Done if the tool returns done:true; if markerPending:true, explain that completion was saved and the Slack checkmark will retry. A denial is not completion: explain that only the starter can close it and participants can use Hide in Activity. Never infer completion from an agent saying its task finished. Marking Done does not cancel running work or hang up; continue the call unless asked to end it.",
    conversationId ? `Current conversation id for mark_thread_done: ${conversationId} (routing key only, never read aloud).` : "",
    "When the caller says goodbye or asks to hang up, say a short goodbye and call end_call.",
    own,
    recent,
    list,
    threadContext ? `The messages of the current conversation that you have read so far, oldest first (this is your only knowledge of it; it may not be complete — use read_thread for more):\n${threadContext}` : bound && !topLevel ? "The current conversation is new and empty." : "",
  ].filter(Boolean).join("\n\n");
}

// The GPT-Live session's instructions (ChatGPT sign-in). GPT-Live has no tools: everything it
// cannot answer from this briefing goes to the gateway as a DELEGATION, which calls.js routes to
// the same actions Gemini calls as tools (delegation-router.ts). So the briefing describes what a
// delegation can do in plain words and numbers the conversations, which a caller can then name or
// pick by number ("open the second one").
export function buildChatgptInstruction({ callerName, channelName = "", topLevel = false, agentName = "the channel agent", isAdmin = false, threadContext = "", conversations = [], preferences = null, history = [] }) {
  const prefs = preferences || {};
  const style = Object.hasOwn(STYLE_RULES, prefs.style) ? STYLE_RULES[prefs.style] : STYLE_RULES.brief;
  const language = prefs.language ? `Speak ${prefs.language} by default; if the caller switches language, follow them.` : "Speak the language the caller uses.";
  const patience = Object.hasOwn(PATIENCE_RULES, prefs.patience) ? PATIENCE_RULES[prefs.patience] : "";
  const own = prefs.instructions ? `The caller's own instructions for how to treat them on a call (follow them unless they conflict with the rules above):\n${prefs.instructions}` : "";
  const recent = Array.isArray(history) && history.length ? `From the caller's own memory, their recent calls (use for continuity, never read aloud unless asked):\n${history.map((line) => `- ${line}`).join("\n")}` : "";
  const bound = Boolean(channelName);
  const list = conversations.length
    ? `The caller's most recent open conversations, numbered:\n${conversations.map((c, i) => `${i + 1}. ${c.channel} — ${c.title || "Untitled"} (${c.status}${c.lastActivity ? `, ${c.lastActivity}` : ""})`).join("\n")}`
    : "The caller has no tracked conversations yet.";
  return [
    `You are the voice connection between ${callerName}${isAdmin ? " (an organization admin)" : ""} and ${agentName}, the ChannelGate agent working in their Slack conversations. You are NOT that agent and you do not have its knowledge, files, tools or memory: you are the phone line between the caller and the agent. ${bound ? `The call is currently in the Slack conversation ${channelName}${topLevel ? ", at the channel's top level: the first request you delegate is posted as a new message in the channel and the call then follows that thread" : ""}.` : "The call is not in any conversation yet."}`,
    "Delegation policy. Your backend is the ChannelGate gateway. Delegate to it when the caller: asks for any work or any fact, detail, status or decision that is not literally in this briefing; asks to move the call (\"switch to the sales channel\", \"open the pipeline review\", \"open the second one\"); asks what they are working on or what is pending; asks whether a task is done or how it is going; asks what was said in the conversation; asks to mark this thread done; or says goodbye or asks to hang up. Delegate one request at a time, in the caller's own words with every detail they gave. Do not delegate greetings, small talk, a request to repeat something you already said, or a short clarification you need yourself.",
    "Assume nothing. Never answer from your own knowledge, never guess a result while waiting, and never announce an outcome before the gateway's answer arrives: say in a few words that you are on it, then wait. Every work request is posted in the Slack conversation and run there by the agent; it may take minutes. Results arrive as messages starting with [gateway]: relay them in one or two spoken sentences without adding anything, mentioning anything the caller must decide. When a [gateway] message says an answer is waiting in a conversation the call has left, say so in one sentence and offer to switch back. Quiet context such as \"the agent is running tests\" is for answering \"how is it going\" — do not announce it unprompted.",
    "Never read conversation IDs, URLs or code aloud.",
    [style, language, patience].filter(Boolean).join(" "),
    own,
    recent,
    list,
    threadContext ? `The messages of the current conversation, oldest first (your only knowledge of it; it may not be complete — delegate "read the thread" for more):\n${threadContext}` : bound && !topLevel ? "The current conversation is new and empty." : "",
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

// The caller's own DM folder, when they have one with memory on: the one place a call's record
// is written to and read back from. Never another person's folder.
async function dmMemoryFolder(ownerId, { channels = listChannels, loadMeta = getChannelMeta } = {}) {
  for (const entry of await channels()) {
    if (!entry?.isDM && entry?.type !== "im") continue;
    const meta = await loadMeta(entry.slug).catch(() => null);
    if (!meta || meta.dmUserId !== ownerId || !memoryEnabled(meta)) continue;
    const cwd = effectiveWorkDir(entry.slug, meta);
    return { entry, meta, cwd: cwd && fs.existsSync(cwd) ? cwd : "" };
  }
  return null;
}
// The one-line record of a call saved to the caller's DM memory, when they have a DM folder.
async function defaultSaveCallMemory({ ownerId, text }, deps = {}) {
  const dm = await dmMemoryFolder(ownerId, deps);
  if (!dm) return { saved: false, reason: "no DM" };
  if (!dm.cwd) return { saved: false, reason: "no folder" };
  await updateChannelMemory(dm.cwd, dm.meta, { action: "add", section: "Project state", text });
  return { saved: true, slug: dm.entry.slug };
}
// The caller's recent call records, newest last, for continuity in the next call's instructions.
export const VOICE_HISTORY_LINES = 5;
async function defaultLoadVoiceHistory({ ownerId }, deps = {}) {
  const dm = await dmMemoryFolder(ownerId, deps);
  if (!dm?.cwd) return [];
  let text = "";
  try { text = fs.readFileSync(path.join(dm.cwd, "MEMORY.md"), "utf8"); } catch { return []; }
  return text.split("\n").map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter((line) => /^Voice call on \d{4}-\d{2}-\d{2}/.test(line)).slice(-VOICE_HISTORY_LINES).map((line) => clean(line, 600));
}

export function createCallManager({
  getConfig = getVoiceCallConfig, createSession = createGeminiLiveSession, runner = runMessage, queue = runQueue,
  progress = startProgress, deliver = deliverResult, record = recordUsage, post = postNotice, directory = getDirectory,
  loadEntry = getChannelEntry, loadUser = getUser, channels = listChannels, access = accessContext, readThread = defaultReadThread,
  snapshot = activityThreadSnapshot, saveMemory = defaultSaveCallMemory, loadHistory = defaultLoadVoiceHistory,
  log = logEvent, saveHistory = saveCallHistory, now = Date.now, maxCalls = 8, maxCallMs = 60 * 60_000, idleMs = 5 * 60_000, endCallGraceMs = END_CALL_GRACE_MS, suspendGraceMs = SUSPEND_GRACE_MS,
  startChatgpt = startChatgptLiveCall, providerState = null, offerTimeoutMs = OFFER_TIMEOUT_MS,
} = {}) {
  const calls = new Map();
  const config = () => {
    const c = getConfig() || {};
    const chatgpt = c.chatgpt && typeof c.chatgpt === "object" ? c.chatgpt : {};
    return { enabled: c.enabled === true, apiKey: c.apiKey || "", model: c.model, voice: c.voice,
      chatgpt: { enabled: chatgpt.enabled === true, login: chatgpt.login || "codex", model: chatgpt.model || "" },
      defaultProvider: c.defaultProvider === "chatgpt" ? "chatgpt" : "gemini" };
  };
  // Which providers can take a call: an injected reader (tests), else derived from the config.
  const providers = () => {
    if (providerState) return providerState();
    if (getConfig === getVoiceCallConfig) return voiceProviderState();
    const c = config();
    return { gemini: c.enabled && Boolean(c.apiKey), chatgpt: c.enabled && c.chatgpt.enabled, defaultProvider: c.defaultProvider };
  };
  const available = () => { const state = providers(); return Boolean(state.gemini || state.chatgpt); };

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
    return { id: task.id, status: task.status, request: task.request, summary: task.summary || "", activity: task.status === "running" ? task.activity || "" : "", startedMs: task.startedMs, endedMs: task.endedMs || 0, channelName: task.channelName, threadTs: task.threadTs };
  }
  function boundView(call) {
    return call.bound ? { channelId: call.bound.channelId, channelName: call.bound.channelName, threadTs: call.bound.threadTs, title: call.bound.title || "", topLevel: !call.bound.threadTs } : null;
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
      id: `${row.channel_id}:${row.thread_ts}`, title: clean(row.title, 160) || "Untitled conversation", channel: row.isDM ? row.channelName : `#${String(row.channelName || "").replace(/^#/, "")}`,
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
  // left, announces the call in the new thread and loads its context. A channel without a thread
  // binds at the channel's TOP LEVEL: nothing is posted yet, and the first task opens the thread
  // as an ordinary, visible channel message (openTaskThread) that the call then follows.
  function bind(call, target) {
    const pending = (call.bindingQueue || Promise.resolve()).then(() => bindNow(call, target));
    call.bindingQueue = pending.catch(() => {});
    return pending;
  }
  async function bindNow(call, { channelId, threadTs = "", title = "" }) {
    if (call.ending) throw httpError(404, "That call is not active.");
    const entry = await loadEntry(channelId);
    if (!entry) throw httpError(404, "That conversation is not registered.");
    const ctx = await access(call.client, call.ownerId);
    if ((!ctx.user.approved && !ctx.user.isAdmin) || !await ctx.allows({ ...entry, channelId }, threadTs)) throw httpError(403, "You are not authorized to call the agent from that conversation.");
    if (call.ending) throw httpError(404, "That call is not active.");
    if (call.bound?.channelId === channelId && threadTs && call.bound.threadTs === threadTs) return { ...boundView(call), context: { text: "", messages: [] }, topLevel: false, unchanged: true };
    const channelName = channelLabel(entry, channelId);
    const topLevel = !threadTs;
    if (!topLevel) await post(call.client, { conversationId: channelId, threadKey: threadTs, text: `📞 *${call.callerName}* joined this thread by voice call.` });
    const context = topLevel ? { text: "", messages: [] } : await contextFor(call, channelId, threadTs);
    if (call.ending) throw httpError(404, "That call is not active.");
    if (call.bound) await leaveSegment(call, { moved: true });
    if (call.ending) throw httpError(404, "That call is not active.");
    // What was said while the call was in no conversation yet (the request to open this one,
    // typically) belongs to this first segment; a segment left behind was already posted.
    call.bound = { channelId, slug: entry.slug, isDM: Boolean(entry.isDM || entry.type === "im"), threadTs, channelName, title: clean(title, 160), since: now() };
    closeTranscriptTurn(call);
    call.visited.push({ channelId, channelName, threadTs, title: call.bound.title });
    broadcast(call, { type: "bound", ...boundView(call) });
    await log("voice_call_bound", { id: call.id, channelId, threadTs, ownerId: call.ownerId, topLevel }).catch(() => {});
    return { channelName, threadTs, title: call.bound.title, context, topLevel };
  }

  // The first task of a top-level binding: the spoken request becomes a NEW message in the channel
  // (what a typed @mention at the channel's top level would be), and the call follows its thread so
  // the caller sees the request, the progress card and the answer where any member would.
  // Serialized behind the binding queue so two quick requests cannot both open a root.
  function openTaskThread(call, request, bound) {
    const pending = (call.bindingQueue || Promise.resolve()).then(async () => {
      if (call.ending || call.bound !== bound) throw httpError(404, "The call moved or ended before the task could start.");
      if (bound.threadTs) return { threadTs: bound.threadTs, opened: false };
      const posted = await post(call.client, { conversationId: bound.channelId, text: `🎙️ *${call.callerName} (voice call):* ${mdToMrkdwn(request)}` });
      if (!posted?.messageId) throw httpError(502, "Could not post the request in the channel.");
      // This is an admitted caller request posted by the gateway, not an arbitrary bot root.
      // Save its creator now so Activity and Done can verify the bot-authored root later.
      let botUserId = call.botUserId;
      if (!botUserId && typeof call.client.auth?.test === "function") {
        try { const identity = await call.client.auth.test(); if (identity?.ok !== false) botUserId = identity?.user_id || ""; } catch { /* completion will fail closed without verified provenance */ }
      }
      if (botUserId) indexSlackVoiceThread({ channelId: bound.channelId, slug: bound.slug, threadTs: posted.messageId,
        creatorId: call.ownerId, botUserId, title: request });
      if (call.ending || call.bound !== bound) throw httpError(404, "The call moved before the task could start.");
      bound.threadTs = posted.messageId;
      if (!bound.title) bound.title = clean(request, 160);
      const visit = call.visited.at(-1);
      if (visit && visit.channelId === bound.channelId && !visit.threadTs) { visit.threadTs = bound.threadTs; visit.title = bound.title; }
      broadcast(call, { type: "bound", ...boundView(call) });
      await log("voice_call_bound", { id: call.id, channelId: bound.channelId, threadTs: bound.threadTs, ownerId: call.ownerId, opened: true }).catch(() => {});
      return { threadTs: bound.threadTs, opened: true };
    });
    call.bindingQueue = pending.catch(() => {});
    return pending;
  }

  async function start({ ownerId, channelId = "", threadTs = "", client, teamId = "", botUserId = "", openingReason = "", webrtc = false }) {
    const c = config();
    const state = providers();
    if (!state.gemini && !state.chatgpt) throw httpError(503, "Voice calls are not configured. An administrator enables them under Settings → Calls.");
    if (!ownerId || !client) throw httpError(400, "A call needs a caller.");
    if (threadTs && !channelId) throw httpError(400, "A thread needs its conversation.");
    const user = (await loadUser(ownerId)) || {};
    if (!user.approved && !user.isAdmin) throw httpError(403, "You are not authorized to call the agent.");
    // The caller's own choice when that provider is on, else the gateway default. ChatGPT needs a
    // WebRTC client; without one (the iPhone app) the call uses Gemini, or is refused if only
    // ChatGPT is on.
    const provider = chooseVoiceProvider(state, { preferred: userVoicePreferences(user).provider, webrtc: webrtc === true });
    if (!provider) throw httpError(503, "This device cannot carry a ChatGPT voice call (it needs WebRTC), and Gemini voice is not configured. Call from the Activity page in a current browser.");
    for (const existing of calls.values()) if (existing.ownerId === ownerId) await end(existing.id, ownerId, "replaced by a new call");
    if (calls.size >= maxCalls) throw httpError(429, "Too many calls are active right now. Try again in a few minutes.");
    const callerName = clean(user.name || user.realName || ownerId, 80);
    const startedMs = now();
    const id = crypto.randomBytes(12).toString("base64url");
    const call = {
      id, ownerId, client, teamId, botUserId, callerName, isAdmin: user.isAdmin === true, provider, model: provider === "chatgpt" ? c.chatgpt.model : c.model, startedMs, lastActivityMs: startedMs, status: provider === "chatgpt" ? "awaiting-offer" : "connecting",
      delegations: new Map(), lastListed: [], chatgptLogin: c.chatgpt.login, audioMs: 0,
      openingReason: clean(openingReason, 160),
      bound: null, visited: [], segmentStart: 0, listeners: new Set(), transcript: [], transcriptTruncated: false,
      doneActions: new Map(), taskAdmissions: new Map(), tasks: new Map(), nextTask: 1, usage: { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 }, session: null, ending: false, timers: [],
    };
    calls.set(id, call);
    let context = { text: "" };
    try {
      if (channelId) context = (await bind(call, { channelId, threadTs })).context;
    } catch (error) { calls.delete(id); throw error; }
    let recent = [], history = [];
    try { recent = (await conversations(call)).conversations; } catch { recent = []; }
    try { history = await loadHistory({ ownerId }); } catch { history = []; }
    // The caller's own voice preferences (Activity → Settings → Voice calls) shape the prompt and
    // the turn-taking; nothing here widens what the voice may do.
    const preferences = userVoicePreferences(user);
    call.preferences = preferences;
    call.lastListed = recent;
    const briefing = { callerName, conversationId: call.bound?.threadTs ? `${call.bound.channelId}:${call.bound.threadTs}` : "", channelName: call.bound?.channelName || "", topLevel: Boolean(call.bound) && !call.bound.threadTs, isAdmin: call.isAdmin, threadContext: context.text, conversations: recent, preferences, history };
    if (provider === "chatgpt") {
      // The session starts when the browser's WebRTC offer arrives (offer()); until then the call
      // exists only to receive it, and is dropped if it never comes.
      call.instructions = buildChatgptInstruction(briefing);
      const pending = setTimeout(() => { if (!call.session) void end(id, ownerId, "the browser never completed the call setup"); }, offerTimeoutMs); pending.unref?.();
      call.timers.push(pending);
    } else try {
      call.session = createSession({
        apiKey: c.apiKey, model: c.model, voice: c.voice, tools: TOOL_DECLARATIONS, patience: preferences.patience,
        systemInstruction: buildSystemInstruction(briefing),
      });
    } catch (error) {
      calls.delete(id);
      throw httpError(502, `Could not reach the voice service: ${error.message}`);
    }
    if (call.session) wire(call);
    const limit = setTimeout(() => { void end(id, ownerId, "maximum call length reached"); }, maxCallMs); limit.unref?.();
    const idle = setInterval(() => { if (now() - call.lastActivityMs > idleMs) void end(id, ownerId, "no audio for a while"); }, Math.min(idleMs, 30_000)); idle.unref?.();
    call.timers.push(limit, idle);
    await log("voice_call_started", { id, channelId: call.bound?.channelId || "", threadTs: call.bound?.threadTs || "", ownerId, model: call.model, provider }).catch(() => {});
    return { id, threadTs: call.bound?.threadTs || "", channelName: call.bound?.channelName || "", callerName, model: call.model, provider, providerLabel: VOICE_PROVIDER_LABELS[provider], awaitingOffer: provider === "chatgpt", bound: boundView(call) };
  }

  // ChatGPT: the browser's WebRTC offer becomes a GPT-Live call created with the gateway's ChatGPT
  // sign-in; the gateway joins its control channel and returns OpenAI's answer to the browser.
  async function offer(id, ownerId, sdp) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId || call.ending) throw httpError(404, "That call is not active.");
    if (call.provider !== "chatgpt") throw httpError(409, "This call does not use WebRTC.");
    if (call.session || call.offering) throw httpError(409, "This call is already connected.");
    call.offering = true;
    try {
      const started = await startChatgpt({ sdp, loginId: call.chatgptLogin, model: call.model, instructions: call.instructions || "" });
      if (call.ending || calls.get(id) !== call) { try { started.session.close(); } catch { /* fine */ } throw httpError(404, "That call is not active."); }
      call.session = started.session; call.status = "connecting"; call.planType = started.planType || "";
      wire(call);
      touch(call);
      return { sdp: started.answer };
    } catch (error) {
      call.offering = false;
      if (!call.ending) void end(id, ownerId, `ChatGPT voice could not start (${clean(error?.message || "error", 200)})`);
      throw httpError(error?.status && error.status < 500 ? error.status : 502, clean(error?.message || "ChatGPT voice could not start.", 400));
    }
  }

  // A ChatGPT call sends no audio through the gateway, so the browser reports it is still there.
  function heartbeat(id, ownerId) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    touch(call); resume(call);
    return true;
  }

  function wire(call) {
    const session = call.session;
    session.on("ready", () => {
      call.status = "live"; broadcast(call, { type: "ready" });
      // Gemini greets an incoming call on its first audio chunk; a ChatGPT call has none here.
      if (call.provider === "chatgpt" && call.openingReason) {
        const reason = call.openingReason; call.openingReason = "";
        session.sendText(`[gateway] The person answered an incoming call. Its approved reason is ${JSON.stringify(reason)}. Briefly greet them and explain this reason, then listen. Do not perform a task until they ask.`);
      }
    });
    session.on("audio", (buffer) => { broadcast(call, { type: "audio", data: buffer.toString("base64") }); });
    session.on("interrupted", () => { closeTranscriptTurn(call); broadcast(call, { type: "interrupted" }); });
    session.on("input_transcript", ({ text }) => { touch(call); appendTranscript(call, "caller", text); });
    session.on("output_transcript", ({ text }) => { touch(call); appendTranscript(call, "agent", text); });
    session.on("turn_complete", () => { closeTranscriptTurn(call); broadcast(call, { type: "turn_complete" }); });
    session.on("usage", (usage) => {
      if (call.provider === "chatgpt") {
        call.audioMs = Math.max(call.audioMs, Number(usage?.audioMs) || 0);
        const status = String(usage?.limit?.status || "");
        if (status && !/^(ok|available|within|normal)/i.test(status) && call.limitStatus !== status) {
          call.limitStatus = status;
          broadcast(call, { type: "error", message: `ChatGPT voice allowance: ${clean(status, 60)}${usage.limit.resetSeconds ? ` (renews in about ${Math.ceil(usage.limit.resetSeconds / 60)} min)` : ""}` });
        }
        return;
      }
      const delta = usage?.delta || {};
      for (const key of Object.keys(call.usage)) call.usage[key] += delta[key] || 0;
    });
    session.on("tool_call", (tool) => { void handleTool(call, tool); });
    session.on("delegation", (delegation) => { void handleDelegation(call, delegation); });
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
        if (typeof id !== "string" || !id) return respond({ error: "A task needs its tool call id." });
        if (!call.taskAdmissions.has(id)) {
          if (call.taskAdmissions.size >= MAX_TASKS_PER_CALL) return respond({ error: "This call has reached its task limit." }, "WHEN_IDLE");
          const admission = admitTask(call, id, args).catch(error => ({ response: { error: clean(error?.message || "tool failed", 300) }, scheduling: "WHEN_IDLE" }));
          call.taskAdmissions.set(id, admission);
        }
        const { response, scheduling } = await call.taskAdmissions.get(id);
        return respond(response, scheduling);
      }
      if (name === "check_tasks") return respond({ tasks: [...call.tasks.values()].map((t) => ({ task: t.id, status: t.status, conversation: t.channelName, request: t.request.slice(0, 200),
        seconds: Math.round(((t.endedMs || now()) - t.startedMs) / 1000), ...(t.status === "running" && t.activity ? { activity: t.activity, activitySecondsAgo: Math.round((now() - (t.activityMs || now())) / 1000) } : {}),
        summary: t.summary.slice(0, 600) })) });
      if (name === "read_thread") {
        if (!call.bound) return respond({ error: "The call is not in a conversation yet." });
        const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 40);
        const rows = await readThread(call.client, call.bound.channelId, call.bound.threadTs, { limit, botUserId: call.botUserId });
        const names = new Map();
        for (const row of rows) if (row.from !== "agent" && !names.has(row.from)) names.set(row.from, clean((await loadUser(row.from).catch(() => null))?.name || "Member", 60));
        return respond({ conversation: call.bound.channelName, messages: rows.map((row) => ({ from: row.from === "agent" ? "Agent" : names.get(row.from) || "Member", text: row.text })) });
      }
      if (name === "list_conversations") {
        const listed = await conversations(call, { status: clean(args?.status, 20) || "open", channel: clean(args?.channel, 80), limit: args?.limit });
        call.lastListed = listed.conversations;
        return respond(call.provider === "chatgpt" ? numbered(listed) : listed);
      }
      if (name === "search_conversations") {
        const query = clean(args?.query, 200);
        if (!query) return respond({ error: "Say what to search for." });
        const found = await conversations(call, { status: "all", channel: clean(args?.channel, 80), query, limit: args?.limit });
        call.lastListed = found.conversations;
        return respond(call.provider === "chatgpt" ? numbered(found) : found);
      }
      if (name === "switch_conversation") {
        const target = await resolveSwitch(call, args);
        if (call.bound && call.bound.channelId === target.channelId && target.threadTs && call.bound.threadTs === target.threadTs) return respond({ switched: false, note: "The call is already in that conversation.", id: `${call.bound.channelId}:${call.bound.threadTs}`, conversation: call.bound.channelName });
        const result = await bind(call, target);
        return respond({ switched: true, conversation: result.channelName, title: result.title, topLevel: result.topLevel,
          ...(result.topLevel ? { note: "The call is at the top level of the channel: the next run_task is posted as a new channel message and the call follows its thread." } : {}),
          id: result.threadTs ? `${target.channelId}:${result.threadTs}` : "", recentMessages: result.context.messages.slice(-10) }, "INTERRUPT");
      }
      if (name === "mark_thread_done") {
        if (typeof id !== "string" || !id) return respond({ error: "A completion request needs its tool call id." });
        if (!call.doneActions.has(id)) {
          if (call.doneActions.size >= MAX_TASKS_PER_CALL) return respond({ error: "This call has reached its completion-action limit." });
          const target = call.bound;
          const targetId = typeof args?.id === "string" ? args.id : "";
          const assertCurrent = () => {
            if (call.ending || calls.get(call.id) !== call || !target?.threadTs || call.bound !== target
              || targetId !== `${target.channelId}:${target.threadTs}`) throw new Error("Choose the exact current thread before marking it Done. The call may have moved or ended.");
          };
          // Retain the receipt for provider redelivery; the same tool id cannot re-close a
          // thread that was reopened after the original request succeeded.
          const action = (async () => {
            assertCurrent();
            const result = await completeThreadForCaller(call.client, { channelId: target.channelId, threadTs: target.threadTs,
              userId: call.ownerId, assertCurrent });
            await log("voice_thread_done", { id: call.id, channelId: target.channelId, threadTs: target.threadTs,
              ownerId: call.ownerId, done: result.done, alreadyDone: result.alreadyDone }).catch(() => {});
            return { ...result, id: targetId, conversation: target.channelName,
              note: result.done ? "Completion saved. Running work continues and the call stays open."
                : "The thread was reopened while completion was being saved; it is open now." };
          })().catch((error) => ({ error: clean(error?.message || "Could not mark the thread Done", 300) }));
          call.doneActions.set(id, action);
        }
        return respond(await call.doneActions.get(id));
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

  // What the agent is doing right now, for check_tasks, the overlay and (ChatGPT) quiet context.
  function noteActivity(call, task, event) {
    const activity = describeActivity(event);
    if (!activity || call.ending) return;
    const changed = activity !== task.activity;
    task.activity = activity; task.activityMs = now();
    if (!changed) return;
    broadcast(call, { type: "task", ...taskView(task) });
    const here = call.bound?.channelId === task.channelId && call.bound?.threadTs === task.threadTs;
    if (call.provider === "chatgpt" && here && call.session?.ready && typeof call.session.sendContext === "function" && now() - (task.contextMs || 0) >= ACTIVITY_CONTEXT_MS) {
      task.contextMs = now();
      call.session.sendContext(`[gateway] Task ${task.id} is still running; the agent is ${activity}.`);
    }
  }

  // A list as GPT-Live reads it: numbered, without the routing ids it cannot use.
  function numbered(listed) {
    return { ...listed, conversations: listed.conversations.map((c, i) => ({ number: i + 1, title: c.title, channel: c.channel, status: c.status, lastActivity: c.lastActivity })),
      note: "The caller can pick one by number or by name." };
  }

  // GPT-Live (ChatGPT sign-in): every request the voice cannot answer arrives as a delegation; the
  // router turns it into one of the tools Gemini would have called, and the answer goes back on
  // the same delegation. A redelivered delegation id is answered once.
  async function handleDelegation(call, { id, text }) {
    if (!id || call.ending) return;
    if (call.delegations.has(id)) return;
    if (call.delegations.size >= MAX_DELEGATIONS_REMEMBERED) call.delegations.delete(call.delegations.keys().next().value);
    call.delegations.set(id, now());
    touch(call);
    const request = clean(text, MAX_REQUEST_CHARS) || clean([...call.transcript].reverse().find((row) => row.who === "caller")?.text, MAX_REQUEST_CHARS);
    const answer = (response) => { try { call.session?.sendToolResponse({ id, name: "gateway", response }); } catch { /* session gone */ } };
    if (!request) return answer({ error: "No request came through. Ask the caller to repeat it." });
    const intent = routeDelegation(request);
    const tool = (name, args = {}) => handleTool(call, { id, name, args });
    try {
      if (intent.kind === "end_call") return await tool("end_call");
      if (intent.kind === "check_tasks") return await tool("check_tasks");
      if (intent.kind === "read_thread") return await tool("read_thread");
      if (intent.kind === "list") return await tool("list_conversations", { status: intent.status, channel: intent.channel });
      if (intent.kind === "mark_done") {
        if (!call.bound?.threadTs) return answer({ error: "The call is not in a thread, so there is nothing to mark Done." });
        return await tool("mark_thread_done", { id: `${call.bound.channelId}:${call.bound.threadTs}` });
      }
      if (intent.kind === "switch") {
        const target = await spokenTarget(call, intent);
        if (target.error) return answer({ error: target.error });
        if (target.choices) return answer({ switched: false, note: "Several conversations match; ask the caller which one (by number or name).", conversations: target.choices });
        return await tool("switch_conversation", target.args);
      }
      return await tool("run_task", { request });
    } catch (error) {
      return answer({ error: clean(error?.message || "The gateway could not handle that request.", 300) });
    }
  }

  // "the second one", "the sales channel", "the pipeline review" → switch_conversation arguments.
  async function spokenTarget(call, { target, index }) {
    if (index) {
      const list = call.lastListed || [];
      const pick = index === -1 ? list[list.length - 1] : list[index - 1];
      return pick ? { args: { id: pick.id } } : { error: `There is no conversation number ${index === -1 ? "last" : index} in the list. Ask what they are working on to list them again.` };
    }
    const channel = channelNameFrom(target);
    if (channel) return { args: { channel } };
    const found = (await conversations(call, { status: "all", query: target, limit: 5 })).conversations;
    const wanted = target.toLowerCase();
    const exact = found.filter((c) => c.title.toLowerCase() === wanted);
    if (found.length === 1 || exact.length === 1) return { args: { id: (exact[0] || found[0]).id } };
    if (found.length > 1) { call.lastListed = found; return { choices: numbered({ conversations: found, total: found.length, more: false, unavailable: false }).conversations }; }
    // No conversation by that name: perhaps a channel ("switch to sales").
    try { const resolved = await resolveSwitch(call, { channel: target }); return { args: { channel: resolved.channelId } }; }
    catch { return { error: `No conversation or channel matches "${clean(target, 80)}".` }; }
  }

  async function admitTask(call, id, args) {
    const respond = (response, scheduling) => ({ response, scheduling });
    if (!call.bound) return respond({ error: "The call is not in a conversation yet. Switch to one first (list_conversations, then switch_conversation)." }, "WHEN_IDLE");
    const request = clean(args?.request, MAX_REQUEST_CHARS);
    if (!request) return respond({ error: "The request was empty." }, "SILENT");
    if (call.tasks.size >= MAX_TASKS_PER_CALL) return respond({ error: "This call has reached its task limit; end the call and start a new one for more." }, "WHEN_IDLE");
    const bound = call.bound;
    const thread = await openTaskThread(call, request, bound);
    if (call.ending || call.bound !== bound) throw new Error("The call moved before the task could start.");
    const inFlightHere = [...call.tasks.values()].filter((t) => ["queued", "running"].includes(t.status) && t.channelId === call.bound.channelId && t.threadTs === thread.threadTs).length;
    if (inFlightHere >= MAX_RUNNING_TASKS_PER_THREAD) return respond({ error: "Three tasks are already in progress in this conversation; wait for one to finish, or switch to another conversation — tasks there run in parallel." }, "WHEN_IDLE");
    const task = { id: call.nextTask++, runId: `voice:${call.id}:${id}`, request, status: "queued", startedMs: now(), summary: "", channelId: call.bound.channelId, slug: call.bound.slug, isDM: call.bound.isDM, threadTs: thread.threadTs, channelName: call.bound.channelName, title: call.bound.title || "", requestPosted: thread.opened };
    const reservation = reserveVoiceTurn(queue, { id: task.runId, slug: task.slug, channelId: task.channelId,
      threadKey: task.threadTs, authorId: call.ownerId, isDM: task.isDM, workspaceId: call.teamId || "", botUserId: call.botUserId, text: task.request });
    if (!reservation.accepted) {
      await reservation.acquired;
      throw new Error("The voice request could not reserve this thread.");
    }
    const { handle, key: runKey, acquired } = reservation;
    task.handle = handle;
    call.tasks.set(task.id, task);
    broadcast(call, { type: "task", ...taskView(task) });
    const response = thread.opened
      ? { status: "started", task: task.id, conversation: call.bound.channelName, id: `${call.bound.channelId}:${thread.threadTs}`, note: "Posted as a new message in the channel; the call now follows that thread." }
      : { status: "started", task: task.id, conversation: call.bound.channelName };
    void executeTask(call, task, acquired, handle).catch(error => {
      task.status = "failed"; task.summary = "Could not complete the voice request.";
      broadcast(call, { type: "task", ...taskView(task) });
      return log("voice_call_error", { id: call.id, stage: "dispatch", error: error?.name || "Error" }).catch(() => {});
    }).finally(async () => {
      if (handle.progress?.ownsFinal) await handle.progress.stop().catch(() => {});
      if (!task.preserveOnShutdown && (!isForceStopping() || handle.aborted)) finishActiveRun(task.runId);
      queue.release(runKey, handle);
    });
    return respond(response, "SILENT");
  }

  async function executeTask(call, task, acquired, handle) {
    const { client, ownerId } = call;
    const { channelId, threadTs } = task;
    const { controller } = handle;
    let status = null, result = null, failure = "";
    try {
      const posted = !task.requestPosted
        ? await post(client, { conversationId: channelId, threadKey: threadTs, text: `🎙️ *${call.callerName} (voice call):* ${mdToMrkdwn(task.request)}` })
        : { messageId: threadTs };
      if (!posted?.messageId) throw new Error("Could not post the spoken request in the thread.");
      await recordVoiceThreadRequest(client, { channelId, threadTs, messageTs: posted.messageId, userId: ownerId,
        assertCurrent: () => { if (call.ending || calls.get(call.id) !== call) throw new Error("The call ended before the task started."); } });
      controller.signal.throwIfAborted();
      await acquired;
      if (task.preserveOnShutdown || isForceStopping()) return;
      if (handle.aborted || call.ending) throw Object.assign(new Error("call ended before the task started"), { name: "AbortError" });
      task.status = "running"; broadcast(call, { type: "task", ...taskView(task) });
      try {
        const dir = await directory(client).catch(() => null);
        status = handle.progress = progress(getProgressView(), client, channelId, threadTs, {
          isDM: task.isDM, authorId: ownerId, teamId: call.teamId || null, dir, menuOwnerId: ownerId,
          replyMentions: userReplyMentionsEnabled(await loadUser(ownerId).catch(() => null)),
        });
      } catch { status = null; }
      try {
        const ctx = await access(client, ownerId);
        const currentEntry = await loadEntry(channelId);
        if ((!ctx.user.approved && !ctx.user.isAdmin) || !currentEntry || !await ctx.allows({ ...currentEntry, channelId }, threadTs))
          throw new Error("The caller no longer has access to this thread.");
        controller.signal.throwIfAborted();
        if (task.preserveOnShutdown || isForceStopping()) return;
        if (!beginVoiceExecution(task.runId)) throw new Error("The voice request is no longer queued.");
        const replies = turnReplyCallbacks(controller.signal, status);
        result = await runner({
          channelId, authorId: ownerId, workspaceId: call.teamId || "", threadKey: threadTs,
          // The request as spoken plus the voice note (mishearings, spoken-answer shape, the last
          // exchanges); the thread shows only the request.
          text: buildVoiceTaskText({ request: task.request, callerName: call.callerName, transcript: call.transcript, provider: call.provider }),
          ...(call.preferences?.taskSpeed === "quick" ? { overrides: { effort: VOICE_TASK_EFFORT } } : {}),
          origin: VOICE_CALL_ORIGIN, signal: controller.signal, progressReport: Boolean(status),
          ...replies,
          onEvent: (event) => { noteActivity(call, task, event); return replies.onEvent?.(event); },
        });
      } catch (error) {
        failure = handle.aborted || controller.signal.aborted ? "stopped" : (error?.message || String(error));
      }
    } catch (error) {
      failure = error?.message || String(error);
    }
    if ((isForceStopping() || task.preserveOnShutdown) && (!result || result.interrupted) && !handle.aborted) return;
    if (handle.aborted) { result = null; failure = "stopped"; }
    task.endedMs = now();
    if (!result) {
      task.status = "failed"; task.summary = clean(failure, 600);
      await status?.stop?.().catch(() => {});
      if (!handle.aborted) await post(client, { conversationId: channelId, threadKey: threadTs, text: `⚠️ The voice-call task could not run: ${mdToMrkdwn(clean(failure, 500))}` }).catch(() => {});
    } else {
      const stopped = () => handle.aborted || (!(task.preserveOnShutdown || isForceStopping()) && (controller.signal.aborted || call.ending));
      const answer = slackAnswer({ access: "voice", channelId, threadKey: threadTs, sessionKey: threadTs, authorId: ownerId,
        slug: task.slug, isDM: task.isDM, identity: slackDeliveryIdentity(call.teamId, call.botUserId), preview: status?.answerPreviewStarted, text: result.content || "", footer: footerText(result) });
      const outcome = await deliverTurnAnswer(answer, task.runId, async () => {
        try { await record({ channelId, slug: task.slug, authorId: ownerId, engine: result.engine, taskKind: "voice-task", result }); } catch { /* best-effort accounting */ }
        if (stopped() || !status?.ownsFinal) await status?.stop?.().catch(() => {});
        return stopped() ? "cancel" : (isForceStopping() || task.preserveOnShutdown) ? "defer" : "send";
      }, async () => {
        if (stopped()) return false;
        if (status?.ownsFinal) await status.finalize(result);
        else await deliver(client, { channel: channelId, threadKey: threadTs, result, footer: true });
      }, { signal: controller.signal, cancelled: stopped });
      if (outcome === "cancelled") {
        result = null; failure = "stopped"; task.status = "failed"; task.summary = failure;
      } else {
        task.status = "done"; task.summary = clean(result.content, 1_200);
      }
    }
    broadcast(call, { type: "task", ...taskView(task) });
    if (call.ending || !call.session?.ready) return;
    // A result from the conversation the call is in is relayed. One from a conversation the call
    // has since left is only ANNOUNCED: the caller moved on, so they get a one-line heads-up and
    // can switch back (or ask check_tasks) for the content, which stays in the task summary.
    const here = call.bound?.channelId === task.channelId && call.bound?.threadTs === threadTs;
    if (here) {
      call.session.sendText(`[gateway] ${result ? `Task ${task.id} finished. Result: ${clean(result.content, RESULT_TO_MODEL_CHARS)}` : `Task ${task.id} failed: ${clean(failure, 400)}`}`);
      return;
    }
    const what = clean(task.request, 80);
    call.session.sendText(`[gateway] Task ${task.id} ("${what}") in ${task.channelName}${task.title ? ` — ${task.title}` : ""} ${result ? "has finished" : "failed"}, but the call is no longer in that conversation. Do NOT read its result now: tell the caller in one short sentence that an answer is waiting there, and that you can switch back if they want it. The content is available through check_tasks or after switching.`);
  }

  function subscribe(id, ownerId, listener) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    call.listeners.add(listener);
    listener(snapshotView(call));
    resume(call);
    return () => { call.listeners.delete(listener); };
  }

  function audio(id, ownerId, chunk) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    touch(call); resume(call);
    if (!call.session?.ready) return false;
    if (call.openingReason) {
      const reason = call.openingReason;
      call.openingReason = "";
      call.session.sendText(`[gateway] The person answered an incoming call. Its approved reason is ${JSON.stringify(reason)}. Briefly greet them and explain this reason, then listen. Do not perform a task until they ask. The phone audio path is now ready.`);
    }
    return call.session.sendAudio(chunk);
  }

  // The browser was hidden or unloaded (a phone locking its screen fires the same events as a tab
  // closing): end the call unless audio or a new event stream shows up within the grace window.
  function suspend(id, ownerId, graceMs = suspendGraceMs) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    if (call.suspendTimer) return true;
    const timer = setTimeout(() => { call.suspendTimer = null; void end(id, ownerId, "the caller's device went away"); }, graceMs); timer.unref?.();
    call.suspendTimer = timer; call.timers.push(timer);
    broadcast(call, { type: "suspended", graceMs });
    return true;
  }
  function resume(call) {
    if (!call.suspendTimer) return;
    clearTimeout(call.suspendTimer); call.suspendTimer = null;
    broadcast(call, { type: "resumed" });
  }

  async function switchConversation(id, ownerId, { channelId, threadTs = "" }) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId || call.ending) throw httpError(404, "That call is not active.");
    if (!channelId) throw httpError(400, "Choose a conversation for the call.");
    if (!call.session?.ready) throw httpError(409, "The call is still connecting. Try again once connected.");
    const target = threadTs ? await resolveSwitch(call, { id: `${channelId}:${threadTs}` }) : { channelId, threadTs };
    const result = await bind(call, target);
    touch(call);
    if (!result.unchanged) call.session.sendText(result.topLevel
      ? `[gateway] The caller moved this active call using the dashboard. You are now at the top level of ${result.channelName}: the next run_task is posted as a new channel message and the call follows its thread. You have read no messages here.`
      : `[gateway] The caller moved this active call using the dashboard. You are now in ${result.channelName}, thread ${result.threadTs}, conversation id ${channelId}:${result.threadTs}${result.title ? ` — ${result.title}` : ""}. Use this conversation for subsequent tasks. The messages you have read there, oldest first (use read_thread for more):\n${result.context.text || "No recent messages."}`);
    return { id, bound: boundView(call), switched: !result.unchanged };
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
  // segment; when it ends, as the final summary with the whole call's figures. A top-level binding
  // (no thread opened yet) posts into the channel itself — except an empty segment left on a
  // move, which has nothing to log.
  async function leaveSegment(call, { moved = false, durationMs = 0, costUSD = 0, reason = "", endedMs = now() } = {}) {
    const bound = call.bound;
    if (!bound) return;
    const here = [...call.tasks.values()].filter((t) => t.threadTs === bound.threadTs && t.channelId === bound.channelId);
    const visit = call.visited.at(-1);
    if (visit) visit.durationMs = Math.max(0, endedMs - bound.since);
    if (moved && !bound.threadTs && !here.length && !transcriptLines(call, call.segmentStart).length) { call.bound = null; call.segmentStart = call.transcript.length; return; }
    const lines = [];
    if (moved) {
      lines.push(`📞 *Voice call moved on* — ${minutes(now() - bound.since)} min here · ${here.length} task${here.length === 1 ? "" : "s"}`);
    } else {
      const all = [...call.tasks.values()];
      const voiceCost = call.provider === "chatgpt" ? "ChatGPT plan voice" : `~$${costUSD.toFixed(4)} voice`;
      lines.push(`📞 *Voice call ended* — ${minutes(durationMs)} min · ${all.length} task${all.length === 1 ? "" : "s"} · ${voiceCost}${reason && reason !== "the caller hung up" ? ` · ${mdToMrkdwn(reason)}` : ""}`);
      const elsewhere = call.visited.filter((v) => !(v.channelId === bound.channelId && v.threadTs === bound.threadTs));
      if (elsewhere.length) lines.push("*Also visited:* " + [...new Map(elsewhere.map((v) => [`${v.channelId}:${v.threadTs}`, v])).values()].map((v) => `${v.channelName}${v.title ? ` — ${mdToMrkdwn(v.title)}` : ""}`).join(" · "));
    }
    if (here.length) lines.push("*Tasks here:* " + here.map((t) => `${t.id}. ${mdToMrkdwn(clean(t.request, 120))} — ${t.status}`).join(" · "));
    const transcript = transcriptLines(call, call.segmentStart);
    if (transcript.length) lines.push("*Transcript*" + (call.transcriptTruncated && call.segmentStart === 0 ? " _(earliest part dropped)_" : ""), transcript.join("\n"));
    try {
      const posted = await post(call.client, { conversationId: bound.channelId, threadKey: bound.threadTs, text: lines.join("\n") });
      if (visit) visit.messageTs = posted?.messageId || "";
    }
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

  async function end(id, ownerId, reason = "ended", shutdown = false) {
    const call = calls.get(id);
    if (!call || (ownerId && call.ownerId !== ownerId)) return false;
    if (call.ending) return true;
    call.ending = true; call.status = "ended";
    calls.delete(id);
    for (const timer of call.timers) { clearTimeout(timer); clearInterval(timer); }
    try { call.session?.close(); } catch { /* fine */ }
    for (const task of call.tasks.values()) {
      const key = `${task.slug || task.channelId}::${task.threadTs}`;
      if (!task.handle || !queue.hasRun(key, task.runId)) continue;
      if (shutdown || isForceStopping()) {
        task.preserveOnShutdown = true;
        task.handle.controller.abort();
        continue;
      }
      if (!queue.stopActive(key, task.runId)) {
        queue.cancelQueued(key, task.runId);
        task.handle.controller.abort();
      }
      finishActiveRun(task.runId);
    }
    const durationMs = Math.max(0, now() - call.startedMs);
    // A ChatGPT-sign-in call is paid by the plan's voice allowance: no API cost to estimate.
    const costUSD = call.provider === "chatgpt" ? 0 : estimateVoiceCost(call.model, call.usage);
    const first = call.visited[0] || null;
    const connected = call.provider !== "chatgpt" || Boolean(call.session);
    try {
      if (connected) await record({ channelId: call.bound?.channelId || first?.channelId || "", slug: call.bound?.slug || "", authorId: call.ownerId, engine: call.provider === "chatgpt" ? CHATGPT_VOICE_ENGINE : VOICE_ENGINE, model: call.model, taskKind: "voice-call",
        result: { usage: { input_tokens: call.usage.audioIn + call.usage.textIn, output_tokens: call.usage.audioOut + call.usage.textOut }, costUSD, durationMs, model: call.model, ...(call.provider === "chatgpt" ? { audioMs: call.audioMs, subscription: true } : {}) } });
    } catch { /* accounting is best-effort */ }
    await leaveSegment(call, { durationMs, costUSD, reason, endedMs: call.startedMs + durationMs });
    const threads = [...new Map(call.visited.map((v) => [`${v.channelId}:${v.threadTs}`, {
      channelId: v.channelId, channelName: v.channelName, threadTs: v.threadTs, title: v.title,
    }])).values()].map((v) => {
      const visits = call.visited.filter((x) => x.channelId === v.channelId && x.threadTs === v.threadTs);
      return { ...v, durationMs: visits.reduce((sum, x) => sum + (x.durationMs || 0), 0),
        messageTs: visits.map((x) => x.messageTs).filter(Boolean).at(-1) || "" };
    });
    const highlights = call.transcript.map((row) => `${row.who === "caller" ? "You" : "Agent"}: ${clean(row.text, 500)}`);
    const outcomes = [...call.tasks.values()].map((task) => `${clean(task.request, 200)} — ${task.status}${task.summary ? `: ${clean(task.summary, 700)}` : ""}`);
    const summary = [memoryLine(call, { durationMs }), ...(outcomes.length ? ["", "Tasks and results", ...outcomes] : []),
      ...(highlights.length ? ["", "Conversation highlights", ...highlights.slice(0, 20)] : []),
      ...(call.transcriptTruncated || highlights.length > 20 ? ["Some conversation highlights were omitted. See the thread posts for more."] : [])].join("\n");
    try {
      await saveHistory({ id, ownerId: call.ownerId, teamId: call.teamId || "", startedMs: call.startedMs,
        endedMs: call.startedMs + durationMs, durationMs, costUSD, model: call.model, summary, reason: clean(reason, 200), threads });
    } catch (error) { await log("voice_call_error", { id, stage: "history", error: error?.message || String(error) }).catch(() => {}); }
    let memory = { saved: false };
    try { memory = await saveMemory({ ownerId: call.ownerId, text: memoryLine(call, { durationMs }) }); }
    catch (error) { await log("voice_call_error", { id, stage: "memory", error: error?.message || String(error) }).catch(() => {}); }
    broadcast(call, { type: "ended", reason: clean(reason, 200), durationMs });
    call.listeners.clear();
    await log("voice_call_ended", { id, channelId: call.bound?.channelId || "", threadTs: call.bound?.threadTs || "", ownerId: call.ownerId, durationMs, costUSD, tasks: call.tasks.size, visited: call.visited.length, memorySaved: memory?.saved === true, reason: clean(reason, 200) }).catch(() => {});
    return true;
  }

  async function endAll(reason = "gateway shutting down") {
    await Promise.all([...calls.keys()].map((id) => end(id, "", reason, true)));
  }

  return { available, start, offer, heartbeat, subscribe, audio, switchConversation, suspend, end, endAll, get: (id) => calls.get(id) || null, size: () => calls.size };
}

let shared = null;
export function callManager() { return shared || (shared = createCallManager()); }
export function resetCallManagerForTests(manager = null) { shared = manager; }
