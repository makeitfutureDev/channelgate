// The stall watchdog shared by every engine runner (warm Claude, cold Claude, Codex).
//
// The old rule was "no output for timeoutMs → kill". That conflates two very different states:
//
//   wedged  — the CLI is gone or will never speak again (dead stream, crashed MCP child)
//   quiet   — the CLI is healthy and waiting: the model is thinking server-side, a subagent is
//             working, or the provider returned a rate limit and the CLI is backing off before a
//             retry. The gateway's own channel hit this repeatedly — turns were killed mid-work
//             and auto-resumed, which reads to a user as the agent restarting itself.
//
// A CLI is a thin client: while the model thinks it consumes no CPU and emits nothing, so neither
// silence nor CPU tells the two apart. What DOES tell them apart is whether the process still
// exists. So quiet no longer kills — it reports. The turn keeps running, the caller surfaces the
// wait to the user, and only two things end it: the process disappearing, or a generous absolute
// silence budget being exhausted so a genuinely wedged turn can't hang forever.
//
// Two kinds of signal reach the watchdog, and conflating them is its own bug:
//
//   progress  — stdout / engine events. The turn is getting somewhere: reset the clock.
//   liveness  — engine stderr (retry, backoff, sign-in complaints). The process is talking, but
//               the turn is no further along than it was. Recorded and reported, NEVER a reset:
//               a CLI that logs a failing retry every second would otherwise push the silence
//               budget out forever, making a wedged turn immortal. Aliveness is the pid probe's
//               job, so nothing is lost by refusing stderr the reset it used to get.
//
// The caller decides what a quiet report looks like; this module only decides when to report,
// when to keep waiting, and when to give up.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// How many quiet windows we tolerate before declaring the turn wedged. 3 × 10m = 30 minutes of
// total silence, which comfortably covers provider backoff while still bounding a hung process.
export const DEFAULT_SILENCE_WINDOWS = 3;

// How long a liveness probe may take before its answer stops being useful. A host probe is a
// syscall, but a containerized one is an exec into another namespace over a CLI — it can hang on a
// wedged container daemon. A probe that never answers must not decide the turn's fate, so it times
// out into "unknown" (see below) instead of blocking the watchdog forever.
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

// The third answer. Liveness is no longer a boolean: a probe that throws or never answers has told
// us nothing, and "I could not tell" must never be read as "the process is gone" — that would end
// healthy turns whenever a container daemon hiccuped. Only a definite `false` ends a turn.
const UNKNOWN = Symbol("liveness-unknown");

export function createStallWatchdog({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSilenceMs = timeoutMs * DEFAULT_SILENCE_WINDOWS,
  // Liveness: does the child process still exist? On the host `process.kill(pid, 0)` signals
  // nothing, it just tests for the process — throws ESRCH once it's gone. A runtime backend
  // (src/runtimes/) answers the same question for a child whose pid lives in another namespace,
  // so the probe may be ASYNC and may take ~100ms. Injectable so tests need no real child.
  isAlive = () => true,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onQuiet = null, // ({ silentMs, willKeepWaiting }) → report progress to the user
  onKill = null, // ({ reason, silentMs }) → end the turn
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let lastActivity = now();
  let lastLiveness = 0; // 0 = the engine has never spoken on a non-progress channel
  let stopped = false;
  let probing = false; // one probe at a time — touch() may re-arm while one is in flight
  const sinceLiveness = () => (lastLiveness ? now() - lastLiveness : null);

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    clear();
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, timeoutMs);
    timer.unref?.();
  };

  // true | false | UNKNOWN. A sync probe (the host's) resolves on the microtask queue, so nothing
  // about the host path's timing changes.
  async function probeAlive() {
    let guard = null;
    try {
      return await Promise.race([
        (async () => Boolean(await isAlive()))(),
        new Promise((resolve) => {
          guard = setTimeout(() => resolve(UNKNOWN), probeTimeoutMs);
          guard.unref?.();
        }),
      ]);
    } catch {
      return UNKNOWN; // a probe that failed to answer is not evidence of death
    } finally {
      if (guard) clearTimeout(guard);
    }
  }

  async function tick() {
    if (stopped || probing) return;
    probing = true;
    const activityAtStart = lastActivity;
    let alive;
    try {
      alive = await probeAlive();
    } finally {
      probing = false;
    }
    // The turn may have finished while the probe was in flight — or progressed: output that
    // arrived mid-probe already re-armed the timer through touch(), and reporting "quiet" on its
    // heels would tell the user the turn stalled at the very moment it moved.
    if (stopped) return;
    if (lastActivity !== activityAtStart) return;
    const silentMs = now() - lastActivity;

    // The one unambiguous signal. A process that no longer exists is never coming back, so this
    // is the case worth acting on immediately rather than waiting out the silence budget.
    if (alive === false) {
      stopped = true;
      clear();
      onKill?.({ reason: "process-gone", silentMs, livenessMs: sinceLiveness() });
      return;
    }

    if (silentMs >= maxSilenceMs) {
      stopped = true;
      clear();
      onKill?.({ reason: "silence-budget", silentMs, livenessMs: sinceLiveness() });
      return;
    }

    // Healthy (or unprovable) but quiet: say so and keep waiting.
    onQuiet?.({ silentMs, willKeepWaiting: true, livenessMs: sinceLiveness(), liveness: alive === UNKNOWN ? "unknown" : "alive" });
    arm();
  }

  arm();

  return {
    // Any byte of stdout, or any engine event, means the turn is progressing.
    touch() {
      if (stopped) return;
      lastActivity = now();
      arm();
    },
    // The engine spoke, but not on a progress channel (stderr). Recorded so a quiet report and a
    // give-up can say "it was still logging", and deliberately NOT a reset of the silence budget.
    touchLiveness() {
      if (stopped) return;
      lastLiveness = now();
    },
    stop() {
      stopped = true;
      clear();
    },
    // For tests and status reporting.
    silentMs() {
      return now() - lastActivity;
    },
    livenessMs: sinceLiveness,
  };
}

// Standard liveness probe for a spawned child. Detached children are killed as a group elsewhere;
// here we only ask whether the direct child is still around.
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — still alive for our purposes.
    return e.code === "EPERM";
  }
}

// Human-readable silence, for the status the user sees.
export function describeSilence(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}
