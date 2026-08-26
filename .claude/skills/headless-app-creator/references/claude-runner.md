# Claude CLI Runner — Complete Reference

The Claude runner wraps the `claude` CLI binary as a Node.js subprocess. It handles argument construction, stdout line buffering, timeout, and both full (wait-for-result) and streaming modes.

---

## Full implementation: `src/engines/claude.js`

```js
import { spawn } from "node:child_process";

const MAX_LOG_CHARS = 8_000;

function truncateLog(value) {
  if (!value) return "";
  return value.length > MAX_LOG_CHARS
    ? `${value.slice(0, MAX_LOG_CHARS)}\n...[truncated]`
    : value;
}

function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// ── Argument builder ──────────────────────────────────────────────────────────
export function buildClaudeArgs({ prompt, sessionId, turnCount, permissionMode, outputFormat }) {
  const args = ["-p", prompt.trim()];

  // First turn: Claude creates the session. Subsequent turns: Claude resumes it.
  if (turnCount === 0) args.push("--session-id", sessionId);
  else args.push("-r", sessionId);

  args.push("--output-format", outputFormat);

  if (outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }

  if (permissionMode === "full") {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

// ── Error factories ───────────────────────────────────────────────────────────
function createCommandError(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  return error;
}

// ── Subprocess runner ─────────────────────────────────────────────────────────
async function runClaudeCommand({ args, cwd, timeoutMs, onStdoutLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutBuffer += chunk;

      // Emit complete lines as they arrive
      while (stdoutBuffer.includes("\n")) {
        const index = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) onStdoutLine?.(line);
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(createCommandError(err.message, {
        stdout: truncateLog(stdout), stderr: truncateLog(stderr), exitCode: null
      }));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);

      // Flush any trailing partial line
      const trailing = stdoutBuffer.trim();
      if (trailing) onStdoutLine?.(trailing);

      if (timedOut) {
        reject(createCommandError(`Claude command timed out after ${timeoutMs}ms`, {
          stdout: truncateLog(stdout), stderr: truncateLog(stderr), exitCode: null
        }));
        return;
      }

      if (code !== 0) {
        reject(createCommandError(`Claude exited with code ${code}`, {
          stdout: truncateLog(stdout), stderr: truncateLog(stderr), exitCode: code
        }));
        return;
      }

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// ── Runner factory ────────────────────────────────────────────────────────────
export function createClaudeRunner({ timeoutMs }) {

  // Full mode: run once, wait for result JSON
  async function runFull({ session, prompt }) {
    const args = buildClaudeArgs({
      prompt,
      sessionId: session.sessionId,
      turnCount: session.turnCount,
      permissionMode: session.permissionMode,
      outputFormat: "json"
    });

    const { stdout, stderr } = await runClaudeCommand({
      args,
      cwd: session.workingDir,
      timeoutMs
    });

    const payload = parseJsonLine(stdout.trim());
    if (!payload || payload.type !== "result") {
      throw createCommandError("Claude returned malformed JSON output", {
        stdout: truncateLog(stdout), stderr: truncateLog(stderr), exitCode: 0
      });
    }

    return {
      content: payload.result ?? "",
      stdout: truncateLog(stdout),
      stderr: truncateLog(stderr),
      raw: payload
    };
  }

  // Stream mode: emit deltas as they arrive
  async function runStream({ session, prompt, onDelta }) {
    const args = buildClaudeArgs({
      prompt,
      sessionId: session.sessionId,
      turnCount: session.turnCount,
      permissionMode: session.permissionMode,
      outputFormat: "stream-json"
    });

    let assistantText = "";
    let resultPayload = null;

    const { stdout, stderr } = await runClaudeCommand({
      args,
      cwd: session.workingDir,
      timeoutMs,
      onStdoutLine: (line) => {
        const payload = parseJsonLine(line);
        if (!payload) return;

        // Delta event: extract text and call onDelta
        if (
          payload.type === "stream_event" &&
          payload.event?.type === "content_block_delta"
        ) {
          const deltaText =
            payload.event?.delta?.text ??
            payload.event?.delta?.delta?.text ??
            payload.event?.delta?.content ??
            "";
          if (deltaText) {
            assistantText += deltaText;
            onDelta?.(deltaText);
          }
          return;
        }

        // Final result payload
        if (payload.type === "result") {
          resultPayload = payload;
        }
      }
    });

    const content = assistantText || resultPayload?.result || "";
    if (!content && !resultPayload) {
      throw createCommandError("Claude streaming output did not include a final result", {
        stdout: truncateLog(stdout), stderr: truncateLog(stderr), exitCode: 0
      });
    }

    return {
      content,
      stdout: truncateLog(stdout),
      stderr: truncateLog(stderr),
      raw: resultPayload
    };
  }

  return { runFull, runStream };
}
```

---

## Engine health check: `src/services/engine-health.js`

```js
import { spawn } from "node:child_process";

function runVersion(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function getEngineHealth() {
  const [claude, gemini] = await Promise.all([
    runVersion("claude").then(() => ({ available: true }))
      .catch((err) => ({ available: false, reason: err.message })),
    runVersion("gemini").then(() => ({ available: true }))
      .catch((err) => ({ available: false, reason: err.message }))
  ]);

  return { engines: { claude, gemini } };
}
```

---

## Key CLI flags explained

| Flag | Purpose |
|------|---------|
| `-p <prompt>` | Provide the prompt (required) |
| `--session-id <uuid>` | Create a new named session (first turn only) |
| `-r <uuid>` | Resume an existing session (all subsequent turns) |
| `--output-format json` | Return a single JSON result when done |
| `--output-format stream-json` | Stream NDJSON events as tokens arrive |
| `--verbose` | Include detailed event stream (needed for delta events) |
| `--include-partial-messages` | Emit `assistant` events with partial content |
| `--dangerously-skip-permissions` | Allow all tool use without permission prompts (full mode) |

---

## Timeout configuration

Parse a flexible timeout string from env:

```js
// src/server.js
function parseTimeoutMs(value) {
  if (!value) return 10 * 60 * 1000; // default: 10m
  const match = /^(\d+)(ms|s|m)?$/i.exec(value.trim());
  if (!match) return 10 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "s") return amount * 1000;
  return amount;
}

const timeoutMs = parseTimeoutMs(process.env.COMMAND_TIMEOUT ?? "10m");
const claudeRunner = createClaudeRunner({ timeoutMs });
```

---

## App-level working directory

All Claude subprocesses run with `cwd` set to the app's working folder (`~/.appname/`). This is NOT per-session — it's set once on server startup via `ensureWorkspace()` and passed to the runner factory. The AI agent auto-discovers `.agents/agent.md` and `.agents/skills/` in this directory via symlinks.

```js
// In server.js
const claudeRunner = createClaudeRunner({ timeoutMs, workingDir: WORK_DIR });

// In the runner, use workingDir instead of session.workingDir
const { stdout, stderr } = await runClaudeCommand({
  args,
  cwd: workingDir,  // always ~/.appname/
  timeoutMs
});
```

---

## Error structure

All runner errors have a `details` object for debugging:

```js
{
  message: "Claude exited with code 1",
  details: {
    stdout: "...",  // truncated to 8000 chars
    stderr: "...",
    exitCode: 1     // or null for timeout/spawn errors
  }
}
```

The API routes catch these and include them in error logs:

```js
} catch (error) {
  await sessionStore.recordLog(sessionId, {
    type: "command-error",
    stdout: error.details?.stdout ?? "",
    stderr: error.details?.stderr ?? "",
    exitCode: error.details?.exitCode ?? null
  });
}
```
