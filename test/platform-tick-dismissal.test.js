import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ createIngest }, { setUser }, { teamsAdapter }, threads, { addAck, findAckByMessage }] = await Promise.all([
  import("../src/platforms/ingest.js"), import("../src/config/store.js"), import("../src/platforms/msteams.js"),
  import("../src/gateway/platform-threads.js"), import("../src/config/acks.js"),
]);
const log = { warn() {}, error() {}, info() {} };
await setUser("29:starter", { name: "Starter", approved: true });
await setUser("29:helper", { name: "Helper", approved: true });
await setUser("29:bystander", { name: "Bystander", approved: true });

function harness() {
  const posted = [];
  const connector = { platform: "msteams", capabilities: teamsAdapter.capabilities,
    async post(payload) { posted.push(payload); return { conversationId: payload.conversationId, messageId: `bot-${posted.length}`, threadKey: payload.threadKey || "" }; },
    async edit() {}, async directory() { return { map: new Map(), maxWords: 1 }; } };
  const ingest = createIngest({ connector, log, run: async () => ({ content: "done", engine: "claude" }) });
  return { ingest, posted };
}
const base = (nativeId, root, userId, extra = {}) => ({ platform: "msteams", conversationId: `teams:${nativeId}`, rawConversationId: nativeId,
  threadKey: root, userId, userName: userId, isDM: false, kind: "channel", mentionsBot: true, text: "please help",
  attachments: [], trigger: "message", messageId: randomUUID(), ...extra });
const tick = (nativeId, root, userId) => base(nativeId, root, userId, { trigger: "reaction", reactionAction: "ack",
  replyToId: randomUUID(), text: "the answer", mentionsBot: false });

test("✅ by the person who started a session marks its Activity entry done", async () => {
  const { ingest, posted } = harness();
  const nativeId = `19:${randomUUID()}@thread.tacv2`;
  await ingest(base(nativeId, "100", "29:starter", { messageId: "100" }));
  assert.equal(threads.getPlatformThread(`teams:${nativeId}`, "100").starter_id, "29:starter");
  await ingest(tick(nativeId, "100", "29:starter"));
  assert.match(posted.at(-1).text, /Marked done in your Activity/);
  const row = threads.getPlatformThread(`teams:${nativeId}`, "100");
  assert.ok(row.done_ms > 0);
  assert.equal(row.status, "done");
});

test("✅ by another participant dismisses it from their own list only; a bystander has nothing to dismiss", async () => {
  const { ingest, posted } = harness();
  const nativeId = `19:${randomUUID()}@thread.tacv2`;
  await ingest(base(nativeId, "200", "29:starter", { messageId: "200" }));
  await ingest(base(nativeId, "200", "29:helper", { text: "adding context" }));
  await ingest(tick(nativeId, "200", "29:helper"));
  assert.match(posted.at(-1).text, /Dismissed from your Activity/);
  const row = threads.getPlatformThread(`teams:${nativeId}`, "200");
  assert.equal(row.done_ms, 0, "the starter's entry stays open");
  const helperRow = threads.listPlatformThreadsForUser("29:helper").find(item => item.thread_ts === "200" && item.channel_id === `teams:${nativeId}`);
  assert.ok(helperRow.hidden_ms > 0);
  const starterRow = threads.listPlatformThreadsForUser("29:starter").find(item => item.thread_ts === "200" && item.channel_id === `teams:${nativeId}`);
  assert.equal(starterRow.hidden_ms, 0);

  await ingest(tick(nativeId, "200", "29:bystander"));
  assert.match(posted.at(-1).text, /No pending Tick button reminder on this message, and no Activity entry of yours/);
});

test("a tracked reminder still takes precedence over the Activity entry", async () => {
  const { ingest, posted } = harness();
  const nativeId = `19:${randomUUID()}@thread.tacv2`;
  await ingest(base(nativeId, "300", "29:starter", { messageId: "300" }));
  const reaction = tick(nativeId, "300", "29:starter");
  addAck({ channelId: `teams:${nativeId}`, messageTs: reaction.replyToId, ackEmoji: "2705_whiteheavycheckmark", nextAt: new Date(Date.now() + 3_600_000).toISOString() });
  await ingest(reaction);
  assert.match(posted.at(-1).text, /Acknowledged — reminder closed/);
  assert.equal(findAckByMessage(`teams:${nativeId}`, reaction.replyToId), null);
  assert.equal(threads.getPlatformThread(`teams:${nativeId}`, "300").done_ms, 0, "closing a reminder does not also close the conversation");
});
