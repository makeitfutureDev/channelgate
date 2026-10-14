import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGraphEvents } from '../src/platforms/msteams/graph-activity.js';
import { teamsActivationFingerprint } from '../src/platforms/msteams/reactions.js';

const start = '2026-10-09T10:00:00.000Z', added = '2026-10-09T10:02:20.912Z';
const row = {
  conversationId: 'teams:19:channel@thread.tacv2', startedAt: start,
  reactionSnapshotsStartedAt: start, controlSnapshotsStartedAt: start, alienReactionStartedAt: start,
  reactionAliasesStartedAt: start, graphRobotStartedAt: start,
  activationReactionsStartedAt: start, activationReactionsVersion: '',
  activationReactionsFingerprint: teamsActivationFingerprint(),
  context: { conversation: { id: '19:channel@thread.tacv2', conversationType: 'channel' },
    serviceUrl: 'https://smba.trafficmanager.net/teams/', channelData: { tenant: { id: 'tenant' } } },
};
const opts = { botId: '28:bot', activationVersion: '', now: () => Date.parse('2026-10-09T10:05:00Z'),
  resolveMember: async id => ({ id: `29:${id}`, name: 'Reactor' }) };
const fixture = () => ({ id: 'target', messageType: 'message', from: { user: { id: 'author' } },
  createdDateTime: '2026-10-08T10:00:00Z', lastModifiedDateTime: '2026-10-09T10:02:37.026Z',
  body: { content: 'Reply exactly SNAPSHOT_OK', contentType: 'text' },
  reactions: [{ reactionType: '👽', displayName: 'Alien', createdDateTime: added, user: { user: { id: 'reactor' } } }] });

test('history-free Graph reaction activates as its reactor on an older channel message', async () => {
  for (const history of [undefined, []]) {
    const message = { ...fixture(), ...(history === undefined ? {} : { messageHistory: history }) };
    const events = await normalizeGraphEvents(message, row, opts);
    assert.equal(events.length, 1);
    assert.equal(events[0].reactionAction, 'engage');
    assert.equal(events[0].userId, '29:reactor');
    assert.equal(events[0].threadKey, 'target');
    assert.equal(events[0].replyToId, 'target');
    assert.equal(events[0].text, 'Reply exactly SNAPSHOT_OK');
    assert.equal(Object.hasOwn(message, 'messageHistory'), history !== undefined, 'normalization must not mutate snapshots');
  }
});

test('snapshot replay and later history share an identity; a genuine re-addition changes it', async () => {
  const message = fixture();
  const [first] = await normalizeGraphEvents(message, row, opts);
  message.lastModifiedDateTime = '2026-10-09T10:03:00Z';
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, first.raw.eventId);
  message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:02:37.026Z', reaction: message.reactions[0] }];
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, first.raw.eventId, 'later history modification time must not duplicate the addition');
  message.reactions[0].createdDateTime = '2026-10-09T10:04:00Z';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), [], 'old history cannot relabel a newer current addition');
  delete message.messageHistory;
  assert.notEqual((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, first.raw.eventId);
  message.reactions = [];
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
});

test('snapshot activation requires fresh provider addition time and persisted upgrade cutoff', async () => {
  for (const time of [undefined, null, '', 'invalid', start, '2026-10-08T10:04:00Z', '2026-10-09T10:06:00Z']) {
    const message = fixture(); message.reactions[0].createdDateTime = time;
    assert.deepEqual(await normalizeGraphEvents(message, row, opts), [], String(time));
  }
  for (const cutoff of [undefined, 'invalid', added, '2026-10-09T10:03:00Z']) {
    assert.deepEqual(await normalizeGraphEvents(fixture(), { ...row, reactionSnapshotsStartedAt: cutoff }, opts), []);
  }
  assert.deepEqual(await normalizeGraphEvents(fixture(), row, { ...opts, now: () => Date.parse('2026-10-11T10:05:00Z') }), []);
});

test('history cannot change an addition identity at the rolling freshness or future-time boundary', async () => {
  const message = fixture();
  const [first] = await normalizeGraphEvents(message, row, opts);
  message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:02:37.026Z', reaction: message.reactions[0] }];
  const at = time => ({ ...opts, now: () => Date.parse(time) });
  assert.equal((await normalizeGraphEvents(message, row, at('2026-10-10T10:02:20.911Z')))[0].raw.eventId, first.raw.eventId);
  assert.deepEqual(await normalizeGraphEvents(message, row, at('2026-10-10T10:02:20.912Z')), []);
  assert.deepEqual(await normalizeGraphEvents(message, row, at('2026-10-10T10:02:30Z')), [], 'recent modification cannot revive expired creation');
  message.reactions[0].createdDateTime = '2026-10-09T10:06:00Z';
  message.messageHistory[0].modifiedDateTime = '2026-10-09T10:06:10Z';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), [], 'future creation cannot borrow a history identity');
  assert.equal((await normalizeGraphEvents(message, row, at('2026-10-09T10:06:00Z'))).length, 1);
});

test('multiple activation emoji from one reactor resolve the actual addition independently of array order', async () => {
  const message = fixture(), alien = message.reactions[0];
  const [first] = await normalizeGraphEvents(message, row, opts);
  const like = { ...alien, reactionType: '👍', displayName: 'Like', createdDateTime: '2026-10-09T10:03:00Z' };
  message.reactions.push(like);
  const [second] = await normalizeGraphEvents(message, row, opts);
  assert.notEqual(second.raw.eventId, first.raw.eventId);
  message.reactions.reverse();
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:03:10Z', reaction: { ...like, reactionType: 'like' } }];
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  message.reactions.reverse();
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
});

test('Like skin-tone variants sharing an activation key retain order-independent provider identities', async () => {
  const message = fixture();
  message.reactions[0].reactionType = '👍';
  const like = message.reactions[0];
  const [first] = await normalizeGraphEvents(message, row, opts);
  const tone = { ...like, reactionType: '👍🏻', createdDateTime: '2026-10-09T10:03:00Z' };
  message.reactions.push(tone);
  const [second] = await normalizeGraphEvents(message, row, opts);
  assert.notEqual(second.raw.eventId, first.raw.eventId);
  message.reactions.reverse();
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:03:10Z', reaction: { ...tone, reactionType: 'like-tone1' } }];
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  delete message.messageHistory[0].reaction.createdDateTime;
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  message.reactions.reverse();
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
  tone.createdDateTime = '2026-10-09T10:03:00.000+00:00';
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, second.raw.eventId);
});

test('history removals, ambiguity and malformed history never fall back to a present reaction', async () => {
  for (const actions of ['reactionRemoved', 'reactionAdded, reactionRemoved', 'reactionAdded, unknownFutureValue']) {
    const message = fixture(); message.messageHistory = [{ actions, modifiedDateTime: '2026-10-09T10:03:00Z', reaction: message.reactions[0] }];
    assert.deepEqual(await normalizeGraphEvents(message, row, opts), [], actions);
  }
  for (const messageHistory of [null, {}, 'invalid']) {
    assert.deepEqual(await normalizeGraphEvents({ ...fixture(), messageHistory }, row, opts), []);
  }
});

test('history-free Stop and Tick reactions act as their reactor', async () => {
  for (const [reactionType, action] of [['🛑', 'stop'], ['stopsign', 'stop'], ['✅', 'ack'], ['white_check_mark', 'ack']]) {
    for (const history of [undefined, []]) {
      const message = { ...fixture(), ...(history === undefined ? {} : { messageHistory: history }) };
      message.reactions[0].reactionType = reactionType;
      const events = await normalizeGraphEvents(message, row, opts);
      assert.equal(events.length, 1, reactionType);
      assert.equal(events[0].reactionAction, action);
      assert.equal(events[0].userId, '29:reactor');
      assert.equal(events[0].replyToId, 'target');
    }
  }
  const message = fixture(); message.reactions[0].reactionType = '👎';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
});

test('snapshot controls need their own cutoff, a recent addition and a present reaction', async () => {
  const stop = () => { const message = fixture(); message.reactions[0].reactionType = '🛑'; return message; };
  for (const cutoff of [undefined, 'invalid', added]) {
    assert.deepEqual(await normalizeGraphEvents(stop(), { ...row, controlSnapshotsStartedAt: cutoff }, opts), [], String(cutoff));
  }
  const at = time => ({ ...opts, now: () => Date.parse(time) });
  assert.equal((await normalizeGraphEvents(stop(), row, at('2026-10-09T10:12:20Z'))).length, 1);
  assert.deepEqual(await normalizeGraphEvents(stop(), row, at('2026-10-09T10:12:21Z')), [], 'a late Stop must not end newer work');
  for (const time of [undefined, '', 'invalid', '2026-10-09T10:06:00Z']) {
    const message = stop(); message.reactions[0].createdDateTime = time;
    assert.deepEqual(await normalizeGraphEvents(message, row, opts), [], String(time));
  }
  const removed = stop(); removed.reactions = [];
  assert.deepEqual(await normalizeGraphEvents(removed, row, opts), []);
  const history = stop();
  history.messageHistory = [{ actions: 'reactionRemoved', modifiedDateTime: '2026-10-09T10:03:00Z', reaction: history.reactions[0] }];
  assert.deepEqual(await normalizeGraphEvents(history, row, opts), [], 'removal history stays authoritative');
});

test('a snapshot control and its later history share one identity', async () => {
  const message = fixture(); message.reactions[0].reactionType = '🛑';
  const [first] = await normalizeGraphEvents(message, row, opts);
  message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:02:37.026Z', reaction: message.reactions[0] }];
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].raw.eventId, first.raw.eventId);
  const legacy = { ...row }; delete legacy.controlSnapshotsStartedAt;
  const [old] = await normalizeGraphEvents(message, legacy, opts);
  assert.equal(old.reactionAction, 'stop', 'pre-cutoff history controls keep working');
  assert.notEqual(old.raw.eventId, first.raw.eventId, 'pre-cutoff controls keep their history identity');
});

test('snapshot fallback retains roster, bot ownership, setting versions and all addition cutoffs', async () => {
  const message = fixture();
  assert.deepEqual(await normalizeGraphEvents(message, row, { ...opts, resolveMember: async () => null }), []);
  assert.deepEqual(await normalizeGraphEvents(message, row, { ...opts, resolveMember: async () => ({ id: '28:bot' }) }), []);
  for (const key of ['startedAt', 'activationReactionsStartedAt', 'alienReactionStartedAt']) {
    assert.deepEqual(await normalizeGraphEvents(message, { ...row, [key]: added }, opts), [], key);
  }
  assert.deepEqual(await normalizeGraphEvents(message, row, { ...opts, activationVersion: 'changed' }), []);
  message.from = { application: { id: 'different-bot' } };
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  message.from.application.id = 'bot';
  assert.equal((await normalizeGraphEvents(message, row, opts))[0].text, 'Continue the task from this message.');
  message.deletedDateTime = '2026-10-09T10:03:00Z';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
});

test('configured snapshot emoji replaces defaults and keeps its configuration cutoff', async () => {
  const selected = ['🚀'], version = start;
  const configured = { ...row, activationReactionsVersion: version, activationReactionsFingerprint: teamsActivationFingerprint(selected) };
  const options = { ...opts, activationReactions: selected, activationVersion: version };
  assert.deepEqual(await normalizeGraphEvents(fixture(), configured, options), []);
  const message = fixture(); message.reactions[0].reactionType = '🚀';
  assert.equal((await normalizeGraphEvents(message, configured, options)).length, 1);
  assert.deepEqual(await normalizeGraphEvents(message, { ...configured, activationReactionsStartedAt: added }, options), []);
});

test('legacy history event identities stay unchanged when snapshot support is initialized', async () => {
  const message = fixture(); message.messageHistory = [{ actions: 'reactionAdded', modifiedDateTime: '2026-10-09T10:02:37.026Z', reaction: message.reactions[0] }];
  const legacy = { ...row }; delete legacy.reactionSnapshotsStartedAt;
  const [old] = await normalizeGraphEvents(message, legacy, opts);
  const [upgraded] = await normalizeGraphEvents(message, { ...row, reactionSnapshotsStartedAt: '2026-10-09T10:04:00Z' }, opts);
  assert.equal(upgraded.raw.eventId, old.raw.eventId);
});
