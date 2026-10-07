import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { createConversationControls } = await import('../src/platforms/conversation-controls.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { sessionKeyForMessage } = await import('../src/platforms/reply-sessions.js');
const { saveSettings } = await import('../src/config/settings.js');
const { setUser } = await import('../src/config/store.js');
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadRuntimeOverrides } = await import('../src/gateway/thread-engine.js');
const { saveSession } = await import('../src/gateway/sessions.js');
const { adaptiveCardAttachment } = await import('../src/platforms/msteams/cards.js');

let sequence = 0;
function fixture({ meta = {}, isAdmin = true, isDM = false, now = Date.now } = {}) {
  const slug = `teams-model-${++sequence}`, sent = [], replies = [];
  const message = { ...makeInbound({ platform: 'msteams', kind: isDM ? 'dm' : 'group',
    conversationId: `19:${slug}`, messageId: 'root', userId: '29:model-owner', text: '/model', mentionsBot: true }) };
  const context = { meta: { engine: 'claude', model: 'sonnet', ...meta }, userIsAdmin: isAdmin };
  const connector = { platform: 'msteams',
    api: { sendActivity: async () => assert.fail('picker must not send file consent') },
    openDm: async () => assert.fail('model controls stay in their source conversation'),
    postCard: async payload => { sent.push(payload); return { messageId: `card-${sent.length}` }; },
    updateCard: async payload => sent.push(payload),
  };
  const native = createTeamsControls({ connector, now, authorize: async () => context });
  const controls = createConversationControls();
  const args = { message, sessionKey: 'group:root', entry: { slug }, meta: context.meta,
    authorIsAdmin: isAdmin, reply: async value => replies.push(value), controls };
  const submit = async (data = {}, { actor = message.userId, conversation = message.rawConversationId, legacy = false } = {}) => {
    const action = sent[0].card.actions[0];
    const activity = { type: legacy ? 'message' : 'invoke', name: 'adaptiveCard/action',
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      from: { id: actor }, conversation: { id: conversation }, replyToId: 'forged-target',
      value: legacy ? { ...action.data, ...data } : { action: { type: 'Action.Execute', verb: action.verb, data: { ...action.data, ...data } } } };
    return native.onInvoke(activity);
  };
  return { native, connector, controls, args, context, sent, replies, submit };
}
saveSettings({ engine: 'claude', defaultClaudeModel: 'sonnet', defaultCodexModel: 'gpt-6.1-sol', engineEnabled: { opencode: false } });

test('bare /model shows retained session runtime and actionable compatible choices', async () => {
  const f = fixture();
  await saveSession(f.args.entry.slug, f.args.sessionKey, 'retained-codex-session', 'codex');
  await setThreadRuntimeOverrides(f.args.entry.slug, f.args.sessionKey, { model: 'gpt-6-sol', effort: 'high' });
  f.args.message.text = '  /MODEL  ';
  assert.equal(await f.native.onCommand(f.args), true);
  const card = f.sent[0].card;
  assert.match(card.body[1].text, /Current engine: codex; model: gpt-6-sol; effort: high/);
  assert.equal(card.body.find(item => item.id === 'engine').value, 'codex');
  assert.ok(card.body.find(item => item.id === 'model').choices.some(item => item.value === 'gpt-6-sol'));
  assert.ok(card.body.find(item => item.id === 'model').choices.some(item => item.value.startsWith('claude-')));
  assert.equal(card.actions[0].verb, 'model.save');
  assert.equal(card.actions[0].fallback.type, 'Action.Submit');
  adaptiveCardAttachment(card);
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), '');
});

for (const legacy of [false, true]) test(`Apply persists session runtime and replaces the source card (${legacy ? 'Submit' : 'Execute'})`, async () => {
  const f = fixture(); await f.native.onCommand(f.args);
  const data = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
  const result = await f.submit(data, { legacy });
  assert.equal(result.status, 200);
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), 'codex');
  assert.equal(await getThreadModel(f.args.entry.slug, f.args.sessionKey), data.model);
  assert.equal(await getThreadEffort(f.args.entry.slug, f.args.sessionKey), 'high');
  assert.equal(await getThreadModel(f.args.entry.slug, 'other-session'), '');
  assert.equal(f.context.meta.engine, 'claude');
  assert.equal(f.sent[1].messageId, 'card-1');
  assert.equal(f.sent[1].conversationId, f.args.message.rawConversationId);
  assert.match(JSON.stringify(f.sent[1].card), /Session engine: codex/);
  await f.submit({ engine: 'claude', model: 'sonnet', effort: 'default' }, { legacy });
  assert.equal(f.sent.length, 2, 'consumed controls cannot be replayed');
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), 'codex');
});

test('invalid, incomplete, disabled and foreign submissions never mutate runtime', async () => {
  const f = fixture(); await f.native.onCommand(f.args);
  for (const [data, envelope] of [
    [{ engine: 'codex', model: 'sonnet', effort: 'default' }],
    [{ engine: 'codex', model: 'gpt-6-sol', effort: 'impossible' }],
    [{ engine: 'codex', model: 'gpt-6-sol' }],
    [{ engine: 'opencode', model: 'default', effort: 'default' }],
    [{ engine: 'codex', model: 'gpt-6-sol', effort: 'default' }, { actor: '29:other' }],
    [{ engine: 'codex', model: 'gpt-6-sol', effort: 'default' }, { conversation: 'a:other' }],
  ]) {
    const result = await f.submit(data, envelope);
    assert.equal(result.body.value.body[0].text, 'Action could not be completed');
    assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), '');
    assert.equal(await getThreadModel(f.args.entry.slug, f.args.sessionKey), '');
  }
  assert.equal(f.sent.length, 1);
});

test('runtime policy is checked on open and again on Apply; personal chats can switch', async () => {
  const denied = fixture({ isAdmin: false }); await denied.native.onCommand(denied.args);
  assert.match(JSON.stringify(denied.sent[0].card), /restricted to administrators/);
  assert.equal(denied.sent[0].card.actions.length, 0);
  const revoked = fixture(); await revoked.native.onCommand(revoked.args);
  revoked.context.userIsAdmin = false;
  assert.match(JSON.stringify((await revoked.submit({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' })).body), /Action could not be completed/);
  assert.equal(await getThreadEngine(revoked.args.entry.slug, revoked.args.sessionKey), '');
  const dm = fixture({ isAdmin: false, isDM: true }); await dm.native.onCommand(dm.args);
  await dm.submit({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
  assert.equal(await getThreadModel(dm.args.entry.slug, dm.args.sessionKey), 'gpt-6-sol');
});

test('channel login locks engine and expired/revoked access cannot submit', async () => {
  const locked = fixture({ meta: { codexAuthSource: 'channel' } }); await locked.native.onCommand(locked.args);
  assert.deepEqual(locked.sent[0].card.body.find(row => row.id === 'engine').choices.map(row => row.value), ['codex']);
  await locked.submit({ engine: 'claude', model: 'sonnet', effort: 'default' });
  assert.equal(await getThreadEngine(locked.args.entry.slug, locked.args.sessionKey), '');
  let time = 0; const expired = fixture({ now: () => time }); await expired.native.onCommand(expired.args);
  time = 16 * 60_000;
  assert.match(JSON.stringify((await expired.submit({ engine: 'codex', model: 'default', effort: 'default' })).body), /Action could not be completed/);
  const revoked = fixture(); await revoked.native.onCommand(revoked.args);
  revoked.context.meta = null;
  await revoked.submit({ engine: 'codex', model: 'default', effort: 'default' });
  assert.equal(await getThreadEngine(revoked.args.entry.slug, revoked.args.sessionKey), '');
});

test('busy session refuses Apply without writing model or effort', async () => {
  const f = fixture(); await f.native.onCommand(f.args);
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const running = f.controls.execute({ message: f.args.message, sessionKey: f.args.sessionKey, queued: async () => {}, work: async () => { start(); await done; } });
  await started;
  try {
    await f.submit({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
    assert.match(JSON.stringify(f.sent[1].card), /Wait for this session/);
    assert.equal(await getThreadModel(f.args.entry.slug, f.args.sessionKey), '');
    assert.equal(await getThreadEffort(f.args.entry.slug, f.args.sessionKey), '');
  } finally { finish(); await running; }
});

test('typed arguments and reactions keep their existing dispatch; card failures show change syntax', async () => {
  const f = fixture(); f.args.message.text = '/model codex gpt-6-sol';
  assert.equal(await f.native.onCommand(f.args), false);
  f.args.message.text = '/model'; f.args.message.trigger = 'reaction';
  assert.equal(await f.native.onCommand(f.args), false);
  f.args.message.trigger = 'message'; f.args.replyCard = async () => { throw new Error('Cards unavailable'); };
  assert.equal(await f.native.onCommand(f.args), true);
  assert.match(f.replies[0], /\/model <engine> <model\|default>/);
});

test('ingest posts model picker before engine execution and maps quoted card to source group session', async () => {
  const f = fixture(); await setUser(f.args.message.userId, { approved: true, isAdmin: true });
  const ingest = createIngest({ connector: f.connector, onCommand: f.native.onCommand,
    run: async () => assert.fail('picker must not start an engine'), log: {} });
  for (const kind of ['dm', 'channel', 'group']) {
    const message = makeInbound({ platform: 'msteams', kind, conversationId: `19:picker-${kind}`, userId: f.args.message.userId,
      text: '/model', messageId: `model-${kind}`, mentionsBot: kind !== 'dm', threadKey: kind === 'channel' ? 'channel-root' : '', replyToId: kind === 'group' ? 'quoted-root' : '' });
    assert.deepEqual(await ingest(message), { command: true });
    assert.equal(f.sent.at(-1).conversationId, message.rawConversationId);
    assert.equal(f.sent.at(-1).threadKey, message.threadKey);
    if (kind === 'group') assert.equal(sessionKeyForMessage(makeInbound({ platform: 'msteams', kind, conversationId: message.rawConversationId,
      userId: message.userId, messageId: 'follow-up', text: '/status', replyToId: `card-${f.sent.length}`, mentionsBot: true })), sessionKeyForMessage(message));
  }
});
