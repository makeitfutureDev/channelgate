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
//
// A session can also CONTINUE another one: a Codex `/fork` writes a paginated rollout that holds
// only the child's turns and names the source rollout it was cut from, and the source may name its
// own, so `codex exec resume` walks that chain and refuses ("invalid paginated history lineage …
// missing source rollout") when a link is missing on the side about to run. The carry therefore
// follows the chain — the engine says, from a transcript's first line, which session it continues
// (`sessionState.parentSession`) — and brings every absent source along. A source the receiving
// side already has is left alone: rollouts are append-only, so that copy holds the prefix the
// fork points into, and it may be LIVE there (its own thread still running) — overwriting it
// would lose turns. The daemon reads headers on the host side only: the destination after a
// container→host copy, the source before a host→container one.
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { engineSessionFiles, engineSessionParent, engineSessionState, engineStateDir } from "../engines/registry.js";
import { newRunId, runtimeCanCarry } from "../runtimes/contract.js";
import { expandCarryEntry } from "../runtimes/copy.js";
import { resolveRuntime } from "../runtimes/resolve.js";

export const CARRY_DIRECTIONS = Object.freeze({ IN: "host→container", OUT: "container→host" });

// How many sources a carry follows up a fork chain. Every link is one more transcript to copy;
// a chain longer than this is not a conversation anyone forked by hand.
export const CARRY_LINEAGE_LIMIT = 32;

// A session header is one JSON line (Codex's `session_meta` carries the base instructions, so it
// is long, not unbounded). Past this the line is not a header and the walk stops.
const HEADER_READ_LIMIT = 4 * 1024 * 1024;

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
// matching place on the other (src/runtimes/copy.js). `ifMissing` marks a lineage source: copied
// only where the destination has no file of that name (copy.js, container/carry.js).
export function buildCarryEntries({ engine, cwd, sessionId, fromDir, toDir, ifMissing = false }) {
  if (!fromDir || !toDir || fromDir === toDir) return [];
  return engineSessionFiles(engine, { cwd, sessionId }).map((entry) => Object.freeze({
    rel: entry.rel,
    kind: entry.kind,
    from: path.join(fromDir, entry.rel),
    to: path.join(toDir, entry.rel),
    ...(ifMissing ? { ifMissing: true } : {}),
  }));
}

// The first line of a file, read without loading the rest of it. `""` when the file cannot be
// read or has no newline within the limit.
export function readFirstLine(file, limit = HEADER_READ_LIMIT) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < limit) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, limit - position), position);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(chunk));
      position += read;
    }
    return "";
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch { /* already closed */ }
  }
}

// Where this session's TRANSCRIPT file sits under a state dir on the daemon's own filesystem, or
// `""` when it is not there. Only files are headers; a subagent directory names nothing.
export function locateSessionFile(engine, { stateDir, cwd, sessionId }) {
  if (!stateDir || !sessionId) return "";
  for (const entry of engineSessionFiles(engine, { cwd, sessionId })) {
    if (entry.kind !== "file") continue;
    const abs = path.join(stateDir, entry.rel);
    const [match] = expandCarryEntry({ rel: entry.rel, kind: "file", from: abs, to: abs });
    if (match) return match.from;
  }
  return "";
}

// The session a transcript on the daemon's filesystem continues, or `""`.
export function sessionParentOnHost(engine, { stateDir, cwd, sessionId }) {
  const file = locateSessionFile(engine, { stateDir, cwd, sessionId });
  return file ? engineSessionParent(engine, readFirstLine(file)) : "";
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
 * @param {AbortSignal} [options.signal] cancellation of the turn, including container preparation
 * @param {Function} [options.announce]  progress while the source or destination container is prepared
 * @returns {Promise<{direction: string, files: number, sources: number}|null>} null when nothing
 *          was carried; `sources` counts the lineage sessions brought along with the session itself
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
  signal = null,
  announce = null,
} = {}) {
  const where = `${slug}/${threadKey}`;
  const to = String(target?.backend || "host");
  const from = storedRuntimeBackend(storedRuntime);
  // A recreated container is the same backend on purpose: its persistent HOME already has state.
  if (!sessionId || !target || from === to) return null;
  // Host transcripts can contain admin-only filesystem/tool history. Never import them for members.
  if (target.runtimeScope === "project") return null;
  // Shared channel transcripts are readable by members. Never publish host /sudo state into
  // that store, including when the receiving author is an admin. A fresh chat session heals it.
  if (to === "container" && target.container?.sharedHistory === true) return null;

  try {
    signal?.throwIfAborted();
    if (!engineSessionState(engine)) {
      log(`[gateway] ${where}: ${engine} does not declare where it keeps a session, so its history stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
    const direction = to === "host" ? CARRY_DIRECTIONS.OUT : CARRY_DIRECTIONS.IN;
    const source = resolveFor(target.slug, target.meta || {}, { backend: from, isAdminAuthor: target.runtimeScope === "admin" });
    const destination = target;
    const fromDir = engineStateDir(engine, source);
    const toDir = engineStateDir(engine, destination);
    const own = buildCarryEntries({ engine, cwd, sessionId, fromDir, toDir });
    if (!own.length) return null;

    // The container side owns the copy in both directions because only it can reach its HOME
    // volume. copyIn/copyOut remain optional backend capabilities.
    const mover = to === "host" ? source : destination;
    if (!runtimeCanCarry(mover)) {
      log(`[gateway] ${where}: the ${mover.backend} runtime cannot move session state, so ${engine} session ${sessionId} stays on ${from} — the resume falls back to the existing heal`);
      return null;
    }
    const lease = mover.runtime.acquireLease(mover, { kind: "run", id: newRunId("run") });
    let files = 0;
    let sources = 0;
    try {
      const copy = async (entries) => {
        const result = to === "host"
          ? await mover.runtime.copyOut(mover, entries, { lease, signal, announce })
          : await mover.runtime.copyIn(mover, entries, { lease, signal, announce });
        signal?.throwIfAborted();
        return Number(result?.copied) || 0;
      };
      // The side the daemon can read headers on: the destination of a copy OUT, the source of a
      // copy IN.
      const hostDir = to === "host" ? toDir : fromDir;
      const seen = new Set([sessionId]);
      if (to === "host") {
        // Copy, then read what arrived; a source the host already holds is kept as it is, but the
        // walk continues through it — its own source may still be missing.
        files = await copy(own);
        let current = files ? sessionId : "";
        while (current && seen.size <= CARRY_LINEAGE_LIMIT) {
          const parent = sessionParentOnHost(engine, { stateDir: hostDir, cwd, sessionId: current });
          if (!parent || seen.has(parent)) break;
          seen.add(parent);
          if (!locateSessionFile(engine, { stateDir: hostDir, cwd, sessionId: parent })) {
            const copied = await copy(buildCarryEntries({ engine, cwd, sessionId: parent, fromDir, toDir }));
            if (!copied) break; // the chain is broken on the far side too — nothing more to bring
            files += copied;
            sources += 1;
          }
          current = parent;
        }
      } else {
        // Read the chain on the host first, then one copy in; the container keeps any source it
        // already has (`ifMissing`).
        const entries = [...own];
        let current = sessionId;
        while (current && seen.size <= CARRY_LINEAGE_LIMIT) {
          const parent = sessionParentOnHost(engine, { stateDir: hostDir, cwd, sessionId: current });
          if (!parent || seen.has(parent)) break;
          seen.add(parent);
          if (!locateSessionFile(engine, { stateDir: hostDir, cwd, sessionId: parent })) break;
          entries.push(...buildCarryEntries({ engine, cwd, sessionId: parent, fromDir, toDir, ifMissing: true }));
          sources += 1;
          current = parent;
        }
        files = await copy(entries);
        if (!files) sources = 0;
      }
    } finally {
      lease.release();
    }
    signal?.throwIfAborted();
    if (!files) return null;
    const lineage = sources ? `, ${sources} fork source${sources === 1 ? "" : "s"}` : "";
    log(`[gateway] ${where}: carried ${engine} session ${sessionId} ${direction} (${files} file${files === 1 ? "" : "s"}${lineage})`);
    return { direction, files, sources };
  } catch (error) {
    // A user Stop must end the turn, never fall through to a fresh engine attempt.
    signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    log(`[gateway] ${where}: session carry-over failed (${error?.message || error}) — the resume falls back to the existing heal`);
    return null;
  }
}
