import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGraphEvents } from '../src/platforms/msteams/graph-activity.js';
const row = { conversationId: 'teams:19:test@thread.v2', startedAt: '2026-09-09T10:00:00Z', context: { conversation: { id: '19:test@thread.v2', conversationType: 'groupchat' }, serviceUrl: 'https://smba.trafficmanager.net/teams/', channelData: { tenant: { id: 'tenant' } } } };
const reaction = { reactionType: '🤖', user: { user: { id: 'reactor' } } };
const fixture = () => ({ id: 'message1', messageType: 'message', from: { user: { id: 'author' } }, body: { contentType: 'html', content: '<p>Handle this &amp; that</p>' }, reactions: [reaction], messageHistory: [{ actions: 'reactionAdded', modifiedDateTime: '2026-09-09T10:01:00Z', reaction }] });
const opts = { now: () => Date.parse('2026-09-09T11:00:00Z'), botId: '28:bot', resolveMember: async id => ({ id: `29:${id}`, name: id }) };
test('robot reaction runs as reactor and anchors the original message', async () => {
  const [event] = await normalizeGraphEvents(fixture(), row, opts);
  assert.equal(event.userId, '29:reactor'); assert.equal(event.trigger, 'reaction');
  assert.equal(event.replyToId, 'message1'); assert.equal(event.text, 'Handle this & that');
  assert.equal(event.mentionsBot, false); assert.equal(event.threadKey, '');
  assert.match(event.messageId, /^reaction:/);
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
  for (const change of [m => { m.reactions = []; }, m => { m.messageHistory[0].modifiedDateTime = row.startedAt; }, m => { m.messageHistory = [{ actions: 'reactionRemoved', reaction }]; }, m => { m.deletedDateTime = 'now'; }, m => { m.messageHistory[0].reaction = { ...reaction, reactionType: '👍' }; }]) {
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
