import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createGoogleChatControls } = await import('../src/platforms/googlechat/controls.js');
const { parseSettingsCommand } = await import('../src/platforms/googlechat/settings-commands.js');
const { parseChatEvent, eventShape } = await import('../src/platforms/googlechat/events.js');
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import('../src/config/store.js');
const { getThreadEffort } = await import('../src/gateway/thread-engine.js');

let index = 0;
async function fixture({ admin = true } = {}) {
  const i = ++index, owner = `cmd-owner${i}@example.com`, raw = `spaces/cmd${i}`, channelId = `gchat:${raw}`;
  await setUser(owner, { approved: true, isAdmin: admin, googleChatUserName: `users/cmd${i}` });
  const entry = await upsertChannelEntry(channelId, { name: 'Chat commands', platform: 'googlechat', type: 'channel', isDM: false });
  await saveChannelMeta(entry.slug, { channelId, platform: 'googlechat', access: 'approved', manageAccess: 'admins', mode: 'worker', allowBash: true, engine: 'claude', allowNetwork: false });
  const replies = [], posts = [];
  const authorize = async () => ({ entry, meta: await getChannelMeta(entry.slug), userIsAdmin: admin, userId: owner, members: [{ id: owner, name: 'Owner' }] });
  const connector = { botUserId: 'users/bot', api: { listMembers: async () => [{ id: `users/cmd${i}`, email: owner, name: 'Owner' }] },
    postCard: async payload => { posts.push(payload); return { messageId: `${raw}/messages/p${posts.length}` }; }, updateCard: async () => {} };
  const controls = createGoogleChatControls({ connector, authorize, publicUrl: () => 'https://gateway.example', log: { warn() {} } });
  const message = { conversationId: channelId, rawConversationId: raw, userId: owner, threadKey: `${raw}/threads/t`, raw: { senderName: `users/cmd${i}` } };
  const command = text => controls.onCommand({ message: { ...message, text }, entry, meta: {}, sessionKey: 'cmd-session', reply: async text => replies.push(text) });
  return { entry, replies, posts, command };
}

test('parser maps typed settings to the guarded card actions and rejects anything else', () => {
  assert.deepEqual(parseSettingsCommand('auto on'), { action: 'settings.access', data: { field: 'autoMode', access_autoMode: 'on' } });
  assert.deepEqual(parseSettingsCommand('Mode Read'), { action: 'settings.access', data: { field: 'mode', access_mode: 'read' } });
  assert.deepEqual(parseSettingsCommand('managers members'), { action: 'settings.access', data: { field: 'manageAccess', access_manageAccess: 'members' } });
  assert.deepEqual(parseSettingsCommand('vpn off'), { action: 'settings.vpn', data: { enabled: false } });
  assert.deepEqual(parseSettingsCommand('effort high'), { action: 'settings.runtime', data: { scope: 'thread', field: 'effort', thread_effort: 'high' } });
  assert.deepEqual(parseSettingsCommand('channel model default'), { action: 'settings.runtime', data: { scope: 'channel', field: 'model', channel_model: '__default__' } });
  for (const bad of ['', 'help', 'auto maybe', 'network', 'allowedUsers a@b.c', 'thread model', 'mode admin now']) assert.match(parseSettingsCommand(bad).error, /\/settings mode read\|worker\|admin/);
});

test('typed commands change settings through the shared policy and report the outcome', async () => {
  const f = await fixture();
  await f.command('/settings network on');
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, true);
  await f.command('/settings auto on');
  assert.equal((await getChannelMeta(f.entry.slug)).autoMode, true);
  await f.command('/settings effort high');
  assert.equal(await getThreadEffort(f.entry.slug, 'cmd-session'), 'high');
  assert.equal(f.replies.length, 3);
  for (const reply of f.replies) assert.match(reply, /saved|updated/i);
  await f.command('/settings auto sometimes');
  assert.match(f.replies.at(-1), /Use `\/settings auto on\|off`/);
  assert.equal(f.posts.length, 0, 'a typed change posts no card');
});

test('typed commands keep the manager check', async () => {
  const f = await fixture({ admin: false });
  await f.command('/settings network on');
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  assert.equal(f.replies.length, 1);
  assert.doesNotMatch(f.replies[0], /saved/i);
});

test('the /settings card lists the typed commands', async () => {
  const f = await fixture();
  await f.command('/settings');
  assert.equal(f.posts.length, 1);
  assert.match(JSON.stringify(f.posts[0].card.sections[0].widgets[0]), /settings auto on\|off/);
});

test('event shape names keys and types only, never values', () => {
  const envelope = { chat: { user: { name: 'users/1', email: 'secret@example.com' }, buttonClickedPayload: { message: { text: 'private words' } } }, commonEventObject: {} };
  const shape = eventShape(envelope, { 'ce-type': 'google.workspace.chat.button.v1.clicked' });
  assert.equal(shape, 'ce-type=google.workspace.chat.button.v1.clicked type=- keys=[chat,commonEventObject] chat=[user,buttonClickedPayload]');
  assert.doesNotMatch(eventShape({ type: 'has spaces <x>', chat: {} }), /spaces|<x>/);
  assert.equal(parseChatEvent(envelope).type, 'card');
});
