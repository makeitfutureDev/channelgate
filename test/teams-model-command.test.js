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
  // Acts on the card currently shown (the posted card, or its latest in-place update).
  const submit = async (data = {}, { actor = message.userId, conversation = message.rawConversationId, legacy = false, verb = 'model.save' } = {}) => {
    const action = sent.at(-1).card.actions.find(item => item.verb === verb);
    if (!action) return { status: 200, body: { value: { body: [{ text: 'Action could not be completed' }] } } };
    const activity = { type: legacy ? 'message' : 'invoke', name: 'adaptiveCard/action',
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      from: { id: actor }, conversation: { id: conversation }, replyToId: 'forged-target',
      value: legacy ? { ...action.data, ...data } : { action: { type: 'Action.Execute', verb: action.verb, data: { ...action.data, ...data } } } };
    return native.onInvoke(activity);
  };
  // Page 1 → page 2: choose the engine and press Next.
  const next = (engine, options = {}) => submit({ engine }, { ...options, verb: 'model.next' });
  const apply = async (engine, data, options = {}) => { await next(engine, options); return submit(data, options); };
  return { native, connector, controls, args, context, sent, replies, submit, next, apply };
}
saveSettings({ engine: 'claude', defaultClaudeModel: 'sonnet', defaultCodexModel: 'gpt-6.1-sol', engineEnabled: { opencode: false } });

test('bare /model is two pages: engine first, then only that engine\'s models and efforts', async () => {
  const f = fixture();
  await saveSession(f.args.entry.slug, f.args.sessionKey, 'retained-codex-session', 'codex');
  await setThreadRuntimeOverrides(f.args.entry.slug, f.args.sessionKey, { model: 'gpt-6-sol', effort: 'high' });
  f.args.message.text = '  /MODEL  ';
  assert.equal(await f.native.onCommand(f.args), true);
  const page1 = f.sent[0].card;
  assert.match(page1.body[1].text, /Current engine: codex; model: gpt-6-sol; effort: high/);
  assert.equal(page1.body.find(item => item.id === 'engine').value, 'codex');
  assert.equal(page1.body.find(item => item.id === 'model'), undefined, 'page 1 offers no model list');
  assert.deepEqual(page1.actions.map(item => item.verb), ['model.next']);
  assert.equal(page1.actions[0].fallback.type, 'Action.Submit');
  adaptiveCardAttachment(page1);

  await f.next('codex');
  const codex = f.sent.at(-1).card;
  assert.equal(f.sent.at(-1).messageId, 'card-1', 'Next replaces the same card');
  const codexModels = codex.body.find(item => item.id === 'model');
  assert.equal(codexModels.value, 'gpt-6-sol');
  assert.ok(codexModels.choices.some(item => item.value === 'gpt-6-sol'));
  assert.ok(!codexModels.choices.some(item => item.value.startsWith('claude-') || item.value.startsWith('qwen')), 'only Codex models');
  assert.equal(codex.body.find(item => item.id === 'effort').value, 'high');
  assert.deepEqual(codex.actions.map(item => item.verb), ['model.back', 'model.save']);
  adaptiveCardAttachment(codex);

  await f.submit({}, { verb: 'model.back' });
  assert.equal(f.sent.at(-1).card.body.find(item => item.id === 'engine').value, 'codex');
  await f.next('claude');
  const claude = f.sent.at(-1).card;
  const claudeModels = claude.body.find(item => item.id === 'model').choices.slice(1).map(item => item.value);
  assert.ok(claudeModels.length && claudeModels.every(value => value.startsWith('claude-')), `only Claude models: ${claudeModels}`);
  assert.equal(claude.body.find(item => item.id === 'model').value, 'default', 'another engine\'s saved model is not preselected');
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), '', 'navigation never saves');
});

for (const legacy of [false, true]) test(`Apply persists session runtime and replaces the source card (${legacy ? 'Submit' : 'Execute'})`, async () => {
  const f = fixture(); await f.native.onCommand(f.args);
  const data = { model: 'gpt-6.1-sol', effort: 'high' };
  const result = await f.apply('codex', data, { legacy });
  assert.equal(result.status, 200);
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), 'codex');
  assert.equal(await getThreadModel(f.args.entry.slug, f.args.sessionKey), data.model);
  assert.equal(await getThreadEffort(f.args.entry.slug, f.args.sessionKey), 'high');
  assert.equal(await getThreadModel(f.args.entry.slug, 'other-session'), '');
  assert.equal(f.context.meta.engine, 'claude');
  assert.equal(f.sent[2].messageId, 'card-1');
  assert.equal(f.sent[2].conversationId, f.args.message.rawConversationId);
  assert.match(JSON.stringify(f.sent[2].card), /Session engine: codex/);
  const page2 = f.sent[1].card.actions.find(item => item.verb === 'model.save');
  await f.native.onInvoke({ type: 'invoke', name: 'adaptiveCard/action', serviceUrl: 'https://smba.trafficmanager.net/teams/',
    from: { id: f.args.message.userId }, conversation: { id: f.args.message.rawConversationId },
    value: { action: { type: 'Action.Execute', verb: page2.verb, data: { ...page2.data, model: 'gpt-6-sol', effort: 'default' } } } });
  assert.equal(f.sent.length, 3, 'consumed controls cannot be replayed');
  assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), 'codex');
});

test('invalid, incomplete, disabled, tampered and foreign submissions never mutate runtime', async () => {
  const f = fixture(); await f.native.onCommand(f.args);
  const failed = result => assert.equal(result.body.value.body[0].text, 'Action could not be completed');
  failed(await f.submit({ model: 'gpt-6-sol', effort: 'default' }), 'Apply is not offered before Next');
  failed(await f.next('opencode'));
  failed(await f.next('codex', { actor: '29:other' }));
  await f.next('codex');
  for (const [data, envelope] of [
    [{ model: 'sonnet', effort: 'default' }],
    [{ model: 'claude-opus-5-5', effort: 'default' }],
    [{ model: 'gpt-6-sol', effort: 'impossible' }],
    [{ model: 'gpt-6-sol' }],
    [{ model: 'claude-opus-5-5', effort: 'default', engine: 'claude' }],
    [{ model: 'gpt-6-sol', effort: 'default' }, { actor: '29:other' }],
    [{ model: 'gpt-6-sol', effort: 'default' }, { conversation: 'a:other' }],
  ]) {
    failed(await f.submit(data, envelope));
    assert.equal(await getThreadEngine(f.args.entry.slug, f.args.sessionKey), '');
    assert.equal(await getThreadModel(f.args.entry.slug, f.args.sessionKey), '');
  }
  assert.equal(f.sent.length, 2);
});

test('runtime policy is checked on open and again on Apply; personal chats can switch', async () => {
  const denied = fixture({ isAdmin: false }); await denied.native.onCommand(denied.args);
  assert.match(JSON.stringify(denied.sent[0].card), /restricted to administrators/);
  assert.equal(denied.sent[0].card.actions.length, 0);
  const revoked = fixture(); await revoked.native.onCommand(revoked.args);
  await revoked.next('codex');
  revoked.context.userIsAdmin = false;
  assert.match(JSON.stringify((await revoked.submit({ model: 'gpt-6-sol', effort: 'high' })).body), /Action could not be completed/);
  assert.match(JSON.stringify((await revoked.submit({}, { verb: 'model.back' })).body), /Action could not be completed/);
  assert.equal(await getThreadEngine(revoked.args.entry.slug, revoked.args.sessionKey), '');
  const dm = fixture({ isAdmin: false, isDM: true }); await dm.native.onCommand(dm.args);
  await dm.apply('codex', { model: 'gpt-6-sol', effort: 'high' });
  assert.equal(await getThreadModel(dm.args.entry.slug, dm.args.sessionKey), 'gpt-6-sol');
});

test('channel login locks engine and expired/revoked access cannot submit', async () => {
  const locked = fixture({ meta: { codexAuthSource: 'channel' } }); await locked.native.onCommand(locked.args);
  const lockedCard = locked.sent[0].card;
  assert.equal(lockedCard.body.find(row => row.id === 'engine'), undefined, 'a locked engine skips page 1');
  assert.ok(lockedCard.body.find(row => row.id === 'model').choices.slice(1).every(row => !row.value.startsWith('claude-')));
  assert.deepEqual(lockedCard.actions.map(row => row.verb), ['model.save']);
  await locked.submit({ engine: 'claude', model: 'sonnet', effort: 'default' });
  await locked.next('claude');
  assert.equal(await getThreadEngine(locked.args.entry.slug, locked.args.sessionKey), '');
  let time = 0; const expired = fixture({ now: () => time }); await expired.native.onCommand(expired.args);
  time = 16 * 60_000;
  assert.match(JSON.stringify((await expired.next('codex')).body), /Action could not be completed/);
  const revoked = fixture(); await revoked.native.onCommand(revoked.args);
  await revoked.next('codex');
  revoked.context.meta = null;
  await revoked.submit({ model: 'default', effort: 'default' });
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
    await f.apply('codex', { model: 'gpt-6-sol', effort: 'high' });
    assert.match(JSON.stringify(f.sent[2].card), /Wait for this session/);
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
