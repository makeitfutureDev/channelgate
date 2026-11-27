import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { migrations } = await import("../src/db/migrations.js");
const { indexSlackThread, getSlackThread, recordSlackThreadParticipation, isSlackThreadParticipant,
  setSlackThreadHidden, slackThreadsForUser, trackSlackThread, setSlackThreadDone, setSlackThreadLater } = await import("../src/gateway/slack-threads.js");
const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
let entry;
const threadTs = "100.000001";
const client = { conversations: { replies: async () => ({ messages: [{ ts: threadTs, user: "U_OWNER", text: "Task" }] }) } };
const own = (user = "U_JOIN") => slackThreadsForUser(user).find(row => row.thread_ts === threadTs);
const event = (extra = {}) => ({ channel: "C_PARTICIPANTS", thread_ts: threadTs, ts: "201.000001", user: "U_JOIN", text: "An ordinary reply", ...extra });
beforeEach(async () => {
  for (const table of ["slack_threads", "channels", "channel_meta", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  for (const user of ["U_OWNER", "U_JOIN", "U_OTHER"]) await setUser(user, { approved: true, isAdmin: false });
  await setUser("U_DENIED", { approved: false, isAdmin: false });
  await upsertChannelEntry("C_PARTICIPANTS", { name: "participants", type: "channel" });
  entry = await getChannelEntry("C_PARTICIPANTS");
  await saveChannelMeta(entry.slug, { access: "approved" });
  indexSlackThread({ channelId: "C_PARTICIPANTS", slug: entry.slug, root: { ts: threadTs, user: "U_OWNER", text: "Task" }, agentEngaged: true });
});

test("migration 56 backfills verified owners and excludes discovery tombstones", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(m => m.version < 56)) migration.up(db);
    db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms) VALUES(?,?,?,?,?,?)")
      .run("C_OLD", threadTs, "old", "U_OWNER", "Task", 100000);
    db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms) VALUES(?,?,?,?,?,?)")
      .run("C_OLD", "99.000001", "old", "", "", 99000);
    migrations.find(m => m.version === 56).up(db);
    assert.deepEqual(db.prepare("SELECT user_id,last_own_message_ts,hidden_ms FROM slack_thread_participants").all().map(r => ({ ...r })),
      [{ user_id: "U_OWNER", last_own_message_ts: threadTs, hidden_ms: 0 }]);
  } finally { db.close(); }
});

test("authorized unmentioned replies join personal Activity without transferring ownership", async () => {
  await observeSlackThreadMessage(client, event(), "U_BOT");
  assert.equal(isSlackThreadParticipant("C_PARTICIPANTS", threadTs, "U_JOIN"), true);
  assert.equal(own().hidden_ms, 0);
  assert.equal(getSlackThread("C_PARTICIPANTS", threadTs).starter_id, "U_OWNER");
  assert.equal(setSlackThreadDone("C_PARTICIPANTS", threadTs, "U_JOIN", true), false);
  assert.equal(setSlackThreadLater("C_PARTICIPANTS", threadTs, "U_JOIN", true), false);
});

test("Hide is personal; other people, outcomes, bots and duplicate own messages never undo it", async () => {
  await observeSlackThreadMessage(client, event(), "U_BOT");
  setSlackThreadHidden("C_PARTICIPANTS", threadTs, "U_JOIN", true, 202000);
  for (const extra of [{ user: "U_OTHER", ts: "203.000001" }, { user: "U_BOT", ts: "204.000001" },
    { bot_id: "B_EXTERNAL", ts: "205.000001" }, { app_id: "APP_EXTERNAL", ts: "206.000001" },
    {}, { ts: "200.000001" }, { subtype: "message_changed", ts: "209.000001" }]) {
    await observeSlackThreadMessage(client, event(extra), "U_BOT");
    assert.equal(own().hidden_ms, 202000);
  }
  assert.equal(own("U_OWNER").hidden_ms, 0);
  assert.equal(own("U_OTHER").hidden_ms, 0);
  await observeSlackThreadMessage(client, event({ ts: "210.000001" }), "U_BOT");
  assert.equal(own().hidden_ms, 0);
});

test("unmentioned participation leaves global Done and Later unchanged", async () => {
  setSlackThreadDone("C_PARTICIPANTS", threadTs, "U_OWNER", true, 200000);
  await observeSlackThreadMessage(client, event(), "U_BOT");
  assert.equal(getSlackThread("C_PARTICIPANTS", threadTs).done_ms, 200000);
  setSlackThreadLater("C_PARTICIPANTS", threadTs, "U_OWNER", true, 202000);
  await observeSlackThreadMessage(client, event({ ts: "203.000001" }), "U_BOT");
  assert.equal(getSlackThread("C_PARTICIPANTS", threadTs).later_ms, 202000);
});

test("unauthorized people and nonadmin sudo-thread authors cannot join or unhide", async () => {
  await observeSlackThreadMessage(client, event({ user: "U_DENIED" }), "U_BOT");
  assert.equal(isSlackThreadParticipant("C_PARTICIPANTS", threadTs, "U_DENIED"), false);
  recordSlackThreadParticipation("C_PARTICIPANTS", threadTs, "U_JOIN", "201.000001");
  setSlackThreadHidden("C_PARTICIPANTS", threadTs, "U_JOIN", true, 202000);
  await setThreadSudo(entry.slug, threadTs, true);
  await observeSlackThreadMessage(client, event({ ts: "203.000001" }), "U_BOT");
  assert.equal(own().hidden_ms, 202000);
  assert.equal(setSlackThreadHidden("C_PARTICIPANTS", threadTs, "U_UNKNOWN", true), false);
});

test("admitted discovery records author when observer preceded indexing and never replays through a later hide", async () => {
  getDb().exec("DELETE FROM slack_threads");
  await observeSlackThreadMessage(client, event(), "U_BOT");
  assert.equal(own(), undefined);
  await trackSlackThread(client, { channelId: "C_PARTICIPANTS", slug: entry.slug, threadKey: threadTs,
    messageTs: "201.000001", participantId: "U_JOIN" });
  assert.equal(own().last_own_message_ts, "201.000001");
  setSlackThreadHidden("C_PARTICIPANTS", threadTs, "U_JOIN", true, 204000);
  // This original delivery was never observed before Hide. Its delayed indexing cannot unhide.
  await trackSlackThread(client, { channelId: "C_PARTICIPANTS", slug: entry.slug, threadKey: threadTs,
    messageTs: "203.000001", participantId: "U_JOIN" });
  assert.equal(own().hidden_ms, 204000);
  assert.equal(own().last_own_message_ts, "203.000001");
  await trackSlackThread(client, { channelId: "C_PARTICIPANTS", slug: entry.slug, threadKey: threadTs,
    messageTs: "204.000002", participantId: "U_JOIN" });
  assert.equal(own().hidden_ms, 204000, "ambiguous same-millisecond delivery cannot undo Hide");
  await trackSlackThread(client, { channelId: "C_PARTICIPANTS", slug: entry.slug, threadKey: threadTs,
    messageTs: "205.000001", participantId: "U_JOIN" });
  assert.equal(own().hidden_ms, 0);
  setSlackThreadHidden("C_PARTICIPANTS", threadTs, "U_OWNER", true, 206000);
  indexSlackThread({ channelId: "C_PARTICIPANTS", slug: entry.slug, root: { ts: threadTs, user: "U_OWNER", text: "Task" } });
  assert.equal(own("U_OWNER").hidden_ms, 206000, "root refresh cannot unhide its owner");
});
