// Carrying a thread's ENGINE-NATIVE history into the container that is about to run it.
//
// A session row remembers WHERE it last ran (`runtime`, migration 13 — `''` means the pre-v0.8
// host runtime, and rows written while the host backend still existed say "host"). Every channel
// runs in a container now, but a thread that last ran on the host still has its engine session
// files in the daemon's own engine state dir: resuming it from the container would find no session,
// and run.js would fall back to HEALING the thread — a fresh engine session with the chat transcript
// replayed, which throws away everything the transcript never held (compaction summaries, tool
// results, subagent transcripts, the model's working state).
//
// So before the first resume attempt, and only when the row names the host, the session's files are
// copied from the host state dir into the channel's container. Lazily (one thread, at its next
// message), overwriting the older copy and deleting nothing. The heal stays exactly where it was:
// every failure here is logged and swallowed, and the turn continues into it. A container→host
// direction no longer exists: there is no host runtime to carry to.
import path from "node:path";
import { engineSessionFiles, engineSessionState, engineStateDir } from "../engines/registry.js";
import { newRunId, runtimeCanCarry } from "../runtimes/contract.js";

export const CARRY_DIRECTIONS = Object.freeze({ IN: "host→container" });

// The backend a session row names. A row with no stamp, an unparseable one, or one from before
// migration 13 is a HOST row — that is what every session predating multi-runtime was.
export function storedRuntimeBackend(runtime) {
  if (!runtime) return "host";
  if (typeof runtime === "object") return String(runtime.backend || "host") || "host";
  try {
    const parsed = JSON.parse(String(runtime));
    return String(parsed?.backend || "host") || "host";
  } catch {
    return "host";
  }
}

// Pair the engine's relative paths with the two state dirs. `from`/`to` are absolute on their own
// side and share the relative tail, which is what lets a wildcard expanded on one side land in the
// matching place on the other (src/runtimes/copy.js).
export function buildCarryEntries({ engine, cwd, sessionId, fromDir, toDir }) {
  if (!fromDir || !toDir || fromDir === toDir) return [];
  return engineSessionFiles(engine, { cwd, sessionId }).map((entry) => Object.freeze({
    rel: entry.rel,
    kind: entry.kind,
    from: path.join(fromDir, entry.rel),
    to: path.join(toDir, entry.rel),
  }));
}

/**
 * Carry a thread's engine session files from the host state dir into the container about to run it.
 *
 * @param {object} options
 * @param {string} options.engine        the harness the resume will use
 * @param {string} options.sessionId     the stored session id being resumed
 * @param {string} options.cwd           the run's ACTUAL working directory (clean mode included —
 *                                       Claude keys its transcripts by the directory it ran in)
 * @param {string} options.storedRuntime the session row's `runtime` stamp (JSON string or "")
 * @param {object} options.target        the RuntimeTarget this turn resolved to (a container)
 * @param {string} [options.slug]        for the log line
 * @param {string} [options.threadKey]   for the log line
 * @param {Function} [options.log]       console.log, injectable for tests
 * @returns {Promise<{direction: string, files: number}|null>} null when nothing was carried
 */
export async function carrySession({
  engine,
  sessionId,
  cwd,
  storedRuntime = "",
  target,
  slug = "",
  threadKey = "",
  log = console.log,
} = {}) {
  const where = `${slug}/${threadKey}`;
  const from = storedRuntimeBackend(storedRuntime);
  // Only a host row has anything to carry. A RECREATED container is still the same backend on
  // purpose: it shares the channel's HOME volume, which is never deleted, so its history is there.
  if (!sessionId || from !== "host" || !target) return null;

  try {
    if (!engineSessionState(engine)) {
      log(`[gateway] ${where}: ${engine} does not declare where it keeps a session, so its history stays on the host — the resume falls back to the existing heal`);
      return null;
    }
    // The SOURCE is the daemon's own engine state dir (no target = the host view); the DESTINATION
    // is this turn's container.
    const entries = buildCarryEntries({
      engine,
      cwd,
      sessionId,
      fromDir: engineStateDir(engine, null),
      toDir: engineStateDir(engine, target),
    });
    if (!entries.length) return null;

    // The container side owns the copy: it is the only one that can reach its own HOME volume.
    // `copyIn` is an optional contract method, so a backend that lacks it skips instead of throwing.
    if (!runtimeCanCarry(target)) {
      log(`[gateway] ${where}: the ${target.backend} runtime cannot move session state, so ${engine} session ${sessionId} stays on the host — the resume falls back to the existing heal`);
      return null;
    }
    // Hold a lease for the whole copy so the idle reaper cannot stop the container we are writing
    // into halfway through.
    const lease = target.runtime.acquireLease(target, { kind: "run", id: newRunId("run") });
    let result;
    try {
      result = await target.runtime.copyIn(target, entries);
    } finally {
      lease.release();
    }
    const files = Number(result?.copied) || 0;
    if (!files) return null;
    log(`[gateway] ${where}: carried ${engine} session ${sessionId} ${CARRY_DIRECTIONS.IN} (${files} file${files === 1 ? "" : "s"})`);
    return { direction: CARRY_DIRECTIONS.IN, files };
  } catch (error) {
    log(`[gateway] ${where}: session carry-over failed (${error?.message || error}) — the resume falls back to the existing heal`);
    return null;
  }
}
