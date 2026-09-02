// Carrying a thread's ENGINE-NATIVE history across runtime backends.
//
// The problem this solves: a session row remembers WHERE it last ran (`runtime`, migration 13 —
// `''` means host, every row written before multi-runtime was a host row). Stopping, starting or
// even recreating a channel container loses nothing, because the HOME volume and the workdir bind
// outlive it. The one real loss is a thread whose CHANNEL changed backend between two messages —
// host → container when a channel is containerized, container → host when it is set to admin mode
// or pinned back. The engine's own state dir moved with it, so the resume finds no session, and
// run.js falls back to HEALING the thread: a fresh engine session with the chat transcript
// replayed. That keeps the conversation readable but throws away everything the transcript never
// held — compaction summaries, tool results, subagent transcripts, the model's own working state.
//
// So before the first resume attempt, and only when the backend actually changed, the session's
// files are copied to the side that is about to run. Lazily (one thread, at its next message),
// in both directions, overwriting the older copy and deleting nothing. The heal stays exactly
// where it was: every failure here is logged and swallowed, and the turn continues into it.
import path from "node:path";
import { engineSessionFiles, engineSessionState, engineStateDir } from "../engines/registry.js";
import { newRunId, runtimeCanCarry } from "../runtimes/contract.js";
import { resolveRuntime } from "../runtimes/resolve.js";

export const CARRY_DIRECTIONS = Object.freeze({ IN: "host→container", OUT: "container→host" });

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
 * Carry a thread's engine session files to the backend that is about to run it.
 *
 * @param {object} options
 * @param {string} options.engine        the harness the resume will use
 * @param {string} options.sessionId     the stored session id being resumed
 * @param {string} options.cwd           the run's ACTUAL working directory (clean mode included —
 *                                       Claude keys its transcripts by the directory it ran in)
 * @param {string} options.storedRuntime the session row's `runtime` stamp (JSON string or "")
 * @param {object} options.target        the RuntimeTarget this turn resolved to
 * @param {string} [options.slug]        for the log line
 * @param {string} [options.threadKey]   for the log line
 * @param {Function} [options.resolveFor] resolveRuntime, injectable for tests
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
  resolveFor = resolveRuntime,
  log = console.log,
} = {}) {
  const where = `${slug}/${threadKey}`;
  const to = String(target?.backend || "host");
  const from = storedRuntimeBackend(storedRuntime);
  // Same backend, nothing to do. A RECREATED container is still the same backend on purpose: it
  // shares the channel's HOME volume, which is never deleted, so its history is already there.
  if (!sessionId || from === to) return null;

  try {
    if (!engineSessionState(engine)) {
      log(`[gateway] ${where}: ${engine} does not declare where it keeps a session, so its history stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
    const direction = to === "host" ? CARRY_DIRECTIONS.OUT : CARRY_DIRECTIONS.IN;
    // The SOURCE is the environment the row names, which by definition is not the one this turn
    // resolved to — so it has to be resolved with an explicit backend override, because the channel
    // no longer decides that way. The DESTINATION is always this turn's own target.
    const source = resolveFor(target.slug, target.meta || {}, { backend: from });
    const destination = target;

    const entries = buildCarryEntries({
      engine,
      cwd,
      sessionId,
      fromDir: engineStateDir(engine, source),
      toDir: engineStateDir(engine, destination),
    });
    if (!entries.length) return null;

    // The CONTAINER side of the pair owns the copy in both directions: it is the only one that can
    // reach its own HOME volume. `copyIn`/`copyOut` are optional contract methods, so a backend
    // that declares neither skips instead of throwing.
    const mover = to === "host" ? source : destination;
    if (!runtimeCanCarry(mover)) {
      log(`[gateway] ${where}: the ${mover.backend} runtime cannot move session state, so ${engine} session ${sessionId} stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
    // Hold a lease for the whole copy so the idle reaper cannot stop the environment we are reading
    // from or writing into halfway through. A no-op on the host backend, which is why there is no
    // branch here; bringing a stopped container back up is the backend's own job.
    const lease = mover.runtime.acquireLease(mover, { kind: "run", id: newRunId("run") });
    let result;
    try {
      result = to === "host"
        ? await mover.runtime.copyOut(mover, entries)
        : await mover.runtime.copyIn(mover, entries);
    } finally {
      lease.release();
    }
    const files = Number(result?.copied) || 0;
    if (!files) return null;
    log(`[gateway] ${where}: carried ${engine} session ${sessionId} ${direction} (${files} file${files === 1 ? "" : "s"})`);
    return { direction, files };
  } catch (error) {
    log(`[gateway] ${where}: session carry-over failed (${error?.message || error}) — the resume falls back to the existing heal`);
    return null;
  }
}
