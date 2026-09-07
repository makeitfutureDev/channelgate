// A long-lived ("warm") Claude process for one Slack thread. It launches once in stream-json
// input+output mode and accepts many user turns over stdin, so follow-ups skip the cold
// startup + resume cost. It self-terminates after an idle window (default 10 min); the next
// message then cold-resumes via -r into a fresh warm process. Patterned on the
// headless-app-creator runner contract.
import { claudeProviderError, createStreamConsumer } from "./stream.js";
import { buildChildEnv } from "./child-env.js";
import { appendTail } from "../util/tail.js";
import { conciseProcessDiagnostic, processFailureMessage } from "../util/process-outcome.js";
import { probeEngineChild, runtimeTargetOr, signalEngineChild, spawnEngineChild } from "./runtime-target.js";
import { newRunId } from "../runtimes/contract.js";
import { createStallWatchdog, describeSilence, DEFAULT_SILENCE_WINDOWS } from "./watchdog.js";

const MAX_RETAINED = 64_000; // stderr kept for the death message — tail only, never unbounded

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export class PersistentClaudeSession {
  constructor({ cwd, args, env = null, idleMs = 10 * 60 * 1000, target = null, runId = "" }) {
    this.cwd = cwd;
    this.args = args;
    this.env = env;
    this.idleMs = idleMs;
    // Where this warm process runs (src/runtimes/). Absent = the host backend, i.e. today's spawn.
    this.target = runtimeTargetOr(target, cwd);
    // Stable for the life of the process: the container backend addresses a warm process's whole
    // group by this id, and the boot sweep filters on its `warm-` prefix.
    this.runId = runId || newRunId("warm");
    this.state = "starting"; // starting | ready | busy | dead
    this.child = null;
    this.buffer = "";
    this.turn = null; // in-flight turn context
    this.idleTimer = null;
    this.onDead = null; // pool sets this to evict the entry
  }

  start() {
    // Minimal allowlisted env — the sandbox can't hide the child's own environment (see child-env.js).
    // detached → own process group, so kills take the MCP grandchildren too (see util/proc.js).
    this.child = spawnEngineChild(this.target, {
      cmd: "claude",
      args: this.args,
      cwd: this.cwd,
      env: this.env || buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      runId: this.runId,
      kind: "warm",
    });
    // Optional chaining: a backend whose environment is unavailable returns a child-shaped object
    // that emits "error" and carries no streams (runtimes/contract.js).
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.stderr = "";

    this.child.stdout?.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr?.on("data", (chunk) => {
      // Liveness, not progress (see watchdog.js): a CLI announcing a retry or a rate-limit wait is
      // very much alive, but the turn is no further along — so it is recorded without extending
      // the silence budget a wedged-but-chatty process would otherwise never exhaust.
      this.turn?.touchLiveness?.();
      this.stderr = appendTail(this.stderr, chunk, MAX_RETAINED);
    });
    // A pipe-level failure means this warm process is unusable, whichever emitter reports it.
    const dieFromStreamError = (err) => {
      const error = new Error(processFailureMessage("Claude", { spawnError: err, diagnostic: this.stderr }));
      error.details = {
        exitCode: null,
        signal: null,
        stderr: this.stderr.slice(0, 500),
        engine: "claude",
        runtime: this.target.backend,
        processEnded: false,
      };
      this._die(error);
    };
    // stdin is its OWN EventEmitter: a write racing the process dying (EPIPE) emits 'error' there,
    // not on the child. With no listener that is an uncaught error which takes the whole daemon
    // down instead of one warm session. Route it through the same death path — the in-flight turn
    // rejects, the pool evicts this session (onDead), and the next message cold-resumes fresh.
    this.child.stdin?.on("error", dieFromStreamError);
    this.child.on("error", dieFromStreamError);
    this.child.on("close", (code, signal) => {
      if (code === 0 && !signal) {
        this._die(null);
        return;
      }
      const error = new Error(processFailureMessage("Claude", { code, signal, diagnostic: this.stderr, maxDiagnosticChars: 500 }));
      error.details = {
        exitCode: code,
        signal: signal || null,
        stderr: this.stderr.slice(0, 500),
        engine: "claude",
        runtime: this.target.backend,
        processEnded: true,
      };
      this._die(error);
    });

    this.state = "ready";
    this._armIdle();
    return this;
  }

  get alive() {
    return this.state !== "dead";
  }

  _armIdle() {
    this._clearIdle();
    this.idleTimer = setTimeout(() => this.terminate(), this.idleMs);
    this.idleTimer.unref?.();
  }
  _clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _die(err) {
    if (this.state === "dead") return;
    this.state = "dead";
    this._clearIdle();
    if (this.turn) {
      let failure = err ?? new Error("claude session ended");
      if (this.turn.providerError) {
        const provider = this.turn.providerError;
        failure = new Error(provider.message, { cause: err });
        failure.details = {
          ...(err?.details || {}),
          engine: "claude",
          processEnded: true,
          providerError: true,
          providerCode: provider.code || "",
          providerKind: provider.kind || "",
          // Same rule as the cold runner: no tool AND no text already streamed to the thread.
          replaySafe: this.turn.stream.toolUseCount === 0 && !this.turn.stream.text.trim(),
          toolUseCount: this.turn.stream.toolUseCount,
        };
      }
      this.turn.reject(failure);
      this.turn = null;
    }
    signalEngineChild(this.child, "SIGKILL"); // group kill — takes the MCP children with it
    this.onDead?.();
  }

  terminate() {
    if (this.state === "dead") return;
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    this._die(null);
  }

  // Send one user turn. Resolves { content, usage, costUSD, sessionId, durationMs }.
  // timeoutMs is the per-turn STALL watchdog: the idle timer is disarmed while a turn runs, so
  // without it a wedged CLI (stuck MCP child, dead stream) would leave the turn promise pending
  // forever — and with it the thread's whole pool chain. It is INACTIVITY-based, not a runtime
  // cap: every stdout line re-arms it (see _onStdout), so a busy turn runs as long as it needs
  // and only timeoutMs of total silence kills it. Default mirrors the cold runner's kill timer.
  send(text, { onDelta = null, onEvent = null, timeoutMs = 10 * 60 * 1000, maxSilenceMs = null } = {}) {
    if (this.state === "dead") return Promise.reject(new Error("session is dead"));
    if (this.state === "busy") return Promise.reject(new Error("session is busy"));

    this.state = "busy";
    this._clearIdle();

    return new Promise((resolve, reject) => {
      // Quiet ≠ dead: a healthy CLI waiting on the model or on rate-limit backoff produces no
      // output. The watchdog reports those stretches (onEvent → the Slack status) and only ends
      // the turn when the process is gone or the absolute silence budget runs out.
      const watchdog = createStallWatchdog({
        timeoutMs,
        maxSilenceMs: maxSilenceMs ?? timeoutMs * DEFAULT_SILENCE_WINDOWS,
        isAlive: () => probeEngineChild(this.child),
        onQuiet: ({ silentMs, livenessMs }) => {
          try {
            onEvent?.({ kind: "quiet", silentMs, livenessMs, source: "warm" });
          } catch {
            /* a status callback must never end a live turn */
          }
        },
        onKill: ({ reason, silentMs }) => {
          // _die rejects this turn and evicts the session from the pool; the next message
          // cold-resumes into a fresh warm process instead of queueing forever.
          this._die(
            new Error(
              reason === "process-gone"
                ? "Warm Claude session exited unexpectedly"
                : `Warm Claude turn produced no output for ${describeSilence(silentMs)} — giving up`,
            ),
          );
        },
      });
      this.turn = {
        startedAt: Date.now(),
        // Where this turn's stderr starts. The warm process outlives every turn, so its buffer is
        // the WHOLE session's chatter — only the slice written since this turn began can explain
        // how this turn ended.
        stderrAt: (this.stderr || "").length,
        stream: createStreamConsumer({ onDelta, onEvent }),
        providerError: null,
        result: null,
        onDelta,
        onEvent,
        touch: () => watchdog.touch(), // any stdout while this turn is in flight = progress
        touchLiveness: () => watchdog.touchLiveness(), // stderr: talking, but not progress
        resolve: (v) => {
          watchdog.stop();
          this.turn = null;
          this.state = "ready";
          this._armIdle();
          resolve(v);
        },
        reject: (e) => {
          // _die handles state; just propagate.
          watchdog.stop();
          reject(e);
        },
      };
      const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
      try {
        this.child.stdin.write(msg);
      } catch (e) {
        this._die(e);
      }
    });
  }

  // Steer the RUNNING turn: send the SDK `control_request` interrupt so the CLI stops the current
  // turn now (it comes back as a `result`, typically empty with subtype error_during_execution).
  // Unlike terminate(), the process stays warm and keeps the conversation — the next send() resumes
  // with the interrupted turn's context. Marks the in-flight turn so its result carries `interrupted`
  // (so the caller doesn't mistake the empty result for a broken session). No-op unless a turn is
  // actually in flight. Returns true when the interrupt was written.
  interrupt() {
    if (this.state !== "busy" || !this.turn) return false;
    this.turn.interrupted = true;
    const reqId = `int-${(this._interruptSeq = (this._interruptSeq || 0) + 1)}`;
    const msg = JSON.stringify({ type: "control_request", request_id: reqId, request: { subtype: "interrupt" } }) + "\n";
    try {
      this.child.stdin.write(msg);
      this.turn.touch?.(); // the interrupt counts as activity — don't let the stall watchdog fire
      return true;
    } catch (e) {
      this._die(e);
      return false;
    }
  }

  _onStdout(chunk) {
    this.turn?.touch?.(); // re-arm the stall watchdog — output means the turn is making progress
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const i = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this._handleLine(line);
    }
  }

  _handleLine(line) {
    const p = parseJsonLine(line);
    if (!p || !this.turn) return;

    // The LAST provider error wins (an earlier one the CLI recovered from must not label the turn).
    this.turn.providerError = claudeProviderError(p) || this.turn.providerError;
    this.turn.stream.consume(p);
    if (p.type === "result") {
      const t = this.turn;
      // The CLI reported a provider failure for this turn (the assistant `error` marker) and — a
      // long-lived process — stayed alive to end it as an is_error result. Print mode exits 1 on
      // the same failure and the cold runner rejects with the classified error; do the same here,
      // so the orchestrator's in-place retry and cross-engine failover see the outage instead of
      // the "API Error: …" text being posted as the reply. The process is retired with the turn
      // (_die evicts it from the pool); the retry spawns afresh, exactly as on the cold path.
      if (p.is_error === true && t.providerError && !t.interrupted) {
        this._die(new Error(t.providerError.message));
        return;
      }
      t.resolve({
        content: t.stream.text || p.result || "",
        usage: p.usage ?? null,
        costUSD: p.total_cost_usd ?? null,
        sessionId: p.session_id ?? null,
        durationMs: Date.now() - t.startedAt,
        // Same contract as the cold runner (claude.js): the CLI's own verdict on the turn travels
        // with the result, so a turn that ends with no text can say WHY instead of "(empty response)".
        endReason: String(p.subtype || ""),
        engineError: p.is_error === true,
        toolUseCount: t.stream.toolUseCount,
        // Only when the turn produced no answer: on an abort the CLI never exits, so no error path
        // ever reads what it wrote to stderr (redacted + capped by conciseProcessDiagnostic).
        ...(t.stream.text || p.result ? {} : { diagnostic: conciseProcessDiagnostic((this.stderr || "").slice(t.stderrAt)) }),
        interrupted: Boolean(t.interrupted), // we steered this turn — result is intentionally cut short
        raw: p,
      });
    }
  }
}
