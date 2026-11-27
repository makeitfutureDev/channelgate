import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { migrations } = await import("../src/db/migrations.js");
const { indexSlackThread, getSlackThread, getSlackThreadParticipant, recordSlackThreadParticipation,
  recordSlackThreadMessage, setSlackThreadDone, updateSlackThreadRootCompletion } = await import("../src/gateway/slack-threads.js");
const { inspectThreadCompletion } = await import("../src/gateway/thread-completion.js");
const { activityThreadSnapshot, homeThreadsSnapshot } = await import("../src/slack/home-threads.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const channelId = "C_HISTORY", owner = "U_OWNER", other = "U_OTHER", bot = "U_BOT";
const ts = "100.000001";
let entry, client, messages, reads;
const check = (users, extra = {}) => ({ name: "white_check_mark", count: users.length, users, ...extra });
const participant = (user = owner, thread = ts) => getSlackThreadParticipant(channelId, thread, user);
function seed(thread = ts, reactions = [check([owner])], { legacy = true } = {}) {
  const root = { ts: thread, user: owner, text: "Historical task", reactions };
  indexSlackThread({ channelId, slug: entry.slug, root, agentEngaged: true });
  messages.set(thread, [root]);
  if (legacy) getDb().prepare("UPDATE slack_thread_participants SET historical_completion_checked=0 WHERE channel_id=? AND thread_ts=?").run(channelId, thread);
  return root;
}
beforeEach(async () => {
  for (const table of ["slack_threads", "channels", "channel_meta", "thread_overrides", "followup_done", "sessions", "active_runs", "bg_jobs", "question_requests", "approval_requests"]) getDb().exec(`DELETE FROM ${table}`);
  for (const user of [owner, other]) await setUser(user, { approved: true, isAdmin: false });
  await upsertChannelEntry(channelId, { name: "history", type: "channel" });
  entry = await getChannelEntry(channelId);
  await saveChannelMeta(entry.slug, { access: "approved" });
  messages = new Map(); reads = 0;
  client = { auth: { test: async () => ({ ok: true, user_id: bot }) },
    conversations: { replies: async ({ ts: thread }) => { reads++; return { messages: messages.get(thread) }; } },
    chat: { getPermalink: async () => ({ permalink: "https://example.slack.com/thread" }) } };
});

test("migration 61 recovers durable personal receipts, fences restored work, and limits legacy eligibility", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(m => m.version < 61)) migration.up(db);
    const insert = db.prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,root_done,completion_reopened_ms) VALUES('C',?,'s','OWNER','Task',100000,?,?)");
    for (const [thread, done, reopened, ownTs] of [["100.1", 1, 0, "100.1"], ["101.1", 1, 0, "301.1"], ["102.1", 1, 300000, "102.1"], ["103.1", 0, 0, "103.1"], ["104.1", 1, 0, "104.1"]]) {
      insert.run(thread, done, reopened);
      db.prepare("INSERT INTO slack_thread_participants(channel_id,thread_ts,user_id,last_own_message_ts) VALUES('C',?,'OWNER',?)").run(thread, ownTs);
      if (thread !== "104.1") db.prepare("INSERT INTO followup_done(user_id,thread_key,done_ms) VALUES('OWNER',?,200000)").run(`C::${thread}`);
    }
    migrations.find(m => m.version === 61).up(db);
    const rows = db.prepare("SELECT thread_ts,dismissed_ms,historical_completion_checked FROM slack_thread_participants ORDER BY thread_ts").all();
    assert.deepEqual(rows.map(r => [r.dismissed_ms, r.historical_completion_checked]), [[200000,1],[0,1],[0,1],[0,1],[0,0]]);
    db.prepare("INSERT INTO slack_thread_participants(channel_id,thread_ts,user_id) VALUES('C','104.1','NEW')").run();
    assert.equal(db.prepare("SELECT historical_completion_checked AS n FROM slack_thread_participants WHERE user_id='NEW'").get().n, 1);
  } finally { db.close(); }
});

test("full pagination archives only existing matching actors, including reply checks", async () => {
  const root = seed(ts, [check([other])]);
  recordSlackThreadParticipation(channelId, ts, other, "101.000001");
  getDb().exec("UPDATE slack_thread_participants SET historical_completion_checked=0");
  client.conversations.replies = async ({ cursor }) => { reads++; return cursor
    ? { messages: [{ ts: "102.000001", reactions: [check([owner, other, "U_STRANGER"], { name: "heavy_check_mark" })] }] }
    : { messages: [root], response_metadata: { next_cursor: "page2" } }; };
  const view = await activityThreadSnapshot(client, owner);
  assert.equal(view.rows.length, 0);
  assert.ok(participant().dismissed_ms > 0);
  assert.ok(participant(other).dismissed_ms > 0);
  assert.equal(participant("U_STRANGER"), null);
  assert.equal(reads, 2);
  await activityThreadSnapshot(client, owner);
  assert.equal(reads, 2, "one-time reconciliation stops polling");
});

test("other-person checks stay visible as Done and are never inferred from starter ownership", async () => {
  seed(ts, [check([other])]);
  const view = await activityThreadSnapshot(client, owner);
  assert.equal(view.rows[0].status, "done");
  assert.equal(participant().dismissed_ms, 0);
  assert.equal(participant().historical_completion_checked, 1);
});

test("legacy gateway-only root marker preserves only the owner's archive", async () => {
  seed(ts, [check([bot])]);
  recordSlackThreadParticipation(channelId, ts, other, "101.000001");
  getDb().exec("UPDATE slack_thread_participants SET historical_completion_checked=0");
  assert.equal((await activityThreadSnapshot(client, owner)).rows.length, 0);
  assert.ok(participant().dismissed_ms > 0);
  assert.equal(participant(other).dismissed_ms, 0);
  assert.equal(getSlackThread(channelId, ts).done_ms, 0, "repair does not create shared explicit Done");
  assert.equal((await activityThreadSnapshot(client, other)).rows[0].status, "done");
});

test("new roots and legacy root markers with human actors cannot acquire gateway-only fallback", async () => {
  seed(ts, [check([bot])], { legacy: false });
  seed("101.000001", [check([bot, other])]);
  const view = await activityThreadSnapshot(client, owner);
  assert.equal(view.rows.length, 2);
  assert.equal(participant().dismissed_ms, 0);
  assert.equal(participant(owner, "101.000001").dismissed_ms, 0);
  assert.equal(reads, 1, "post-upgrade roots never request a legacy read");
});

test("unknown reactor lists fail open and retry full identities without consuming flags", async () => {
  seed(ts, [check([other], { count: 2 })]);
  let clock = Date.now();
  let view = await activityThreadSnapshot(client, owner, {}, { now: () => clock });
  assert.equal(view.rows.length, 1); assert.equal(view.unavailable, true);
  assert.equal(participant().historical_completion_checked, 0);
  let fullReads = 0;
  client.reactions = { get: async ({ full }) => { assert.equal(full, true); fullReads++; return { message: { reactions: [check([owner, other])] } }; } };
  clock += 16000;
  view = await activityThreadSnapshot(client, owner, {}, { now: () => clock });
  assert.equal(view.rows.length, 0); assert.equal(fullReads, 1);
});

test("Home consumes the same personal actor metadata before filtering", async () => {
  seed();
  assert.equal((await homeThreadsSnapshot(client, owner, {}, { discover: false })).rows.length, 0);
  assert.ok(participant().dismissed_ms > 0);
});

for (const action of ["own message", "Reopen", "human prompt"]) test(`${action} during asynchronous inspection fences stale completion`, async () => {
  const root = seed();
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  client.conversations.replies = async () => { started(); return new Promise(resolve => { release = () => resolve({ messages: [root] }); }); };
  const pending = activityThreadSnapshot(client, owner);
  await began;
  if (action === "own message") recordSlackThreadParticipation(channelId, ts, owner, "200.000001");
  else if (action === "human prompt") recordSlackThreadMessage(channelId, ts, "200.000001", { human: true });
  else setSlackThreadDone(channelId, ts, owner, false, 200000);
  release();
  const view = await pending;
  assert.equal(view.rows.length, 1);
  assert.equal(participant().dismissed_ms, 0);
  assert.equal(participant().historical_completion_checked, 1);
});

test("an own message after repair stays visible through later Home inspection", async () => {
  seed(); await activityThreadSnapshot(client, owner);
  const nextTs = `${Math.floor(Date.now()/1000)+2}.000001`;
  recordSlackThreadParticipation(channelId, ts, owner, nextTs);
  assert.equal((await homeThreadsSnapshot(client, owner, {}, { discover: false })).rows.length, 1);
  assert.equal(participant().dismissed_ms, 0);
});

test("failed pagination does not persist partial actors and successful retry resumes the unread page", async () => {
  const root = seed();
  let fail = true, clock = Date.now();
  const cursors = [];
  client.conversations.replies = async ({ cursor }) => { cursors.push(cursor); if (!cursor) return { messages: [root], response_metadata: { next_cursor: "next" } }; if (fail) throw new Error("rate limited"); return { messages: [{ ts: "101.000001" }] }; };
  assert.equal((await activityThreadSnapshot(client, owner, {}, { now: () => clock })).rows.length, 1);
  assert.equal(participant().historical_completion_checked, 0);
  fail = false; clock += 16000;
  assert.equal((await activityThreadSnapshot(client, owner, {}, { now: () => clock })).rows.length, 0);
  assert.deepEqual(cursors, [undefined, "next", "next"]);
});

test("a slow read is coalesced, times out visibly, and applies only after fresh access", async () => {
  const root = seed();
  let release;
  client.conversations.replies = async () => { reads++; return new Promise(resolve => { release = () => resolve({ messages: [root] }); }); };
  const views = await Promise.all([activityThreadSnapshot(client, owner, {}, { rootReadBudgetMs: 10 }), activityThreadSnapshot(client, owner, {}, { rootReadBudgetMs: 10 })]);
  assert.equal(reads, 1); assert.ok(views.every(v => v.rows.length === 1 && v.unavailable));
  await saveChannelMeta(entry.slug, { access: "none" }); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await activityThreadSnapshot(client, owner)).rows.length, 0);
  assert.equal(participant().historical_completion_checked, 0);
  await saveChannelMeta(entry.slug, { access: "approved" });
  assert.equal((await activityThreadSnapshot(client, owner)).rows.length, 0);
  assert.ok(participant().dismissed_ms > 0); assert.equal(reads, 1);
});

test("repair batch caps ten threads and resumes long threads after a twenty-page slice", async () => {
  for (let i = 100; i < 112; i++) seed(`${i}.000001`);
  await activityThreadSnapshot(client, owner);
  assert.equal(reads, 10);
  await activityThreadSnapshot(client, owner); assert.equal(reads, 12);
  getDb().exec("DELETE FROM slack_threads");
  const root = seed();
  let pages = 0, clock = Date.now();
  client.conversations.replies = async ({ cursor }) => { pages++; const page = Number(cursor || 0); return { messages: page === 0 ? [root] : [{ ts: `${101 + page}.000001` }], ...(page < 22 ? { response_metadata: { next_cursor: String(page+1) } } : {}) }; };
  assert.equal((await activityThreadSnapshot(client, owner, {}, { now: () => clock })).rows.length, 1);
  assert.equal(pages, 20); assert.equal(participant().historical_completion_checked, 0);
  clock += 16000;
  assert.equal((await activityThreadSnapshot(client, owner, {}, { now: () => clock })).rows.length, 0);
  assert.equal(pages, 23);
});

test("inspections older than a newer verified completion state cannot consume personal metadata", async () => {
  const root = seed();
  const inspected = await inspectThreadCompletion(client, channelId, ts);
  updateSlackThreadRootCompletion(channelId, root, { completed: true, inspectedAt: inspected.inspectedAt + 1 });
  updateSlackThreadRootCompletion(channelId, root, inspected);
  assert.equal(participant().historical_completion_checked, 0);
  assert.equal(participant().dismissed_ms, 0);
});

test("legacy gateway archive survives repeated passive scans with a persisted mirror until Reopen", async () => {
  seed(ts, [check([bot])]);
  getDb().prepare("UPDATE slack_threads SET completion_mirror_user=? WHERE channel_id=? AND thread_ts=?").run(bot, channelId, ts);
  assert.equal((await activityThreadSnapshot(client, owner)).rows.length, 0);
  assert.equal(getSlackThread(channelId, ts).historical_completion_marker_user, bot);
  for (let i = 0; i < 2; i++) {
    assert.equal((await homeThreadsSnapshot(client, owner, {}, { discover: false })).rows.length, 0);
    assert.ok(participant().dismissed_ms > 0);
    assert.equal(getSlackThread(channelId, ts).root_done, 1);
  }
  setSlackThreadDone(channelId, ts, owner, false);
  assert.equal((await homeThreadsSnapshot(client, owner, {}, { discover: false })).rows.length, 1);
  assert.equal(participant().dismissed_ms, 0);
});

test("authenticating the gateway for attribution does not change ordinary shared completion", async () => {
  seed(ts, [check([bot])]);
  messages.get(ts).push({ ts: "101.000001", reactions: [check([bot])] });
  const view = await activityThreadSnapshot(client, owner);
  assert.equal(view.rows[0].status, "done", "reply marker excludes the legacy fallback but preserves shared Done");
  assert.equal(participant().dismissed_ms, 0);
});

test("failed actor hydration does not retain actors from a partially processed page", async () => {
  seed();
  messages.get(ts).push({ ts: "101.000001", reactions: [check([], { count: 1 })] });
  let clock = Date.now();
  assert.equal((await activityThreadSnapshot(client, owner, {}, { now: () => clock })).unavailable, true);
  assert.equal(participant().historical_completion_checked, 0);
  messages.set(ts, [{ ts, user: owner, reactions: [check([other])] }]);
  clock += 16000;
  const view = await activityThreadSnapshot(client, owner, {}, { now: () => clock });
  assert.equal(view.rows[0].status, "done");
  assert.equal(participant().dismissed_ms, 0, "removed actor from the failed page is discarded");
});


test("own work restored before migration stays visible when its timestamp follows the checked message", async () => {
  for (const [thread, actor] of [[ts, owner], ["101.000001", bot]]) {
    seed(thread, [check([actor])]);
    recordSlackThreadParticipation(channelId, thread, owner, "200.000001");
    // Simulate migration eligibility when the previous version restored the dismissal.
    getDb().prepare("UPDATE slack_thread_participants SET historical_completion_checked=0 WHERE channel_id=? AND thread_ts=?").run(channelId, thread);
  }
  const view = await activityThreadSnapshot(client, owner);
  assert.equal(view.rows.length, 2);
  assert.equal(participant().dismissed_ms, 0);
  assert.equal(participant(owner, "101.000001").dismissed_ms, 0);
});


test("slow actor hydration finishes its admitted page after the snapshot wait budget", async () => {
  seed(ts, [check([other], { count: 2 })]);
  messages.get(ts).push({ ts: "101.000001", reactions: [check([other], { count: 2 })] });
  let releaseFirst, releaseSecond, secondStarted;
  const second = new Promise(resolve => { secondStarted = resolve; });
  let hydrated = 0;
  client.reactions = { get: async () => {
    hydrated++;
    return new Promise(resolve => {
      const release = () => resolve({ message: { reactions: [check([owner, other])] } });
      if (hydrated === 1) releaseFirst = release;
      else { releaseSecond = release; secondStarted(); }
    });
  } };
  const initial = await activityThreadSnapshot(client, owner, {}, { rootReadBudgetMs: 20 });
  assert.equal(initial.rows.length, 1); assert.equal(initial.unavailable, true);
  assert.equal(participant().historical_completion_checked, 0);
  releaseFirst();
  await second;
  releaseSecond();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await activityThreadSnapshot(client, owner)).rows.length, 0);
  assert.equal(reads, 1); assert.equal(hydrated, 2);
});
