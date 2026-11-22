// Channel API tokens from Slack Settings → API tokens and the Activity dashboard's Settings → API
// tokens section: one ownership rule shared with the agent tools (src/gateway/api-tokens.js), the
// Slack page and its create/revoke handlers, and the dashboard's per-conversation view module.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/store.js");
const tokens = await import("../src/gateway/api-tokens.js");
const view = await import("../src/gateway/api-tokens-view.js");
const { saveSettingsForm, revokeSettingsApiToken } = await import("../src/slack/app.js");
const { buildChannelSettingsView, settingsFormSpec, parseSettingsMetadata } = await import("../src/slack/channel-settings.js");
const { activityPage } = await import("../src/web/activity-page.js");

await store.ensureRoot();
async function channel(id, name, patch = {}) {
  const entry = await store.upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: id, name, type: "channel", isDM: false }), access: "approved", manageAccess: "admins", platform: "slack", ...patch });
  return { ...entry, channelId: id };
}
const main = await channel("CTUIMAIN", "tui-main");
const other = await channel("CTUIOTHER", "tui-other");
const members = await channel("CTUIMEMBERS", "tui-members", { manageAccess: "members" });
const dm = { ...(await store.upsertChannelEntry("DTUIMINE", { name: "dm", type: "im", isDM: true })), channelId: "DTUIMINE" };
const theirDm = { ...(await store.upsertChannelEntry("DTUITHEIRS", { name: "dm2", type: "im", isDM: true })), channelId: "DTUITHEIRS" };
await store.patchChannelMeta(dm.slug, { dmUserId: "U_TUI_MEMBER" });
await store.patchChannelMeta(theirDm.slug, { dmUserId: "U_TUI_ADMIN" });
await store.setUser("U_TUI_ADMIN", { name: "Ada Admin", approved: true, isAdmin: true });
await store.setUser("U_TUI_MEMBER", { name: "Mel Member", approved: true, isAdmin: false });
await store.setUser("U_TUI_PEER", { name: "Pat Peer", approved: true, isAdmin: false });
const meta = async (entry) => store.getChannelMeta(entry.slug);

test("shared rule: a member sees and revokes only their own; a manager or admin every token of the conversation", () => {
  const mine = tokens.createApiToken({ name: "mine", channelId: main.channelId, slug: main.slug, createdBy: "U_TUI_MEMBER" });
  const peer = tokens.createApiToken({ name: "peer", channelId: main.channelId, slug: main.slug, createdBy: "U_TUI_PEER" });
  const elsewhere = tokens.createApiToken({ name: "elsewhere", channelId: other.channelId, slug: other.slug, createdBy: "U_TUI_MEMBER" });
  const names = (list) => list.map((t) => t.name).sort();
  assert.deepEqual(names(tokens.conversationTokensFor({ channelId: main.channelId, userId: "U_TUI_MEMBER" })), ["mine"]);
  assert.deepEqual(names(tokens.conversationTokensFor({ channelId: main.channelId, userId: "U_TUI_MEMBER", manager: true })), ["mine", "peer"]);
  assert.deepEqual(tokens.conversationTokensFor({ channelId: main.channelId, userId: "" }), []);
  assert.throws(() => tokens.revokeConversationToken({ id: peer.record.id, channelId: main.channelId, userId: "U_TUI_MEMBER" }), { status: 403 });
  assert.throws(() => tokens.revokeConversationToken({ id: elsewhere.record.id, channelId: main.channelId, userId: "U_TUI_MEMBER", manager: true }), { status: 404 });
  assert.throws(() => tokens.revokeConversationToken({ id: "nope", channelId: main.channelId, userId: "U_TUI_MEMBER" }), { status: 404 });
  assert.equal(tokens.revokeConversationToken({ id: peer.record.id, channelId: main.channelId, userId: "U_TUI_ADMIN", manager: true }).revoked, true);
  assert.equal(tokens.revokeConversationToken({ id: mine.record.id, channelId: main.channelId, userId: "U_TUI_MEMBER" }).revoked, true);
  assert.throws(() => tokens.revokeConversationToken({ id: mine.record.id, channelId: main.channelId, userId: "U_TUI_MEMBER" }), { status: 409 });
  assert.deepEqual(tokens.conversationTokensFor({ channelId: main.channelId, userId: "U_TUI_MEMBER", manager: true, includeRevoked: false }), []);
});

test("Slack Settings → API tokens lists tokens with Revoke and a New token form, never a value", () => {
  const state = { channelId: main.channelId, slug: main.slug, threadTs: "", ownerId: "U_TUI_MEMBER" };
  const list = [
    { id: 7, name: "Make <flow>", prefix: "cgk_abcd", last4: "wxyz", createdBy: "U_TUI_MEMBER", createdAt: "2026-11-03T10:00:00.000Z", lastUsedAt: "", revoked: false },
    { id: 8, name: "gone", prefix: "cgk_efgh", last4: "qrst", createdBy: "U_TUI_MEMBER", createdAt: "2026-11-03T10:00:00.000Z", lastUsedAt: "", revoked: true },
  ];
  const built = buildChannelSettingsView({ apiTokens: { manager: false, tokens: list } }, state, { tab: "api" });
  assert.equal(parseSettingsMetadata(built.private_metadata).tab, "api");
  const text = JSON.stringify(built.blocks);
  assert.match(text, /Make &lt;flow&gt;/);
  assert.match(text, /cgk_abcd…wxyz/);
  assert.match(text, /Created by you 2026-11-03 · never used/);
  assert.doesNotMatch(text, /gone/, "revoked tokens are not listed");
  const revoke = built.blocks.find((block) => block.accessory?.action_id === "cg_channel_settings_api_token_revoke");
  assert.equal(JSON.parse(revoke.accessory.value).id, 7);
  assert.ok(revoke.accessory.confirm, "revoking asks first");
  assert.match(text, /\+ New token/);
  assert.match(text, /You see your own tokens/);
  const managerView = JSON.stringify(buildChannelSettingsView({ apiTokens: { manager: true, tokens: [{ ...list[0], createdBy: "U_TUI_PEER" }] } }, state, { tab: "api" }).blocks);
  assert.match(managerView, /Created by <@U_TUI_PEER>/);
  assert.match(managerView, /because you manage it/);
  const form = buildChannelSettingsView({ apiTokens: { manager: false, tokens: [] } }, { ...state, form: "tok-add:c" }, { tab: "api" });
  assert.ok(form.submit, "the open form gives the modal a Save button");
  assert.equal(settingsFormSpec("tok-add:c").fields[0].name, "name");
  assert.equal(settingsFormSpec("tok-add:p"), null, "a token always belongs to the conversation");
  // The legacy page name lands on the new page.
  assert.equal(parseSettingsMetadata(buildChannelSettingsView({}, state, { tab: "tokens" }).private_metadata).tab, "api");
});

test("Slack Settings saves a token for the clicker in this conversation and revokes by the shared rule", async () => {
  const ctx = async (clicker, entry = members) => ({ entry, meta: await meta(entry), clicker, userIsAdmin: clicker === "U_TUI_ADMIN", userIsApproved: true });
  assert.deepEqual(await saveSettingsForm("tok-add:c", { name: "  " }, await ctx("U_TUI_MEMBER")), { field: "name", error: "a token needs a name" });
  const saved = await saveSettingsForm("tok-add:c", { name: "CI deploy" }, await ctx("U_TUI_PEER"));
  const value = saved.notice.match(/`(cgk_[A-Za-z0-9_-]+)`/)[1];
  assert.match(saved.notice, /shown only this once/);
  assert.match(saved.notice, /curl -X POST .*\/api\/runs/);
  const record = tokens.resolveApiToken(value);
  assert.equal(record.createdBy, "U_TUI_PEER");
  assert.equal(record.channelId, members.channelId);
  // CTUIMAIN is admins-only to manage: a member cannot revoke a peer's token there…
  const peerMain = tokens.createApiToken({ name: "peer-main", channelId: main.channelId, slug: main.slug, createdBy: "U_TUI_PEER" });
  await assert.rejects(revokeSettingsApiToken(peerMain.record.id, await ctx("U_TUI_MEMBER", main)), { status: 403 });
  // …but in a channel whose members manage it, an approved member can.
  assert.match(await revokeSettingsApiToken(record.id, await ctx("U_TUI_MEMBER")), /Revoked `CI deploy`/);
  assert.equal(tokens.resolveApiToken(value), null);
  // A token from another conversation is never reachable through this one.
  await assert.rejects(revokeSettingsApiToken(peerMain.record.id, await ctx("U_TUI_ADMIN")), { status: 404 });
  assert.match(await revokeSettingsApiToken(peerMain.record.id, await ctx("U_TUI_ADMIN", main)), /Revoked/);
});

test("dashboard: conversations follow dashboard access, own DM only; tokens are minted for the session owner", async () => {
  const allowed = new Set([main.channelId, members.channelId, dm.channelId, theirDm.channelId]);
  const access = (user) => ({ user, allows: async (entry) => allowed.has(entry.channelId) });
  const member = access({ isAdmin: false, approved: true });
  const channels = await view.apiTokenChannels(member, "U_TUI_MEMBER");
  const ids = channels.map((c) => c.channelId);
  assert.equal(ids[0], dm.channelId, "your own DM comes first");
  assert.ok(ids.includes(main.channelId) && ids.includes(members.channelId));
  assert.ok(!ids.includes(theirDm.channelId), "another person's DM is never offered");
  assert.ok(!ids.includes(other.channelId), "a conversation you cannot access is never offered");
  await assert.rejects(view.apiTokenChannelView(member, "U_TUI_MEMBER", other.channelId), { status: 403 });
  await assert.rejects(view.createDashboardApiToken(member, "U_TUI_MEMBER", theirDm.channelId, "x"), { status: 403 });

  let authorized = 0;
  const minted = await view.createDashboardApiToken(member, "U_TUI_MEMBER", main.channelId, "Zapier", { authorize: async () => { authorized += 1; } });
  assert.equal(authorized, 1, "the session is re-checked before the write");
  assert.match(minted.token, /^cgk_/);
  assert.match(minted.example, new RegExp(minted.token));
  assert.equal(tokens.resolveApiToken(minted.token).createdBy, "U_TUI_MEMBER");
  const peer = tokens.createApiToken({ name: "peer-dash", channelId: main.channelId, slug: main.slug, createdBy: "U_TUI_PEER" });

  const mine = await view.apiTokenChannelView(member, "U_TUI_MEMBER", main.channelId);
  assert.equal(mine.manager, false);
  assert.deepEqual(mine.tokens.map((t) => t.name), ["Zapier"]);
  assert.equal(mine.tokens[0].mine, true);
  assert.doesNotMatch(JSON.stringify(mine), new RegExp(minted.token.slice(8)), "a listing never carries the value");
  assert.match(mine.example, /<token>/);

  const admin = access({ isAdmin: true, approved: true });
  const all = await view.apiTokenChannelView(admin, "U_TUI_ADMIN", main.channelId);
  assert.equal(all.manager, true);
  assert.deepEqual(all.tokens.map((t) => t.name).sort(), ["Zapier", "peer-dash"]);
  assert.equal(all.tokens.find((t) => t.name === "peer-dash").createdByName, "Pat Peer");

  await assert.rejects(view.revokeDashboardApiToken(member, "U_TUI_MEMBER", main.channelId, peer.record.id), { status: 403 });
  assert.equal((await view.revokeDashboardApiToken(admin, "U_TUI_ADMIN", main.channelId, peer.record.id)).revoked, true);
  assert.equal((await view.revokeDashboardApiToken(member, "U_TUI_MEMBER", main.channelId, minted.record.id)).revoked, true);
  assert.equal(tokens.resolveApiToken(minted.token), null);
});

test("dashboard Settings offers an API tokens section", () => {
  const { html } = activityPage({ sessionId: "s1", csrf: "c1", view: "settings" });
  assert.match(html, /\["api", "API tokens"\]/);
  assert.match(html, /\/api\/api-tokens/);
});
