// A channel container's process limit, as the run orchestrator talks about it.
//
// Three moments, one vocabulary (src/runtimes/container/pids-pressure.js owns the numbers):
//   • before a turn — ensureUp found the container full and either restarted it (nobody else was
//     working inside) or had to leave it (somebody was): the reader is told which, at the head of
//     the answer, because both change what the turn can rely on;
//   • inside the turn — the engine is told the same thing, plus the standing fact that slots are a
//     shared, finite budget that leftover processes keep (src/gateway/runtime-access.js);
//   • after an engine process died — "Claude crashed after aborting itself" is what a thread that
//     could not be started looks like from outside, and names nothing. The kernel counted every
//     refused start, so the failure can say so.
import { describePidsUse } from "../runtimes/container/pids-pressure.js";

// The answer note for what ensureUp did about a full container. "" when it did nothing.
export function containerProcessNotice(warmup) {
  if (warmup?.reclaimed) {
    return `⚠️ _This channel's container had run out of process slots (${describePidsUse(warmup.reclaimed)} in use by processes earlier work left running), so it was restarted before this turn. Browser sessions, dev servers and anything else left running in it are gone._\n\n`;
  }
  if (warmup?.processPressure) {
    const why = warmup.processPressure.others > 0 ? " and other work is still running in it, so it could not be cleared" : " and could not be cleared";
    return `⚠️ _This channel's container is nearly out of process slots (${describePidsUse(warmup.processPressure)} in use)${why}. This turn may fail until that work finishes or its leftover processes are closed._\n\n`;
  }
  return "";
}

// Which of the two notices a warm-up produced — the key a turn dedupes on, so a second warm-up
// (the way back from a retry pause) with slightly different counts does not repeat the sentence.
export function containerProcessNoticeKind(warmup) {
  return warmup?.reclaimed ? "reclaimed" : (warmup?.processPressure ? "pressure" : "");
}

const POST_MORTEM_TIMEOUT_MS = 3_000;

/**
 * After an engine run rejected: if the runtime's process limit refused starts during this turn (or
 * is exhausted right now), say so on the error. Returns the SAME error, annotated or untouched —
 * a slow, failed or absent probe never delays or replaces the failure it was asked about.
 */
export async function annotateProcessLimit(error, target, { timeoutMs = POST_MORTEM_TIMEOUT_MS } = {}) {
  try {
    if (!error || typeof error !== "object" || error.name === "AbortError") return error;
    if (error.details?.explicitStop || error.details?.providerError === true || error.details?.processLimit) return error;
    const inspect = target?.runtime?.inspectProcessLimit;
    if (typeof inspect !== "function") return error;
    let timer;
    const status = await Promise.race([
      Promise.resolve().then(() => inspect.call(target.runtime, target)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    // Evidence, not suspicion: the kernel refused a start during this turn, or the container is at
    // its cap right now. "Nearly full" (the 85% early warning) blames nothing — an engine that
    // stalled in a busy container did not die of the limit.
    if (!status || !(status.denied > 0 || status.full === true)) return error;
    const facts = { current: status.current, max: status.max, denied: Math.max(0, Number(status.denied) || 0) };
    // Worded without "thread", "fork" or "session": the session-recovery classifiers in run.js
    // match those words on the same line, and this sentence is appended to the engine's own.
    const refused = facts.denied > 0
      ? `; the limit refused ${facts.denied.toLocaleString("en-US")} new process${facts.denied === 1 ? "" : "es"} during this turn`
      : "";
    error.details = { ...(error.details || {}), processLimit: facts };
    error.message = `${String(error.message || "The engine failed").replace(/[.\s]+$/, "")} — this channel's container ran out of process slots (${describePidsUse(facts)} in use${refused}).`;
  } catch {
    /* the original failure is the one that matters */
  }
  return error;
}
