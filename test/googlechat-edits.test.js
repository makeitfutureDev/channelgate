// Google Chat edit trigger: an edit that newly mentions the app runs the edited message, delivered
// only through Google Workspace Events (`google.workspace.chat.message.v1.updated`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { parseMessageUpdateEvent, editIsFresh, mentionsApp, editedArgumentText, appUserNameFromInteraction, MESSAGE_UPDATED, MESSAGE_BATCH_UPDATED, EDIT_MAX_AGE_MS, EDITED_MESSAGE_MAX_AGE_MS } = await import('../src/platforms/googlechat/edits.js');
const { REACTION_CREATED, REACTION_DELETED } = await import('../src/platforms/googlechat/reactions.js');
const { createReactionSubscriptions, createWorkspaceEventsClient, SUBSCRIPTION_EVENT_TYPES } = await import('../src/platforms/googlechat/workspace-events.js');
const { startGoogleChat } = await import('../src/platforms/googlechat/transport.js');
const { googleChatAdapter } = await import('../src/platforms/googlechat.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { setUser } = await import('../src/config/store.js');
const { getDb } = await import('../src/db/index.js');

const quiet = { info() {}, warn() {}, error() {} };
const TOPIC = 'projects/cg-test/topics/chat-events';
const iso = ms => new Date(ms).toISOString();
const APP = 'users/app';
const mention = (name = APP) => ({ type: 'USER_MENTION', startIndex: 0, length: 4, userMention: { user: { name, type: 'BOT' } } });
const updated = (message, time = iso(Date.now())) => [{ message }, { 'ce-type': MESSAGE_UPDATED, 'ce-time': time, 'ce-id': `ce-${Math.random()}` }];

// ── parsing, freshness, exact mention ──────────────────────────────────────────────────────

test('message update events parse single and batch payloads and reject malformed names', () => {
  const t = '2026-11-20T10:00:00Z';
  const message = { name: 'spaces/AAA/messages/M1', sender: { name: 'users/1', type: 'HUMAN' }, lastUpdateTime: t, createTime: '2026-11-20T09:00:00Z' };
  const [one] = parseMessageUpdateEvent(...updated(message, t));
  assert.equal(one.messageName, 'spaces/AAA/messages/M1');
  assert.equal(one.space, 'spaces/AAA');
  assert.equal(one.senderName, 'users/1');
  assert.equal(one.senderType, 'HUMAN');
  assert.equal(one.eventTime, t);
  assert.equal(one.lastUpdateTime, t);
  const batch = parseMessageUpdateEvent({ messages: [{ message }, { message: { ...message, name: 'spaces/AAA/messages/M2' } }, { message: { name: 'bad' } }] },
    { 'ce-type': MESSAGE_BATCH_UPDATED, 'ce-time': t });
  assert.deepEqual(batch.map(item => item.messageName), ['spaces/AAA/messages/M1', 'spaces/AAA/messages/M2']);
  for (const name of ['', 'spaces/AAA', 'spaces/../messages/M1', 'users/1']) {
    assert.deepEqual(parseMessageUpdateEvent({ message: { name } }, { 'ce-type': MESSAGE_UPDATED }), [], name);
  }
  assert.deepEqual(parseMessageUpdateEvent({ message }, { 'ce-type': 'google.workspace.chat.message.v1.created' }), [], 'only update types');
  assert.equal(parseMessageUpdateEvent({ message: { ...message, sender: { name: 'not-a-user' } } }, { 'ce-type': MESSAGE_UPDATED })[0].senderName, '');
  assert.equal(parseMessageUpdateEvent({ message }, { 'ce-type': MESSAGE_UPDATED })[0].eventTime, t, 'falls back to lastUpdateTime');
});

test('freshness: a recent edit of a message the inbox still remembers; stale, future or old messages never act', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (editAgo, createdAgo = 60_000) => ({ eventTime: iso(now - editAgo), createTime: iso(now - createdAgo) });
  assert.equal(editIsFresh(at(59 * 60_000), now), true);
  assert.equal(editIsFresh(at(EDIT_MAX_AGE_MS + 60_000), now), false, 'stale edit event');
  assert.equal(editIsFresh(at(-10 * 60_000), now), false, 'future edit');
  assert.equal(editIsFresh(at(1000, EDITED_MESSAGE_MAX_AGE_MS - 60_000), now), true);
  assert.equal(editIsFresh(at(1000, EDITED_MESSAGE_MAX_AGE_MS + 60_000), now), false, 'message older than the inbox memory');
  assert.equal(editIsFresh({ eventTime: iso(now), createTime: '' }, now), false);
  assert.equal(editIsFresh({ eventTime: 'x', createTime: iso(now) }, now), false);
});

test('only a mention of THIS app counts; the edited text drops that mention', () => {
  assert.equal(mentionsApp({ annotations: [mention()] }, APP), true);
  assert.equal(mentionsApp({ annotations: [mention('users/otherapp')] }, APP), false, 'another app');
  assert.equal(mentionsApp({ annotations: [{ type: 'SLASH_COMMAND', slashCommand: { bot: { name: APP } } }] }, APP), false);
  assert.equal(mentionsApp({ annotations: [mention()] }, ''), false, 'unknown own id fails closed');
  assert.equal(editedArgumentText({ argumentText: ' given', text: '@App given', annotations: [mention()] }, APP), ' given');
  assert.equal(editedArgumentText({ text: '@App summarize this', annotations: [mention()] }, APP), 'summarize this');
  assert.equal(editedArgumentText({ text: 'please @App now', annotations: [{ ...mention(), startIndex: 7 }] }, APP), 'please now');
  assert.equal(editedArgumentText({ text: '@Oth hi', annotations: [mention('users/otherapp')] }, APP), '@Oth hi');
});

test('the app id is read only from unambiguous interaction messages', () => {
  assert.equal(appUserNameFromInteraction({ annotations: [mention()] }), APP);
  assert.equal(appUserNameFromInteraction({ annotations: [mention(), { ...mention(), startIndex: 9 }] }), APP, 'same app twice');
  assert.equal(appUserNameFromInteraction({ annotations: [mention(), mention('users/otherapp')] }), '', 'two apps');
  assert.equal(appUserNameFromInteraction({ annotations: [mention()] }, { kind: 'dm' }), '');
  assert.equal(appUserNameFromInteraction({ annotations: [{ type: 'SLASH_COMMAND', slashCommand: { bot: { name: 'users/cmd' } } }] }), 'users/cmd');
  assert.equal(appUserNameFromInteraction({ annotations: [{ type: 'SLASH_COMMAND', slashCommand: {} }, mention('users/x')] }), '');
  assert.equal(appUserNameFromInteraction({ annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/h', type: 'HUMAN' } } }] }), '');
});

// ── subscriptions gain the update type without duplicates ───────────────────────────────────

function fakeClient(subs = []) {
  const calls = [];
  return { calls,
    async list() { calls.push(['list']); return subs; },
    async create(arg) { calls.push(['create', arg.space]); },
    async renew(name) { calls.push(['renew', name]); },
    async reactivate(name) { calls.push(['reactivate', name]); },
    async setEventTypes(name) { calls.push(['setEventTypes', name]); },
    async remove(name) { calls.push(['remove', name]); } };
}
const sub = (name, space, { types = [REACTION_CREATED, REACTION_DELETED], expireTime = iso(Date.now() + 3.5 * 3600_000) } = {}) => ({ name, state: 'ACTIVE', expireTime,
  targetResource: `//chat.googleapis.com/${space}`, eventTypes: types, notificationEndpoint: { pubsubTopic: TOPIC }, payloadOptions: { includeResource: true } });
const run = async (client, spaces) => {
  const manager = createReactionSubscriptions({ client, topic: TOPIC, log: quiet, intervalMs: 1e9, listSpaces: async () => spaces.map(name => ({ name })) });
  await manager.start(); manager.stop();
  return manager;
};

test('a reaction-only subscription is patched in place (after any renewal); a complete one is left alone', async () => {
  const client = fakeClient([
    sub('subscriptions/old', 'spaces/A'),
    sub('subscriptions/old-expiring', 'spaces/B', { expireTime: iso(Date.now() + 10 * 60_000) }),
    sub('subscriptions/full', 'spaces/C', { types: SUBSCRIPTION_EVENT_TYPES }),
  ]);
  const manager = await run(client, ['spaces/A', 'spaces/B', 'spaces/C']);
  assert.deepEqual(client.calls.filter(c => c[0] !== 'list'), [
    ['setEventTypes', 'subscriptions/old'],
    ['renew', 'subscriptions/old-expiring'], ['setEventTypes', 'subscriptions/old-expiring'],
  ]);
  assert.equal(manager.status.state, 'active');
  assert.equal(manager.status.active, 3);
});

test('a refused patch creates the full subscription before retiring the old one; other failures keep reactions', async () => {
  const refused = fakeClient([sub('subscriptions/old', 'spaces/A')]);
  refused.setEventTypes = async name => { refused.calls.push(['setEventTypes', name]); const e = new Error('bad mask'); e.status = 400; throw e; };
  await run(refused, ['spaces/A']);
  assert.deepEqual(refused.calls.filter(c => c[0] !== 'list'), [['setEventTypes', 'subscriptions/old'], ['create', 'spaces/A'], ['remove', 'subscriptions/old']]);

  const createFails = fakeClient([sub('subscriptions/old', 'spaces/A')]);
  createFails.setEventTypes = refused.setEventTypes;
  createFails.create = async () => { createFails.calls.push(['create']); const e = new Error('quota'); e.status = 429; throw e; };
  const kept = await run(createFails, ['spaces/A']);
  assert.equal(createFails.calls.some(c => c[0] === 'remove'), false, 'the old subscription survives a failed replacement');
  assert.equal(createFails.calls.filter(c => c[0] === 'create').length, 1, 'no second create in the same pass');
  assert.equal(kept.status.state, 'degraded');

  const denied = fakeClient([sub('subscriptions/old', 'spaces/A', { expireTime: iso(Date.now() + 10 * 60_000) })]);
  denied.setEventTypes = async () => { const e = new Error('denied'); e.status = 403; throw e; };
  const status = await run(denied, ['spaces/A']);
  assert.deepEqual(denied.calls.filter(c => c[0] !== 'list'), [['renew', 'subscriptions/old']], 'renewed first, never recreated');
  assert.equal(status.status.state, 'degraded');
  assert.match(status.status.error, /denied/);

  const vanished = fakeClient([sub('subscriptions/old', 'spaces/A')]);
  vanished.setEventTypes = async () => { const e = new Error('gone'); e.status = 404; throw e; };
  await run(vanished, ['spaces/A']);
  assert.deepEqual(vanished.calls.filter(c => c[0] === 'create'), [['create', 'spaces/A']], 'a vanished subscription is recreated');
});

test('with an old and a complete subscription for one space, the complete one is kept', async () => {
  const client = fakeClient([sub('subscriptions/old', 'spaces/A'), sub('subscriptions/new', 'spaces/A', { types: SUBSCRIPTION_EVENT_TYPES })]);
  await run(client, ['spaces/A']);
  assert.deepEqual(client.calls.filter(c => c[0] !== 'list'), [['remove', 'subscriptions/old']]);
});

test('the REST client patches the full event type list', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; };
  await createWorkspaceEventsClient({ auth: { token: async () => 't' }, fetchImpl }).setEventTypes('subscriptions/s1');
  assert.deepEqual(seen, [{ url: 'https://workspaceevents.googleapis.com/v1/subscriptions/s1?updateMask=event_types', method: 'PATCH',
    body: { eventTypes: [REACTION_CREATED, REACTION_DELETED, MESSAGE_UPDATED] } }]);
});

// ── Pub/Sub → transport → durable inbox → ingest ───────────────────────────────────────────

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let fixtureCount = 0;
async function fixture({ run: runEngine, spaceType = 'SPACE', topic = TOPIC, botUserId = APP, subscription = null } = {}) {
  const n = ++fixtureCount;
  const space = `spaces/ED${n}`;
  const posts = [];
  const connector = { platform: 'googlechat', async post(p) {
    posts.push(p); return { messageId: `${space}/messages/bot-${posts.length}`, conversationId: p.conversationId, threadKey: p.threadKey };
  }, async edit() {}, async directory() { return null; } };
  const runs = [];
  const ingest = createIngest({ connector, run: async args => { runs.push(args); return runEngine ? runEngine(args) : { content: 'done', engine: 'claude' }; }, log: quiet });
  const delivered = [];
  const api = {
    getMessage: async () => { const e = new Error('nf'); e.status = 404; throw e; },
    getSpace: async name => ({ name, spaceType, displayName: spaceType === 'DIRECT_MESSAGE' ? '' : 'Room' }),
    listSpaces: async () => [],
  };
  const transport = await startGoogleChat({
    subscription: subscription || `projects/cg-test/subscriptions/ed-${n}`, reactionTopic: topic, botUserId,
    capabilities: googleChatAdapter.capabilities, log: quiet,
    onMessage: async (m, opts) => { delivered.push(m); return ingest(m, opts); },
    deps: { auth: { token: async () => 't' }, api, eventsApi: api, connector, puller: { start() {}, async stop() {} },
      reactionSubscriptions: { start() {}, stop() {}, reconcile() {}, status: { state: 'active', active: 1, spaces: 1 } } },
  });
  // The shape Workspace Events delivers: the CURRENT message, sender as users/NNN only.
  const edit = (id, text, { mentioned = true, app = APP, sender = { name: 'users/owner', type: 'HUMAN' }, thread = 'E1', time = iso(Date.now()), created = iso(Date.now() - 60_000), lastUpdateTime = time } = {}) =>
    transport.onEvent(...updated({ name: `${space}/messages/${id}`, text: mentioned ? `@App ${text}` : text, sender, thread: { name: `${space}/threads/${thread}` },
      space: { name: space }, createTime: created, lastUpdateTime, annotations: mentioned ? [mention(app)] : [] }, time));
  const say = (id, text, { sender = OWNER, thread = 'E1', annotations = [mention()] } = {}) => {
    const message = { name: `${space}/messages/${id}`, text: `@App ${text}`, argumentText: text, sender, thread: { name: `${space}/threads/${thread}` }, annotations };
    return transport.onEvent({ chat: { messagePayload: { message, space: { name: space, spaceType, displayName: spaceType === 'DIRECT_MESSAGE' ? '' : 'Room' } } } }, { 'ce-type': 'google.workspace.chat.message.v1.created' });
  };
  return { space, posts, delivered, runs, transport, edit, say };
}
const OWNER = { name: 'users/owner', email: 'owner@ed.test', displayName: 'Owner', type: 'HUMAN' };
await setUser('owner@ed.test', { approved: true, name: 'Owner', googleChatUserName: 'users/owner' });
await setUser('guest@ed.test', { approved: false, name: 'Guest', googleChatUserName: 'users/guest' });
const settle = async (predicate, label) => { for (let i = 0; i < 2000 && !predicate(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(predicate(), label); };
const pause = ms => new Promise(r => setTimeout(r, ms));

test('an edit that adds the app mention runs the edited text once, as its sender, in its thread', async () => {
  const f = await fixture();
  try {
    const time = iso(Date.now());
    await f.edit('m1', 'summarize the plan', { time });
    await f.edit('m1', 'summarize the plan', { time }); // Pub/Sub redelivery
    await settle(() => f.runs.length === 1, 'ran once');
    const inbound = f.delivered[0];
    assert.equal(inbound.trigger, 'edit');
    assert.equal(inbound.userId, 'owner@ed.test', 'attributed to the sender through the recorded mapping');
    assert.equal(inbound.text, 'summarize the plan');
    assert.equal(inbound.mentionsBot, true);
    assert.equal(inbound.threadKey, `${f.space}/threads/E1`);
    assert.equal(inbound.conversationId, `gchat:${f.space}`);
    // Editing the already-answered message again (mention kept) never runs it a second time.
    await f.edit('m1', 'summarize the plan in French', { time: iso(Date.now() + 1000) });
    await pause(40);
    assert.equal(f.runs.length, 1);
  } finally { await f.transport.stop(); }
});

test('an edit of a message the app already received with its mention does nothing', async () => {
  const f = await fixture();
  try {
    await f.say('orig', 'first request');
    await settle(() => f.runs.length === 1, 'original mention ran');
    await f.edit('orig', 'first request, edited');
    // A control command took the control lane; editing it into an ordinary request still counts
    // as the same, already-handled message.
    await f.say('ctl', '/status');
    await settle(() => f.delivered.some(m => m.messageId === `${f.space}/messages/ctl`), 'control delivered');
    await f.edit('ctl', 'now do real work');
    await pause(40);
    assert.equal(f.runs.length, 1);
    assert.equal(f.delivered.filter(m => m.trigger === 'edit').length, 0);
  } finally { await f.transport.stop(); }
});

test('edits without this app\'s mention, by apps, stale, unmapped, unedited or in a DM never act; unapproved senders are refused', async () => {
  const f = await fixture();
  try {
    await f.edit('plain', 'no mention', { mentioned: false });
    await f.edit('other', 'for another app', { app: 'users/otherapp' });
    await f.edit('bot', 'progress', { sender: { name: APP, type: 'BOT' } });
    await f.edit('stale', 'late', { time: iso(Date.now() - EDIT_MAX_AGE_MS - 60_000) });
    await f.edit('ancient', 'old message', { created: iso(Date.now() - EDITED_MESSAGE_MAX_AGE_MS - 60_000) });
    await f.edit('stranger', 'who', { sender: { name: 'users/stranger', type: 'HUMAN' } });
    await f.edit('noedit', 'attachment finished', { lastUpdateTime: '' });
    await pause(40);
    assert.deepEqual(f.delivered, []);
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE event_id LIKE ?").get(`${f.space}/%`).n, 0, 'nothing reached the inbox');
    await f.edit('guest', 'let me in', { sender: { name: 'users/guest', type: 'HUMAN' } });
    await settle(() => f.posts.some(p => /not approved/.test(p.text)), 'the normal authorization gate refuses');
    assert.equal(f.runs.length, 0);
  } finally { await f.transport.stop(); }
  const dm = await fixture({ spaceType: 'DIRECT_MESSAGE' });
  try {
    await dm.edit('d1', 'edited DM');
    await pause(40);
    assert.deepEqual(dm.delivered, [], 'a DM already answered the message itself');
  } finally { await dm.transport.stop(); }
});

test('removing the mention withdraws a queued edit trigger; adding it back later runs once', async () => {
  const started = deferred(); const release = deferred();
  const f = await fixture({ run: async () => { started.resolve(); await release.promise; return { content: 'ok', engine: 'claude' }; } });
  try {
    await f.say('req', 'first');
    await started.promise;
    const t0 = Date.now();
    await f.edit('later', 'second', { time: iso(t0) });
    const queued = () => getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE event_id = ? AND status = 'queued'").get(`${f.space}/messages/later`).n;
    assert.equal(queued(), 1, 'queued behind the running turn');
    await f.edit('later', 'second', { mentioned: false, time: iso(t0 - 5000) });
    assert.equal(queued(), 1, 'an OLDER update (out of order) withdraws nothing');
    await f.edit('later', 'second', { mentioned: false, time: iso(t0 + 1000) });
    assert.equal(queued(), 0, 'withdrawn');
    release.resolve();
    await pause(60);
    assert.equal(f.runs.length, 1, 'the withdrawn edit never ran');
    await f.edit('later', 'second again', { time: iso(t0 + 2000) });
    await settle(() => f.runs.length === 2, 'a re-added mention counts as new');
    assert.equal(f.delivered.at(-1).text, 'second again');
  } finally { release.resolve(); await f.transport.stop(); }
});

test('batch updates act per message; without a reaction topic updates are inert and never read as new messages', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const message = id => ({ name: `${f.space}/messages/${id}`, text: `@App do ${id}`, sender: { name: 'users/owner', type: 'HUMAN' },
      thread: { name: `${f.space}/threads/${id}` }, createTime: iso(now - 1000), lastUpdateTime: iso(now), annotations: [mention()] });
    await f.transport.onEvent({ messages: [{ message: message('b1') }, { message: message('b2') }] }, { 'ce-type': MESSAGE_BATCH_UPDATED, 'ce-time': iso(now) });
    await settle(() => f.runs.length === 2, 'both ran');
    assert.deepEqual(f.delivered.map(m => m.text).sort(), ['do b1', 'do b2']);
  } finally { await f.transport.stop(); }
  const off = await fixture({ topic: '' });
  try {
    await off.edit('m', 'hello');
    await pause(40);
    assert.deepEqual(off.delivered, []);
  } finally { await off.transport.stop(); }
});

test('the app id is learned from a mention sent to the app, kept across restarts, and then enables edits', async () => {
  const subscription = `projects/cg-test/subscriptions/ed-learn-${Date.now()}`;
  const first = await fixture({ botUserId: '', subscription });
  try {
    await first.edit('early', 'too soon');
    await pause(30);
    assert.deepEqual(first.delivered, [], 'unknown own id: inactive');
    await first.say('hello', 'hi');
    await settle(() => first.runs.length === 1, 'mention ran');
    assert.equal(first.transport.botUserId, APP);
  } finally { await first.transport.stop(); }
  const second = await fixture({ botUserId: '', subscription });
  try {
    assert.equal(second.transport.botUserId, APP, 'remembered');
    await second.edit('later', 'now it works');
    await settle(() => second.runs.length === 1, 'edit ran after restart');
  } finally { await second.transport.stop(); }
});
