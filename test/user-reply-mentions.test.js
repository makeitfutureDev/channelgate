import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { getUser, setUser } = await import("../src/config/store.js");
const { userReplyMentionsEnabled } = await import("../src/config/user-preferences.js");
const { migrations } = await import("../src/db/migrations.js");
const { runMigrations } = await import("../src/db/index.js");
const { importLegacy } = await import("../src/db/import-legacy.js");
const { usersFile } = await import("../src/config/paths.js");

function oldDatabase(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  for (const migration of migrations.filter((item) => item.version <= 51)) {
    migration.up(db);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
  return db;
}

const insertUser = (db, id, user) => db.prepare("INSERT INTO users(user_id, data) VALUES(?, ?)").run(id, JSON.stringify(user));
const readUser = (db, id) => JSON.parse(db.prepare("SELECT data FROM users WHERE user_id = ?").get(id).data);

test("reply mention preference requires an explicit boolean opt-in", () => {
  for (const user of [null, undefined, {}, { replyMentions: false }, { replyMentions: "true" }, { replyMentions: 1 }]) {
    assert.equal(userReplyMentionsEnabled(user), false);
  }
  assert.equal(userReplyMentionsEnabled({ replyMentions: true }), true);
});

test("new users default off and field-scoped patches preserve each person's choice", async () => {
  assert.equal((await setUser("U_MENTION_NEW", { name: "New user" })).replyMentions, false);
  await setUser("U_MENTION_NEW", { replyMentions: true });
  await setUser("U_MENTION_NEW", { approved: true, replyMentions: undefined });
  assert.equal((await getUser("U_MENTION_NEW")).replyMentions, true);
  await setUser("U_MENTION_NEW", () => ({ replyMentions: false }));
  await setUser("U_MENTION_NEW", { name: "Renamed" });
  assert.equal((await getUser("U_MENTION_NEW")).replyMentions, false);
  assert.equal((await setUser("U_MENTION_OPT_IN", { replyMentions: true })).replyMentions, true);
  assert.equal((await setUser("U_MENTION_FUNCTION", () => ({ name: "Function-created user" }))).replyMentions, false);
  assert.equal(await setUser("U_MENTION_SKIP", () => null), null);
  assert.equal(await getUser("U_MENTION_SKIP"), null);
});

test("v52 backfills existing users once and reopening preserves a later opt-out", () => {
  const file = path.join(tempDir("cg-reply-mentions-"), "gateway.db");
  let db = oldDatabase(file);
  try {
    insertUser(db, "U_EXISTING", { name: "Existing", approved: true, skills: ["kept"] });
    insertUser(db, "U_ON", { replyMentions: true });
    insertUser(db, "U_OFF", { replyMentions: false });
    for (const [id, value] of [["U_NULL", null], ["U_STRING", "false"], ["U_NUMBER", 0]]) {
      insertUser(db, id, { replyMentions: value });
    }
    runMigrations(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 52);
    assert.deepEqual(readUser(db, "U_EXISTING"), { name: "Existing", approved: true, skills: ["kept"], replyMentions: true });
    assert.equal(readUser(db, "U_OFF").replyMentions, false);
    for (const id of ["U_ON", "U_NULL", "U_STRING", "U_NUMBER"]) assert.equal(readUser(db, id).replyMentions, true);

    db.prepare("UPDATE users SET data = ? WHERE user_id = ?").run(JSON.stringify({ replyMentions: false }), "U_EXISTING");
    insertUser(db, "U_NEW", { replyMentions: false });
    db.close();
    db = new DatabaseSync(file);
    runMigrations(db);
    assert.equal(readUser(db, "U_EXISTING").replyMentions, false);
    assert.equal(readUser(db, "U_NEW").replyMentions, false);
    assert.equal(readUser(db, "U_OFF").replyMentions, false);
  } finally { db.close(); }
});

test("a failed preference backfill rolls back all user edits and the schema version", () => {
  const db = oldDatabase();
  try {
    insertUser(db, "U_FIRST", { name: "First" });
    insertUser(db, "U_FAIL", { name: "Fail" });
    db.exec(`CREATE TRIGGER fail_reply_backfill BEFORE UPDATE ON users
      WHEN OLD.user_id = 'U_FAIL' BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END`);
    assert.throws(() => runMigrations(db), /fixture migration failure/);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 51);
    assert.deepEqual(readUser(db, "U_FIRST"), { name: "First" });
    db.exec("DROP TRIGGER fail_reply_backfill");
    runMigrations(db);
    assert.equal(readUser(db, "U_FIRST").replyMentions, true);
    assert.equal(readUser(db, "U_FAIL").replyMentions, true);
  } finally { db.close(); }
});

test("legacy JSON users retain mentions and explicit choices without altering their backup", () => {
  const legacy = {
    U_LEGACY: { name: "Legacy", approved: true },
    U_LEGACY_ON: { replyMentions: true },
    U_LEGACY_OFF: { replyMentions: false },
  };
  const file = usersFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(legacy));
  const before = readFileSync(file, "utf8");
  const db = oldDatabase();
  try {
    runMigrations(db);
    importLegacy(db);
    assert.deepEqual(readUser(db, "U_LEGACY"), { name: "Legacy", approved: true, replyMentions: true });
    assert.equal(readUser(db, "U_LEGACY_ON").replyMentions, true);
    assert.equal(readUser(db, "U_LEGACY_OFF").replyMentions, false);
    db.prepare("UPDATE users SET data = ? WHERE user_id = ?").run(JSON.stringify({ replyMentions: false }), "U_LEGACY");
    importLegacy(db);
    assert.equal(readUser(db, "U_LEGACY").replyMentions, false);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { db.close(); }
});
