// Carrying a thread's ENGINE-NATIVE history across the container ↔ sudo-host boundary.
//
// A session row remembers WHERE it last ran (`runtime`, migration 13 — `''` means the pre-v0.8
// host runtime, and rows written while the host backend still existed say "host"). Every channel
// Ordinary runs use a container, while `/sudo` deliberately crosses to the host. A thread that
// last ran on either side keeps its engine session files there; resuming on the other side would
// find no session,
// and run.js would fall back to HEALING the thread — a fresh engine session with the chat transcript
// replayed, which throws away everything the transcript never held (compaction summaries, tool
// results, subagent transcripts, the model's working state).
//
// So before the first resume attempt, and only when the backend changed, the session's files are
// copied to the side about to run. This preserves compactions and native tool/subagent state when
// an admin turns `/sudo` on or off. Every failure remains non-fatal and falls back to healing.
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
 * Carry a thread's engine session files to the backend about to run it.
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
  // A recreated container is the same backend on purpose: its persistent HOME already has state.
  if (!sessionId || !target || from === to) return null;

  try {
    if (!engineSessionState(engine)) {
      log(`[gateway] ${where}: ${engine} does not declare where it keeps a session, so its history stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
    const direction = to === "host" ? CARRY_DIRECTIONS.OUT : CARRY_DIRECTIONS.IN;
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

    // The container side owns the copy in both directions because only it can reach its HOME
    // volume. copyIn/copyOut remain optional backend capabilities.
    const mover = to === "host" ? source : destination;
    if (!runtimeCanCarry(mover)) {
      log(`[gateway] ${where}: the ${mover.backend} runtime cannot move session state, so ${engine} session ${sessionId} stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
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
