// OpenAI Codex CLI runner (`codex exec`). The headless counterpart to engines/claude.js, used
// when the gateway engine is set to "codex". Codex differs from Claude in several ways the
// gateway accounts for:
//   - One-shot per message: a new turn resumes the thread (`codex exec resume <id>`), so there
//     are no warm sessions — each message spawns a fresh process.
//   - Confinement via Codex permission profiles (`default_permissions` + a per-run
//     `[permissions.*]` definition passed as -c overrides), not a settings file; cwd via the
//     spawn { cwd } (fresh runs also pass -C). Our .claude lockdown does not apply. Full access
//     is the only non-profile path (--dangerously-bypass-approvals-and-sandbox).
//     NOTE: the `exec resume` subcommand dropped -C/--cd and -s/--sandbox; profiles are plain
//     config overrides, so the same flags work on fresh and resumed runs — see buildCodexArgs.
//   - MCP injected with `-c mcp_servers.*` overrides — identical on a fresh run and on a resume,
//     because `exec resume` reads them the same way. Header-bearing remote MCPs (Composio, the
//     toolboxes) use Codex's native streamable-HTTP transport with a per-run `http_headers_helper`
//     script, NOT a stdio bridge: Codex takes whichever MCP servers finished starting by the time
//     it builds the first request, and a resumed turn reaches that point far sooner than a fresh
//     one (see addSecretRemote).
//   - JSONL events (`--json`): thread.started carries the session id; the authoritative final
//     message is read from the `-o` file. Token usage comes from turn.completed; no dollar cost.
//   - timeoutMs is an inactivity watchdog, not a wall-clock runtime cap: a busy Codex turn may run
//     as long as it keeps producing JSONL/progress output.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { composioUrl, toolboxUrl } from "../gateway/mcp-catalog.js";
import { argvSafePrompt } from "./contract.js";
import { buildChildEnv } from "./child-env.js";
import { safeSpawnEnv } from "../config/channel-env.js";
import { browserSpawnEnv } from "../gateway/browser-env.js";
import { appendTail } from "../util/tail.js";
import { trackEngineChild } from "./process-registry.js";
import { containerPaths, dropHostLocationEnv, isIsolatedTarget, probeEngineChild, runtimeTargetOr, signalEngineChild, spawnEngineChild } from "./runtime-target.js";
import { newRunId } from "../runtimes/contract.js";
import { isProgressReportTool, normalizeProgressReport } from "./progress-report.js";
import { thinkingSummary } from "./stream.js";
import { createStallWatchdog, describeSilence, DEFAULT_SILENCE_WINDOWS } from "./watchdog.js";
import { redactLogValue } from "../util/redact.js";
import { conciseProcessDiagnostic, embeddedJsonObject, plainFailureText, processFailureMessage } from "../util/process-outcome.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { createCodexUsageReader, subtractCodexTokenUsage } from "./codex-usage.js";
import { MCP_STARTUP_TIMEOUT_SECONDS } from "./mcp-timeouts.js";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const MAX_RETAINED = 64_000; // stdout/stderr/delta kept for error context — tail only, never unbounded
const NOTE_INTERVAL_MS = 15_000; // floor between stderr diagnostics shown to the user (see handleStderrLine)
// The daemon-side helpers an engine spawns during a run (the gateway control MCP, the secret
// bridges) are NOT resolved from this checkout any more: on the host they are these scripts, but
// inside a channel container they are the image's baked bundle and the checkout is not mounted.
// The runtime backend is the one home for that fact (runtimes/contract.js HELPER_COMMANDS), so
// every entry below is composed from `target.runtime.helperCommand()`.
//
// secret-env-bridge re-execs its target with process.execPath, so what it needs from the gateway
// helper is a SCRIPT path, not a command: take the helper's args when it has any, else its bare
// command. On the host that is exactly today's `[<src>/mcp/gateway-server.js]`.
//
// One requirement this places on an isolated backend's helper table, because Codex reaches that
// helper THROUGH the secret bridge rather than launching it itself: "gateway-mcp" must be node +
// a script path the bridge will accept (it validates a .js suffix), not a bare wrapper executable.
// The image's "mcp-remote" helper is no longer part of a Codex run — remote MCPs are dialled by
// Codex itself now (see addSecretRemote) — but it stays in the table for the image contract and
// for any backend that still bridges one.
function helperScriptArgv(helper) {
  return helper.args?.length ? [...helper.args] : [helper.command];
}

// Where the per-run `http_headers_helper` for one remote MCP server lives: beside the run's secret
// bundle, in the artifact dir both sides of the container name identically. `.cjs` on purpose —
// the file is written outside any package, and the extension is what fixes the module system.
export function headerHelperPath(secretBundlePath, serverName) {
  return `${String(secretBundlePath).replace(/\.json$/, "")}-${serverName}.headers.cjs`;
}

// The helper itself. Codex executes it at MCP startup and reads a JSON header map from stdout, so
// this is where the credential is resolved: out of the run's 0600 bundle, never from argv or the
// environment (which Codex persists into `.codex/shell_snapshots/*.sh`). Nothing secret is written
// into the script — only the bundle path and which entry to read.
export function headerHelperSource({ secretName, headerName, prefix = "", bundlePath }) {
  const literal = (value) => JSON.stringify(String(value));
  return `#!/usr/bin/env node
"use strict";
// Generated per run by the gateway. Prints ONE HTTP header for one remote MCP server.
const BUNDLE = ${literal(bundlePath)};
const SECRET = ${literal(secretName)};
const HEADER = ${literal(headerName)};
const PREFIX = ${literal(prefix)};
let bundle;
try {
  bundle = JSON.parse(require("node:fs").readFileSync(BUNDLE, "utf8"));
} catch {
  process.stderr.write("Remote MCP credential is unavailable\\n");
  process.exit(2);
}
const value = Object.prototype.hasOwnProperty.call(bundle, SECRET) ? bundle[SECRET] : "";
if (typeof value !== "string" || !value) {
  process.stderr.write("Remote MCP credential is unavailable\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ [HEADER]: PREFIX + value }));
`;
}
// Names that can ride in a `-c` dotted key path. TOML bare keys are exactly [A-Za-z0-9_-]; anything
// else needs quoting, and quoting a `-c` segment does not mean what it means in a TOML file.
const BARE_TOML_KEY = /^[A-Za-z0-9_-]{1,120}$/;

function tomlString(value) {
  return JSON.stringify(String(value));
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const MODEL_REJECTION_RE = /(?:\bmodel\b[^\n]{0,180}\b(?:not supported|unsupported|not available|unavailable|does not exist|not found|requires (?:a )?newer version|invalid)\b|\b(?:unsupported|invalid)\s+model\b)/i;
// Codex plan/credit exhaustion, e.g. "You've hit your usage limit. Visit
// https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th…".
// Like a model rejection this lands BEFORE any generation, so the turn did no work and is safe to
// replay on another harness.
const USAGE_LIMIT_RE = /(?:hit|reached|exceeded)[^.\n]{0,40}(?:usage|rate|quota|credit|spend|weekly|monthly|token)\s+limit|usage limit|rate limit(?:ed|s)?\b|quota exceeded|purchase more credits|out of credits|insufficient (?:credits|quota|balance|funds)|codex\/settings\/usage/i;
const AUTH_FAILURE_RE = /not logged in|log ?in (?:again|with)|sign ?in (?:again|to)|unauthori[sz]ed|invalid api key|authentication (?:failed|error)|expired (?:token|credential|session)|run `?codex login/i;

// Classify a Codex provider failure into the kinds the orchestrator knows how to act on. Only
// pre-generation rejections get a kind: a model-availability rejection is retryable with another
// model, and authentication / usage-limit failures are the operator-authorized cross-engine
// failover cases. Anything else stays an ordinary opaque failure.
// Provider-side failures worth retrying IN PLACE: the request never got a real answer. 5xx and 529
// (overloaded) are the textbook cases; 404 is listed on purpose — on 2026-09-03 the ChatGPT Codex
// backend answered every request with "404 Not Found: Unknown error" for a few minutes, and a
// retry ten seconds later was the right response, not a red error in the thread. A 400 is NOT
// here: it says the request itself was wrong, and a model rejection has its own kind above — that
// check runs first, so the 404 an OpenAI-style backend answers for a model that does not exist
// ("model_not_found") is a rejection, not an outage. Every 5xx qualifies via `>= 500`, so only the
// sub-500 members are listed.
const TRANSIENT_STATUSES = new Set([404, 408, 409, 425]);
// Codex names most of these as underscore codes in `error.type` (internal_server_error,
// response_stream_disconnected, http_connection_failed, retry_limit, …); the text is matched with
// underscores folded to spaces so one vocabulary covers both the code and the prose.
const TRANSIENT_FAILURE_RE = /unknown error|timed? ?out|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network (?:error|failure)|stream (?:disconnected|failed)|connection (?:reset|refused|closed|error|failed)|reconnecting|overloaded|high load|at capacity|server (?:had an )?error|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|internal (?:server )?error|too many failed attempts|retry limit/i;

// `source` says what `message` IS. "event" (default): one structured failure report — a JSON error
// event, a credential probe. "stderr": the process's accumulated log, which is not a verdict: it
// carries the CLI's own recovered retries ("stream disconnected … retrying", an "unexpected status
// 429" it got past) and boilerplate, so from a log only the explicit usage-limit / authentication
// phrasings count — never a status quoted in passing, never the transient wording. A wedge or an
// unexplained exit is therefore never replayed on the strength of its log; the in-place retry is
// decided from the event the provider actually answered with.
export function classifyCodexFailure({ message = "", providerType = "", status = 0, source = "event" } = {}) {
  const text = `${providerType} ${message}`;
  const fromLog = source === "stderr";
  // The HTTP status often travels only in the prose ("unexpected status 404 Not Found: …") — but
  // not in a "Reconnecting... 2/5 (unexpected status 429 …)" progress line, which reports a
  // failure the CLI is still retrying: transient by definition, whatever status it quotes.
  const quoted = fromLog || /\breconnecting\b/i.test(message) ? null : /unexpected status (\d{3})\b/i.exec(message);
  const httpStatus = Number(status) || (quoted ? Number(quoted[1]) : 0);
  if ((httpStatus === 400 || httpStatus === 404 || /invalid[_ -]?request|model[_ -]?not[_ -]?found/i.test(providerType)) && MODEL_REJECTION_RE.test(message)) return "model_rejected";
  if (httpStatus === 429 || /rate[_ -]?limit|quota|insufficient[_ -]?quota|usage[_ -]?limit/i.test(providerType) || USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (httpStatus === 401 || httpStatus === 403 || /auth|credential|unauthori[sz]ed/i.test(providerType) || AUTH_FAILURE_RE.test(text)) return "authentication";
  if (fromLog) return "";
  if (TRANSIENT_STATUSES.has(httpStatus) || httpStatus >= 500 || TRANSIENT_FAILURE_RE.test(text.replace(/_/g, " "))) return "transient";
  return "";
}

// Pre-generation rejections: the turn provably did nothing, so the orchestrator may replay it
// (with another model, on the other harness, or — for a transient provider failure — the same
// engine again after a pause) as long as no tool ran.
const REPLAY_SAFE_KINDS = Object.freeze(["model_rejected", "usage_limit", "authentication", "transient"]);

// Codex's OWN logged-out phrasing, matched on stderr WHILE the process is still running.
// Deliberately narrower than AUTH_FAILURE_RE, which only ever runs on a corpse: this match ENDS a
// live turn, and Codex's stderr can also carry a line from an MCP child, so a bare "401" or
// "unauthorized" must not be enough to blame the harness's own credential. Every alternative here
// names the CLI's sign-in state, which no MCP server has any reason to talk about.
const LIVE_AUTH_FAILURE_RE = /not (?:logged|signed) in|run `?codex login|please (?:re-?)?(?:log|sign) ?in|(?:token|credential) refresh failed|failed to refresh (?:the )?(?:auth|access|id)?\s*token|(?:auth(?:entication)?|credentials?|session|refresh token|api key) (?:is |has |was )?(?:expired|revoked|invalid)|(?:expired|revoked|invalid) (?:auth(?:entication)?|credentials?|session|refresh token|api key)/i;

// Only "authentication" is actionable live. A usage limit reliably arrives as a JSON error event
// or a nonzero exit, both already handled on close; killing a live turn on stderr prose about
// limits would risk ending a healthy run that merely quoted one.
export function classifyCodexLiveStderr(line = "") {
  return LIVE_AUTH_FAILURE_RE.test(String(line)) ? "authentication" : "";
}

// Codex stderr lines worth showing the user while a turn is quiet: its own problem reports, not
// routine tracing. Answering "what is it stuck on?" is the whole point, so the filter is about
// signal, not severity.
const DIAGNOSTIC_LINE_RE = /\b(?:error|warn(?:ing)?|fail(?:ed|ure)?|retry|retrying|backoff|timed? ?out|unauthori[sz]ed|forbidden|rate.?limit|quota|log(?:in|ged) in|sign(?:ed)? in|credentials?|token|stream disconnected|connection (?:refused|reset))\b/i;

// One short, secret-free line for a status row or an error message. Engine stderr is not a
// trusted channel: it can echo argv, headers, or a token, so everything that leaves here goes
// through the shared redactor and a hard length cap.
export function codexDiagnosticLine(text = "") {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (DIAGNOSTIC_LINE_RE.test(lines[i])) return redactLogValue(lines[i]).slice(0, 200);
  }
  return lines.length ? redactLogValue(lines[lines.length - 1]).slice(0, 200) : "";
}

// The user-facing sentence for a classified failure that arrived on stderr rather than as a JSON
// event. Keeps the CLI's own actionable text (reset time, top-up link) instead of an exit code —
// as the redacted last lines of the log, never the raw buffer: this sentence is posted to the
// thread and stored in the event log, and a CLI that fails will happily echo a token into its own
// error line (src/util/redact.js).
export function codexProcessFailureMessage(kind, stderr = "") {
  const detail = conciseProcessDiagnostic(stderr, 600);
  const label = { usage_limit: "Codex usage limit reached", authentication: "Codex authentication failed" }[kind] || "Codex provider error";
  return detail ? `${label}: ${detail}` : label;
}

// Codex reports provider-side request failures as structured JSON. Preserve the useful message and
// attach the classification above so the orchestrator can retry with another model or hand the
// turn to the other harness instead of collapsing it into an opaque error.
export function codexTurnError(event) {
  const raw = event?.error;
  const reported = String(raw?.message || event?.message || (typeof raw === "string" ? raw : "") || "codex error").trim();
  // A ChatGPT-account Codex reports some provider refusals by handing the response BODY back
  // verbatim: the whole `{"type":"error","status":400,"error":{…}}` document arrives as the event's
  // message, with the status and the error type INSIDE it instead of on the event. Read them from
  // there, or a model the account cannot use looks like an unclassifiable failure — which is how a
  // misconfigured channel came to dead-end on raw JSON instead of falling back to the gateway
  // default (and saying so).
  const body = embeddedJsonObject(reported);
  const nested = body?.error && typeof body.error === "object" ? body.error : null;
  const message = plainFailureText(reported, 600) || reported;
  const providerType = String(raw?.type || raw?.code || nested?.type || nested?.code || body?.type || "").trim();
  const status = Number(event?.status ?? raw?.status ?? body?.status ?? nested?.status ?? 0) || 0;
  const providerError = Boolean(raw && typeof raw === "object") || event?.type === "error" || Boolean(body);
  return {
    message,
    details: {
      engine: "codex",
      providerError,
      providerCode: providerType,
      providerStatus: status || null,
      providerKind: providerError ? classifyCodexFailure({ message, providerType, status }) : "",
    },
  };
}

// Item type as a comparison key. Codex writes the same item under two spellings depending on the
// stream: the `codex exec --json` schema is snake_case (`collab_tool_call`), the session/app-server
// stream is PascalCase (`CollabAgentToolCall`). Folding both to letters means one branch covers the
// item wherever it came from.
function codexItemKey(value) {
  return String(value || "").replace(/[._\s-]/g, "").toLowerCase();
}

function codexItemMayExecuteTool(item = {}) {
  const type = codexItemKey(item.type);
  return ["mcptoolcall", "commandexecution", "filechange", "websearch", "collabtoolcall", "collabagenttoolcall"].includes(type);
}

// Is this item the model coordinating with its children (spawn/wait/send_input/close_agent)?
function codexIsCollabItem(item) {
  const type = codexItemKey(item?.type);
  return type === "collabtoolcall" || type === "collabagenttoolcall";
}

function codexMcpToolName(item = {}) {
  const server = String(item.server || "").trim();
  const tool = String(item.tool || item.tool_name || "").trim();
  if (server && tool) return `mcp__${server}__${tool}`;
  return tool || server || "mcp";
}

function codexAgentStatus(value, fallback = "running") {
  const raw = typeof value === "object" && value ? value.status : value;
  const status = String(raw || "").replace(/[_\s-]/g, "").toLowerCase();
  if (status === "completed" || status === "complete" || status === "success") return "completed";
  if (status === "failed" || status === "error" || status === "errored" || status === "crashed" || status === "notfound") return "failed";
  if (status === "stopped" || status === "killed" || status === "interrupted" || status === "shutdown" || status === "cancelled" || status === "canceled" || status === "closed") return "stopped";
  return fallback;
}

function codexAgentName(value) {
  const raw = String(value || "").trim();
  return raw.split("/").filter(Boolean).pop() || "";
}

function codexAgentEvent(payload, { spawnCompleted = false, id: idOverride = "", aliasIds = [], status: statusOverride } = {}) {
  const id = String(
    idOverride ||
    payload.event_id || payload.eventId ||
    payload.id ||
    payload.agent_thread_id || payload.agentThreadId ||
    payload.new_thread_id || payload.newThreadId ||
    "",
  ).trim();
  if (!id) return null;
  const explicitAgentStatus = payload.agent_status ?? payload.agentStatus;
  const lifecycle = payload.kind ?? explicitAgentStatus;
  const status = statusOverride || (spawnCompleted && explicitAgentStatus == null
    ? "running"
    : codexAgentStatus(lifecycle));
  const name = codexAgentName(
    payload.task_name || payload.taskName ||
    payload.agent_path || payload.agentPath ||
    payload.agent_name || payload.agentName,
  );
  const description = String(
    payload.description || payload.message || payload.summary || payload.prompt || "",
  ).trim();
  return {
    kind: "agent_activity",
    id,
    engine: "codex",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    status,
    ...(aliasIds.length ? { aliasIds: [...new Set(aliasIds.filter(Boolean).map(String))] } : {}),
  };
}

// Collab tool names: the model calls `spawn_agent`/`wait_agent`/`send_input`/`close_agent`, the
// exec JSON item reports `tool: "wait"` for the waiting family (Wait and ResumeAgent both map to
// it). One canonical name per family keeps the branches — and the rendered row — stable.
const COLLAB_TOOL_NAMES = {
  spawn_agent: "spawn_agent",
  spawn: "spawn_agent",
  send_input: "send_input",
  wait: "wait_agent",
  wait_agent: "wait_agent",
  resume_agent: "wait_agent",
  close_agent: "close_agent",
};

function codexCollabTool(value) {
  const raw = String(value || "").replace(/-/g, "_").toLowerCase();
  return COLLAB_TOOL_NAMES[raw] || raw;
}

// The arguments of a collaboration function call arrive as a JSON STRING (`{"task_name":"…"}`);
// a structured stream may hand over the object itself. Never throw on either.
function codexToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// A `SubAgentActivity` item — the shape Codex's session/app-server stream uses to announce a child
// thread starting and finishing. The child's THREAD id is the identity that survives its whole
// life; the item id differs between the start (the spawning call id) and the finish (a synthetic
// `subagent-completed-…`), so both ride along as aliases and Slack merges them into one row.
function codexSubAgentEvent(item) {
  const threadId = String(item.agent_thread_id || item.agentThreadId || item.new_thread_id || item.newThreadId || "").trim();
  const itemId = String(item.id || item.event_id || item.eventId || "").trim();
  if (!threadId && !itemId) return null;
  return codexAgentEvent(item, {
    id: threadId || itemId,
    aliasIds: [threadId, itemId, item.call_id, item.callId],
    status: codexAgentStatus(item.kind ?? item.agent_status ?? item.agentStatus ?? item.status),
  });
}

// Rows for the children of a collab tool call. Codex reports them in three different places
// depending on the CLI version and the multi-agent mode, so all three are read here:
//   · `agents_states` — one entry per child with its own status (multi-agent v1, and every
//     version's spawn/send_input/close_agent items that carry state);
//   · `receiver_agents` — the same children as objects (thread id + nickname/role);
//   · `receiver_thread_ids` — bare ids, the last resort for identity.
// Returning [] is meaningful: it says this item named no child at all (multi-agent v2 sends empty
// `wait` items), and the caller then renders the coordination step itself rather than nothing.
function codexCollabEvents(item, eventType) {
  const tool = codexCollabTool(item.tool || item.name);
  const args = codexToolArguments(item.arguments);
  const rawReceiverAgents = item.receiver_agents || item.receiverAgents;
  const receiverAgents = Array.isArray(rawReceiverAgents) ? rawReceiverAgents : [];
  const rawReceiverIds = item.receiver_thread_ids || item.receiverThreadIds;
  // One id per child: the same thread is often listed both as a bare id and as a receiver agent.
  const receivers = [...new Set([
    ...(Array.isArray(rawReceiverIds) ? rawReceiverIds : []),
    ...(item.receiver_thread_id || item.receiverThreadId ? [item.receiver_thread_id || item.receiverThreadId] : []),
    ...receiverAgents.map((agent) => agent?.thread_id || agent?.threadId || ""),
  ].filter(Boolean).map(String))];
  // Nicknames belong to ONE child each — never to the whole item, or a two-child wait would label
  // both rows with the first child's name.
  const nicknames = new Map(receiverAgents
    .map((agent) => [String(agent?.thread_id || agent?.threadId || ""), agent?.agent_nickname || agent?.nickname || agent?.agent_role || ""])
    .filter(([threadId, nickname]) => threadId && nickname));
  const rawStates = item.agents_states || item.agentsStates || {};
  const states = rawStates && typeof rawStates === "object" && !Array.isArray(rawStates)
    ? Object.entries(rawStates)
    : [];
  const toolFailed = codexAgentStatus(item.status, "") === "failed";
  // The requested identity of the child, wherever this shape carries it.
  const named = {
    ...item,
    ...(args.task_name || args.agent_type || args.name ? { task_name: args.task_name || args.agent_type || args.name } : {}),
    ...(args.description ? { description: args.description } : {}),
  };
  const forChild = (threadId) => (nicknames.has(threadId) ? { ...named, agent_name: nicknames.get(threadId) } : named);

  if (tool === "spawn_agent") {
    const stateIds = states.map(([threadId]) => threadId);
    const aliases = [...receivers, ...stateIds];
    const state = states[0]?.[1];
    const status = toolFailed ? "failed" : codexAgentStatus(state?.status, "running");
    // A spawn always deserves a row, even from a build that reports no child identity yet: the
    // call id then holds the row until a later event supplies the thread id as an alias.
    const event = codexAgentEvent(
      {
        ...forChild(aliases[0]),
        ...(toolFailed && item.error?.message ? { message: item.error.message } : {}),
      },
      {
        id: item.id || aliases[0],
        aliasIds: aliases,
        status,
        spawnCompleted: eventType === "item.completed",
      },
    );
    return event ? [event] : [];
  }

  // wait/send_input/close_agent can report several children in one item. Emit one sparse update
  // per child thread; Slack's alias map reconnects it to the original spawn row.
  if (states.length) {
    return states.map(([threadId, state]) => codexAgentEvent(
      {
        ...forChild(threadId),
        message: ["failed", "errored", "not_found"].includes(String(state?.status || "").toLowerCase())
          ? state?.message
          : "",
      },
      { id: threadId, status: codexAgentStatus(state?.status) },
    )).filter(Boolean);
  }
  // No per-child state, but the children are still named: mark them running again (a wait that
  // completed says nothing about which child finished, so status stays with the tool's own row).
  if (eventType !== "item.completed" && receivers.length) {
    return receivers.map((threadId) => codexAgentEvent(forChild(threadId), { id: threadId, status: "running" })).filter(Boolean);
  }
  return [];
}

// The collab call itself, as a tool row. Multi-agent v2 reports `wait` items with no receivers and
// no `agents_states` at all (the child lifecycle rides events `codex exec --json` does not
// forward), so without this the card would say nothing while two subagents worked.
function codexCollabToolEvent(item, completed) {
  const name = codexCollabTool(item.tool || item.name) || "collab";
  const id = String(item.id || "").trim();
  if (!completed) return { event: { kind: "tool_use", ...(id ? { id } : {}), name } };
  return {
    event: {
      kind: "tool_result",
      ...(id ? { id } : {}),
      name,
      status: item.error ? "failed" : codexAgentStatus(item.status, "completed"),
    },
  };
}

// Per-run state for progressFromCodexEvent: which message item is currently writing, and the last
// characters it wrote. Only the answer-segment separation needs it; every other mapping is pure.
export function createCodexProgressState() {
  return { messageItemId: "", messageTail: "" };
}

// Codex reports each assistant message as its OWN completed item — a stage narration, then the
// answer — and the gateway streams their texts into one Slack message. Concatenating them verbatim
// is what glued sentences together ("…isolates conversations.ChannelGate isolates each…"), so a
// NEW message item opens a new paragraph. Deltas WITHIN one streamed item are never separated: the
// break marks a boundary, it does not reformat prose. Callers that map a single event in isolation
// pass no state and get the text unchanged.
function codexMessageDelta(text, { state = null, itemId = "", complete = false } = {}) {
  if (!state) return text;
  const key = String(itemId || "");
  const boundary = complete || !key || key !== state.messageItemId;
  const wroteBefore = Boolean(state.messageTail);
  state.messageItemId = complete ? "" : key;
  let out = text;
  if (wroteBefore && boundary) {
    const gap = /\n\n$/.test(state.messageTail) ? "" : (/\n$/.test(state.messageTail) ? "\n" : "\n\n");
    out = `${gap}${text.replace(/^\n+/, "")}`;
  }
  state.messageTail = `${state.messageTail}${out}`.slice(-2);
  return out;
}

export function progressFromCodexEvent(p, state = null) {
  const payload = p?.payload && typeof p.payload === "object" ? p.payload : {};
  // Two envelopes carry the same items. `codex exec --json` puts the item next to an
  // "item.started"/"item.completed" type at the top level; the session/app-server stream wraps an
  // "item_completed" payload (and spells the item types in PascalCase). Read the item and its
  // lifecycle from whichever envelope this line uses.
  const item = (p?.item && typeof p.item === "object" ? p.item : null)
    || (payload.item && typeof payload.item === "object" ? payload.item : null)
    || {};
  const itemType = String(item.type || "");
  const normalizedItemType = codexItemKey(itemType);
  const normalizedPayloadType = codexItemKey(payload.type);
  const eventKey = codexItemKey(p?.item ? p?.type : (payload.item ? payload.type : p?.type));
  const startedEvent = eventKey === "itemstarted";
  const completedEvent = eventKey === "itemcompleted";

  // A child thread starting or finishing. Codex announces this as a SubAgentActivity item — the
  // only place a child's name and its completion appear when multi-agent v2 is in charge.
  if (normalizedItemType === "subagentactivity" || (!itemType && normalizedPayloadType === "subagentactivity")) {
    const event = codexSubAgentEvent(normalizedItemType === "subagentactivity" ? item : payload);
    return event ? { event } : null;
  }

  // A raw collaboration tool CALL. Streams that carry response items (rather than only the mapped
  // thread items) report a spawn here, and the child's requested name rides in its arguments.
  if (normalizedPayloadType === "functioncall" && String(payload.namespace || "").toLowerCase() === "collaboration") {
    if (codexCollabTool(payload.name) !== "spawn_agent") return null;
    const args = codexToolArguments(payload.arguments);
    // Deliberately NOT payload.arguments.message: a spawn's message is an encrypted blob.
    const event = codexAgentEvent(
      { task_name: args.task_name || args.agent_type || "", description: args.description || "" },
      { id: payload.call_id || payload.id, status: "running" },
    );
    return event ? { event } : null;
  }

  if (normalizedItemType === "collabtoolcall" || normalizedItemType === "collabagenttoolcall") {
    const events = codexCollabEvents(item, completedEvent ? "item.completed" : "item.started");
    if (events.length === 1) return { event: events[0] };
    if (events.length > 1) return { events };
    // The item named no child (multi-agent v2 sends empty `wait` items). Render the coordination
    // step itself so the card is not silent while subagents work.
    if (startedEvent || completedEvent) return codexCollabToolEvent(item, completedEvent);
    return null;
  }

  if (startedEvent) {
    if (normalizedItemType === "mcptoolcall") {
      const name = codexMcpToolName(item);
      if (isProgressReportTool(name)) {
        const event = normalizeProgressReport(item.arguments);
        if (event) return { event };
        return null;
      }
      return { event: { kind: "tool_use", ...(item.id ? { id: String(item.id) } : {}), name } };
    }
    if (normalizedItemType === "commandexecution") {
      return {
        event: {
          kind: "tool_use",
          ...(item.id ? { id: String(item.id) } : {}),
          name: item.command ? String(item.command) : "shell",
        },
      };
    }
    if (/reasoning|thinking/i.test(itemType)) return { event: { kind: "thinking" } };
  }
  if (completedEvent) {
    if (normalizedItemType === "mcptoolcall") {
      const name = codexMcpToolName(item);
      if (isProgressReportTool(name)) return null;
      return {
        event: {
          kind: "tool_result",
          ...(item.id ? { id: String(item.id) } : {}),
          name,
          status: item.error ? "failed" : codexAgentStatus(item.status, "completed"),
        },
      };
    }
    if (normalizedItemType === "commandexecution") {
      return {
        event: {
          kind: "tool_result",
          ...(item.id ? { id: String(item.id) } : {}),
          name: item.command ? String(item.command) : "shell",
          status: item.error ? "failed" : codexAgentStatus(item.status, "completed"),
        },
      };
    }
    if (normalizedItemType === "agentmessage" && typeof item.text === "string" && item.text) {
      return { delta: codexMessageDelta(item.text, { state, itemId: item.id, complete: true }) };
    }
    if (/reasoning|thinking/i.test(itemType)) {
      // Completed reasoning items carry Codex's own summary text — surface its gist so the
      // status line says WHAT it was reasoning about, mirroring Claude's thinking summaries.
      const summary = typeof item.text === "string" ? thinkingSummary(item.text) : "";
      return { event: summary ? { kind: "thinking", summary } : { kind: "thinking" } };
    }
  }
  const t = p?.delta?.text ?? item.text ?? p?.text ?? "";
  if (typeof t === "string" && t && /message|delta|agent/i.test(String(p?.type || ""))) {
    // A delta INSIDE one streamed message item: the item id (when the stream carries one) is what
    // tells a continuation apart from the start of the next segment.
    return { delta: codexMessageDelta(t, { state, itemId: item.id || p?.item_id || p?.itemId }) };
  }
  return null;
}

// A per-turn catalog supplements native repo/system skill discovery without changing HOME or
// CODEX_HOME. Empty catalogs explicitly supersede a previous author's grants on resumed threads.
export function codexPersonalSkillPrefix(skills) {
  if (!Array.isArray(skills)) return "";
  return "[Current personal skill grants — this run only]\n"
    + "These instruction files supplement your native repository and system skills. When the user names a listed skill, or its description matches the task, read its SKILL.md before applying it. Resolve references and scripts relative to that file's directory. They are prompt-delivered skills, not native slash commands. Only the following personal catalog applies now; earlier personal catalogs and paths have expired. Do not copy these grants into shared project skill folders.\n"
    + JSON.stringify(skills) + "\n[End current personal skill grants]\n\n";
}

// Build `codex exec` argv. `outFile` receives the final agent message (authoritative content).
export function buildCodexArgs({ prompt, sessionId, isNewSession, cwd, dangerouslySkip, writable = false, networkMode = "off", clean = false, autoApprove = false, composioUserEndpoint = null, composioEndpoint = null, composioUserToken = "", composioToken = "", toolboxToken = "", makeToolboxUrl = "", makeToolboxKey = "", secretBundlePath = "", codexMcpPolicy = null, gatewayCapability = "", gatewayFsRoot = "", gatewayWorkspaceRoot = "", progressReport = false, model = "", effort = "", personalSkills = null, attachments = [], target = null, outFile, headerHelpers = [] }) {
  const runtimeTarget = runtimeTargetOr(target, cwd);
  // The CONTAINER is the confinement boundary, so Codex's own sandbox is switched off: no
  // permission profiles, no network_proxy — egress is the container's network mode.
  if (!isIsolatedTarget(runtimeTarget)) throw new Error("Codex runs only inside a channel container");
  const helper = (name) => runtimeTarget.runtime.helperCommand(runtimeTarget, name);
  if (!["off", "on"].includes(networkMode)) throw new Error(`Unknown Codex network mode: ${networkMode}`);
  const resuming = !isNewSession;
  const base = isNewSession ? ["exec"] : ["exec", "resume", sessionId];
  const args = [...base, "--json", "--skip-git-repo-check", "-o", outFile];
  // Slack is the only interactive surface for this daemon. In non-autonomous modes, fail closed:
  // approval-required Codex actions are rejected instead of hanging on an invisible prompt. In
  // autonomous mode, route eligible approvals through Codex auto-review so safe MCP reads (for
  // example Composio/Gmail metadata searches) can proceed without a Slack dialog.
  if (autoApprove && !dangerouslySkip && !clean) {
    args.push("-c", `approval_policy="on-request"`);
    args.push("-c", `approvals_reviewer="auto_review"`);
  } else {
    args.push("-c", `approval_policy="never"`);
  }
  // Working dir: fresh `exec` takes -C/--cd, but the `exec resume` subcommand DROPPED it (Codex
  // ≥0.14x) and errors out with exit 2 ("unexpected argument '-C'") if it's present. We always
  // spawn codex with { cwd } anyway, so on a resume we let the process cwd stand in for the flag.
  if (!resuming) args.push("-C", cwd);
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${tomlString(effort)}`);

  // Confinement mirrors the channel's mode: admin → full bypass · everything else runs inside
  // the container with Codex's own sandbox reduced to read-only for read mode. --ignore-user-config
  // keeps a personal config in the container's HOME from broadening a channel's run.
  // The gateway MCP server is the in-image bridge to the daemon's unix socket, outside the
  // command sandbox, so the daemon runtime root is never reachable from model-generated commands.
  if (dangerouslySkip) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    // Read mode still asks Codex for a read-only sandbox — defence in depth inside the container,
    // and the one mode where a stray write would be a real surprise. Everything else runs
    // unconfined INSIDE the container, whose mounts, caps and network are the actual boundary.
    // `exec resume` dropped -s/--sandbox (see the header note), so a resumed run states the same
    // policy through its config-override twin; the approval policy set above is untouched.
    args.push("--ignore-user-config");
    const sandbox = writable ? "danger-full-access" : "read-only";
    if (resuming) args.push("-c", `sandbox_mode=${tomlString(sandbox)}`);
    else args.push("--sandbox", sandbox);
    // The sandbox also has to be a MECHANISM that can start in here. Codex's default is
    // bubblewrap, which refuses under the container's `--cap-drop ALL` + no-new-privileges
    // ("bwrap: Unexpected capabilities but not setuid") and fails EVERY command — which left Read
    // mode inoperative, reads included. Landlock is the mechanism that works under those caps:
    // reads succeed, writes get "Permission denied". Codex runs only inside a container (asserted
    // above), so this is unconditional wherever Codex's own sandbox is in use — never on the admin
    // bypass, which has no sandbox to pick a mechanism for. `use_legacy_landlock` is
    // DEPRECATED-but-functional in the pinned CLI (containers/versions.json): re-check it on every
    // Codex CLI bump.
    args.push("-c", "features.use_legacy_landlock=true");
  }

  // Optional host/runtime MCP policy. OpenAI injects `codex_apps` AFTER config parsing, so treating
  // it as a config.toml MCP server creates a transport-less invalid entry. Codex's documented
  // `apps.*` controls are the correct boundary: default-deny every runtime app, then enable only
  // selected tool-family slugs. Configured local MCP servers still use server-level `enabled`.
  const optionalPolicy = codexMcpPolicy || { apps: [], servers: [] };
  args.push("-c", "apps._default.enabled=false");
  if (!clean) {
    for (const app of Array.isArray(optionalPolicy.apps) ? optionalPolicy.apps : []) {
      const id = String(app || "");
      if (!BARE_TOML_KEY.test(id)) continue;
      args.push("-c", `apps.${id}.enabled=true`);
    }
  }
  for (const server of Array.isArray(optionalPolicy.servers) ? optionalPolicy.servers : []) {
    if (!server?.name) continue;
    const name = String(server.name);
    // A `-c` dotted path takes its segments LITERALLY, quotes included (same probe finding as the
    // permission-profile keys above), so `mcp_servers."x"` addresses a table named `"x"` — not the
    // `x` we meant. Every catalog name we can express is a bare TOML key; one that is not cannot be
    // addressed through `-c` at all, so it is refused rather than written to a key nobody reads.
    if (!BARE_TOML_KEY.test(name)) {
      if (!clean && server.enabled) throw new Error(`Optional MCP ${server.name} has a name Codex config cannot address`);
      continue;
    }
    // A DISABLED server gets no override at all. The run's CODEX_HOME (codexEngineHome()) holds
    // only auth.json + sessions — never a config.toml — so there is no entry for `enabled=false` to
    // land on; it would DEFINE a table whose only key is `enabled`, and a server with neither
    // `command` nor `url` has no transport. Codex then refuses the whole config
    // ("Error loading config.toml: invalid transport"), so one unselected server discovered from
    // the host's own Codex install killed every run on that machine.
    if (clean || !server.enabled) continue;
    const definition = server.definition;
    if (!definition) throw new Error(`Optional MCP ${server.name} is missing a complete safe definition`);
    args.push("-c", `mcp_servers.${name}.enabled=true`);
    args.push("-c", `mcp_servers.${name}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SECONDS}`);
    if (definition.transport === "http" && definition.url) {
      args.push("-c", `mcp_servers.${name}.url=${JSON.stringify(definition.url)}`);
    } else if (definition.transport === "stdio" && definition.command) {
      args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(definition.command)}`);
      args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(definition.args || [])}`);
    } else {
      throw new Error(`Optional MCP ${server.name} uses an unsupported transport`);
    }
  }

  // Gateway control MCP server. Its signed run capability is inherited from the exact child-env
  // allowlist, never reconstructed from caller-controlled identity strings in argv.
  // Skipped entirely in clean mode (bare run — no MCP servers at all).
  if (!clean) {
    const bridge = helper("secret-env-bridge");
    args.push("-c", `mcp_servers.gateway.command=${JSON.stringify(bridge.command)}`);
    args.push("-c", `mcp_servers.gateway.args=${JSON.stringify([...(bridge.args || []), secretBundlePath, "gatewayCapability", "CG_GATEWAY_CAPABILITY", ...helperScriptArgv(helper("gateway-mcp"))])}`);
    args.push("-c", `mcp_servers.gateway.env.CG_ENGINE="codex"`);
    if (progressReport) args.push("-c", `mcp_servers.gateway.env.CG_PROGRESS_REPORT="1"`);
    // This server is the gateway's own control plane (schedules/reminders/background/channel admin).
    // It already enforces channel/admin policy inside the tool handlers, so Codex should not add an
    // extra approval layer or invisible cancellation in headless Slack runs.
    args.push("-c", `mcp_servers.gateway.default_tools_approval_mode="approve"`);
    args.push("-c", `mcp_servers.gateway.startup_timeout_sec=60`);
  }

  // A header-bearing remote MCP (both Composio identities, the toolboxes) is reached over Codex's
  // OWN streamable-HTTP transport, and the header value is produced by a per-run helper script
  // (`http_headers_helper`) that reads the 0600 bundle — so the credential is still absent from
  // Codex's argv and environment. It used to be bridged to stdio through `mcp-remote` instead,
  // which cost ~2.4s to answer `tools/list` (two Node bootstraps, mcp-remote's OAuth discovery
  // round trip, then a duplicated initialize). Codex does not BLOCK a turn on MCP startup — it
  // takes whichever servers finished by the time it builds the first request, and
  // `startup_timeout_sec` only caps the handshake, it does not extend that wait. A fresh `exec`
  // assembles more context first (~2-5s of room); `exec resume` reaches the request in ~2s, so the
  // bridged servers made the cold window and missed every warm one: the second turn of a Codex
  // thread saw `gateway` and no `composio-user`/`composio-agent` at all. The native transport
  // answers in ~1.2s, inside both.
  const addSecretRemote = (name, url, secretName, headerName, prefix = "") => {
    if (clean || !secretBundlePath || !secretName || !url) return;
    const helperPath = headerHelperPath(secretBundlePath, name);
    args.push("-c", `mcp_servers.${name}.url=${JSON.stringify(url)}`);
    args.push("-c", `mcp_servers.${name}.http_headers_helper=${JSON.stringify(helperPath)}`);
    args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    // Still a ceiling on the handshake itself: the remote endpoint can be slow to answer the first
    // initialize, and Codex's default window (10s) intermittently dropped a server outright.
    args.push("-c", `mcp_servers.${name}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SECONDS}`);
    headerHelpers.push({ path: helperPath, secretName, headerName, prefix });
  };

  const addComposio = (name, endpoint, legacyToken, secretName) => {
    if (clean) return;
    if (endpoint?.mode === "sdk" && endpoint.url) {
      const sdk = helper("composio-sdk-bridge");
      args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(sdk.command)}`);
      args.push("-c", `mcp_servers.${name}.args=${JSON.stringify([...(sdk.args || []), endpoint.url])}`);
      args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
      args.push("-c", `mcp_servers.${name}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SECONDS}`);
      return;
    }
    const url = endpoint?.url || composioUrl();
    const token = endpoint?.headers?.["x-consumer-api-key"] || legacyToken;
    if (!token) return;
    addSecretRemote(name, url, secretName, "x-consumer-api-key");
  };
  addComposio("composio-user", composioUserEndpoint, composioUserToken, "composioUserToken");
  addComposio("composio-agent", composioEndpoint, composioToken, "composioToken");

  // Toolbox MCP, same native transport, carrying this run's token as a Bearer header.
  if (!clean && toolboxToken) {
    addSecretRemote("makeitfuture-toolbox", toolboxUrl(), "toolboxToken", "Authorization", "Bearer ");
  }

  if (!clean && makeToolboxUrl && makeToolboxKey) {
    addSecretRemote("make-toolbox", makeToolboxUrl, "makeToolboxKey", "Authorization", "Bearer ");
  }

  // Prompt must come before image flags: Codex's `-i/--image <FILE>...` option is variadic, so any
  // positional after the last `-i` is consumed as another image and the CLI exits with no prompt.
  args.push(argvSafePrompt((clean ? "" : codexPersonalSkillPrefix(personalSkills)) + prompt));

  // Attached images via native -i (Codex's vision path); non-image files are referenced in the
  // prompt text instead (the gateway already lists their paths there).
  for (const f of attachments) {
    if (IMAGE_RE.test(f)) args.push("-i", f);
  }
  return args;
}

// See buildClaudeEnv: the channel's own secrets are re-filtered at this boundary and go in first,
// so the gateway's TMPDIR / HOME / CODEX_HOME — and the browser namespace, which is a
// confinement boundary, not a preference (gateway/browser-env.js) — always win.
export function buildCodexEnv({ extraEnv = {}, browserNamespace = "", target = null } = {}, source = process.env) {
  // An ISOLATED runtime has the image's layout, not the host's: HOME and CODEX_HOME are the
  // container's (CODEX_HOME is the bind-mounted per-install codex home that carries auth.json),
  // TMPDIR is the container's tmpfs, and PATH is the image's — the daemon's toolchain launcher dir
  // does not exist there. The channel's own secrets still ride in through safeSpawnEnv, and the
  // gateway-owned values are still applied last so a channel secret cannot displace them.
  if (isIsolatedTarget(target)) {
    const image = containerPaths(target);
    const base = buildChildEnv({
      ...safeSpawnEnv(extraEnv),
      ...browserSpawnEnv(browserNamespace),
      NODE_USE_ENV_PROXY: "1",
      ...(source.CODEX_API_KEY || source.OPENAI_API_KEY ? { CODEX_API_KEY: source.CODEX_API_KEY || source.OPENAI_API_KEY } : {}),
    }, source);
    return {
      ...dropHostLocationEnv(base),
      HOME: image.home,
      CODEX_HOME: image.codexHome,
      TMPDIR: image.tmpDir,
      PATH: image.path,
    };
  }
  throw new Error("Codex runs only inside a channel container");
}

function commandError(message, details = {}) {
  const err = new Error(message);
  err.details = details;
  return err;
}


export async function runCodex({
  cwd,
  prompt,
  extraEnv = {},
  browserNamespace = "",
  sessionId,
  isNewSession,
  dangerouslySkip = false,
  writable = false,
  networkMode = "off",
  clean = false,
  autoApprove = false,
  composioUserEndpoint = null,
  composioEndpoint = null,
  composioUserToken = "",
  composioToken = "",
  toolboxToken = "",
  makeToolboxUrl = "",
  makeToolboxKey = "",
  codexMcpPolicy = null,
  gatewayCapability = "",
  gatewayFsRoot = "",
  gatewayWorkspaceRoot = "",
  progressReport = false,
  model = "",
  effort = "",
  codexStateDir = "",
  personalSkills = null,
  attachments = [],
  // Where this turn runs (src/runtimes/): the channel's container.
  target = null,
  // Per-run ENGINE-FACING files (the -o answer file, the secret bundle) for an isolated target:
  // a host directory bind-mounted at the IDENTICAL absolute path, so both sides name it the same
  // way. Null/absent keeps today's host locations (gatewayRoot()/tmp and runTmpDir()).
  artifactDir = null,
  runId = "",
  timeoutMs = 10 * 60 * 1000,
  maxSilenceMs = null,
  signal = null,
  onDelta = null,
  onEvent = null,
  onSessionResolved = null,
}) {
  // Sign-in is checked BEFORE anything is spawned. A logged-out Codex is not reliably a fast
  // failure — depending on build and credential shape it can sit there refreshing or waiting,
  // producing no JSONL at all, which the watchdog (correctly) reads as a live-but-quiet turn and
  // the user reads as a hang. Classified here, the turn is a replay-safe `authentication` failure
  // before any work exists to lose, so the orchestrator diverts it to the other harness with a
  // visible reason. The probe fails OPEN: only a positively absent/empty credential lands here.
  const runtime = runtimeTargetOr(target, cwd);
  if (!isIsolatedTarget(runtime) || !artifactDir) {
    throw commandError("Codex runs only inside a channel container", { engine: "codex", providerError: false });
  }
  // The BACKEND answers "is this runtime's Codex signed in?" (it owns the container's codex home).
  // An optional hook — a backend that cannot tell says nothing and the turn proceeds.
  const credentialFailure = typeof runtime.runtime.credentialError === "function" ? await runtime.runtime.credentialError(runtime, "codex") : null;
  // A backend may answer with an Error or with the sentence itself; both mean the same thing here.
  const authDetail = typeof credentialFailure === "string" ? credentialFailure : String(credentialFailure?.message || "");
  if (authDetail) {
    throw commandError(String(authDetail), {
      engine: "codex",
      providerError: true,
      providerCode: "",
      providerStatus: null,
      providerKind: "authentication",
      requestedModel: model,
      replaySafe: true,
      toolUseCount: 0,
    });
  }

  // Different gateway keys can still point at the same provider thread. Serializing on the actual
  // resume id keeps the cumulative baseline single-valued and prevents divergent interleaved
  // branches. Fresh locally minted ids are already stable within their gateway thread.
  const releaseSession = await acquireKeyedLock("codex-session", sessionId || `fresh:${cwd}`, { signal });
  const accountingStartedAt = Date.now();
  const usageReader = createCodexUsageReader(runtime);
  try {
  const usageSnapshot = isNewSession
    ? { file: "", offset: 0, total: {}, model: "" }
    : await usageReader.snapshot(sessionId);
  // Per-run scratch dir (mkdtemp → mode 0700) and the secret bundle are ENGINE-FACING: the CLI
  // writes the answer to the -o file and the secret bridges read the bundle, so both live in the
  // run's artifact dir — bind-mounted at the identical absolute path — never under the gateway
  // root, which a container is deliberately denied.
  const scratchBase = path.join(artifactDir, "tmp");
  await mkdir(scratchBase, { recursive: true, mode: 0o700 });
  const scratchDir = await mkdtemp(path.join(scratchBase, "run-"));
  const outFile = path.join(scratchDir, `cg-codex-${randomUUID()}.txt`);
  const secretDir = path.join(artifactDir, "run");
  const secretBundlePath = !clean && [gatewayCapability, composioUserToken, composioToken, toolboxToken, makeToolboxKey].some(Boolean)
    ? path.join(secretDir, `cg-codex-secrets-${randomUUID()}.json`)
    : "";
  if (secretBundlePath) {
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    await writeFile(secretBundlePath, JSON.stringify({ gatewayCapability, composioUserToken, composioToken, toolboxToken, makeToolboxKey }), { mode: 0o600 });
  }
  // The `http_headers_helper` scripts the argv names: written here because buildCodexArgs stays a
  // pure argv builder. They carry no credential of their own — each one reads its entry out of the
  // 0600 bundle above — but they are still per-run files, created and removed with it.
  const headerHelpers = [];
  const args = buildCodexArgs({ prompt, sessionId, isNewSession, cwd, dangerouslySkip, writable, networkMode, clean, autoApprove, composioUserEndpoint, composioEndpoint, composioUserToken, composioToken, toolboxToken, makeToolboxUrl, makeToolboxKey, secretBundlePath, codexMcpPolicy, gatewayCapability, gatewayFsRoot, gatewayWorkspaceRoot, progressReport, model, effort, codexStateDir, personalSkills, attachments, target: runtime, outFile, headerHelpers });
  for (const spec of headerHelpers) {
    await writeFile(spec.path, headerHelperSource({ ...spec, bundlePath: secretBundlePath }), { mode: 0o700 });
  }
  const removeRunSecrets = () => [secretBundlePath, ...headerHelpers.map((spec) => spec.path)].filter(Boolean);

  return await new Promise((resolve, reject) => {
    // Minimal allowlisted env — the sandbox can't hide the child's own environment (see child-env.js).
    // detached → own process group, so kills take the MCP grandchildren too (see util/proc.js).
    const child = trackEngineChild(spawnEngineChild(runtime, {
      cmd: "codex",
      args,
      cwd,
      env: buildCodexEnv({ extraEnv, browserNamespace, target: runtime }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      runId: runId || newRunId("run"),
      kind: "turn",
    }), { engine: "codex", kind: "cold" });

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let deltaText = "";
    // Per-run, because the only cross-event state a mapping needs is where the previous assistant
    // message segment ended (see codexMessageDelta).
    const progressState = createCodexProgressState();
    let resolvedSessionId = sessionId;
    let usage = null;
    let raw = null;
    let turnError = null;
    let toolUseCount = 0;
    let timedOut = false;
    let liveFailure = null;
    let stderrBuffer = "";
    let lastNote = "";
    let lastNoteAt = 0;
    const startedAt = Date.now();
    // Child rows already opened on the card, by the child's own thread id. `codex exec --json`
    // reports collaboration as ONE anonymous `wait` item, so the identity comes from the children's
    // rollouts instead (see announceChildAgents) and this set is what keeps a repeated scan from
    // re-announcing the same child.
    const announcedChildren = new Set();
    let childScan = Promise.resolve();
    let inspectionWarning = false;
    const warnInspection = () => {
      if (inspectionWarning) return;
      inspectionWarning = true;
      try { onEvent?.({ kind: "engine_note", source: "codex", text: "Codex usage inspection is unavailable; subagent details and accounting may be incomplete." }); } catch { /* status only */ }
    };

    // Open a row per spawned child. Triggered by a collaboration item — the one signal stdout gives
    // that children exist — and serialized, because two `wait` items in a row would otherwise scan
    // the same rollouts twice and announce each child twice. Purely additive: a failed scan leaves
    // the coordination row exactly as it was.
    const announceChildAgents = () => {
      if (!resolvedSessionId) return;
      childScan = childScan.then(async () => {
        const children = await usageReader.children({
          rootSessionId: resolvedSessionId,
          startedAtMs: accountingStartedAt,
        }).catch(() => { warnInspection(); return []; });
        for (const thread of children) {
          if (announcedChildren.has(thread.sessionId)) continue;
          announcedChildren.add(thread.sessionId);
          try {
            onEvent?.({
              kind: "agent_activity",
              id: thread.sessionId,
              engine: "codex",
              ...(thread.name ? { name: thread.name } : {}),
              status: "running",
            });
          } catch {
            /* a status callback must never end a live run */
          }
        }
      }).catch(() => {});
    };

    const onAbort = () => {
      signalEngineChild(child, "SIGTERM");
      setTimeout(() => signalEngineChild(child, "SIGKILL"), 800).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Quiet ≠ dead: while the model thinks or the provider backs off after a rate limit, Codex
    // emits nothing. Report those stretches and keep waiting; end the turn only if the process is
    // gone or the absolute silence budget is exhausted.
    let silenceMs = 0;
    const watchdog = createStallWatchdog({
      timeoutMs,
      maxSilenceMs: maxSilenceMs ?? timeoutMs * DEFAULT_SILENCE_WINDOWS,
      isAlive: () => probeEngineChild(child),
      onQuiet: ({ silentMs, livenessMs }) => {
        try {
          onEvent?.({ kind: "quiet", silentMs, livenessMs, source: "codex" });
        } catch {
          /* a status callback must never end a live run */
        }
      },
      onKill: ({ silentMs }) => {
        timedOut = true;
        silenceMs = silentMs;
        onAbort();
      },
    });

    const handleLine = (line) => {
      const p = parseJsonLine(line);
      if (!p) return;
      if (codexItemMayExecuteTool(p.item)) {
        if (p.type === "item.started") toolUseCount += 1;
        else if (p.type === "item.completed" && toolUseCount === 0) toolUseCount = 1;
      }
      switch (p.type) {
        case "thread.started":
          if (p.thread_id) {
            resolvedSessionId = p.thread_id;
            // A first turn can be stopped before any result exists. Publish the native id now
            // so the gateway's Stop/resume controls never retain its provisional UUID.
            onSessionResolved?.(resolvedSessionId);
          }
          break;
        case "turn.completed":
          // Token usage (best-effort across schema variants).
          usage = p.usage || p.turn?.usage || usage;
          raw = p;
          break;
        case "turn.failed":
        case "error":
          turnError = codexTurnError(p);
          break;
        default: {
          // A collaboration item is stdout's ONLY sign that children exist: multi-agent v2 sends an
          // anonymous `wait` (no receivers, no `agents_states`), and the spawn call never reaches
          // this stream at all. Use it as the cue to go and read who those children are.
          if (codexIsCollabItem(p.item)) announceChildAgents();
          // Best-effort live progress for Slack; final answer content still comes from outFile.
          const progress = progressFromCodexEvent(p, progressState);
          if (progress?.delta) {
            deltaText = appendTail(deltaText, progress.delta, MAX_RETAINED); // fallback content only — outFile is authoritative
            onDelta?.(progress.delta);
          }
          if (progress?.event) onEvent?.(progress.event);
          for (const event of progress?.events || []) onEvent?.(event);
        }
      }
    };

    // Codex talks about its own health on stderr. Two jobs here: keep the user's status row
    // honest about what a quiet turn is waiting on, and END a turn whose credential is gone
    // instead of letting it heartbeat "starting" until somebody presses stop.
    const handleStderrLine = (line) => {
      if (!line) return;
      const note = codexDiagnosticLine(line);
      // First one immediately (it is the one that explains a stall), then at most one per window:
      // a retry loop whose text changes every attempt would otherwise redraw the Slack row as
      // fast as the CLI can log.
      const now = Date.now();
      if (note && note !== lastNote && (lastNoteAt === 0 || now - lastNoteAt >= NOTE_INTERVAL_MS)) {
        lastNote = note;
        lastNoteAt = now;
        try {
          onEvent?.({ kind: "engine_note", source: "codex", text: note });
        } catch {
          /* a status callback must never end a live run */
        }
      }
      if (liveFailure || classifyCodexLiveStderr(line) !== "authentication") return;
      // Only while the turn provably has nothing to lose. Once a tool ran or text streamed, a log
      // line never ends the run — and never makes it replayable on the other harness.
      if (toolUseCount > 0 || deltaText.trim()) return;
      liveFailure = { kind: "authentication", line: note };
      onAbort();
    };

    // Optional chaining: a backend whose environment is unavailable returns a child-shaped object
    // that emits "error" and carries no streams (runtimes/contract.js).
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      watchdog.touch();
      stdout = appendTail(stdout, chunk, MAX_RETAINED);
      buffer += chunk;
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n");
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk) => {
      // Liveness, NOT progress (see watchdog.js): counting stderr as activity would reset the
      // silence budget every time the CLI logged a retry, making a wedged-but-chatty process —
      // the classic expired-credential retry loop — immortal.
      watchdog.touchLiveness();
      stderr = appendTail(stderr, chunk, MAX_RETAINED);
      stderrBuffer += chunk;
      let i = stderrBuffer.indexOf("\n");
      while (i !== -1) {
        handleStderrLine(stderrBuffer.slice(0, i).trim());
        stderrBuffer = stderrBuffer.slice(i + 1);
        i = stderrBuffer.indexOf("\n");
      }
      if (stderrBuffer.length > 4_000) { handleStderrLine(stderrBuffer.trim()); stderrBuffer = ""; }
    });

    child.on("error", (err) => {
      watchdog.stop();
      rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      for (const file of removeRunSecrets()) rm(file, { force: true }).catch(() => {});
      reject(commandError(processFailureMessage("Codex", { spawnError: err, diagnostic: stderr }), {
        stderr: stderr.slice(0, 4000),
        exitCode: null,
        signal: null,
      }));
    });

    child.on("close", async (code, exitSignal) => {
      watchdog.stop();
      if (buffer.trim()) handleLine(buffer.trim());
      if (stderrBuffer.trim()) { handleStderrLine(stderrBuffer.trim()); stderrBuffer = ""; }

      // Authoritative final message from the -o file; fall back to accumulated deltas.
      let finalText = "";
      try {
        finalText = (await readFile(outFile, "utf8")).trim();
      } catch {
        /* no file (failed turn) */
      }
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      for (const file of removeRunSecrets()) await rm(file, { force: true }).catch(() => {});

      // A turn that attempted ANY tool, or already streamed text, may have mutated something — it
      // is never replayed, whatever the provider said. `didWork` is the single proof every failure
      // path below shares.
      const didWork = toolUseCount > 0 || Boolean(deltaText.trim());
      if (timedOut) {
        // A wedged turn is still worth classifying: the reason it went quiet is usually sitting in
        // the stderr we buffered. Naming it turns an opaque "no output" into an actionable
        // failure the orchestrator can fail over on (when nothing ran), instead of a dead end.
        // `source: "stderr"` — a log, not a verdict: only the explicit limit/auth phrasings count,
        // never the transient wording, so a wedge that already spent the whole silence budget is
        // not replayed for another one on the strength of a recovered retry line.
        const wedgedKind = classifyCodexFailure({ message: stderr, source: "stderr" });
        const waited = describeSilence(silenceMs || timeoutMs);
        if (wedgedKind && wedgedKind !== "model_rejected") {
          return reject(commandError(`${codexProcessFailureMessage(wedgedKind, stderr)} (no output for ${waited})`, {
            engine: "codex",
            providerError: true,
            providerCode: "",
            providerStatus: null,
            providerKind: wedgedKind,
            stderr: stderr.slice(0, 4000),
            requestedModel: model,
            replaySafe: !didWork,
            toolUseCount,
          }));
        }
        const wedgedNote = codexDiagnosticLine(stderr);
        return reject(commandError(
          `Codex produced no output for ${waited} — giving up${wedgedNote ? ` (last diagnostic: ${wedgedNote})` : ""}`,
          { stderr: stderr.slice(0, 4000) },
        ));
      }
      if (signal?.aborted) {
        return reject(Object.assign(commandError("Codex run was stopped before it finished.", {
          stderr: stderr.slice(0, 4000),
          exitCode: code,
          signal: exitSignal || null,
        }), { name: "AbortError" }));
      }
      // Credential loss caught on stderr mid-run (see handleStderrLine): the process was ended on
      // purpose, so report the classified failure rather than the exit code that ending produced.
      if (liveFailure && !finalText) {
        return reject(commandError(codexProcessFailureMessage(liveFailure.kind, liveFailure.line || stderr), {
          engine: "codex",
          providerError: true,
          providerCode: "",
          providerStatus: null,
          providerKind: liveFailure.kind,
          stderr: stderr.slice(0, 4000),
          requestedModel: model,
          replaySafe: !didWork,
          toolUseCount,
          exitCode: code,
          signal: exitSignal || null,
        }));
      }
      if (turnError && !finalText) {
        const replaySafe = REPLAY_SAFE_KINDS.includes(turnError.details.providerKind) && !didWork;
        return reject(commandError(turnError.message, {
          ...turnError.details,
          stderr: stderr.slice(0, 4000),
          requestedModel: model,
          replaySafe,
          toolUseCount,
        }));
      }
      if ((code !== 0 || exitSignal) && !finalText) {
        // Some Codex builds print the limit/auth notice on stderr and exit nonzero WITHOUT emitting
        // a JSON error event. Classify that too, so the same actionable message and failover path
        // apply instead of an opaque "Codex exited with code 1". Same `source: "stderr"` rule as
        // the wedge above: an unexplained exit whose log merely mentions a timeout or a reset is
        // an ordinary process failure, not a provider outage to replay.
        const kind = classifyCodexFailure({ message: stderr, source: "stderr" });
        if (kind && kind !== "model_rejected") {
          return reject(commandError(codexProcessFailureMessage(kind, stderr), {
            engine: "codex",
            providerError: true,
            providerCode: "",
            providerStatus: null,
            providerKind: kind,
            stderr: stderr.slice(0, 4000),
            requestedModel: model,
            replaySafe: !didWork,
            toolUseCount,
            exitCode: code,
            signal: exitSignal || null,
          }));
        }
        return reject(commandError(processFailureMessage("Codex", { code, signal: exitSignal, diagnostic: stderr }), {
          stderr: stderr.slice(0, 4000),
          exitCode: code,
          signal: exitSignal || null,
          engine: "codex",
          runtime: runtime.backend,
          processEnded: true,
        }));
      }

      let accounting;
      try {
        accounting = await usageReader.root({
          sessionId: resolvedSessionId,
          snapshot: usageSnapshot,
          terminalUsage: usage || {},
          configuredModel: model,
          startedAtMs: accountingStartedAt,
        });
      } catch {
        warnInspection();
        accounting = {
          usage: subtractCodexTokenUsage(usage || {}, usageSnapshot.total || {}),
          requests: [],
          exactRequests: false,
          model: model || usageSnapshot.model || "",
          sourceId: `codex-turn:${resolvedSessionId}:${Math.floor(accountingStartedAt / 1000)}`,
          startedAt: new Date(accountingStartedAt).toISOString(),
          endedAt: new Date().toISOString(),
        };
      }
      const accountingEndedAt = Date.now();
      const children = await usageReader.accounting({
        rootSessionId: resolvedSessionId,
        startedAtMs: accountingStartedAt,
        endedAtMs: accountingEndedAt,
      }).catch(() => { warnInspection(); return []; });
      // Let any in-flight live announcement land FIRST. A "running" row that arrived after the
      // terminal one below would reopen a child that has already finished.
      await childScan;
      // Close each child's row with what only the rollouts know: its name, how long it ran and what
      // it spent. A child announced live gets its own row updated (same thread id); one that only
      // the accounting pass found opens its row here rather than staying invisible.
      for (const thread of children) {
        try {
          onEvent?.({
            kind: "agent_activity",
            id: thread.sessionId,
            engine: "codex",
            ...(thread.name ? { name: thread.name } : {}),
            status: "completed",
            ...(thread.durationMs ? { elapsedMs: thread.durationMs } : {}),
            ...(thread.usage?.total_tokens ? { tokens: thread.usage.total_tokens } : {}),
          });
        } catch {
          /* a status callback must never fail a finished turn */
        }
      }

      resolve({
        content: finalText || deltaText || "",
        sessionId: resolvedSessionId,
        usage: accounting.usage,
        usageRequests: accounting.requests,
        usageAccounting: { root: accounting, children },
        runtimeModel: accounting.model || model || "",
        costUSD: null, // Codex doesn't report a dollar cost
        durationMs: Date.now() - startedAt,
        // Codex has no terminal subtype to report, so only the step count travels — enough for an
        // answerless turn's notice (run.js) to say how much work ran before the silence.
        toolUseCount,
        raw,
      });
    });
  });
  } finally {
    releaseSession();
  }
}
