// Security-restricted OpenCode runner. OpenCode's permissions gate model tool calls, but they are
// not an operating-system sandbox: in particular, the shell tool runs with the host user's full
// filesystem/process/network authority. This adapter therefore exposes only read/glob/grep/list,
// denies every other action, disables plugins, omits MCP entirely, and refuses writable, network,
// or bypass requests before spawn. See docs/OPENCODE-ADAPTER.md.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { argvSafePrompt } from "./contract.js";
import { buildChildEnv } from "./child-env.js";
import { trackEngineChild } from "./process-registry.js";
import { probeEngineChild, runtimeTargetOr, signalEngineChild, spawnEngineChild } from "./runtime-target.js";
import { newRunId } from "../runtimes/contract.js";
import { createStallWatchdog, describeSilence, DEFAULT_SILENCE_WINDOWS } from "./watchdog.js";
import { appendTail } from "../util/tail.js";
import { processFailureMessage } from "../util/process-outcome.js";

const MAX_RETAINED = 64_000;

const READONLY_CONFIG = Object.freeze({
  $schema: "https://opencode.ai/config.json",
  // OpenCode V2 renamed V1's permission/agent object schema to ordered permissions/agents rules.
  // Keep both explicit forms while the stable CLI and V2 coexist. In each evaluator the broad
  // deny precedes the narrow read exceptions, and .env-style files are denied again last.
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
  ],
  agents: {
    "gateway-readonly": {
      description: "Gateway-enforced read-only, no-shell, no-network agent",
      mode: "primary",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "deny" },
        { action: "read", resource: "*.env.*", effect: "deny" },
      ],
    },
  },
  // V1 compatibility. The CLI's --pure flag disables external plugins. The explicit permission
  // policy is duplicated globally and on the selected agent so user/project config cannot broaden it.
  permission: {
    "*": "deny",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "deny",
    bash: "deny",
    shell: "deny",
    task: "deny",
    subagent: "deny",
    skill: "deny",
    lsp: "deny",
    webfetch: "deny",
    websearch: "deny",
    external_directory: "deny",
    execute: "deny",
  },
  agent: {
    "gateway-readonly": {
      description: "Gateway-enforced read-only, no-shell, no-network agent",
      mode: "primary",
      permission: {
        "*": "deny",
        read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
        glob: "allow",
        grep: "allow",
        list: "allow",
      },
    },
  },
  mcp: {},
});

export function buildOpenCodeArgs({ prompt, sessionId = "", isNewSession = true, cwd, model = "", effort = "", attachments = [] }) {
  const args = ["run", "--format", "json", "--dir", cwd, "--agent", "gateway-readonly"];
  if (!isNewSession) {
    if (!sessionId) throw new Error("OpenCode resume requires a session ID");
    args.push("--session", sessionId);
  }
  if (model) args.push("--model", model);
  if (effort) args.push("--variant", effort);
  for (const file of attachments) args.push("--file", file);
  args.push(argvSafePrompt(prompt));
  return args;
}

// OpenCode is the one engine with no OS sandbox behind its config gate, so it must not inherit
// the daemon's real HOME/XDG roots: the user's global ~/.config/opencode would join the config
// merge and their real dotfiles would be readable through plain fs access. Claude/Codex get
// per-run synthetic homes from run-grant-artifacts; OpenCode gets a stable synthetic one here —
// empty on purpose (read-only, network-off profile needs no git/gh/ssh state).
export function openCodeHome() {
  return path.join(gatewayRoot(), "engine-state", "opencode", "home");
}

export function buildOpenCodeEnv(source = process.env, { home = openCodeHome() } = {}) {
  return buildChildEnv({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(READONLY_CONFIG),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_AUTO_SHARE: "false",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }, source);
}

function jsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function progressFromOpenCodeEvent(event) {
  const part = event?.part || event?.properties?.part || {};
  if (event?.type === "text" && typeof part.text === "string") return { delta: part.text };
  if (event?.type === "tool_use") return { event: { kind: "tool_use", name: String(part.tool || part.name || "read") } };
  if (event?.type === "reasoning") return { event: { kind: "thinking" } };
  return null;
}

function commandError(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  return error;
}

export async function runOpenCode({
  cwd, prompt, sessionId, isNewSession, model = "", effort = "", attachments = [],
  timeoutMs = 10 * 60 * 1000, maxSilenceMs = null, signal = null, onDelta = null,
  // `target` is where the process runs (src/runtimes/); absent = the host backend, today's spawn.
  // `spawnImpl` stays for callers that inject a fake child directly — such a child never crossed
  // the runtime seam, so probe/signal fall back to the pid path exactly as before.
  onEvent = null, target = null, runId = "", spawnImpl = null,
}) {
  const args = buildOpenCodeArgs({ prompt, sessionId, isNewSession, cwd, model, effort, attachments });
  mkdirSync(openCodeHome(), { recursive: true, mode: 0o700 });
  const runtime = runtimeTargetOr(target, cwd);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const spawnSpec = {
      cmd: "opencode",
      args: ["--pure", ...args],
      cwd,
      env: buildOpenCodeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      runId: runId || newRunId("run"),
      kind: "turn",
    };
    const child = trackEngineChild(spawnImpl
      ? spawnImpl(spawnSpec.cmd, spawnSpec.args, { cwd, env: spawnSpec.env, stdio: spawnSpec.stdio, detached: true })
      : spawnEngineChild(runtime, spawnSpec), { engine: "opencode", kind: "cold" });
    let stderr = "";
    let buffer = "";
    let content = "";
    let resolvedSessionId = isNewSession ? "" : sessionId;
    let usage = null;
    let costUSD = null;
    let raw = null;
    let turnError = "";
    let timedOut = false;
    let silenceMs = 0;
    let settled = false;

    const abort = () => {
      signalEngineChild(child, "SIGTERM");
      setTimeout(() => signalEngineChild(child, "SIGKILL"), 800).unref();
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    const watchdog = createStallWatchdog({
      timeoutMs,
      maxSilenceMs: maxSilenceMs ?? timeoutMs * DEFAULT_SILENCE_WINDOWS,
      isAlive: () => probeEngineChild(child),
      onQuiet: ({ silentMs, livenessMs }) => { try { onEvent?.({ kind: "quiet", silentMs, livenessMs, source: "opencode" }); } catch {} },
      onKill: ({ silentMs }) => { timedOut = true; silenceMs = silentMs; abort(); },
    });

    const handle = (line) => {
      const event = jsonLine(line);
      if (!event) return;
      raw = event;
      resolvedSessionId = String(event.sessionID || event.sessionId || event.session_id || resolvedSessionId || "");
      const part = event.part || event.properties?.part || {};
      if (event.type === "step_finish") {
        // Normalize OpenCode's {input, output, reasoning, cache} into the gateway's *_tokens
        // convention — the usage ledger, isEmptyResult, and the ctx% math all read those keys;
        // raw-shaped usage recorded every turn as 0/0 tokens and made real work look empty.
        const t = part.tokens || event.tokens;
        if (t) {
          usage = {
            input_tokens: Number(t.input) || 0,
            output_tokens: (Number(t.output) || 0) + (Number(t.reasoning) || 0),
            cache_read_input_tokens: Number(t.cache?.read) || 0,
            cache_creation_input_tokens: Number(t.cache?.write) || 0,
          };
        }
        if (Number.isFinite(part.cost)) costUSD = part.cost;
      } else if (event.type === "error") {
        turnError = typeof event.error === "string" ? event.error : event.error?.message || "OpenCode error";
      }
      const progress = progressFromOpenCodeEvent(event);
      if (progress?.delta) {
        content = appendTail(content, progress.delta, MAX_RETAINED);
        onDelta?.(progress.delta);
      }
      if (progress?.event) onEvent?.(progress.event);
    };

    // Optional chaining: a backend whose environment is unavailable returns a child-shaped object
    // that emits "error" and carries no streams (runtimes/contract.js).
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      watchdog.touch();
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handle(line);
      }
    });
    child.stderr?.on("data", (chunk) => {
      // Liveness, not progress (see watchdog.js): retry/backoff logs prove the process is talking,
      // never that the turn advanced, so they must not extend the silence budget.
      watchdog.touchLiveness();
      stderr = appendTail(stderr, chunk, MAX_RETAINED);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      reject(commandError(processFailureMessage("OpenCode", { spawnError: error, diagnostic: stderr }), {
        stderr: stderr.slice(0, 4000),
        exitCode: null,
        signal: null,
      }));
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      if (buffer.trim()) handle(buffer.trim());
      if (timedOut) return reject(commandError(`OpenCode produced no output for ${describeSilence(silenceMs || timeoutMs)} — giving up`, { stderr: stderr.slice(0, 4000) }));
      if (signal?.aborted) return reject(Object.assign(commandError("OpenCode run was stopped before it finished.", { stderr: stderr.slice(0, 4000), exitCode: code, signal: exitSignal || null }), { name: "AbortError" }));
      if (turnError && !content) return reject(commandError(turnError, { stderr: stderr.slice(0, 4000) }));
      if ((code !== 0 || exitSignal) && !content) {
        return reject(commandError(processFailureMessage("OpenCode", { code, signal: exitSignal, diagnostic: stderr }), {
          stderr: stderr.slice(0, 4000),
          exitCode: code,
          signal: exitSignal || null,
        }));
      }
      if (!resolvedSessionId) return reject(commandError("OpenCode JSON stream did not report a session ID", { stderr: stderr.slice(0, 4000) }));
      resolve({ content, sessionId: resolvedSessionId, usage, costUSD, durationMs: Date.now() - startedAt, raw });
    });
  });
}
