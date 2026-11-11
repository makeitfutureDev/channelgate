import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb, toJson } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { getSlackThread, indexSlackThread, trackSlackThread, recordSlackThreadOutcome, setSlackThreadDone,
  slackThreadRuntime, slackThreadStatus, updateSlackThreadRootCompletion } = await import("../src/gateway/slack-threads.js");
const { homeThreadsSnapshot, homeThreadBlocks, registerHomeThreadActions, normalizeThreadView, homeThreadsRefreshKey } = await import("../src/slack/home-threads.js");

let roots;
let members;
let reads;
let client;
async function channel(id = "C_THREADS", type = "channel", meta = {}) {
  await upsertChannelEntry(id, { name: `#${id}`, type, isDM: type === "im" });
  const entry = await getChannelEntry(id);
  await saveChannelMeta(entry.slug, { isDM: type === "im", access: "approved", ...meta });
  return { ...entry, channelId: id };
}
function root(entry, ts, user = "U_MINE", extra = {}) {
  const message = { ts, user, text: `Task ${ts}`, ...extra };
  roots.set(`${entry.channelId}:${ts}`, message);
  return indexSlackThread({ channelId: entry.channelId, slug: entry.slug, root: message });
}
beforeEach(async () => {
  const db = getDb();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) db.exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false });
  await setUser("U_OTHER", { approved: true, isAdmin: false });
  roots = new Map(); members = new Map(); reads = [];
  client = {
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

test("Done is durable, root checks are respected, explicit Reopen overrides a root check, and newer work stays completed", async () => {
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

test("history is discovered in bounded batches and verifies roots rather than assuming session authors", async () => {
  const c = await channel();
  const db = getDb();
  for (let n = 1; n <= 23; n++) {
    const ts = `${100 + n}.000001`;
    roots.set(`${c.channelId}:${ts}`, { ts, user: n % 2 ? "U_MINE" : "U_OTHER", text: `Historical ${n}` });
    db.prepare("INSERT INTO sessions(slug,thread_key,session_id,engine,runtime) VALUES(?,?,?,?,?)").run(c.slug, ts, `session-${n}`, "codex", "{}");
  }
  let view = await homeThreadsSnapshot(client, "U_MINE", { filter: "all" });
  assert.equal(view.moreHistory, true); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slack_threads").get().n, 10);
  await homeThreadsSnapshot(client, "U_MINE", { filter: "all" });
  view = await homeThreadsSnapshot(client, "U_MINE", { filter: "all" });
  assert.equal(view.moreHistory, false); assert.equal(view.total, 12);
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

test("later messages and background outcomes cannot undo manual Done", async () => {
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

for (const marker of ["white_check_mark", "+1", "thumbsup", "+1::skin-tone-3", "activity", "feedback"]) {
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
  const c = await channel(); root(c, "100.000001", "U_MINE", { reactions: [{ name: "+1", count: 1 }] });
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
  const messages = [roots.get("C_THREADS:100.000001"), { ts: "101.000001", thread_ts: "100.000001", user: "BOT", reactions: [{ name: "+1", count: 1 }] }];
  client.conversations.replies = async () => ({ messages });
  client.reactions = { get: async ({ timestamp }) => ({ message: messages.find((m) => m.ts === timestamp) }) };
  const event = (ts, reaction, eventTs) => ({ item: { type: "message", channel: c.channelId, ts }, reaction, event_ts: eventTs });
  await syncThreadCompletionReaction(client, event("101.000001", "+1", "200.000001"), { added: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  messages[0].reactions = [{ name: "white_check_mark", count: 1 }];
  messages[1].reactions = [];
  await syncThreadCompletionReaction(client, event("101.000001", "+1", "201.000001"));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0, "remaining root check still completes work");
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", false, 300000);
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  messages[1].reactions = [{ name: "thumbsup", count: 1 }];
  await syncThreadCompletionReaction(client, event("101.000001", "thumbsup", "400.000001"), { added: true });
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 0);
  messages[0].reactions = []; messages[1].reactions = [];
  await syncThreadCompletionReaction(client, event("100.000001", "white_check_mark", "401.000001"));
  assert.equal((await homeThreadsSnapshot(client, "U_MINE")).rows.length, 1);
  setSlackThreadDone(c.channelId, "100.000001", "U_MINE", true);
  await syncThreadCompletionReaction(client, event("101.000001", "thumbsup", "402.000001"));
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

test("native positive feedback cannot forge thread ownership or retain revoked private/sudo access", async () => {
  const { completeThreadFromFeedback } = await import("../src/slack/thread-completion.js");
  const c = await channel("G_PRIVATE", "group"); root(c, "100.000001");
  const body = { user: { id: "U_MINE" }, channel: { id: c.channelId }, message: { ts: "101.000001", thread_ts: "100.000001" } };
  const parsed = { verdict: "up", channel: c.channelId, threadTs: "100.000001" };
  members.set(c.channelId, ["U_MINE"]);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed: { ...parsed, threadTs: "999.000001" } }), false);
  assert.equal(await completeThreadFromFeedback({ client, body: { ...body, user: { id: "U_OTHER" } }, parsed }), false);
  members.set(c.channelId, []);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), false);
  members.set(c.channelId, ["U_MINE"]);
  await setThreadSudo(c.slug, "100.000001", true);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), false);
  await setThreadSudo(c.slug, "100.000001", false);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed: { ...parsed, verdict: "down" } }), false);
  assert.equal(getSlackThread(c.channelId, "100.000001").done_ms, 0);
  assert.equal(await completeThreadFromFeedback({ client, body, parsed }), true);
});
