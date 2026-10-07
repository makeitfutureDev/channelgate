import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeGraphEvents } from '../src/platforms/msteams/graph-activity.js';
const row = { conversationId: 'teams:19:test@thread.v2', startedAt: '2026-09-09T10:00:00Z', reactionAliasesStartedAt: '2026-09-09T10:00:00Z', alienReactionStartedAt: '2026-09-09T10:00:00Z', context: { conversation: { id: '19:test@thread.v2', conversationType: 'groupchat' }, serviceUrl: 'https://smba.trafficmanager.net/teams/', channelData: { tenant: { id: 'tenant' } } } };
const reaction = { reactionType: '🤖', user: { user: { id: 'reactor' } } };
const fixture = () => ({ id: 'message1', messageType: 'message', from: { user: { id: 'author' } }, body: { contentType: 'html', content: '<p>Handle this &amp; that</p>' }, reactions: [reaction], messageHistory: [{ actions: 'reactionAdded', modifiedDateTime: '2026-09-09T10:01:00Z', reaction }] });
const opts = { now: () => Date.parse('2026-09-09T11:00:00Z'), botId: '28:bot', resolveMember: async id => ({ id: `29:${id}`, name: id }) };
test('robot reaction runs as reactor and anchors the original message', async () => {
  const [event] = await normalizeGraphEvents(fixture(), row, opts);
  assert.equal(event.userId, '29:reactor'); assert.equal(event.trigger, 'reaction');
  assert.equal(event.replyToId, 'message1'); assert.equal(event.text, 'Handle this & that');
  assert.equal(event.mentionsBot, false); assert.equal(event.threadKey, '');
  assert.match(event.messageId, /^reaction:/);
  const legacyId = createHash('sha256').update(JSON.stringify([row.conversationId, 'message1', 'reaction', 'reactor', '2026-09-09T10:01:00Z'])).digest('hex');
  assert.equal(event.raw.eventId, legacyId, 'upgrading must not replay already-dispatched robot events');
});
test('Teams activation and control IDs trigger Graph reactions without granting authority to other emoji', async () => {
  for (const reactionType of ['alien', ':alien:', '👽', '1f47d_extraterrestrialalien', 'like', '👍', '👍🏽', 'like-tone3', 'smilerobot', 'hearteyesrobot', ':hearteyesrobot:', 'stopsign', '2705_whiteheavycheckmark']) {
    const message = fixture();
    message.reactions = [{ ...reaction, reactionType }];
    message.messageHistory[0].reaction = message.reactions[0];
    const [event] = await normalizeGraphEvents(message, row, opts);
    assert.equal(event.userId, '29:reactor');
    assert.equal(event.replyToId, 'message1');
    assert.equal(event.trigger, 'reaction');
    assert.equal(event.reactionAction, ({ stopsign: 'stop', '2705_whiteheavycheckmark': 'ack' })[reactionType] || 'engage');
    message.reactions = [];
    assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  }
  for (const reactionType of ['hearteyes', 'hearteyesdog']) {
    const message = fixture();
    message.reactions = [{ ...reaction, reactionType }];
    message.messageHistory[0].reaction = message.reactions[0];
    assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  }
});
test('history dedup key survives later snapshots but remove/readd gets a distinct key', async () => {
  const message = fixture(); const [first] = await normalizeGraphEvents(message, row, opts);
  message.lastModifiedDateTime = '2026-09-09T10:02:00Z';
  const [repeat] = await normalizeGraphEvents(message, row, opts);
  assert.equal(first.raw.eventId, repeat.raw.eventId);
  message.messageHistory[0].modifiedDateTime = '2026-09-09T10:03:00Z';
  const [added] = await normalizeGraphEvents(message, row, opts);
  assert.notEqual(first.raw.eventId, added.raw.eventId);
});
test('removed, historical, nonrobot, missing roster and deleted messages do not trigger', async () => {
  for (const change of [m => { m.reactions = []; }, m => { m.messageHistory[0].modifiedDateTime = row.startedAt; }, m => { m.messageHistory = [{ actions: 'reactionRemoved', reaction }]; }, m => { m.deletedDateTime = 'now'; }, m => { m.messageHistory[0].reaction = { ...reaction, reactionType: '👎' }; }]) {
    const message = fixture(); change(message); assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  }
  assert.deepEqual(await normalizeGraphEvents(fixture(), row, { ...opts, resolveMember: async () => null }), []);
});
test('edits require genuine bot mentions in groups and use edit time not modification time', async () => {
  const message = fixture(); message.messageHistory = []; message.lastModifiedDateTime = '2026-09-09T10:02:00Z';
  message.body.content = '<at>Xavier</at> process';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  message.lastEditedDateTime = '2026-09-09T10:02:00Z';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
  message.mentions = [{ mentioned: { application: { id: 'bot' } } }];
  const [event] = await normalizeGraphEvents(message, row, opts);
  assert.equal(event.trigger, 'edit'); assert.equal(event.userId, '29:author'); assert.equal(event.messageId, 'message1');
});
test('own bot reactions continue while other bots and bot edits are ignored', async () => {
  const message = fixture(); message.from = { application: { id: 'bot' } }; message.lastEditedDateTime = '2026-09-09T10:02:00Z';
  const events = await normalizeGraphEvents(message, row, opts);
  assert.equal(events.length, 1); assert.equal(events[0].text, 'Continue the task from this message.');
  message.from.application.id = 'another-bot';
  assert.deepEqual(await normalizeGraphEvents(message, row, opts), []);
});
test('channel reply reactions stay in native thread and quoted edits keep the reference', async () => {
  const channel = structuredClone(row); channel.context.conversation.conversationType = 'channel';
  const message = fixture(); message.replyToId = 'native-root';
  const [event] = await normalizeGraphEvents(message, channel, opts); assert.equal(event.threadKey, 'native-root');
  message.lastEditedDateTime = '2026-09-09T10:02:00Z'; message.mentions = [{ mentioned: { application: { id: 'bot' } } }];
  message.body.content = '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quoted">old</blockquote>new';
  const [edit] = await normalizeGraphEvents(message, row, opts); assert.equal(edit.replyToId, 'quoted');
});

test('old history never replays after inbox tombstone retention', async () => {
  assert.deepEqual(await normalizeGraphEvents(fixture(), row, { ...opts, now: () => Date.parse('2026-09-20T11:00:00Z') }), []);
});

test('expanded reaction aliases require persisted cutoff and cannot replay older history', async () => {
  for (const reactionType of ['like', '👍', ':hearteyesrobot:', ':stopsign:', ':white_check_mark:']) {
    const message = fixture();
    message.reactions = [{ ...reaction, reactionType }];
    message.messageHistory[0].reaction = message.reactions[0];
    message.lastModifiedDateTime = '2026-09-09T10:04:00Z'; // unrelated update must not replay old addition
    const beforeUpgrade = { ...row, reactionAliasesStartedAt: '2026-09-09T10:02:00Z' };
    assert.deepEqual(await normalizeGraphEvents(message, beforeUpgrade, opts), []);
    assert.deepEqual(await normalizeGraphEvents(message, { ...row, reactionAliasesStartedAt: undefined }, opts), []);
    message.messageHistory[0].modifiedDateTime = '2026-09-09T10:03:00Z';
    assert.equal((await normalizeGraphEvents(message, beforeUpgrade, opts)).length, 1);
  }
  // Existing robot IDs retain their admission and stable dedup behavior on upgrade.
  assert.equal((await normalizeGraphEvents(fixture(), { ...row, reactionAliasesStartedAt: undefined }, opts)).length, 1);
});


test('Alien expansion has its own cutoff even on a previously upgraded subscription', async () => {
  for (const reactionType of ['alien', ':alien:', '👽', '👽\uFE0F', '1f47d_extraterrestrialalien']) {
    const message = fixture();
    message.reactions = [{ ...reaction, reactionType }];
    message.messageHistory[0].reaction = message.reactions[0];
    const upgraded = { ...row, alienReactionStartedAt: '2026-09-09T10:02:00Z' };
    assert.deepEqual(await normalizeGraphEvents(message, upgraded, opts), [], 'old Alien must not replay');
    for (const cutoff of [undefined, 'invalid']) {
      assert.deepEqual(await normalizeGraphEvents(message, { ...upgraded, alienReactionStartedAt: cutoff }, opts), []);
    }
    message.messageHistory[0].modifiedDateTime = upgraded.alienReactionStartedAt;
    assert.deepEqual(await normalizeGraphEvents(message, upgraded, opts), [], 'cutoff equality is excluded');
    message.messageHistory[0].modifiedDateTime = '2026-09-09T10:03:00Z';
    const [event] = await normalizeGraphEvents(message, upgraded, opts);
    assert.equal(event.reactionAction, 'engage');
    assert.equal(event.userId, '29:reactor');
    assert.equal(event.raw.eventId, (await normalizeGraphEvents(message, upgraded, opts))[0].raw.eventId);
    message.messageHistory.push({ actions: 'reactionRemoved', modifiedDateTime: '2026-09-09T10:04:00Z', reaction: message.reactions[0] });
    assert.deepEqual(await normalizeGraphEvents(message, upgraded, opts), []);
  }
});


test('Graph robot Unicode variant requires exact provider metadata, fresh history and its own cutoff', async () => {
  const metadata = { ...reaction, reactionType: '😍', displayName: 'Heart eyes robot', reactionContentUrl: null };
  const message = fixture();
  message.reactions = [metadata]; message.messageHistory[0].reaction = metadata;
  const updated = { ...row, graphRobotStartedAt: '2026-09-09T10:00:00Z' };
  const [event] = await normalizeGraphEvents(message, updated, opts);
  assert.equal(event.reactionAction, 'engage'); assert.equal(event.userId, '29:reactor');
  assert.equal(event.replyToId, 'message1');
  for (const change of [{ displayName: undefined }, { displayName: 'Heart eyes' },
    { displayName: 'Heart eyes dog' }, { displayName: 'Heart eyes robot ' },
    { reactionType: 'custom' }, { reactionContentUrl: 'https://example.org/custom.png' }]) {
    const other = { ...metadata, ...change };
    message.reactions = [other]; message.messageHistory[0].reaction = other;
    assert.deepEqual(await normalizeGraphEvents(message, updated, opts), []);
  }
  // Current metadata cannot relabel a history addition or prove when an ambiguous emoji was added.
  message.reactions = [metadata]; message.messageHistory[0].reaction = { ...metadata, displayName: undefined };
  assert.deepEqual(await normalizeGraphEvents(message, updated, opts), []);
  message.messageHistory[0].reaction = metadata; message.reactions = [{ ...metadata, displayName: 'Heart eyes' }];
  assert.deepEqual(await normalizeGraphEvents(message, updated, opts), []);
  message.reactions = [metadata];
  for (const graphRobotStartedAt of [undefined, 'invalid', '2026-09-09T10:01:00Z', '2026-09-09T10:02:00Z']) {
    assert.deepEqual(await normalizeGraphEvents(message, { ...updated, graphRobotStartedAt }, opts), []);
  }
  message.messageHistory.push({ actions: 'reactionRemoved', modifiedDateTime: '2026-09-09T10:02:00Z', reaction: metadata });
  assert.deepEqual(await normalizeGraphEvents(message, updated, opts), []);
  message.messageHistory.push({ actions: 'reactionAdded', modifiedDateTime: '2026-09-09T10:03:00Z', reaction: metadata });
  const [readded] = await normalizeGraphEvents(message, updated, opts);
  assert.notEqual(readded.raw.eventId, event.raw.eventId);
  assert.equal(readded.raw.eventId, (await normalizeGraphEvents(message, updated, opts))[0].raw.eventId);
  message.messageHistory = [];
  assert.deepEqual(await normalizeGraphEvents(message, updated, opts), [], 'a snapshot alone is not addition evidence');
});

test('configured Graph activation selection replaces defaults while controls remain fixed', async () => {
  const { teamsActivationFingerprint } = await import('../src/platforms/msteams/reactions.js');
  const selected = ['1f680_rocket'];
  const configuredRow = { ...row, activationReactionsFingerprint: teamsActivationFingerprint(selected), activationReactionsStartedAt: row.startedAt };
  for (const reactionType of ['🚀', '1f680_rocket', '🤖', 'alien', 'like', '🛑', '✅']) {
    const message = fixture();
    message.reactions = [{ ...reaction, reactionType }];
    message.messageHistory[0].reaction = message.reactions[0];
    const events = await normalizeGraphEvents(message, configuredRow, { ...opts, activationReactions: selected });
    assert.equal(events.length, ['🤖', 'alien', 'like'].includes(reactionType) ? 0 : 1, reactionType);
  }
  const message = fixture(); message.reactions = [{ ...reaction, reactionType: '🚀' }];
  message.messageHistory[0].reaction = message.reactions[0];
  assert.deepEqual(await normalizeGraphEvents(message, row, { ...opts, activationReactions: selected }), [], 'missing config version must fail closed');
  assert.deepEqual(await normalizeGraphEvents(message, { ...configuredRow, activationReactionsStartedAt: '2026-09-09T10:02:00Z' }, { ...opts, activationReactions: selected }), [], 'old history must not activate after config changes');
  message.messageHistory = [];
  assert.deepEqual(await normalizeGraphEvents(message, configuredRow, { ...opts, activationReactions: selected }), [], 'snapshot alone must not activate');
});
