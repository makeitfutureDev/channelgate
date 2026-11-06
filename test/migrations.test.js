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
    for (const table of ["users", "active_runs", "api_jobs", "stopped_turns", "composio_sessions", "followup_digest_messages", "approval_requests", "usage_components", "usage_requests", "usage_repair_batches", "teams_file_launchers"]) {
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

test("v35 preserves pending foreground forms and scopes scheduled uniqueness to the source fire", () => {
  const db = memoryDb();
  try {
    for (const migration of migrations.filter((item) => item.version <= 34)) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const insert = (id, threadKey, data = {}) => db.prepare(
      "INSERT INTO question_requests(id,channel_id,thread_key,author_id,status,revision,updated_ms,data) VALUES(?,?,?,?,?,?,?,?)",
    ).run(id, "C_FORMS", threadKey, "U_CREATOR", "pending", 0, 0, JSON.stringify(data));
    insert("legacy-card", "100.001", { title: "Saved draft", answers: { access: { values: ["team"] } } });
    const before = db.prepare("SELECT data FROM question_requests WHERE id='legacy-card'").get().data;
    assert.throws(() => insert("fire-old-index", "100.001", { sessionThreadKey: "sched-first" }), /UNIQUE/);
    runMigrations(db);
    assert.equal(db.prepare("SELECT data FROM question_requests WHERE id='legacy-card'").get().data, before);
    insert("fire-first", "100.001", { sessionThreadKey: "sched-first" });
    insert("fire-second", "100.001", { sessionThreadKey: "sched-second" });
    assert.throws(() => insert("same-fire-different-display", "200.001", { sessionThreadKey: "sched-first" }), /UNIQUE/);
    assert.throws(() => insert("duplicate-foreground", "100.001"), /UNIQUE/);
  } finally { db.close(); }
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

test("v37 preserves existing credential bytes and handles without guessing owner identity", () => {
  const db = memoryDb();
  try {
    for (const migration of migrations.filter(item => item.version <= 36)) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.prepare("INSERT INTO users(user_id,data) VALUES(?,?)").run("U_EXISTING", JSON.stringify({ name: "Same label", isAdmin: true }));
    db.prepare("INSERT INTO admin_accounts(id,username,display_name,user_handle,auth_version,created_ms) VALUES(?,?,?,?,?,?)")
      .run("legacy", "same-label", "Same label", "opaque-existing-handle", 9, 1);
    db.prepare("INSERT INTO admin_passkeys(id,account_id,public_key,counter,transports,device_type,backed_up,name,created_ms) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("credential-kept", "legacy", Buffer.from([1, 7, 9]), 12, '["internal"]', "multiDevice", 1, "Physical key", 2);
    db.prepare("INSERT INTO admin_enrollment_tokens(digest,account_id,auth_version,expires_ms) VALUES(?,?,?,?)")
      .run("old-invite-digest", "legacy", 9, Date.now() + 60_000);
    const credential = db.prepare("SELECT * FROM admin_passkeys").get();
    runMigrations(db);
    const account = db.prepare("SELECT * FROM admin_accounts").get();
    assert.equal(account.user_id, null, "matching names cannot establish ownership");
    assert.equal(account.user_handle, "opaque-existing-handle");
    assert.equal(account.auth_version, 10);
    assert.deepEqual(db.prepare("SELECT * FROM admin_passkeys").get(), credential);
    assert.equal(db.prepare("SELECT count(*) AS n FROM admin_enrollment_tokens").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM admin_identity_links").get().n, 0);
  } finally { db.close(); }
});
