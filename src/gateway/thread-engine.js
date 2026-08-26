// Per-thread engine override. A user can pick the engine for a thread by starting a message with
// "claude" or "codex" (e.g. "@bot codex build X"), or via the /model wizard's "just this thread"
// scope; it sticks for the thread until changed. Precedence at run time: thread override >
// channel engine (meta.engine) > global engine. Model + effort + clean get the same per-thread
// treatment further down.
//
// Backed by SQLite (thread_overrides, one keyed row per override — see db/migrations.js v11);
// functions keep their async signatures so callers are unchanged. This replaced four per-channel
// JSON files (thread-engines/models/efforts/clean.json) whose unsynchronized read-modify-writeFile
// let concurrent messages drop each other's values; a single-row upsert/delete is atomic, so a
// write for one thread can never clobber another thread's override. The old files are imported
// once at DB open and left on disk as inert backups (db/import-legacy.js importThreadOverrides).
import { getDb } from "../db/index.js";
import { ENGINE_IDS } from "../engines/registry.js";

const VALID = new Set(ENGINE_IDS);

function getOverride(slug, threadKey, kind) {
  const row = getDb()
    .prepare("SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?")
    .get(slug, threadKey, kind);
  return row ? row.value : "";
}

// An empty value clears the override (absence of a row = no override), mirroring the old writers
// which deleted the key from the JSON map.
function setOverride(slug, threadKey, kind, value) {
  if (value) {
    getDb()
      .prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?) ON CONFLICT(slug, thread_key, kind) DO UPDATE SET value = excluded.value")
      .run(slug, threadKey, kind, value);
  } else {
    getDb().prepare("DELETE FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?").run(slug, threadKey, kind);
  }
}

export async function getThreadEngine(slug, threadKey) {
  const v = getOverride(slug, threadKey, "engine");
  return VALID.has(v) ? v : "";
}

export async function setThreadEngine(slug, threadKey, engine) {
  setOverride(slug, threadKey, "engine", VALID.has(engine) ? engine : "");
}

// ── Per-thread MODEL / EFFORT overrides (the /model wizard's "just this thread" scope) ────────
// Same shape as the engine override. An empty value clears the override. Run-time precedence:
// thread override > channel meta > gateway default. A stored value is engine-specific (it becomes
// the CLI's --model / effort flag), so writers must clear it on a harness switch.

export async function getThreadModel(slug, threadKey) {
  return getOverride(slug, threadKey, "model");
}

export async function setThreadModel(slug, threadKey, model) {
  setOverride(slug, threadKey, "model", String(model || "").trim());
}

export async function getThreadEffort(slug, threadKey) {
  return getOverride(slug, threadKey, "effort");
}

export async function setThreadEffort(slug, threadKey, effort) {
  setOverride(slug, threadKey, "effort", String(effort || "").trim());
}

// ── Per-thread CLEAN override ("/clean" directive) ────────────────────────────────────────────
// A thread flagged clean runs bare (channel cleanMode semantics, scoped to this thread): empty
// strict MCP config, bare gateway folder, no skills, no provenance/replay. Sticky by design — the
// thread's session was BUILT on the bare context, so resumed turns must stay bare or the resume
// would suddenly inject tool schemas into a conversation that never had them. (Crossing the
// boundary in either direction therefore rotates the thread's session — the Slack layer clears it
// when the flag actually changes value.)

export async function getThreadClean(slug, threadKey) {
  return Boolean(getOverride(slug, threadKey, "clean"));
}

export async function setThreadClean(slug, threadKey, on) {
  setOverride(slug, threadKey, "clean", on ? "1" : "");
}
