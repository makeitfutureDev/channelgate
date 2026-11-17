import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { migrations } = await import("../src/db/migrations.js");
const { indexSlackVoiceThread, indexSlackFork, indexSlackThread, getSlackThread,
  getSlackThreadParticipant, slackThreadRootOwner, skipSlackThreadCandidate,
  setSlackThreadDone, slackThreadIsDone, renameSlackThread } = await import("../src/gateway/slack-threads.js");

const channelId = "C_VOICE_OWNER", slug = "voice-owner", threadTs = "100.000001";
const created = (extra = {}) => ({ channelId, slug, threadTs, creatorId: "U_CALLER", botUserId: "U_BOT", title: "Voice task", ...extra });
const root = (extra = {}) => ({ ts: threadTs, user: "U_BOT", bot_id: "B_BOT", text: "Voice call from <@U_CALLER>", ...extra });
beforeEach(() => getDb().exec("DELETE FROM slack_threads"));

test("migration 57 adds empty provenance without attributing existing bot roots", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(m => m.version < 57)) migration.up(db);
    db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms) VALUES(?,?,?,?,?,?)")
      .run(channelId, threadTs, slug, "", "Voice call from <@U_CALLER>", 100000);
    migrations.find(m => m.version === 57).up(db);
    const row = db.prepare("SELECT starter_id,voice_bot_user_id FROM slack_threads").get();
    assert.equal(row.starter_id, "");
    assert.equal(row.voice_bot_user_id, "");
  } finally { db.close(); }
});

test("trusted successful voice creation persists caller ownership and their participation", () => {
  const row = indexSlackVoiceThread(created());
  assert.equal(row.starter_id, "U_CALLER");
  assert.equal(row.voice_bot_user_id, "U_BOT");
  assert.equal(row.agent_engaged, 1);
  assert.equal(getSlackThreadParticipant(channelId, threadTs, "U_CALLER").hidden_ms, 0);
  const file = getDb().prepare("PRAGMA database_list").all().find(db => db.name === "main").file;
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    const persisted = reader.prepare("SELECT starter_id,voice_bot_user_id FROM slack_threads WHERE channel_id=? AND thread_ts=?").get(channelId, threadTs);
    assert.equal(persisted.starter_id, "U_CALLER");
    assert.equal(persisted.voice_bot_user_id, "U_BOT");
  } finally { reader.close(); }
  assert.equal(slackThreadRootOwner(channelId, root()), "U_CALLER");
});

test("root text, mentions and other bot identities cannot spoof voice ownership", () => {
  assert.equal(indexSlackThread({ channelId, slug, root: root() }), null);
  assert.equal(slackThreadRootOwner(channelId, root()), "");
  indexSlackVoiceThread(created());
  for (const altered of [root({ user: "U_OTHER_BOT" }), root({ bot_id: undefined }), root({ subtype: "tombstone" }), root({ user: undefined })]) {
    assert.equal(slackThreadRootOwner(channelId, altered), "");
    assert.equal(indexSlackThread({ channelId, slug, root: altered }), null);
  }
  assert.equal(slackThreadRootOwner(channelId, root({ bot_id: undefined, subtype: "bot_message" })), "U_CALLER");
  assert.equal(slackThreadRootOwner("C_OTHER", root()), "");
});

test("trusted registration repairs a pre-existing bot-discovery tombstone", () => {
  skipSlackThreadCandidate({ channelId, slug, threadTs });
  assert.equal(getSlackThread(channelId, threadTs).starter_id, "");
  assert.equal(indexSlackVoiceThread(created()).starter_id, "U_CALLER");
  assert.equal(slackThreadRootOwner(channelId, root()), "U_CALLER");
  assert.ok(getSlackThreadParticipant(channelId, threadTs, "U_CALLER"));
});

test("voice creation cannot replace established owners, forks or another voice creator", () => {
  indexSlackThread({ channelId, slug, root: { ts: threadTs, user: "U_HUMAN", text: "Human task" } });
  assert.equal(indexSlackVoiceThread(created()), null);
  assert.equal(getSlackThread(channelId, threadTs).starter_id, "U_HUMAN");
  getDb().exec("DELETE FROM slack_threads");
  indexSlackFork({ ...created(), sourceThreadTs: "99.000001" });
  assert.equal(indexSlackVoiceThread(created()), null);
  assert.equal(getSlackThread(channelId, threadTs).fork_source_ts, "99.000001");
  getDb().exec("DELETE FROM slack_threads");
  indexSlackVoiceThread(created());
  assert.equal(indexSlackVoiceThread(created({ creatorId: "U_OTHER" })), null);
  assert.equal(indexSlackVoiceThread(created({ botUserId: "U_OTHER_BOT" })), null);
  assert.equal(indexSlackFork({ ...created(), sourceThreadTs: "99.000001" }), null);
  assert.equal(indexSlackVoiceThread(created({ title: "Replay changed title" })).title, "Voice task");
  assert.equal(getSlackThread(channelId, threadTs).starter_id, "U_CALLER");
});

test("refresh preserves the trusted voice title and later explicit session rename", () => {
  indexSlackVoiceThread(created());
  assert.equal(indexSlackThread({ channelId, slug, root: root({ text: "Untrusted preview" }) }).title, "Voice task");
  renameSlackThread({ channelId, threadTs, title: "Renamed task", eventTs: "200.000001" });
  assert.equal(indexSlackThread({ channelId, slug, root: root() }).title, "Renamed task");
});

test("caller retains owner-only Done and deleted bot roots can be tombstoned", () => {
  indexSlackVoiceThread(created());
  assert.equal(setSlackThreadDone(channelId, threadTs, "U_OTHER", true, 200000), false);
  assert.equal(setSlackThreadDone(channelId, threadTs, "U_CALLER", true, 200000), true);
  assert.equal(slackThreadIsDone(getSlackThread(channelId, threadTs)), true);
  skipSlackThreadCandidate({ channelId, slug, threadTs });
  assert.equal(slackThreadRootOwner(channelId, root()), "");
  assert.equal(setSlackThreadDone(channelId, threadTs, "U_CALLER", true, 300000), false);
});

test("invalid voice metadata does not index a thread", () => {
  for (const extra of [{ channelId: "" }, { slug: "" }, { threadTs: "bad" }, { creatorId: "" }, { botUserId: "" }, { creatorId: "U_BOT" }]) {
    assert.equal(indexSlackVoiceThread(created(extra)), null);
  }
  assert.equal(getSlackThread(channelId, threadTs), null);
});
