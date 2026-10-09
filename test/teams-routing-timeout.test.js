import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsApi, DEFAULT_SERVICE_URL } = await import('../src/platforms/msteams/api.js');
const { createTeamsAuth } = await import('../src/platforms/msteams/auth.js');
const { createTeamsConnector } = await import('../src/platforms/msteams/connector.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { setUser } = await import('../src/config/store.js');
const { platformOr } = await import('../src/platforms/registry.js');
const regional = 'https://smba.trafficmanager.net/emea/';
const ok = (body = {}) => ({ ok: true, json: async () => body });
const bounded = promise => Promise.race([promise, delay(150).then(() => { throw new Error('test deadline exceeded'); })]);

test('Teams bounds a stalled token lookup before sending a message', async () => {
  let calls = 0;
  const api = createTeamsApi({ timeoutMs: 10, auth: { token: () => new Promise(() => {}) }, fetchImpl: async () => { calls++; return ok(); } });
  await assert.rejects(bounded(api.sendActivity('19:timeout', { text: 'hello' })), /Teams request timed out/);
  assert.equal(calls, 0);
});

test('Teams bounds a stalled fetch and does not retry an uncertain POST', async () => {
  let calls = 0, signal;
  const api = createTeamsApi({ timeoutMs: 10, auth: { token: async () => 'fixture-token' }, fetchImpl: async (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(bounded(api.sendActivity('19:timeout', { text: 'hello' })), /Teams request timed out/);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('Teams bounds a stalled response body', async () => {
  const api = createTeamsApi({ timeoutMs: 10, auth: { token: async () => 'fixture-token' }, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  await assert.rejects(bounded(api.sendActivity('19:timeout', { text: 'hello' })), /Teams request timed out/);
});

test('Teams caller cancellation aborts a pending POST without retry', async () => {
  const controller = new AbortController(); let signal;
  const api = createTeamsApi({ auth: { token: async () => 'fixture-token' }, fetchImpl: async (_url, init) => { signal = init.signal; controller.abort(new Error('fixture cancelled')); return new Promise(() => {}); } });
  await assert.rejects(bounded(api.sendActivity('19:timeout', { text: 'hello', signal: controller.signal })), /fixture cancelled/);
  assert.equal(signal.aborted, true);
});

test('Teams bounds token refresh itself and can retry a later lookup', async () => {
  let calls = 0;
  const auth = createTeamsAuth({ clientId: 'fixture-id', clientSecret: 'fixture-secret', timeoutMs: 10, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Promise(() => {}) : { ok: true, text: async () => JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }) };
  } });
  await assert.rejects(bounded(auth.token()), /Teams request timed out/);
  assert.equal(await bounded(auth.token()), 'fixture-token');
});

test('Teams persists validated source routing across connector recreation and isolates bots', async () => {
  const calls = [];
  const auth = { token: async () => 'fixture-token' };
  const apiForServiceUrl = serviceUrl => createTeamsApi({ auth, serviceUrl, fetchImpl: async url => { calls.push(String(url)); return ok({ id: '123' }); } });
  const options = { auth, botId: '28:routing-fixture', capabilities: platformOr('msteams').capabilities, api: apiForServiceUrl(DEFAULT_SERVICE_URL), apiForServiceUrl };
  const first = createTeamsConnector(options);
  first.rememberServiceUrl('19:regional@thread.tacv2', regional);
  await first.post({ conversationId: '19:regional@thread.tacv2', threadKey: '12345', text: 'hello' });
  const restarted = createTeamsConnector(options);
  await restarted.edit({ conversationId: 'teams:19:regional@thread.tacv2', messageId: '123', text: 'after restart' });
  await restarted.api.listMembers('19:regional@thread.tacv2');
  const otherBot = createTeamsConnector({ ...options, botId: '28:other-bot' });
  await otherBot.post({ conversationId: '19:regional@thread.tacv2', text: 'other bot' });
  assert.ok(calls.slice(0, 3).every(url => url.startsWith(regional)));
  assert.ok(calls[3].startsWith(DEFAULT_SERVICE_URL));
  assert.match(decodeURIComponent(calls[0]), /;messageid=12345/);
  assert.throws(() => restarted.rememberServiceUrl('19:regional@thread.tacv2', 'https://evil.example/'), /service URL/);
  await restarted.remove({ conversationId: '19:regional@thread.tacv2', messageId: '123' });
  assert.ok(calls.at(-1).startsWith(regional));
});

test('Teams ingest registers authenticated routing before an authorized reply', async () => {
  await setUser('teams:routing-owner', { approved: true });
  const calls = [];
  const connector = { platform: 'msteams', rememberServiceUrl: (id, url) => calls.push(['route', id, url]),
    post: async body => { calls.push(['post', body]); return { messageId: '123' }; }, edit: async () => {} };
  const ingest = createIngest({ connector, run: async () => ({ content: 'OK', engine: 'codex' }) });
  await ingest(makeInbound({ platform: 'msteams', conversationId: '19:ingest-routing', kind: 'dm', userId: 'teams:routing-owner', text: 'hello' }), { serviceUrl: regional });
  assert.deepEqual(calls[0], ['route', '19:ingest-routing', regional]);
});

test('Teams private card creation and later DM delivery retain the source service region', async () => {
  const calls = [];
  const auth = { token: async () => 'fixture-token' };
  const apiForServiceUrl = serviceUrl => createTeamsApi({ auth, serviceUrl, fetchImpl: async url => {
    calls.push(String(url)); return ok({ id: String(url).endsWith('v3/conversations') ? 'a:regional-private' : '123' });
  } });
  const options = { auth, botId: '28:private-routing', capabilities: platformOr('msteams').capabilities, api: apiForServiceUrl(DEFAULT_SERVICE_URL), apiForServiceUrl };
  const connector = createTeamsConnector(options);
  connector.rememberServiceUrl('19:regional-private-source', regional);
  await connector.postCard({ conversationId: '19:regional-private-source', ephemeralTo: '29:fixture-owner', card: { type: 'AdaptiveCard', version: '1.4', body: [] } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith(regional)));
  const restarted = createTeamsConnector(options);
  await restarted.post({ conversationId: 'a:regional-private', text: 'private follow-up' });
  assert.ok(calls.at(-1).startsWith(regional));
});
