// Native Slack progress UI for a running turn (extracted from slack/app.js — the 2026-08 restructure notes (internal repo)
// Phase 2.1): the assistant-status shimmer, the unified tool/progress timeline card, and the
// streaming answer writer. startProgress() is the one entry point; startStreamingProgress owns
// the final message (ownsFinal:true) — the caller must call finalize(result) instead of posting.
import { mdToMrkdwn, chunkMrkdwn, resolveMentions, createMentionStream } from "./format.js";
import { createTtlSet, isSlackInvalidBlocksError, postChunkedReply, MAX_SLACK_CHARS } from "./util.js";
import { footerText, footerButtons, footerBlocks } from "./footer.js";
import { modelLabel } from "../gateway/model-info.js";
import { engineLabel } from "../engines/registry.js";
import { describeSilence } from "../engines/watchdog.js";

// Live feedback: while Claude runs, edit the placeholder every ~1.5s (Slack's chat.update rate
// limit) with the streamed text + a cursor, falling back to an activity line before any text.
// Slack Assistant working UI in an AI-app / assistant thread
// (assistant.threads.setStatus). `status` drives the compact "atlas is using…" activity line;
// `loading_messages` drives the separate, prominent loading copy above the composer. It no-ops
// gracefully outside an assistant thread or without the required scope. Pass "" to clear.
// Threads where setStatus has already been refused (not an assistant thread, missing
// assistant:write, unusable thread_ts). Once it fails it will fail every time, and the liveness
// heartbeat now calls this every 20s — without this the SDK logs the same error on a timer for the
// whole run. Bounded so a long-lived daemon can't grow it without limit.
const assistantStatusOff = createTtlSet(60 * 60 * 1000);
const SLACK_LOADING_MESSAGE_MAX_CHARS = 50;
const SLACK_LOADING_MESSAGE_MAX_COUNT = 10;
const STATUS_REASSERT_AFTER_MESSAGE_MS = 1_500;

function normalizeLoadingMessage(message) {
  const text = String(message);
  if (text.length <= SLACK_LOADING_MESSAGE_MAX_CHARS) return text;
  let clipped = "";
  for (const char of text) {
    if (clipped.length + char.length > SLACK_LOADING_MESSAGE_MAX_CHARS - 1) break;
    clipped += char;
  }
  return `${clipped}…`;
}

// Resolves true when Slack accepted the status, false when this thread can't show one. This
// temporary surface is independent of the persistent task/toolbox card in the streamed message.
export function setAssistantStatus(client, channel, threadTs, status, loadingMessages = []) {
  if (!threadTs) return Promise.resolve(false);
  const key = `${channel}:${threadTs}`;
  if (assistantStatusOff.has(key)) return Promise.resolve(false);
  const normalizedLoadingMessages = loadingMessages
    .slice(0, SLACK_LOADING_MESSAGE_MAX_COUNT)
    .map(normalizeLoadingMessage);
  return client
    .apiCall("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
      ...(normalizedLoadingMessages.length ? { loading_messages: normalizedLoadingMessages } : {}),
    })
    .then(() => true)
    .catch(() => {
      // Not an assistant thread / missing assistant:write — fall back to the placeholder edit, and
      // stop asking for this thread.
      assistantStatusOff.add(key);
      return false;
    });
}

// Turn a tool name (and assembled target) into a readable label. MCP tools come through as
// "mcp__<server>__<tool>" — show "server · tool". The target (file/command/query) is appended
// in parentheses, mirroring Claude Code's own "Read(file.js)" style.
function prettyToolName(name) {
  if (!name) return "tool";
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    const server = parts[0] || "mcp";
    const tool = parts.slice(1).join("__");
    return tool ? `${server} · ${tool}` : server;
  }
  return name;
}
function toolLabel(name, target) {
  const label = prettyToolName(name);
  return target ? `${label}(${target})` : label;
}

// Slack has been observed red-flagging a task_update row that remains in_progress for roughly
// five minutes, even while its title keeps changing. Heartbeats therefore use completed pulses
// and rotate identities with margin before that undocumented boundary. A completed pulse still
// visibly changes its elapsed/title every tick, but an abrupt daemon restart cannot strand a
// heartbeat spinner for Slack to later turn into "Something went wrong".
const HEARTBEAT_ROW_ROTATE_MS = 4 * 60_000;
const isHeartbeatRow = (id) => String(id || "").startsWith("heartbeat-");

// Slack's client also red-flags the MESSAGE itself: one that stays in the streaming state for
// roughly five minutes renders a "Something went wrong" banner even while appends keep succeeding
// (verified empirically 2026-08-09 — server-side `streaming_state` stays `in_progress` and every
// append returns ok past the boundary, so the flag is pure client rendering on stream age).
// A long turn therefore never keeps one message streaming that long: before the boundary the
// current stream is finalized and a fresh stream receives the complete compiled reply/toolbox.
// Only after that replacement is durable is the retired bot message removed. This applies to both
// a long tool phase and a long answer — message age, not task-row state, is the trigger.
const STREAM_ROLLOVER_MS = 4.5 * 60_000;

// Native streams can roll between arbitrary answer deltas. If that happens inside a fenced code
// block, close the fence in the retired fallback copy; its replacement receives the original
// compiled Markdown (and therefore the original open fence) unchanged.
function activeMarkdownFence(text) {
  let active = null;
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, marker, suffix] = match;
    if (!active) {
      // A backtick fence's info string cannot itself contain a backtick. Ignoring that malformed
      // shape avoids treating inline-ish content such as ```code``` as an opener.
      if (marker[0] === "`" && suffix.includes("`")) continue;
      active = { marker, opener: `${indent}${marker}${suffix}` };
    } else if (marker[0] === active.marker[0] && marker.length >= active.marker.length && !suffix.trim()) {
      active = null;
    }
  }
  return active;
}

// Drives ONLY the native Slack assistant status animation (the shimmering line) while a run is
// in progress — no placeholder message, no chat.update streaming. The phrase tracks progress:
// thinking summaries carry the actual reasoning gist, tool phases the tool label. Once run.js
// resolves the spawn runtime, every phase carries its model label so the requester can see what
// is doing the work before the answer/footer arrives. A fallback runtime replaces that label
// mid-turn. Slack clears this status whenever the app posts in the thread, so the liveness tick
// RE-ASSERTS the current phrase even when unchanged — a cleared line comes back within one tick
// instead of staying dark until the next phase change. stop() clears it and waits for that clear
// attempt before the answer stream is finalized.
function startStatusAnimation(client, channel, threadTs) {
  let activity = "is gathering information…";
  let runtime = "";
  let rendered = "";
  let closed = false;
  let disabled = false;
  let writeChain = Promise.resolve();
  let reassertTimer = null;
  let lastStatusQueuedAt = 0;
  const activeAgents = new Set();
  const agentAliases = new Map();
  // Liveness heartbeat. Every other status update is EVENT-driven, so a turn that goes quiet —
  // a long reasoning block, a subagent working, the API backing off under a usage limit — leaves
  // the last status frozen on screen with no way to tell "still working" from "died". Elapsed
  // time ticks on a timer instead, so movement on that line always means the run is alive.
  const startedAt = Date.now();
  const elapsedLabel = () => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return mins < 60 ? `${mins}m${String(secs % 60).padStart(2, "0")}s` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  };
  // Slack status writes used to race: a delayed activity request could complete after stop()'s
  // clear and resurrect the temporary box. Preserve the live activity sequence on one chain and
  // make the terminal clear its final write.
  const queueWrite = (status, loadingMessages, { terminal = false } = {}) => {
    if (closed && !terminal) return writeChain;
    lastStatusQueuedAt = Date.now();
    writeChain = writeChain.then(async () => {
      if (disabled && status) return;
      const accepted = await setAssistantStatus(client, channel, threadTs, status, loadingMessages);
      if (!accepted && status) disabled = true;
    });
    return writeChain;
  };
  const render = ({ force = false } = {}) => {
    if (closed || disabled) return writeChain;
    const base = runtime ? `${activity} · ${runtime}` : activity;
    // Only once the run is genuinely long: a quick answer shouldn't carry a stopwatch, and the
    // clock is only informative when the question is "is this thing still alive?".
    const status = Date.now() - startedAt >= 30_000 ? `${base} · ${elapsedLabel()}` : base;
    if (!force && status === rendered) return;
    rendered = status;
    // The prominent loading line above the composer mirrors the live activity. Slack truncates
    // it from the right in narrow agent panels, so lead with the runtime — the model stays
    // visible even when the activity phrase is clipped.
    const prominent = activity.replace(/^is\s+/, "");
    const loadingMessages = [runtime
      ? `${runtime} · ${prominent.charAt(0).toUpperCase()}${prominent.slice(1)}`
      : `${prominent.charAt(0).toUpperCase()}${prominent.slice(1)}`];
    return queueWrite(status, loadingMessages);
  };
  const setActivity = (next) => {
    activity = next;
    render();
  };
  render();
  // 20s: fast enough that a watching human sees movement well inside the stall window, slow
  // enough to stay far under Slack's update limits even on an hour-long turn. Forced, because
  // Slack wipes the status on every message the app posts — streaming appends included — and a
  // re-assert is the only way to bring it back while the phrase hasn't changed.
  const heartbeat = setInterval(() => render({ force: true }), 20_000);
  heartbeat.unref?.();
  const afterMessageActivity = ({ immediate = false } = {}) => {
    if (closed || disabled || !rendered) return;
    const refresh = () => {
      reassertTimer = null;
      render({ force: true });
    };
    if (immediate || Date.now() - lastStatusQueuedAt >= STATUS_REASSERT_AFTER_MESSAGE_MS) {
      if (reassertTimer) clearTimeout(reassertTimer);
      reassertTimer = null;
      refresh();
      return;
    }
    if (!reassertTimer) {
      reassertTimer = setTimeout(refresh, STATUS_REASSERT_AFTER_MESSAGE_MS - (Date.now() - lastStatusQueuedAt));
      reassertTimer.unref?.();
    }
  };
  return {
    onDelta: (t) => {
      if (t.trim()) setActivity("is putting it all together…");
    },
    onEvent: (e) => {
      if (e.kind === "tool_use") setActivity(`is using ${toolLabel(e.name, e.target)}…`);
      else if (e.kind === "tool_result") {
        const label = toolLabel(e.name, e.target);
        setActivity(e.status === "failed" ? `hit an error in ${label}…` : `finished ${label}…`);
      }
      else if (e.kind === "thinking") setActivity(e.summary ? `is thinking — ${e.summary}` : "is thinking…");
      else if (e.kind === "quiet") setActivity(`is waiting — ${quietDetail(e)}…`);
      // What the harness itself is complaining about (retry, backoff, sign-in). Without it a turn
      // that stalls before its first token can only say "starting".
      else if (e.kind === "engine_note" && e.text) setActivity(`is waiting — ${e.text}`);
      // A harness-level notice written for the reader (currently the stop hook's safety valve).
      else if (e.kind === "notice" && e.text) setActivity(`⚠️ ${e.text}`);
      else if (e.kind === "run_queued")
        setActivity(e.position > 1 ? `is queued — ${e.position} runs ahead…` : "is queued — every run slot is busy…");
      else if (e.kind === "agent_activity") {
        const identities = [e.id, ...(e.aliasIds || [])].filter(Boolean).map(String);
        const canonical = identities.map((id) => agentAliases.get(id)).find(Boolean) || identities[0];
        for (const id of identities) agentAliases.set(id, canonical);
        if (e.status === "running") activeAgents.add(canonical);
        else activeAgents.delete(canonical);
        if (activeAgents.size) {
          setActivity(`is coordinating ${activeAgents.size} ${activeAgents.size === 1 ? "agent" : "agents"}…`);
        } else {
          setActivity("is gathering information…");
        }
      }
    },
    onRuntimeResolved: ({ engine = "", model = "" } = {}) => {
      if (!engine && !model) return;
      runtime = model
        ? modelLabel({ engine, model })
        : `${engineLabel(engine) || engine} CLI default`;
      render();
    },
    afterMessageActivity,
    stop: () => {
      if (closed) return writeChain;
      closed = true;
      clearInterval(heartbeat);
      if (reassertTimer) clearTimeout(reassertTimer);
      reassertTimer = null;
      rendered = "";
      return queueWrite("", [], { terminal: true });
    },
  };
}

// Maps tool, subagent, TodoWrite, and semantic progress-report events onto Slack's native streaming
// `plan_update`/`task_update` timeline — the collapsible,
// checkmarked "steps" card Slack renders inline in an agent message. Each tool call becomes a row
// that starts `in_progress` and flips to `complete` when the next step (or the answer text) begins;
// a TodoWrite plan snapshot upserts a row per item carrying its real pending/in_progress/complete
// state, keyed by item text so repeated snapshots update the same rows in place. `push(chunks)`
// enqueues an appendStream on the shared stream chain (ordering with the answer text is preserved);
// the caller guards it so a workspace/app that can't render task chunks just loses the card while
// the answer keeps streaming. Titles are clamped — Slack truncates long ones, but we cap to stay
// safely under the field limit.
function createTaskTimeline(push) {
  let seq = 0;
  const rows = new Map(); // id → task_update fields; insertion order is the display order
  const todoIds = new Map(); // todo text → stable row id across repeated TodoWrite snapshots
  const toolRows = new Map(); // engine tool-use id → native row id for immediate result updates
  const agentRows = new Map(); // engine activity id → { rowId, state }
  let activeToolId = null; // the tool row currently shown as in_progress
  let latestHeartbeatId = null;
  let reportTitle = "";
  let latestReport = null;
  const clamp = (s) => {
    const t = String(s || "").trim() || "working";
    return t.length > 240 ? `${t.slice(0, 239)}…` : t;
  };
  const chunkFor = (id) => {
    const r = rows.get(id);
    return { type: "task_update", id, ...r };
  };
  const emit = (ids) => {
    if (ids.length) push(ids.map(chunkFor));
  };
  const compactCount = (value) => {
    const count = Number(value);
    if (!Number.isFinite(count)) return "";
    if (Math.abs(count) < 1_000) return String(Math.round(count));
    if (Math.abs(count) < 1_000_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  };
  const agentTitle = (state) => {
    const failed = state.status === "failed" || state.status === "stopped" || state.status === "incomplete";
    const parts = [`${failed ? "⚠️ " : ""}🤖 ${state.name || "agent"}`];
    if (state.description) parts.push(state.description);
    if (Number.isFinite(Number(state.elapsedMs))) parts.push(`${Math.round(Number(state.elapsedMs) / 1000)}s`);
    if (Number.isFinite(Number(state.tokens))) parts.push(`${compactCount(state.tokens)} tokens`);
    if (Number.isFinite(Number(state.toolUses))) parts.push(`${Math.round(Number(state.toolUses))} tools`);
    if (state.lastTool) parts.push(`last: ${state.lastTool}`);
    if (state.status === "failed") parts.push("failed");
    else if (state.status === "stopped") parts.push("stopped");
    else if (state.status === "incomplete") parts.push(state.terminalNote || "status unavailable");
    return clamp(parts.join(" · "));
  };
  return {
    // The current plan title and every row state in display order. Live appends build the card as
    // work happens; finalize/stop resend this snapshot to seal it into Slack history.
    snapshot() {
      return [
        ...(reportTitle ? [{ type: "plan_update", title: reportTitle }] : []),
        ...[...rows.keys()].map(chunkFor),
      ];
    },
    // A stream rollover closes one durable message while the run continues in another. Seal the
    // fallback copy without mutating the live timeline: active rows become terminal there, then
    // snapshot() reseeds the complete real state into its replacement.
    retirementSnapshot() {
      return [
        ...(reportTitle ? [{ type: "plan_update", title: reportTitle }] : []),
        ...[...rows.keys()].map((id) => {
          const chunk = chunkFor(id);
          return chunk.status === "in_progress" ? { ...chunk, status: "complete" } : chunk;
        }),
      ];
    },
    // A completed pulse carrying elapsed time. Every other row is event-driven, so a quiet turn
    // otherwise shows a frozen card identical to a dead run. Updating a COMPLETE row still makes
    // the liveness title tick without keeping a task open across Slack's observed five-minute
    // failure boundary. Rotate the identity as a second guard against undocumented row-age rules.
    heartbeat(label, slot = 0) {
      const id = `heartbeat-${slot}`;
      const title = clamp(label);
      if (rows.get(id)?.title === title) return;
      rows.set(id, { title, status: "complete" });
      latestHeartbeatId = id;
      emit([id]);
    },
    // Turn is closing: relabel the latest pulse. Its status is already terminal, which makes this
    // safe even when a restart prevents this best-effort cosmetic update from running.
    heartbeatDone(label) {
      const id = latestHeartbeatId;
      if (!id || !rows.has(id)) return;
      rows.set(id, { title: clamp(label || rows.get(id).title), status: "complete" });
      emit([id]);
    },
    // A tool is about to run: finish the previous tool row, then open a row for this one.
    tool(name, target, eventId = "") {
      const changed = [];
      if (activeToolId) {
        rows.get(activeToolId).status = "complete";
        changed.push(activeToolId);
      }
      const id = `tool-${++seq}`;
      rows.set(id, { title: clamp(toolLabel(name, target)), status: "in_progress" });
      if (eventId) toolRows.set(String(eventId), id);
      activeToolId = id;
      changed.push(id);
      emit(changed);
    },
    // The harness reports a result separately from the call. Close that exact row immediately so
    // the durable toolbox and temporary status stop claiming a finished tool is still running.
    // Raw result content never enters this event vocabulary — only terminal success/failure.
    //
    // A failed tool is recorded in the row's TITLE, never in its status. Slack derives the whole
    // card's header from the aggregate row statuses: one row with `status: "error"` collapses the
    // entire toolbox to a red "Something went wrong" banner, even when the turn went on to succeed
    // and every other row is a checkmark. A grep that matched nothing is not a failed turn. The
    // subagent path already resolves this the same way (⚠️ + "failed" in the title, terminal status
    // `complete`); `error` stays reserved for a step the agent itself declares failed.
    toolResult(eventId = "", status = "completed") {
      const id = eventId ? toolRows.get(String(eventId)) : activeToolId;
      if (!id || !rows.has(id)) return;
      const previous = rows.get(id);
      const failed = status === "failed";
      const next = {
        ...previous,
        ...(failed && !/ · failed$/.test(previous.title) ? { title: clamp(`⚠️ ${previous.title} · failed`) } : {}),
        status: "complete",
      };
      rows.set(id, next);
      if (activeToolId === id) activeToolId = null;
      if (previous.title !== next.title || previous.status !== next.status) emit([id]);
    },
    // A harness notice the reader must actually see (the stop hook's safety valve announcing that
    // background subagent work is being abandoned). It gets its own terminal row rather than the
    // transient status line, because the whole point is that it must survive the turn.
    notice(text) {
      const body = String(text || "").trim();
      if (!body) return;
      const id = `notice-${++seq}`;
      rows.set(id, { title: clamp(`⚠️ ${body}`), status: "complete" });
      emit([id]);
    },
    // A TodoWrite snapshot: upsert one row per item with its real status, emitting only the rows
    // whose status/text actually changed so a re-sent identical plan makes no API calls.
    todos(items) {
      const changed = [];
      for (const it of items) {
        const status =
          it.status === "completed" || it.status === "complete"
            ? "complete"
            : it.status === "in_progress"
              ? "in_progress"
              : "pending";
        let id = todoIds.get(it.content);
        if (!id) {
          id = `plan-${++seq}`;
          todoIds.set(it.content, id);
        }
        const title = clamp(it.content);
        const prev = rows.get(id);
        if (!prev || prev.status !== status || prev.title !== title) {
          rows.set(id, { title, status });
          changed.push(id);
        }
      }
      emit(changed);
    },
    // Semantic progress-report stages belong in the SAME durable plan/toolbox as low-level tools. Slack's
    // streaming API supports `plan_update` plus rich `task_update` chunks, so publishing a third
    // standalone Plan message is unnecessary and violates the two-surface UI contract.
    report(snapshot) {
      latestReport = {
        title: snapshot.title,
        steps: snapshot.steps.map((step) => ({
          ...step,
          sources: (step.sources || []).map((source) => ({ ...source })),
        })),
      };
      const chunks = [];
      const nextTitle = clamp(snapshot.title);
      if (nextTitle !== reportTitle) {
        reportTitle = nextTitle;
        chunks.push({ type: "plan_update", title: reportTitle });
      }
      for (const step of latestReport.steps) {
        const id = `report-${step.id}`;
        const next = {
          title: clamp(step.title),
          status: step.status,
          ...(step.details ? { details: step.details } : {}),
          ...(step.output ? { output: step.output } : {}),
          ...(step.sources?.length
            ? { sources: step.sources.map((source) => ({ type: "url", url: source.url, text: source.text })) }
            : {}),
        };
        if (JSON.stringify(rows.get(id)) === JSON.stringify(next)) continue;
        rows.set(id, next);
        chunks.push(chunkFor(id));
      }
      if (chunks.length) push(chunks);
    },
    // A stop is the reader's own decision, not a malfunction, so the abandoned step closes as a
    // terminal row whose title and output say it was interrupted — flagging it `error` would paint
    // the whole card with Slack's "Something went wrong" header for a turn that did what was asked.
    interruptReport() {
      const active = latestReport?.steps.find((step) => step.status === "in_progress");
      if (!active) return;
      const interruption = "Interrupted before completion.";
      this.report({
        ...latestReport,
        steps: latestReport.steps.map((step) => step.id === active.id
          ? {
              ...step,
              status: "complete",
              title: /^⚠️ /.test(step.title || "") ? step.title : `⚠️ ${step.title || "step"}`,
              output: step.output ? `${step.output}\n${interruption}` : interruption,
            }
          : step),
      });
    },
    // Native subagents are parallel: each engine activity id owns one stable row, and updating or
    // completing one row never changes its siblings. Sparse lifecycle events merge into the last
    // known state so progress messages can add usage without repeating the task description.
    agent(event) {
      const identities = [event?.id, ...(event?.aliasIds || [])]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      if (!identities.length) return;
      let entry = identities.map((key) => agentRows.get(key)).find(Boolean);
      if (!entry) {
        entry = { rowId: `agent-${++seq}`, state: { status: "running" } };
      }
      for (const key of identities) agentRows.set(key, entry);
      for (const field of ["engine", "name", "description", "status", "elapsedMs", "tokens", "toolUses", "lastTool"]) {
        if (event[field] !== undefined && event[field] !== null && event[field] !== "") {
          entry.state[field] = event[field];
        }
      }
      const status = ["completed", "failed", "stopped"].includes(entry.state.status)
        ? "complete"
        : "in_progress";
      const next = { title: agentTitle(entry.state), status };
      const previous = rows.get(entry.rowId);
      if (previous?.title === next.title && previous?.status === next.status) return;
      rows.set(entry.rowId, next);
      emit([entry.rowId]);
    },
    // A joined turn should normally carry a terminal lifecycle event. If an engine version omits
    // it, close the Slack spinner explicitly and make the uncertainty visible instead of silently
    // pretending the child succeeded.
    finishAgents(reason = "status unavailable") {
      const changed = [];
      for (const entry of new Set(agentRows.values())) {
        if (entry.state.status !== "running") continue;
        entry.state.status = reason === "stopped" ? "stopped" : "incomplete";
        entry.state.terminalNote = reason;
        rows.set(entry.rowId, { title: agentTitle(entry.state), status: "complete" });
        changed.push(entry.rowId);
      }
      emit(changed);
    },
    // The active tool has finished — the model started writing/thinking, or the run ended.
    flushActive() {
      if (!activeToolId) return;
      rows.get(activeToolId).status = "complete";
      const id = activeToolId;
      activeToolId = null;
      emit([id]);
    },
  };
}

// NATIVE STREAMING mode. Instead of posting a placeholder and editing it (the "log" path Slack
// now recommends migrating away from), this writes the answer LIVE via the streaming API:
// chat.startStream → appendStream(markdown_text) → stopStream. The run-stats footer is appended as
// a block at stop. Unlike the other progress modes this OWNS the final message (ownsFinal:true), so
// the caller must NOT post its own reply — it calls finalize(result) instead.
//
// The ChatStreamer buffers markdown in-memory and only calls the API every ~buffer_size chars (or
// when a chunk forces a flush), which is how Slack expects streaming to stay under rate limits.
// All append/stop calls are serialized through a promise chain (the streamer's buffer is not
// concurrency-safe). Any API failure flips `failed`, and finalize() falls back to a plain
// postMessage so an answer is never lost if streaming is unavailable (missing scope / not enabled).
function startStreamingProgress(client, { channel, threadTs, isDM, authorId, teamId, dir }) {
  // Resolve "@Name" → "<@id>" as the answer streams in; the holdback buffer keeps a mention whole
  // even when it straddles two delta slices (flushed in finalize).
  const mentionStream = createMentionStream(dir);
  // Ping the requester at the very end of the answer so they get a Slack notification even in a busy
  // channel thread they aren't actively watching. Skipped in DMs — the peer is already notified of
  // every message there, and tagging the sole other participant just reads as noise. Guarded on
  // authorId so an automation post with no user id never yields a broken "<@undefined>".
  const requesterTag = !isDM && authorId ? `<@${authorId}>` : "";
  const streamArgs = {
    channel,
    thread_ts: threadTs,
    // Group every tool/plan row into ONE collapsible card instead of a separate box per step.
    // Slack's task display mode: "timeline" (the default) narrates each task_update as its own
    // box — space-hungry when a run makes many tool calls — while "plan" collects them all into a
    // single expandable "plan" card. We stream the same task_update chunks either way; this only
    // changes how Slack lays them out. Forwarded verbatim to chat.startStream by the streamer.
    task_display_mode: "plan",
    // Required by the API outside a DM; harmless inside one.
    ...(authorId ? { recipient_user_id: authorId } : {}),
    ...(teamId ? { recipient_team_id: teamId } : {}),
  };
  // `let`, not `const`: a long run ROLLS OVER to a fresh streaming message before
  // Slack's client red-flags this one (see STREAM_ROLLOVER_MS below). Closures always read the
  // current streamer, so queued appends after a rollover land in the new message.
  let streamer = client.chatStream(streamArgs);
  // `chatStream()` only constructs the SDK helper; Slack does not create a message until an append
  // flushes (or stop is called). Start the age clock only after the helper exposes a real `ts`.
  let streamStartedAt = null;
  let streamMarkdown = "";
  let rolloverQueued = false;
  const retiredStreamTs = new Set();
  let shimmer = null;

  let chain = Promise.resolve();
  let rawLen = 0; // raw answer chars accepted into the live stream
  let streamed = ""; // the accepted deltas themselves — finalize() prefix-checks against the final content
  let truncated = false; // the live stream hit the length cap — the rest arrives as follow-up messages
  let failed = false;
  let stopped = false;
  let terminal = null; // "finalize" or "stop" once the run starts closing
  // Streaming failures used to be swallowed whole, which made field problems (e.g. Slack's
  // undocumented limit on how long a message may stay in the streaming state) undiagnosable from
  // the logs. One warn per failure site per turn — never the payload, only the error code.
  const reportedStreamFailures = new Set();
  const reportStreamFailure = (site, error) => {
    if (reportedStreamFailures.has(site)) return;
    reportedStreamFailures.add(site);
    const raw = error?.data?.error || error?.code || "unknown_error";
    const code = String(raw).replace(/[^a-zA-Z0-9_.:\-]/g, "_").slice(0, 80) || "unknown_error";
    console.warn(`[slack] answer stream ${site} failed (${code}) channel=${channel}`);
  };
  // A replacement is made durable before its predecessor is removed. Failed cleanup is harmless:
  // both complete copies remain readable, the timestamp stays queued for one terminal retry, and
  // only a sanitized API code is logged. This is cosmetic cleanup, never answer delivery.
  const cleanupRetiredStreams = async () => {
    if (typeof client.chat?.delete !== "function") return;
    for (const ts of [...retiredStreamTs]) {
      try {
        await client.chat.delete({ channel, ts });
        retiredStreamTs.delete(ts);
        shimmer?.afterMessageActivity?.({ immediate: true });
      } catch (error) {
        reportStreamFailure("rollover cleanup", error);
      }
    }
  };
  // All append sites use this wrapper so the rollover clock follows the actual Slack message,
  // not the earlier construction of the SDK ChatStreamer. Capture the current helper at execution
  // time: the shared promise chain decides whether an append belongs before or after a rollover.
  const appendCurrent = async (payload) => {
    const target = streamer;
    const response = await target.append(payload);
    if (target === streamer) {
      if (typeof payload?.markdown_text === "string") streamMarkdown += payload.markdown_text;
      if (target.ts && streamStartedAt === null) streamStartedAt = Date.now();
    }
    // Slack clears assistant status whenever the app writes in the thread. Restore the current
    // live phase after durable toolbox updates immediately; answer deltas use a bounded cadence
    // so a fast token stream cannot turn into one status API request per token.
    shimmer?.afterMessageActivity?.({ immediate: Boolean(payload?.chunks?.length) });
    return response;
  };
  const enqueue = (fn) => {
    chain = chain.then(fn).catch((error) => {
      reportStreamFailure("append", error);
      failed = true;
    });
    return chain;
  };

  // Native tool-call / task-planner card, streamed into the same message as the answer. Its
  // appends ride the SAME chain (so a task_update never races the answer text), but a failure only
  // disables the card — never the answer: some workspaces/apps can't render task chunks, and we
  // degrade to plain streamed text there instead of falling back off streaming entirely.
  let timelineOff = false;
  // Slack renders the plan card where its FIRST chunk lands, so a live card is necessarily ABOVE
  // the answer — where a long reply pushes it out of view. Deferring the whole card to the end
  // fixes the position but costs every live signal (ticking heartbeat, quiet reports, subagent
  // tracking): during the run the message would show nothing at all. That trade isn't worth it,
  // so the card stays live and a compact recap is appended AFTER the answer instead. Flip
  // DEFER_CARD to true to move the card itself and accept the loss.
  const DEFER_CARD = false;
  const pushTimeline = (chunks) => {
    if (timelineOff || DEFER_CARD) return;
    // Serialized on the shared chain, so a flushActive() enqueued during finalize still lands
    // before streamer.stop() closes the message; a post-stop append would just throw and disable.
    chain = chain.then(() => appendCurrent({ chunks })).catch((error) => {
      reportStreamFailure("task-card append", error);
      timelineOff = true;
    });
  };
  // The toolbox is durable message content regardless of whether the thread supports the
  // temporary assistant status. Every tool/plan/subagent row therefore streams immediately and
  // remains in Slack history after stopStream finalizes the answer.
  const timeline = createTaskTimeline(pushTimeline);
  // Pre-text feedback: keep Slack's separate temporary assistant status running for
  // thinking/tool steps where the thread supports it. It is explicitly cleared at termination.
  shimmer = startStatusAnimation(client, channel, threadTs);
  // Liveness row, ticking independently of engine events. It remains part of the durable toolbox;
  // the temporary assistant status mirrors it in assistant threads and no-ops elsewhere. The row
  // carries the last thing we actually saw, so a stuck run says WHAT it is stuck on.
  const runStartedAt = Date.now();
  let lastActivity = "starting";
  // Subagents are the longest silent stretches a turn has: the parent emits nothing at all while
  // a child works. Track which are still running so the row reports THAT rather than whatever
  // event happened to be last before the silence began.
  const runningAgents = new Set();
  // Set once the run reports where it resolved to (onRuntimeResolved). A turn behind an OS
  // boundary the daemon owns starts slower and stops differently, so the liveness row says so —
  // the elapsed seconds mean something different when the engine is not a process on this host.
  // A declared capability, never a backend id: this layer must not know what backends exist.
  let runtimeSuffix = "";
  const heartbeatLabel = () => {
    const secs = Math.round((Date.now() - runStartedAt) / 1000);
    const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
    const detail = runningAgents.size
      ? `${runningAgents.size} ${runningAgents.size === 1 ? "subagent" : "subagents"} running · ${lastActivity}`
      : lastActivity;
    return `⏳ Working — ${elapsed}${runtimeSuffix} · ${detail}`;
  };
  // Replace the current streaming message before Slack's ~5-minute client flag. The successor is
  // a COMPLETE copy of the compiled answer and toolbox, not a continuation fragment: once it is
  // durable the retired message is deleted. The user therefore sees one authoritative reply while
  // every individual native stream remains younger than Slack's undocumented client-side limit.
  const maybeRollover = () => {
    if (terminal || failed || stopped || rolloverQueued || streamStartedAt === null) return;
    if (Date.now() - streamStartedAt < STREAM_ROLLOVER_MS) return;
    rolloverQueued = true;
    const hadAnswer = rawLen > 0;
    chain = chain
      .then(async () => {
        if (terminal || failed || stopped) return;
        const retiring = streamer;
        const retiringTs = retiring.ts;
        const compiledMarkdown = streamMarkdown;
        const fence = hadAnswer ? activeMarkdownFence(streamMarkdown) : null;
        const terminalChunks = timelineOff ? [] : timeline.retirementSnapshot();
        try {
          await retiring.stop({
            markdown_text: hadAnswer
              ? `${fence ? `\n${fence.marker}` : ""}\n\n_⏳ Refreshing the live reply below…_`
              : "_⏳ Refreshing live progress below…_",
            ...(terminalChunks.length ? { chunks: terminalChunks } : {}),
          });
          shimmer?.afterMessageActivity?.({ immediate: true });
        } catch (error) {
          // The fresh stream is what matters. A failed close is diagnostic, but it must not turn
          // a healthy engine run into a failed answer delivery.
          reportStreamFailure("rollover stop", error);
        }
        streamer = client.chatStream(streamArgs);
        streamStartedAt = null;
        streamMarkdown = "";
        const chunks = timelineOff ? [] : timeline.snapshot();
        await appendCurrent({
          ...(compiledMarkdown ? { markdown_text: compiledMarkdown } : {}),
          ...(chunks.length ? { chunks } : {}),
        });
        // appendCurrent() must expose a real successor ts before deletion; if a nonstandard client
        // buffers without starting, leave the retired copy intact and retry on the next rollover.
        if (retiringTs && streamer.ts) {
          retiredStreamTs.add(retiringTs);
          await cleanupRetiredStreams();
        }
      })
      .catch((error) => {
        // Once the predecessor has been stopped, a successor that cannot be made durable is no
        // longer a healthy native-stream path. Force finalize() through the complete classic
        // fallback instead of trying to stop an empty/broken replacement and losing the answer.
        reportStreamFailure("rollover", error);
        failed = true;
      })
      .finally(() => { rolloverQueued = false; });
  };
  const beat = () => {
    if (stopped || failed || terminal) return;
    maybeRollover();
    const slot = Math.floor((Date.now() - runStartedAt) / HEARTBEAT_ROW_ROTATE_MS);
    timeline.heartbeat(heartbeatLabel(), slot);
  };
  // Deliberately not beaten eagerly: the row must not append before the stream is posted, and a
  // run that answers quickly should never show a "Working" row at all. The first tick lands one
  // interval in — by which point silence is the thing worth reporting.
  const heartbeatTimer = setInterval(beat, 20_000);
  heartbeatTimer.unref?.();
  // Heartbeat pulses are complete from the moment they are emitted, so success, delivery
  // failure, or an abrupt restart cannot strand an in_progress row. The terminal path still
  // relabels the latest pulse for a clear successful/stopped final state.
  // A one-line recap appended AFTER the answer, so a long reply still ends with what the run did
  // and how long it took — the plan card itself is pinned above by Slack and scrolls out of view.
  // Text, not a task_update: appending more rows would just update the same (top) card.
  let recapDone = false;
  const flushCard = () => {
    if (recapDone) return;
    recapDone = true;
    if (DEFER_CARD) {
      const chunks = timeline.snapshot();
      if (chunks.length) chain = chain.then(() => appendCurrent({ chunks })).catch((error) => { reportStreamFailure("task-card append", error); timelineOff = true; });
      return;
    }
    const steps = timeline.snapshot()
      .filter((chunk) => chunk.type === "task_update" && !isHeartbeatRow(chunk.id))
      .length;
    if (!steps) return; // nothing ran worth recapping (a plain answer)
    const secs = Math.round((Date.now() - runStartedAt) / 1000);
    const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
    const line = `\n\n_🧰 ${steps} ${steps === 1 ? "step" : "steps"} · ${elapsed} — details in the card above._`;
    chain = chain.then(() => appendCurrent({ markdown_text: line })).catch((error) => reportStreamFailure("recap append", error));
  };

  const stopHeartbeat = (label) => {
    clearInterval(heartbeatTimer);
    timeline.heartbeatDone(label || "✅ Done");
  };

  return {
    ownsFinal: true,
    onRuntimeResolved: (runtime) => {
      if (runtime?.isolated) runtimeSuffix = " · container";
      shimmer.onRuntimeResolved?.(runtime);
    },
    onDelta: (t) => {
      shimmer.onDelta?.(t);
      if (!t || stopped || failed || truncated) return;
      // The model is writing the answer now → the last tool row is done.
      if (t.trim()) timeline.flushActive();
      if (rawLen + t.length > MAX_SLACK_CHARS) {
        // Cap the live stream at a whole-delta boundary so `rawLen` stays a clean index into the
        // final content; everything past it is delivered by finalize() as chunked follow-ups —
        // nothing is silently dropped, and the reader sees a marker instead of a dead stop.
        truncated = true;
        enqueue(() => appendCurrent({ markdown_text: "\n\n…_(long answer — continued below)_" }));
        return;
      }
      rawLen += t.length;
      streamed += t;
      const chunk = mentionStream.push(t); // resolve mentions; may hold back a partial "@name"
      if (chunk) enqueue(() => appendCurrent({ markdown_text: chunk }));
    },
    onEvent: (e) => {
      if (stopped) return;
      shimmer.onEvent?.(e);
      if (e.kind === "tool_use") {
        lastActivity = toolLabel(e.name, e.target);
        timeline.tool(e.name, e.target, e.id);
      } else if (e.kind === "tool_result") {
        const label = toolLabel(e.name, e.target);
        lastActivity = e.status === "failed" ? `${label} failed` : `finished ${label}`;
        timeline.toolResult(e.id, e.status);
      } else if (e.kind === "todos") timeline.todos(e.items);
      else if (e.kind === "agent_activity") {
        const agentKey = String(e.id || e.name || "");
        if (e.status === "running") {
          runningAgents.add(agentKey);
          lastActivity = `launched ${e.name || "subagent"}`;
        } else {
          runningAgents.delete(agentKey);
          lastActivity = `${e.name || "subagent"} ${e.status || "finished"}`;
        }
        timeline.agent(e);
      } else if (e.kind === "thinking") {
        lastActivity = e.summary ? `thinking — ${e.summary}` : "thinking";
        timeline.flushActive();
      } else if (e.kind === "notice") {
        // Durable row, not just a status blip: the stop-hook safety valve says work is being
        // abandoned, and that has to still be readable once the turn has finished.
        lastActivity = e.text;
        timeline.notice(e.text);
      } else if (e.kind === "run_queued") {
        // Position, not just "queued": the number falling is what tells a waiting user the queue
        // is actually moving rather than stuck.
        const place = e.position > 1 ? ` — ${e.position} ahead of this one` : "";
        lastActivity = `waiting for a free run slot${place}`;
        beat();
      } else if (e.kind === "quiet") {
        // The engine has gone silent but is still alive (model thinking, subagent working, or
        // provider backoff). Say so explicitly rather than letting the card look abandoned.
        lastActivity = `no output for ${describeSilence(e.silentMs)} — ${stillLogging(e) ? "the harness is still logging" : "still connected"}`;
        beat();
      } else if (e.kind === "engine_note" && e.text) {
        // The harness's own diagnostic (retry, backoff, sign-in trouble), already redacted and
        // capped by the runner. A turn that stalls before its first token would otherwise sit on
        // "starting" for as long as the user's patience lasts — which is how a dead credential
        // came to look exactly like a slow model.
        lastActivity = e.text;
        beat();
      }
      else if (e.kind === "report_progress") timeline.report(e);
    },
    // Finish the stream as the final message: flush any buffered text, append the full answer if
    // nothing streamed (e.g. a tool-only run), then stopStream with the footer block. Any text
    // the live stream never carried (past the cap) is posted as chunked follow-up messages so a
    // long reply always arrives complete. Falls back to a chunked postMessage if streaming failed
    // at any point.
    finalize: async (result) => {
      if (terminal) {
        await chain;
        return;
      }
      terminal = "finalize";
      stopped = true;
      stopHeartbeat();
      flushCard();
      await shimmer.stop?.();
      const fullRaw = result?.content || "";
      const full = fullRaw.trim();
      // Release any "@name" the holdback buffer was still waiting on (already counted in rawLen).
      const remainder = mentionStream.flush();
      if (remainder && !failed && rawLen > 0) enqueue(() => appendCurrent({ markdown_text: remainder }));
      // Text the live stream never carried: everything past the cap, or the whole answer when
      // nothing streamed (a tool-only run) and it's longer than one message.
      let oneShot = "";
      let overflow = "";
      if (rawLen === 0) {
        // Fence-safe split (a raw slice could cut mid-line/mid-``` and corrupt everything after).
        const parts = chunkMrkdwn(full, MAX_SLACK_CHARS);
        oneShot = parts[0] || "_(empty response)_";
        overflow = parts.slice(1).join("\n");
        if (overflow) oneShot += "\n\n…_(continued below)_";
      } else if (truncated) {
        // The slice is only valid when the final content really is the concatenation of the
        // streamed deltas (true for Claude; Codex deltas are best-effort and the limit-fallback
        // prepends a notice that never streamed). On divergence, deliver the full authoritative
        // answer below instead of a mis-sliced tail.
        overflow = fullRaw.startsWith(streamed)
          ? fullRaw.slice(streamed.length)
          : "_(the live stream above was truncated — full answer:)_\n\n" + fullRaw;
      }
      // The requester @-mention rides the LAST message of the reply so they get a notification even
      // in a channel thread they aren't watching (requesterTag is "" in a DM / author-less post, so
      // every branch below is a no-op then). When there's overflow, "last" is that trailing
      // follow-up; otherwise it's the streamed/oneShot message finalized here — and for a pure
      // streamed answer the tag has to go out as one final delta before stop().
      const hasOverflow = Boolean(overflow.trim());
      const tag = requesterTag ? `\n\n${requesterTag}` : "";
      if (tag && !hasOverflow && rawLen > 0 && !failed) enqueue(() => appendCurrent({ markdown_text: tag }));
      timeline.finishAgents(); // never leave a native child spinner running after the turn closes
      timeline.flushActive(); // check off the last tool row before the stream closes
      await chain; // drain queued appends (incl. the timeline, the remainder + trailing mention)
      if (!failed) {
        // Seal the card into the terminal API call as well as its live appends so Slack history keeps
        // the final snapshot after the streaming state is gone. Stable row ids update, not duplicate.
        const terminalChunks = timelineOff ? [] : timeline.snapshot();
        const fence = rawLen > 0 ? activeMarkdownFence(streamMarkdown) : null;
        const terminalPayload = {
          // If nothing was streamed live, send the answer's first part now so the stream never
          // finalizes with no content (which the API rejects). Resolve mentions in it too; the
          // requester tag rides here when there's no overflow to carry it.
          ...(rawLen === 0 ? { markdown_text: resolveMentions(oneShot, dir) + (hasOverflow ? "" : tag) } : {}),
          ...(rawLen > 0 && fence ? { markdown_text: `\n${fence.marker}` } : {}),
          ...(terminalChunks.length ? { chunks: terminalChunks } : {}),
        };
        try {
          await streamer.stop({
            ...terminalPayload,
            blocks: footerBlocks(result, { channel, threadTs, authorId }),
          });
          if (streamer.ts) {
            await cleanupRetiredStreams();
            // The streamed message IS the reply; deliver any overflow beneath it (with the tag).
            if (hasOverflow) await postChunkedReply(client, channel, threadTs, resolveMentions(mdToMrkdwn(overflow), dir).trim() + tag);
            return;
          }
        } catch (error) {
          reportStreamFailure("stop", error);
          if (isSlackInvalidBlocksError(error)) {
            try {
              // The SDK keeps buffered markdown after a rejected stopStream call. Retry the same
              // terminal write without cosmetic footer blocks. Re-send the toolbox snapshot, which
              // the helper does not retain, but do not append terminal markdown a second time: that
              // text is still in ChatStreamer's buffer from the rejected request.
              const footerlessPayload = terminalChunks.length ? { chunks: terminalChunks } : undefined;
              await streamer.stop(footerlessPayload);
              if (streamer.ts) {
                await cleanupRetiredStreams();
                if (hasOverflow) await postChunkedReply(client, channel, threadTs, resolveMentions(mdToMrkdwn(overflow), dir).trim() + tag);
                return;
              }
            } catch {
              // The text-only stop failed too; fall through to the normal full-answer fallback.
            }
          }
          failed = true;
        }
      }
      // Fallback: streaming unavailable — post the whole answer the classic way (chunked).
      try {
        await postChunkedReply(client, channel, threadTs, resolveMentions(mdToMrkdwn(full), dir).trim() + tag, footerText(result), footerButtons(result, { channel, threadTs, authorId }));
      } catch (error) {
        // Both delivery surfaces failed. The outer run handler will call stop(), but this finalize
        // already owns the terminal state, so close and drain the Plan here before rethrowing.
        // A later stop() only awaits the settled shared chain and cannot duplicate this update.
        timeline.interruptReport();
        await chain;
        throw error;
      }
    },
    // Abort/error path: close the stream so the partial message finalizes cleanly (or clear the
    // shimmer if it never started). The caller posts its own error/stop notice.
    stop: async () => {
      if (terminal) {
        await chain;
        return;
      }
      terminal = "stop";
      stopped = true;
      stopHeartbeat("⏹️ Stopped");
      flushCard();
      timeline.interruptReport();
      timeline.finishAgents("stopped");
      timeline.flushActive(); // close off the running tool row before we stop the stream
      await shimmer.stop?.();
      await chain;
      if (!failed) {
        // The controlled stop path has the same lifecycle contract: toolbox stays, shimmer is gone.
        const terminalChunks = timelineOff ? [] : timeline.snapshot();
        try {
          const fence = activeMarkdownFence(streamMarkdown);
          await streamer.stop(
            fence || terminalChunks.length
              ? {
                  ...(fence ? { markdown_text: `\n${fence.marker}` } : {}),
                  ...(terminalChunks.length ? { chunks: terminalChunks } : {}),
                }
              : undefined,
          );
          await cleanupRetiredStreams();
        } catch (error) {
          reportStreamFailure("abort stop", error);
        }
      }
    },
  };
}

// A quiet stretch has two flavours worth distinguishing: nothing at all (the model is thinking
// server-side) versus the harness still logging to stderr without making progress — a retry or
// backoff loop. Saying which one it is turns "still connected" into something actionable.
function stillLogging(event) {
  return typeof event?.livenessMs === "number" && event.livenessMs < event.silentMs;
}
function quietDetail(event) {
  return stillLogging(event)
    ? `the harness has been logging without progress for ${describeSilence(event.silentMs)}`
    : `quiet for ${describeSilence(event.silentMs)}`;
}

// Native streaming writes the answer plus the persistent tool/plan toolbox and owns the final
// message. Slack's assistant status separately mirrors live activity and disappears at the end.
export function startProgress(_mode, client, channel, threadTs, ctx = {}) {
  return startStreamingProgress(client, { channel, threadTs, ...ctx });
}
