// Shared stream-json parsing for the Claude engine (cold runner + warm session). With
// --include-partial-messages the CLI emits low-level `stream_event` lines that mirror the
// Anthropic streaming API. This turns them into the lightweight events the Slack progress UI
// consumes — text deltas (onDelta) and { kind: "tool_use" | "thinking", name, target } steps
// (onEvent) — while assembling each tool call's input from its incremental input_json_delta
// chunks so we can show a useful target ("Read meta.json", "Bash: npm test").

import { isProgressReportTool, normalizeProgressReport } from "./progress-report.js";
import { isLoopTool, normalizeLoopWakeup } from "./loop-wakeup.js";

const CLAUDE_PROVIDER_ERROR_MAX = 500;
// Harness `systemMessage` text shown to the user (see the system branch in consume()).
const SYSTEM_NOTICE_MAX = 400;

function claudeEventText(event) {
  const content = event?.message?.content;
  const values = Array.isArray(content)
    ? content.map((block) => (block?.type === "text" ? block.text : ""))
    : [typeof content === "string" ? content : ""];
  return values
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLAUDE_PROVIDER_ERROR_MAX);
}

// Claude can emit a structured assistant error (for example `error:"rate_limit"` with
// "You've hit your session limit · resets 6am") and then exit nonzero WITHOUT a terminal result
// line. Preserve that actionable provider message so the runner does not collapse it into the
// opaque numeric process failure. A normal assistant answer never has the top-level error
// marker, so merely discussing limits in prose cannot be mistaken for an engine failure.
export function claudeProviderError(event) {
  const raw = event?.error ?? event?.message?.error;
  const code = typeof raw === "string"
    ? raw.trim()
    : String(raw?.type || raw?.code || raw?.message || "").trim();
  if (!code) return null;

  const detail = claudeEventText(event);
  const combined = `${code} ${detail}`;
  const usageLimited = /(?:rate|usage|session|account|spend|credit|token)[_-]?limit|quota/i.test(combined);
  // The CLI's own label for a model the provider does not serve ("There's an issue with the
  // selected model (m). It may not exist or you may not have access to it.") — a rejection the
  // orchestrator answers with the gateway default model, exactly as it does for Codex.
  const modelRejected = /model[_ -]?not[_ -]?found/i.test(code) || /issue with the selected model/i.test(combined);
  // `availability` means the provider did not ANSWER (overloaded, 5xx, "server_error") — the one
  // kind the orchestrator replays in place. The CLI prefixes every failure with "API Error: …",
  // including the ones it answers with a plain 4xx (a rejected model, an unknown 400), so the
  // prefix itself proves nothing: only overload / unavailable wording, a server_error label or a
  // 5xx status in the text qualifies. Anything else the labels leave open stays "provider".
  const kind = modelRejected
    ? "model_rejected"
    : usageLimited
    ? "usage_limit"
    : /auth|credential|unauthori[sz]ed/i.test(combined)
      ? "authentication"
      : /permission|forbidden|access[_ -]?denied/i.test(combined)
        ? "permission"
        : /invalid[_ -]?request|bad[_ -]?request|validation/i.test(combined)
          ? "invalid_request"
          : /overload|unavailable|server[_ -]?error|bad gateway|gateway time-?out|api error:? 5\d\d\b/i.test(combined)
            ? "availability"
            : /billing|payment|credit/i.test(combined)
              ? "billing"
              : /network|connection|timeout/i.test(combined)
                ? "connection"
                : "provider";
  const label = {
    usage_limit: "Claude usage limit reached",
    model_rejected: "Claude provider rejected the model",
    authentication: "Claude authentication failed",
    permission: "Claude provider denied the request",
    invalid_request: "Claude provider rejected the request",
    availability: "Claude provider is temporarily unavailable",
    billing: "Claude billing or credit issue",
    connection: "Claude provider connection failed",
    provider: "Claude provider returned an error",
  }[kind];
  return { code, kind, detail, message: detail ? `${label}: ${detail}` : label };
}

export function claudeProviderErrorMessage(event) {
  return claudeProviderError(event)?.message || "";
}

function clip(s, n) {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// Last path segment, e.g. "/a/b/meta.json" → "meta.json".
function base(p) {
  if (typeof p !== "string" || !p) return "";
  return p.split("/").filter(Boolean).pop() || p;
}

// Surface the most useful-looking string argument for tools we don't special-case (MCP tools,
// custom tools). Prefers obviously-meaningful keys, else the first short string value.
function firstStringArg(input) {
  const preferred = ["query", "q", "url", "path", "file", "name", "id", "prompt", "text", "title"];
  for (const k of preferred) {
    if (typeof input[k] === "string" && input[k].trim()) return clip(input[k], 60);
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) return clip(v, 60);
  }
  return "";
}

// Pull a short, human-readable "target" out of a tool's assembled input.
export function toolTarget(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return base(input.file_path);
    case "NotebookEdit":
      return base(input.notebook_path || input.file_path);
    case "Bash":
      return clip(input.command, 60);
    case "Glob":
      return clip(input.pattern, 60);
    case "Grep":
      return clip(input.pattern, 60);
    case "WebFetch":
      return clip(input.url, 60);
    case "WebSearch":
      return clip(input.query, 60);
    case "Agent":
    case "Task":
      return clip(input.description || input.prompt, 60);
    case "TodoWrite":
      return "";
    case "Skill":
      // The skill the model invoked — exact usage telemetry keys on it (gateway/skills/usage.js).
      return clip(input.skill || input.name || input.skill_name || "", 60);
    default:
      return firstStringArg(input);
  }
}

// The status line shows WHAT the model is thinking about, not just that it thinks: surface the
// latest complete-ish line of the thinking block, clipped to fit Slack's one-line status. First
// emission waits for enough text to be meaningful; later ones are time-throttled so a long
// reasoning stretch keeps the line moving without hammering the status API per delta.
export const THINKING_SUMMARY_MAX = 80;
const THINKING_FIRST_EMIT_CHARS = 48;
const THINKING_REEMIT_MS = 5000;

export function thinkingSummary(buf) {
  const lines = String(buf || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] || "";
  return line.length > THINKING_SUMMARY_MAX ? `${line.slice(0, THINKING_SUMMARY_MAX - 1)}…` : line;
}

// Create a per-run consumer. Feed every parsed JSON line to consume(p); it accumulates the
// assistant text (exposed via .text) and fires onDelta/onEvent. The caller still handles the
// terminal `type === "result"` line itself.
export function createStreamConsumer({ onDelta = null, onEvent = null } = {}) {
  const toolBlocks = new Map(); // content-block index → { id, name, json }
  const toolCalls = new Map(); // tool-use id → { name, target }, retained until its result arrives
  const thinkingBlocks = new Map(); // content-block index → { buf, emittedAt, last }
  const taskAliases = new Map(); // Claude task_id → originating Agent/Task tool_use_id
  const agentIds = new Set(); // stable ids known to represent native subagents
  const seenToolUses = new Set();
  let text = "";
  let toolUseCount = 0; // any attempted tool means replaying the turn could repeat side effects
  const markToolUse = (id) => {
    const key = String(id || `anonymous-${toolUseCount + 1}`);
    if (seenToolUses.has(key)) return;
    seenToolUses.add(key);
    toolUseCount += 1;
  };

  const statusFor = (value, fallback = "running") => {
    const status = String(value || "").toLowerCase();
    if (status === "completed" || status === "complete" || status === "success") return "completed";
    if (status === "failed" || status === "error") return "failed";
    if (status === "killed" || status === "stopped" || status === "cancelled" || status === "canceled") return "stopped";
    return fallback;
  };
  const taskIdFor = (p) => {
    const taskId = String(p?.task_id || p?.taskId || "").trim();
    const toolUseId = String(p?.tool_use_id || p?.toolUseId || "").trim();
    if (taskId && toolUseId) taskAliases.set(taskId, toolUseId);
    return (taskId && taskAliases.get(taskId)) || toolUseId || taskId;
  };
  const usageFields = (usage = {}) => {
    const fields = {};
    const elapsedMs = usage.duration_ms ?? usage.durationMs;
    const tokens = usage.total_tokens ?? usage.totalTokens;
    const toolUses = usage.tool_uses ?? usage.toolUses;
    if (Number.isFinite(Number(elapsedMs))) fields.elapsedMs = Number(elapsedMs);
    if (Number.isFinite(Number(tokens))) fields.tokens = Number(tokens);
    if (Number.isFinite(Number(toolUses))) fields.toolUses = Number(toolUses);
    return fields;
  };
  const emitClaudeTask = (p) => {
    const subtype = String(p?.subtype || "");
    if (p?.type === "tool_progress") {
      const id = taskIdFor(p) || String(p.parent_tool_use_id || p.parentToolUseId || "").trim();
      if (!id || !agentIds.has(id)) return false;
      const seconds = p.elapsed_time_seconds ?? p.elapsedTimeSeconds;
      onEvent?.({
        kind: "agent_activity",
        id,
        engine: "claude",
        status: "running",
        ...(Number.isFinite(Number(seconds)) ? { elapsedMs: Math.round(Number(seconds) * 1000) } : {}),
        ...(p.tool_name || p.toolName ? { lastTool: String(p.tool_name || p.toolName) } : {}),
      });
      return true;
    }
    if (p?.type !== "system" || !subtype.startsWith("task_")) return false;

    const id = taskIdFor(p);
    if (!id) return true;
    agentIds.add(id);
    const usage = usageFields(p.usage);
    const common = {
      kind: "agent_activity",
      id,
      engine: "claude",
    };
    if (subtype === "task_started") {
      onEvent?.({
        ...common,
        ...(p.subagent_type || p.subagentType ? { name: String(p.subagent_type || p.subagentType) } : {}),
        ...(p.description ? { description: String(p.description) } : {}),
        status: "running",
      });
      return true;
    }
    if (subtype === "task_progress") {
      onEvent?.({
        ...common,
        ...(p.subagent_type || p.subagentType ? { name: String(p.subagent_type || p.subagentType) } : {}),
        ...(p.description || p.summary ? { description: String(p.description || p.summary) } : {}),
        status: "running",
        ...usage,
        ...(p.last_tool_name || p.lastToolName ? { lastTool: String(p.last_tool_name || p.lastToolName) } : {}),
      });
      return true;
    }
    if (subtype === "task_updated") {
      const patch = p.patch || {};
      onEvent?.({
        ...common,
        ...(patch.description || patch.error ? { description: String(patch.description || patch.error) } : {}),
        status: statusFor(patch.status),
      });
      return true;
    }
    if (subtype === "task_notification") {
      onEvent?.({
        ...common,
        ...(p.summary ? { description: String(p.summary) } : {}),
        status: statusFor(p.status),
        ...usage,
      });
      return true;
    }
    return true;
  };

  function consume(p) {
    if (emitClaudeTask(p)) return;
    if (p?.type === "assistant") {
      const content = Array.isArray(p?.message?.content) ? p.message.content : (Array.isArray(p?.content) ? p.content : []);
      for (const block of content) if (block?.type === "tool_use") markToolUse(block.id);
    }
    // With --include-partial-messages Claude emits the executed tool response as a high-level
    // `user` message. Surface only lifecycle metadata; command output, file content, MCP payloads,
    // and errors can be sensitive or enormous and never belong in Slack's status line.
    if (p?.type === "user") {
      const content = Array.isArray(p?.message?.content)
        ? p.message.content
        : (Array.isArray(p?.content) ? p.content : []);
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const id = String(block.tool_use_id || block.toolUseId || "").trim();
        const call = toolCalls.get(id);
        if (!id || !call) continue;
        toolCalls.delete(id);
        onEvent?.({
          kind: "tool_result",
          id,
          name: call.name,
          target: call.target,
          status: block.is_error === true ? "failed" : "completed",
        });
      }
      return;
    }
    // A hook's `systemMessage` arrives as a plain system line. Everything else in the system
    // channel is machinery, but THIS is text written for the person reading the thread — the
    // stop-hook safety valve announcing that background subagent work is being abandoned. Dropping
    // every non-task system event made that release completely invisible, so a lost subagent
    // looked exactly like a clean finish. Route it into the progress surface as a notice.
    if (p?.type === "system") {
      const message = String(p.systemMessage ?? p.system_message ?? "").replace(/\s+/g, " ").trim();
      if (message) onEvent?.({ kind: "notice", text: message.slice(0, SYSTEM_NOTICE_MAX) });
      return;
    }
    if (!p || p.type !== "stream_event") return;
    const ev = p.event;
    const et = ev?.type;

    if (et === "content_block_start") {
      const cb = ev.content_block;
      if (cb?.type === "tool_use") {
        markToolUse(cb.id || `stream-index-${ev.index}`);
        toolBlocks.set(ev.index, { id: cb.id || "", name: cb.name, json: "" });
      } else if (cb?.type === "thinking" || cb?.type === "redacted_thinking") {
        // Redacted thinking has no readable content — only the bare "is thinking" signal.
        if (cb?.type === "thinking") thinkingBlocks.set(ev.index, { buf: "", emittedAt: 0, last: "" });
        onEvent?.({ kind: "thinking" });
      }
      return;
    }

    if (et === "content_block_delta") {
      const d = ev.delta;
      const t = d?.text ?? d?.delta?.text ?? "";
      if (t) {
        text += t;
        onDelta?.(t);
      }
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
        const b = toolBlocks.get(ev.index);
        if (b) b.json += d.partial_json;
      }
      const think = d?.type === "thinking_delta" ? (d.thinking ?? d?.delta?.thinking ?? "") : "";
      if (typeof think === "string" && think) {
        const tb = thinkingBlocks.get(ev.index);
        if (tb) {
          tb.buf += think;
          const now = Date.now();
          const due = tb.emittedAt === 0
            ? tb.buf.length >= THINKING_FIRST_EMIT_CHARS || tb.buf.includes("\n")
            : now - tb.emittedAt >= THINKING_REEMIT_MS;
          if (due) {
            tb.emittedAt = now;
            const summary = thinkingSummary(tb.buf);
            if (summary && summary !== tb.last) {
              tb.last = summary;
              onEvent?.({ kind: "thinking", summary });
            }
          }
        }
      }
      return;
    }

    if (et === "content_block_stop") {
      thinkingBlocks.delete(ev.index);
      const b = toolBlocks.get(ev.index);
      if (b) {
        toolBlocks.delete(ev.index);
        let input = null;
        try {
          input = b.json ? JSON.parse(b.json) : null;
        } catch {
          /* incomplete partial JSON — emit the name without a target */
        }
        if (isProgressReportTool(b.name)) {
          const event = normalizeProgressReport(input);
          if (event) onEvent?.(event);
          return;
        }
        // The harness's own loop tools (`/loop`). Their timers die with this process, so the
        // daemon reads the pacing decision here and re-arms the thread durably instead — see
        // engines/loop-wakeup.js. The call still runs in the harness; we only observe it, exactly
        // like a progress report, which keeps the native skill working unmodified.
        if (isLoopTool(b.name)) {
          const event = normalizeLoopWakeup(b.name, input);
          if (event) onEvent?.(event);
          return;
        }
        // Agent (and legacy Task) is a parallel child lifecycle, not a serial generic tool row.
        // Emit it immediately from the assembled launch input; later system task messages update
        // this same stable tool-use id through taskAliases.
        if (b.name === "Agent" || b.name === "Task") {
          const id = String(b.id || "").trim() || `claude-agent-${ev.index}`;
          agentIds.add(id);
          onEvent?.({
            kind: "agent_activity",
            id,
            engine: "claude",
            ...(input?.subagent_type ? { name: String(input.subagent_type) } : {}),
            ...(input?.description || input?.prompt ? { description: String(input.description || input.prompt) } : {}),
            status: "running",
          });
          return;
        }
        // TodoWrite carries the agent's live plan. Surface it as a structured event for any
        // progress consumer that wants to format it differently from a generic tool line.
        if (b.name === "TodoWrite" && Array.isArray(input?.todos)) {
          onEvent?.({
            kind: "todos",
            items: input.todos.map((t) => ({
              content: String(t?.content ?? t?.activeForm ?? "").trim(),
              status: String(t?.status ?? "pending"),
            })).filter((t) => t.content),
          });
        }
        const id = String(b.id || "").trim();
        const target = toolTarget(b.name, input);
        if (id) toolCalls.set(id, { name: b.name, target });
        // The full file path rides along for file tools (the target is only the basename): skill
        // usage capture needs to see `…/skills/<slug>/SKILL.md`.
        const filePath = typeof input?.file_path === "string" ? input.file_path : "";
        onEvent?.({ kind: "tool_use", ...(id ? { id } : {}), name: b.name, target, ...(filePath ? { path: filePath } : {}) });
      }
    }
  }

  return {
    consume,
    get text() {
      return text;
    },
    get toolUseCount() {
      return toolUseCount;
    },
  };
}
