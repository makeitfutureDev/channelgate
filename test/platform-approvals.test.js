import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, saveChannelMeta } = await import("../src/config/store.js");
const { registerTransport, unregisterTransport } = await import("../src/platforms/live.js");
const { requestApproval, lookupApproval, handlePlatformApproval, setDurableApprovalExecutor } = await import("../src/slack/approvals.js");
const CHANNEL = "teams:19:approval@thread.v2", SLUG = "teams-approval-test", AUTHOR = "29:author", ADMIN = "29:admin";
await setUser(AUTHOR, { approved: true });
await setUser(ADMIN, { approved: true, isAdmin: true });
await saveChannelMeta(SLUG, { channelId: CHANNEL, platform: "msteams", access: "approved", autoMode: false, adminMode: false });
const cards = [], updates = [];
const connector = { platform: "msteams", ready: () => true,
  postCard: async payload => { cards.push(payload); return { messageId: String(cards.length), conversationId: CHANNEL }; },
  updateCard: async payload => updates.push(payload),
  openDm: async () => "", post: async () => { throw new Error("No public bearer links"); },
};
registerTransport("msteams", { getConnector: () => connector });
after(() => unregisterTransport("msteams"));
async function begin(extra = {}) {
  const pending = requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: AUTHOR, threadKey: "group:1", toolName: "Review plan", toolInput: { details: "Exact action preview" }, approvalType: "agent", ...extra });
  await new Promise(resolve => setImmediate(resolve));
  const latest = cards.at(-1);
  return { pending, id: latest.card.actions[0].data.id, conversationId: CHANNEL, messageId: String(cards.length), actorId: AUTHOR, decision: "approve" };
}
test("native Teams card resolves only its exact conversation/message and authorized actor", async () => {
  const request = await begin();
  assert.equal(cards.at(-1).card.type, "AdaptiveCard");
  for (const invalid of [{ conversationId: "teams:19:other@thread.v2" }, { messageId: "forged" }, { actorId: "29:stranger" }, { scope: "forever" }]) {
    assert.equal((await handlePlatformApproval({ ...request, ...invalid })).ok, false);
    assert.ok(lookupApproval(request.id).entry);
  }
  const [first, second] = await Promise.all([handlePlatformApproval(request), handlePlatformApproval(request)]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.equal((await request.pending).allow, true);
  assert.equal(updates.at(-1).messageId, request.messageId);
  assert.equal((await handlePlatformApproval(request)).code, 409);
});
test("revoked requester cannot resolve and native admin tier is enforced", async () => {
  const request = await begin({ requiredTier: "admin" });
  assert.equal((await handlePlatformApproval(request)).code, 403);
  await setUser(AUTHOR, { approved: false });
  const { canResolveApproval } = await import("../src/slack/approvals.js");
  assert.equal((await canResolveApproval(lookupApproval(request.id).entry, AUTHOR)).allowed, false);
  assert.equal((await handlePlatformApproval({ ...request, decision: "deny" })).code, 403);
  assert.equal((await handlePlatformApproval({ ...request, actorId: ADMIN, decision: "deny", comment: "Revise it" })).ok, true);
  assert.equal((await request.pending).comment, "Revise it");
  await setUser(AUTHOR, { approved: true });
});
test("durable Teams approval uses shared CAS and executes once", async () => {
  let executions = 0;
  setDurableApprovalExecutor(async () => { executions++; return { ok: true, completed: true, message: "Applied" }; });
  const request = await begin({ durableAction: { kind: "background_shell", channelId: CHANNEL, slug: SLUG, authorId: AUTHOR, threadKey: "group:durable", command: "echo fixture" } });
  assert.equal((await request.pending).pending, true);
  const responses = await Promise.all([handlePlatformApproval(request), handlePlatformApproval(request)]);
  assert.equal(responses.filter(result => result.ok).length, 1);
  assert.equal(executions, 1);
  setDurableApprovalExecutor(null);
});
test("Teams native approvals stay in their source thread even when browser links are enabled", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  const { getDb } = await import("../src/db/index.js");
  saveSettings({ publicUrl: "https://gateway.example.test", approvalLinks: "always", aiTestingUsers: [AUTHOR] });
  const original = { post: connector.post, openDm: connector.openDm };
  let privateAttempts = 0;
  connector.openDm = async () => { privateAttempts++; return "a:private"; };
  connector.post = async () => { privateAttempts++; return { messageId: "private-link" }; };
  const linkCount = () => getDb().prepare("SELECT count(*) AS count FROM approval_link_tokens").get().count;
  const before = linkCount();
  setDurableApprovalExecutor(async () => ({ ok: true, completed: true, message: "Applied" }));
  try {
    for (const durable of [false, true]) {
      const request = await begin({ threadKey: "123456",
        ...(durable ? { durableAction: { kind: "background_shell", channelId: CHANNEL, slug: SLUG,
          authorId: AUTHOR, threadKey: "123456", command: "echo no-dm-fixture" } } : {}) });
      assert.equal(cards.at(-1).conversationId, CHANNEL);
      assert.equal(cards.at(-1).threadKey, "123456");
      assert.equal(cards.at(-1).ephemeralTo, undefined);
      assert.doesNotMatch(JSON.stringify(cards.at(-1)), /\/approve\//);
      assert.equal((await handlePlatformApproval(request)).ok, true);
      await request.pending;
    }
    assert.equal(privateAttempts, 0);
    assert.equal(linkCount(), before, "Teams must not even mint supplemental bearer links");
  } finally {
    Object.assign(connector, original); setDurableApprovalExecutor(null);
    saveSettings({ publicUrl: "", approvalLinks: "auto", aiTestingUsers: [] });
  }
});
test("unavailable Teams cards refuse safely with retry guidance in the original thread and no DM", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  saveSettings({ publicUrl: "https://gateway.example.test", approvalLinks: "auto" });
  const original = { postCard: connector.postCard, post: connector.post, openDm: connector.openDm };
  const posts = [];
  let privateAttempts = 0;
  connector.postCard = async () => { throw new Error("Card unavailable"); };
  connector.post = async payload => { posts.push(payload); return { messageId: "fallback-notice", conversationId: payload.conversationId }; };
  connector.openDm = async () => { privateAttempts++; return "a:private"; };
  try {
    for (const durable of [false, true]) {
      const outcome = await requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: AUTHOR,
        threadKey: "123457", toolName: "Fallback plan", approvalType: "agent", toolInput: { details: "Exact plan" },
        ...(durable ? { durableAction: { kind: "background_shell", channelId: CHANNEL, slug: SLUG,
          authorId: AUTHOR, threadKey: "123457", command: "echo failed-card-fixture" } } : {}) });
      assert.equal(outcome.allow, false);
      assert.equal(outcome.pending, undefined);
      assert.match(outcome.reason, /Retry the original request here/);
      assert.equal(posts.at(-1).conversationId, CHANNEL);
      assert.equal(posts.at(-1).threadKey, "123457");
      assert.match(posts.at(-1).text, /No action was approved/);
      assert.match(posts.at(-1).text, /administrator.*Teams card delivery/);
      assert.doesNotMatch(posts.at(-1).text, /\/approve\/|private chat/);
    }
    assert.equal(posts.length, 2);
    assert.equal(privateAttempts, 0);
  } finally { Object.assign(connector, original); saveSettings({ publicUrl: "", approvalLinks: "auto" }); }
});
test("Google Chat retains private link delivery when native approval controls are absent", async () => {
  const { approvalDeliveryFor } = await import("../src/platforms/approval-delivery.js");
  const posts = [];
  const google = { platform: "googlechat", ready: () => true,
    post: async payload => { posts.push(payload); return { messageId: String(posts.length) }; },
    openDm: async userId => { assert.equal(userId, "users/requester"); return "gchat:spaces/private"; },
  };
  registerTransport("googlechat", { getConnector: () => google });
  try {
    const delivery = approvalDeliveryFor("gchat:spaces/source");
    assert.equal(delivery.supportsPrivateLinks, true);
    await delivery.post({ threadKey: "spaces/source/threads/thread", title: "Review plan" });
    assert.equal(delivery.requiresLinks, true);
    assert.equal(posts[0].conversationId, "gchat:spaces/source");
    assert.match(posts[0].text, /private chat/);
    await delivery.privately({ userId: "users/requester", text: "fixture-private-link" });
    assert.equal(posts[1].conversationId, "gchat:spaces/private");
    assert.equal(posts[1].text, "fixture-private-link");
  } finally { unregisterTransport("googlechat"); }
});
