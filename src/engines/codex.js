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
//   - MCP injected with `-c mcp_servers.*` overrides. Composio (HTTP+header) is bridged to stdio
//     via `npx mcp-remote` so it works regardless of Codex's HTTP-MCP support.
//   - JSONL events (`--json`): thread.started carries the session id; the authoritative final
//     message is read from the `-o` file. Token usage comes from turn.completed; no dollar cost.
//   - timeoutMs is an inactivity watchdog, not a wall-clock runtime cap: a busy Codex turn may run
//     as long as it keeps producing JSONL/progress output.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { composioUrl, skillsUrl, toolboxUrl } from "../gateway/mcp-catalog.js";
import { gatewayRoot, runTmpDir } from "../config/paths.js";
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
import { readCodexAuthState } from "./codex-auth.js";
import { redactLogValue } from "../util/redact.js";
import { normalizeNetworkDomains } from "../util/network-domains.js";
import { resolveBinPath } from "../gateway/cli-detect.js";
import { processFailureMessage } from "../util/process-outcome.js";
import { HOST_IDENTITY_PATHS } from "../gateway/host-sensitive-paths.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { collectCodexChildAccounting, readCodexRootAccounting, snapshotCodexUsage, subtractCodexTokenUsage } from "./codex-usage.js";

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
// Two requirements this places on an isolated backend's helper table, because Codex reaches these
// helpers THROUGH the secret bridge rather than launching them itself:
//   · "gateway-mcp" must be node + a script path the bridge will accept (it validates a .js
//     suffix), not a bare wrapper executable;
//   · "mcp-remote" must be the image's twin of src/mcp/remote-secret-bridge.js — the broker that
//     reads the 0600 bundle and only then starts mcp-remote — not the raw mcp-remote binary,
//     whose argv is entirely different and which would take the bundle path for a URL.
function helperScriptArgv(helper) {
  return helper.args?.length ? [...helper.args] : [helper.command];
}
// Names that can ride in a `-c` dotted key path. TOML bare keys are exactly [A-Za-z0-9_-]; anything
// else needs quoting, and quoting a `-c` segment does not mean what it means in a TOML file.
const BARE_TOML_KEY = /^[A-Za-z0-9_-]{1,120}$/;

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function codexFeatureListHasNetworkProxy(output) {
  return /^network_proxy\s+\S+\s+(?:true|false)\s*$/m.test(String(output || ""));
}

let networkProxySupported;
let networkProxyProbeAt = 0;
// Negative results are cached too (with a TTL so a CLI upgrade is noticed): the probe is a
// synchronous execFileSync with a 5s timeout, and an incompatible host retrying approved-network
// runs (scheduler, follow-ups) used to freeze the whole event loop for up to 5s per attempt.
const NEGATIVE_PROBE_TTL_MS = 60_000;
export function assertCodexNetworkProxySupported({ execImpl = execFileSync, useCache = execImpl === execFileSync } = {}) {
  if (useCache && networkProxySupported === true) return;
  if (useCache && networkProxySupported === false && Date.now() - networkProxyProbeAt < NEGATIVE_PROBE_TTL_MS) {
    throw new Error("Codex approved-domain networking requires a CLI with the network_proxy feature; refusing to broaden egress. Update Codex or turn network off");
  }
  let supported = false;
  try {
    const output = execImpl("codex", ["features", "list"], {
      encoding: "utf8",
      timeout: 5_000,
      env: buildChildEnv({}, process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    supported = codexFeatureListHasNetworkProxy(output);
  } catch {
    supported = false;
  }
  if (useCache) {
    networkProxySupported = supported;
    networkProxyProbeAt = Date.now();
  }
  if (!supported) {
    throw new Error("Codex approved-domain networking requires a CLI with the network_proxy feature; refusing to broaden egress. Update Codex or turn network off");
  }
}

function tomlDomainRules(domains) {
  return `{ ${domains.map((domain) => `${tomlString(domain)} = "allow"`).join(", ")} }`;
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
export function classifyCodexFailure({ message = "", providerType = "", status = 0 } = {}) {
  const text = `${providerType} ${message}`;
  if ((status === 400 || /invalid[_ -]?request/i.test(providerType)) && MODEL_REJECTION_RE.test(message)) return "model_rejected";
  if (status === 429 || /rate[_ -]?limit|quota|insufficient[_ -]?quota|usage[_ -]?limit/i.test(providerType) || USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (status === 401 || status === 403 || /auth|credential|unauthori[sz]ed/i.test(providerType) || AUTH_FAILURE_RE.test(text)) return "authentication";
  return "";
}

// Pre-generation rejections: the turn provably did nothing, so the orchestrator may replay it
// (with another model, or on the other harness) as long as no tool ran.
const REPLAY_SAFE_KINDS = Object.freeze(["model_rejected", "usage_limit", "authentication"]);

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
// event. Keeps the CLI's own actionable text (reset time, top-up link) instead of an exit code.
export function codexProcessFailureMessage(kind, stderr = "") {
  const detail = String(stderr || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const label = kind === "usage_limit" ? "Codex usage limit reached" : "Codex authentication failed";
  return detail ? `${label}: ${detail}` : label;
}

// Codex reports provider-side request failures as structured JSON. Preserve the useful message and
// attach the classification above so the orchestrator can retry with another model or hand the
// turn to the other harness instead of collapsing it into an opaque error.
export function codexTurnError(event) {
  const raw = event?.error;
  const message = String(raw?.message || event?.message || "codex error").trim();
  const providerType = String(raw?.type || raw?.code || "").trim();
  const status = Number(event?.status ?? raw?.status ?? 0) || 0;
  const providerError = Boolean(raw && typeof raw === "object") || event?.type === "error";
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

function codexItemMayExecuteTool(item = {}) {
  const type = String(item.type || "").replace(/[_\s-]/g, "").toLowerCase();
  return ["mcptoolcall", "commandexecution", "filechange", "websearch", "collabtoolcall"].includes(type);
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

function codexCollabEvents(item, eventType) {
  const tool = String(item.tool || item.name || "").replace(/-/g, "_").toLowerCase();
  const receivers = item.receiver_thread_ids || item.receiverThreadIds || (
    item.receiver_thread_id || item.receiverThreadId ? [item.receiver_thread_id || item.receiverThreadId] : []
  );
  const rawStates = item.agents_states || item.agentsStates || {};
  const states = rawStates && typeof rawStates === "object" && !Array.isArray(rawStates)
    ? Object.entries(rawStates)
    : [];
  const toolFailed = codexAgentStatus(item.status, "") === "failed";

  if (tool === "spawn_agent") {
    const stateIds = states.map(([threadId]) => threadId);
    const aliases = [...receivers, ...stateIds];
    const state = states[0]?.[1];
    const status = toolFailed ? "failed" : codexAgentStatus(state?.status, "running");
    const event = codexAgentEvent(
      {
        ...item,
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
  return states.map(([threadId, state]) => codexAgentEvent(
    {
      ...item,
      message: ["failed", "errored", "not_found"].includes(String(state?.status || "").toLowerCase())
        ? state?.message
        : "",
    },
    { id: threadId, status: codexAgentStatus(state?.status) },
  )).filter(Boolean);
}

export function progressFromCodexEvent(p) {
  const item = p?.item || {};
  const itemType = String(item.type || "");
  const normalizedItemType = itemType.replace(/_/g, "").toLowerCase();
  const payload = p?.payload || {};
  const normalizedPayloadType = String(payload.type || "").replace(/_/g, "").toLowerCase();

  if (normalizedPayloadType === "subagentactivity") {
    const event = codexAgentEvent(payload);
    return event ? { event } : null;
  }

  if (normalizedItemType === "collabtoolcall") {
    const events = codexCollabEvents(item, p?.type);
    if (events.length === 1) return { event: events[0] };
    if (events.length > 1) return { events };
    return null;
  }

  if (p?.type === "item.started") {
    if (itemType === "mcp_tool_call") {
      const name = codexMcpToolName(item);
      if (isProgressReportTool(name)) {
        const event = normalizeProgressReport(item.arguments);
        if (event) return { event };
        return null;
      }
      return { event: { kind: "tool_use", ...(item.id ? { id: String(item.id) } : {}), name } };
    }
    if (itemType === "command_execution") {
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
  if (p?.type === "item.completed") {
    if (itemType === "mcp_tool_call") {
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
    if (itemType === "command_execution") {
      return {
        event: {
          kind: "tool_result",
          ...(item.id ? { id: String(item.id) } : {}),
          name: item.command ? String(item.command) : "shell",
          status: item.error ? "failed" : codexAgentStatus(item.status, "completed"),
        },
      };
    }
    if (itemType === "agent_message" && typeof item.text === "string" && item.text) return { delta: item.text };
    if (/reasoning|thinking/i.test(itemType)) {
      // Completed reasoning items carry Codex's own summary text — surface its gist so the
      // status line says WHAT it was reasoning about, mirroring Claude's thinking summaries.
      const summary = typeof item.text === "string" ? thinkingSummary(item.text) : "";
      return { event: summary ? { kind: "thinking", summary } : { kind: "thinking" } };
    }
  }
  const t = p?.delta?.text ?? item.text ?? p?.text ?? "";
  if (typeof t === "string" && t && /message|delta|agent/i.test(String(p?.type || ""))) return { delta: t };
  return null;
}

// Build `codex exec` argv. `outFile` receives the final agent message (authoritative content).
export function buildCodexArgs({ prompt, sessionId, isNewSession, cwd, dangerouslySkip, writable = false, networkMode = "off", networkDomains = [], clean = false, autoApprove = false, composioUserEndpoint = null, composioEndpoint = null, composioUserToken = "", composioToken = "", skillsToken = "", toolboxToken = "", makeToolboxUrl = "", makeToolboxKey = "", secretBundlePath = "", codexMcpPolicy = null, gatewayCapability = "", gatewayFsRoot = "", gatewayWorkspaceRoot = "", progressReport = false, model = "", effort = "", codexStateDir = "", skillSupportDir = "", credentialPaths = [], toolchainPaths = [], codexExecutablePath = "", attachments = [], target = null, outFile }) {
  const runtimeTarget = runtimeTargetOr(target, cwd);
  // Inside an isolated runtime the CONTAINER is the confinement boundary, so Codex's own sandbox
  // is switched off (plan §6): no permission profiles compiled against host paths that do not
  // exist in the image, and no network_proxy — egress is the container's network mode.
  const isolated = isIsolatedTarget(runtimeTarget);
  const helper = (name) => runtimeTarget.runtime.helperCommand(runtimeTarget, name);
  if (!["off", "approved", "unrestricted"].includes(networkMode)) throw new Error(`Unknown Codex network mode: ${networkMode}`);
  if (networkMode === "unrestricted" && !dangerouslySkip) {
    throw new Error("Codex unrestricted network requires the foreground-admin sandbox bypass");
  }
  const approvedDomains = networkMode === "approved" ? normalizeNetworkDomains(networkDomains) : [];
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
  // A host path — meaningless inside the image, where CODEX_HOME (the bind-mounted container
  // codex home) is where Codex keeps its sessions.
  if (codexStateDir && !isolated) args.push("-c", `sqlite_home=${tomlString(codexStateDir)}`);

  // Confinement mirrors the channel's mode: admin → full bypass · bash/auto → workspace write ·
  // read → read-only. Non-Full runs use Codex permission profiles (0.138+), NEVER the legacy
  // -s/--sandbox or sandbox_mode/sandbox_workspace_write keys — a legacy key anywhere in the
  // loaded config stack silently switches Codex back to the broad-read legacy sandbox, which is
  // exactly the bug this replaces. --ignore-user-config keeps a host user's personal config
  // (their own sandbox_mode, approvals, MCPs, hooks, writable roots) from broadening a Slack
  // channel's run; auth still resolves via CODEX_HOME. Profile facts proven by live
  // `codex sandbox` probes (macOS, codex-cli 0.144.1):
  //   - quoted segments in `-c` dotted paths are treated literally, so symbol keys (":root")
  //     must ride inside an inline-table VALUE, never in the key path;
  //   - a profile without `extends` loses the baseline write denial (writes fall open), so both
  //     profiles extend ":read-only" and re-grant access explicitly;
  //   - ":minimal" bakes in /tmp read+write regardless of the requested access level and wins
  //     over explicit "/tmp" denies (platform runtime carve-out) — nothing sensitive may live
  //     in shared temp, which is why the per-run scratch dir sits under the sandbox-denied
  //     gateway root and reaches commands only through the child TMPDIR + the ":tmpdir" grant;
  //   - ".git" mirrors Codex's built-in workspace safeguard: readable, never writable;
  //   - ":minimal" does NOT cover developer toolchains: without the extra read grants below,
  //     git (the /usr/bin xcrun shim needs /Library/Developer), node, and python3 (Homebrew)
  //     all fail to launch, and git hard-fails ("fatal") on an EPERM read of ~/.gitconfig.
  //     The grants are read-only tool/config roots — credential stores (~/.ssh, ~/.config/gh,
  //     ~/.npmrc, ~/.git-credentials) stay denied.
  // The gateway MCP server is a separate stdio subprocess outside the command sandbox, so the
  // daemon runtime root is no longer writable (or even readable) from model-generated commands.
  if (dangerouslySkip) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (isolated) {
    // Read mode still asks Codex for a read-only sandbox — defence in depth inside the container,
    // and the one mode where a stray write would be a real surprise. Everything else runs
    // unconfined INSIDE the container, whose mounts, caps and network are the actual boundary.
    // `exec resume` dropped -s/--sandbox (see the header note), so a resumed run states the same
    // policy through its config-override twin; the approval policy set above is untouched.
    args.push("--ignore-user-config");
    const sandbox = writable ? "danger-full-access" : "read-only";
    if (resuming) args.push("-c", `sandbox_mode=${tomlString(sandbox)}`);
    else args.push("--sandbox", sandbox);
  } else {
    args.push("--ignore-user-config");
    const profile = writable ? "gateway-workspace" : "gateway-readonly";
    // Personal skill support lives in the run-private synthetic HOME. Grant only that subtree so
    // references/scripts/assets remain usable; the stable CODEX_HOME's auth/session state stays
    // unreadable to model-generated commands.
    const skillRead = skillSupportDir ? `, ${tomlString(path.resolve(skillSupportDir))} = "read"` : "";
    // Git/gh credentials in the synthetic HOME are absent from network-off profiles. Approved
    // mode grants only the same exact files/directories as Claude; they cannot be sent anywhere
    // except the compiled destination allowlist.
    const credentialReads = networkMode === "approved"
      ? [...new Set(credentialPaths.map((entry) => path.resolve(String(entry))))].map((entry) => `, ${tomlString(entry)} = "read"`).join("")
      : "";
    // The CLI launches its command host through an absolute path inside its own standalone
    // release. When that release lives under $HOME, :root=deny masks it and every shell tool
    // fails with ENOENT before the requested command starts. Re-allow only the symlink and the
    // self-contained release directory, never the surrounding ~/.codex auth/session tree.
    let codexRuntimeRead = "";
    if (codexExecutablePath) {
      const lexical = path.resolve(codexExecutablePath);
      let real = lexical;
      try { real = realpathSync(lexical); } catch { /* keep the lexical path */ }
      const releaseRoot = path.basename(path.dirname(real)) === "bin" ? path.dirname(path.dirname(real)) : path.dirname(real);
      codexRuntimeRead = `, ${tomlString(lexical)} = "read", ${tomlString(releaseRoot)} = "read"`;
    }
    // Keep Codex aligned with Claude's generated lockdown on Linux: reviewed per-user Node/CLI
    // paths (including split npm-global package roots) must survive :root=deny. These paths carry
    // binaries only; saved logins remain independently network-gated through credentialReads.
    const hostToolchainReads = [...new Set(toolchainPaths.map((entry) => path.resolve(String(entry))))]
      .map((entry) => `, ${tomlString(entry)} = "read"`).join("");
    const toolchainReads = `"/Library/Developer" = "read", "/opt/homebrew" = "read", "/usr/local" = "read"${hostToolchainReads}${skillRead}${credentialReads}${codexRuntimeRead}`;
    // `:minimal` re-opens enough of the host OS for normal binaries to launch, including host
    // identity files on Linux. Explicit path rules close those exceptions for every confined run.
    // A qualifying foreground admin takes the bypass branch above and receives no profile.
    const hostIdentityDenies = HOST_IDENTITY_PATHS.map((entry) => `, ${tomlString(entry)} = "deny"`).join("");
    const filesystem = writable
      ? `{ ":root" = "deny", ":minimal" = "read"${hostIdentityDenies}, ${toolchainReads}, ":tmpdir" = "write", ":slash_tmp" = "deny", ":workspace_roots" = { "." = "write", ".git" = "read", ".codex" = "read" } }`
      : `{ ":root" = "deny", ":minimal" = "read"${hostIdentityDenies}, ${toolchainReads}, ":tmpdir" = "deny", ":slash_tmp" = "deny", ":workspace_roots" = { "." = "read" } }`;
    args.push("-c", `default_permissions=${tomlString(profile)}`);
    args.push("-c", `permissions.${profile}.extends=":read-only"`);
    args.push("-c", `permissions.${profile}.filesystem=${filesystem}`);
    if (networkMode === "approved") {
      // The permission profile grants command networking; network_proxy makes that grant an OS-
      // enforced allowlist. Keep every local/private and listener escape hatch explicitly closed.
      args.push("-c", `features.network_proxy.enabled=true`);
      args.push("-c", `permissions.${profile}.network={ enabled = true, domains = ${tomlDomainRules(approvedDomains)}, allow_local_binding = false, dangerously_allow_non_loopback_proxy = false, dangerously_allow_all_unix_sockets = false }`);
    } else {
      args.push("-c", `features.network_proxy.enabled=false`);
      args.push("-c", `permissions.${profile}.network={ enabled = false }`);
    }
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
    // Non-secret context only — these `-c` overrides are argv-visible (`ps`), so CG_APPROVAL_SECRET
    // must NEVER ride here; the gateway MCP server falls back to the daemon's 0600
    // internal-auth.json for the secret + port instead. The MCP server inherits Codex's isolated
    // HOME, so pass daemon-resolved path roots explicitly rather than letting it derive disposable
    // defaults under that HOME.
    //
    // None of that crosses into a container: an isolated run's gateway "server" is the in-image
    // bridge to the daemon's unix socket, which needs only the signed capability (plus who is
    // asking). Handing it CG_FS_ROOT / CG_WORKSPACE_DIR / CHANNELGATE_DIR / the host PATH would
    // name host paths that do not exist in the image — and CHANNELGATE_DIR is the daemon root the
    // container is deliberately denied.
    if (!isolated) {
      args.push("-c", `mcp_servers.gateway.env.CG_FS_ROOT=${JSON.stringify(gatewayFsRoot)}`);
      args.push("-c", `mcp_servers.gateway.env.CG_WORKSPACE_DIR=${JSON.stringify(gatewayWorkspaceRoot)}`);
      args.push("-c", `mcp_servers.gateway.env.CHANNELGATE_DIR=${JSON.stringify(gatewayRoot())}`);
      args.push("-c", `mcp_servers.gateway.env.PATH=${JSON.stringify(process.env.PATH || "")}`);
    }
    if (progressReport) args.push("-c", `mcp_servers.gateway.env.CG_PROGRESS_REPORT="1"`);
    // This server is the gateway's own control plane (schedules/reminders/background/channel admin).
    // It already enforces channel/admin policy inside the tool handlers, so Codex should not add an
    // extra approval layer or invisible cancellation in headless Slack runs.
    args.push("-c", `mcp_servers.gateway.default_tools_approval_mode="approve"`);
    args.push("-c", `mcp_servers.gateway.startup_timeout_sec=60`);
  }

  const addSecretRemote = (name, url, secretName, headerName, prefix = "") => {
    if (clean || !secretBundlePath || !secretName || !url) return;
    const remote = helper("mcp-remote");
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(remote.command)}`);
    args.push("-c", `mcp_servers.${name}.args=${JSON.stringify([...(remote.args || []), secretBundlePath, secretName, url, headerName, prefix])}`);
    args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    // Cold spawns start several bridges at once and the remote endpoint may be slow to answer the
    // first initialize; Codex's default startup window (10s) intermittently dropped a server —
    // observed as composio-user tools "absent" in background runs while its twin survived.
    args.push("-c", `mcp_servers.${name}.startup_timeout_sec=120`);
  };

  const addComposio = (name, endpoint, legacyToken, secretName) => {
    if (clean) return;
    if (endpoint?.mode === "sdk" && endpoint.url) {
      const sdk = helper("composio-sdk-bridge");
      args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(sdk.command)}`);
      args.push("-c", `mcp_servers.${name}.args=${JSON.stringify([...(sdk.args || []), endpoint.url])}`);
      // The daemon root is never named to a containerized child (it is not mounted); the in-image
      // bridge reads what it needs over the daemon socket instead.
      if (!isolated) args.push("-c", `mcp_servers.${name}.env.CHANNELGATE_DIR=${JSON.stringify(gatewayRoot())}`);
      args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
      args.push("-c", `mcp_servers.${name}.startup_timeout_sec=120`);
      return;
    }
    const url = endpoint?.url || composioUrl();
    const token = endpoint?.headers?.["x-consumer-api-key"] || legacyToken;
    if (!token) return;
    addSecretRemote(name, url, secretName, "x-consumer-api-key");
  };
  addComposio("composio-user", composioUserEndpoint, composioUserToken, "composioUserToken");
  addComposio("composio-agent", composioEndpoint, composioToken, "composioToken");

  // Skills Manager MCP, same HTTP→stdio bridge, carrying this run's token as a Bearer header.
  if (!clean && skillsToken) {
    addSecretRemote("makeitfuture-skills", skillsUrl(), "skillsToken", "Authorization", "Bearer ");
  }

  // Toolbox MCP, same HTTP→stdio bridge, carrying this run's token as a Bearer header.
  if (!clean && toolboxToken) {
    addSecretRemote("makeitfuture-toolbox", toolboxUrl(), "toolboxToken", "Authorization", "Bearer ");
  }

  if (!clean && makeToolboxUrl && makeToolboxKey) {
    addSecretRemote("make-toolbox", makeToolboxUrl, "makeToolboxKey", "Authorization", "Bearer ");
  }

  // Prompt must come before image flags: Codex's `-i/--image <FILE>...` option is variadic, so any
  // positional after the last `-i` is consumed as another image and the CLI exits with no prompt.
  args.push(argvSafePrompt(prompt));

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
export function buildCodexEnv({ tmpDir = "", home = "", codexHome = "", toolchainBinDir = "", extraEnv = {}, browserNamespace = "", target = null } = {}, source = process.env) {
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
    }, source);
    return {
      ...dropHostLocationEnv(base),
      HOME: image.home,
      CODEX_HOME: image.codexHome,
      TMPDIR: image.tmpDir,
      PATH: image.path,
    };
  }
  const extra = {
    ...safeSpawnEnv(extraEnv),
    ...browserSpawnEnv(browserNamespace),
    // Node-based CLIs (Vercel included) do not honor HTTP(S)_PROXY unless this is enabled.
    // Codex's network proxy remains the enforcement boundary and still limits destinations.
    NODE_USE_ENV_PROXY: "1",
    // Sandboxed runs get the private per-run scratch dir as TMPDIR: the ":tmpdir" symbol in the
    // permission profile resolves through this variable, making it the run's only non-workspace
    // writable path. Full-access runs keep the host TMPDIR untouched.
    ...(tmpDir ? { TMPDIR: tmpDir } : {}),
    ...(home ? { HOME: home } : {}),
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    ...(toolchainBinDir ? { PATH: `${toolchainBinDir}${path.delimiter}${source.PATH || ""}` } : {}),
  };
  return buildChildEnv(extra, source);
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
  networkDomains = [],
  clean = false,
  autoApprove = false,
  composioUserEndpoint = null,
  composioEndpoint = null,
  composioUserToken = "",
  composioToken = "",
  skillsToken = "",
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
  codexUserHome = "",
  codexHome = "",
  codexStateDir = "",
  codexSkillSupportDir = "",
  codexCredentialPaths = [],
  codexToolchainPaths = [],
  codexToolchainBinDir = "",
  attachments = [],
  // Where this turn runs (src/runtimes/). Absent = the host backend, i.e. today's direct spawn.
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
}) {
  // Sign-in is checked BEFORE anything is spawned. A logged-out Codex is not reliably a fast
  // failure — depending on build and credential shape it can sit there refreshing or waiting,
  // producing no JSONL at all, which the watchdog (correctly) reads as a live-but-quiet turn and
  // the user reads as a hang. Classified here, the turn is a replay-safe `authentication` failure
  // before any work exists to lose, so the orchestrator diverts it to the other harness with a
  // visible reason. The probe fails OPEN: only a positively absent/empty credential lands here.
  const runtime = runtimeTargetOr(target, cwd);
  const isolated = isIsolatedTarget(runtime);
  // Same gate, different credential store: an isolated run does not authenticate against the host
  // auth file the daemon reads, so the BACKEND answers "is this runtime's Codex signed in?" (it
  // owns the container's codex home). An optional hook — a backend that cannot tell says nothing
  // and the turn proceeds, exactly as the host probe fails open.
  const credentialFailure = isolated
    ? (typeof runtime.runtime.credentialError === "function" ? await runtime.runtime.credentialError(runtime, "codex") : null)
    : await (async () => {
      const authState = await readCodexAuthState({ codexHome, hostCodexHome: codexStateDir });
      return authState.known && !authState.authenticated ? `Codex is not signed in: ${authState.detail}` : "";
    })();
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
  const usageSnapshot = isNewSession
    ? { file: "", offset: 0, total: {}, model: "" }
    : await snapshotCodexUsage(codexStateDir, sessionId).catch(() => ({ file: "", offset: 0, total: {}, model: "" }));
  try {
  // A probe of the HOST CLI's features. An isolated run compiles no network_proxy at all (the
  // container's network mode is the boundary), so the host binary's capabilities are irrelevant.
  if (!dangerouslySkip && !isolated && networkMode === "approved") assertCodexNetworkProxySupported();
  // Per-run scratch dir (mkdtemp → mode 0700) under the gateway root, NOT the shared system temp:
  // the permission profiles leave /tmp readable+writable (Codex ":minimal" platform carve-out), so
  // a scratch file there would be exposed to every concurrent sandboxed run. Under ~/.channelgate
  // the profiles deny everything except this exact dir, which rides in as the child TMPDIR. The
  // codex CLI itself runs outside the command sandbox and writes the -o file here regardless of mode.
  // Both files are ENGINE-FACING: the CLI writes the answer to the -o file and the secret bridges
  // read the bundle. On an isolated target they must therefore live in the run's artifact dir —
  // bind-mounted at the identical absolute path — and never under the gateway root, which a
  // container is deliberately denied. Host targets keep today's exact locations.
  const scratchBase = artifactDir ? path.join(artifactDir, "tmp") : path.join(gatewayRoot(), "tmp");
  await mkdir(scratchBase, { recursive: true, mode: 0o700 });
  const scratchDir = await mkdtemp(path.join(scratchBase, "run-"));
  const outFile = path.join(scratchDir, `cg-codex-${randomUUID()}.txt`);
  const secretDir = artifactDir ? path.join(artifactDir, "run") : runTmpDir();
  const secretBundlePath = !clean && [gatewayCapability, composioUserToken, composioToken, skillsToken, toolboxToken, makeToolboxKey].some(Boolean)
    ? path.join(secretDir, `cg-codex-secrets-${randomUUID()}.json`)
    : "";
  if (secretBundlePath) {
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    await writeFile(secretBundlePath, JSON.stringify({ gatewayCapability, composioUserToken, composioToken, skillsToken, toolboxToken, makeToolboxKey }), { mode: 0o600 });
  }
  const args = buildCodexArgs({ prompt, sessionId, isNewSession, cwd, dangerouslySkip, writable, networkMode, networkDomains, clean, autoApprove, composioUserEndpoint, composioEndpoint, composioUserToken, composioToken, skillsToken, toolboxToken, makeToolboxUrl, makeToolboxKey, secretBundlePath, codexMcpPolicy, gatewayCapability, gatewayFsRoot, gatewayWorkspaceRoot, progressReport, model, effort, codexStateDir, skillSupportDir: codexSkillSupportDir, credentialPaths: codexCredentialPaths, toolchainPaths: codexToolchainPaths, codexExecutablePath: isolated ? "" : (resolveBinPath("codex") || ""), attachments, target: runtime, outFile });

  return await new Promise((resolve, reject) => {
    // Minimal allowlisted env — the sandbox can't hide the child's own environment (see child-env.js).
    // detached → own process group, so kills take the MCP grandchildren too (see util/proc.js).
    const child = trackEngineChild(spawnEngineChild(runtime, {
      cmd: "codex",
      args,
      cwd,
      env: buildCodexEnv({ tmpDir: dangerouslySkip ? "" : scratchDir, home: codexUserHome, codexHome, toolchainBinDir: dangerouslySkip ? "" : codexToolchainBinDir, extraEnv, browserNamespace, target: runtime }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      runId: runId || newRunId("run"),
      kind: "turn",
    }), { engine: "codex", kind: "cold" });

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let deltaText = "";
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
          if (p.thread_id) resolvedSessionId = p.thread_id;
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
          // Best-effort live progress for Slack; final answer content still comes from outFile.
          const progress = progressFromCodexEvent(p);
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
      if (secretBundlePath) rm(secretBundlePath, { force: true }).catch(() => {});
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
      if (secretBundlePath) await rm(secretBundlePath, { force: true }).catch(() => {});

      // A turn that attempted ANY tool, or already streamed text, may have mutated something — it
      // is never replayed, whatever the provider said. `didWork` is the single proof every failure
      // path below shares.
      const didWork = toolUseCount > 0 || Boolean(deltaText.trim());
      if (timedOut) {
        // A wedged turn is still worth classifying: the reason it went quiet is usually sitting in
        // the stderr we buffered. Naming it turns an opaque "no output" into an actionable
        // failure the orchestrator can fail over on (when nothing ran), instead of a dead end.
        const wedgedKind = classifyCodexFailure({ message: stderr });
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
        // apply instead of an opaque "Codex exited with code 1".
        const kind = classifyCodexFailure({ message: stderr });
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
        }));
      }

      let accounting;
      try {
        accounting = await readCodexRootAccounting({
          stateDir: codexStateDir,
          sessionId: resolvedSessionId,
          snapshot: usageSnapshot,
          terminalUsage: usage || {},
          configuredModel: model,
          startedAtMs: accountingStartedAt,
        });
      } catch {
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
      const children = await collectCodexChildAccounting({
        stateDir: codexStateDir,
        rootSessionId: resolvedSessionId,
        startedAtMs: accountingStartedAt,
        endedAtMs: accountingEndedAt,
      }).catch(() => []);

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
