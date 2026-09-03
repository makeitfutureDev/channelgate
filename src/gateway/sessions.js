// Thread-scoped session map. Each thread key (thread_ts, or the message ts for a top-level
// message that starts a thread) maps to a Claude session id, per channel. First message in a
// thread → new id (runner uses --session-id); replies → resume (runner uses -r). This is what
// makes a Slack thread a coherent Claude conversation. Backed by SQLite (see ../db); functions
// keep their async signatures so callers are unchanged.
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

function get(slug, threadKey) {
  const row = getDb().prepare("SELECT session_id FROM sessions WHERE slug = ? AND thread_key = ?").get(slug, threadKey);
  return row ? row.session_id : null;
}

// ── /clear generation guard ───────────────────────────────────────────────────────────────────
// Each /clear bumps a per-thread generation counter; a run captures the generation when it starts
// (sessionGeneration) and passes it back with its session writes, which are then skipped if a
// clear landed in between. This is what makes the /clear tombstone durable against the race where
// a run that was aborted by the clear still unwinds afterwards (its subprocess finished right at
// the kill, or a resume-heal path re-mints): without the check, that late saveSession/resetSession
// would silently resurrect the session the user just cleared. In-memory on purpose — both sides
// of the race (the run and the clear) live in this one daemon process, and a restart aborts the
// in-flight run anyway, so nothing stale can outlive the map.
const clearGenerations = new Map();
// run.js keys a fallback turn "<threadKey>::<engine>-fallback" for WHICHEVER engine it fell back
// to (`${threadKey}::${fallbackEngine}-fallback`) — codex-fallback was only the first case. This
// pattern must therefore match any engine id, or a claude-fallback save would look up a different
// generation than the /clear that bumped the thread and be dropped forever (the graph is
// bidirectional, so both directions exist in practice).
const FALLBACK_SUFFIX_RE = /::[a-z0-9_-]+-fallback$/;
// A fallback row belongs to its thread — /clear deletes it along with the main row — so it shares
// the thread's generation.
export function fallbackBaseThreadKey(threadKey) {
  return String(threadKey).replace(FALLBACK_SUFFIX_RE, "");
}
function genKey(slug, threadKey) {
  return `${slug}::${fallbackBaseThreadKey(threadKey)}`;
}

// The thread's current clear-generation. Capture it before a run starts and pass it to
// saveSession/resetSession so a /clear that lands mid-run invalidates those writes.
export function sessionGeneration(slug, threadKey) {
  return clearGenerations.get(genKey(slug, threadKey)) || 0;
}

function generationStale(slug, threadKey, generation) {
  return generation != null && generation !== sessionGeneration(slug, threadKey);
}

function getRow(slug, threadKey) {
  return getDb().prepare("SELECT session_id, engine, runtime FROM sessions WHERE slug = ? AND thread_key = ?").get(slug, threadKey) || null;
}

// `engine` records which harness minted `session_id` (a session id is engine-specific — Claude
// mints a UUID, Codex mints its own thread_id, and neither can resume the other's). Stamped on
// every session write so a later engine switch is detectable (see run.js's harness-switch reset).
// `runtime` records WHERE it ran — a JSON `{ backend, fingerprint, image }` (see migration 13).
// Same reason: a session is only resumable in the environment that minted it, so /status and
// /resume have to name that environment rather than assume the host.
function put(slug, threadKey, sessionId, engine = "", runtime = "") {
  getDb()
    .prepare("INSERT INTO sessions(slug, thread_key, session_id, engine, runtime) VALUES(?, ?, ?, ?, ?) ON CONFLICT(slug, thread_key) DO UPDATE SET session_id = excluded.session_id, engine = excluded.engine, runtime = excluded.runtime")
    .run(slug, threadKey, sessionId, engine, String(runtime || ""));
}

// Resolve the session for a thread. Returns { sessionId, isNew, engine } — `engine` is the harness
// that owns an EXISTING session (so the caller can detect a mid-thread engine switch); for a new
// thread it echoes back the passed engine. A new thread gets a fresh uuid persisted immediately (so
// a concurrent reply resumes the same session), stamped with the engine that will run it.
export async function resolveSession(slug, threadKey, engine = "", runtime = "") {
  const existing = getRow(slug, threadKey);
  if (existing && existing.session_id) {
    return { sessionId: existing.session_id, isNew: false, engine: existing.engine || "", runtime: existing.runtime || "" };
  }
  const sessionId = randomUUID();
  put(slug, threadKey, sessionId, engine, runtime);
  return { sessionId, isNew: true, engine, runtime: String(runtime || "") };
}

// Read a thread's stored session id WITHOUT minting one (null when the thread has none). Used by
// paths that must not create a session as a side effect (e.g. the Codex fallback's own thread).
export async function getSession(slug, threadKey) {
  return get(slug, threadKey);
}

// The harness that minted a thread's LIVE session ("" when the thread has none, was /clear-ed, or
// is a pre-v4 row with no engine stamp). Lets the Slack layer detect — before the run — that the
// thread's engine changed (a /model wizard pick, a "claude"/"codex" directive, or a flipped
// default) and replay the thread context, since run.js will mint a fresh, blind session.
export async function getSessionEngine(slug, threadKey) {
  const row = getRow(slug, threadKey);
  return row && row.session_id ? row.engine || "" : "";
}

// The runtime environment a thread's LIVE session last ran in, parsed from the row's JSON stamp
// ({ backend, fingerprint, image }). `null` when the thread has no session, was /clear-ed, or was
// written before migration 13 — every one of those is a host row, and callers render the host
// form. Never throws on a malformed value: a status line must not be the thing that fails.
export async function getSessionRuntime(slug, threadKey) {
  const row = getRow(slug, threadKey);
  if (!row || !row.session_id || !row.runtime) return null;
  try {
    const parsed = JSON.parse(row.runtime);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Persist an ENGINE-RETURNED session id for a thread. Codex mints its own thread_id server-side
// (unlike Claude, which accepts our locally-minted UUID), so after a Codex turn the returned id
// must replace the stored one — otherwise `codex exec resume <ourUUID>` never finds the thread
// and every turn silently starts context-less. `engine` stamps the harness that owns the id.
// `generation` (when passed — see sessionGeneration) drops the write if the thread was /clear-ed
// after the caller captured it, so a late-finishing run can't re-save over the tombstone.
export async function saveSession(slug, threadKey, sessionId, engine = "", generation = null, runtime = "") {
  if (!sessionId) return;
  if (generationStale(slug, threadKey, generation)) return;
  put(slug, threadKey, sessionId, engine, runtime);
}

export async function getSessionMap(slug) {
  const rows = getDb().prepare("SELECT thread_key, session_id FROM sessions WHERE slug = ?").all(slug);
  const map = {};
  for (const r of rows) map[r.thread_key] = r.session_id;
  return map;
}

// Replace a thread's session with a fresh uuid and persist it. Used when a resume fails because
// the stored session no longer exists (deleted/expired), or when the thread's engine switched and
// the old engine's session can't be resumed by the new one — the next run starts a clean session
// under `engine` (stamped so the switch isn't re-detected on the following turn).
// `generation` works as in saveSession: a stale caller still gets a usable throwaway id (its run
// carries on in a session no one will resume), but the tombstone in the table stands.
export async function resetSession(slug, threadKey, engine = "", generation = null, runtime = "") {
  const sessionId = randomUUID();
  if (!generationStale(slug, threadKey, generation)) put(slug, threadKey, sessionId, engine, runtime);
  return sessionId;
}

// Forget a thread's session so the next message starts fresh (used by /clear). Tombstones the
// row (empty session_id) instead of deleting it: the row's existence is the persistent "the bot
// has had a session in this thread" marker that gates thread-context replay — deleting it would
// make the next reply re-inject the whole thread history (including the bot's own answers),
// defeating /clear and re-billing the tokens. An empty session_id is falsy everywhere a live id
// is expected, so resolveSession still mints a fresh session on the next message. An UPSERT, not
// an UPDATE: on a thread with no row yet (cleared before the bot's first run) an UPDATE would
// change nothing, leaving no marker — and the next reply would replay the very conversation the
// user just cleared. The insert leaves an empty-session tombstone row either way. Also bumps the
// thread's clear-generation, invalidating any in-flight run's later session writes (see
// sessionGeneration). EVERY fallback row of the thread (run.js keys them
// "<threadKey>::<engine>-fallback") IS deleted — they're not replay markers, and a cleared thread
// must not resume stale fallback context under any engine. Returns whether a row was written
// (always true now that the rowless case inserts one — no caller branches on it).
export async function clearSession(slug, threadKey) {
  clearGenerations.set(genKey(slug, threadKey), sessionGeneration(slug, threadKey) + 1);
  const info = getDb()
    .prepare("INSERT INTO sessions(slug, thread_key, session_id, engine, runtime) VALUES(?, ?, '', '', '') ON CONFLICT(slug, thread_key) DO UPDATE SET session_id = '', engine = '', runtime = ''")
    .run(slug, threadKey);
  // LIKE with an explicit ESCAPE so a thread key containing % or _ can't widen the delete into
  // other threads' rows. The trailing "-fallback" keeps it to fallback keys only.
  const prefix = String(threadKey).replace(/[\\%_]/g, (c) => `\\${c}`);
  getDb()
    .prepare("DELETE FROM sessions WHERE slug = ? AND thread_key LIKE ? ESCAPE '\\'")
    .run(slug, `${prefix}::%-fallback`);
  return info.changes > 0;
}

// Whether the bot has EVER had a session in this thread (live or /clear-tombstoned). Used to
// replay a thread's earlier messages only the very first time the bot is pulled in — never after
// a /clear, and without loading the whole per-channel map.
export async function hasThreadSession(slug, threadKey) {
  return Boolean(getDb().prepare("SELECT 1 FROM sessions WHERE slug = ? AND thread_key = ?").get(slug, threadKey));
}
