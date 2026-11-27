import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { migrations } = await import("../src/db/migrations.js");
const { indexSlackThread, getSlackThread, getSlackThreadParticipant, recordSlackThreadParticipation,
  setSlackThreadHidden, slackThreadsForUser, setSlackThreadDone, setSlackThreadLater,
  markSlackThreadCompletionDismissed, recordSlackThreadMessage, slackThreadIsDone } = await import("../src/gateway/slack-threads.js");
const { syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
const { completeThreadForCaller } = await import("../src/slack/thread-done-action.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const channelId = "C_DISMISS", threadTs = "100.000001";
const participant = user => getSlackThreadParticipant(channelId, threadTs, user);
let entry, messages, client;
beforeEach(async () => {
  for (const table of ["slack_threads", "channels", "channel_meta", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  for (const user of ["U_OWNER", "U_JOIN", "U_OTHER", "U_GATEWAY"]) await setUser(user, { approved: true, isAdmin: false });
  await upsertChannelEntry(channelId, { name: "dismiss", type: "channel" });
  entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  messages = [{ ts: threadTs, user: "U_OWNER", text: "Task", reactions: [] }];
  indexSlackThread({ channelId, slug: entry.slug, root: messages[0], agentEngaged: true });
  for (const user of ["U_JOIN", "U_OTHER"]) recordSlackThreadParticipation(channelId, threadTs, user, "150.000001");
  client = { conversations: { replies: async () => ({ messages }), members: async () => ({ members: ["U_OWNER", "U_JOIN"] }) },
    auth: { test: async () => ({ user_id: "U_GATEWAY" }) },
    reactions: { get: async () => ({ message: messages[0] }), add: async () => ({ ok: true }), remove: async () => ({ ok: true }) } };
});

test("migration 59 preserves explicitly completed starters' personal archive only", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(m => m.version < 59)) migration.up(db);
    db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,done_ms,root_done) VALUES(?,?,?,?,?,?,?,?)")
      .run(channelId, threadTs, "dismiss", "U_OWNER", "Task", 200000, 200000, 0);
    db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,done_ms,root_done) VALUES(?,?,?,?,?,?,?,?)")
      .run(channelId, "101.000001", "dismiss", "U_OWNER", "Reaction only", 200000, 0, 1);
    for (const [ts, user] of [[threadTs, "U_OWNER"], [threadTs, "U_JOIN"], ["101.000001", "U_OWNER"]]) {
      db.prepare("INSERT INTO slack_thread_participants(channel_id,thread_ts,user_id,hidden_ms,last_own_message_ts) VALUES(?,?,?,?,?)")
        .run(channelId, ts, user, 123, ts);
    }
    migrations.find(m => m.version === 59).up(db);
    const rows = db.prepare("SELECT thread_ts,user_id,dismissed_ms,hidden_ms FROM slack_thread_participants").all();
    assert.equal(rows.find(r => r.thread_ts === threadTs && r.user_id === "U_OWNER").dismissed_ms, 200000);
    assert.equal(rows.find(r => r.user_id === "U_JOIN").dismissed_ms, 0);
    assert.equal(rows.find(r => r.thread_ts === "101.000001").dismissed_ms, 0);
    assert.ok(rows.every(r => r.hidden_ms === 123));
  } finally { db.close(); }
});

test("owner Done dismisses only that owner, without granting completion authority or using Hide", () => {
  assert.equal(setSlackThreadDone(channelId, threadTs, "U_JOIN", true, 200000), false);
  assert.equal(setSlackThreadDone(channelId, threadTs, "U_OWNER", true, 200000), true);
  assert.equal(slackThreadIsDone(getSlackThread(channelId, threadTs)), true);
  assert.equal(participant("U_OWNER").dismissed_ms, 200000);
  assert.equal(participant("U_OWNER").hidden_ms, 0);
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  assert.equal(slackThreadsForUser("U_OWNER")[0].dismissed_ms, 200000);
});

test("new own message clears own dismissal; duplicates, delayed messages and someone else's replies cannot", () => {
  setSlackThreadDone(channelId, threadTs, "U_OWNER", true, 200000);
  markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 210000);
  recordSlackThreadParticipation(channelId, threadTs, "U_OTHER", "220.000001");
  for (const ts of ["150.000001", "209.000001", "210.000001"]) {
    recordSlackThreadParticipation(channelId, threadTs, "U_JOIN", ts);
    assert.equal(participant("U_JOIN").dismissed_ms, 210000);
  }
  recordSlackThreadParticipation(channelId, threadTs, "U_JOIN", "211.000001");
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  assert.equal(markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 210000), false);
  assert.equal(markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 211000), false,
    "an ambiguous same-millisecond event cannot dismiss newer own work");
  assert.equal(participant("U_OWNER").dismissed_ms, 200000);
  assert.equal(getSlackThread(channelId, threadTs).done_ms, 200000);
});

test("Reopen and addressed new work reset automatic dismissals while preserving someone else's Hide", () => {
  const complete = () => {
    setSlackThreadDone(channelId, threadTs, "U_OWNER", true, 200000);
    markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 210000);
    setSlackThreadHidden(channelId, threadTs, "U_OTHER", true, 215000);
  };
  for (const reset of [() => setSlackThreadDone(channelId, threadTs, "U_OWNER", false, 220000),
    () => recordSlackThreadMessage(channelId, threadTs, "220.000001", { human: true }),
    () => setSlackThreadLater(channelId, threadTs, "U_OWNER", true, 220000)]) {
    complete(); reset();
    assert.equal(participant("U_OWNER").dismissed_ms, 0);
    assert.equal(participant("U_JOIN").dismissed_ms, 0);
    assert.equal(participant("U_OTHER").hidden_ms, 215000);
  }
});

const reaction = (user, eventTs = "200.000001") => ({ user, reaction: "heavy_check_mark", event_ts: eventTs,
  item: { type: "message", channel: channelId, ts: threadTs } });
const checked = () => { messages[0].reactions = [{ name: "heavy_check_mark", count: 1, users: ["U_JOIN"] }]; };
test("admitted participant checkmark dismisses only its author and duplicate deliveries stay personal", async () => {
  checked();
  for (let i = 0; i < 2; i++) await syncThreadCompletionReaction(client, reaction("U_JOIN"), { added: true });
  assert.equal(slackThreadIsDone(getSlackThread(channelId, threadTs)), true);
  assert.equal(participant("U_JOIN").dismissed_ms, 200000);
  assert.equal(participant("U_OWNER").dismissed_ms, 0);
  assert.equal(participant("U_OTHER").dismissed_ms, 0);
});

test("reaction dismissal rejects nonparticipants, denied/private/sudo callers and gateway mirrors", async () => {
  checked();
  await setUser("U_DENIED", { approved: false });
  recordSlackThreadParticipation(channelId, threadTs, "U_DENIED", "150.000001");
  recordSlackThreadParticipation(channelId, threadTs, "U_GATEWAY", "150.000001");
  getDb().prepare("UPDATE slack_threads SET completion_mirror_user=? WHERE channel_id=? AND thread_ts=?").run("U_GATEWAY", channelId, threadTs);
  for (const user of ["U_UNKNOWN", "U_DENIED", "U_GATEWAY"]) await syncThreadCompletionReaction(client, reaction(user), { added: true });
  assert.equal(participant("U_UNKNOWN"), null);
  assert.equal(participant("U_DENIED").dismissed_ms, 0);
  assert.equal(participant("U_GATEWAY").dismissed_ms, 0);
  await setThreadSudo(entry.slug, threadTs, true);
  await syncThreadCompletionReaction(client, reaction("U_JOIN"), { added: true });
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  await setThreadSudo(entry.slug, threadTs, false);
  getDb().prepare("UPDATE channels SET data=? WHERE channel_id=?").run(JSON.stringify({ ...entry, type: "group" }), channelId);
  client.conversations.members = async () => ({ members: ["U_OWNER"] });
  await syncThreadCompletionReaction(client, reaction("U_JOIN"), { added: true });
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
});

test("delayed checkmark cannot dismiss a newer own prompt or a reopened work cycle", async () => {
  checked();
  recordSlackThreadParticipation(channelId, threadTs, "U_JOIN", "250.000001");
  await syncThreadCompletionReaction(client, reaction("U_JOIN", "200.000001"), { added: true });
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  setSlackThreadDone(channelId, threadTs, "U_OWNER", false, 300000);
  await syncThreadCompletionReaction(client, reaction("U_JOIN", "299.000001"), { added: true });
  assert.equal(slackThreadIsDone(getSlackThread(channelId, threadTs)), false);
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
});

test("voice Done on existing shared completion dismisses caller without moving global Done watermark", async () => {
  checked();
  await syncThreadCompletionReaction(client, reaction("U_JOIN"), { added: true });
  const before = getSlackThread(channelId, threadTs);
  const result = await completeThreadForCaller(client, { channelId, threadTs, userId: "U_OWNER" });
  assert.equal(result.alreadyDone, true);
  assert.ok(participant("U_OWNER").dismissed_ms > 0);
  assert.equal(getSlackThread(channelId, threadTs).done_ms, before.done_ms);
  assert.equal(getSlackThread(channelId, threadTs).root_reaction_ms, before.root_reaction_ms);
  await assert.rejects(completeThreadForCaller(client, { channelId, threadTs, userId: "U_JOIN" }), /starter/);
});


test("removing final shared check clears automatic dismissal for a later completion cycle", async () => {
  checked();
  await syncThreadCompletionReaction(client, reaction("U_JOIN"), { added: true });
  setSlackThreadHidden(channelId, threadTs, "U_OTHER", true, 215000);
  messages[0].reactions = [];
  await syncThreadCompletionReaction(client, reaction("U_JOIN", "220.000001"));
  assert.equal(slackThreadIsDone(getSlackThread(channelId, threadTs)), false);
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  assert.equal(participant("U_OTHER").hidden_ms, 215000);
  checked();
  await syncThreadCompletionReaction(client, reaction("U_OWNER", "230.000001"), { added: true });
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  assert.equal(participant("U_OWNER").dismissed_ms, 230000);
});


test("old participant completion cannot dismiss a later completion cycle", () => {
  setSlackThreadDone(channelId, threadTs, "U_OWNER", true, 200000);
  markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 210000);
  setSlackThreadDone(channelId, threadTs, "U_OWNER", false, 300000);
  setSlackThreadDone(channelId, threadTs, "U_OWNER", true, 400000);
  assert.equal(markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 210000), false);
  assert.equal(participant("U_JOIN").dismissed_ms, 0);
  assert.equal(markSlackThreadCompletionDismissed(channelId, threadTs, "U_JOIN", 410000), true);
});
