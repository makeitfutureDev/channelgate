// Live voice calls with a channel's agent (phase 1).
//
// A call is a browser session (web/activity.js serves the page and relays audio) bound to ONE
// Slack conversation and ONE thread in it. The daemon holds the Gemini Live session, so the API
// key never reaches a browser and every tool the voice model calls runs here with the caller's
// own identity. The voice model only converses and dispatches: a `run_task` call becomes an
// ordinary engine turn in the bound thread, authored by the caller (origin `voice_call`), in the
// channel's own container under its mode, secrets and queue — exactly what a typed message in that
// thread would do. Nothing on this path widens access: a call is admitted by the same
// `accessContext().allows()` rule as the Dashboard button, and the dispatched turn re-applies the
// gateway's authorization for the author like any Slack turn.
//
// Everything said is logged: the caller's requests are posted into the thread as they are
// dispatched, and the transcript, task list and cost are posted when the call ends.
import crypto from "node:crypto";
import { getVoiceCallConfig, getProgressView } from "../../config/settings.js";
import { getChannelEntry, getUser } from "../../config/store.js";
import { userReplyMentionsEnabled } from "../../config/user-preferences.js";
import { accessContext } from "../../slack/home-threads.js";
import { postNotice } from "../../platforms/notify.js";
import { runMessage } from "../run.js";
import { runQueue } from "../../slack/message-lifecycle.js";
import { startProgress } from "../../slack/progress.js";
import { deliverResult } from "../../slack/deliver.js";
import { getDirectory } from "../../slack/directory.js";
import { mdToMrkdwn } from "../../slack/format.js";
import { recordUsage } from "../usage.js";
import { logEvent } from "../../util/logger.js";
import { createGeminiLiveSession, estimateVoiceCost } from "./gemini-live.js";

export const VOICE_CALL_ORIGIN = "voice_call";
export const VOICE_ENGINE = "gemini-live";
export const MAX_REQUEST_CHARS = 4_000;
export const MAX_TRANSCRIPT_POST_CHARS = 2_800;
const MAX_TRANSCRIPT_ENTRIES = 400;
const MAX_TASKS_PER_CALL = 20;
const MAX_RUNNING_TASKS = 3;
const CONTEXT_MESSAGES = 20;
const CONTEXT_MESSAGE_CHARS = 400;
const RESULT_TO_MODEL_CHARS = 1_500;
const END_CALL_GRACE_MS = 4_000;

export const TOOL_DECLARATIONS = Object.freeze([
  {
    name: "run_task", nonBlocking: true,
    description: "Give the channel agent a task or question to work on in the bound Slack thread. It runs in the channel's own environment with its files, tools, memory and credentials, and may take minutes. Returns immediately; the result arrives later as a message starting with [gateway].",
    parameters: { type: "object", properties: { request: { type: "string", description: "The complete request, in the caller's words, with every detail they gave." } }, required: ["request"] },
  },
  {
    name: "check_tasks",
    description: "List the tasks dispatched during this call with their status (queued, running, done, failed) and a short result summary.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_thread",
    description: "Read the most recent messages of the bound Slack thread, newest last, to answer questions about what was discussed or produced there.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "How many recent messages to read (1-40, default 15)." } } },
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

export function buildSystemInstruction({ callerName, channelName, agentName = "the channel agent", isAdmin = false, threadContext = "" }) {
  return [
    `You are the voice of ${agentName}, the ChannelGate agent for the Slack conversation ${channelName}. You are on a live voice call with ${callerName}${isAdmin ? " (an organization admin)" : ""}. The call is bound to a thread in that conversation; everything you dispatch runs there and everything said is logged there when the call ends.`,
    "Speak briefly and naturally, like a colleague on the phone: one to three sentences per reply, no lists, no code read aloud, no markdown. Ask one clarifying question when a request is ambiguous; otherwise act.",
    "You discuss, answer from the thread context you have, and hand real work to the channel agent with run_task: it runs in the channel's own environment with its files, tools, memory and credentials, and can take minutes. Pass the caller's request completely and faithfully. Say in a few words that you started it, then keep talking; never pretend a result you do not have.",
    "A message starting with [gateway] is not from the caller: it is the gateway reporting a task result or event. Summarize it for the caller in one or two spoken sentences, mentioning anything they must decide. Use check_tasks when asked about progress and read_thread when asked what was said or produced in the thread.",
    "Your own view is limited to this one thread. You do not see the rest of the conversation, other threads, other channels, running work elsewhere, memory or files. When the caller asks about any of those, say that you can only see this thread and offer to ask the channel agent, then use run_task if they agree; never guess or claim that nothing else is happening.",
    "When the caller says goodbye or asks to hang up, say a short goodbye and call end_call.",
    threadContext ? `Recent messages in the bound thread, oldest first:\n${threadContext}` : "The bound thread is new and empty.",
  ].join("\n\n");
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

export function createCallManager({
  getConfig = getVoiceCallConfig, createSession = createGeminiLiveSession, runner = runMessage, queue = runQueue,
  progress = startProgress, deliver = deliverResult, record = recordUsage, post = postNotice, directory = getDirectory,
  loadEntry = getChannelEntry, loadUser = getUser, access = accessContext, readThread = defaultReadThread,
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
      if (call.transcript.length >= MAX_TRANSCRIPT_ENTRIES) { call.transcript.shift(); call.transcriptTruncated = true; }
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
    return { id: task.id, status: task.status, request: task.request, summary: task.summary || "", startedMs: task.startedMs, endedMs: task.endedMs || 0 };
  }
  function snapshot(call) {
    return { type: "state", status: call.status, callId: call.id, startedMs: call.startedMs, channelName: call.channelName, threadTs: call.threadTs,
      transcript: call.transcript.map((row) => ({ who: row.who, text: row.text, ms: row.ms })), tasks: [...call.tasks.values()].map(taskView) };
  }

  async function start({ ownerId, channelId, threadTs = "", client, teamId = "", botUserId = "" }) {
    const c = config();
    if (!c.enabled || !c.apiKey) throw httpError(503, "Voice calls are not configured. An administrator enables them under Settings → Voice calls.");
    if (!ownerId || !channelId || !client) throw httpError(400, "A call needs a caller and a conversation.");
    const entry = await loadEntry(channelId);
    if (!entry) throw httpError(404, "That conversation is not registered.");
    const ctx = await access(client, ownerId);
    if ((!ctx.user.approved && !ctx.user.isAdmin) || !await ctx.allows({ ...entry, channelId }, threadTs)) throw httpError(403, "You are not authorized to call the agent from this conversation.");
    for (const existing of calls.values()) if (existing.ownerId === ownerId) await end(existing.id, ownerId, "replaced by a new call");
    if (calls.size >= maxCalls) throw httpError(429, "Too many calls are active right now. Try again in a few minutes.");
    const user = (await loadUser(ownerId)) || {};
    const callerName = clean(user.name || user.realName || ownerId, 80);
    const channelName = entry.isDM || entry.type === "im" ? "your direct messages" : `#${String(entry.name || channelId).replace(/^#/, "")}`;
    const startedMs = now();
    let boundThread = threadTs;
    if (boundThread) {
      await post(client, { conversationId: channelId, threadKey: boundThread, text: `📞 *${callerName}* joined this thread by voice call.` });
    } else {
      const posted = await post(client, { conversationId: channelId, text: `📞 *Voice call* — ${callerName} is talking to the agent. Requests and the transcript land in this thread.` });
      if (!posted?.messageId) throw httpError(502, "Could not open a thread for the call.");
      boundThread = posted.messageId;
    }
    let context = "";
    try {
      const rows = threadTs ? await readThread(client, channelId, boundThread, { botUserId }) : [];
      const names = new Map();
      for (const row of rows) if (row.from !== "agent" && !names.has(row.from)) names.set(row.from, clean((await loadUser(row.from).catch(() => null))?.name || "Member", 60));
      context = renderContext(rows, names);
    } catch { context = ""; }
    const id = crypto.randomBytes(12).toString("base64url");
    const call = {
      id, ownerId, channelId, slug: entry.slug, isDM: Boolean(entry.isDM || entry.type === "im"), threadTs: boundThread, client, teamId, callerName, channelName,
      model: c.model, startedMs, lastActivityMs: startedMs, status: "connecting", listeners: new Set(), transcript: [], transcriptTruncated: false,
      tasks: new Map(), nextTask: 1, usage: { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 }, session: null, ending: false, timers: [],
    };
    calls.set(id, call);
    try {
      call.session = createSession({
        apiKey: c.apiKey, model: c.model, voice: c.voice, tools: TOOL_DECLARATIONS,
        systemInstruction: buildSystemInstruction({ callerName, channelName, isAdmin: user.isAdmin === true, threadContext: context }),
      });
    } catch (error) {
      calls.delete(id);
      throw httpError(502, `Could not reach the voice service: ${error.message}`);
    }
    wire(call);
    const limit = setTimeout(() => { void end(id, ownerId, "maximum call length reached"); }, maxCallMs); limit.unref?.();
    const idle = setInterval(() => { if (now() - call.lastActivityMs > idleMs) void end(id, ownerId, "no audio for a while"); }, Math.min(idleMs, 30_000)); idle.unref?.();
    call.timers.push(limit, idle);
    await log("voice_call_started", { id, channelId, threadTs: boundThread, ownerId, model: c.model }).catch(() => {});
    return { id, threadTs: boundThread, channelName, callerName, model: c.model };
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

  async function handleTool(call, { id, name, args }) {
    const respond = (response, scheduling = "") => { try { call.session.sendToolResponse({ id, name, response, scheduling }); } catch { /* session gone */ } };
    try {
      if (name === "run_task") {
        const request = clean(args?.request, MAX_REQUEST_CHARS);
        if (!request) return respond({ error: "The request was empty." }, "SILENT");
        if (call.tasks.size >= MAX_TASKS_PER_CALL) return respond({ error: "This call has reached its task limit; end the call and start a new one for more." }, "WHEN_IDLE");
        if ([...call.tasks.values()].filter((t) => ["queued", "running"].includes(t.status)).length >= MAX_RUNNING_TASKS) return respond({ error: "Three tasks are already in progress; wait for one to finish." }, "WHEN_IDLE");
        const task = { id: call.nextTask++, request, status: "queued", startedMs: now(), summary: "" };
        call.tasks.set(task.id, task);
        broadcast(call, { type: "task", ...taskView(task) });
        respond({ status: "started", task: task.id }, "SILENT");
        void dispatch(call, task);
        return;
      }
      if (name === "check_tasks") return respond({ tasks: [...call.tasks.values()].map((t) => ({ task: t.id, status: t.status, request: t.request.slice(0, 200), summary: t.summary.slice(0, 600) })) });
      if (name === "read_thread") {
        const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 40);
        const rows = await readThread(call.client, call.channelId, call.threadTs, { limit });
        const names = new Map();
        for (const row of rows) if (row.from !== "agent" && !names.has(row.from)) names.set(row.from, clean((await loadUser(row.from).catch(() => null))?.name || "Member", 60));
        return respond({ messages: rows.map((row) => ({ from: row.from === "agent" ? "Agent" : names.get(row.from) || "Member", text: row.text })) });
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
    const { client, channelId, threadTs, ownerId } = call;
    const runKey = `${call.slug || channelId}::${threadTs}`;
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
          isDM: call.isDM, authorId: ownerId, teamId: call.teamId || null, dir, menuOwnerId: ownerId,
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
      try { await record({ channelId, slug: call.slug, authorId: ownerId, engine: result.engine, taskKind: "voice-task", result }); } catch { /* best-effort accounting */ }
      try {
        if (status?.ownsFinal) await status.finalize(result);
        else { await status?.stop?.().catch(() => {}); await deliver(client, { channel: channelId, threadKey: threadTs, result, footer: true }); }
      } catch (error) {
        await log("voice_call_error", { id: call.id, stage: "deliver", error: error?.message || String(error) }).catch(() => {});
      }
    }
    broadcast(call, { type: "task", ...taskView(task) });
    if (call.ending || !call.session?.ready) return;
    const outcome = result ? `Task ${task.id} finished. Result: ${clean(result.content, RESULT_TO_MODEL_CHARS)}` : `Task ${task.id} failed: ${clean(failure, 400)}`;
    call.session.sendText(`[gateway] ${outcome}`);
  }

  function subscribe(id, ownerId, listener) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    call.listeners.add(listener);
    listener(snapshot(call));
    return () => { call.listeners.delete(listener); };
  }

  function audio(id, ownerId, chunk) {
    const call = calls.get(id);
    if (!call || call.ownerId !== ownerId) throw httpError(404, "That call is not active.");
    touch(call);
    if (!call.session?.ready) return false;
    return call.session.sendAudio(chunk);
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
    try {
      await record({ channelId: call.channelId, slug: call.slug, authorId: call.ownerId, engine: VOICE_ENGINE, model: call.model, taskKind: "voice-call",
        result: { usage: { input_tokens: call.usage.audioIn + call.usage.textIn, output_tokens: call.usage.audioOut + call.usage.textOut }, costUSD, durationMs, model: call.model } });
    } catch { /* accounting is best-effort */ }
    try { await post(call.client, { conversationId: call.channelId, threadKey: call.threadTs, text: callSummary(call, { durationMs, costUSD, reason }) }); }
    catch (error) { await log("voice_call_error", { id, stage: "summary", error: error?.message || String(error) }).catch(() => {}); }
    broadcast(call, { type: "ended", reason: clean(reason, 200), durationMs });
    call.listeners.clear();
    await log("voice_call_ended", { id, channelId: call.channelId, threadTs: call.threadTs, ownerId: call.ownerId, durationMs, costUSD, tasks: call.tasks.size, reason: clean(reason, 200) }).catch(() => {});
    return true;
  }

  function callSummary(call, { durationMs, costUSD, reason }) {
    const tasks = [...call.tasks.values()];
    const lines = [`📞 *Voice call ended* — ${minutes(durationMs)} min · ${tasks.length} task${tasks.length === 1 ? "" : "s"} · ~$${costUSD.toFixed(4)} voice${reason && reason !== "the caller hung up" ? ` · ${mdToMrkdwn(reason)}` : ""}`];
    if (tasks.length) lines.push("*Tasks:* " + tasks.map((t) => `${t.id}. ${mdToMrkdwn(clean(t.request, 120))} — ${t.status}`).join(" · "));
    const transcript = [];
    let used = 0;
    for (const row of call.transcript) {
      const line = `> *${row.who === "caller" ? call.callerName : "Agent"}:* ${mdToMrkdwn(clean(row.text, 600))}`;
      if (used + line.length > MAX_TRANSCRIPT_POST_CHARS) { transcript.push("> _(transcript truncated)_"); break; }
      transcript.push(line); used += line.length + 1;
    }
    if (transcript.length) lines.push("*Transcript*" + (call.transcriptTruncated ? " _(earliest part dropped)_" : ""), transcript.join("\n"));
    return lines.join("\n");
  }

  async function endAll(reason = "gateway shutting down") {
    await Promise.all([...calls.keys()].map((id) => end(id, "", reason)));
  }

  return { available, start, subscribe, audio, end, endAll, get: (id) => calls.get(id) || null, size: () => calls.size };
}

let shared = null;
export function callManager() { return shared || (shared = createCallManager()); }
export function resetCallManagerForTests(manager = null) { shared = manager; }
