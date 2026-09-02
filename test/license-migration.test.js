// Migration 12 (license_usage). Two paths matter: a brand-new install, and a machine that pulls
// this code with a database already at the previous version — that second one is the whole reason
// migrations are append-only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/db/migrations.js";
import { runMigrations } from "../src/db/index.js";

const LICENSE_MIGRATION = 12;
const latest = Math.max(...migrations.map((m) => m.version));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  return db;
}
const version = (db) => db.prepare("PRAGMA user_version").get().user_version;
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();

test("license_usage is added by migration 12 and nothing earlier", () => {
  const db = memoryDb();
  try {
    for (const m of migrations.filter((m) => m.version < LICENSE_MIGRATION)) {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='license_usage'").get(), undefined);
    runMigrations(db);
    assert.equal(version(db), latest);
    assert.deepEqual(columns(db, "license_usage"), ["admitted", "admitted_seq", "conversation_id", "first_ts", "last_ts", "month", "runs", "warned"]);
  } finally {
    db.close();
  }
});

test("a fresh database reaches the license schema in one pass", () => {
  const db = memoryDb();
  try {
    runMigrations(db);
    assert.equal(version(db), latest);
    db.prepare("INSERT INTO license_usage(month, conversation_id, runs) VALUES(?, ?, ?)").run("2026-08", "C1", 3);
    // (month, conversation_id) is the primary key — one allowance row per conversation per month.
    assert.throws(
      () => db.prepare("INSERT INTO license_usage(month, conversation_id, runs) VALUES(?, ?, ?)").run("2026-08", "C1", 9),
      /UNIQUE|constraint/i,
    );
    // The same conversation in a different month is a different row, which is what makes the
    // monthly reset a reset rather than a counter rewind.
    db.prepare("INSERT INTO license_usage(month, conversation_id, runs) VALUES(?, ?, ?)").run("2026-09", "C1", 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM license_usage").get().n, 2);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_license_usage_month'").get());
  } finally {
    db.close();
  }
});

test("upgrading a populated v11 database preserves its rows", () => {
  const db = memoryDb();
  try {
    for (const m of migrations.filter((m) => m.version <= 11)) {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO users(user_id, data) VALUES(?, ?)").run("U_KEEP", '{"name":"kept"}');
    db.prepare("INSERT INTO usage(ts, channel_id, slug) VALUES(?, ?, ?)").run("2026-08-01T00:00:00Z", "C_KEEP", "keep");

    runMigrations(db);

    assert.equal(version(db), latest);
    assert.equal(db.prepare("SELECT data FROM users WHERE user_id = ?").get("U_KEEP").data, '{"name":"kept"}');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM license_usage").get().n, 0, "a new install-month starts empty");
  } finally {
    db.close();
  }
});

test("re-running migrations on an already-migrated database is a no-op", () => {
  const db = memoryDb();
  try {
    runMigrations(db);
    db.prepare("INSERT INTO license_usage(month, conversation_id, runs, admitted) VALUES(?, ?, ?, 1)").run("2026-08", "C_STICKY", 42);
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    runMigrations(db);
    assert.deepEqual(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), schema);
    assert.equal(db.prepare("SELECT runs FROM license_usage WHERE conversation_id = ?").get("C_STICKY").runs, 42);
  } finally {
    db.close();
  }
});
