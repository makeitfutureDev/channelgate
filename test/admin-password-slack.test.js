import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const settings = await import('../src/config/settings.js');
const accounts = await import('../src/config/admin-accounts.js');
const { setUser } = await import('../src/config/store.js');
const { hashPassword } = await import('../src/web/security.js');
const { createWebApp } = await import('../src/web/app.js');
const { getDb } = await import('../src/db/index.js');
const { createAdminSession } = await import('../src/web/auth.js');

// HTTP integration: delivery is captured locally; no Slack message leaves the test.
test('optional password + private Slack code remains a two-factor, browser-bound login after passkey enrollment', async t => {
  const originalNow = Date.now;
  let clockOffset = 0;
  Date.now = () => originalNow() + clockOffset;
  t.after(() => { Date.now = originalNow; });
  const password = 'disposable-password-slack-http';
  settings.saveSettings({ publicUrl: '', apiKey: '', adminPassword: await hashPassword(password), adminPasswordSlackEnabled: false });
  await setUser('UPASSWORDADMIN', { name: 'Fixture administrator', isAdmin: true });
  await setUser('UPASSWORDMEMBER', { name: 'Fixture member', isAdmin: false });
  await setUser('msteams:fixture-admin', { name: 'Fixture Teams administrator', isAdmin: true });
  const account = accounts.ensureUserAdminAccount('UPASSWORDADMIN');
  let administratorCookie;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { administratorCookie = value.split(';')[0]; } }, account);
  let deliveryMode = 'ok';
  let releaseDelivery;
  let signalDelivery;
  const deliveries = [];
  const app = createWebApp({ adminIdentityDelivery: async (userId, text) => {
    const code = text.match(/\b\d{8}\b/)?.[0];
    assert.match(code, /^\d{8}$/);
    deliveries.push({ userId, code, text });
    if (deliveryMode === 'pause') {
      deliveryMode = 'ok';
      signalDelivery();
      await new Promise(resolve => { releaseDelivery = resolve; });
    }
    if (deliveryMode === 'fail') throw new Error('fixture delivery failure');
    if (deliveryMode === 'demote') {
      await setUser(userId, { isAdmin: false });
      await setUser(userId, { isAdmin: true });
    }
    return true;
  } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  async function request(route, body, cookie = '', method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}${route}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-CG-Request': '1', Origin: base, Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Move past intentional failure backoff without slowing the regression or disabling limits.
    if (response.status >= 400) clockOffset += 61_000;
    const cookies = response.headers.getSetCookie?.() || [];
    return { status: response.status, body: await response.json(), cookies,
      cookie: cookies.map(value => value.split(';')[0]).join('; ') };
  }
  const options = (userId = 'UPASSWORDADMIN', suppliedPassword = password, cookie = '') =>
    request('/api/auth/password-slack/options', { userId, password: suppliedPassword }, cookie);
  const verify = (proof, code = deliveries.at(-1).code, cookie = proof.cookie) =>
    request('/api/auth/password-slack/verify', { requestId: proof.body.requestId, code }, cookie);
  const configure = enabled => request('/api/auth/password-slack/settings', { enabled }, administratorCookie, 'PUT');
  assert.equal((await request('/api/auth/status')).body.passwordSlackEnabled, false);
  assert.notEqual((await options()).status, 200);
  assert.equal(deliveries.length, 0);
  assert.equal((await configure(true)).status, 200);
  assert.equal((await request('/api/auth/status')).body.passwordSlackEnabled, true);
  // A stored fixture key sets the irreversible enrollment latch without pretending to verify WebAuthn.
  accounts.saveAdminPasskey({ accountId: account.id, authVersion: account.authVersion,
    credential: { id: 'cGFzc3dvcmQtc2xhY2stZml4dHVyZQ', publicKey: new Uint8Array([1]), counter: 0, transports: ['internal'] }, name: 'Fixture', deviceType: 'singleDevice', backedUp: false });
  assert.equal((await request('/api/login', { password })).status, 401, 'the old password-only bootstrap stays closed');
  for (const userId of ['UPASSWORDMEMBER', 'msteams:fixture-admin', 'api', 'missing']) {
    assert.notEqual((await options(userId)).status, 200);
  }
  assert.notEqual((await options('UPASSWORDADMIN', 'wrong-password')).status, 200);
  assert.equal(deliveries.length, 0);
  const proof = await options();
  assert.equal(proof.status, 200);
  const code = deliveries.at(-1).code;
  assert.equal(deliveries.at(-1).userId, 'UPASSWORDADMIN');
  assert.equal(JSON.stringify(proof.body).includes(code), false, 'the code is delivered only privately');
  assert.equal((await request('/api/settings', undefined, proof.cookie)).status, 401, 'password and pending request cannot authorize dashboard access');
  assert.notEqual((await verify(proof, code, '')).status, 200, 'another browser cannot consume the code');
  const login = await verify(proof, code);
  assert.equal(login.status, 200);
  const me = await request('/api/auth/me', undefined, login.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.account.userId, 'UPASSWORDADMIN');
  assert.equal(me.body.bootstrap, false);
  assert.equal((await request('/api/settings', undefined, login.cookie)).status, 200);
  assert.notEqual((await verify(proof, code)).status, 200, 'code cannot be replayed');
  const expired = await options();
  clockOffset += 5 * 60_000 + 1;
  assert.notEqual((await verify(expired)).status, 200, 'expired private codes fail closed');
  const guesses = await options();
  const correctCode = deliveries.at(-1).code;
  const wrongCode = correctCode === '10000000' ? '10000001' : '10000000';
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await verify(guesses, wrongCode)).status, 401);
  }
  assert.notEqual((await verify(guesses, correctCode)).status, 200, 'five guesses retire the challenge');
  clockOffset += 301_000;
  deliveryMode = 'fail';
  assert.equal((await options()).status, 503);
  clockOffset += 301_000;
  deliveryMode = 'demote';
  assert.equal((await options()).status, 503, 'role changes during private delivery retire authority');
  clockOffset += 301_000;
  deliveryMode = 'ok';
  const revokedRole = await options();
  const roleCode = deliveries.at(-1).code;
  await setUser('UPASSWORDADMIN', { isAdmin: false });
  await setUser('UPASSWORDADMIN', { isAdmin: true });
  assert.notEqual((await verify(revokedRole, roleCode)).status, 200);
  assert.equal((await request('/api/settings', undefined, login.cookie)).status, 401, 'role changes revoke established fallback sessions');
  clockOffset += 301_000;
  const rotatedPassword = await options();
  const oldCode = deliveries.at(-1).code;
  settings.saveSettings({ adminPassword: await hashPassword(password) });
  assert.notEqual((await verify(rotatedPassword, oldCode)).status, 200, 'password rotation revokes outstanding codes');
  clockOffset += 301_000;
  const active = await options();
  assert.equal((await verify(active)).status, 200, 'a fresh successful login resets failure backoff');
  const deliveryStarted = new Promise(resolve => { signalDelivery = resolve; });
  deliveryMode = 'pause';
  const superseded = options('UPASSWORDADMIN', password, active.cookie);
  await deliveryStarted;
  const replacement = await options('UPASSWORDADMIN', password, active.cookie);
  releaseDelivery();
  assert.equal((await superseded).status, 503, 'a slower resend cannot revive its superseded challenge');
  assert.equal(replacement.status, 200);
  const activeLogin = await verify(replacement);
  assert.equal(activeLogin.status, 200);
  const rotated = await request('/api/auth/users/UPASSWORDADMIN/revoke-sessions', {}, activeLogin.cookie);
  assert.equal(rotated.status, 200);
  assert.equal((await request('/api/settings', undefined, activeLogin.cookie)).status, 401);
  assert.equal((await request('/api/settings', undefined, rotated.cookie)).status, 200);
  getDb().prepare('DELETE FROM admin_passkeys').run();
  settings.saveSettings({ slackBotToken: 'fixture-private-slack-token' });
  const reveal = await request('/api/secrets/reveal', { scope: 'settings', field: 'slackBotToken' }, rotated.cookie);
  assert.equal(reveal.status, 200, 'fresh alternate auth authorizes reveal even with zero stored passkeys');
  assert.equal(reveal.body.value, 'fixture-private-slack-token');
  // Freshly authenticated fallback administrators may turn the option off, revoking their session.
  assert.equal((await request('/api/auth/password-slack/settings', { enabled: false }, rotated.cookie, 'PUT')).status, 200);
  assert.equal((await request('/api/settings', undefined, rotated.cookie)).status, 401);
  assert.notEqual((await options()).status, 200);
  settings.saveSettings({ adminPasswordSlackEnabled: true });
  assert.equal((await request('/api/settings', undefined, rotated.cookie)).status, 401, 're-enabling cannot resurrect a retired session');
});
