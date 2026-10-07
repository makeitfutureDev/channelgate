// Durable control-plane approvals (src/gateway/control-plane-approvals.js) and the tier-by-scope
// secret cards (src/gateway/secret-host-approvals.js) — operator decision 2026-10-07, minimum
// second-approval cards. The end-to-end gate (the stdio MCP server posting the saved action and
// the executor applying it) is test/mcp-control-plane-approval.test.js; this file pins the pieces
// that file cannot reach: the secret-argument stash across a restart, the action key, and who may
// click a secret's card.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const cp = await import("../src/gateway/control-plane-approvals.js");
const { approvalActionKey } = await import("../src/gateway/approval-requests.js");
const secretHost = await import("../src/gateway/secret-host-approvals.js");
const scoped = await import("../src/config/scoped-env.js");
const { patchChannelEnv } = await import("../src/config/channel-env.js");
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");

const SLUG = "cp-approvals";
const CHANNEL = "C_CP_APPROVALS";
const ADMIN = "U_CP_ADMIN";
const MEMBER = "U_CP_MEMBER";
const OTHER = "U_CP_OTHER"; // approved, works in the channel, owns nothing here
const STRANGER = "U_CP_STRANGER";

await setUser(ADMIN, { name: "CP Admin", approved: true, isAdmin: true });
await setUser(MEMBER, { name: "CP Member", approved: true, isAdmin: false });
await setUser(OTHER, { name: "CP Other", approved: true, isAdmin: false });
const entry = await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), channelId: CHANNEL, access: "approved" });

const ctx = { channelId: CHANNEL, slug: SLUG, createdBy: ADMIN, threadKey: "1700000000.000100" };

test("a secret argument never rides the saved action: it is stashed under the approval id and a restart loses it loudly", async () => {
  const action = cp.buildControlPlaneAction(ctx, { tool: "add_skill_source", args: { kind: "gateway", url: "https://peer.example", token: "peer-token-value", mode: "review" }, tier: "admin" });
  const { action: stored, secrets } = cp.splitControlPlaneSecrets(action);
  assert.deepEqual(stored.args, { kind: "gateway", url: "https://peer.example", mode: "review" });
  assert.deepEqual(stored.secretArgNames, ["token"]);
  assert.deepEqual(secrets, { token: "peer-token-value" });
  assert.doesNotMatch(JSON.stringify(stored), /peer-token-value/, "the persisted row carries no token");
  // No token given → nothing stashed, nothing recorded.
  const plain = cp.splitControlPlaneSecrets(cp.buildControlPlaneAction(ctx, { tool: "add_skill_source", args: { kind: "github", url: "https://github.com/x/y" }, tier: "admin" }));
  assert.equal(plain.secrets, null);
  assert.deepEqual(plain.action.secretArgNames, []);

  cp.stashControlPlaneSecrets("appr-1", secrets);
  assert.deepEqual(cp.takeControlPlaneSecrets("appr-1"), { token: "peer-token-value" });
  assert.equal(cp.takeControlPlaneSecrets("appr-1"), null, "taken once");

  // After a restart the stash is empty: the executor names the remedy instead of adding a
  // half-formed source.
  const calls = [];
  cp.setControlPlaneInvoker(async (call) => { calls.push(call); return { ok: true, text: "✅ added" }; });
  try {
    const lost = await cp.executeControlPlaneApproval({ id: "appr-2", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: ADMIN, decidedBy: ADMIN, action: stored });
    assert.equal(lost.ok, false);
    assert.match(lost.error, /`token` given with this request was not kept across a gateway restart\. Call add_skill_source again/);
    assert.equal(calls.length, 0, "nothing was invoked");
    // Re-armed (the same exact request after the restart re-stashes it): applied with the token.
    cp.stashControlPlaneSecrets("appr-3", secrets);
    const applied = await cp.executeControlPlaneApproval({ id: "appr-3", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: ADMIN, decidedBy: ADMIN, action: stored });
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(calls[0].args, { kind: "gateway", url: "https://peer.example", mode: "review", token: "peer-token-value" });
    assert.equal(calls[0].authorId, ADMIN);
    assert.match(applied.message, /added/);
  } finally {
    cp.__resetControlPlaneApprovals();
  }
});

test("the executor fails closed without an invoker, and a refusal from the handler is a failure, not a consumed success", async () => {
  cp.__resetControlPlaneApprovals();
  const action = cp.buildControlPlaneAction(ctx, { tool: "set_channel_admin_mode", args: { enabled: true }, tier: "admin" });
  const record = { id: "appr-4", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: ADMIN, decidedBy: ADMIN, action };
  const unwired = await cp.executeControlPlaneApproval(record);
  assert.equal(unwired.ok, false);
  assert.match(unwired.error, /cannot apply saved control-plane approvals right now/);
  cp.setControlPlaneInvoker(async () => ({ ok: true, text: "🚫 Only admins can change this channel's admin mode." }));
  try {
    const refused = await cp.executeControlPlaneApproval(record);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Only admins/);
    // Wrong tier value, not-executing rows and foreign kinds are refused before any invocation.
    assert.match((await cp.executeControlPlaneApproval({ ...record, status: "pending" })).error, /Invalid saved/);
    assert.match((await cp.executeControlPlaneApproval({ ...record, action: { ...action, tier: "root" } })).error, /Invalid saved/);
    assert.match((await cp.executeControlPlaneApproval({ ...record, action: { ...action, kind: "secret_host" } })).error, /Invalid saved/);
    assert.throws(() => cp.buildControlPlaneAction(ctx, { tool: "x", tier: "root" }), /Unknown approval tier/);
  } finally {
    cp.__resetControlPlaneApprovals();
  }
});

test("the executor checks the clicker's tier: owner, member, manager", async () => {
  cp.__resetControlPlaneApprovals();
  const calls = [];
  cp.setControlPlaneInvoker(async (call) => { calls.push(call); return { ok: true, text: "✅ done" }; });
  try {
    const owner = cp.buildControlPlaneAction({ ...ctx, createdBy: MEMBER }, { tool: "set_secret_mode", args: { name: "MINE", mode: "readable" }, tier: "owner" });
    const ownerRecord = { id: "o1", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: MEMBER, action: owner };
    assert.match((await cp.executeControlPlaneApproval({ ...ownerRecord, decidedBy: OTHER })).error, /Only you \(the requester\) can approve this/);
    assert.equal((await cp.executeControlPlaneApproval({ ...ownerRecord, decidedBy: MEMBER })).ok, true, "the owner's own click");
    assert.equal((await cp.executeControlPlaneApproval({ ...ownerRecord, decidedBy: ADMIN })).ok, true, "an admin can always");

    const member = cp.buildControlPlaneAction({ ...ctx, createdBy: MEMBER }, { tool: "set_secret_mode", args: { name: "CHAN", mode: "readable", scope: "conversation" }, tier: "" });
    const memberRecord = { id: "m1", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: MEMBER, action: member };
    assert.match((await cp.executeControlPlaneApproval({ ...memberRecord, decidedBy: STRANGER })).error, /Only anyone working in this channel can approve this/);
    assert.equal((await cp.executeControlPlaneApproval({ ...memberRecord, decidedBy: OTHER })).ok, true, "another member working here");

    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), manageAccess: "admins" });
    const manage = cp.buildControlPlaneAction(ctx, { tool: "set_channel_bash", args: { enabled: true }, tier: "manage" });
    const manageRecord = { id: "g1", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: ADMIN, action: manage };
    assert.match((await cp.executeControlPlaneApproval({ ...manageRecord, decidedBy: MEMBER })).error, /Only one of this channel's managers/);
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), manageAccess: "members" });
    assert.equal((await cp.executeControlPlaneApproval({ ...manageRecord, decidedBy: MEMBER })).ok, true, "members manage where the channel lets them");
    // The requester's authority is re-checked too: a manager-tier row whose requester lost it.
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), manageAccess: "admins" });
    const lapsed = { ...manageRecord, authorId: MEMBER, action: { ...manage, authorId: MEMBER }, decidedBy: ADMIN };
    assert.match((await cp.executeControlPlaneApproval(lapsed)).error, /requester no longer manages/);
    assert.equal(calls.length, 4, "owner, admin, other member, managing member — and nothing for the refusals");
  } finally {
    cp.__resetControlPlaneApprovals();
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), manageAccess: "members" });
  }
});

test("the action key tells exact calls apart and ignores argument order", () => {
  const base = cp.buildControlPlaneAction(ctx, { tool: "add_org_skills", args: { slugs: ["a", "b"] }, tier: "admin" });
  assert.equal(approvalActionKey(base), approvalActionKey({ ...base }));
  assert.notEqual(approvalActionKey(base), approvalActionKey({ ...base, args: { slugs: ["a"] } }), "different arguments");
  assert.notEqual(approvalActionKey(base), approvalActionKey({ ...base, tool: "remove_org_skills" }), "different tool");
  assert.notEqual(approvalActionKey(base), approvalActionKey({ ...base, authorId: MEMBER }), "different requester");
  const ordered = cp.buildControlPlaneAction(ctx, { tool: "update_skill_template", args: { template: "dev", add: ["x"] }, tier: "admin" });
  const reordered = cp.buildControlPlaneAction(ctx, { tool: "update_skill_template", args: { add: ["x"], template: "dev" }, tier: "admin" });
  assert.equal(approvalActionKey(ordered), approvalActionKey(reordered));
});

test("a secret's host card is approved by its scope's tier: admin, anyone in the channel, or the owner", async () => {
  assert.deepEqual(["organization", "channel", "personal"].map(secretHost.secretHostTier), ["admin", "", "owner"]);
  const metaBefore = await getChannelMeta(SLUG);
  await saveChannelMeta(SLUG, { ...metaBefore, env: patchChannelEnv(metaBefore.env || {}, { set: { name: "CHAN_PAY", value: "chan-pay-value-1234567" } }) });
  await scoped.patchUserEnv(MEMBER, { set: { name: "MY_PAY", value: "my-pay-value-1234567" } });
  try {
    const chanEntry = await scoped.getSecretEntry({ scope: "channel", slug: SLUG, name: "CHAN_PAY" });
    const chan = { kind: secretHost.SECRET_HOST_ACTION, channelId: CHANNEL, slug: SLUG, authorId: MEMBER, threadKey: "1.1", secretName: "CHAN_PAY", scope: "channel", ownerId: "", host: "api.pay.example", entrySetAt: chanEntry.setAt };
    const chanRecord = { id: "s1", status: "executing", channelId: CHANNEL, slug: SLUG, authorId: MEMBER, action: chan };
    assert.match((await secretHost.executeSecretHostApproval({ ...chanRecord, decidedBy: STRANGER })).error, /Only someone working in this channel/);
    const byOther = await secretHost.executeSecretHostApproval({ ...chanRecord, decidedBy: OTHER });
    assert.equal(byOther.ok, true, byOther.error);
    assert.deepEqual((await scoped.getSecretEntry({ scope: "channel", slug: SLUG, name: "CHAN_PAY" })).approvedHosts, ["api.pay.example"]);

    const mineEntry = await scoped.getSecretEntry({ scope: "personal", userId: MEMBER, name: "MY_PAY" });
    const mine = { ...chan, secretName: "MY_PAY", scope: "personal", ownerId: MEMBER, host: "api.mine.example", entrySetAt: mineEntry.setAt };
    const mineRecord = { ...chanRecord, id: "s2", action: mine };
    assert.match((await secretHost.executeSecretHostApproval({ ...mineRecord, decidedBy: OTHER })).error, /Only the owner of a personal secret/);
    const byOwner = await secretHost.executeSecretHostApproval({ ...mineRecord, decidedBy: MEMBER });
    assert.equal(byOwner.ok, true, byOwner.error);
    assert.deepEqual((await scoped.getSecretEntry({ scope: "personal", userId: MEMBER, name: "MY_PAY" })).approvedHosts, ["api.mine.example"]);
  } finally {
    await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), env: metaBefore.env || {} });
    await scoped.patchUserEnv(MEMBER, { remove: "MY_PAY" });
  }
});
