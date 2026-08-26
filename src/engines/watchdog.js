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

export function createStallWatchdog({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSilenceMs = timeoutMs * DEFAULT_SILENCE_WINDOWS,
  // Liveness: does the child process still exist? `process.kill(pid, 0)` signals nothing, it just
  // tests for the process — throws ESRCH once it's gone. Injectable so tests need no real child.
  isAlive = () => true,
  onQuiet = null, // ({ silentMs, willKeepWaiting }) → report progress to the user
  onKill = null, // ({ reason, silentMs }) → end the turn
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let lastActivity = now();
  let lastLiveness = 0; // 0 = the engine has never spoken on a non-progress channel
  let stopped = false;
  const sinceLiveness = () => (lastLiveness ? now() - lastLiveness : null);

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    clear();
    if (stopped) return;
    timer = setTimeout(tick, timeoutMs);
    timer.unref?.();
  };

  function tick() {
    if (stopped) return;
    const silentMs = now() - lastActivity;

    // The one unambiguous signal. A process that no longer exists is never coming back, so this
    // is the case worth acting on immediately rather than waiting out the silence budget.
    if (!isAlive()) {
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

    // Healthy but quiet: say so and keep waiting.
    onQuiet?.({ silentMs, willKeepWaiting: true, livenessMs: sinceLiveness() });
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
