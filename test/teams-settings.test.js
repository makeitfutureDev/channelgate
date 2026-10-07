import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, patchChannelMeta, setUser } = await import('../src/config/store.js');
const { addSchedule, listForChannel } = await import('../src/config/schedules.js');
const { getThreadEngine, setThreadEngine, getThreadModel } = await import('../src/gateway/thread-engine.js');
const { saveSession } = await import('../src/gateway/sessions.js');
const { adaptiveCardAttachment } = await import('../src/platforms/msteams/cards.js');
const { modelsForEngine, modelBelongsToEngine } = await import('../src/engines/registry.js');
const { getDb } = await import('../src/db/index.js');
let sequence = 0;
async function fixture({ admin = true, privateChat = true, personal = false } = {}) {
  const suffix = ++sequence, channelId = personal ? `teams:a:settings-${suffix}` : `teams:19:settings-${suffix}@thread.v2`, owner = `29:settings-${suffix}`;
  const entry = await upsertChannelEntry(channelId, { name: `Settings ${suffix}`, platform: 'msteams', type: personal ? 'dm' : 'mpim' });
  const meta = { channelId, isDM: personal, platform: 'msteams', engine: 'claude', access: 'approved', manageAccess: 'admins', allowBash: true, allowNetwork: false };
  await saveChannelMeta(entry.slug, meta); await setUser(owner, { approved: true, isAdmin: admin });
  const sent = [], replies = [];
  const connector = { botId: '28:bot', api: { sendActivity: async () => ({ messageId: 'file-consent' }), listMembers: async () => [{ id: owner, name: 'Settings owner' }] },
    postCard: async value => { adaptiveCardAttachment(value.card); sent.push(value); return { messageId: 'card1' }; },
    updateCard: async value => sent.push(value), openDm: async () => privateChat ? `a:private-${suffix}` : '' };
  const controls = createTeamsControls({ connector, publicUrl: () => 'https://gateway.example' });
  const args = command => ({ message: { text: command, trigger: 'message', conversationId: channelId,
    rawConversationId: channelId.slice(6), userId: owner, isDM: personal, threadKey: 'original-root' },
    entry, meta, sessionKey: 'original-session', authorIsAdmin: admin, reply: async value => replies.push(value) });
  const invoke = (data, action, actor = owner, destination = channelId.slice(6)) => controls.onInvoke({
    type: 'invoke', name: 'adaptiveCard/action', from: { id: actor }, conversation: { id: destination },
    replyToId: 'card1', serviceUrl: 'https://smba.trafficmanager.net/teams/',
    value: { action: { type: 'Action.Execute', verb: action, data } },
  });
  await controls.onCommand(args('/settings'));
  const stateId = sent[0]?.card.body.find(item => item.type === 'ActionSet').actions[0].data.stateId;
  return { controls, connector, sent, replies, args, invoke, entry, owner, channelId, stateId };
}
const value = result => result.body.value;
const input = (card, id) => card.body.find(item => item.id === id);
test('six settings pages stay in the source conversation and update the same card', async () => {
  const f = await fixture();
  assert.equal(f.sent[0].conversationId, f.channelId.slice(6));
  assert.equal(f.sent[0].threadKey, 'original-root');
  assert.equal(f.sent[0].text, 'Conversation settings');
  assert.deepEqual(f.replies, []);
  const menu = f.sent[0].card;
  assert.ok(!menu.body.some(item => item.type.startsWith('Input.')));
  assert.deepEqual(menu.actions, []);
  const tabs = menu.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions);
  assert.deepEqual(tabs.map(action => action.title), ['General', 'Variables', 'MCPs', 'Skills', 'Automations', 'Resume']);
  assert.equal(menu.body.at(-1).type, 'ActionSet');
  for (const page of ['general', 'secrets', 'mcp', 'skills', 'automations', 'resume']) {
    const action = tabs.find(item => item.data.page === page);
    const card = value(await f.invoke(action.data, action.verb));
    assert.equal(card.body[0].text, 'Channel settings');
    adaptiveCardAttachment(card);
    assert.equal(card.body.filter(item => item.type === 'ActionSet').slice(0, 2).flatMap(item => item.actions).length, 6);
    assert.equal(f.sent.at(-1).conversationId, f.channelId.slice(6));
    assert.equal(f.sent.at(-1).messageId, 'card1');
    assert.deepEqual(f.sent.at(-1).card, card);
    assert.ok(card.body.length > menu.body.length);
    assert.ok(card.body.filter(item => item.type === 'ActionSet').slice(0, 2).flatMap(item => item.actions).some(item => item.title === `• ${action.title}`));
    if (page !== 'general') assert.equal(input(card, 'channel_engine'), undefined);
  }
  const secrets = value(await f.invoke({ stateId: f.stateId, page: 'secrets' }, 'settings.page'));
  assert.ok(input(secrets, 'variableValue'));
  assert.equal(input(secrets, 'variableValue').value, '');
  assert.equal(input(secrets, 'variableValue').style, 'password');
});
test('/secrets opens Variables directly while /settings starts with the menu', async () => {
  const f = await fixture();
  assert.equal(input(f.sent[0].card, 'variableValue'), undefined);
  await f.controls.onCommand(f.args('/secrets'));
  const secrets = f.sent.at(-1).card;
  assert.ok(input(secrets, 'variableValue'));
  assert.ok(secrets.body.filter(item => item.type === 'ActionSet').slice(0, 2).flatMap(item => item.actions).some(item => item.title === '• Variables'));
});
test('combined runtime Apply actions save the chosen scope through Execute and Submit', async () => {
  const f = await fixture({ admin: false });
  const general = value(await f.invoke({ stateId: f.stateId, page: 'general' }, 'settings.page'));
  const applies = general.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions).filter(item => item.verb === 'settings.runtime.apply');
  assert.deepEqual(applies.map(item => item.title), ['Apply to channel', 'Apply to thread']);
  const channel = applies[0];
  const saved = value(await f.invoke({ ...channel.data, channel_engine: 'codex', channel_model: modelsForEngine('codex')[0].value,
    channel_effort: 'high', thread_engine: 'claude' }, channel.verb));
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), '');
  const thread = saved.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions).find(item => item.data?.scope === 'thread' && item.verb === 'settings.runtime.apply');
  const before = f.sent.length;
  const result = await f.controls.onInvoke({ type: 'message', from: { id: f.owner }, recipient: { id: '28:bot' },
    conversation: { id: f.channelId.slice(6) }, replyToId: 'forged-target', serviceUrl: 'https://smba.trafficmanager.net/teams/',
    value: { ...thread.fallback.data, thread_engine: 'claude', thread_model: modelsForEngine('claude')[0].value, thread_effort: 'high', channel_engine: 'claude' } });
  assert.deepEqual(result, { status: 200, body: {} });
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), 'claude');
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  assert.equal(f.sent.length, before + 1); assert.equal(f.sent.at(-1).messageId, 'card1');
});
test('Load models refreshes the same requester card through Execute and Submit without saving', async () => {
  const f = await fixture({ admin: false });
  const general = value(await f.invoke({ stateId: f.stateId, page: 'general' }, 'settings.page'));
  const load = general.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions).find(item => item.verb === 'settings.runtime.models' && item.data.scope === 'channel');
  assert.equal(load.title, 'Load models');
  assert.equal(load.associatedInputs, 'auto');
  assert.equal(load.fallback.associatedInputs, 'auto');
  const before = await getChannelMeta(f.entry.slug);
  const updated = value(await f.invoke({ ...load.data, channel_engine: 'codex', channel_model: '__default__', channel_effort: '__default__' }, load.verb));
  assert.ok(input(updated, 'channel_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'codex')));
  assert.equal(input(updated, 'channel_engine').value, 'codex');
  assert.deepEqual(await getChannelMeta(f.entry.slug), before);
  const sent = f.sent.length;
  await f.controls.onInvoke({ type: 'message', from: { id: f.owner }, recipient: { id: '28:bot' },
    conversation: { id: f.channelId.slice(6) }, replyToId: 'forged-target', serviceUrl: 'https://smba.trafficmanager.net/teams/',
    value: { ...load.fallback.data, channel_engine: 'claude', channel_model: '__default__', channel_effort: '__default__' } });
  assert.equal(f.sent.length, sent + 1);
  assert.equal(f.sent.at(-1).messageId, 'card1');
  assert.ok(input(f.sent.at(-1).card, 'channel_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'claude')));
  assert.deepEqual(await getChannelMeta(f.entry.slug), before);
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), '');
});
test('Resume permits current admins and protects admin sessions from members', async () => {
  for (const admin of [true, false]) {
    const f = await fixture({ admin, personal: true });
    await saveSession(f.entry.slug, 'original-session', 'admin-session', 'claude', null, JSON.stringify({ backend: 'container', scope: 'admin' }));
    const card = value(await f.invoke({ stateId: f.stateId, page: 'resume' }, 'settings.page'));
    if (admin) assert.match(input(card, 'resumeCommand')?.value || '', /admin-session/);
    else assert.equal(input(card, 'resumeCommand'), undefined);
    await saveSession(f.entry.slug, 'original-session', 'project-session', 'claude', null, JSON.stringify({ backend: 'container', scope: 'project' }));
    const projectCard = value(await f.invoke({ stateId: f.stateId, page: 'resume' }, 'settings.page'));
    assert.match(input(projectCard, 'resumeCommand')?.value || '', /project-session/);
  }
});
test('approved member runtime changes write only the dispatched field to the original scope', async () => {
  const f = await fixture({ admin: false });
  await setThreadEngine(f.entry.slug, 'original-session', 'codex');
  const result = value(await f.invoke({ stateId: f.stateId, scope: 'channel', field: 'model',
    channel_model: modelsForEngine('claude')[0].value, thread_engine: 'claude' }, 'settings.runtime'));
  assert.equal(result.body[0].text, 'Channel settings');
  assert.equal((await getChannelMeta(f.entry.slug)).model, modelsForEngine('claude')[0].value);
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), 'codex');
  const updated = value(await f.invoke({ stateId: f.stateId, scope: 'thread', field: 'model',
    thread_model: modelsForEngine('codex')[0].value, channel_model: 'forged' }, 'settings.runtime'));
  assert.equal(updated.body[0].text, 'Channel settings');
  assert.equal(await getThreadModel(f.entry.slug, 'original-session'), modelsForEngine('codex')[0].value);
});
test('settings do not require personal-chat delivery', async () => {
  const f = await fixture({ privateChat: false });
  assert.equal(f.sent[0].conversationId, f.channelId.slice(6));
  assert.deepEqual(f.replies, []);
});
test('Submit navigation updates the stored channel card once, ignoring a forged reply target', async () => {
  const f = await fixture();
  const skills = f.sent[0].card.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions).find(action => action.data.page === 'skills');
  assert.equal(skills.fallback.associatedInputs, 'none');
  const before = f.sent.length;
  const result = await f.controls.onInvoke({ type: 'message', from: { id: f.owner },
    conversation: { id: `${f.channelId.slice(6)};messageid=1760000000000` }, recipient: { id: '28:bot' },
    replyToId: 'forged-message', serviceUrl: 'https://smba.trafficmanager.net/teams/', value: skills.fallback.data });
  assert.deepEqual(result, { status: 200, body: {} });
  assert.equal(f.sent.length, before + 1);
  assert.equal(f.sent.at(-1).messageId, 'card1');
  assert.equal(f.sent.at(-1).conversationId, f.channelId.slice(6));
  assert.ok(f.sent.at(-1).card.body.some(item => item.text === 'Skills'));
});
test('shared Resume never publishes an administrator session command', async () => {
  const f = await fixture();
  await saveSession(f.entry.slug, 'original-session', 'admin-private-session', 'claude', null, JSON.stringify({ backend: 'container', scope: 'admin' }));
  const card = value(await f.invoke({ stateId: f.stateId, page: 'resume' }, 'settings.page'));
  assert.equal(input(card, 'resumeCommand'), undefined);
  assert.doesNotMatch(JSON.stringify(card), /admin-private-session/);
});
test('a different bot recipient cannot open or operate the settings card', async () => {
  const f = await fixture();
  const args = f.args('/settings'); args.message.raw = { activity: { recipient: { id: '28:other-bot' } } };
  const before = f.sent.length;
  await f.controls.onCommand(args);
  assert.equal(f.sent.length, before);
  assert.match(f.replies.at(-1), /different bot/);
  const result = await f.controls.onInvoke({ type: 'invoke', name: 'adaptiveCard/action', from: { id: f.owner },
    recipient: { id: '28:other-bot' }, conversation: { id: f.channelId.slice(6) }, serviceUrl: 'https://smba.trafficmanager.net/teams/',
    value: { action: { type: 'Action.Execute', verb: 'settings.page', data: { stateId: f.stateId, page: 'secrets' } } } });
  assert.equal(value(result).body[0].text, 'Bot registration mismatch');
  assert.equal(f.sent.length, before);
});
test('card ownership, delivery conversation and revoked roles are checked for every interaction', async () => {
  const f = await fixture();
  for (const [actor, destination] of [['29:other', f.channelId.slice(6)], [f.owner, 'a:foreign']]) {
    const result = value(await f.invoke({ stateId: f.stateId, page: 'mcp' }, 'settings.page', actor, destination));
    assert.equal(result.body[0].text, 'Action could not be completed');
  }
  await setUser(f.owner, { approved: false, isAdmin: false });
  const rejected = value(await f.invoke({ stateId: f.stateId, scope: 'channel', field: 'engine', channel_engine: 'codex' }, 'settings.runtime'));
  assert.equal(rejected.body[0].text, 'Action could not be completed');
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'claude');
});
test('confirmations are one-use and cannot delete an automation from another conversation', async () => {
  const f = await fixture();
  const own = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'Own reminder', runAt: '2030-01-01T00:00:00Z', once: true });
  const foreign = addSchedule({ channelId: 'teams:19:foreign@thread.v2', slug: 'foreign', prompt: 'Foreign reminder', cron: '0 * * * *' });
  const prompt = value(await f.invoke({ stateId: f.stateId, id: own.id }, 'settings.automation.delete'));
  assert.equal(listForChannel(f.channelId).length, 1);
  const token = prompt.actions[0].data.token;
  await f.invoke({ stateId: f.stateId, token, id: foreign.id }, 'settings.confirm');
  assert.equal(listForChannel(f.channelId).length, 0);
  assert.equal(listForChannel('teams:19:foreign@thread.v2').length, 1);
  const replay = value(await f.invoke({ stateId: f.stateId, token }, 'settings.confirm'));
  assert.equal(replay.body[0].text, 'Action could not be completed');
  const other = value(await f.invoke({ stateId: f.stateId, id: foreign.id }, 'settings.automation.toggle'));
  assert.equal(other.body[0].text, 'Action could not be completed');
});
test('role revocation while membership is in flight prevents an access mutation', async () => {
  const f = await fixture();
  f.connector.api.listMembers = async () => {
    await setUser(f.owner, { approved: true, isAdmin: false });
    return [{ id: f.owner }];
  };
  const result = value(await f.invoke({ stateId: f.stateId, field: 'allowNetwork', access_allowNetwork: 'on' }, 'settings.access'));
  assert.equal(result.body[0].text, 'Action could not be completed');
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
});
test('metadata audit logs contain policy keys and never submitted credential inputs', async () => {
  const f = await fixture();
  await f.invoke({ stateId: f.stateId, scope: 'channel', field: 'engine', channel_engine: 'codex',
    variableValue: 'private-neighbour-value' }, 'settings.runtime');
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  const logs = JSON.stringify(getDb().prepare('SELECT * FROM events').all());
  assert.match(logs, /teams_settings/);
  assert.doesNotMatch(logs, /private-neighbour-value/);
});
test('all variable scopes can be removed through normalized Teams inputs and one-use confirmations', async () => {
  const f = await fixture({ personal: true });
  const { listChannelEnv } = await import('../src/config/channel-env.js');
  const { listUserEnv, listOrgEnv } = await import('../src/config/scoped-env.js');
  for (const scope of ['channel', 'personal', 'organization']) {
    const name = `REMOVE_${scope.toUpperCase()}_TOKEN`;
    const saved = value(await f.invoke({ stateId: f.stateId, variableScope: scope,
      variableName: name, variableValue: 'private-variable-remove-fixture' }, 'settings.variable.save'));
    assert.equal(saved.body[0].text, 'Channel settings');
    assert.doesNotMatch(JSON.stringify(saved), /private-variable-remove-fixture/);
    const prompt = value(await f.invoke({ stateId: f.stateId, variableScope: scope, name }, 'settings.variable.remove'));
    assert.equal(prompt.body[0].text, 'Confirm change');
    const removed = value(await f.invoke(prompt.actions[0].data, 'settings.confirm'));
    assert.equal(removed.body[0].text, 'Channel settings');
    const listed = scope === 'channel' ? listChannelEnv(await getChannelMeta(f.entry.slug)) : scope === 'personal' ? await listUserEnv(f.owner) : listOrgEnv();
    assert.ok(!listed.some(row => row.name === name));
  }
});
test('disconnect confirmation retains the exact connection and blank credential fields', async () => {
  const f = await fixture();
  await patchChannelMeta(f.entry.slug, { composioToken: 'disconnect-secret-fixture', toolboxToken: 'keep-toolbox-fixture' });
  const prompt = value(await f.invoke({ stateId: f.stateId, connection: 'composio' }, 'settings.connections.remove'));
  await f.invoke(prompt.actions[0].data, 'settings.confirm');
  const stored = await getChannelMeta(f.entry.slug);
  assert.equal(stored.composioToken, '');
  assert.equal(stored.toolboxToken, 'keep-toolbox-fixture');
});
test('automation pages keep later schedules reachable and native cards within bounds', async () => {
  const f = await fixture({ admin: false });
  for (let index = 0; index < 15; index++) addSchedule({ channelId: f.channelId, slug: f.entry.slug,
    prompt: `Schedule ${index}`, description: `Schedule ${index}`, cron: '0 * * * *', createdBy: f.owner });
  const first = value(await f.invoke({ stateId: f.stateId, page: 'automations' }, 'settings.page'));
  adaptiveCardAttachment(first);
  assert.ok(first.actions.some(action => action.title === 'Next'));
  const last = value(await f.invoke(first.actions.find(action => action.title === 'Next').data, 'settings.automation.page'));
  adaptiveCardAttachment(last);
  assert.ok(last.body.some(item => item.text === 'Schedule 14'));
});
test('named member grants reject bots and targets removed during write authorization', async () => {
  const f = await fixture();
  f.connector.api.listMembers = async () => [{ id: f.owner }, { id: '28:other-bot' }];
  const bot = value(await f.invoke({ stateId: f.stateId, field: 'allowedUsers', access_allowedUsers: '28:other-bot' }, 'settings.access'));
  assert.equal(bot.body[0].text, 'Action could not be completed');
  let calls = 0;
  f.connector.api.listMembers = async () => ++calls < 4 ? [{ id: f.owner }, { id: '29:departing' }] : [{ id: f.owner }];
  const left = value(await f.invoke({ stateId: f.stateId, field: 'allowedUsers', access_allowedUsers: '29:departing' }, 'settings.access'));
  assert.equal(left.body[0].text, 'Action could not be completed');
  assert.deepEqual((await getChannelMeta(f.entry.slug)).allowedUsers, undefined);
});
