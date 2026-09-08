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
test("unavailable native cards never put private approval links in the shared chat", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  saveSettings({ publicUrl: "https://gateway.example.test", approvalLinks: "auto" });
  const original = { postCard: connector.postCard, post: connector.post, openDm: connector.openDm };
  const posts = [];
  connector.postCard = async () => { throw new Error("Card unavailable"); };
  connector.post = async payload => { posts.push(payload); return { messageId: "fallback-notice", conversationId: payload.conversationId }; };
  connector.openDm = async () => "";
  try {
    const outcome = await requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: AUTHOR,
      threadKey: "group:fallback", toolName: "Fallback plan", approvalType: "agent", toolInput: { details: "Exact plan" } });
    assert.equal(outcome.allow, false);
    assert.match(outcome.reason, /private decision links could not be delivered/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].conversationId, CHANNEL);
    assert.equal(posts[0].text.includes("/approve/"), false);
  } finally { Object.assign(connector, original); saveSettings({ publicUrl: "", approvalLinks: "auto" }); }
});
