// Session-integrity guards for the in-thread session controls.
//
// Three races used to let a thread's session outlive the command that was supposed to end it:
//   * `/clear` dropped the session map + warm pool but left the thread's LIVE run alone — the run
//     could post its answer after the clear, auto-continue a recoverable death, and saveSession its
//     id straight back over the clear.
//   * `/clean` (on/off) flipped a sticky flag without rotating the session, so a thread resumed a
//     conversation built on the other side of the clean boundary (bare vs. fully provisioned).
//   * clearSession was a plain UPDATE, so a thread with no row yet (cleared before the bot's first
//     run) got no tombstone at all — and the next reply replayed the history the user just cleared.
// A fourth guard covers the per-thread overrides (engine/model/effort/clean), which moved off
// read-modify-writeFile JSON maps onto keyed SQLite rows so concurrent writes can't drop each other.
//
// ensureTestEnv() runs before importing src so the lazy DB opens the scratch file, never the real dir.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.SESSION_KEEPALIVE = "0";
// Keep the provisioned channel workspaces inside the scratch dir — these turns go through the real
// ensureRegistered/ensureChannelFolder path and would otherwise write to ~/Slack Agent.
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspaces");

const { setUser, upsertChannelEntry } = await import("../src/config/store.js");
const { migrations } = await import("../src/db/migrations.js");
const { runMigrations } = await import("../src/db/index.js");
const { importThreadOverrides } = await import("../src/db/import-legacy.js");
const {
  clearSession,
  getSession,
  hasThreadSession,
  resetSession,
  saveSession,
  sessionGeneration,
} = await import("../src/gateway/sessions.js");
const {
  getThreadClean,
  getThreadEffort,
  getThreadEngine,
  getThreadModel,
  setThreadClean,
  setThreadEffort,
  setThreadEngine,
  setThreadModel,
} = await import("../src/gateway/thread-engine.js");
const { runMessage } = await import("../src/gateway/run.js");
const {
  fallbackContextFetcher,
  processMessageEvent,
  runDeathRecovery,
  runQueue,
} = await import("../src/slack/message-pipeline.js");

function fakeSlack() {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  return {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `bot.${++seq}` };
      },
      update: ok,
      postEphemeral: async (message) => {
        posted.push(message);
        return { ok: true };
      },
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Integrity User" } }),
      list: async () => ({ members: [{ id: "U_INTEGRITY", real_name: "Integrity User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [], response_metadata: {} }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: ["U_INTEGRITY"], response_metadata: {} }),
    },
    apiCall: ok,
  };
}

const USER = "U_INTEGRITY";
let ts = 5000;
const nextTs = () => `${++ts}.000`;

// ── M6b: clearSession tombstones even a thread that has no row yet ────────────────────────────

test("clearSession tombstones a rowless thread instead of updating nothing", async () => {
  const slug = "integrity-rowless";
  assert.equal(await hasThreadSession(slug, "t-never-ran"), false);

  assert.equal(await clearSession(slug, "t-never-ran"), true, "the upsert must report a change");

  // The row now exists as the "this thread has been used" marker that gates thread-history replay…
  assert.equal(await hasThreadSession(slug, "t-never-ran"), true);
  // …while carrying no resumable id, so the next message still mints a fresh session.
  assert.equal(await getSession(slug, "t-never-ran"), "");
});

test("clearSession still tombstones an existing row and drops the codex-fallback row", async () => {
  const slug = "integrity-existing";
  await saveSession(slug, "t1", "live-session", "claude");
  await saveSession(slug, "t1::codex-fallback", "fallback-session", "codex");

  await clearSession(slug, "t1");

  assert.equal(await getSession(slug, "t1"), "");
  assert.equal(await hasThreadSession(slug, "t1"), true, "the replay marker must survive");
  // The fallback row is not a replay marker — a cleared thread must not resume stale fallback context.
  assert.equal(await hasThreadSession(slug, "t1::codex-fallback"), false);
});

// ── H9: the clear-generation guard ────────────────────────────────────────────────────────────

test("a run that unwinds AFTER a /clear cannot re-save over the tombstone", async () => {
  const slug = "integrity-generation";
  await saveSession(slug, "t1", "session-before-clear", "claude");
  // What runMessage captures at the top of the turn.
  const gen = sessionGeneration(slug, "t1");

  await clearSession(slug, "t1");

  // The late unwind: a subprocess that finished right at the kill saves its id with the stale
  // generation. Dropped.
  await saveSession(slug, "t1", "late-session", "claude", gen);
  assert.equal(await getSession(slug, "t1"), "");

  // Same for a resume-heal re-mint: the caller still gets a usable throwaway id (its run carries on
  // in a session no one will resume) but the tombstone in the table stands.
  const throwaway = await resetSession(slug, "t1", "claude", gen);
  assert.ok(throwaway, "resetSession must still hand back an id");
  assert.equal(await getSession(slug, "t1"), "");

  // And the Codex-fallback row shares the thread's generation, so its late save is dropped too.
  await saveSession(slug, "t1::codex-fallback", "late-fallback", "codex", gen);
  assert.equal(await hasThreadSession(slug, "t1::codex-fallback"), false);

  // A run that STARTED after the clear captures the new generation and writes normally.
  const freshGen = sessionGeneration(slug, "t1");
  assert.notEqual(freshGen, gen);
  await saveSession(slug, "t1", "session-after-clear", "claude", freshGen);
  assert.equal(await getSession(slug, "t1"), "session-after-clear");
});

test("session writes without a generation (non-run callers) are never dropped", async () => {
  const slug = "integrity-nogen";
  await clearSession(slug, "t1");
  await saveSession(slug, "t1", "unguarded", "claude");
  assert.equal(await getSession(slug, "t1"), "unguarded");
});

// ── H9: /clear terminalizes the thread's live run ─────────────────────────────────────────────

test("/clear stops the thread's live run, so its late answer and auto-continue are suppressed", async () => {
  await setUser(USER, { name: "Integrity User", approved: true });
  const entry = await upsertChannelEntry("D_INTEGRITY_CLEAR", { name: "integrity-clear", type: "im", isDM: true });
  const thread = nextTs();
  const runKey = `${entry.slug}::${thread}`;
  await saveSession(entry.slug, thread, "session-being-cleared", "claude");
  // The generation the in-flight run captured when it started.
  const gen = sessionGeneration(entry.slug, thread);

  // A live turn, registered exactly as processMessageEvent registers its own.
  const handle = { aborted: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(runKey, handle);

  const client = fakeSlack();
  await processMessageEvent(
    { type: "message", channel: "D_INTEGRITY_CLEAR", channel_type: "im", user: USER, text: "/clear", thread_ts: thread, ts: nextTs() },
    client,
    { botUserId: "U_BOT", teamId: "T_INTEGRITY" },
  );

  // The run went through the same terminal path as `stop`: the handle is aborted (which is what
  // suppresses the late answer post) and the child process signal is raised.
  assert.equal(handle.aborted, true, "/clear must terminalize the in-flight run");
  assert.equal(handle.controller.signal.aborted, true, "the engine child must be killed");
  // Auto-continue is gated on exactly this flag — a recoverable death now recovers into nothing.
  const recoverableDeath = { message: "Claude session ended", details: { engine: "claude", processEnded: true } };
  assert.equal(runDeathRecovery(recoverableDeath), "continue", "the death is recoverable in principle");
  assert.equal(handle.aborted ? null : runDeathRecovery(recoverableDeath), null, "…but an aborted run must not auto-continue");

  // The session is tombstoned, and the aborted run's late saveSession is refused.
  assert.equal(await getSession(entry.slug, thread), "");
  await saveSession(entry.slug, thread, "late-from-killed-run", "claude", gen);
  assert.equal(await getSession(entry.slug, thread), "");

  const note = client.posted.find((message) => String(message.text || "").includes("Cleared"));
  assert.ok(note, `expected a clear confirmation, got: ${JSON.stringify(client.posted)}`);
  assert.match(note.text, /stopped the in-flight run/, "the reply must own up to killing the run");

  runQueue.release(runKey, handle);
});

test("/clear on an idle thread clears without claiming it stopped anything", async () => {
  await setUser(USER, { name: "Integrity User", approved: true });
  const entry = await upsertChannelEntry("D_INTEGRITY_IDLE", { name: "integrity-idle", type: "im", isDM: true });
  const thread = nextTs();
  await saveSession(entry.slug, thread, "idle-session", "claude");

  const client = fakeSlack();
  await processMessageEvent(
    { type: "message", channel: "D_INTEGRITY_IDLE", channel_type: "im", user: USER, text: "/clear", thread_ts: thread, ts: nextTs() },
    client,
    { botUserId: "U_BOT", teamId: "T_INTEGRITY" },
  );

  assert.equal(await getSession(entry.slug, thread), "");
  const note = client.posted.find((message) => String(message.text || "").includes("Cleared"));
  assert.ok(note);
  assert.doesNotMatch(note.text, /stopped the in-flight run/);
});

test("a turn aborted before it starts never mints a session over the tombstone", async () => {
  await setUser(USER, { name: "Integrity User", approved: true });
  const entry = await upsertChannelEntry("D_INTEGRITY_PRESTART", { name: "integrity-prestart", type: "im", isDM: true });
  const thread = nextTs();
  // The /clear landed while this turn was still provisioning its folder: the thread is tombstoned
  // and the turn's controller is already aborted.
  await clearSession(entry.slug, thread);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runMessage({
      channelId: "D_INTEGRITY_PRESTART",
      authorId: USER,
      text: "this turn is already dead",
      threadKey: thread,
      signal: controller.signal,
      origin: "slack_foreground",
      preferCold: true,
    }),
    (err) => err?.name === "AbortError",
  );
  // resolveSession would otherwise have written a live id here.
  assert.equal(await getSession(entry.slug, thread), "");
});

// ── M6a: the /clean toggle rotates the thread's session ───────────────────────────────────────

test("/clean rotates the thread session on the way in and on the way out, but not on a no-op", async () => {
  await setUser(USER, { name: "Integrity User", approved: true });
  const entry = await upsertChannelEntry("D_INTEGRITY_CLEAN", { name: "integrity-clean", type: "im", isDM: true });
  const thread = nextTs();
  const client = fakeSlack();
  const send = (text) => processMessageEvent(
    { type: "message", channel: "D_INTEGRITY_CLEAN", channel_type: "im", user: USER, text, thread_ts: thread, ts: nextTs() },
    client,
    { botUserId: "U_BOT", teamId: "T_INTEGRITY" },
  );

  await saveSession(entry.slug, thread, "provisioned-session", "claude");
  await send("/clean");
  // Crossing into clean: the session built on the provisioned context must not be resumable.
  assert.equal(await getThreadClean(entry.slug, thread), true);
  assert.equal(await getSession(entry.slug, thread), "");
  assert.equal(await hasThreadSession(entry.slug, thread), true, "the tombstone also suppresses replay");

  // A second /clean crosses no boundary — the bare session the thread just built must survive.
  await saveSession(entry.slug, thread, "bare-session", "claude");
  await send("/clean");
  assert.equal(await getThreadClean(entry.slug, thread), true);
  assert.equal(await getSession(entry.slug, thread), "bare-session", "a no-op toggle must not rotate");

  // Crossing back out: the bare session must not be resumed with tool schemas suddenly attached.
  await send("/clean off");
  assert.equal(await getThreadClean(entry.slug, thread), false);
  assert.equal(await getSession(entry.slug, thread), "");

  // And "/clean off" on an already-normal thread is a no-op too.
  await saveSession(entry.slug, thread, "normal-session", "claude");
  await send("/clean off");
  assert.equal(await getSession(entry.slug, thread), "normal-session");
});

test("a clean thread gets no fallback-context replay", () => {
  const fetcher = () => "transcript";
  // Ordinary turn with nothing prepended: the Codex fallback may read the thread.
  assert.equal(fallbackContextFetcher({ threadContext: "", threadClean: false }, fetcher), fetcher);
  // Already prepended above — a second copy would arrive in the fallback prompt.
  assert.equal(fallbackContextFetcher({ threadContext: "earlier thread", threadClean: false }, fetcher), null);
  // Clean means NO gateway-injected context at all, replay included.
  assert.equal(fallbackContextFetcher({ threadContext: "", threadClean: true }, fetcher), null);
  assert.equal(fallbackContextFetcher({ threadContext: "earlier thread", threadClean: true }, fetcher), null);
  assert.equal(fallbackContextFetcher(undefined, fetcher), fetcher);
});

// ── M5: per-thread overrides on keyed SQLite rows ─────────────────────────────────────────────

test("the per-thread override API round-trips and clears each kind independently", async () => {
  const slug = "integrity-overrides";
  await setThreadEngine(slug, "t1", "codex");
  await setThreadModel(slug, "t1", "gpt-5.6");
  await setThreadEffort(slug, "t1", "high");
  await setThreadClean(slug, "t1", true);

  assert.equal(await getThreadEngine(slug, "t1"), "codex");
  assert.equal(await getThreadModel(slug, "t1"), "gpt-5.6");
  assert.equal(await getThreadEffort(slug, "t1"), "high");
  assert.equal(await getThreadClean(slug, "t1"), true);

  // An empty value clears just that kind (absence of a row = no override).
  await setThreadModel(slug, "t1", "");
  assert.equal(await getThreadModel(slug, "t1"), "");
  assert.equal(await getThreadEffort(slug, "t1"), "high", "clearing one kind must not touch another");

  // An unknown engine is refused the same way the JSON writer refused it.
  await setThreadEngine(slug, "t1", "not-an-engine");
  assert.equal(await getThreadEngine(slug, "t1"), "");

  await setThreadClean(slug, "t1", false);
  assert.equal(await getThreadClean(slug, "t1"), false);

  // A thread that never set anything reads as "no override" for every kind.
  assert.equal(await getThreadEngine(slug, "t-unset"), "");
  assert.equal(await getThreadModel(slug, "t-unset"), "");
  assert.equal(await getThreadEffort(slug, "t-unset"), "");
  assert.equal(await getThreadClean(slug, "t-unset"), false);
});

test("concurrent override writes across threads and kinds lose nothing", async () => {
  // The regression this replaces: four per-channel JSON maps written by read-modify-writeFile.
  // Two messages landing together each read the whole map, then each wrote its own copy back —
  // the later write silently dropped the earlier one's thread. Keyed rows make every write
  // independent, so all of these must survive.
  const slug = "integrity-concurrent";
  const threads = Array.from({ length: 40 }, (_, i) => `t${i}`);

  await Promise.all(threads.flatMap((thread, i) => [
    setThreadEngine(slug, thread, i % 2 ? "codex" : "claude"),
    setThreadModel(slug, thread, `model-${i}`),
    setThreadEffort(slug, thread, i % 3 ? "high" : "low"),
    setThreadClean(slug, thread, i % 4 === 0),
  ]));

  for (const [i, thread] of threads.entries()) {
    assert.equal(await getThreadEngine(slug, thread), i % 2 ? "codex" : "claude", `engine for ${thread}`);
    assert.equal(await getThreadModel(slug, thread), `model-${i}`, `model for ${thread}`);
    assert.equal(await getThreadEffort(slug, thread), i % 3 ? "high" : "low", `effort for ${thread}`);
    assert.equal(await getThreadClean(slug, thread), i % 4 === 0, `clean for ${thread}`);
  }

  // Interleaved writes to the SAME thread but different kinds are independent too.
  const other = "integrity-concurrent-same-thread";
  await Promise.all([
    setThreadEngine(other, "t", "codex"),
    setThreadModel(other, "t", "gpt-5.6"),
    setThreadEffort(other, "t", "high"),
    setThreadClean(other, "t", true),
  ]);
  assert.equal(await getThreadEngine(other, "t"), "codex");
  assert.equal(await getThreadModel(other, "t"), "gpt-5.6");
  assert.equal(await getThreadEffort(other, "t"), "high");
  assert.equal(await getThreadClean(other, "t"), true);
});

// ── M5: the migration + the one-time import of the legacy JSON ────────────────────────────────

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  runMigrations(db);
  return db;
}

test("the thread_overrides migration is appended and keyed by (slug, thread_key, kind)", () => {
  const latest = Math.max(...migrations.map((migration) => migration.version));
  const added = migrations.find((migration) => migration.version === latest);
  assert.ok(added, "the new migration must be the appended, highest-numbered one");

  const db = memoryDb();
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_overrides'").get()?.sql || "";
    assert.match(sql, /PRIMARY KEY \(slug, thread_key, kind\)/);
    // One row per (thread, kind): a second write of the same kind must replace, not duplicate.
    db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES('s', 't', 'model', 'a')").run();
    assert.throws(
      () => db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES('s', 't', 'model', 'b')").run(),
      /UNIQUE|constraint/i,
    );
    // …while a different kind on the same thread is a separate row.
    db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES('s', 't', 'effort', 'high')").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM thread_overrides").get().n, 2);
  } finally {
    db.close();
  }
});

test("the legacy per-thread JSON files are imported once and left on disk as backups", () => {
  const slug = "legacy-import-fixture";
  const dir = path.join(scratch, "channels", slug);
  mkdirSync(dir, { recursive: true });
  const files = {
    "thread-engines.json": { "100.1": "codex", "100.2": "" },
    "thread-models.json": { "100.1": "gpt-5.6" },
    "thread-efforts.json": { "100.1": "high" },
    "thread-clean.json": { "100.1": true, "100.3": false },
  };
  for (const [name, map] of Object.entries(files)) writeFileSync(path.join(dir, name), `${JSON.stringify(map, null, 2)}\n`);
  // A channel dir with none of the files at all must not break the sweep.
  mkdirSync(path.join(scratch, "channels", "legacy-import-empty"), { recursive: true });

  const db = memoryDb();
  try {
    importThreadOverrides(db);

    const rows = db.prepare("SELECT kind, value FROM thread_overrides WHERE slug = ? AND thread_key = '100.1' ORDER BY kind")
      .all(slug)
      .map((row) => ({ kind: row.kind, value: row.value }));
    assert.deepEqual(rows, [
      { kind: "clean", value: "1" },
      { kind: "effort", value: "high" },
      { kind: "engine", value: "codex" },
      { kind: "model", value: "gpt-5.6" },
    ]);
    // Falsy legacy values meant "no override" (the old writers deleted the key) — no row for them.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM thread_overrides WHERE thread_key IN ('100.2', '100.3')").get().n, 0);

    // The old files are inert backups: read, never deleted or rewritten.
    for (const [name, map] of Object.entries(files)) {
      const file = path.join(dir, name);
      assert.equal(existsSync(file), true, `${name} must stay on disk`);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), map, `${name} must be untouched`);
    }

    // One-time: a later edit made in the DB is not clobbered by a second open.
    db.prepare("UPDATE thread_overrides SET value = 'claude' WHERE slug = ? AND kind = 'engine'").run(slug);
    importThreadOverrides(db);
    assert.equal(db.prepare("SELECT value FROM thread_overrides WHERE slug = ? AND kind = 'engine'").get(slug).value, "claude");
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'thread_overrides_imported'").get().value, "1");
  } finally {
    db.close();
  }
});

test("the thread-override import has its own flag, so an already-migrated install still gets it", () => {
  // Existing installs already carry legacy_imported=1 from the JSON→SQLite move; reusing that flag
  // would have skipped the thread overrides entirely and silently reset every pinned thread.
  const db = memoryDb();
  try {
    db.prepare("INSERT INTO _meta(key, value) VALUES('legacy_imported', '1')").run();
    importThreadOverrides(db);
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'thread_overrides_imported'").get()?.value, "1");
  } finally {
    db.close();
  }
});

// ── Fallback session keys belong to their thread, for EVERY engine ─────────────────────────────
// run.js keys a fallback turn `${threadKey}::${engine}-fallback`, and failover is bidirectional
// (Claude→Codex and Codex→Claude), so both "codex-fallback" and "claude-fallback" rows exist. The
// generation key used to strip only the literal "::codex-fallback": after a /clear, a
// claude-fallback save looked up a DIFFERENT generation than the clear had bumped, so the write
// was judged stale and silently dropped forever. /clear deleted only the codex row for the same
// reason, leaving stale claude-fallback context to be resumed in a supposedly cleared thread.

test("every engine's fallback row shares its thread's clear generation", async () => {
  const slug = "fallback-keys";
  const thread = "1700000900.000100";
  for (const engine of ["codex", "claude"]) {
    const key = `${thread}::${engine}-fallback`;
    assert.equal(
      sessionGeneration(slug, key),
      sessionGeneration(slug, thread),
      `${engine}-fallback must resolve to the thread's generation`,
    );
  }
  const before = sessionGeneration(slug, thread);
  await clearSession(slug, thread);
  assert.equal(sessionGeneration(slug, `${thread}::claude-fallback`), before + 1, "the clear bumps it for the fallback key too");

  // …so a fallback save arriving with the PRE-clear generation is dropped, and one captured after
  // the clear still lands.
  await saveSession(slug, `${thread}::claude-fallback`, "stale-id", "claude", before);
  assert.equal(await getSession(slug, `${thread}::claude-fallback`), null);
  await saveSession(slug, `${thread}::claude-fallback`, "fresh-id", "claude", before + 1);
  assert.equal(await getSession(slug, `${thread}::claude-fallback`), "fresh-id");
});

test("/clear deletes the thread's fallback row whichever engine minted it", async () => {
  const slug = "fallback-clear";
  const thread = "1700000901.000100";
  const other = "1700000902.000100";
  await saveSession(slug, `${thread}::codex-fallback`, "codex-thread-id", "codex");
  await saveSession(slug, `${thread}::claude-fallback`, "claude-uuid", "claude");
  await saveSession(slug, `${other}::claude-fallback`, "another-thread", "claude");

  await clearSession(slug, thread);

  assert.equal(await getSession(slug, `${thread}::codex-fallback`), null);
  assert.equal(await getSession(slug, `${thread}::claude-fallback`), null, "the claude row goes too");
  assert.equal(await getSession(slug, `${other}::claude-fallback`), "another-thread", "a sibling thread is untouched");
});

test("a LIKE metacharacter in a thread key cannot widen the fallback delete", async () => {
  const slug = "fallback-escape";
  // "%" would match anything if the pattern weren't escaped.
  await saveSession(slug, "%::claude-fallback", "wildcard-victim", "claude");
  await saveSession(slug, "1700000903.000100::claude-fallback", "real-row", "claude");

  await clearSession(slug, "1700000903.000100");

  assert.equal(await getSession(slug, "1700000903.000100::claude-fallback"), null);
  assert.equal(await getSession(slug, "%::claude-fallback"), "wildcard-victim", "the literal-% row survives");
});
