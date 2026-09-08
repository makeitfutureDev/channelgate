import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { teamsWorkspaceContext } = await import('../src/platforms/msteams/workspace-access.js');
const { upsertChannelEntry, saveChannelMeta, setUser } = await import('../src/config/store.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'teams-controls-'));
await writeFile(path.join(root, 'hello.txt'), 'hello');
const message = text => ({ text, trigger: 'message', conversationId: 'teams:19:source@thread.v2', rawConversationId: '19:source@thread.v2', userId: '29:owner', isDM: false });
const invoke = (data, action = 'files.browse', actor = '29:owner', conversation = 'a:private') => ({ type: 'invoke', name: 'adaptiveCard/action', id: 'invoke-1', replyToId: 'card1', from: { id: actor }, conversation: { id: conversation, conversationType: 'personal' }, serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { action: { type: 'Action.Execute', verb: action, data } } });
function fixture(extra = {}) {
  const sent = [], commands = [], replies = [];
  const connector = { api: { sendActivity: async () => ({ messageId: 'file-consent' }) }, updateCard: async value => sent.push(value), openDm: async () => 'a:private', postCard: async value => { sent.push(value); return { messageId: 'card1' }; } };
  const controls = createTeamsControls({ connector, authorize: async () => ({ root, meta: { allowBash: true }, userIsAdmin: true }), publicUrl: () => 'https://gateway.example', ...extra });
  const args = text => ({ message: message(text), sessionKey: 'group:root', entry: { slug: 'source' }, meta: { engine: 'claude' }, authorIsAdmin: true, reply: async text => replies.push(text), controls: { command: async input => { commands.push(input.message.text); await input.reply(input.message.text.startsWith('/model') ? 'Session engine: claude' : 'Session effort: default'); return true; } } });
  return { controls, args, sent, commands, replies };
}
test('files are sent privately and browser actions preserve original workspace identity', async () => {
  const f = fixture(); await f.controls.onCommand(f.args('/files'));
  assert.equal(f.sent[0].conversationId, 'a:private');
  const action = f.sent[0].card.body.find(item => item.type === 'ActionSet').actions[0];
  assert.equal(action.data.relative, 'hello.txt');
  const result = await f.controls.onInvoke(invoke(action.data, action.verb));
  assert.equal(result.body.value.body[0].text, 'File');
  assert.match(result.body.value.actions[0].url, /\/file-download\/open\//);
});
test('foreign actor/conversation and expired controls cannot use file grants', async () => {
  let time = 0; const f = fixture({ now: () => time }); await f.controls.onCommand(f.args('/files'));
  const data = f.sent[0].card.actions[0].data;
  for (const [actor, conversation] of [['29:other', 'a:private'], ['29:owner', 'a:other']]) {
    const result = await f.controls.onInvoke(invoke(data, 'files.browse', actor, conversation));
    assert.equal(result.body.value.body[0].text, 'Action could not be completed');
  }
  time = 16 * 60_000;
  const result = await f.controls.onInvoke(invoke(data)); assert.equal(result.body.value.body[0].text, 'Action could not be completed');
});
test('reaction content never opens native commands; failed private delivery does not expose file list', async () => {
  const f = fixture(); const args = f.args('/files'); args.message.trigger = 'reaction';
  assert.equal(await f.controls.onCommand(args), false); assert.equal(f.sent.length, 0);
  const failed = fixture({ connector: { api: { sendActivity: async () => ({}) }, openDm: async () => '' } });
  assert.equal(await failed.controls.onCommand(failed.args('/files')), true);
  assert.match(failed.replies[0], /personal chat/);
});
test('model form uses existing controls and consumes its state on a successful submit', async () => {
  const f = fixture(); await f.controls.onCommand(f.args('/settings'));
  const stateId = f.sent[0].card.actions[0].data.stateId;
  const payload = { stateId, engine: 'claude', model: 'default', effort: 'default' };
  await f.controls.onInvoke(invoke(payload, 'model.save', '29:owner', '19:source@thread.v2'));
  assert.deepEqual(f.commands, ['/model claude default', '/effort default']);
  await f.controls.onInvoke(invoke(payload, 'model.save', '29:owner', '19:source@thread.v2')); assert.equal(f.commands.length, 2);
});
test('approval invocation trusts envelope identity over malicious card data', async () => {
  let received;
  const f = fixture({ approval: async input => { received = input; return { ok: true, outcome: 'approved' }; } });
  await f.controls.onInvoke(invoke({ id: 'approval', decision: 'approve', actorId: '29:admin', conversationId: 'teams:other', messageId: 'forged' }, 'approval.respond'));
  assert.equal(received.actorId, '29:owner'); assert.equal(received.conversationId, 'teams:a:private'); assert.equal(received.messageId, 'card1');
});
test('workspace access repeats live approval and roster membership', async () => {
  const channelId = 'teams:19:access@thread.v2', ownerId = '29:access-owner';
  const entry = await upsertChannelEntry(channelId, { name: 'access', platform: 'msteams', type: 'mpim' });
  await saveChannelMeta(entry.slug, { channelId, platform: 'msteams', workDir: root, access: 'approved' });
  await setUser(ownerId, { approved: true });
  const grant = { channelId, ownerId, slug: entry.slug };
  const connector = { api: { listMembers: async () => [{ id: ownerId }] } };
  assert.equal((await teamsWorkspaceContext(grant, { connector })).entry.slug, entry.slug);
  await assert.rejects(teamsWorkspaceContext(grant, { connector: { api: { listMembers: async () => [] } } }), /membership/);
  await setUser(ownerId, { approved: false }); await assert.rejects(teamsWorkspaceContext(grant, { connector }), /no longer allowed/);
});

test('legacy Submit explicitly updates its private card', async () => {
  const f = fixture(); await f.controls.onCommand(f.args('/files'));
  const action = f.sent[0].card.actions[0];
  const activity = invoke(action.data); activity.type = 'message'; delete activity.name; activity.value = { ...action.data, cgAction: 'files.browse' };
  const result = await f.controls.onInvoke(activity);
  assert.deepEqual(result, { status: 200, body: {} });
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].messageId, 'card1'); assert.equal(f.sent[1].conversationId, 'a:private');
});

test('settings stay in the source thread and reject another actor or conversation', async () => {
  const f = fixture(); const args = f.args('/settings'); args.message.threadKey = 'root-message';
  await f.controls.onCommand(args);
  assert.equal(f.sent[0].conversationId, args.message.rawConversationId);
  assert.equal(f.sent[0].threadKey, 'root-message');
  assert.deepEqual(f.replies, []);
  const data = { ...f.sent[0].card.actions[0].data, engine: 'claude', model: 'default', effort: 'default' };
  for (const [actor, conversation] of [['29:other', args.message.rawConversationId], ['29:owner', 'a:private']]) {
    const result = await f.controls.onInvoke(invoke(data, 'model.save', actor, conversation));
    assert.equal(result.body.value.body[0].text, 'Action could not be completed');
  }
  assert.deepEqual(f.commands, []);
});
