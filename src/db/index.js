// The one SQLite handle for the whole daemon (and for the separate MCP server process, which
// imports the same stores). Uses the built-in `node:sqlite` — no native build, so any machine
// with a modern Node just works after `git pull` (that's the portability requirement). Opening is
// lazy and idempotent: the first getDb() in a process creates the file, sets pragmas, runs any
// pending schema migrations, and performs the one-time import of legacy JSON — all guarded so it's
// safe when the daemon and the MCP server open the same file concurrently (WAL + busy_timeout,
// migrations inside an IMMEDIATE transaction).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dbFile } from "../config/paths.js";
import { migrations } from "./migrations.js";
import { importLegacy, importThreadOverrides } from "./import-legacy.js";

// node:sqlite emits an ExperimentalWarning at import time; silence just that one line (the API
// surface we use — exec/prepare/run/get/all/user_version — is small and stable).
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === "string" ? warning : warning?.message || "";
  const type = rest[0] && typeof rest[0] === "object" ? rest[0].type : rest[0];
  if ((type === "ExperimentalWarning" || /ExperimentalWarning/.test(String(type))) && /SQLite/i.test(msg)) return;
  return originalEmitWarning(warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");

let db = null;

// Block the current thread for `ms` (used only for the rare WAL-conversion retry at cold start).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function open() {
  const file = dbFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec("PRAGMA busy_timeout = 5000");
  // WAL = concurrent readers alongside a writer (daemon + MCP process). The one-time conversion of
  // a fresh DB to WAL needs an exclusive lock, and SQLite does NOT honor busy_timeout for a
  // journal_mode change — it returns BUSY immediately. That can only collide if two processes
  // cold-start on a brand-new file at the same instant (in normal operation the daemon boots first
  // and later-spawned MCP processes just see WAL already set), so retry with a short sync backoff.
  for (let attempt = 0; ; attempt++) {
    try {
      handle.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (err) {
      if (attempt >= 50 || !/lock|busy/i.test(String(err?.message))) throw err;
      sleepSync(20);
    }
  }
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  return handle;
}

function currentVersion(handle) {
  return handle.prepare("PRAGMA user_version").get().user_version ?? 0;
}

// Apply every migration newer than the DB's user_version, in one transaction so a crash mid-way
// leaves the DB at a clean prior version. BEGIN IMMEDIATE takes the write lock up front so two
// processes can't both migrate — the loser waits, then sees the version already advanced.
export function runMigrations(handle) {
  const target = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  if (currentVersion(handle) >= target) return;
  handle.exec("BEGIN IMMEDIATE");
  try {
    const from = currentVersion(handle); // re-read under the lock
    for (const m of migrations) {
      if (m.version <= from) continue;
      m.up(handle);
      handle.exec(`PRAGMA user_version = ${Number(m.version)}`);
    }
    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }
}

export function metaGet(key) {
  const row = getDb().prepare("SELECT value FROM _meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function metaSet(key, value) {
  getDb()
    .prepare("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

export function getDb() {
  if (db) return db;
  db = open();
  runMigrations(db);
  // One-time pull of any pre-existing JSON data into the fresh tables (no-op after the first run).
  try {
    importLegacy(db);
  } catch (err) {
    console.error("[db] legacy import failed (continuing):", err?.message || err);
  }
  // Same one-time pull for the per-thread override files (own flag — see import-legacy.js).
  try {
    importThreadOverrides(db);
  } catch (err) {
    console.error("[db] thread-override import failed (continuing):", err?.message || err);
  }
  return db;
}

// JSON blob helpers used by the config-shaped stores.
export const toJson = (v) => JSON.stringify(v ?? null);
export const fromJson = (s, fallback = null) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
