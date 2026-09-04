// Headless `claude` CLI runner. Spawns one subprocess per Slack message inside the channel's
// gated folder, in stream-json mode, and resolves with the final assistant text + token/cost.
// Patterns follow the headless-app-creator skill (arg builder, line buffering, timeout) plus
// the gateway-specific flags: --mcp-config / --strict-mcp-config for per-run MCP injection and
// --dangerously-skip-permissions for admin authors only.
import { claudeProviderError, createStreamConsumer } from "./stream.js";
import { argvSafePrompt } from "./contract.js";
import { buildChildEnv } from "./child-env.js";
import { safeSpawnEnv } from "../config/channel-env.js";
import { browserSpawnEnv } from "../gateway/browser-env.js";
import { conciseProcessDiagnostic, processFailureMessage } from "../util/process-outcome.js";
import { appendTail } from "../util/tail.js";
import { trackEngineChild } from "./process-registry.js";
import { containerPaths, dropHostLocationEnv, isIsolatedTarget, probeEngineChild, runtimeTargetOr, signalEngineChild, spawnEngineChild } from "./runtime-target.js";
import { newRunId } from "../runtimes/contract.js";
import { createStallWatchdog, describeSilence, DEFAULT_SILENCE_WINDOWS } from "./watchdog.js";

const MAX_LOG_CHARS = 8_000;
const MAX_RETAINED = 64_000; // stdout/stderr kept for error context — tail only, never unbounded

// Plugin skill bodies may be loaded lazily after process startup. A run-private plugin directory
// is deleted when the turn settles, so such a process must be cold (and therefore gone before
// cleanup) rather than retained in the warm pool with dangling plugin paths.
export function canUseClaudeWarmPool(runtime = {}) {
  return !runtime.preferCold && !runtime.claudePluginEphemeral;
}

// `extraEnv` is the channel's own environment secrets (config/channel-env.js). Two independent
// guards, because `extra` beats everything inherited in buildChildEnv: it is re-filtered through
// safeSpawnEnv HERE rather than trusting the caller to have done it (PATH is inherited, so
// ordering alone would not save it), and the gateway's own HOME/CLAUDE_CONFIG_DIR are listed last
// so they win outright. `browserNamespace` is gateway-owned for the same reason and sits in the
// same last group: it decides which channel's browser daemon a browser MCP child attaches to
// (gateway/browser-env.js), so a channel secret must not be able to name it.
export function buildClaudeEnv({ home = "", configDir = "", extraEnv = {}, browserNamespace = "", target = null, oauthToken = "" } = {}, source = process.env) {
  // An ISOLATED runtime (a channel container) has none of the host's layout: HOME, the config dir
  // and PATH are the image's, the daemon's toolchain launcher dir does not exist there, and the
  // engine authenticates with the gateway-held OAuth token rather than the operator's own login
  // (brief §14 — the synthetic Claude HOME symlinks into the operator's real ~/.claude and is
  // never mounted). The channel's own secrets still ride in, still re-filtered by safeSpawnEnv,
  // and the gateway-owned values are still applied LAST so a channel secret cannot displace them.
  if (isIsolatedTarget(target)) {
    const image = containerPaths(target);
    const base = buildChildEnv({ ...safeSpawnEnv(extraEnv), ...browserSpawnEnv(browserNamespace) }, source);
    return {
      ...dropHostLocationEnv(base),
      HOME: image.home,
      CLAUDE_CONFIG_DIR: image.claudeConfigDir,
      PATH: image.path,
      TMPDIR: image.tmpDir,
      ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    };
  }
  return buildChildEnv({
    ...safeSpawnEnv(extraEnv),
    ...browserSpawnEnv(browserNamespace),
    ...(home ? { HOME: home } : {}),
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    // The daemon's OWN turns (the update smoke probe — the only non-container spawn left) relay
    // the resolved login the same way. Same last group as HOME — gateway-owned, so a channel
    // secret can never displace it — and absent when there is nothing to relay.
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
  }, source);
}

function truncate(v) {
  if (!v) return "";
  return v.length > MAX_LOG_CHARS ? `${v.slice(0, MAX_LOG_CHARS)}\n...[truncated]` : v;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function buildClaudeArgs({
  prompt,
  sessionId,
  isNewSession,
  mcpConfig, // value for --mcp-config: a PATH to a 0600 file (tokens must never ride on argv)
  strictMcp,
  dangerouslySkip,
  settingsFile,
  model,
  effort,
  permissionPromptTool,
  pluginDirs = [],
  instructionFile = "",
  disallowedTools = [],
}) {
  const args = ["-p", argvSafePrompt(prompt), "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

  // The gateway grants project skills explicitly. Never inherit host-user skills/plugins/settings
  // from ~/.claude; they sit outside the org/channel/user access tiers and would defeat clean mode.
  args.push("--setting-sources", "");

  if (isNewSession) args.push("--session-id", sessionId);
  else args.push("-r", sessionId);

  // Load the gateway lockdown explicitly so a custom (real-project) work dir is never modified.
  if (settingsFile) args.push("--settings", settingsFile);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  for (const pluginDir of pluginDirs) {
    if (pluginDir) args.push("--plugin-dir", pluginDir);
  }
  // CLAUDE.md discovery is not an authority boundary. Supply the provisioned gateway instruction
  // file as an explicit prompt input while all settings sources are disabled above.
  if (instructionFile) args.push("--append-system-prompt-file", instructionFile);
  // Hard tool denials for reduced-purpose runs (the background memory review): a denied tool
  // never reaches the permission layer, so a headless run cannot even be asked about it.
  if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));

  // Route permission prompts to our MCP tool (Slack approval buttons) instead of failing headless.
  if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);

  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig);
    if (strictMcp) args.push("--strict-mcp-config");
  }

  // Admin authors in an adminMode channel only. The folder's settings also gate this:
  // the flag is ignored unless disableBypassPermissionsMode is "allow".
  if (dangerouslySkip) args.push("--dangerously-skip-permissions");

  return args;
}

// Args for a PERSISTENT (warm) session: identical gating, but the prompt is fed over stdin
// (--input-format stream-json) so one process can serve many turns without restarting.
export function buildPersistentArgs({ sessionId, isNewSession, mcpConfig, strictMcp, dangerouslySkip, settingsFile, model, effort, permissionPromptTool, pluginDirs = [], instructionFile = "", disallowedTools = [] }) {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--setting-sources", "",
  ];
  if (isNewSession) args.push("--session-id", sessionId);
  else args.push("-r", sessionId);
  if (settingsFile) args.push("--settings", settingsFile);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  for (const pluginDir of pluginDirs) {
    if (pluginDir) args.push("--plugin-dir", pluginDir);
  }
  if (instructionFile) args.push("--append-system-prompt-file", instructionFile);
  if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
  if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);
  if (mcpConfig) {
    args.push("--mcp-config", mcpConfig);
    if (strictMcp) args.push("--strict-mcp-config");
  }
  if (dangerouslySkip) args.push("--dangerously-skip-permissions");
  return args;
}

function commandError(message, details = {}) {
  const err = new Error(message);
  err.details = details;
  return err;
}

// Run one message. Resolves { content, sessionId, usage, costUSD, durationMs }.
// onEvent (optional) receives lightweight verbose events for live Slack feedback.
export async function runClaude({
  cwd,
  prompt,
  sessionId,
  isNewSession,
  mcpConfig = null,
  strictMcp = true,
  dangerouslySkip = false,
  settingsFile = null,
  model = "",
  effort = "",
  permissionPromptTool = "",
  pluginDirs = [],
  instructionFile = "",
  disallowedTools = [],
  home = "",
  configDir = "",
  extraEnv = {},
  browserNamespace = "",
  // Where this turn runs (src/runtimes/). Absent = the host backend, i.e. today's direct spawn.
  target = null,
  // The gateway's resolved Claude login, relayed as an ACCESS token (src/gateway/claude-login.js →
  // claude-token-relay.js). Used on BOTH backends: a container has no login of its own, and a host
  // child no longer has a credentials file planted in its synthetic config dir.
  claudeOauthToken = "",
  runId = "",
  timeoutMs = 10 * 60 * 1000,
  maxSilenceMs = null,
  signal = null,
  onDelta = null,
  onEvent = null,
}) {
  const args = buildClaudeArgs({ prompt, sessionId, isNewSession, mcpConfig, strictMcp, dangerouslySkip, settingsFile, model, effort, permissionPromptTool, pluginDirs, instructionFile, disallowedTools });
  const runtime = runtimeTargetOr(target, cwd);

  return new Promise((resolve, reject) => {
    // Minimal allowlisted env — the sandbox can't hide the child's own environment (see child-env.js).
    // detached → own process group, so kills take the MCP grandchildren too (see util/proc.js).
    const child = trackEngineChild(spawnEngineChild(runtime, {
      cmd: "claude",
      args,
      cwd,
      env: buildClaudeEnv({ home, configDir, extraEnv, browserNamespace, target: runtime, oauthToken: claudeOauthToken }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      runId: runId || newRunId("run"),
      kind: "turn",
    }), { engine: "claude", kind: "cold" });

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let result = null;
    let providerError = null;
    let timedOut = false;
    let aborted = false;
    const stream = createStreamConsumer({ onDelta, onEvent });

    const startedAt = Date.now();
    // Stall watchdog — INACTIVITY-based, not a runtime cap: every stdout chunk re-arms it. Quiet
    // stretches are REPORTED rather than killed (the model thinking, a subagent working, or the
    // provider backing off after a rate limit all look identical to silence); the run ends only
    // if the process disappears or the absolute silence budget is exhausted.
    let silenceMs = 0;
    const watchdog = createStallWatchdog({
      timeoutMs,
      maxSilenceMs: maxSilenceMs ?? timeoutMs * DEFAULT_SILENCE_WINDOWS,
      isAlive: () => probeEngineChild(child),
      onQuiet: ({ silentMs, livenessMs }) => {
        try {
          onEvent?.({ kind: "quiet", silentMs, livenessMs, source: "cold" });
        } catch {
          /* a status callback must never end a live run */
        }
      },
      onKill: ({ silentMs }) => {
        timedOut = true;
        silenceMs = silentMs;
        signalEngineChild(child, "SIGTERM");
        setTimeout(() => signalEngineChild(child, "SIGKILL"), 1_000).unref();
      },
    });
    const armKillTimer = () => watchdog.touch();
    // stderr says the CLI is talking, not that the turn advanced — see watchdog.js. It is
    // recorded (and reported) but never resets the silence budget, or a CLI logging a failing
    // retry loop would keep a turn that produces nothing alive forever.
    const noteLiveness = () => watchdog.touchLiveness();

    // User "stop": kill the subprocess (group) instead of letting it run to completion.
    const onAbort = () => {
      aborted = true;
      signalEngineChild(child, "SIGTERM");
      setTimeout(() => signalEngineChild(child, "SIGKILL"), 1_000).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Optional chaining, not paranoia: a runtime backend whose environment is unavailable returns
    // a child-shaped object that emits "error" and has no streams (contract.js). Touching a null
    // stream here would replace that legible failure with a TypeError.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const handleLine = (line) => {
      const p = parseJsonLine(line);
      if (!p) return;
      // The LAST provider error wins: an earlier one the CLI recovered from must not label the
      // failure that actually ended the turn.
      providerError = claudeProviderError(p) || providerError;
      stream.consume(p);
      if (p.type === "result") result = p;
    };

    child.stdout?.on("data", (chunk) => {
      armKillTimer(); // output = progress; only silence trips the stall watchdog
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
      noteLiveness(); // a CLI announcing a retry or rate-limit wait is alive, but no further along
      stderr = appendTail(stderr, chunk, MAX_RETAINED);
    });

    child.on("error", (err) => {
      watchdog.stop();
      signal?.removeEventListener("abort", onAbort);
      reject(commandError(processFailureMessage("Claude", { spawnError: err, diagnostic: stderr }), {
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: null,
        signal: null,
      }));
    });

    child.on("close", (code, exitSignal) => {
      watchdog.stop();
      signal?.removeEventListener("abort", onAbort);
      const trailing = buffer.trim();
      if (trailing) handleLine(trailing);

      if (aborted) {
        reject(commandError("Claude run was stopped before it finished.", { stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code, signal: exitSignal || null }));
        return;
      }
      if (timedOut) {
        reject(commandError(`Claude produced no output for ${describeSilence(silenceMs || timeoutMs)} — giving up`, { stdout: truncate(stdout), stderr: truncate(stderr), exitCode: null }));
        return;
      }
      if (code !== 0 || exitSignal) {
        reject(commandError(providerError?.message || processFailureMessage("Claude", { code, signal: exitSignal, diagnostic: stderr }), {
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode: code,
          signal: exitSignal || null,
          engine: "claude",
          processEnded: true,
          providerError: Boolean(providerError),
          providerCode: providerError?.code || "",
          providerKind: providerError?.kind || "",
          // Replayable only when NOTHING of this turn reached anyone: no tool, and no text already
          // streamed to the thread (a replay would append a second answer under the first half).
          replaySafe: Boolean(providerError) && stream.toolUseCount === 0 && !stream.text.trim(),
          toolUseCount: stream.toolUseCount,
        }));
        return;
      }

      const content = stream.text || result?.result || "";
      resolve({
        content,
        sessionId: result?.session_id ?? sessionId,
        usage: result?.usage ?? null,
        costUSD: result?.total_cost_usd ?? null,
        durationMs: Date.now() - startedAt,
        // How the CLI itself says the turn ended ("success", "error_during_execution",
        // "error_max_turns", …). Exit 0 does NOT mean the turn succeeded: the CLI reports an
        // aborted turn as a terminal result line with is_error and no `result` text. Kept on the
        // result so an answerless turn can name its reason instead of posting "(empty response)".
        endReason: String(result?.subtype || ""),
        engineError: result?.is_error === true,
        toolUseCount: stream.toolUseCount,
        // Only on a turn with no answer: the CLI's stderr tail is where the real cause of an
        // aborted turn is written, and exit 0 means no error path ever reads it. Redacted and
        // capped by conciseProcessDiagnostic; carried for the log, not for the reply.
        ...(content.trim() ? {} : { diagnostic: conciseProcessDiagnostic(stderr) }),
        raw: result,
      });
    });
  });
}
