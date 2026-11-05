import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const settings = await import('../src/config/settings.js');
const accounts = await import('../src/config/admin-accounts.js');
const { setUser } = await import('../src/config/store.js');
const { hashPassword } = await import('../src/web/security.js');
const { createAdminSession } = await import('../src/web/auth.js');
const { createWebApp } = await import('../src/web/app.js');

// Keep time monotonic across this file: auth rate-limit buckets outlive individual tests.
const originalNow = Date.now;
let offset = 0;
Date.now = () => originalNow() + offset;
after(() => { Date.now = originalNow; });

test('Slack directory email lookup is password-gated, exact, canonical and resistant to async authority changes', async t => {
  const password = 'disposable-email-slack-password';
  settings.saveSettings({ publicUrl: '', adminPasswordSlackEnabled: true, adminPassword: await hashPassword(password) });
  await setUser('UEMAILADMIN', { isAdmin: true, approved: true, email: 'editable-attacker@example.test' });
  await setUser('UEMAILOTHER', { isAdmin: true, approved: true });
  await setUser('UEMAILMEMBER', { isAdmin: false, email: 'admin@example.test' });
  let lookupMode = 'ok';
  let releaseLookup, signalLookup;
  const lookedUp = [], delivered = [];
  const app = createWebApp({
    adminSlackIdentityLookup: async email => {
      lookedUp.push(email);
      if (lookupMode === 'pause') {
        lookupMode = 'ok';
        signalLookup();
        await new Promise(resolve => { releaseLookup = resolve; });
      }
      if (lookupMode === 'missing_scope') throw Object.assign(new Error('Slack API failure'), { data: { error: 'missing_scope' } });
      if (lookupMode === 'network') throw new Error('fixture provider network error');
      if (lookupMode === 'unknown') return null;
      const identity = { id: 'UEMAILADMIN', profile: { email } };
      if (lookupMode === 'member') identity.id = 'UEMAILMEMBER';
      if (lookupMode === 'bot') identity.is_bot = true;
      if (lookupMode === 'app') identity.is_app_user = true;
      if (lookupMode === 'deleted') identity.deleted = true;
      if (lookupMode === 'mismatch') identity.profile.email = 'different@example.test';
      return identity;
    },
    adminIdentityDelivery: async (userId, text) => { delivered.push({ userId, code: text.match(/\b\d{8}\b/)[0] }); },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  async function request(route, body, cookie = '') {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CG-Request': '1', Origin: base, Cookie: cookie }, body: JSON.stringify(body) });
    const result = { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') };
    if (response.status >= 400) offset += 301_000; // Respect actual authentication backoff without sleeping.
    return result;
  }
  const options = (body = { email: 'admin@example.test', password }, cookie = '') => request('/api/auth/password-slack/options', body, cookie);
  const verify = (proof, cookie = proof.cookie) => request('/api/auth/password-slack/verify', { requestId: proof.body.requestId, code: delivered.at(-1).code }, cookie);
  function session() {
    let cookie;
    const a = accounts.ensureUserAdminAccount('UEMAILADMIN');
    createAdminSession({ headers: {} }, { setHeader: (_name, value) => { cookie = value.split(';')[0]; } }, a);
    return cookie;
  }
  lookupMode = 'missing_scope';
  assert.equal((await options({ email: 'admin@example.test', password: 'wrong' })).status, 401);
  assert.equal(accounts.adminAccountForUser('UEMAILOTHER'), null, 'wrong passwords cannot provision dashboard accounts');
  assert.equal(lookedUp.length, 0, 'wrong passwords cannot query the Slack directory or expose missing scopes');
  const scopeFailure = await options();
  assert.equal(scopeFailure.status, 503);
  assert.match(scopeFailure.body.error, /users:read.email.*reinstall/i);
  for (const mode of ['unknown', 'member', 'bot', 'app', 'deleted', 'mismatch', 'network']) {
    lookupMode = mode;
    const failure = await options();
    assert.equal(failure.status, 401, mode);
    assert.match(failure.body.error, /Unable to sign in with those credentials/);
  }
  assert.equal(delivered.length, 0);
  lookupMode = 'ok';
  const beforeIdAttempt = lookedUp.length;
  assert.equal((await options({ userId: 'UEMAILADMIN', password })).status, 401);
  assert.equal(lookedUp.length, beforeIdAttempt, 'raw Slack IDs cannot select a signed-out identity');
  const proof = await options({ email: '  AdMiN@Example.Test  ', password });
  assert.equal(proof.status, 200);
  assert.equal(lookedUp.at(-1), 'admin@example.test');
  assert.equal(delivered.at(-1).userId, 'UEMAILADMIN', 'directory stable ID selects delivery despite contradictory editable local email');
  assert.equal((await verify(proof)).status, 200);
  const exact = await options({ email: 'First.Last+tag@example.test', password });
  assert.equal(exact.status, 200);
  assert.equal(lookedUp.at(-1), 'first.last+tag@example.test', 'dots and plus tags are not rewritten');
  assert.equal((await verify(exact)).status, 200);

  // Directory requests yield to other control-plane operations. Snapshot authority before lookup.
  for (const change of ['role', 'password', 'setting']) {
    const count = delivered.length;
    const started = new Promise(resolve => { signalLookup = resolve; });
    lookupMode = 'pause';
    const pending = options();
    await started;
    if (change === 'role') {
      await setUser('UEMAILADMIN', { isAdmin: false });
      await setUser('UEMAILADMIN', { isAdmin: true });
    } else if (change === 'password') settings.saveSettings({ adminPassword: await hashPassword(password) });
    else { settings.saveSettings({ adminPasswordSlackEnabled: false }); settings.saveSettings({ adminPasswordSlackEnabled: true }); }
    releaseLookup();
    assert.equal((await pending).status, 401, change);
    assert.equal(delivered.length, count, `${change} changes cannot send a code after stale lookup`);
  }
  const reauthCookie = session();
  const countBeforeReauthRace = delivered.length;
  const reauthLookupStarted = new Promise(resolve => { signalLookup = resolve; });
  lookupMode = 'pause';
  const reauthLookup = options({ email: 'admin@example.test', password }, reauthCookie);
  await reauthLookupStarted;
  accounts.revokeAdminSessions(accounts.adminAccountForUser('UEMAILADMIN').id);
  releaseLookup();
  assert.equal((await reauthLookup).status, 401, 'revoked session cannot finish reauth directory lookup');
  assert.equal(delivered.length, countBeforeReauthRace);
  // Reauthentication without an email uses the already authenticated stable identity, never lookup.
  const cookie = session();
  const lookupCount = lookedUp.length;
  const reauth = await options({ password }, cookie);
  assert.equal(reauth.status, 200);
  assert.equal(lookedUp.length, lookupCount);
  assert.equal(delivered.at(-1).userId, 'UEMAILADMIN');
  assert.equal((await verify(reauth, `${cookie}; ${reauth.cookie}`)).status, 200);
  const oldSession = session();
  const outstanding = await options({ password }, oldSession);
  assert.equal(outstanding.status, 200);
  assert.equal((await verify(outstanding)).status, 401, 'reauth OTP binding alone cannot replace its originating full session');
  const changedSession = session();
  const pendingCode = await options({ password }, changedSession);
  accounts.revokeAdminSessions(accounts.adminAccountForUser('UEMAILADMIN').id);
  assert.equal((await verify(pendingCode, `${changedSession}; ${pendingCode.cookie}`)).status, 401, 'session revocation invalidates reauth code');
});

test('configured Slack manager performs normalized email lookup and delivers only to its returned stable admin ID', async t => {
  offset += 2 * 24 * 60 * 60_000; // Expire the preceding test's genuine rate-limit buckets.
  const password = 'disposable-configured-slack-password';
  settings.saveSettings({ publicUrl: '', adminPasswordSlackEnabled: true, adminPassword: await hashPassword(password) });
  await setUser('UEMAILREAL9', { isAdmin: true, approved: true });
  const lookups = [], recipients = [];
  const app = createWebApp({
    slack: { getClient: () => ({ users: { lookupByEmail: async input => {
      lookups.push(input);
      return { ok: true, user: { id: 'UEMAILREAL9', profile: { email: 'operator@example.test' }, deleted: false, is_bot: false } };
    } } }) },
    adminIdentityDelivery: async userId => { recipients.push(userId); },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  async function options(email) {
    return fetch(`${base}/api/auth/password-slack/options`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CG-Request': '1', Origin: base }, body: JSON.stringify({ email, password }) });
  }
  assert.equal((await options('not-an-email')).status, 401);
  assert.deepEqual(lookups, [], 'malformed email cannot query Slack');
  const response = await options('  Operator@EXAMPLE.TEST  ');
  assert.equal(response.status, 200);
  assert.ok((await response.json()).requestId);
  assert.deepEqual(lookups, [{ email: 'operator@example.test' }]);
  assert.deepEqual(recipients, ['UEMAILREAL9']);
});
