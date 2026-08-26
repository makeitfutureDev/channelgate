import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/db/migrations.js";
import { runMigrations } from "../src/db/index.js";

const latest = Math.max(...migrations.map((migration) => migration.version));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  return db;
}

function version(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

test("migration versions are append-only, contiguous, and a fresh DB reaches latest", () => {
  assert.deepEqual(migrations.map((migration) => migration.version), Array.from({ length: latest }, (_, i) => i + 1));
  const db = memoryDb();
  try {
    runMigrations(db);
    assert.equal(version(db), latest);
    for (const table of ["users", "active_runs", "api_jobs", "stopped_turns", "composio_sessions", "followup_digest_messages", "approval_requests", "usage_components", "usage_requests", "usage_repair_batches"]) {
      assert.equal(tableExists(db, table), true, `${table} should exist at schema v${latest}`);
    }
  } finally {
    db.close();
  }
});

test("running migrations twice is a no-op that preserves existing data", () => {
  const db = memoryDb();
  try {
    runMigrations(db);
    db.prepare("INSERT INTO users(user_id, data) VALUES(?, ?)").run("U_SENTINEL", '{"name":"kept"}');
    const schemaBefore = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();

    runMigrations(db);

    assert.equal(version(db), latest);
    assert.equal(db.prepare("SELECT data FROM users WHERE user_id = ?").get("U_SENTINEL").data, '{"name":"kept"}');
    assert.deepEqual(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(), schemaBefore);
  } finally {
    db.close();
  }
});

test("an old v3 database upgrades through every later migration without losing rows", () => {
  const db = memoryDb();
  try {
    for (const migration of migrations.filter((item) => item.version <= 3)) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.prepare("INSERT INTO sessions(slug, thread_key, session_id) VALUES(?, ?, ?)").run("legacy", "1.0", "session-old");
    assert.equal(version(db), 3);

    runMigrations(db);

    assert.equal(version(db), latest);
    const legacy = db.prepare("SELECT session_id, engine FROM sessions WHERE slug = 'legacy'").get();
    assert.equal(legacy.session_id, "session-old");
    assert.equal(legacy.engine, "");
    assert.equal(tableExists(db, "stopped_turns"), true, "v5 applied");
    assert.equal(tableExists(db, "composio_sessions"), true, "v6 applied");
    assert.equal(tableExists(db, "followup_digest_messages"), true, "v7 applied");
    assert.equal(tableExists(db, "approval_requests"), true, "v9 applied");
    assert.equal(tableExists(db, "usage_components"), true, "v10 applied");
    const usageColumns = db.prepare("PRAGMA table_info(usage)").all().map((row) => row.name);
    assert.ok(usageColumns.includes("runtime_model"));
    assert.ok(usageColumns.includes("accounting_status"));
  } finally {
    db.close();
  }
});

test("v8 repairs duplicate channel slugs and enforces uniqueness", () => {
  const db = memoryDb();
  try {
    for (const migration of migrations.filter((item) => item.version <= 7)) migration.up(db);
    db.prepare("INSERT INTO channels(channel_id, slug, data) VALUES(?, ?, ?)").run("C1", "sales", '{"slug":"sales","name":"Sales"}');
    db.prepare("INSERT INTO channels(channel_id, slug, data) VALUES(?, ?, ?)").run("C2", "sales", '{"slug":"sales","name":"Sales"}');
    db.prepare("INSERT INTO channels(channel_id, slug, data) VALUES(?, ?, ?)").run("C3", "sales-c2", '{"slug":"sales-c2","name":"Existing suffix"}');
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("sales", '{"profile":"read"}');

    migrations.find((item) => item.version === 8).up(db);

    const rows = db.prepare("SELECT channel_id, slug, data FROM channels ORDER BY channel_id").all();
    assert.deepEqual(rows.map((row) => row.slug), ["sales", "sales-c2-2", "sales-c2"]);
    assert.equal(JSON.parse(rows[1].data).slug, "sales-c2-2");
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get("sales-c2-2").data), {
      profile: "read",
      channelId: "C2",
      name: "Sales",
    });
    assert.throws(
      () => db.prepare("INSERT INTO channels(channel_id, slug, data) VALUES('C4', 'sales', '{}')").run(),
      /UNIQUE/
    );
  } finally {
    db.close();
  }
});
