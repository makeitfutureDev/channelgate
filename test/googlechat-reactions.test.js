// Google Chat reaction controls through Google Workspace Events subscriptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { parseReactionEvent, googleChatReactionAction, reactionIsFresh, resolveReactor, REACTION_CREATED, REACTION_DELETED, REACTION_BATCH_CREATED } = await import('../src/platforms/googlechat/reactions.js');
const { createReactionSubscriptions, createWorkspaceEventsClient, isTopicName } = await import('../src/platforms/googlechat/workspace-events.js');
const { startGoogleChat } = await import('../src/platforms/googlechat/transport.js');
const { googleChatAdapter } = await import('../src/platforms/googlechat.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { setUser } = await import('../src/config/store.js');
const { addAck, findAckByMessage } = await import('../src/config/acks.js');
const { rememberReplySession, sessionKeyForMessage } = await import('../src/platforms/reply-sessions.js');
const { getDb } = await import('../src/db/index.js');

const quiet = { info() {}, warn() {}, error() {} };
const TOPIC = 'projects/cg-test/topics/chat-events';
const iso = ms => new Date(ms).toISOString();
const reactionEnvelope = ({ space, message, id = 'r1', user = 'users/owner', unicode = '🛑', type = 'HUMAN' }) =>
  ({ reaction: { name: `${space}/messages/${message}/reactions/${id}`, user: { name: user, type }, emoji: { unicode } } });
const attrs = (type = REACTION_CREATED, time = iso(Date.now())) => ({ 'ce-type': type, 'ce-time': time, 'ce-id': `ce-${Math.random()}` });

// ── parsing, mapping, freshness, identity ──────────────────────────────────────────────────

test('reaction events parse single, batch and deleted payloads and reject malformed names', () => {
  const t = '2026-10-14T10:00:00Z';
  const [one] = parseReactionEvent(reactionEnvelope({ space: 'spaces/AAA', message: 'M1' }), attrs(REACTION_CREATED, t));
  assert.equal(one.transition, 'added');
  assert.equal(one.messageName, 'spaces/AAA/messages/M1');
  assert.equal(one.space, 'spaces/AAA');
  assert.equal(one.userName, 'users/owner');
  const redelivered = parseReactionEvent(reactionEnvelope({ space: 'spaces/AAA', message: 'M1' }), attrs(REACTION_CREATED, t))[0];
  assert.equal(redelivered.id, one.id, 'a redelivery (new ce-id, same provider time) keeps one identity');
  const readded = parseReactionEvent(reactionEnvelope({ space: 'spaces/AAA', message: 'M1' }), attrs(REACTION_CREATED, '2026-10-14T10:01:00Z'))[0];
  assert.notEqual(readded.id, one.id, 'a genuine re-addition is a new event');
  const [removed] = parseReactionEvent({ reaction: { name: 'spaces/AAA/messages/M1/reactions/r1' } }, attrs(REACTION_DELETED, t));
  assert.equal(removed.transition, 'removed');
  assert.notEqual(removed.id, one.id);
  const batch = parseReactionEvent({ reactions: [reactionEnvelope({ space: 'spaces/AAA', message: 'M1' }), reactionEnvelope({ space: 'spaces/AAA', message: 'M2', id: 'r2' })] }, attrs(REACTION_BATCH_CREATED, t));
  assert.deepEqual(batch.map(r => r.messageName), ['spaces/AAA/messages/M1', 'spaces/AAA/messages/M2']);
  for (const name of ['', 'spaces/AAA/messages/M1', 'spaces/../messages/M1/reactions/x', 'spaces/AAA/messages/M1/reactions/../x', 'users/1']) {
    assert.deepEqual(parseReactionEvent({ reaction: { name, user: { name: 'users/owner' } } }, attrs()), [], name);
  }
  assert.equal(parseReactionEvent({ reaction: { name: 'spaces/AAA/messages/M1/reactions/r1', user: { name: 'not-a-user' } } }, attrs())[0].userName, '');
});

test('only the fixed controls and the configured activation emojis map to actions', () => {
  assert.equal(googleChatReactionAction({ unicode: '🛑' }), 'stop');
  assert.equal(googleChatReactionAction({ unicode: '✅' }), 'ack');
  assert.equal(googleChatReactionAction({ unicode: '🤖' }), 'engage');
  assert.equal(googleChatReactionAction({ unicode: '🤖️' }), 'engage');
  assert.equal(googleChatReactionAction({ unicode: '🚀' }, ['🚀']), 'engage');
  assert.equal(googleChatReactionAction({ unicode: '🤖' }, ['🚀']), '', 'a replaced default no longer activates');
  assert.equal(googleChatReactionAction({ unicode: '🛑' }, ['🛑']), 'stop', 'controls win over a hand-edited activation list');
  for (const emoji of [{ unicode: '👍' }, { customEmoji: { uid: 'x' } }, {}, null]) assert.equal(googleChatReactionAction(emoji), '');
});

test('freshness: Stop is short-lived, Start bounded, Tick generous; invalid or future times never act', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const at = ms => ({ eventTime: iso(now - ms) });
  assert.equal(reactionIsFresh(at(9 * 60_000), 'stop', now), true);
  assert.equal(reactionIsFresh(at(11 * 60_000), 'stop', now), false);
  assert.equal(reactionIsFresh(at(59 * 60_000), 'engage', now), true);
  assert.equal(reactionIsFresh(at(61 * 60_000), 'engage', now), false);
  assert.equal(reactionIsFresh(at(23 * 3600_000), 'ack', now), true);
  assert.equal(reactionIsFresh(at(25 * 3600_000), 'ack', now), false);
  assert.equal(reactionIsFresh(at(-10 * 60_000), 'stop', now), false, 'future');
  for (const eventTime of ['', 'invalid', undefined]) assert.equal(reactionIsFresh({ eventTime }, 'ack', now), false);
});

test('the reactor maps to exactly one recorded gateway user, never to a guess', () => {
  const users = { 'a@x.com': { googleChatUserName: 'users/1' }, 'b@x.com': { googleChatUserName: 'users/2' }, 'c@x.com': { googleChatUserName: 'users/2' } };
  assert.equal(resolveReactor('users/1', users), 'a@x.com');
  assert.equal(resolveReactor('users/2', users), '', 'ambiguous');
  assert.equal(resolveReactor('users/9', users), '', 'unknown');
  assert.equal(resolveReactor('', users), '');
  assert.equal(resolveReactor('a@x.com', users), '');
});

// ── subscription lifecycle ─────────────────────────────────────────────────────────────────

function fakeClient(subs = []) {
  const calls = [];
  return { calls, subs,
    async list() { calls.push(['list']); return subs; },
    async create(arg) { calls.push(['create', arg.space, arg.topic]); },
    async renew(name) { calls.push(['renew', name]); },
    async reactivate(name) { calls.push(['reactivate', name]); },
    async remove(name) { calls.push(['remove', name]); } };
}
const sub = (name, space, { state = 'ACTIVE', expireTime, topic = TOPIC, includeResource = true } = {}) => ({ name, targetResource: `//chat.googleapis.com/${space}`, state, expireTime,
  eventTypes: [REACTION_CREATED, REACTION_DELETED], notificationEndpoint: { pubsubTopic: topic }, payloadOptions: { includeResource } });

test('a pass creates missing, renews expiring, reactivates suspended, retires orphans and never touches foreign subscriptions', async () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const client = fakeClient([
    sub('subscriptions/fresh', 'spaces/A', { expireTime: iso(now + 3.5 * 3600_000) }),
    sub('subscriptions/expiring', 'spaces/B', { expireTime: iso(now + 30 * 60_000) }),
    sub('subscriptions/suspended', 'spaces/C', { state: 'SUSPENDED', expireTime: iso(now + 3 * 3600_000) }),
    sub('subscriptions/orphan', 'spaces/GONE', { expireTime: iso(now + 3 * 3600_000) }),
    sub('subscriptions/duplicate', 'spaces/A', { expireTime: iso(now + 3 * 3600_000) }),
    sub('subscriptions/foreign', 'spaces/D', { topic: 'projects/other-proj/topics/x', expireTime: iso(now + 60_000) }),
    sub('subscriptions/no-data', 'spaces/E', { includeResource: false, expireTime: iso(now + 60_000) }),
  ]);
  const statuses = [];
  const manager = createReactionSubscriptions({ client, topic: TOPIC, log: quiet, now: () => now, intervalMs: 1e9,
    listSpaces: async () => ['A', 'B', 'C', 'D', 'E'].map(s => ({ name: `spaces/${s}` })), onStatus: s => statuses.push(s) });
  await manager.start();
  manager.stop();
  const ops = client.calls.filter(c => c[0] !== 'list');
  assert.deepEqual(ops, [
    ['renew', 'subscriptions/expiring'],
    ['reactivate', 'subscriptions/suspended'], ['renew', 'subscriptions/suspended'],
    ['remove', 'subscriptions/orphan'],
    ['remove', 'subscriptions/duplicate'],
    ['create', 'spaces/D', TOPIC],
    ['create', 'spaces/E', TOPIC],
  ]);
  assert.equal(statuses.at(-1).state, 'active');
  assert.equal(statuses.at(-1).active, 5);
});

test('an expired (vanished) subscription is recreated; failures degrade status without throwing; 409 is adopted', async () => {
  const now = Date.now();
  const client = fakeClient([sub('subscriptions/gone', 'spaces/A', { expireTime: iso(now + 60_000) })]);
  client.renew = async name => { client.calls.push(['renew', name]); const e = new Error('not found'); e.status = 404; throw e; };
  client.create = async ({ space }) => { client.calls.push(['create', space]); if (space === 'spaces/B') { const e = new Error('approval'); e.status = 403; throw e; } if (space === 'spaces/C') { const e = new Error('exists'); e.status = 409; throw e; } };
  const manager = createReactionSubscriptions({ client, topic: TOPIC, log: quiet, intervalMs: 1e9,
    listSpaces: async () => [{ name: 'spaces/A' }, { name: 'spaces/B' }, { name: 'spaces/C' }] });
  await manager.start(); manager.stop();
  assert.deepEqual(client.calls.filter(c => c[0] === 'create').map(c => c[1]), ['spaces/A', 'spaces/B', 'spaces/C']);
  assert.equal(manager.status.state, 'degraded');
  assert.match(manager.status.error, /spaces\/(A|B)/);
  const broken = createReactionSubscriptions({ client: { list: async () => { throw new Error('API disabled'); } }, topic: TOPIC, log: quiet, intervalMs: 1e9, listSpaces: async () => [] });
  await broken.start(); broken.stop();
  assert.equal(broken.status.state, 'error');
  assert.match(broken.status.error, /API disabled/);
});

test('concurrent reconcile requests coalesce into one follow-up pass', async () => {
  let passes = 0; let release;
  const gate = new Promise(r => { release = r; });
  const client = fakeClient([]);
  const manager = createReactionSubscriptions({ client, topic: TOPIC, log: quiet, intervalMs: 1e9,
    listSpaces: async () => { passes++; if (passes === 1) await gate; return []; } });
  const first = manager.start();
  manager.reconcile(); manager.reconcile(); manager.reconcile();
  release(); await first;
  manager.stop();
  assert.equal(passes, 2);
});

test('the REST client sends Google\'s documented create and renew shapes', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({}) }; };
  const client = createWorkspaceEventsClient({ auth: { token: async () => 't' }, fetchImpl });
  await client.create({ space: 'spaces/A', topic: TOPIC });
  await client.renew('subscriptions/s1');
  await client.reactivate('subscriptions/s1');
  await client.list();
  assert.deepEqual(seen[0], { url: 'https://workspaceevents.googleapis.com/v1/subscriptions', method: 'POST', body: {
    targetResource: '//chat.googleapis.com/spaces/A', eventTypes: [REACTION_CREATED, REACTION_DELETED],
    notificationEndpoint: { pubsubTopic: TOPIC }, payloadOptions: { includeResource: true } } });
  assert.equal(seen[1].url, 'https://workspaceevents.googleapis.com/v1/subscriptions/s1?updateMask=ttl');
  assert.deepEqual(seen[1].body, { ttl: '0s' });
  assert.equal(seen[1].method, 'PATCH');
  assert.equal(seen[2].url, 'https://workspaceevents.googleapis.com/v1/subscriptions/s1:reactivate');
  assert.match(decodeURIComponent(seen[3].url), /filter=event_types:"google\.workspace\.chat\.reaction\.v1\.created"/);
  assert.equal(isTopicName(TOPIC), true);
  for (const bad of ['', 'projects/x/subscriptions/y', 'projects/cg-test/topics/../x', 'topics/x']) assert.equal(isTopicName(bad), false, bad);
});

// ── transport + ingest, end to end ─────────────────────────────────────────────────────────

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let fixtureCount = 0;
async function fixture({ run, messages = {}, spaceType = 'SPACE', topic = TOPIC, getMessage = null } = {}) {
  const n = ++fixtureCount;
  const space = `spaces/RX${n}`;
  const posts = [];
  const connector = { platform: 'googlechat', async post(p) {
    posts.push(p); return { messageId: `${space}/messages/bot-${posts.length}`, conversationId: p.conversationId, threadKey: p.threadKey };
  }, async edit() {}, async directory() { return null; } };
  const ingest = createIngest({ connector, run: run || (async () => ({ content: 'done', engine: 'claude' })), log: quiet });
  const delivered = [];
  const reconciles = [];
  const store = new Map(Object.entries(messages).map(([id, m]) => [`${space}/messages/${id}`, { name: `${space}/messages/${id}`, ...m }]));
  const api = {
    getMessage: getMessage || (async name => { if (!store.has(name)) { const e = new Error('nf'); e.status = 404; throw e; } return store.get(name); }),
    getSpace: async name => ({ name, spaceType, displayName: spaceType === 'DIRECT_MESSAGE' ? '' : 'Room' }),
    listSpaces: async () => [],
  };
  const transport = await startGoogleChat({
    subscription: `projects/cg-test/subscriptions/rx-${n}`, reactionTopic: topic, botUserId: 'users/app',
    capabilities: googleChatAdapter.capabilities, log: quiet,
    onMessage: async (m, opts) => { delivered.push(m); return ingest(m, opts); },
    deps: { auth: { token: async () => 't' }, api, eventsApi: api, connector, puller: { start() {}, async stop() {} },
      reactionSubscriptions: { start() {}, stop() {}, reconcile() { reconciles.push(1); }, status: { state: 'active', active: 1, spaces: 1 } } },
  });
  const react = (message, { unicode = '🛑', user = 'users/owner', id = `r${Math.random().toString(36).slice(2)}`, time = iso(Date.now()), type = REACTION_CREATED } = {}) =>
    transport.onEvent(reactionEnvelope({ space, message, id, user, unicode }), attrs(type, time));
  const say = (id, text, { sender = OWNER, thread = 'T1' } = {}) => {
    const message = { name: `${space}/messages/${id}`, text: `@app ${text}`, argumentText: text, sender, thread: { name: `${space}/threads/${thread}` },
      annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/app', type: 'BOT' } } }] };
    store.set(message.name, message);
    return transport.onEvent({ chat: { messagePayload: { message, space: { name: space, spaceType, displayName: spaceType === 'DIRECT_MESSAGE' ? '' : 'Room' } } } }, { 'ce-type': 'google.workspace.chat.message.v1.created' });
  };
  return { space, posts, delivered, reconciles, transport, react, say, store };
}
const OWNER = { name: 'users/owner', email: 'owner@rx.test', displayName: 'Owner', type: 'HUMAN' };
const OTHER = { name: 'users/other', email: 'other@rx.test', displayName: 'Other', type: 'HUMAN' };
await setUser('owner@rx.test', { approved: true, name: 'Owner', googleChatUserName: 'users/owner' });
await setUser('other@rx.test', { approved: true, name: 'Other', googleChatUserName: 'users/other' });
await setUser('admin@rx.test', { approved: true, isAdmin: true, name: 'Admin', googleChatUserName: 'users/admin' });
const settle = async (predicate, label) => { for (let i = 0; i < 2000 && !predicate(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(predicate(), label); };

test('🛑 on the working message interrupts the RUNNING turn, as the reactor, with ownership enforced', async () => {
  const started = deferred(); let signal; let runs = 0;
  const f = await fixture({ run: async args => {
    runs++; signal = args.signal; started.resolve();
    await new Promise(r => args.signal.addEventListener('abort', r, { once: true }));
    return { content: 'stopped', engine: 'claude' };
  } });
  try {
    await f.say('req', 'long task');
    await started.promise;
    const working = f.posts.find(p => /Working on it/.test(p.text));
    assert.ok(working, 'placeholder posted');
    const workingName = `${f.space}/messages/bot-${f.posts.indexOf(working) + 1}`;
    f.store.set(workingName, { name: workingName, text: '_Working on it…_', sender: { name: 'users/app', type: 'BOT' }, thread: { name: `${f.space}/threads/T1` } });
    await f.react(`bot-${f.posts.indexOf(working) + 1}`, { user: 'users/other' });
    await settle(() => f.posts.some(p => /Only the run author/.test(p.text)), 'non-author refused');
    assert.equal(signal.aborted, false);
    await f.react(`bot-${f.posts.indexOf(working) + 1}`, { user: 'users/owner' });
    await settle(() => signal.aborted, 'author Stop aborts the running engine');
    const stopEvent = f.delivered.find(m => m.reactionAction === 'stop' && m.userId === 'owner@rx.test');
    assert.equal(stopEvent.trigger, 'reaction');
    assert.equal(stopEvent.replyToId, workingName);
    assert.equal(stopEvent.conversationId, `gchat:${f.space}`);
    assert.equal(sessionKeyForMessage({ ...stopEvent }), `${f.space}/threads/T1`);
    await settle(() => f.posts.some(p => /Stop requested/.test(p.text) && p.threadKey === `${f.space}/threads/T1`), 'Stop acknowledged in the thread');
    assert.equal(runs, 1);
  } finally { await f.transport.stop(); }
});

test('an admin can stop another author; duplicate Stop deliveries act once', async () => {
  const started = deferred(); let signal;
  const f = await fixture({ run: async args => { signal = args.signal; started.resolve(); await new Promise(r => args.signal.addEventListener('abort', r, { once: true })); return { content: 'x', engine: 'claude' }; } });
  try {
    await f.say('req', 'work');
    await started.promise;
    const time = iso(Date.now());
    await f.react('req', { user: 'users/admin', id: 'dup', time });
    await f.react('req', { user: 'users/admin', id: 'dup', time });
    await settle(() => signal.aborted, 'admin stop');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.delivered.filter(m => m.reactionAction === 'stop').length, 1);
  } finally { await f.transport.stop(); }
});

test('✅ on a tracked reminder acknowledges it once; on an ordinary message it says so', async () => {
  const f = await fixture({ messages: { rem: { text: '⏰ Reminder', sender: { name: 'users/app', type: 'BOT' }, thread: { name: 'x' } }, plain: { text: 'hi', sender: OWNER } } });
  f.store.get(`${f.space}/messages/rem`).thread = { name: `${f.space}/threads/R` };
  f.store.get(`${f.space}/messages/plain`).thread = { name: `${f.space}/threads/P` };
  try {
    const ack = addAck({ channelId: `gchat:${f.space}`, messageTs: `${f.space}/messages/rem`, ackEmoji: 'white_check_mark', nextAt: iso(Date.now() + 3600_000) });
    await f.react('rem', { unicode: '✅' });
    await settle(() => f.posts.some(p => /Acknowledged — reminder closed/.test(p.text)), 'acknowledged');
    assert.equal(findAckByMessage(`gchat:${f.space}`, `${f.space}/messages/rem`), null);
    assert.ok(ack.id);
    await f.react('plain', { unicode: '✅' });
    await settle(() => f.posts.some(p => /No pending Tick button reminder/.test(p.text)), 'ordinary message');
  } finally { await f.transport.stop(); }
});

test('the start emoji on a person\'s message runs its text as the REACTOR; on the app\'s answer it continues', async () => {
  const prompts = [];
  const f = await fixture({ run: async args => { prompts.push(args); return { content: 'ok', engine: 'claude' }; },
    messages: { human: { text: 'summarize the doc', argumentText: 'summarize the doc', sender: OTHER, thread: { name: '' } },
      answer: { text: 'previous answer', sender: { name: 'users/app', type: 'BOT' } }, foreign: { text: 'x', sender: { name: 'users/otherapp', type: 'BOT' } } } });
  for (const id of ['human', 'answer', 'foreign']) f.store.get(`${f.space}/messages/${id}`).thread = { name: `${f.space}/threads/${id}` };
  try {
    await f.react('human', { unicode: '🤖', user: 'users/owner' });
    await settle(() => f.delivered.some(m => m.reactionAction === 'engage'), 'engaged');
    const engaged = f.delivered.find(m => m.reactionAction === 'engage');
    assert.equal(engaged.userId, 'owner@rx.test', 'acts as the reactor, not the message author');
    assert.equal(engaged.text, 'summarize the doc');
    assert.equal(engaged.threadKey, `${f.space}/threads/human`);
    await f.react('answer', { unicode: '🤖' });
    await settle(() => f.delivered.filter(m => m.reactionAction === 'engage').length === 2, 'continue');
    assert.equal(f.delivered.filter(m => m.reactionAction === 'engage')[1].text, 'Continue the task from this message.');
    await f.react('foreign', { unicode: '🤖' });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.delivered.filter(m => m.reactionAction === 'engage').length, 2, 'never acts through another app');
  } finally { await f.transport.stop(); }
});

test('stale, unmapped, bot, unconfigured and removed reactions never act; unauthorized reactors are refused', async () => {
  const f = await fixture({ messages: { m: { text: 'do it', argumentText: 'do it', sender: OWNER } } });
  f.store.get(`${f.space}/messages/m`).thread = { name: `${f.space}/threads/M` };
  try {
    await f.react('m', { unicode: '🛑', time: iso(Date.now() - 11 * 60_000) });
    await f.react('m', { unicode: '🤖', time: iso(Date.now() - 2 * 3600_000) });
    await f.react('m', { unicode: '🤖', user: 'users/stranger' });
    await f.react('m', { unicode: '👍' });
    await f.transport.onEvent(reactionEnvelope({ space: f.space, message: 'm', unicode: '🤖', type: 'BOT', user: 'users/app' }), attrs());
    // Removal overtakes its addition: the addition must never act.
    const time = iso(Date.now() - 1000);
    await f.react('m', { unicode: '🤖', id: 'gone', type: REACTION_DELETED, time: iso(Date.now()) });
    await f.react('m', { unicode: '🤖', id: 'gone', time });
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(f.delivered, []);
    await setUser('guest@rx.test', { approved: false, name: 'Guest', googleChatUserName: 'users/guest' });
    await f.react('m', { unicode: '🤖', user: 'users/guest' });
    await settle(() => f.posts.some(p => /not approved/.test(p.text)), 'unapproved reactor refused by the normal gate');
  } finally { await f.transport.stop(); }
});

test('removing a start reaction withdraws its queued request before it runs', async () => {
  const started = deferred(); const release = deferred(); let runs = 0;
  const f = await fixture({ run: async () => { runs++; started.resolve(); await release.promise; return { content: 'ok', engine: 'claude' }; } });
  try {
    await f.say('req', 'first');
    await started.promise;
    f.store.set(`${f.space}/messages/later`, { name: `${f.space}/messages/later`, text: 'second', argumentText: 'second', sender: OTHER, thread: { name: `${f.space}/threads/T1` } });
    await f.react('later', { unicode: '🤖', id: 'queued', time: iso(Date.now() - 1000) });
    const queued = () => getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE status = 'queued' AND json_extract(data, '$.event.reaction.name') = ?").get(`${f.space}/messages/later/reactions/queued`).n;
    assert.equal(queued(), 1, 'queued behind the running turn');
    await f.react('later', { unicode: '🤖', id: 'queued', type: REACTION_DELETED });
    assert.equal(queued(), 0, 'the durable row itself is withdrawn');
    release.resolve();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(runs, 1, 'the withdrawn reaction never started a run');
    assert.equal(f.delivered.filter(m => m.reactionAction === 'engage').length, 0);
  } finally { release.resolve(); await f.transport.stop(); }
});

test('an unreadable message drops the reaction; a transient error is thrown so Pub/Sub redelivers', async () => {
  let fail = 503;
  const f = await fixture({ getMessage: async () => { const e = new Error('x'); e.status = fail; throw e; } });
  try {
    await assert.rejects(f.react('m', { unicode: '🛑' }), /x/);
    fail = 404;
    await f.react('m', { unicode: '🛑' });
    assert.deepEqual(f.delivered, []);
  } finally { await f.transport.stop(); }
});

test('lifecycle and membership events reconcile subscriptions; without a topic reactions are inert', async () => {
  const f = await fixture();
  try {
    await f.transport.onEvent({ subscription: { name: 'subscriptions/s' } }, { 'ce-type': 'google.workspace.events.subscription.v1.expirationReminder' });
    await f.transport.onEvent({ chat: { membershipPayload: { space: { name: f.space }, membership: { member: { name: 'users/app', type: 'BOT' } } } } }, { 'ce-type': 'google.workspace.chat.membership.v1.created' });
    assert.equal(f.reconciles.length, 2);
    assert.match(f.transport.detail, /reactions 1\/1 spaces/);
  } finally { await f.transport.stop(); }
  const off = await fixture({ topic: '', messages: { m: { text: 'x', sender: OWNER } } });
  try {
    assert.equal(off.transport.reactionSubscriptions, null);
    await off.react('m', { unicode: '🛑' });
    assert.deepEqual(off.delivered, []);
    assert.doesNotMatch(off.transport.detail, /reactions/);
  } finally { await off.transport.stop(); }
});

test('ordinary messages and /stop keep working beside reaction events', async () => {
  const started = deferred(); let signal;
  const f = await fixture({ run: async args => { signal = args.signal; started.resolve(); await new Promise(r => args.signal.addEventListener('abort', r, { once: true })); return { content: 'x', engine: 'claude' }; } });
  try {
    await f.say('req', 'work');
    await started.promise;
    await f.say('stop', '/stop');
    await settle(() => signal.aborted, 'typed /stop still interrupts');
  } finally { await f.transport.stop(); }
});

test('a reaction on a reply in a known thread follows the remembered session', () => {
  rememberReplySession('gchat:spaces/MAP', 'spaces/MAP/messages/answer', 'spaces/MAP/threads/root');
  const key = sessionKeyForMessage({ platform: 'googlechat', conversationId: 'gchat:spaces/MAP', kind: 'channel', threadKey: 'spaces/MAP/threads/other',
    trigger: 'reaction', replyToId: 'spaces/MAP/messages/answer', messageId: 'reaction:x', text: '' });
  assert.equal(key, 'spaces/MAP/threads/root');
});
