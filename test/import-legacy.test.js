// The one-time JSON→SQLite import (src/db/import-legacy.js), driven against an authentic legacy
// tree.
//
// It reads a layout that no longer exists on any current install, which is exactly what made the
// defect invisible: the per-channel files were resolved through channelMetaFile() /
// channelSessionsFile(), and those helpers MOVED with the platform-folder rename — they now point
// at channels/<platform>/<slug>/, while a genuine pre-SQLite tree has channels/<slug>/ and no
// platform level at all. The import therefore found nothing, reported `meta=0 sessions=0`, and a
// pre-SQLite upgrade silently lost every channel's lockdown record and every thread→session
// mapping. Nothing failed; the data was simply not there afterwards.
//
// So the fixture below is the OLD tree, spelled out, and the assertions are on the rows that come
// out of it. The chronology matters and is why this cannot be caught by a test that builds the
// current layout: scripts/migrate-channelgate.mjs reads its channel records from the store, which
// opens the database — running this import — BEFORE it moves a single folder.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();

const { runMigrations } = await import("../src/db/index.js");
const { importLegacy } = await import("../src/db/import-legacy.js");
const { channelMetaFile, channelSessionsFile } = await import("../src/config/paths.js");

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  runMigrations(db);
  return db;
}

const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// The pre-SQLite tree: config/*.json plus channels/<slug>/{meta,sessions}.json — no platform level.
const OPS_META = {
  channelId: "C_OPS",
  name: "ops",
  allowedUsers: ["U_ANN"],
  allowedMcps: ["gateway"],
  adminMode: false,
  allowBash: true,
  allowNetwork: false,
  model: "sonnet",
};
const BILLING_META = { channelId: "C_BILLING", name: "billing", allowedUsers: [], adminMode: true, allowBash: false };
const OPS_SESSIONS = {
  "1700000000.000100": "11111111-1111-4111-8111-111111111111",
  "1700000000.000200": "22222222-2222-4222-8222-222222222222",
  "1700000000.000300": "", // an empty id meant "no session" — it must not become a row
};
const BILLING_SESSIONS = { "1700000900.000100": "33333333-3333-4333-8333-333333333333" };

function buildLegacyTree() {
  writeJson(path.join(scratch, "config", "users.json"), {
    U_ANN: { name: "Ann", approved: true, isAdmin: true, composioToken: "ct_ann" },
  });
  writeJson(path.join(scratch, "config", "channels.json"), {
    C_OPS: { slug: "ops", name: "ops", type: "channel", isDM: false },
    C_BILLING: { slug: "billing", name: "billing", type: "channel", isDM: false },
  });
  writeJson(path.join(scratch, "channels", "ops", "meta.json"), OPS_META);
  writeJson(path.join(scratch, "channels", "ops", "sessions.json"), OPS_SESSIONS);
  writeJson(path.join(scratch, "channels", "billing", "meta.json"), BILLING_META);
  writeJson(path.join(scratch, "channels", "billing", "sessions.json"), BILLING_SESSIONS);
  // A channel folder with neither file must not break the sweep.
  mkdirSync(path.join(scratch, "channels", "empty-channel"), { recursive: true });
}

buildLegacyTree();

test("the legacy tree's channel meta and sessions actually reach the database", () => {
  const db = memoryDb();
  try {
    importLegacy(db);

    const metaCount = db.prepare("SELECT COUNT(*) AS n FROM channel_meta").get().n;
    const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
    assert.ok(metaCount > 0, "counts.meta was 0 on every authentic legacy tree — that is the defect");
    assert.ok(sessionCount > 0, "counts.sessions was 0 for the same reason");
    assert.equal(metaCount, 2);
    assert.equal(sessionCount, 3, "the empty session id contributes nothing");

    // The rows are the files, verbatim — a lockdown record that arrives altered is no better than
    // one that never arrives.
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'ops'").get().data), OPS_META);
    assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'billing'").get().data), BILLING_META);

    const sessions = Object.fromEntries(
      db.prepare("SELECT thread_key, session_id FROM sessions WHERE slug = 'ops' ORDER BY thread_key").all().map((r) => [r.thread_key, r.session_id]),
    );
    assert.deepEqual(sessions, {
      "1700000000.000100": OPS_SESSIONS["1700000000.000100"],
      "1700000000.000200": OPS_SESSIONS["1700000000.000200"],
    });
    assert.equal(db.prepare("SELECT session_id FROM sessions WHERE slug = 'billing'").get().session_id, BILLING_SESSIONS["1700000900.000100"]);

    // The rest of the import is unchanged and still lands.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
    assert.equal(db.prepare("SELECT slug FROM channels WHERE channel_id = 'C_OPS'").get().slug, "ops");
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'legacy_imported'").get().value, "1");
  } finally {
    db.close();
  }
});

test("the legacy files are inert backups — read, never written", () => {
  // The import's whole safety story is that it is reversible until the operator deletes the files
  // by hand, so every source file must still be byte-identical afterwards.
  const files = [
    [path.join(scratch, "config", "users.json"), { U_ANN: { name: "Ann", approved: true, isAdmin: true, composioToken: "ct_ann" } }],
    [path.join(scratch, "channels", "ops", "meta.json"), OPS_META],
    [path.join(scratch, "channels", "ops", "sessions.json"), OPS_SESSIONS],
    [path.join(scratch, "channels", "billing", "meta.json"), BILLING_META],
    [path.join(scratch, "channels", "billing", "sessions.json"), BILLING_SESSIONS],
  ];
  const before = files.map(([file]) => readFileSync(file, "utf8"));

  const db = memoryDb();
  try {
    importLegacy(db);
  } finally {
    db.close();
  }

  files.forEach(([file, expected], i) => {
    assert.equal(readFileSync(file, "utf8"), before[i], `${path.basename(file)} must be untouched`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), expected);
  });
});

test("the import stays one-time: a later edit is not clobbered by a second open", () => {
  const db = memoryDb();
  try {
    importLegacy(db);
    db.prepare("UPDATE channel_meta SET data = ? WHERE slug = 'ops'").run(JSON.stringify({ ...OPS_META, allowBash: false }));
    db.prepare("DELETE FROM sessions WHERE slug = 'ops'").run();

    importLegacy(db); // second open, same database

    assert.equal(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'ops'").get().data).allowBash, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE slug = 'ops'").get().n, 0, "a cleared thread map is not resurrected");
  } finally {
    db.close();
  }
});

test("a tree whose folders already moved is imported too", () => {
  // Half-migrated: the folders were moved to channels/<platform>/<slug>/ but the database is still
  // fresh (a restored backup, an interrupted upgrade). The current-layout path is accepted as a
  // fallback, so those channels are not lost either.
  const movedScratch = path.join(scratch, "moved-root");
  const previousRoot = process.env.CHANNELGATE_DIR;
  process.env.CHANNELGATE_DIR = movedScratch;
  try {
    writeJson(path.join(movedScratch, "config", "channels.json"), {
      C_MOVED: { slug: "moved", name: "moved", type: "channel", isDM: false },
    });
    // The slug directory at the legacy level is what the enumeration walks; the FILES live at the
    // platform path (this is what channelMetaFile resolves to under the moved root).
    mkdirSync(path.join(movedScratch, "channels", "moved"), { recursive: true });
    writeJson(channelMetaFile("moved"), { channelId: "C_MOVED", name: "moved", allowBash: true });
    writeJson(channelSessionsFile("moved"), { "1700001000.000100": "44444444-4444-4444-8444-444444444444" });

    const db = memoryDb();
    try {
      importLegacy(db);
      assert.equal(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'moved'").get().data).allowBash, true);
      assert.equal(db.prepare("SELECT session_id FROM sessions WHERE slug = 'moved'").get().session_id, "44444444-4444-4444-8444-444444444444");
    } finally {
      db.close();
    }
  } finally {
    process.env.CHANNELGATE_DIR = previousRoot;
  }
});

test("a platform folder is never imported as a channel", () => {
  // channels/slack/ is a directory name, not a slug: importing it would mint a phantom channel.
  const mixedScratch = path.join(scratch, "mixed-root");
  const previousRoot = process.env.CHANNELGATE_DIR;
  process.env.CHANNELGATE_DIR = mixedScratch;
  try {
    writeJson(path.join(mixedScratch, "channels", "slack", "meta.json"), { channelId: "C_PHANTOM", name: "slack" });
    writeJson(path.join(mixedScratch, "channels", "real", "meta.json"), { channelId: "C_REAL", name: "real" });

    const db = memoryDb();
    try {
      importLegacy(db);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_meta WHERE slug = 'slack'").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_meta WHERE slug = 'real'").get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    process.env.CHANNELGATE_DIR = previousRoot;
  }
});
