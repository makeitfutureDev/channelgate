// A signed Bot Framework callback through the real file controls, current workspace
// authorization and roster HTTP client. No engine or live Microsoft credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { createTeamsWebhook } = await import('../src/platforms/msteams/webhook.js');
const { createTeamsApi, DEFAULT_SERVICE_URL } = await import('../src/platforms/msteams/api.js');
const { upsertChannelEntry, saveChannelMeta, setUser } = await import('../src/config/store.js');
const APP = '11111111-2222-3333-4444-555555555555';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'dialog-key', use: 'sig', alg: 'RS256' };
function bearer() {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://api.botframework.com', aud: APP,
    exp: Math.floor(Date.now() / 1000) + 60, serviceurl: DEFAULT_SERVICE_URL })).toString('base64url');
  const signer = createSign('RSA-SHA256'); signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${signer.sign(privateKey, 'base64url')}`;
}
let sequence = 0;
async function fixture(t, { timeoutMs = 3500 } = {}) {
  let time = Date.now();
  const serial = ++sequence, owner = `29:callback-${serial}`, nativeId = `19:callback-${serial}@thread.v2`;
  const channelId = `teams:${nativeId}`;
  const entry = await upsertChannelEntry(channelId, { name: `Callback ${serial}`, platform: 'msteams', type: 'mpim' });
  const meta = { channelId, platform: 'msteams', access: 'approved', allowBash: false };
  await saveChannelMeta(entry.slug, meta); await setUser(owner, { approved: true });
  const root = path.join(process.env.CG_WORKSPACE_DIR, 'teams', entry.slug);
  mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, 'hello.txt'), 'callback preview');
  const posted = [], warnings = [], rosterCalls = [];
  let roster = [{ id: owner }], held = null;
  const api = createTeamsApi({ auth: { token: async () => 'fixture-token' }, fetchImpl: async (_url, options) => {
    rosterCalls.push(options);
    if (held) await held;
    return { ok: true, json: async () => roster };
  } });
  const connector = { botId: '28:callback-bot', api, postCard: async payload => {
    posted.push(payload); return { messageId: 'launcher-1' };
  } };
  const makeControls = () => createTeamsControls({ connector, now: () => time, fileInvokeTimeoutMs: timeoutMs, log: { warn: message => warnings.push(message) } });
  let controls = makeControls();
  t.after(() => controls.stop());
  const launch = async (command = '/files') => {
    await controls.onCommand({ message: { text: command, userId: owner, conversationId: channelId,
      rawConversationId: nativeId, trigger: 'message', threadKey: '123456', raw: { tenantId: 'fixture-tenant' } },
      entry, meta, sessionKey: '123456', reply: async message => assert.fail(message) });
    return posted.at(-1).card.actions[0].data;
  };
  const webhook = createTeamsWebhook({ appId: APP, jwks: { get: async () => jwk },
    onMessage: () => assert.fail('A file callback cannot start an engine'), onInvoke: activity => controls.onInvoke(activity),
    log: { error: message => warnings.push(message), warn: message => warnings.push(message) } });
  const callback = async (data, name = 'task/fetch', id = `invoke-${++sequence}`, override = {}) => {
    const result = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await webhook({ headers: { authorization: `Bearer ${bearer()}` }, body: { type: 'invoke', name, id,
      from: { id: owner }, recipient: { id: connector.botId }, conversation: { id: nativeId },
      channelData: { tenant: { id: 'fixture-tenant' } }, serviceUrl: DEFAULT_SERVICE_URL, value: { data }, ...override } }, result);
    return result;
  };
  return { launch, callback, posted, rosterCalls, warnings, owner, nativeId,
    restart(botId = connector.botId) { controls.stop(); connector.botId = botId; controls = makeControls(); },
    advance(ms) { time += ms; },
    hold() { let release; held = new Promise(resolve => { release = resolve; }); return () => { held = null; release(); }; },
    removeMember() { roster = []; } };
}
const content = result => {
  assert.equal(result.code, 200); assert.equal(result.body.task.type, 'continue');
  assert.equal(result.body.task.value.card.contentType, 'application/vnd.microsoft.card.adaptive');
  return result.body.task.value.card.content;
};

test('fresh Open files and browsing each perform one fresh roster lookup and retain revocation checks', async t => {
  const f = await fixture(t); const launcher = await f.launch();
  f.rosterCalls.length = 0;
  const listing = content(await f.callback(launcher));
  assert.equal(f.rosterCalls.length, 1, 'the callback must not double its network authorization latency');
  assert.equal(listing.body[0].text, 'Conversation files');
  assert.match(JSON.stringify(listing), /hello\.txt/);
  const root = listing.actions.find(action => action.title === 'Root').data;
  f.rosterCalls.length = 0;
  content(await f.callback(root, 'task/submit'));
  assert.equal(f.rosterCalls.length, 1, 'browsing rechecks current membership without a second request');
  f.removeMember();
  const denied = await f.callback(root, 'task/submit');
  assert.equal(denied.body.task.type, 'message');
  assert.doesNotMatch(JSON.stringify(denied.body), /hello\.txt|file-download/);
  assert.doesNotMatch(JSON.stringify(f.posted), /hello\.txt|file-download/);
});

test('a stalled roster aborts before the client deadline, renders a safe error and allows a new click to retry', async t => {
  const f = await fixture(t, { timeoutMs: 30 }); const launcher = await f.launch();
  const release = f.hold();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = performance.now();
  const pending = f.callback(launcher, 'task/fetch', 'slow-invoke');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30);
  const result = await pending;
  assert.ok(performance.now() - started < 1000, 'the callback returns even when the upstream ignores cancellation');
  const error = content(result);
  assert.equal(error.body[0].text, 'Action unavailable');
  assert.match(error.body[1].text, /new Open files button/);
  assert.doesNotMatch(JSON.stringify(result.body), /hello\.txt|file-download|fixture-token/);
  assert.equal(f.rosterCalls.at(-1).signal.aborted, true, 'the real roster HTTP request was cancelled');
  assert.equal(f.warnings.length, 1);
  const calls = f.rosterCalls.length;
  const retry = await f.callback(launcher, 'task/fetch', 'slow-invoke');
  assert.deepEqual(retry.body, result.body, 'a transport retry receives its original single outcome');
  assert.equal(f.rosterCalls.length, calls);
  release(); await new Promise(resolve => setImmediate(resolve));
  const recovered = content(await f.callback(launcher));
  assert.equal(recovered.body[0].text, 'Conversation files');
  assert.equal(f.posted.length, 1, 'a callback never posts private contents to chat');
});

test('the same launcher survives transport recreation and still authorizes each new opening', async t => {
  const f = await fixture(t); const launcher = await f.launch();
  f.restart();
  f.rosterCalls.length = 0;
  const listing = content(await f.callback(launcher));
  assert.equal(listing.body[0].text, 'Conversation files');
  assert.match(JSON.stringify(listing), /hello\.txt/);
  assert.equal(f.rosterCalls.length, 1);
  assert.equal(f.posted.length, 1, 'no replacement card or private content is posted to chat');
  f.removeMember(); f.restart();
  const denied = content(await f.callback(launcher));
  assert.equal(denied.body[0].text, 'Action unavailable');
  assert.doesNotMatch(JSON.stringify(denied), /hello\.txt|file-download/);
});

test('restored selected-file launchers preserve their file while private dialog state stays ephemeral', async t => {
  const f = await fixture(t); const launcher = await f.launch('/sendfile hello.txt');
  const before = content(await f.callback(launcher));
  f.restart();
  const reopened = content(await f.callback(launcher));
  assert.equal(reopened.body[0].text, 'File');
  assert.match(JSON.stringify(reopened), /callback preview/);
  const oldBack = before.actions.find(action => action.title === 'Back to files').data;
  const stale = await f.callback(oldBack, 'task/submit');
  assert.equal(stale.body.task.type, 'message');
  assert.doesNotMatch(JSON.stringify(stale.body), /hello\.txt|file-download/);
});

test('restored launchers still bind owner, source conversation, tenant and bot registration', async t => {
  const f = await fixture(t); const launcher = await f.launch(); f.restart();
  for (const override of [{ from: { id: '29:other' } }, { conversation: { id: 'a:other' } },
    { channelData: { tenant: { id: 'other-tenant' } } }]) {
    const denied = content(await f.callback(launcher, 'task/fetch', undefined, override));
    assert.equal(denied.body[0].text, 'Action unavailable');
    assert.doesNotMatch(JSON.stringify(denied), /hello\.txt|file-download/);
  }
  f.restart('28:other-bot');
  const denied = content(await f.callback(launcher));
  assert.equal(denied.body[0].text, 'Action unavailable');
  assert.equal(f.warnings.at(-1), '[msteams] file launcher unavailable: wrong-bot');
});

test('restored launchers reject current gateway revocation and retain the original 15-minute expiry', async t => {
  const f = await fixture(t); const launcher = await f.launch(); f.restart();
  await setUser(f.owner, { approved: false });
  const revoked = content(await f.callback(launcher));
  assert.equal(revoked.body[0].text, 'Action unavailable');
  assert.doesNotMatch(JSON.stringify(revoked), /hello\.txt|file-download/);
  await setUser(f.owner, { approved: true });
  f.advance(16 * 60_000);
  const expired = content(await f.callback(launcher));
  assert.match(expired.body[1].text, /expired after 15 minutes/);
  assert.equal(f.warnings.at(-1), '[msteams] file launcher unavailable: expired');
});

test('missing and unknown references are distinguished without claiming that the gateway restarted', async t => {
  const f = await fixture(t);
  for (const [data, expected, reason] of [
    [{ cgAction: 'files.open' }, /did not include a valid reference/, 'missing-reference'],
    [{ cgAction: 'files.open', stateId: '22222222-2222-2222-2222-222222222222' }, /no longer available/, 'unknown'],
  ]) {
    const error = content(await f.callback(data));
    assert.match(error.body[1].text, expected);
    assert.doesNotMatch(JSON.stringify(error), /restarted|hello\.txt|file-download/);
    assert.equal(f.warnings.at(-1), `[msteams] file launcher unavailable: ${reason}`);
  }
});

test('gateway access revoked while the roster is in flight refuses before displaying files', async t => {
  const f = await fixture(t); const launcher = await f.launch();
  const release = f.hold();
  const pending = f.callback(launcher);
  await new Promise(resolve => setImmediate(resolve));
  await setUser(f.owner, { approved: false });
  release();
  const error = content(await pending);
  assert.equal(error.body[0].text, 'Action unavailable');
  assert.doesNotMatch(JSON.stringify(error), /hello\.txt|file-download/);
  assert.equal(f.posted.length, 1);
});
