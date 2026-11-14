import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb, toJson } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { getSlackThread, indexSlackThread, indexSlackFork, slackThreadRootOwner, trackSlackThread, recordSlackThreadOutcome, setSlackThreadDone, setSlackThreadLater,
  slackThreadRuntime, slackThreadStatus, updateSlackThreadRootCompletion, slackThreadCandidates, eligibleSlackThreadsForUser, renameSlackThread } = await import("../src/gateway/slack-threads.js");
const { homeThreadsSnapshot, homeThreadBlocks, registerHomeThreadActions, normalizeThreadView, homeThreadsRefreshKey, activityThreadSnapshot, discoverSlackThreadHistory, markAllSlackThreadsDone } = await import("../src/slack/home-threads.js");
const { createHomeThreadReader } = await import("../src/slack/home-thread-reader.js");

let roots;
let members;
let reads;
let client;
let markerCalls;
async function channel(id = "C_THREADS", type = "channel", meta = {}) {
  await upsertChannelEntry(id, { name: `#${id}`, type, isDM: type === "im" });
  const entry = await getChannelEntry(id);
  await saveChannelMeta(entry.slug, { isDM: type === "im", access: "approved", ...meta });
  return { ...entry, channelId: id };
}
function root(entry, ts, user = "U_MINE", extra = {}) {
  const message = { ts, user, text: `Task ${ts}`, ...extra };
  roots.set(`${entry.channelId}:${ts}`, message);
  // Existing fixtures describe admitted agent tasks; raw observation regressions explicitly omit this marker.
  return indexSlackThread({ channelId: entry.channelId, slug: entry.slug, root: message, agentEngaged: true });
}
beforeEach(async () => {
  const db = getDb();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) db.exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false });
  await setUser("U_OTHER", { approved: true, isAdmin: false });
  roots = new Map(); members = new Map(); reads = [];
  markerCalls = [];
  client = {
    auth: { test: async () => ({ user_id: "B_GATEWAY" }) },
    reactions: {
      add: async (args) => { markerCalls.push(["add", args]); return { ok: true }; },
      remove: async (args) => { markerCalls.push(["remove", args]); return { ok: true }; },
    },
    conversations: {
      replies: async ({ channel, ts }) => { reads.push(`${channel}:${ts}`); return { messages: roots.has(`${channel}:${ts}`) ? [roots.get(`${channel}:${ts}`)] : [] }; },
      members: async ({ channel }) => { if (!members.has(channel)) throw new Error("not_in_channel"); return { members: members.get(channel) }; },
    },
    chat: { getPermalink: async ({ channel, message_ts }) => ({ permalink: `https://example.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` }) },
  };
});

test("verified root owner, not the triggering author, controls the personal list", async () => {
  const c = await channel();
  roots.set("C_THREADS:100.000001", { ts: "100.000001", user: "U_OTHER", text: "Original task" });
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "101.000001" });
  assert.equal(getSlackThread(c.channelId, "100.000001").starter_id, "U_OTHER");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "all" })).rows.length, 0);
  assert.equal((await homeThreadsSnapshot(client, "U_OTHER", { filter: "all" })).rows.length, 1);
  roots.set("C_THREADS:102.000001", { ts: "102.000001", user: "U_OTHER", bot_id: "B_OTHER", text: "Automation" });
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "102.000001", messageTs: "102.000001" });
  assert.equal(getSlackThread(c.channelId, "102.000001"), null);
});

test("private/DM membership and current gateway access fail closed, including admins", async () => {
  const pub = await channel();
  const privateChannel = await channel("G_PRIVATE", "group");
  const dm = await channel("D_PRIVATE", "im");
  root(pub, "100.000001"); root(privateChannel, "101.000001"); root(dm, "102.000001");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  await setUser("U_MINE", { isAdmin: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1, "admin is still not a private Slack member");
  members.set("G_PRIVATE", ["U_MINE"]); members.set("D_PRIVATE", ["U_MINE"]);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 3);
  await setUser("U_MINE", { isAdmin: false });
  await saveChannelMeta(pub.slug, { access: "none" });
  members.set("G_PRIVATE", []); members.set("D_PRIVATE", []);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
});

test("sudo threads disappear after admin demotion", async () => {
  const c = await channel(); root(c, "100.000001");
  await setThreadSudo(c.slug, "100.000001", true);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  await setUser("U_MINE", { isAdmin: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
});

test("Working includes queued foreground and background, Waiting takes precedence, normal replies stay Idle", async () => {
  const c = await channel();
  for (let n = 1; n <= 4; n++) root(c, `10${n}.000001`);
  const db = getDb();
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("a", toJson({ channelId: c.channelId, threadKey: "101.000001" }));
  db.prepare("INSERT INTO bg_jobs(id,data) VALUES(?,?)").run("b", toJson({ channelId: c.channelId, threadKey: "102.000001::agent-b" }));
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("c", toJson({ channelId: c.channelId, threadKey: "103.000001", awaitingChoice: true }));
  const state = slackThreadRuntime({ pendingApprovals: [{ channelId: c.channelId, threadKey: "101.000001" }] });
  assert.equal(slackThreadStatus(getSlackThread(c.channelId, "101.000001"), state), "waiting");
  const view = await homeThreadsSnapshot(client, "U_MINE");
  assert.deepEqual(view.rows.map((r) => r.status), ["working", "working", "waiting", "idle"]);
  recordSlackThreadOutcome(c.channelId, "104.000001", { error: true, at: 200000 });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "error" })).rows[0].status, "error");
  recordSlackThreadOutcome(c.channelId, "104.000001", { at: 200001 });
  assert.equal(slackThreadStatus(getSlackThread(c.channelId, "104.000001"), slackThreadRuntime()), "idle");
});

test("discovery preserves Done and root checks, while explicit Reopen overrides old evidence", async () => {
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows.length, 1);
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "150.000001" });
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000, "old redelivery cannot reopen");
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "201.000001" });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false, 202000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  const checked = root(c, "101.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1 }] });
  assert.equal(slackThreadStatus(checked, new Map()), "done");
  setSlackThreadDone(c.channelId, checked.thread_ts, "U_MINE", false, 300000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "all" })).rows.find((r) => r.thread_ts === checked.thread_ts).status, "idle");
  updateSlackThreadRootCompletion(c.channelId, { ts: checked.thread_ts, reactions: [] });
  assert.equal(slackThreadStatus(getSlackThread(c.channelId, checked.thread_ts), new Map()), "idle");
});

test("pagination reaches older rows, clamps stale pages and filters statuses", async () => {
  const c = await channel();
  for (let n = 1; n <= 23; n++) root(c, `${100 + n}.000001`);
  const first = await homeThreadsSnapshot(client, "U_MINE");
  const second = await homeThreadsSnapshot(client, "U_MINE", { page: 1 });
  const last = await homeThreadsSnapshot(client, "U_MINE", { page: 100 });
  assert.equal(first.total, 23); assert.equal(first.rows.length, 10); assert.equal(last.rows.length, 3); assert.equal(last.page, 2);
  assert.equal(new Set([...first.rows, ...second.rows, ...last.rows].map((r) => r.thread_ts)).size, 23);
  setSlackThreadDone(c.channelId, first.rows[0].thread_ts, "U_MINE", true);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows.length, 1);
  assert.equal(normalizeThreadView({ filter: "__proto__", page: -2 }).filter, "active");
  assert.ok(homeThreadBlocks(first).length < 45);
  assert.ok(first.rows.every((r) => r.url.startsWith("https://example.slack.com/archives/")));
});

test("history indexes 100 newest candidates per action, retains them and verifies real ownership", async () => {
  const c = await channel();
  const db = getDb();
  for (let n = 1; n <= 123; n++) {
    const ts = `${100 + n}.000001`;
    roots.set(`${c.channelId}:${ts}`, { ts, user: n % 2 ? "U_MINE" : "U_OTHER", text: `Historical ${n}` });
    db.prepare("INSERT INTO sessions(slug,thread_key,session_id,engine,runtime) VALUES(?,?,?,?,?)").run(c.slug, ts, `session-${n}`, "codex", "{}");
  }
  const first = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(first.scanned, 100); assert.equal(first.moreHistory, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slack_threads").get().n, 100);
  assert.equal(getSlackThread(c.channelId, "123.000001"), null, "oldest candidates wait for the next action");
  assert.ok(getSlackThread(c.channelId, "124.000001"));
  const second = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(second.scanned, 23); assert.equal(second.moreHistory, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slack_threads").get().n, 123);
  reads.length = 0;
  const again = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(again.scanned, 0); assert.equal(reads.length, 0, "indexed roots are not rediscovered");
  db.exec("DELETE FROM sessions");
  assert.equal(eligibleSlackThreadsForUser("U_MINE").length, 62, "index survives legacy session cleanup");
  const view = await homeThreadsSnapshot(client, "U_MINE", { filter: "all" });
  assert.equal(view.total, 62);
  assert.ok(view.rows.every((r) => r.starter_id === "U_MINE"));
});

test("forged ownership and stale membership cannot mutate completion; valid clicks republish only the actor", async () => {
  const c = await channel("G_PRIVATE", "group");
  root(c, "100.000001"); root(c, "101.000001", "U_OTHER");
  members.set(c.channelId, ["U_MINE", "U_OTHER"]);
  let handler;
  const published = [];
  registerHomeThreadActions({ action: (_pattern, fn) => { handler = fn; } }, { publishHome: async (_client, userId) => published.push(userId) });
  let acknowledgements = 0;
  const click = (threadTs) => handler({ ack: async () => { acknowledgements++; }, body: { user: { id: "U_MINE" } },
    action: { action_id: "cg_home_threads_done", value: JSON.stringify({ channelId: c.channelId, threadTs, userId: "U_OTHER" }) }, client });
  await click("101.000001");
  assert.equal(getSlackThread(c.channelId, "101.000001").done_ms, 0);
  members.set(c.channelId, []); await click("100.000001");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
  members.set(c.channelId, ["U_MINE"]); await click("100.000001");
  assert.ok(getSlackThread(c.channelId, "100.000001").done_ms > 0);
  assert.equal(acknowledgements, 3); assert.deepEqual(published, ["U_MINE"]);
});

test("missing ownership evidence and Slack failures do not leak or invent rows", async () => {
  const c = await channel(); root(c, "100.000001");
  roots.clear();
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  root(c, "101.000001");
  client.conversations.replies = async () => { throw new Error("rate_limited"); };
  const view = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(view.rows.length, 0); assert.equal(view.unavailable, true);
});

test("a checked thread stays completed after a newer request and successful reply", async () => {
  const c = await channel();
  root(c, "100.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1 }] });
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "200.000001" });
  recordSlackThreadOutcome(c.channelId, "100.000001", { at: 201000 });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows[0].status, "done");
});

test("deleted and bot-started legacy roots cannot starve older history", async () => {
  const c = await channel();
  for (let n = 1; n <= 23; n++) {
    const ts = `${100 + n}.000001`;
    roots.set(`${c.channelId}:${ts}`, { ts, user: n < 10 ? "U_MINE" : "U_BOT", ...(n >= 10 ? { bot_id: "B_FOREIGN" } : {}) });
    getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, ts, `legacy-${n}`);
  }
  const read = client.conversations.replies;
  client.conversations.replies = async (args) => {
    if (args.ts === "123.000001") throw Object.assign(new Error("Slack API error"), { data: { error: "thread_not_found" } });
    return read(args);
  };
  await homeThreadsSnapshot(client, "U_MINE");
  await homeThreadsSnapshot(client, "U_MINE");
  const view = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(view.moreHistory, false); assert.equal(view.total, 9);
});

test("completion checks precede filtering and reconcile root events missed while offline", async () => {
  const c = await channel();
  root(c, "100.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1 }] });
  roots.get("C_THREADS:100.000001").reactions = [];
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
  roots.get("C_THREADS:100.000001").reactions = [{ name: "white_check_mark", count: 1 }];
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows[0].status, "done");
});

test("code-channel threaded execution uses the actual Slack reply target for Working", async () => {
  const c = await channel(); root(c, "100.000001");
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("code-run", toJson({ channelId: c.channelId, threadKey: "code-channel", slackThreadTs: "100.000001" }));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "working");
});

test("discovery and background outcomes cannot undo manual Done", async () => {
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  recordSlackThreadOutcome(c.channelId, "100.000001", { at: 400000 });
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "300.000001" });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
});

test("deleting the last row of a page rebuilds the clamped page instead of showing an empty list", async () => {
  const c = await channel();
  for (let n = 0; n < 11; n++) root(c, `${100 + n}.000001`);
  roots.delete("C_THREADS:100.000001");
  const view = await homeThreadsSnapshot(client, "U_MINE", { page: 1 });
  assert.equal(view.total, 10); assert.equal(view.pages, 1); assert.equal(view.page, 0); assert.equal(view.rows.length, 10);
});

test("temporary bot access loss does not permanently remove owned history", async () => {
  const c = await channel(); root(c, "100.000001");
  const read = client.conversations.replies;
  client.conversations.replies = async () => { throw Object.assign(new Error("Slack API error"), { data: { error: "not_in_channel" } }); };
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).unavailable, true);
  assert.equal(getSlackThread(c.channelId, "100.000001").starter_id, "U_MINE");
  client.conversations.replies = read;
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
});

test("Reopen wins over stale root reaction evidence discovered by the same click", async () => {
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  roots.get("C_THREADS:100.000001").reactions = [{ name: "white_check_mark", count: 1 }];
  let handler; let published;
  registerHomeThreadActions({ action: (_pattern, fn) => { handler = fn; } }, {
    publishHome: async (_client, userId, view) => { published = await homeThreadsSnapshot(client, userId, view); },
  });
  await handler({ ack: async () => {}, body: { user: { id: "U_MINE" } }, action: {
    action_id: "cg_home_threads_reopen", value: JSON.stringify({ channelId: c.channelId, threadTs: "100.000001" }),
  }, client });
  assert.equal(published.rows[0].status, "idle");
});

test("passive root reconciliation preserves explicit Reopen until a newer completion event", async () => {
  const c = await channel(); root(c, "100.000001");
  roots.get("C_THREADS:100.000001").reactions = [{ name: "white_check_mark", count: 1 }];
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false, 200000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001", reactions: [] });
  updateSlackThreadRootCompletion(c.channelId, roots.get("C_THREADS:100.000001"), { reactionAt: 300000 });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows[0].status, "done");
});

test("a newer root reaction wins regardless of a preceding passive read and an older delayed prompt", async () => {
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false, 200000);
  const checked = { ts: "100.000001", reactions: [{ name: "white_check_mark", count: 1 }] };
  updateSlackThreadRootCompletion(c.channelId, checked);
  updateSlackThreadRootCompletion(c.channelId, checked, { reactionAt: 400000 });
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "300.000001" });
  assert.equal(slackThreadStatus(getSlackThread(c.channelId, "100.000001"), new Map()), "done");
});

test("one inaccessible public channel does not block other owned threads or history", async () => {
  const gone = await channel("C_GONE"); const good = await channel("C_GOOD");
  root(gone, "100.000001"); root(good, "101.000001");
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(gone.slug, "200.000001", "gone-history");
  const read = client.conversations.replies;
  client.conversations.replies = async (args) => {
    if (args.channel === gone.channelId) throw Object.assign(new Error("Slack API error"), { data: { error: "channel_not_found" } });
    return read(args);
  };
  const view = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(view.rows.length, 1); assert.equal(view.rows[0].channel_id, good.channelId);
  assert.equal(getSlackThread(gone.channelId, "100.000001").starter_id, "U_MINE");
});

test("real persisted questions and approval requests show Waiting until resolved", async () => {
  const { createQuestion, updateQuestion } = await import("../src/gateway/questions.js");
  const { createApprovalRequest, transitionApprovalRequest } = await import("../src/gateway/approval-requests.js");
  const c = await channel(); root(c, "100.000001"); root(c, "101.000001");
  const question = createQuestion({ channelId: c.channelId, slug: c.slug, threadKey: "100.000001", authorId: "U_MINE" }, {
    title: "Choose next step", questions: [{ id: "choice", prompt: "What next?", type: "text" }],
  });
  const approval = createApprovalRequest({ id: "home-approval", actionKey: "home-approval-key", channelId: c.channelId,
    action: { channelId: c.channelId, threadKey: "101.000001", authorId: "U_MINE" } });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "waiting" })).rows.length, 2);
  updateQuestion(question.id, question.revision, { status: "cancelled" });
  transitionApprovalRequest(approval.id, "pending", "denied");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "waiting" })).rows.length, 0);
});

for (const reaction of ["+1", "thumbsup", "+1::skin-tone-3", "thumbsup::skin-tone-5"]) {
  test(`${reaction} emoji reactions leave Activity and reminder eligibility open without a root marker`, async () => {
    const { syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
    const { noteBotReply, sweepNudges } = await import("../src/gateway/nudges.js");
    const { recordActivity, buildPendingReportForUser } = await import("../src/gateway/followups.js");
    const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: reaction, count: 1 }] });
    const messages = [roots.get(`${c.channelId}:100.000001`),
      { ts: "101.000001", thread_ts: "100.000001", user: "BOT", reactions: [{ name: reaction, count: 1 }] }];
    client.conversations.replies = async () => ({ messages });
    client.reactions.get = async () => { assert.fail("thumbs-up events must not fetch completion evidence"); };
    for (const ts of ["100.000001", "101.000001"]) {
      for (const added of [true, false]) await syncThreadCompletionReaction(client,
        { reaction, event_ts: "200.000001", item: { type: "message", channel: c.channelId, ts } }, { added });
    }
    assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
    assert.equal((await activityThreadSnapshot(client, "U_MINE")).rows[0].status, "idle");
    assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows.length, 0);
    assert.deepEqual(markerCalls, []);
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "U_MINE", aiTurn: true, tsMs: 1000 });
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "BOT", isBot: true, aiTurn: true, tsMs: 2000 });
    assert.match(await buildPendingReportForUser(client, "U_MINE", "BOT", 3000), /waiting on your decision in 1 thread/);
    const map = new Map(); noteBotReply(c.channelId, c.slug, "100.000001", "U_MINE", { map, nowMs: 1000 });
    let posts = 0;
    await sweepNudges({ snapshot: () => ({ connected: true }), getClient: () => client }, {
      map, nowMs: 3000, thresholdMs: 10, loadUser: async () => ({ nudges: true }), post: async () => { posts++; }, log: async () => {},
    });
    assert.equal(posts, 1);
  });
}

for (const marker of ["white_check_mark", "heavy_check_mark", "activity", "feedback"]) {
  test(`${marker} completion on a root/reply or in Activity hides active work and suppresses both reminder paths`, async () => {
    const { noteBotReply, sweepNudges } = await import("../src/gateway/nudges.js");
    const { recordActivity, sendDigest, buildPendingReportForUser } = await import("../src/gateway/followups.js");
    const c = await channel(); const row = root(c, "100.000001");
    const messages = [roots.get("C_THREADS:100.000001"), { ts: "101.000001", user: "BOT", ...(["activity", "feedback"].includes(marker) ? {} : { reactions: [{ name: marker, count: 1 }] }) }, { ts: "102.000001", user: "BOT" }];
    client.conversations.replies = async () => ({ messages });
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: row.thread_ts, userId: "U_MINE", isBot: false, aiTurn: true, tsMs: 1000 });
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: row.thread_ts, userId: "BOT", isBot: true, aiTurn: true, tsMs: 2000 });
    if (marker === "activity") {
      let click;
      registerHomeThreadActions({ action: (_id, handler) => { click = handler; } }, { publishHome: async () => {} });
      await click({ ack: async () => {}, body: { user: { id: "U_MINE" } }, client,
        action: { action_id: "cg_home_threads_done", value: JSON.stringify({ channelId: c.channelId, threadTs: row.thread_ts }) } });
    }
    if (marker === "feedback") {
      const { registerAgentInterfaceHandlers } = await import("../src/slack/agent-interface.js");
      const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
      const { feedbackBlocks, REPLY_FEEDBACK_ACTION_ID } = await import("../src/slack/footer.js");
      const actions = new Map();
      registerAgentInterfaceHandlers({ event: () => {}, action: (id, fn) => actions.set(id, fn) }, { onPositiveFeedback: completeThreadFromFeedback });
      const value = feedbackBlocks({ channel: c.channelId, threadTs: row.thread_ts, authorId: "U_MINE" })[0].elements[0].positive_button.value;
      await actions.get(REPLY_FEEDBACK_ACTION_ID)({ ack: async () => {}, client, action: { value },
        body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: row.thread_ts } } });
    }
    getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("still-running", toJson({ channelId: c.channelId, threadKey: row.thread_ts }));
    assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
    assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "all" })).rows.length, 0);
    assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows[0].status, "done");
    await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: row.thread_ts, messageTs: "103.000001" });
    recordSlackThreadOutcome(c.channelId, row.thread_ts);
    assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
    const map = new Map(); noteBotReply(c.channelId, c.slug, row.thread_ts, "U_MINE", { map, nowMs: 1000 });
    let notifications = 0;
    client.chat.postMessage = async () => { notifications++; return { ts: "999.000001" }; };
    client.conversations.open = async () => ({ channel: { id: "D_REMINDER" } });
    await sweepNudges({ snapshot: () => ({ connected: true }), getClient: () => client }, {
      map, nowMs: 3000, thresholdMs: 10, loadUser: async () => ({ nudges: true }), post: async () => { notifications++; }, log: async () => {},
    });
    assert.equal(await sendDigest(client, "U_MINE", "BOT", 3000), 0);
    assert.match(await buildPendingReportForUser(client, "U_MINE", "BOT", 3000), /Nothing pending/);
    assert.equal(notifications, 0);
  });
}

test("compact linked rows with primary Done and genuine last-message dates survive completion and deleted replies", async () => {
  const c = await channel(); root(c, "100.000001");
  let messages = [roots.get("C_THREADS:100.000001"), { ts: "200.000001", user: "BOT" }, { ts: "300.000001", user: "BOT" }];
  client.conversations.replies = async () => ({ messages });
  recordSlackThreadOutcome(c.channelId, "100.000001", { at: 900000 });
  let view = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(view.rows[0].last_message_ms, 300000);
  const blocks = homeThreadBlocks(view);
  const entry = blocks.find((b) => b.accessory?.action_id === "cg_home_threads_done");
  assert.equal(entry.accessory.style, "primary");
  assert.ok(entry.text.text.includes("<!date^300^"));
  assert.ok(entry.text.text.includes(`<${view.rows[0].url}|`));
  assert.equal(entry.text.text.split("\n").length, 2);
  assert.equal(entry.fields, undefined);
  assert.ok(!blocks.some((b) => b.type === "actions" && b.elements.some((e) => ["cg_home_threads_done", "cg_home_threads_open"].includes(e.action_id))));
  assert.ok(blocks.filter((b) => b.type === "divider").length >= 2);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  messages = messages.slice(0, 2);
  view = await homeThreadsSnapshot(client, "U_MINE", { filter: "done" });
  assert.equal(view.rows[0].last_message_ms, 200000, "complete scan corrects a deleted last message; Done/outcome time never becomes the date");
});

test("last-message date follows a fully paginated Slack transcript", async () => {
  const c = await channel(); root(c, "100.000001");
  client.conversations.replies = async ({ cursor }) => cursor
    ? { messages: [{ ts: "400.000001", user: "BOT" }] }
    : { messages: [roots.get("C_THREADS:100.000001")], has_more: true, response_metadata: { next_cursor: "page-two" } };
  const view = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(view.rows[0].last_message_ms, 400000);
});

for (const boundary of ["permalink", "dm-open"]) {
  test(`Done during digest ${boundary} prevents the notification`, async () => {
    const { recordActivity, sendDigest } = await import("../src/gateway/followups.js");
    const c = await channel(); root(c, "100.000001");
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "U_MINE", isBot: false, aiTurn: true, tsMs: 1000 });
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "BOT", isBot: true, aiTurn: true, tsMs: 2000 });
    const complete = () => setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
    let sent = 0;
    client.chat.postMessage = async () => { sent++; return { ts: "999.000001" }; };
    client.chat.getPermalink = async () => { if (boundary === "permalink") complete(); return { permalink: "https://example.slack.com/thread" }; };
    client.conversations.open = async () => { if (boundary === "dm-open") complete(); return { channel: { id: "D_REMINDER" } }; };
    assert.equal(await sendDigest(client, "U_MINE", "BOT", 3000), 0);
    assert.equal(sent, 0);
  });
}

test("pending verification reconciles a completion reaction removed while offline", async () => {
  const { recordActivity, buildPendingReportForUser } = await import("../src/gateway/followups.js");
  const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1 }] });
  roots.get("C_THREADS:100.000001").reactions = [];
  recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "U_MINE", isBot: false, aiTurn: true, tsMs: 1000 });
  recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: "100.000001", userId: "BOT", isBot: true, aiTurn: true, tsMs: 2000 });
  assert.match(await buildPendingReportForUser(client, "U_MINE", "BOT", 3000), /waiting on your decision in 1 thread/);
});

test("upgrading v44 discards obsolete prompt reopening markers and preserves manual Done", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { migrations } = await import("../src/db/migrations.js");
  const old = new DatabaseSync(":memory:");
  try {
    old.exec("CREATE TABLE slack_threads(id TEXT,done_ms INTEGER,root_done INTEGER); INSERT INTO slack_threads VALUES('old-prompt',-200000,1),('manual',300000,0)");
    migrations.find((m) => m.version === 45).up(old);
    const rows = old.prepare("SELECT * FROM slack_threads ORDER BY id").all();
    assert.equal(rows.find((r) => r.id === "old-prompt").done_ms, 0);
    assert.equal(slackThreadStatus(rows.find((r) => r.id === "old-prompt"), new Map()), "done");
    assert.equal(rows.find((r) => r.id === "manual").done_ms, 300000);
  } finally { old.close(); }
});

test("root/reply completion events agree, preserve other markers and honor explicit Reopen", async () => {
  const { syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get("C_THREADS:100.000001"), { ts: "101.000001", thread_ts: "100.000001", user: "BOT", reactions: [{ name: "heavy_check_mark", count: 1 }] }];
  client.conversations.replies = async () => ({ messages });
  client.reactions = { ...client.reactions, get: async ({ timestamp }) => ({ message: messages.find((m) => m.ts === timestamp) }) };
  const event = (ts, reaction, eventTs) => ({ item: { type: "message", channel: c.channelId, ts }, reaction, event_ts: eventTs });
  await syncThreadCompletionReaction(client, event("101.000001", "heavy_check_mark", "200.000001"), { added: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  messages[0].reactions = [{ name: "white_check_mark", count: 1 }];
  messages[1].reactions = [];
  await syncThreadCompletionReaction(client, event("101.000001", "heavy_check_mark", "201.000001"));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0, "remaining root check still completes work");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false, 300000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  messages[1].reactions = [{ name: "heavy_check_mark", count: 1 }];
  await syncThreadCompletionReaction(client, event("101.000001", "heavy_check_mark", "400.000001"), { added: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  messages[0].reactions = []; messages[1].reactions = [];
  await syncThreadCompletionReaction(client, event("100.000001", "white_check_mark", "401.000001"));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadCompletionReaction(client, event("101.000001", "heavy_check_mark", "402.000001"));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0, "manual Done survives reaction removal");
});

test("temporary membership failures hide private rows and request automatic retry until access can be verified", async () => {
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001");
  client.conversations.members = async () => { throw new Error("temporary membership API failure"); };
  const unavailable = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(unavailable.rows.length, 0); assert.equal(unavailable.unavailable, true);
  client.conversations.members = async () => ({ members: ["U_MINE"] });
  const recovered = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(recovered.rows.length, 1); assert.equal(recovered.unavailable, false);
  client.conversations.members = async () => ({ members: [] });
  const revoked = await homeThreadsSnapshot(client, "U_MINE");
  assert.equal(revoked.rows.length, 0); assert.equal(revoked.unavailable, false, "verified nonmembership stays denied without retry");
});

test("automatic refresh keys follow owned lifecycle/completion/message state without Slack history calls", async () => {
  const c = await channel(); root(c, "100.000001");
  let key = homeThreadsRefreshKey("U_MINE");
  const change = () => {
    const next = homeThreadsRefreshKey("U_MINE"); assert.notEqual(next, key); key = next;
  };
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("refresh-run", toJson({ channelId: c.channelId, threadKey: "100.000001" }));
  change();
  getDb().prepare("DELETE FROM active_runs").run(); change();
  recordSlackThreadOutcome(c.channelId, "100.000001", { error: true }); change();
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: true }); change();
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false); change();
  await trackSlackThread(client, { channelId: c.channelId, slug: c.slug, threadKey: "100.000001", messageTs: "200.000001" }); change();
  root(c, "300.000001", "U_OTHER");
  assert.equal(homeThreadsRefreshKey("U_MINE"), key, "another owner's threads cannot affect this viewer");
  getDb().prepare("UPDATE slack_threads SET checked_ms=checked_ms+1").run();
  assert.equal(homeThreadsRefreshKey("U_MINE"), key, "passive verification does not trigger a refresh loop");
  assert.equal(reads.length, 0);
});

test("cold visible pages verify four rows concurrently and repeated pages need no transcript/link calls", async () => {
  const c = await channel(); for (let n = 0; n < 10; n++) root(c, `${100+n}.000001`);
  let active = 0, peak = 0, transcripts = 0, links = 0;
  const work = async (value) => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setImmediate(resolve)); active--; return value; };
  client.conversations.replies = ({ channel, ts }) => { transcripts++; return work({ messages: [roots.get(`${channel}:${ts}`)] }); };
  client.chat.getPermalink = ({ message_ts }) => { links++; return work({ permalink: `https://example.slack.com/${message_ts}` }); };
  const options = { reader: createHomeThreadReader(), discover: false, reconcile: false };
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", {}, options)).rows.length, 10);
  assert.equal(peak, 4); assert.equal(transcripts, 10); assert.equal(links, 10);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", {}, options)).rows.length, 10);
  assert.equal(transcripts, 10); assert.equal(links, 10);
});

test("fast navigation reuses Slack evidence while checking current membership and gateway access afresh", async () => {
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001"); members.set(c.channelId, ["U_MINE"]);
  const reader = createHomeThreadReader(); const options = { reader, discover: false, reconcile: false };
  const first = await homeThreadsSnapshot(client, "U_MINE", {}, options);
  assert.equal(first.rows.length, 1); const count = reads.length;
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", {}, options)).rows.length, 1);
  assert.equal(reads.length, count, "repeated navigation does not rescan transcripts");
  members.set(c.channelId, []);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", {}, options)).rows.length, 0);
  members.set(c.channelId, ["U_MINE"]); await saveChannelMeta(c.slug, { access: "none" });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", {}, options)).rows.length, 0);
});

test("fast navigation skips history discovery and forced Refresh bypasses cached evidence", async () => {
  const c = await channel(); root(c, "100.000001");
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id,engine,runtime) VALUES(?,?,?,?,?)")
    .run(c.slug, "200.000001", "historical", "codex", "{}");
  roots.set(`${c.channelId}:200.000001`, { ts: "200.000001", user: "U_MINE", text: "Older tracked task" });
  const reader = createHomeThreadReader(); const options = { reader, discover: false, reconcile: false };
  const first = await homeThreadsSnapshot(client, "U_MINE", {}, options);
  assert.equal(first.moreHistory, true); assert.equal(first.total, 1);
  assert.ok(reads.every((key) => key.endsWith("100.000001")));
  roots.get(`${c.channelId}:100.000001`).reactions = [{ name: "white_check_mark", count: 1 }];
  const refreshed = await homeThreadsSnapshot(client, "U_MINE", {}, { reader, discover: true, reconcile: true, force: true });
  assert.equal(refreshed.rows.length, 1); assert.equal(refreshed.rows[0].thread_ts, "200.000001");
  assert.equal(getSlackThread(c.channelId, "100.000001").root_done, 1);
});

test("Refresh and Load older request one-shot full reads without changing the selected filter/page", async () => {
  let handler; const states = [];
  registerHomeThreadActions({ action: (_id, fn) => { handler = fn; } }, { publishHome: async (_c, _u, state) => states.push(state) });
  for (const action of ["refresh", "history"]) await handler({ ack: async () => {}, body: { user: { id: "U_MINE" } }, client,
    action: { action_id: `cg_home_threads_${action}`, value: JSON.stringify({ filter: "idle", page: 2 }) } });
  assert.ok(states.every((state) => state.forceThreads && state.discoverThreads && state.filter === "idle" && state.page === 2));
});

test("a stale full inspection cannot undo a newer completion or message-date observation", async () => {
  const c = await channel(); root(c, "100.000001");
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: true, lastMessageMs: 300000, inspectedAt: 400000 });
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: false, lastMessageMs: 200000, inspectedAt: 350000 });
  const row = getSlackThread(c.channelId, "100.000001");
  assert.equal(row.root_done, 1); assert.equal(row.last_message_ms, 300000);
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: true, lastMessageMs: 200000, inspectedAt: 500000 });
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: false, lastMessageMs: 300000, inspectedAt: 450000 });
  const afterDeletion = getSlackThread(c.channelId, "100.000001");
  assert.equal(afterDeletion.root_done, 1); assert.equal(afterDeletion.last_message_ms, 200000);
});

for (const partialMessage of [false, true]) test(`native positive feedback cannot forge thread ownership or retain revoked private/sudo access (partial message: ${partialMessage})`, async () => {
  const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001");
  const body = { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } };
  if (partialMessage) {
    body.container = { channel_id: c.channelId, message_ts: body.message.ts };
    delete body.message.ts;
  }
  const parsed = { verdict: "up", channel: c.channelId, threadTs: "100.000001" };
  members.set(c.channelId, ["U_MINE"]);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed: { ...parsed, threadTs: "999.000001" } }), false);
  assert.equal(await completeThreadFromFeedback({ client, body: { ...body, message: undefined }, parsed }), false,
    "container timestamp alone cannot prove the target thread");
  assert.equal(await completeThreadFromFeedback({ client, body: { ...body, user: { id: "U_OTHER" } }, parsed }), false);
  members.set(c.channelId, []);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), false);
  members.set(c.channelId, ["U_MINE"]);
  await setThreadSudo(c.slug, "100.000001", true);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), false);
  await setThreadSudo(c.slug, "100.000001", false);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed: { ...parsed, verdict: "down" } }), false);
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
  assert.equal(markerCalls.length, 0, "rejected feedback must never add a marker");
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), true);
  assert.deepEqual(markerCalls, [
    ["add", { channel: c.channelId, timestamp: "100.000001", name: "white_check_mark" }],
    ["add", { channel: c.channelId, timestamp: "101.000001", name: "white_check_mark" }],
  ]);
});


test("ordinary human follow-ups and foreign bots never become agent candidates, even with polluted index rows", async () => {
  const { recordActivity } = await import("../src/gateway/followups.js");
  const c = await channel();
  for (const [ts, isBot] of [["100.000001", false], ["101.000001", true]]) {
    const message = { ts, user: "U_MINE", text: "Ordinary conversation" };
    roots.set(`${c.channelId}:${ts}`, message);
    recordActivity({ channelId: c.channelId, slug: c.slug, threadTs: ts, userId: isBot ? "B_OTHER" : "U_MINE", isBot, aiTurn: false, tsMs: 1000 });
    indexSlackThread({ channelId: c.channelId, slug: c.slug, root: message });
  }
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, "100.000001", "");
  // Shell activity and unrelated completion marks are not proof of an agent conversation.
  getDb().prepare("INSERT INTO bg_jobs(id,data) VALUES(?,?)").run("shell", toJson({ channelId: c.channelId, threadKey: "100.000001", kind: "shell" }));
  setSlackThreadDone(c.channelId, "101.000001", "U_MINE", true);
  assert.deepEqual(slackThreadCandidates([c]), []);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "all" })).total, 0);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "done" })).total, 0);
  assert.equal(reads.length, 0, "polluted human-only rows do not even trigger Slack root reads");
  assert.equal(getSlackThread(c.channelId, "100.000001").agent_engaged, 0);
});

test("genuine gateway evidence repairs legacy index rows and remains durable after evidence cleanup and restart", async () => {
  const c = await channel();
  const db = getDb();
  const timestamps = ["100.000001", "101.000001", "102.000001", "103.000001"];
  for (const ts of timestamps) indexSlackThread({ channelId: c.channelId, slug: c.slug, root: { ts, user: "U_MINE", text: "Legacy task" } });
  db.prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, timestamps[0], "real-session");
  db.prepare("INSERT INTO followup_threads(thread_key,data) VALUES(?,?)").run("gateway-followup", toJson({ channelId: c.channelId, threadTs: timestamps[1], aiInvolved: true }));
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("queued", toJson({ channelId: c.channelId, threadKey: "code-channel", slackThreadTs: timestamps[2] }));
  db.prepare("INSERT INTO bg_jobs(id,data) VALUES(?,?)").run("agent", toJson({ channelId: c.channelId, threadKey: `${timestamps[3]}::agent-one`, kind: "agent" }));
  assert.equal(eligibleSlackThreadsForUser("U_MINE").length, 4);
  for (const ts of timestamps) assert.equal(getSlackThread(c.channelId, ts).agent_engaged, 1);
  for (const table of ["sessions", "followup_threads", "active_runs", "bg_jobs"]) db.exec(`DELETE FROM ${table}`);
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { eligibleSlackThreadsForUser } from "./src/gateway/slack-threads.js"; process.stdout.write(JSON.stringify(eligibleSlackThreadsForUser("U_MINE").map(r => r.thread_ts)));'],
  { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output).sort(), timestamps);
});

test("gateway-only follow-up discovery excludes ordinary history and preserves eligibility after discovery", async () => {
  const c = await channel();
  for (const [ts, aiInvolved] of [["100.000001", false], ["101.000001", true]]) {
    roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", text: "Thread" });
    getDb().prepare("INSERT INTO followup_threads(thread_key,data) VALUES(?,?)").run(ts, toJson({ channelId: c.channelId, threadTs: ts, aiInvolved }));
  }
  assert.deepEqual(slackThreadCandidates([c]).map((row) => row.threadTs), ["101.000001"]);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  getDb().exec("DELETE FROM followup_threads");
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).rows[0].thread_ts, "101.000001");
});

test("local Activity snapshots paginate and search without any Slack history or permalink calls", async () => {
  const c = await channel();
  for (let n = 0; n < 12; n++) root(c, `${100 + n}.000001`, "U_MINE", { text: n < 3 ? `Findable ${n}` : `Task ${n}` });
  root(c, "200.000001", "U_OTHER");
  client.conversations.replies = () => { throw new Error("must not read transcript"); };
  client.chat.getPermalink = () => { throw new Error("must not resolve links"); };
  const first = await activityThreadSnapshot(client, "U_MINE", { pageSize: 5 });
  const last = await activityThreadSnapshot(client, "U_MINE", { pageSize: 5, page: 99 });
  const search = await activityThreadSnapshot(client, "U_MINE", { search: "FINDABLE" });
  assert.equal(first.total, 12); assert.equal(first.rows.length, 5);
  assert.equal(last.page, 2); assert.equal(last.rows.length, 2);
  assert.equal(search.total, 3); assert.equal(search.unavailable, false);
  assert.ok(first.rows.every((row) => row.channelName && row.last_message_ms && row.status === "idle" && !row.url));
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "done" })).total, 1);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "all-statuses" })).total, 12);
});

test("local Activity snapshots freshly enforce private membership, user demotion, sudo, and gateway revocation", async () => {
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001");
  await setUser("U_MINE", { isAdmin: true });
  let snapshot = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(snapshot.total, 0); assert.equal(snapshot.unavailable, true);
  members.set(c.channelId, ["U_MINE"]);
  await setThreadSudo(c.slug, "100.000001", true);
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 1);
  await setUser("U_MINE", { isAdmin: false });
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
  await setThreadSudo(c.slug, "100.000001", false);
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 1);
  members.set(c.channelId, []);
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
  members.set(c.channelId, ["U_MINE"]);
  await saveChannelMeta(c.slug, { access: "none" });
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
  await patchChannelMeta(c.slug, { access: "approved", archived: true });
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
});

test("local Activity snapshots cap visible data and flag partial results", async () => {
  const c = await channel();
  const insert = getDb().prepare("INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,last_message_ms,agent_engaged) VALUES(?,?,?,?,?,?,?,1)");
  for (let n = 0; n < 1001; n++) insert.run(c.channelId, `${100 + n}.000001`, c.slug, "U_MINE", "Task", n, n);
  const snapshot = await activityThreadSnapshot(client, "U_MINE", { pageSize: 10000 });
  assert.equal(snapshot.total, 1000); assert.equal(snapshot.rows.length, 1000);
  assert.equal(snapshot.truncated, true); assert.equal(snapshot.pages, 1);
  const pin = JSON.stringify([c.channelId, "100.000001"]);
  const withPin = await activityThreadSnapshot(client, "U_MINE", { filter: "all-statuses", pageSize: 1000, pinnedThreads: [pin] });
  assert.equal(withPin.rows.length, 1001);
  assert.equal(withPin.rows.some((row) => row.thread_ts === "100.000001"), true, "old saved pins survive the ordinary history cap");
  assert.equal(new Set(withPin.rows.map((row) => row.thread_ts)).size, withPin.rows.length);
  const channelPin = await activityThreadSnapshot(client, "U_MINE", { filter: "all-statuses", pageSize: 1000, pinnedChannels: [c.channelId] });
  assert.equal(channelPin.rows.length, 1001, "all open threads in a pinned channel survive the feed cap");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  const completed = await activityThreadSnapshot(client, "U_MINE", { filter: "all-statuses", pageSize: 1, pinnedChannels: [c.channelId] });
  assert.equal(completed.rows.length, 1000);
  assert.equal(completed.rows.some((row) => row.thread_ts === "100.000001"), false, "channel pins do not retain completed history outside the page");
});

test("thread changes emit scoped invalidations and passive checks do not loop", async () => {
  const { onThreadChanged } = await import("../src/gateway/thread-changes.js");
  const { recordSlackThreadMessage } = await import("../src/gateway/slack-threads.js");
  const c = await channel(); const notifications = [];
  const unsubscribe = onThreadChanged((event) => notifications.push(event));
  try {
    root(c, "100.000001");
    recordSlackThreadMessage(c.channelId, "100.000001", "101.000001");
    setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
    recordSlackThreadOutcome(c.channelId, "100.000001", { at: 300000 });
    const count = notifications.length;
    updateSlackThreadRootCompletion(c.channelId, roots.get(`${c.channelId}:100.000001`));
    assert.equal(notifications.length, count, "checked_ms alone is not a display change");
    assert.equal(count, 4);
    assert.ok(notifications.every((event) => event.channelId === c.channelId && event.threadTs === "100.000001"));
  } finally { unsubscribe(); }
  recordSlackThreadMessage(c.channelId, "100.000001", "400.000001");
  assert.equal(notifications.length, 4);
});

test("Activity shows live resumed completed work while Home and completion markers remain completed", async () => {
  const c = await channel(); const thread = root(c, "100.000001");
  setSlackThreadDone(c.channelId, thread.thread_ts, "U_MINE", true);
  const initialKey = homeThreadsRefreshKey("U_MINE");
  const active = getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)");
  active.run("resumed-completed", toJson({ channelId: c.channelId, slackThreadTs: thread.thread_ts, threadKey: "code-channel", authorId: "U_MINE" }));
  const workingKey = homeThreadsRefreshKey("U_MINE");
  assert.notEqual(workingKey, initialKey, "live work invalidates refresh even when Home still considers the thread complete");
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "working" })).rows[0]?.status, "working");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "done" })).rows[0]?.status, "done");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "active" })).rows.length, 0);
  getDb().prepare("UPDATE active_runs SET data=? WHERE id=?").run(toJson({ channelId: c.channelId, threadKey: thread.thread_ts, awaitingChoice: true }), "resumed-completed");
  const waitingKey = homeThreadsRefreshKey("U_MINE");
  assert.notEqual(waitingKey, workingKey);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "waiting" })).rows[0]?.status, "waiting");
  getDb().prepare("DELETE FROM active_runs WHERE id=?").run("resumed-completed");
  assert.notEqual(homeThreadsRefreshKey("U_MINE"), waitingKey);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "done" })).rows[0]?.status, "done");
  assert.ok(getSlackThread(c.channelId, thread.thread_ts).done_ms > 0, "live display never clears durable completion");
});

test("Activity repairs missing live roots using the actual human starter rather than the run author", async () => {
  const c = await channel();
  roots.set(`${c.channelId}:100.000001`, { ts: "100.000001", user: "U_OTHER", text: "Another person's task" });
  roots.set(`${c.channelId}:101.000001`, { ts: "101.000001", user: "U_MINE", bot_id: "B_FOREIGN", text: "Foreign bot" });
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("missing-live", toJson({ channelId: c.channelId, slug: c.slug, authorId: "U_MINE", threadKey: "code-channel", slackThreadTs: "100.000001" }));
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("foreign-bot", toJson({ channelId: c.channelId, slug: c.slug, authorId: "U_MINE", threadKey: "101.000001" }));
  const originalReplies = client.conversations.replies;
  client.conversations.replies = (request) => { assert.equal(request.limit, 1); return originalReplies(request); };
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
  const owned = await activityThreadSnapshot(client, "U_OTHER");
  assert.equal(owned.rows.length, 1);
  assert.equal(owned.rows[0].thread_ts, "100.000001");
  assert.equal(owned.rows[0].status, "working");
  assert.equal(getSlackThread(c.channelId, "100.000001").starter_id, "U_OTHER");
  assert.equal(getSlackThread(c.channelId, "101.000001")?.starter_id || "", "", "a bot root can never become the author's personal work");
});

test("bot-started live threads do not warn or starve older human threads across refreshes", async () => {
  const c = await channel(); root(c, "100.000001");
  const insert = getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)");
  roots.set(`${c.channelId}:101.000001`, { ts: "101.000001", user: "U_MINE", text: "Older human work" });
  insert.run("human", toJson({ channelId: c.channelId, slug: c.slug, threadKey: "101.000001" }));
  for (let n = 0; n < 12; n++) {
    const ts = `${102 + n}.000001`;
    roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", bot_id: "B_AUTOMATION", text: "Automation" });
    insert.run(`bot-${n}`, toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
  }
  const first = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(first.unavailable, false, "successful bot reads are exclusions, not lookup failures");
  assert.equal(first.total, 1);
  assert.equal(reads.length, 10, "root repair still obeys its per-snapshot bound");
  const second = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(second.unavailable, false);
  assert.deepEqual(second.rows.map((row) => row.thread_ts), ["101.000001", "100.000001"]);
  assert.equal(reads.length, 13, "known bot roots cannot starve the remaining human root");
  await activityThreadSnapshot(client, "U_MINE");
  assert.equal(reads.length, 13, "excluded bot roots are not fetched again while their runs remain active");
});

test("failed live root reads still warn and recover on a later successful read", async () => {
  const c = await channel(); root(c, "100.000001");
  const ts = "101.000001";
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("failed-root", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
  const replies = client.conversations.replies;
  client.conversations.replies = async () => { throw new Error("Slack unavailable"); };
  let now = Date.now();
  const failed = await activityThreadSnapshot(client, "U_MINE", {}, { now: () => now });
  assert.equal(failed.unavailable, true);
  assert.equal(failed.total, 1);
  assert.equal(getSlackThread(c.channelId, ts), null, "a failed request must remain retryable");
  roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", text: "Recovered work" });
  client.conversations.replies = replies;
  now += 15_001;
  const recovered = await activityThreadSnapshot(client, "U_MINE", {}, { now: () => now });
  assert.equal(recovered.unavailable, false);
  assert.equal(recovered.total, 2);
});

test("bot-root exclusion rechecks private membership after fetching the root", async () => {
  const c = await channel("G_PRIVATE", "group");
  members.set(c.channelId, ["U_MINE"]);
  const ts = "101.000001";
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("revoked-bot", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
  client.conversations.replies = async () => {
    members.set(c.channelId, []);
    return { messages: [{ ts, user: "U_MINE", bot_id: "B_AUTOMATION", text: "Automation" }] };
  };
  const snapshot = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(snapshot.total, 0);
  assert.equal(getSlackThread(c.channelId, ts), null, "revoked access must prevent discovery writes");
});

test("Activity missing-root repair checks current channel, private membership and sudo access before any root fetch", async () => {
  const privateChannel = await channel("G_PRIVATE", "group");
  const sudoChannel = await channel("C_SUDO");
  const deniedChannel = await channel("C_DENIED", "channel", { access: "none" });
  const insert = getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)");
  for (const [entry, ts] of [[privateChannel, "100.000001"], [sudoChannel, "101.000001"], [deniedChannel, "102.000001"]]) {
    roots.set(`${entry.channelId}:${ts}`, { ts, user: "U_MINE", text: "Private work" });
    insert.run(entry.channelId, toJson({ channelId: entry.channelId, slug: entry.slug, threadKey: ts, authorId: "U_MINE" }));
  }
  members.set(privateChannel.channelId, []);
  await setThreadSudo(sudoChannel.slug, "101.000001", true);
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0);
  assert.equal(reads.length, 0, "unauthorized live roots never trigger Slack content reads");
  members.set(privateChannel.channelId, ["U_MINE"]);
  const allowed = await activityThreadSnapshot(client, "U_MINE");
  assert.deepEqual(allowed.rows.map((row) => row.thread_ts), ["100.000001"]);
  assert.deepEqual(reads, [`${privateChannel.channelId}:100.000001`]);
  members.set(privateChannel.channelId, []);
  assert.equal((await activityThreadSnapshot(client, "U_MINE")).total, 0, "repair never caches authorization");
});

test("Activity retries transient missing-root failures after fifteen seconds without repeated Slack calls", async () => {
  const c = await channel(); const ts = "100.000001";
  roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", text: "A live task" });
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("retry-live", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts, authorId: "U_MINE" }));
  let clock = 1_000_000, attempts = 0;
  const originalReplies = client.conversations.replies;
  client.conversations.replies = async (request) => {
    attempts++;
    if (attempts === 1) throw new Error("temporary Slack failure");
    return originalReplies(request);
  };
  const options = { now: () => clock };
  assert.equal((await activityThreadSnapshot(client, "U_MINE", {}, options)).total, 0);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", {}, options)).total, 0);
  clock += 14_999;
  assert.equal((await activityThreadSnapshot(client, "U_MINE", {}, options)).total, 0);
  assert.equal(attempts, 1);
  clock++;
  assert.equal((await activityThreadSnapshot(client, "U_MINE", {}, options)).rows[0]?.status, "working");
  assert.equal(attempts, 2);
  await activityThreadSnapshot(client, "U_MINE", {}, options);
  assert.equal(attempts, 2, "an indexed root remains entirely local on refresh");
});

test("Activity coalesces concurrent missing live root lookups for the same Slack client", async () => {
  const c = await channel(); const ts = "100.000001";
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("concurrent-live", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
  let release, lookups = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  client.conversations.replies = async () => { lookups++; await gate; return { messages: [{ ts, user: "U_MINE", text: "Live work" }] }; };
  const pending = [activityThreadSnapshot(client, "U_MINE"), activityThreadSnapshot(client, "U_MINE")];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(pending);
  assert.equal(lookups, 1);
  assert.ok(results.every((snapshot) => snapshot.rows[0]?.status === "working"));
});

for (const revoke of ["membership", "admission", "admin"]) {
  test(`Activity rechecks ${revoke} after a delayed missing-root read`, async () => {
    const c = await channel("G_PRIVATE", "group"); const ts = "100.000001";
    members.set(c.channelId, ["U_MINE"]);
    if (revoke === "admin") {
      await setUser("U_MINE", { approved: true, isAdmin: true });
      await setThreadSudo(c.slug, ts, true);
      await setThreadSudo(c.slug, "99.000001", true);
    }
    getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("delayed-live", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
    getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("later-live", toJson({ channelId: c.channelId, slug: c.slug, threadKey: "99.000001" }));
    let rootReads = 0;
    client.conversations.replies = async () => {
      rootReads++;
      if (revoke === "membership") members.set(c.channelId, []);
      else await setUser("U_MINE", { approved: revoke === "admin", isAdmin: false });
      return { messages: [{ ts, user: "U_MINE", text: "Revoked private work" }] };
    };
    const result = await activityThreadSnapshot(client, "U_MINE");
    assert.equal(result.total, 0);
    assert.equal(getSlackThread(c.channelId, ts), null);
    assert.equal(rootReads, 1, "later roots must not reuse access from before the revocation");
  });
}

test("a stalled live-root lookup cannot block indexed rows or start duplicate requests", async () => {
  const c = await channel(); root(c, "100.000001");
  const ts = "101.000001";
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("slow-live", toJson({ channelId: c.channelId, slug: c.slug, threadKey: ts }));
  let release, lookups = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  client.conversations.replies = async () => {
    lookups++; await gate;
    return { messages: [{ ts, user: "U_MINE", text: "Slow live root" }] };
  };
  const options = { rootReadBudgetMs: 10 };
  for (let n = 0; n < 2; n++) {
    const snapshot = await activityThreadSnapshot(client, "U_MINE", {}, options);
    assert.deepEqual(snapshot.rows.map((row) => row.thread_ts), ["100.000001"]);
    assert.equal(snapshot.unavailable, true);
  }
  assert.equal(lookups, 1);
  release(); await new Promise((resolve) => setImmediate(resolve));
  const recovered = await activityThreadSnapshot(client, "U_MINE", {}, options);
  assert.equal(recovered.rows[0].thread_ts, ts);
  assert.equal(recovered.rows[0].status, "working");
  assert.equal(lookups, 1, "consume the completed request instead of fetching again");
});

test("Activity bounds missing live-root repair and discovers agent jobs but never shell-only jobs", async () => {
  const c = await channel();
  const insert = getDb().prepare("INSERT INTO bg_jobs(id,data) VALUES(?,?)");
  for (let n = 0; n < 12; n++) {
    const ts = `${100 + n}.000001`;
    roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", text: `Worker ${n}` });
    insert.run(`agent-${n}`, toJson({ channelId: c.channelId, slug: c.slug, threadKey: `${ts}::agent-${n}`, kind: "agent" }));
  }
  const shellTs = "999.000001";
  roots.set(`${c.channelId}:${shellTs}`, { ts: shellTs, user: "U_MINE", text: "Shell only" });
  insert.run("shell", toJson({ channelId: c.channelId, slug: c.slug, threadKey: shellTs, kind: "shell" }));
  const first = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(reads.length, 10, "one snapshot repairs no more than ten roots");
  assert.equal(first.rows.length, 10);
  const second = await activityThreadSnapshot(client, "U_MINE");
  assert.equal(reads.length, 12);
  assert.equal(second.rows.length, 12);
  assert.ok(second.rows.every((row) => row.status === "working"));
  assert.equal(getSlackThread(c.channelId, shellTs), null);
  await activityThreadSnapshot(client, "U_MINE");
  assert.equal(reads.length, 12, "indexed rows and shell-only jobs cause no further Slack reads");
});


test("Slack renames survive root refreshes, reject old deliveries, and update Activity search locally", async (t) => {
  const c = await channel();
  const original = root(c, "100.000001");
  root(c, "101.000001");
  const beforeKey = homeThreadsRefreshKey("U_MINE");
  const { onThreadChanged } = await import("../src/gateway/thread-changes.js");
  const hints = []; t.after(onThreadChanged((hint) => hints.push(hint)));
  const rename = (title, eventTs = "200.000002") => renameSlackThread({ channelId: c.channelId, threadTs: original.thread_ts, title, eventTs });
  assert.equal(rename("  A custom trip title  "), true);
  assert.notEqual(homeThreadsRefreshKey("U_MINE"), beforeKey);
  assert.equal(rename("Old title", "200.000001"), false, "out-of-order events cannot undo the latest rename");
  assert.equal(rename("Retry with same timestamp"), false);
  assert.equal(rename("A custom trip title", "201.000001"), true, "same-title events still advance the watermark");
  assert.equal(rename("Delayed intermediate title", "200.999999"), false);
  assert.deepEqual(hints, [{ channelId: c.channelId, threadTs: original.thread_ts }]);
  indexSlackThread({ channelId: c.channelId, slug: c.slug, root: { ts: original.thread_ts, user: "U_MINE", text: "Edited original message" } });
  const current = getSlackThread(c.channelId, original.thread_ts);
  assert.equal(current.title, "A custom trip title");
  for (const field of ["starter_id", "updated_ms", "last_message_ms", "done_ms", "agent_engaged"]) assert.equal(current[field], original[field], `${field} unchanged`);
  assert.equal(getSlackThread(c.channelId, "101.000001").title, "Task 101.000001");
  const snapshot = await activityThreadSnapshot(client, "U_MINE", { search: "custom trip" });
  assert.deepEqual(snapshot.rows.map((r) => r.title), ["A custom trip title"]);
  assert.deepEqual(reads, [], "rename and Activity search never query Slack history");
  assert.equal((await activityThreadSnapshot(client, "U_OTHER", { search: "custom trip" })).total, 0);
});

test("renames ignore unknown/tombstoned roots and malformed or empty metadata", async () => {
  const c = await channel(); root(c, "100.000001");
  const valid = { channelId: c.channelId, threadTs: "100.000001", title: "New name", eventTs: "200.000001" };
  for (const change of [{ channelId: "" }, { threadTs: "" }, { threadTs: "sched-task" }, { eventTs: "bad" }, { eventTs: "0.0" }, { title: "   " }, { title: {} }, { threadTs: "999.000001" }, { channelId: "C_OTHER" }]) {
    assert.equal(renameSlackThread({ ...valid, ...change }), false);
  }
  assert.equal(getSlackThread(c.channelId, "100.000001").title, "Task 100.000001");
  assert.equal(getSlackThread(c.channelId, "999.000001"), null);
  getDb().prepare("UPDATE slack_threads SET starter_id='' WHERE channel_id=?").run(c.channelId);
  assert.equal(renameSlackThread(valid), false);
});

function markerFixture(messages) {
  client.conversations.replies = async () => ({ messages });
  const reaction = (method) => async (args) => {
    markerCalls.push([method, args]);
    const root = messages.find((message) => message.ts === args.timestamp);
    assert.ok(root, "marker must target an existing message");
    const current = root.reactions?.find((r) => r.name === args.name);
    if (method === "add") {
      if (current?.users?.includes("B_GATEWAY")) throw Object.assign(new Error("duplicate"), { data: { error: "already_reacted" } });
      if (current) { current.count++; current.users.push("B_GATEWAY"); }
      else (root.reactions ||= []).push({ name: args.name, count: 1, users: ["B_GATEWAY"] });
    } else if (current?.users?.includes("B_GATEWAY")) {
      current.count--; current.users = current.users.filter((u) => u !== "B_GATEWAY");
    } else return { ok: false, error: "no_reaction" };
    return { ok: true };
  };
  client.reactions = { get: async ({ timestamp }) => ({ message: messages.find((m) => m.ts === timestamp) }),
    add: reaction("add"), remove: reaction("remove") };
}

test("native thumbs-up checks the liked answer once and its decoration cannot re-complete reopened work", async () => {
  const { completeThreadFromFeedback, syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
  const { threadHasCompletionReaction } = await import("../src/gateway/thread-completion.js");
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`),
    { ts: "101.000001", thread_ts: "100.000001", user: "B_GATEWAY" },
    { ts: "102.000001", thread_ts: "100.000001", user: "B_GATEWAY" }];
  markerFixture(messages);
  const input = { client, body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: messages[1] },
    parsed: { verdict: "up", channel: c.channelId, threadTs: "100.000001" } };
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.equal(await completeThreadFromFeedback(input), true);
  for (const message of messages.slice(0, 2)) assert.deepEqual(message.reactions,
    [{ name: "white_check_mark", count: 1, users: ["B_GATEWAY"] }]);
  assert.equal(messages[2].reactions, undefined, "unliked answers stay unchanged");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  assert.equal(messages[0].reactions[0].count, 0);
  assert.equal(messages[1].reactions[0].count, 1, "the answer retains its historical feedback marker");
  assert.equal(await threadHasCompletionReaction(client, c.channelId, "100.000001"), false);
  await syncThreadCompletionReaction(client, { reaction: "white_check_mark", event_ts: String(Date.now() / 1000),
    item: { type: "message", channel: c.channelId, ts: "101.000001" } }, { added: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
  messages[1].reactions[0].users.push("U_OTHER"); messages[1].reactions[0].count++;
  assert.equal(await threadHasCompletionReaction(client, c.channelId, "100.000001"), true, "human checks remain evidence");
});

test("native feedback marks the answer when Slack supplies its timestamp only in the container", async () => {
  const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`),
    { ts: "101.000001", thread_ts: "100.000001", user: "B_GATEWAY" },
    { ts: "102.000001", thread_ts: "100.000001", user: "B_GATEWAY" }];
  markerFixture(messages);
  const input = { client, body: { user: { id: "U_MINE" },
    container: { channel_id: c.channelId, message_ts: "101.000001" }, message: { thread_ts: "100.000001" } },
    parsed: { verdict: "up", channel: c.channelId, threadTs: "100.000001" } };
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.equal(await completeThreadFromFeedback(input), true);
  for (const message of messages.slice(0, 2)) assert.deepEqual(message.reactions,
    [{ name: "white_check_mark", count: 1, users: ["B_GATEWAY"] }]);
  assert.equal(messages[2].reactions, undefined);
});

for (const errorKind of ["throw", "response"]) test(`liked-answer marker ${errorKind} failure preserves Done and repeated feedback repairs it`, async () => {
  const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`), { ts: "101.000001", thread_ts: "100.000001" }];
  markerFixture(messages);
  const add = client.reactions.add;
  client.reactions.add = async (args) => {
    if (args.timestamp !== "101.000001") return add(args);
    if (errorKind === "response") return { ok: false, error: "ratelimited" };
    throw Object.assign(new Error("rate limited"), { data: { error: "ratelimited" } });
  };
  const input = { client, body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: messages[1] },
    parsed: { verdict: "up", channel: c.channelId, threadTs: "100.000001" } };
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.ok(getSlackThread(c.channelId, "100.000001").done_ms > 0);
  assert.equal(messages[0].reactions[0].count, 1);
  assert.equal(messages[1].reactions, undefined);
  client.reactions.add = add;
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.equal(messages[1].reactions[0].count, 1);
});

test("reply completion mirrors the root, retries duplicates and removes only the bot check on undo", async () => {
  const { syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
  const { threadHasCompletionReaction } = await import("../src/gateway/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`), { ts: "101.000001", thread_ts: "100.000001", reactions: [{ name: "white_check_mark", count: 1, users: ["U_MINE"] }] }];
  markerFixture(messages);
  const event = { reaction: "white_check_mark", event_ts: String(Date.now() / 1000), item: { type: "message", channel: c.channelId, ts: "101.000001" } };
  await syncThreadCompletionReaction(client, event, { added: true });
  await syncThreadCompletionReaction(client, event, { added: true });
  assert.ok(messages[0].reactions[0].users.includes("B_GATEWAY"));
  assert.ok(markerCalls.every(([, args]) => args.timestamp === "100.000001"));
  messages[1].reactions = [];
  assert.equal(await threadHasCompletionReaction(client, c.channelId, "100.000001"), false, "persisted mirror is never its own evidence");
  await syncThreadCompletionReaction(client, event);
  assert.equal(messages[0].reactions[0].count, 0);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
  messages[0].reactions = [{ name: "white_check_mark", count: 1, users: ["U_OTHER"] }];
  await syncThreadCompletionReaction(client, { ...event, item: { ...event.item, ts: "100.000001" } }, { added: true });
  messages[0].reactions[0].users = ["B_GATEWAY"]; messages[0].reactions[0].count = 1;
  await syncThreadCompletionReaction(client, event);
  assert.equal(messages[0].reactions[0].count, 0);
});

test("Home Done and Reopen add/remove the root marker while retaining human checks", async () => {
  const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1, users: ["U_OTHER"] }] });
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  let handler;
  registerHomeThreadActions({ action: (_id, fn) => { handler = fn; } }, { publishHome: async () => {} });
  for (const action of ["done", "reopen"]) await handler({ ack: async () => {}, client, body: { user: { id: "U_MINE" } },
    action: { action_id: `cg_home_threads_${action}`, value: JSON.stringify({ channelId: c.channelId, threadTs: "100.000001" }) } });
  assert.deepEqual(markerCalls.map(([method]) => method), ["add", "remove"]);
  assert.deepEqual(messages[0].reactions[0], { name: "white_check_mark", count: 1, users: ["U_OTHER"] });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows[0].status, "idle");
});

test("Slack marker failure preserves Done and a repeated action repairs it", async () => {
  const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  client.reactions.add = async () => { throw Object.assign(new Error("rate limited"), { code: "rate_limited" }); };
  const input = { client, body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } },
    parsed: { verdict: "up", channel: c.channelId, threadTs: "100.000001" } };
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.ok(getSlackThread(c.channelId, "100.000001").done_ms > 0);
  markerFixture([roots.get(`${c.channelId}:100.000001`)]);
  assert.equal(await completeThreadFromFeedback(input), true);
  assert.equal(markerCalls[0][0], "add");
});

test("an in-flight inspection recognizes a newly persisted mirror identity", async () => {
  const { inspectThreadCompletion } = await import("../src/gateway/thread-completion.js");
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  let finish;
  client.conversations.replies = () => new Promise((resolve) => { finish = () => resolve({ messages }); });
  const inspection = inspectThreadCompletion(client, c.channelId, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  finish();
  assert.equal((await inspection).completed, false);
});


test("pending markers recover saved Done/Reopen after restart and retry only due writes", async () => {
  const { retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  client.reactions.add = async () => ({ ok: false, error: "missing_scope" });
  await retryThreadDoneMarkers(client);
  assert.equal(markerCalls.length, 0);
  assert.ok(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms > Date.now());
  markerFixture(messages);
  await retryThreadDoneMarkers(client);
  assert.equal(markerCalls.length, 0, "do not spin on failed writes before their backoff");
  await retryThreadDoneMarkers(client, { now: Date.now() + 60001 });
  assert.equal(markerCalls[0][0], "add");
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false);
  await retryThreadDoneMarkers(client);
  assert.equal(markerCalls[1][0], "remove");
  assert.equal(messages[0].reactions[0].count, 0);
});

test("retry checks current reactions rather than restoring a stale completed marker", async () => {
  const { retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  markerFixture([roots.get(`${c.channelId}:100.000001`)]);
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: true });
  await retryThreadDoneMarkers(client);
  assert.equal(markerCalls.length, 0);
  assert.equal(getSlackThread(c.channelId, "100.000001").root_done, 0);
});


test("Home Mark All Done requires native confirmation and covers all owned open pages", async () => {
  const c = await channel();
  for (let i = 0; i < 12; i++) root(c, `${100+i}.000001`);
  root(c, "200.000001", "U_OTHER");
  root(c, "201.000001"); setSlackThreadDone(c.channelId, "201.000001", "U_MINE", true);
  const blocks = homeThreadBlocks({ rows: [], filter: "done" });
  const button = blocks.flatMap((block) => block.elements || []).find((el) => el.action_id === "cg_home_threads_doneall");
  assert.equal(button.text.text, "Mark All Done");
  assert.equal(button.confirm.confirm.text, "Mark All Done"); assert.equal(button.confirm.deny.text, "Cancel");
  assert.match(button.confirm.text.text, /across channels.*other pages and filters/);
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0, "rendering the confirmation does not mutate");
  let handler, published;
  registerHomeThreadActions({ action: (_id, fn) => { handler = fn; } }, { publishHome: async (_client, _user, view) => { published = view; } });
  const args = { ack: async () => {}, client, body: { user: { id: "U_MINE" } }, action: {
    action_id: button.action_id, value: JSON.stringify({ filter: "done", page: 8, ownerId: "U_OTHER", channelId: c.channelId, threadTs: "200.000001" }),
  } };
  await handler(args);
  assert.deepEqual(published.bulkResult, { marked: 12, skipped: 0, failed: 0 }); assert.equal(published.page, 0);
  assert.equal(getSlackThread(c.channelId, "200.000001").done_ms, 0);
  assert.equal(getDb().prepare("SELECT count(*) n FROM slack_threads WHERE completion_marker_retry_ms>0 AND starter_id='U_MINE'").get().n, 13);
  await handler(args); assert.deepEqual(published.bulkResult, { marked: 0, skipped: 0, failed: 0 });
});

test("Mark All Done skips private nonmembers, foreign roots, unengaged and sudo threads", async () => {
  const { markAllSlackThreadsDone } = await import("../src/slack/home-threads.js");
  const publicChannel = await channel(); root(publicChannel, "100.000001"); root(publicChannel, "101.000001");
  await setThreadSudo(publicChannel.slug, "101.000001", true);
  root(publicChannel, "102.000001"); roots.get(`${publicChannel.channelId}:102.000001`).user = "U_OTHER";
  const privateChannel = await channel("G_PRIVATE", "group"); root(privateChannel, "103.000001"); members.set(privateChannel.channelId, []);
  indexSlackThread({ channelId: publicChannel.channelId, slug: publicChannel.slug, root: { ts: "104.000001", user: "U_MINE", text: "human-only" } });
  const result = await markAllSlackThreadsDone(client, "U_MINE");
  assert.deepEqual(result, { marked: 1, skipped: 3, failed: 0 });
  for (const ts of ["101.000001", "102.000001", "104.000001"]) assert.equal(getSlackThread(publicChannel.channelId, ts).done_ms, 0);
  assert.equal(getSlackThread(privateChannel.channelId, "103.000001").done_ms, 0);
});

test("Mark All Done rechecks access after root lookup and reports partial Slack failures", async () => {
  const { markAllSlackThreadsDone } = await import("../src/slack/home-threads.js");
  const c = await channel(); root(c, "100.000001"); root(c, "101.000001");
  const read = client.conversations.replies;
  client.conversations.replies = async (args) => {
    if (args.ts === "101.000001") throw new Error("Slack unavailable");
    return read(args);
  };
  assert.deepEqual(await markAllSlackThreadsDone(client, "U_MINE"), { marked: 1, skipped: 0, failed: 1 });
  client.conversations.replies = async (args) => { await setUser("U_MINE", { approved: false }); return read(args); };
  assert.deepEqual(await markAllSlackThreadsDone(client, "U_MINE"), { marked: 0, skipped: 1, failed: 0 });
  assert.equal(getSlackThread(c.channelId, "101.000001").done_ms, 0);
});


test("bulk completion stops on Slack rate limits and counts every untouched remaining target", async () => {
  const { markAllSlackThreadsDone } = await import("../src/slack/home-threads.js");
  const c = await channel(); root(c, "100.000001"); root(c, "101.000001");
  let calls = 0;
  client.conversations.replies = async () => { calls++; throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error" }); };
  assert.deepEqual(await markAllSlackThreadsDone(client, "U_MINE"), { marked: 0, skipped: 0, failed: 2 });
  assert.equal(calls, 1); assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
});

test("simultaneous bulk confirmations serialize and mark each thread only once", async () => {
  const { markAllSlackThreadsDone } = await import("../src/slack/home-threads.js");
  const c = await channel(); root(c, "100.000001");
  const read = client.conversations.replies;
  let releaseRead, readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  client.conversations.replies = (args) => new Promise((resolve) => { readStarted(); releaseRead = async () => resolve(await read(args)); });
  const first = markAllSlackThreadsDone(client, "U_MINE"); await started;
  const second = markAllSlackThreadsDone(client, "U_MINE");
  await releaseRead();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.marked), [1, 0]);
});


test("transient membership failure during historical root recheck keeps discovery retryable", async () => {
  const c = await channel("G_HISTORY", "group");
  const ts = "100.000001";
  roots.set(`${c.channelId}:${ts}`, { ts, user: "U_MINE", text: "Old private task" });
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, ts, "private-history");
  let calls = 0;
  client.conversations.members = async () => {
    if (++calls === 2) throw new Error("temporarily unavailable");
    return { members: ["U_MINE"] };
  };
  const failed = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(failed.incomplete, true); assert.equal(failed.moreHistory, true);
  assert.equal(getSlackThread(c.channelId, ts), null);
  const retried = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(retried.scanned, 1); assert.equal(retried.incomplete, false);
  assert.equal(getSlackThread(c.channelId, ts).starter_id, "U_MINE");
});


test("initial membership lookup failure cannot report historical indexing exhausted", async () => {
  const c = await channel("G_HISTORY", "group");
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, "100.000001", "private-history");
  const result = await discoverSlackThreadHistory(client, "U_MINE");
  assert.equal(result.scanned, 0); assert.equal(result.incomplete, true); assert.equal(result.moreHistory, true);
});


test("native negative feedback postpones only the owner’s admitted thread and acknowledges privately", async () => {
  const { postponeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const { registerAgentInterfaceHandlers } = await import("../src/slack/agent-interface.js");
  const { feedbackBlocks, REPLY_FEEDBACK_ACTION_ID } = await import("../src/slack/footer.js");
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001");
  const body = { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } };
  const parsed = { verdict: "down", channel: c.channelId, threadTs: "100.000001" };
  members.set(c.channelId, ["U_MINE"]);
  for (const bad of [{ ...parsed, channel: "C_OTHER" }, { ...parsed, threadTs: "999.000001" }]) {
    assert.equal(await postponeThreadFromFeedback({ client, body, parsed: bad }), false);
  }
  assert.equal(await postponeThreadFromFeedback({ client, body: { ...body, user: { id: "U_OTHER" } }, parsed }), false);
  members.set(c.channelId, []);
  assert.equal(await postponeThreadFromFeedback({ client, body, parsed }), false);
  members.set(c.channelId, ["U_MINE"]);
  await setThreadSudo(c.slug, "100.000001", true);
  assert.equal(await postponeThreadFromFeedback({ client, body, parsed }), false);
  await setThreadSudo(c.slug, "100.000001", false);
  const actions = new Map(), notices = [];
  client.chat.postEphemeral = async (message) => { notices.push(message); };
  registerAgentInterfaceHandlers({ event() {}, action: (id, fn) => actions.set(id, fn) }, { onNegativeFeedback: postponeThreadFromFeedback });
  const value = feedbackBlocks({ channel: c.channelId, threadTs: "100.000001", authorId: "U_MINE" })[0].elements[0].negative_button.value;
  let acked = false;
  await actions.get(REPLY_FEEDBACK_ACTION_ID)({ ack: async () => { acked = true; }, body, action: { value }, client });
  assert.ok(acked);
  assert.ok(getSlackThread(c.channelId, "100.000001").later_ms > 0);
  assert.match(notices[0].text, /Moved to Later/);
  assert.equal(notices[0].user, "U_MINE");
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE", { filter: "later" })).rows[0].status, "later");
});


test("Later survives process restart, explicit completed feedback, and clears on positive feedback", async () => {
  const { postponeThreadFromFeedback, completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel(); root(c, "100.000001");
  const input = { client, body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } },
    parsed: { verdict: "down", channel: c.channelId, threadTs: "100.000001" } };
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  assert.equal(await postponeThreadFromFeedback(input), true);
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { getSlackThread, slackThreadStatus } from "./src/gateway/slack-threads.js"; process.stdout.write(slackThreadStatus(getSlackThread("C_THREADS", "100.000001"), new Map()));'],
    { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8" });
  assert.equal(output, "later");
  assert.equal(await completeThreadFromFeedback({ ...input, parsed: { ...input.parsed, verdict: "up" } }), true);
  assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 0);
  assert.equal(slackThreadStatus(getSlackThread(c.channelId, "100.000001"), new Map()), "done");
});

test("feedback cannot postpone after private access is revoked during the root read", async () => {
  const { postponeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001"); members.set(c.channelId, ["U_MINE"]);
  const original = client.conversations.replies;
  client.conversations.replies = async (args) => {
    const response = await original(args);
    await setUser("U_MINE", { approved: false });
    return response;
  };
  const result = await postponeThreadFromFeedback({ client,
    body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } },
    parsed: { verdict: "down", channel: c.channelId, threadTs: "100.000001" } });
  assert.equal(result, false);
  assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 0);
});


test("only a fresh human message addressed to the agent resumes Later and removes its clock", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const c = await channel();
  root(c, "100.000001", "U_MINE", { reactions: [{ name: "clock3", count: 1, users: ["U_OTHER"] }] });
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true, 200000);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "later" })).total, 1);
  const key = homeThreadsRefreshKey("U_MINE");
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)")
    .run("resumed-later", toJson({ channelId: c.channelId, threadKey: "100.000001" }));
  const message = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "Let's continue" };
  for (const text of ["Let's continue", "<@UOTHER> please continue"]) {
    await observeSlackThreadMessage(client, { ...message, text }, "UGATEWAY");
    assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 200000);
    assert.equal(getSlackThread(c.channelId, "100.000001").later_marker, 1);
    assert.equal(markerCalls.length, 1, "ordinary replies leave the root clock intact");
  }
  await observeSlackThreadMessage(client, { ...message, text: "<@UGATEWAY> Let's continue" }, "UGATEWAY");
  const row = getSlackThread(c.channelId, "100.000001");
  assert.equal(row.later_ms, 0); assert.equal(row.later_marker, 0);
  assert.equal(row.completion_marker_retry_ms, 0);
  assert.notEqual(homeThreadsRefreshKey("U_MINE"), key);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "active" })).rows[0].status, "working");
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "later" })).total, 0);
  assert.deepEqual(messages[0].reactions[0], { name: "clock3", count: 1, users: ["U_OTHER"] });
  assert.deepEqual(markerCalls.at(-1), ["remove", { channel: c.channelId, timestamp: "100.000001", name: "clock3" }]);
  const calls = markerCalls.length;
  await observeSlackThreadMessage(client, { ...message, type: "app_mention", text: "<@UGATEWAY> Let's continue" }, "UGATEWAY");
  assert.equal(markerCalls.length, calls, "a companion mention envelope does not duplicate marker writes");
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true, 202000);
  await observeSlackThreadMessage(client, { ...message, type: "app_mention", ts: "203.000001", text: "<@UGATEWAY> Continue" }, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 0, "mention-only delivery resumes too");
});

test("bots, background outcomes, edits and old deliveries leave Later set", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const c = await channel(); root(c, "100.000001");
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true, 200000);
  const base = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "<@UGATEWAY> Continue" };
  for (const event of [
    { user: "UGATEWAY" }, { bot_id: "B_OTHER" }, { app_id: "A_OTHER" },
    { subtype: "bot_message" }, { user: undefined }, { subtype: "message_changed" },
    { subtype: "message_deleted" }, { ts: "199.000001" }, { ts: "200.000000" }, { ts: "invalid" },
  ]) {
    await observeSlackThreadMessage(client, { ...base, ...event }, "UGATEWAY");
    assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 200000);
  }
  recordSlackThreadOutcome(c.channelId, "100.000001", { at: 300000 });
  assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 200000);
  assert.deepEqual(markerCalls, []);
});

test("human attachments and broadcasts resume Later and reopen Done in DMs and private channels", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  for (const [channelId, type, subtype] of [["D_LATER", "im", "file_share"], ["G_LATER", "group", "thread_broadcast"], ["C_LATER", "channel", "me_message"]]) {
    const c = await channel(channelId, type); root(c, "100.000001");
    members.set(channelId, ["U_MINE", "U_OTHER"]);
    setSlackThreadLater(channelId, "100.000001", "U_MINE", true, 200000);
    const event = { channel: channelId, channel_type: type, thread_ts: "100.000001", ts: "201.000001", user: "U_OTHER", subtype,
      text: type === "im" ? "Continue" : "<@UGATEWAY> Continue" };
    if (type !== "im") {
      await observeSlackThreadMessage(client, { ...event, text: "An ordinary attachment or broadcast" }, "UGATEWAY");
      assert.equal(getSlackThread(channelId, "100.000001").later_ms, 200000);
    }
    await observeSlackThreadMessage(client, event, "UGATEWAY");
    assert.equal(getSlackThread(channelId, "100.000001").later_ms, 0);
    setSlackThreadDone(channelId, "100.000001", "U_MINE", true, 202000);
    await observeSlackThreadMessage(client, { ...event, ts: "203.000001" }, "UGATEWAY");
    assert.equal(getSlackThread(channelId, "100.000001").done_ms, -203000);
    await observeSlackThreadMessage(client, { ...event, thread_ts: "999.000001" }, "UGATEWAY");
    assert.equal(getSlackThread(channelId, "999.000001"), null);
  }
});

test("a human reply keeps clock cleanup durable after Slack failure and redelivery cannot undo a new postponement", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const { syncThreadDoneMarker, retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true, 200000);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  client.reactions.remove = async () => ({ ok: false, error: "ratelimited" });
  const event = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "<@UGATEWAY> Continue" };
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  const row = getSlackThread(c.channelId, "100.000001");
  assert.equal(row.later_ms, 0); assert.equal(row.later_marker, 1);
  assert.ok(row.completion_marker_retry_ms > Date.now());
  markerFixture(messages);
  await retryThreadDoneMarkers(client, { now: Date.now() + 60001 });
  assert.equal(getSlackThread(c.channelId, "100.000001").later_marker, 0);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true, 202000);
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").later_ms, 202000);
});

test("Later feedback mirrors clock3 on the main post, duplicates are harmless and Resume preserves human clocks", async () => {
  const { postponeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: "clock3", count: 1, users: ["U_OTHER"] }] });
  const messages = [roots.get(`${c.channelId}:100.000001`), { ts: "101.000001", thread_ts: "100.000001", user: "B_GATEWAY" }];
  markerFixture(messages);
  const input = { client, body: { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: messages[1] },
    parsed: { verdict: "down", channel: c.channelId, threadTs: "100.000001" } };
  assert.equal(await postponeThreadFromFeedback(input), true);
  assert.equal(await postponeThreadFromFeedback(input), true);
  assert.deepEqual(messages[0].reactions[0].users, ["U_OTHER", "B_GATEWAY"]);
  assert.ok(markerCalls.every(([, args]) => args.timestamp === "100.000001" && args.name === "clock3"));
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
  assert.equal(getSlackThread(c.channelId, "100.000001").later_marker, 1);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", false);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  assert.deepEqual(messages[0].reactions[0], { name: "clock3", count: 1, users: ["U_OTHER"] });
  assert.equal(getSlackThread(c.channelId, "100.000001").later_marker, 0);
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
});

test("Done replaces the bot's Later clock with its completion check and Reopen leaves neither", async () => {
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  assert.equal(messages[0].reactions.find((r) => r.name === "clock3").count, 0);
  assert.equal(messages[0].reactions.find((r) => r.name === "white_check_mark").count, 1);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  assert.ok(messages[0].reactions.every((r) => r.count === 0));
});

test("saved Later markers retry after Slack failure and an interrupted removal without losing the choice", async () => {
  const { retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true);
  client.reactions.add = async () => ({ ok: false, error: "ratelimited" });
  await retryThreadDoneMarkers(client);
  let row = getSlackThread(c.channelId, "100.000001");
  assert.ok(row.later_ms > 0 && row.later_marker === 1 && row.completion_marker_retry_ms > Date.now());
  markerFixture(messages);
  await retryThreadDoneMarkers(client, { now: Date.now() + 60001 });
  assert.equal(messages[0].reactions[0].name, "clock3");
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", false);
  // A saved Resume with an installed clock is all a fresh worker needs for cleanup.
  await retryThreadDoneMarkers(client);
  row = getSlackThread(c.channelId, "100.000001");
  assert.equal(row.later_marker, 0); assert.equal(row.completion_marker_retry_ms, 0);
  assert.equal(messages[0].reactions[0].count, 0);
});

test("Resume during an in-flight clock write retains cleanup for the next marker worker", async () => {
  const { syncThreadDoneMarker, retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  const add = client.reactions.add;
  let finish;
  client.reactions.add = async (args) => { await new Promise((resolve) => { finish = resolve; }); return add(args); };
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true);
  const pending = syncThreadDoneMarker(client, c.channelId, "100.000001");
  await new Promise((resolve) => setImmediate(resolve));
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", false);
  finish(); await pending;
  assert.ok(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms > 0);
  await retryThreadDoneMarkers(client);
  assert.equal(messages[0].reactions[0].count, 0);
});

test("Later during in-flight clock removal queues a fresh root clock", async () => {
  const { syncThreadDoneMarker, retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const c = await channel(); root(c, "100.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", false);
  const remove = client.reactions.remove;
  let finish;
  client.reactions.remove = async (args) => { await new Promise((resolve) => { finish = resolve; }); return remove(args); };
  const pending = syncThreadDoneMarker(client, c.channelId, "100.000001");
  await new Promise((resolve) => setImmediate(resolve));
  setSlackThreadLater(c.channelId, "100.000001", "U_MINE", true);
  finish(); await pending;
  assert.ok(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms > 0);
  await retryThreadDoneMarkers(client);
  assert.equal(messages[0].reactions[0].count, 1);
  assert.equal(getSlackThread(c.channelId, "100.000001").later_marker, 1);
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
});


test("a new human prompt reopens Done, clears the root check and restores Activity/reminder eligibility", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const { syncThreadDoneMarker } = await import("../src/slack/thread-done-marker.js");
  const { threadIsComplete } = await import("../src/gateway/thread-completion.js");
  const c = await channel(); root(c, "100.000001"); root(c, "101.000001");
  const messages = [roots.get(`${c.channelId}:100.000001`)]; markerFixture(messages);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  const key = homeThreadsRefreshKey("U_MINE");
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)")
    .run("reopened", toJson({ channelId: c.channelId, threadKey: "100.000001" }));
  const event = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "<@UGATEWAY> Another change please" };
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, -201000);
  assert.equal(messages[0].reactions.find((r) => r.name === "white_check_mark").count, 0);
  assert.deepEqual(markerCalls.at(-1), ["remove", { channel: c.channelId, timestamp: "100.000001", name: "white_check_mark" }]);
  assert.notEqual(homeThreadsRefreshKey("U_MINE"), key);
  assert.equal((await activityThreadSnapshot(client, "U_MINE", { filter: "active" })).rows.find((r) => r.thread_ts === "100.000001").status, "working");
  assert.equal(await threadIsComplete(client, c.channelId, "100.000001"), false);
  assert.equal(getSlackThread(c.channelId, "101.000001").done_ms, 0);
  const calls = markerCalls.length;
  await observeSlackThreadMessage(client, { ...event, type: "app_mention" }, "UGATEWAY");
  assert.equal(markerCalls.length, calls, "companion mention delivery is idempotent");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 202000);
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 202000, "old redelivery preserves a newer Done");
});

test("Done survives bots, edits, unrelated mentions, ordinary shared replies and old prompts", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  const base = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "<@UGATEWAY> Continue" };
  for (const change of [
    { user: "UGATEWAY" }, { bot_id: "B_OTHER" }, { app_id: "A_OTHER" }, { subtype: "bot_message" },
    { user: undefined }, { subtype: "message_changed" }, { subtype: "message_deleted" },
    { text: "Thanks" }, { text: "<@UOTHER> Continue" }, { ts: "199.000001" }, { ts: "200.000000" }, { ts: "invalid" },
  ]) {
    await observeSlackThreadMessage(client, { ...base, ...change }, "UGATEWAY");
    assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000);
  }
  recordSlackThreadOutcome(c.channelId, "100.000001", { at: 300000 });
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000);
  assert.deepEqual(markerCalls, []);
});

test("new prompts override old root/reply checks, delayed mirror events and failed marker removal", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const { syncThreadDoneMarker, retryThreadDoneMarkers } = await import("../src/slack/thread-done-marker.js");
  const { syncThreadCompletionReaction } = await import("../src/slack/thread-completion.js");
  const { threadIsComplete } = await import("../src/gateway/thread-completion.js");
  const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: "white_check_mark", count: 1, users: ["U_MINE"] }] });
  const messages = [roots.get(`${c.channelId}:100.000001`), { ts: "150.000001", thread_ts: "100.000001", reactions: [{ name: "heavy_check_mark", count: 1, users: ["U_MINE"] }] }];
  markerFixture(messages);
  updateSlackThreadRootCompletion(c.channelId, { ts: "100.000001" }, { completed: true, reactionAt: 200000 });
  await syncThreadDoneMarker(client, c.channelId, "100.000001");
  const remove = client.reactions.remove;
  client.reactions.remove = async () => ({ ok: false, error: "ratelimited" });
  await observeSlackThreadMessage(client, { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_MINE", text: "<@UGATEWAY> Continue" }, "UGATEWAY");
  assert.ok(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms > Date.now());
  assert.equal(await threadIsComplete(client, c.channelId, "100.000001"), false, "passive old reactions cannot re-close");
  client.reactions.remove = remove;
  await retryThreadDoneMarkers(client, { now: Date.now() + 60001 });
  assert.deepEqual(messages[0].reactions[0], { name: "white_check_mark", count: 1, users: ["U_MINE"] });
  assert.equal(getSlackThread(c.channelId, "100.000001").completion_marker_retry_ms, 0);
  const item = { type: "message", channel: c.channelId, ts: "100.000001" };
  await syncThreadCompletionReaction(client, { item, reaction: "white_check_mark", user: "B_GATEWAY", event_ts: "202.000001" }, { added: true });
  assert.equal(await threadIsComplete(client, c.channelId, "100.000001"), false, "delayed mirror event preserves Reopen");
  await syncThreadCompletionReaction(client, { item, reaction: "white_check_mark", user: "U_OTHER", event_ts: "203.000001" }, { added: true });
  assert.equal(await threadIsComplete(client, c.channelId, "100.000001"), true, "a genuinely newer completion event closes again");
});


test("denied senders, revoked private membership and sudo non-admins cannot reopen Done", async () => {
  const { observeSlackThreadMessage } = await import("../src/slack/thread-activity.js");
  const c = await channel(); root(c, "100.000001");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true, 200000);
  const event = { channel: c.channelId, thread_ts: "100.000001", ts: "201.000001", user: "U_OTHER", text: "<@UGATEWAY> Continue" };
  await setUser("U_OTHER", { approved: false });
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000);
  await setUser("U_OTHER", { approved: true });
  await patchChannelMeta(c.slug, { access: "none" });
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000);
  await patchChannelMeta(c.slug, { access: "approved" });
  await setThreadSudo(c.slug, "100.000001", true);
  await observeSlackThreadMessage(client, event, "UGATEWAY");
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 200000);
  const privateChannel = await channel("G_REOPEN", "group"); root(privateChannel, "100.000001");
  setSlackThreadDone(privateChannel.channelId, "100.000001", "U_MINE", true, 200000);
  members.set(privateChannel.channelId, ["U_MINE"]);
  await observeSlackThreadMessage(client, { ...event, channel: privateChannel.channelId }, "UGATEWAY");
  assert.equal(getSlackThread(privateChannel.channelId, "100.000001").done_ms, 200000);
  members.set(privateChannel.channelId, ["U_OTHER"]);
  const listMembers = client.conversations.members;
  client.conversations.members = async (args) => {
    await setUser("U_OTHER", { approved: false });
    return listMembers(args);
  };
  await observeSlackThreadMessage(client, { ...event, channel: privateChannel.channelId }, "UGATEWAY");
  assert.equal(getSlackThread(privateChannel.channelId, "100.000001").done_ms, 200000, "revocation during membership lookup wins");
  assert.deepEqual(markerCalls, []);
});


test("registered forks survive history verification and belong only to their creator", async () => {
  const c = await channel();
  root(c, "100.000001", "U_OTHER");
  const fork = { channelId: c.channelId, slug: c.slug, threadTs: "101.000001", sourceThreadTs: "100.000001",
    creatorId: "U_MINE", botUserId: "UBOT", title: "Fork: Try another approach" };
  const botRoot = { ts: fork.threadTs, user: "UBOT", bot_id: "B_GATEWAY", text: "↪️ <@U_MINE> Fork: Try another approach" };
  roots.set(`${c.channelId}:${fork.threadTs}`, botRoot);
  assert.ok(indexSlackFork(fork));
  assert.equal(indexSlackFork({ ...fork, creatorId: "U_OTHER" }), null, "replays cannot transfer ownership");
  await discoverSlackThreadHistory(client, "U_MINE");
  const mine = await homeThreadsSnapshot(client, "U_MINE", { filter: "all" });
  assert.deepEqual(mine.rows.map(r => r.thread_ts), [fork.threadTs]);
  assert.equal((await homeThreadsSnapshot(client, "U_OTHER", { filter: "all" })).rows[0].thread_ts, "100.000001");
  assert.deepEqual((await activityThreadSnapshot(client, "U_MINE")).rows.map(r => r.thread_ts), [fork.threadTs]);
  const row = getSlackThread(c.channelId, fork.threadTs);
  assert.equal(row.starter_id, "U_MINE", "passive reindexing must preserve the authenticated creator");
  assert.equal(slackThreadRootOwner(c.channelId, { ...botRoot, user: "UOTHERBOT" }), "");
  assert.equal(slackThreadRootOwner(c.channelId, { ...botRoot, bot_id: undefined }), "");
  assert.equal(slackThreadRootOwner(c.channelId, { ...botRoot, ts: "102.000001" }), "", "text and mentions cannot establish a fork");
  assert.equal(slackThreadRootOwner(c.channelId, { ...botRoot, subtype: "tombstone" }), "");
  const result = await markAllSlackThreadsDone(client, "U_MINE");
  assert.equal(result.marked, 1);
  assert.ok(getSlackThread(c.channelId, fork.threadTs).done_ms > 0);
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
});


test("fork answer feedback marks only the creator's child Done or Later", async () => {
  const { completeThreadFromFeedback, postponeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel();
  root(c, "100.000001");
  const threadTs = "101.000001";
  roots.set(`${c.channelId}:${threadTs}`, { ts: threadTs, user: "UBOT", bot_id: "B_GATEWAY", text: "Fork task" });
  indexSlackFork({ channelId: c.channelId, slug: c.slug, threadTs, sourceThreadTs: "100.000001",
    creatorId: "U_MINE", botUserId: "UBOT", title: "Fork task" });
  const body = { channel: { id: c.channelId }, message: { ts: "102.000001", thread_ts: threadTs }, user: { id: "U_MINE" } };
  const parsed = { channel: c.channelId, threadTs, verdict: "down" };
  assert.equal(await postponeThreadFromFeedback({ client, body: { ...body, user: { id: "U_OTHER" } }, parsed }), false);
  assert.equal(await postponeThreadFromFeedback({ client, body, parsed }), true);
  assert.ok(getSlackThread(c.channelId, threadTs).later_ms > 0);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed: { ...parsed, verdict: "up" } }), true);
  assert.ok(getSlackThread(c.channelId, threadTs).done_ms > 0);
  assert.equal(getSlackThread(c.channelId, threadTs).later_ms, 0);
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
});
