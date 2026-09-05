// SQLite FTS5 is compiled into Node's bundled SQLite only from some 22.x/23.x builds onward
// (Node 22.13, the documented floor, lacks it; 22.22 and 24 have it). The channel-memory search
// index is a DERIVED cache, so its absence must never stop the database from opening — the daemon
// probes once per handle and every consumer asks here instead of assuming.
const probed = new WeakMap();

export function fts5Available(handle) {
  if (probed.has(handle)) return probed.get(handle);
  let ok = false;
  try {
    handle.exec("CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)");
    handle.exec("DROP TABLE temp.__fts5_probe");
    ok = true;
  } catch {
    ok = false;
  }
  probed.set(handle, ok);
  return ok;
}

export const MEMORY_FTS_TABLE = "channel_memory_fts";

// Create the memory search index when the engine can. Idempotent: called from the migration that
// introduced it AND after every open, so an install that upgrades Node later gains the index on
// its next boot without a new migration.
export function ensureMemoryFtsTable(handle) {
  if (!fts5Available(handle)) return false;
  handle.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_FTS_TABLE} USING fts5(
      channel_slug UNINDEXED,
      source UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return true;
}

export function memoryFtsPresent(handle) {
  const row = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(MEMORY_FTS_TABLE);
  return Boolean(row);
}
