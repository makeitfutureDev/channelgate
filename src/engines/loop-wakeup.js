// Native-loop bridge: normalize the HARNESS's own loop tools into one gateway event.
//
// Claude Code's `/loop` skill paces itself with two built-in tools, and BOTH are dead ends in a
// gateway turn:
//   • `ScheduleWakeup` re-invokes the CURRENT session after a delay — but a gateway turn is a
//     headless `claude -p` run that exits once the answer is posted (a warm pooled process just
//     idles out), so nothing is left alive to wake.
//   • `CronCreate` is documented as session-only and in-memory ("gone when Claude exits"), and it
//     only fires "while the REPL is idle" — there is no REPL here at all.
// So the loop the user asked for silently never ticks. Rather than reimplement `/loop` as a
// gateway skill, we let the native one run unchanged and adopt its intent: the daemon already
// watches every tool-use block in the engine stream (see isProgressReportTool), so it can read the
// pacing decision the model just made and re-arm the thread itself, durably, from the schedule
// store. Whatever the harness does with its own copy of the call is irrelevant — its timer dies
// with the process; ours does not.
//
// This module is pure normalization: no store access, no scheduling. `gateway/loops.js` owns the
// arming, so the parsing can be unit-tested without a database.

// The harness sentinels for an autonomous (no user prompt) loop. They resolve against loop
// instructions that only exist inside an interactive session, so they can never be replayed
// verbatim as a gateway prompt — we substitute an explicit continue instruction instead.
const AUTONOMOUS_SENTINELS = new Set(["<<autonomous-loop-dynamic>>", "<<autonomous-loop>>"]);
export const AUTONOMOUS_LOOP_PROMPT =
  "Continue the loop you are running in this thread: do the next iteration of the task, then " +
  "decide whether to schedule another tick or stop.";

// The harness clamps its own dynamic delay to [60, 3600] seconds; matching it keeps a gateway
// tick on the same cadence the model was reasoning about, and the lower bound doubles as the
// runaway floor for a thread-bound loop.
export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3_600;

const WAKEUP_TOOLS = new Set(["ScheduleWakeup", "mcp__gateway__ScheduleWakeup"]);
const CRON_CREATE_TOOLS = new Set(["CronCreate"]);
const CRON_STOP_TOOLS = new Set(["CronDelete"]);

export function isLoopTool(name) {
  const n = String(name || "");
  return WAKEUP_TOOLS.has(n) || CRON_CREATE_TOOLS.has(n) || CRON_STOP_TOOLS.has(n);
}

function parseInput(input) {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function promptFrom(raw) {
  const p = String(raw ?? "").trim();
  if (!p) return "";
  return AUTONOMOUS_SENTINELS.has(p) ? AUTONOMOUS_LOOP_PROMPT : p;
}

function clampDelay(seconds) {
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(seconds)));
}

// A 5-field cron, the same shape util/cron.js parses. Validated there rather than here so this
// module stays dependency-free for the stream path; we only reject the obviously malformed.
function looksLikeCron(expr) {
  return String(expr || "").trim().split(/\s+/).length === 5;
}

// Normalize one tool-use block into a loop intent, or null when it isn't one (or is malformed —
// a half-streamed input must never arm a schedule).
//
// Returns one of:
//   { kind: "loop_wakeup", mode: "stop" }
//   { kind: "loop_wakeup", mode: "dynamic",  delaySeconds, prompt, reason, noop }
//   { kind: "loop_wakeup", mode: "interval", cron, recurring, prompt }
export function normalizeLoopWakeup(name, input) {
  const tool = String(name || "");
  if (CRON_STOP_TOOLS.has(tool)) {
    // The harness's job ids are its own in-memory ones and never match a gateway schedule id, so
    // a delete can only be honored at thread granularity. A thread running two native loops at
    // once is not a shape `/loop` produces, so "cancel this thread's loop" is the faithful read.
    return { kind: "loop_wakeup", mode: "stop" };
  }

  const args = parseInput(input);
  if (!args) return null;

  if (WAKEUP_TOOLS.has(tool)) {
    if (args.stop === true) return { kind: "loop_wakeup", mode: "stop" };
    const delay = Number(args.delaySeconds);
    if (!Number.isFinite(delay) || delay <= 0) return null;
    const prompt = promptFrom(args.prompt);
    if (!prompt) return null;
    return {
      kind: "loop_wakeup",
      mode: "dynamic",
      delaySeconds: clampDelay(delay),
      prompt,
      reason: String(args.reason ?? "").trim().slice(0, 240),
      noop: args.noop === true,
    };
  }

  if (CRON_CREATE_TOOLS.has(tool)) {
    const cron = String(args.cron ?? "").trim();
    if (!looksLikeCron(cron)) return null;
    const prompt = promptFrom(args.prompt);
    if (!prompt) return null;
    return {
      kind: "loop_wakeup",
      mode: "interval",
      cron,
      recurring: args.recurring !== false,
      prompt,
      reason: "",
      noop: false,
    };
  }

  return null;
}
