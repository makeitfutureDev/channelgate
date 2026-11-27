import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { slackDeliveryIdentity, slackAnswer, deliverTurnAnswer, recoverTurnAnswers, withInboundAnswerScope } = await import("../src/gateway/turn-answer.ts");
const { recordActiveRun, takeStaleRuns } = await import("../src/gateway/active-runs.js");
const { hasCompletedSlackMessage } = await import("../src/slack/message-receipts.js");
const db = getDb();
const state = (id: string) => db.prepare("SELECT state,attempts,payload FROM turn_answers WHERE id=?").get(id);
const answer = slackAnswer({ channelId: "C123", threadKey: "123456.123456", authorId: "U123", slug: "test",
  sessionKey: "123456.123456", text: "finished report" });

test("checkpoint retires paid execution even before the first delivery attempt", async () => {
  const id = "chat-checkpoint";
  recordActiveRun(id, { channelId: answer.channelId, threadKey: answer.threadKey, slackMessageTs: "12345.678901" });
  const outcome = await deliverTurnAnswer(answer, id, async () => {
    assert.equal(state(id)?.state, "pending");
    return "defer";
  }, async () => assert.fail("forced shutdown cannot initiate a post"));
  assert.equal(outcome, "pending");
  assert.deepEqual(takeStaleRuns(), []);
  assert.equal(hasCompletedSlackMessage(answer.channelId, "12345.678901"), true);
  let sends = 0;
  const recover = () => recoverTurnAnswers(async (saved, ambiguous) => {
    assert.equal(saved.text, answer.text);
    assert.equal(ambiguous, false);
    return async () => { assert.equal(state(id)?.state, "attempting"); sends++; };
  });
  await recover(); await recover();
  assert.equal(sends, 1);
  assert.deepEqual({ ...state(id) }, { state: "delivered", attempts: 1, payload: "{}" });
});

test("an accepted send with a lost acknowledgement recovers only its answer", async () => {
  const id = "ambiguous-answer";
  const writes: string[] = [];
  const outcome = await deliverTurnAnswer(answer, id, async () => "send", async () => {
    writes.push(answer.text);
    throw new Error("connection closed after server accepted message");
  });
  assert.equal(outcome, "pending");
  assert.equal(state(id)?.state, "uncertain");
  assert.equal(await deliverTurnAnswer(answer, id, async () => assert.fail("duplicate prepare"), async () => assert.fail("duplicate send")), "duplicate");
  const later = Date.now() + 300_000;
  await recoverTurnAnswers(async () => false, later); // offline does not consume an attempt
  assert.equal(state(id)?.attempts, 1);
  await recoverTurnAnswers(async (saved, ambiguous) => {
    assert.equal(ambiguous, true);
    return async () => { writes.push(saved.text); };
  }, later + 61_000);
  assert.deepEqual(writes, [answer.text, answer.text]);
  assert.equal(state(id)?.attempts, 2);
});

test("a crash in an unacknowledged attempt, bounded retry, and expiration", async () => {
  const id = "abrupt-death";
  await deliverTurnAnswer(answer, id, async () => "defer", async () => assert.fail("deferred"));
  db.prepare("UPDATE turn_answers SET attempts=1, state='attempting' WHERE id=?").run(id);
  let attempts = 0;
  for (let n = 1; n <= 4; n++) await recoverTurnAnswers(async (_saved, ambiguous) => {
    assert.equal(ambiguous, true); return async () => { attempts++; throw new Error("offline"); };
  }, Date.now() + n * 120_000);
  assert.equal(attempts, 2);
  assert.equal(state(id)?.state, "abandoned");
  await recoverTurnAnswers(async () => assert.fail("expired"), Date.now() + 8 * 86_400_000);
  assert.equal(state(id), undefined);
});

test("inbox receipt and private result commit together, cancellation erases the answer before send", async () => {
  const scope = { namespace: "msteams-bot:app", eventId: "event", owner: "worker" };
  const id = JSON.stringify(["inbox", scope.namespace, scope.eventId]);
  db.prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,owner,data) VALUES(?,?,?,'running',?,?,?)")
    .run(scope.namespace, scope.eventId, "conv", Date.now(), scope.owner, '{"text":"private prompt"}');
  const controller = new AbortController();
  const outcome = await withInboundAnswerScope(scope, () => deliverTurnAnswer(answer, id, async () => {
    assert.deepEqual({ ...db.prepare("SELECT status,data FROM inbound_events WHERE namespace=? AND event_id=?").get(scope.namespace, scope.eventId) },
      { status: "done", data: "{}" });
    controller.abort();
    assert.equal(state(id)?.payload, "{}");
    return "cancel";
  }, async () => assert.fail("cancelled reply sent"), { signal: controller.signal }));
  assert.equal(outcome, "cancelled");
});

test("native recovery binds the workspace, rechecks private voice membership, and labels a streamed preview", async () => {
  const { ensureConversation } = await import("../src/platforms/ingest.js");
  const { makeInbound } = await import("../src/platforms/inbound.js");
  const { setUser } = await import("../src/config/store.js");
  const { recoverConnectedTurnAnswers } = await import("../src/gateway/turn-answer-recovery.ts");
  const input = { platform: "slack", conversationId: "G_PRIVATE", conversationName: "private",
    kind: "group", userId: "U_VOICE", threadKey: "1700000000.000012" };
  const incoming = makeInbound(input);
  const { entry } = await ensureConversation(incoming);
  await setUser(incoming.userId, { approved: true });
  const voice = slackAnswer({ ...answer, channelId: incoming.conversationId, sessionKey: incoming.threadKey,
    threadKey: incoming.threadKey, slug: entry.slug, identity: slackDeliveryIdentity("T_ORIGINAL", "U_BOT"), authorId: incoming.userId, access: "voice", preview: true });
  let teamId = "T_OTHER";
  const posts: { text: string; thread_ts: string }[] = [];
  const client = (members: string[]) => ({ conversations: { members: async () => ({ members }) },
    chat: { postMessage: async (p: typeof posts[number]) => { posts.push(p); return { ok: true }; } } });
  let connected = client([]);
  const slack = { snapshot: () => ({ connected: true, teamId, botUserId: "U_BOT" }), getClient: () => connected };
  await deliverTurnAnswer(voice, "stale-voice", async () => "defer", async () => assert.fail("deferred"));
  await recoverConnectedTurnAnswers(slack);
  assert.equal(state("stale-voice")?.attempts, 0);
  teamId = "T_ORIGINAL";
  await recoverConnectedTurnAnswers(slack, Date.now() + 90_000);
  assert.equal(state("stale-voice")?.state, "cancelled");
  assert.equal(posts.length, 0);
  connected = client([incoming.userId]);
  await deliverTurnAnswer(voice, "voice-preview", async () => "defer", async () => assert.fail("deferred"));
  await recoverConnectedTurnAnswers(slack);
  assert.equal(state("voice-preview")?.state, "delivered");
  assert.match(posts[0].text, /Recovered reply/);
  assert.match(posts[0].text, /finished report/);
  assert.equal(posts[0].thread_ts, voice.threadKey);
});

test("stop while the provider request is outstanding suppresses an ambiguous retry", async () => {
  const controller = new AbortController();
  const id = "stopped-at-provider";
  const outcome = await deliverTurnAnswer(answer, id, async () => "send", async () => {
    controller.abort();
    assert.equal(state(id)?.state, "cancelled");
    throw new Error("response lost");
  }, { signal: controller.signal });
  assert.equal(outcome, "cancelled");
  assert.equal(state(id)?.payload, "{}");
});

for (const platform of ["msteams", "googlechat"]) {
  test(`${platform} resumes a saved answer on its bound connector and original placeholder`, async () => {
    const { ensureConversation } = await import("../src/platforms/ingest.js");
    const { makeInbound } = await import("../src/platforms/inbound.js");
    const { registerTransport, unregisterTransport } = await import("../src/platforms/live.js");
    const { setUser } = await import("../src/config/store.js");
    const { recoverConnectedTurnAnswers } = await import("../src/gateway/turn-answer-recovery.ts");
    const input = { platform, conversationId: platform === "msteams" ? "19:recovered@thread.v2" : "spaces/recovered",
      kind: "group", conversationName: "saved replies", userId: "test-author", threadKey: "original-thread" };
    const incoming = makeInbound(input);
    const { entry } = await ensureConversation(incoming);
    await setUser(incoming.userId, { approved: true });
    const edits: { messageId: string; text: string; conversationId: string }[] = [];
    const connector = { platform, deliveryIdentity: "original-account",
      edit: async (payload: typeof edits[number]) => { edits.push(payload); } };
    registerTransport(platform, { getConnector: () => connector });
    try {
      const payload = { ...answer, platform, channelId: incoming.conversationId, rawChannelId: incoming.rawConversationId,
        threadKey: incoming.threadKey, sessionKey: incoming.threadKey, slug: entry.slug, identity: connector.deliveryIdentity,
        authorId: incoming.userId, placeholder: { messageId: "original-working-message" } };
      await deliverTurnAnswer(payload, platform, async () => "send", async () => { throw new Error("acknowledgment lost"); });
      await recoverConnectedTurnAnswers({ snapshot: () => ({ connected: false }), getClient: () => null }, Date.now() + 90_000);
      assert.equal(edits.length, 1);
      assert.equal(edits[0].messageId, "original-working-message");
      assert.equal(edits[0].conversationId, incoming.rawConversationId);
      assert.match(edits[0].text, /Recovered reply/);
      assert.match(edits[0].text, /finished report/);
      assert.equal(state(platform)?.state, "delivered");
    } finally { unregisterTransport(platform); }
  });
}

test("process death between provider acceptance and SQLite acknowledgement recovers without engine replay", async () => {
  const { spawnSync } = await import("node:child_process");
  const id = "killed-during-write";
  recordActiveRun(id, { channelId: answer.channelId, threadKey: answer.threadKey });
  // A separate process owns the sending promise and vanishes before its acknowledgement.
  const source = `
    import { deliverTurnAnswer } from ${JSON.stringify(new URL("../src/gateway/turn-answer.ts", import.meta.url).href)};
    await deliverTurnAnswer(JSON.parse(process.argv[1]), process.argv[2], async () => "send", async () => {
      process.exit(86);
    });
  `;
  const exit = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(answer), id], { encoding: "utf8" });
  assert.equal(exit.status, 86, exit.stderr);
  assert.equal(state(id)?.state, "attempting");
  assert.deepEqual(takeStaleRuns(), []);
  let recovered = false;
  await recoverTurnAnswers(async (saved, ambiguous) => {
    assert.equal(ambiguous, true); assert.equal(saved.text, answer.text);
    return async () => { recovered = true; };
  });
  assert.equal(recovered, true);
  assert.equal(state(id)?.state, "delivered");
});
