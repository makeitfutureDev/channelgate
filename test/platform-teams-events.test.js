import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { normalizeActivity } from '../src/platforms/msteams/activity.js';
import { activityFingerprint } from '../src/platforms/msteams/verify.js';
import { createTeamsWebhook } from '../src/platforms/msteams/webhook.js';
const botId = '28:events-bot';
const appId = 'events-app';
const serviceUrl = 'https://smba.trafficmanager.net/emea/';
const base = { type: 'message', id: 'message-1', serviceUrl, timestamp: '2026-09-09T09:00:00Z', conversation: { id: '19:events@thread.v2', conversationType: 'groupchat' }, from: { id: '29:author', name: 'Fixture Author' }, text: '<at>Xavier</at> hello', entities: [{ type: 'mention', mentioned: { id: botId } }] };
const normalize = (changes = {}) => normalizeActivity({ ...base, ...changes }, { botId });

test('edit event subtype is explicit; real mention entity is required for the mention gate', () => {
  assert.equal(normalize({ type: 'messageUpdate', channelData: { eventType: 'editMessage' } }).trigger, 'edit');
  for (const eventType of ['softDeleteMessage', 'undeleteMessage', '', 'EditMessage']) assert.equal(normalize({ type: 'messageUpdate', channelData: { eventType } }), null);
  assert.equal(normalize({ type: 'messageDelete' }), null);
  assert.equal(normalize({ text: '@Xavier hello', entities: [] }).mentionsBot, false);
  assert.equal(normalize({ entities: [{ type: 'mention', mentioned: { id: 'another-bot' } }] }).mentionsBot, false);
  assert.equal(normalize({ from: { id: botId } }), null, 'bot echo cannot become a turn');
});

test('robot additions carry reactor identity and target; other reactions and removals do not run', () => {
  for (const reaction of ['🤖', 'robot', 'robot_face', '🤖\uFE0F']) {
    const value = normalize({ type: 'messageReaction', replyToId: 'bot-answer', text: '', entities: [], reactionsAdded: [{ type: reaction }] });
    assert.equal(value.trigger, 'reaction'); assert.equal(value.replyToId, 'bot-answer'); assert.equal(value.userId, '29:author'); assert.equal(value.mentionsBot, false);
  }
  assert.equal(normalize({ type: 'messageReaction', replyToId: 'bot-answer', reactionsRemoved: [{ type: 'robot' }] }), null);
  assert.equal(normalize({ type: 'messageReaction', replyToId: 'bot-answer', reactionsAdded: [{ type: 'like' }] }), null);
  assert.equal(normalize({ type: 'messageReaction', reactionsAdded: [{ type: 'robot' }] }), null, 'no target cannot run');
});

test('fingerprint retries collapse but different authors, revisions and event classes are distinct', () => {
  const original = activityFingerprint(base);
  assert.equal(original, activityFingerprint(structuredClone(base)));
  for (const change of [{ from: { id: '29:other' } }, { text: 'changed' }, { type: 'messageUpdate', channelData: { eventType: 'editMessage' } }, { reactionsAdded: [{ type: 'robot' }] }, { timestamp: '2026-09-09T09:00:01Z' }, { conversation: { id: 'another-chat' } }]) assert.notEqual(original, activityFingerprint({ ...base, ...change }));
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'events-key' };
function token() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'events-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://api.botframework.com', aud: appId, exp: Math.floor(Date.now() / 1000) + 600, serviceurl: serviceUrl })).toString('base64url');
  const sign = createSign('RSA-SHA256'); sign.update(`${header}.${body}`);
  return `${header}.${body}.${sign.sign(privateKey, 'base64url')}`;
}
function response() { return { code: 0, status(code) { this.code = code; return this; }, json() { this.acked = true; } }; }

test('signed webhook accepts distinct edits once, authenticates before dispatch and acknowledges before run', async () => {
  const received = [];
  let current;
  const handle = createTeamsWebhook({ appId, botId, jwks: { get: async () => jwk }, log: { warn() {}, error() {} }, onMessage: async (m) => { assert.equal(current.acked, true); received.push(m); } });
  const edit = { ...base, type: 'messageUpdate', channelData: { eventType: 'editMessage' } };
  for (const body of [base, edit, edit, { ...edit, text: '<at>Xavier</at> revised' }]) { current = response(); await handle({ body, headers: { authorization: `Bearer ${token()}` } }, current); assert.equal(current.code, 200); }
  assert.deepEqual(received.map((m) => m.trigger), ['message', 'edit', 'edit']);
  current = response(); await handle({ body: { ...base, id: 'unauth' }, headers: {} }, current); assert.equal(current.code, 401); assert.equal(received.length, 3);
});

test('Graph mode owns edit/reaction events; native new messages remain enabled', async () => {
  const received = []; const observed = [];
  const handle = createTeamsWebhook({ appId, botId, graphEventsEnabled: true, jwks: { get: async () => jwk }, onActivity: async (a) => observed.push(a.type), onMessage: async (m) => received.push(m), log: { error() {}, warn() {} } });
  for (const body of [base, { ...base, type: 'messageUpdate', channelData: { eventType: 'editMessage' } }, { ...base, type: 'messageReaction', replyToId: 'bot-answer', reactionsAdded: [{ type: 'robot' }] }]) await handle({ body, headers: { authorization: `Bearer ${token()}` } }, response());
  assert.equal(received.length, 1); assert.equal(received[0].trigger, 'message'); assert.equal(observed.length, 3);
});
