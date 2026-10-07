import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { normalizeActivity } = await import('../src/platforms/msteams/activity.js');
const { normalizeGraphEvents } = await import('../src/platforms/msteams/graph-activity.js');
const { setUser, getChannelEntry } = await import('../src/config/store.js');
const { addAck, findAckByMessage } = await import('../src/config/acks.js');
const { setThreadSudo } = await import('../src/gateway/thread-engine.js');
const { getSession, saveSession } = await import('../src/gateway/sessions.js');
const botId = '28:rx-bot';
const owner = '29:rx-owner';
const other = '29:rx-other';
const admin = '29:rx-admin';
await setUser(owner, { approved: true });
await setUser(other, { approved: true });
await setUser(admin, { approved: true, isAdmin: true });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(run) {
  const posts = [];
  const connector = { platform: 'msteams', async post(p) {
    posts.push(p); return { messageId: `bot-${posts.length}`, conversationId: p.conversationId, threadKey: p.threadKey };
  }, async edit() {}, async directory() { return null; } };
  return { posts, ingest: createIngest({ connector, run, log: { info() {}, warn() {}, error() {} } }) };
}
const activity = (conversation, changes = {}) => ({ type: 'message', id: 'root',
  conversation, from: { id: owner }, text: '<at>Agent</at> start',
  entities: [{ type: 'mention', mentioned: { id: botId } }], ...changes });
const normalized = value => normalizeActivity(value, { botId });
const stop = (conversation, target, user = owner) => normalized(activity(conversation, {
  type: 'messageReaction', id: `stop-${user}`, replyToId: target, from: { id: user },
  text: '/clear', entities: [], reactionsAdded: [{ type: 'stopsign' }],
}));

for (const source of ['native', 'graph']) for (const kind of ['personal', 'groupchat', 'channel']) {
  test(`${source} Stop sign targets the ${kind} session, enforces ownership and cancels its queue`, async () => {
    const conversation = { id: `19:rx-${kind}@thread.v2`, conversationType: kind };
    const started = deferred(); const release = deferred(); let signal; let runs = 0;
    const f = fixture(async args => {
      runs++; signal = args.signal; started.resolve();
      await Promise.race([release.promise, new Promise(r => args.signal.addEventListener('abort', r, { once: true }))]);
      return { content: 'done', engine: 'claude' };
    });
    const reactStop = async user => {
      if (source === 'native') return stop(conversation, 'bot-1', user);
      const reaction = { reactionType: 'stopsign', user: { user: { id: user } } };
      const [event] = await normalizeGraphEvents({ id: 'bot-1', messageType: 'message',
        from: { application: { id: 'rx-bot' } }, body: { content: '/clear' }, reactions: [reaction],
        messageHistory: [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-07T10:01:00Z', reaction }] },
        { conversationId: `teams:${conversation.id}`, startedAt: '2026-10-07T10:00:00Z', context: { conversation } },
        { botId, now: () => Date.parse('2026-10-07T11:00:00Z'), resolveMember: async id => ({ id }) });
      return event;
    };
    const firstMessage = normalized(activity(conversation));
    const first = f.ingest(firstMessage);
    await started.promise;
    const queue = f.ingest(makeInbound({ ...firstMessage, conversationId: conversation.id,
      messageId: 'queued', replyToId: 'root', text: 'second', mentionsBot: true }));
    // Wait for admission to the same lane, without timing assumptions.
    while (!f.posts.some(p => /Queued/.test(p.text))) await new Promise(r => setImmediate(r));
    try {
      await f.ingest(await reactStop(other));
      assert.equal(signal.aborted, false);
      assert.match(f.posts.at(-1).text, /Only the run author/);
      await f.ingest(await reactStop(owner));
      assert.equal(signal.aborted, true);
      await Promise.all([first, queue]);
      assert.equal(runs, 1, 'queued engine request must never start');
      assert.ok(f.posts.some(p => /Cancelled before starting/.test(p.text)));
      if (kind === 'channel') assert.ok(f.posts.some(p => /Stop requested/.test(p.text) && p.threadKey === 'root'));
    } finally { release.resolve(); await Promise.all([first, queue]); }
  });
}

test('administrator can stop another author while an unrelated group session continues', async () => {
  const conversation = { id: '19:rx-independent@thread.v2', conversationType: 'groupchat' };
  const started = new Map(); const signals = new Map(); const release = deferred();
  for (const text of ['one', 'two']) started.set(text, deferred());
  const f = fixture(async args => {
    signals.set(args.text, args.signal); started.get(args.text).resolve();
    await Promise.race([release.promise, new Promise(r => args.signal.addEventListener('abort', r, { once: true }))]);
    return { content: 'done', engine: 'codex' };
  });
  const one = f.ingest(normalized(activity(conversation, { id: 'one', text: 'one' })));
  await started.get('one').promise;
  const two = f.ingest(normalized(activity(conversation, { id: 'two', text: 'two', from: { id: other } })));
  await started.get('two').promise;
  try {
    await f.ingest(stop(conversation, 'bot-1', admin));
    assert.equal(signals.get('one').aborted, true);
    assert.equal(signals.get('two').aborted, false);
  } finally { release.resolve(); await Promise.all([one, two]); }
});

test('Tick button closes original and escalation reminder messages; unauthorized, custom and removed reactions do not', async () => {
  let runs = 0;
  const f = fixture(async () => { runs++; return { content: 'done' }; });
  const conversation = { id: '19:rx-ack@thread.v2', conversationType: 'groupchat' };
  const tick = (target, user = owner) => normalized(activity(conversation, {
    type: 'messageReaction', id: `ack-${target}-${user}`, replyToId: target, text: '/clear',
    from: { id: user }, entities: [], reactionsAdded: [{ type: '2705_whiteheavycheckmark' }],
  }));
  for (const target of ['reminder', 'second-notice']) {
    addAck({ channelId: `teams:${conversation.id}`, messageTs: 'reminder', messageTsList: ['reminder', 'second-notice'] });
    assert.deepEqual(await f.ingest(tick(target, '29:rx-unapproved')), { skipped: 'unauthorized' });
    assert.ok(findAckByMessage(`teams:${conversation.id}`, target));
    assert.deepEqual(await f.ingest(tick(target)), { command: true });
    assert.equal(findAckByMessage(`teams:${conversation.id}`, target), null);
    assert.match(f.posts.at(-1).text, /Acknowledged/);
    await f.ingest(tick(target));
    assert.match(f.posts.at(-1).text, /No pending/);
  }
  addAck({ channelId: `teams:${conversation.id}`, messageTs: 'custom', ackEmoji: 'thumbsup' });
  await f.ingest(tick('custom'));
  assert.ok(findAckByMessage(`teams:${conversation.id}`, 'custom'));
  assert.equal(normalized(activity(conversation, { type: 'messageReaction', replyToId: 'reminder', reactionsRemoved: [{ type: '2705_whiteheavycheckmark' }] })), null);
  assert.equal(runs, 0);
});

test('Tick button respects sudo thread gate and cannot change the saved session', async () => {
  const f = fixture(async () => assert.fail('reaction control must not invoke an engine'));
  const conversation = { id: '19:rx-sudo@thread.v2', conversationType: 'channel' };
  await f.ingest(normalized(activity(conversation, { text: '/status' })));
  const entry = await getChannelEntry(`teams:${conversation.id}`);
  await setThreadSudo(entry.slug, 'root', true);
  await saveSession(entry.slug, 'root', 'retained', 'claude');
  addAck({ channelId: `teams:${conversation.id}`, messageTs: 'root' });
  const tick = normalized(activity(conversation, { type: 'messageReaction', replyToId: 'root', reactionsAdded: [{ type: '✅' }] }));
  assert.deepEqual(await f.ingest(tick), { skipped: 'sudo-admin-only' });
  assert.ok(findAckByMessage(`teams:${conversation.id}`, 'root'));
  assert.equal(await getSession(entry.slug, 'root'), 'retained');
});

test('Graph Tick on a bot reminder reaches the acknowledgment store as the reactor', async () => {
  const conversation = { id: '19:rx-graph-ack@thread.v2', conversationType: 'groupchat' };
  const reaction = { reactionType: '2705_whiteheavycheckmark', user: { user: { id: 'actor-aad' } } };
  const [event] = await normalizeGraphEvents({ id: 'reminder', messageType: 'message',
    from: { application: { id: 'rx-bot' } }, body: { content: '/clear' }, reactions: [reaction],
    messageHistory: [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-07T10:01:00Z', reaction }] },
    { conversationId: `teams:${conversation.id}`, startedAt: '2026-10-07T10:00:00Z', context: { conversation } },
    { botId, now: () => Date.parse('2026-10-07T11:00:00Z'), resolveMember: async () => ({ id: owner }) });
  addAck({ channelId: event.conversationId, messageTs: 'reminder' });
  const f = fixture(async () => assert.fail('Tick must not start a model request'));
  await f.ingest(event);
  assert.equal(findAckByMessage(event.conversationId, 'reminder'), null);
  assert.match(f.posts.at(-1).text, /Acknowledged/);
});

test('Graph control event identity separates stop/tick and only emits the latest addition', async () => {
  const row = { conversationId: 'teams:19:rx-graph@thread.v2', startedAt: '2026-10-07T10:00:00Z', context: {
    conversation: { id: '19:rx-graph@thread.v2', conversationType: 'groupchat' } } };
  const reaction = type => ({ reactionType: type, user: { user: { id: 'owner-aad' } } });
  const stamp = '2026-10-07T10:01:00Z';
  const message = { id: 'target', messageType: 'message', from: { application: { id: 'rx-bot' } }, body: { content: '/clear' },
    reactions: [reaction('stopsign'), reaction('2705_whiteheavycheckmark')],
    messageHistory: ['stopsign', '2705_whiteheavycheckmark'].map(type => ({ actions: 'reactionAdded', modifiedDateTime: stamp, reaction: reaction(type) })) };
  const opts = { botId, now: () => Date.parse('2026-10-07T11:00:00Z'), resolveMember: async () => ({ id: owner }) };
  const events = await normalizeGraphEvents(message, row, opts);
  assert.deepEqual(events.map(e => e.reactionAction), ['stop', 'ack']);
  assert.notEqual(events[0].raw.eventId, events[1].raw.eventId);
  message.messageHistory.push({ actions: 'reactionRemoved', modifiedDateTime: '2026-10-07T10:02:00Z', reaction: reaction('stopsign') });
  assert.deepEqual((await normalizeGraphEvents(message, row, opts)).map(e => e.reactionAction), ['ack']);
  message.messageHistory.push({ actions: 'reactionAdded', modifiedDateTime: '2026-10-07T10:03:00Z', reaction: reaction('stopsign') });
  const readded = await normalizeGraphEvents(message, row, opts);
  assert.equal(readded.filter(e => e.reactionAction === 'stop').length, 1);
  assert.notEqual(readded.find(e => e.reactionAction === 'stop').raw.eventId, events[0].raw.eventId);
  message.messageHistory.push({ actions: 'reactionAdded, reactionRemoved', modifiedDateTime: '2026-10-07T10:04:00Z', reaction: reaction('stopsign') });
  assert.deepEqual((await normalizeGraphEvents(message, row, opts)).map(e => e.reactionAction), ['ack']);
  message.messageHistory.push({ actions: 'reactionAdded, unknownFutureValue', modifiedDateTime: '2026-10-07T10:05:00Z', reaction: reaction('2705_whiteheavycheckmark') });
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  message.reactions = [];
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
});

for (const [label, value] of [['Like', 'like'], ['Heart eyes robot shortcut', ':hearteyesrobot:']])
for (const source of ['native', 'graph']) for (const kind of ['personal', 'groupchat', 'channel']) {
  test(`${source} ${label} starts a ${kind} engine turn as the approved reactor`, async () => {
    const conversation = { id: `19:activate-${value === 'like' ? 'like' : 'robot'}-${source}-${kind}@thread.v2`, conversationType: kind };
    let event;
    if (source === 'native') {
      event = normalized(activity(conversation, { type: 'messageReaction', id: 'activation-event',
        replyToId: 'target', entities: [], reactionsAdded: [{ type: value }] }));
      assert.equal(normalized(activity(conversation, { type: 'messageReaction',
        replyToId: 'target', reactionsRemoved: [{ type: value }] })), null);
    } else {
      const reaction = { reactionType: value === 'like' ? '👍' : value, user: { user: { id: 'reactor-aad' } } };
      [event] = await normalizeGraphEvents({ id: 'target', messageType: 'message',
        replyToId: kind === 'channel' ? 'channel-root' : null,
        from: { user: { id: 'original-author-aad' } },
        body: { content: 'Reply exactly LIKE_TRIGGER_OK' }, reactions: [reaction],
        messageHistory: [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-07T10:01:00Z', reaction }] },
        { conversationId: `teams:${conversation.id}`, startedAt: '2026-10-07T10:00:00Z',
          reactionAliasesStartedAt: '2026-10-07T10:00:00Z', context: { conversation } },
        { botId, now: () => Date.parse('2026-10-07T11:00:00Z'), resolveMember: async () => ({ id: owner }) });
    }
    const calls = [];
    const f = fixture(async args => { calls.push(args); return { content: 'LIKE_TRIGGER_OK' }; });
    await f.ingest({ ...event, userId: '29:like-unapproved' });
    assert.equal(calls.length, 0, 'Activation cannot grant gateway authorization');
    await f.ingest(event);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorId, owner);
    assert.equal(calls[0].text, event.text);
    assert.equal(calls[0].threadKey, kind === 'channel' ? (source === 'graph' ? 'channel-root' : 'target')
      : kind === 'groupchat' ? 'group:target' : event.conversationId);
  });
}
