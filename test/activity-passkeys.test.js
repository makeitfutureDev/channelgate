import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { setUser } = await import('../src/config/store.js');
const { saveSettings } = await import('../src/config/settings.js');
const { getDb } = await import('../src/db/index.js');
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, ACTIVITY_SESSION_TTL_MS } = await import('../src/web/activity.js');
const { activityAccount, activityPasskeys, activityPasskey } = await import('../src/config/activity-passkeys.js');
const { createAdminAuthRouter } = await import('../src/web/admin-auth.js');

test('Activity passkeys use real browser signatures, persistent identities and isolated sessions', { skip: !process.env.CG_BROWSER_MODULE, timeout: 60_000 }, async t => {
  resetActivityStateForTests();
  await setUser('U_ACTIVITY_KEY', { approved: true });
  await setUser('U_ACTIVITY_OTHER', { approved: true });
  let base, clock = Date.now(), team = 'T_ACTIVITY_KEY', live = true;
  const createRouter = () => createActivityRouter({ getClient: () => live ? {} : null, getTeamId: () => team,
    getBaseUrl: () => base, now: () => clock, snapshot: async () => ({ rows: [], total: 0 }), refreshKey: () => 'fixture', readSubscriptions: async () => ({ subscriptions: [] }) });
  let router = createRouter();
  const app = express();
  app.use('/fonts', express.static(fileURLToPath(new URL('../public/fonts', import.meta.url))));
  app.get('/favicon.svg', (_req, res) => res.sendFile('favicon.svg', { root: fileURLToPath(new URL('../public/', import.meta.url)) }));
  app.use('/activity', (req, res, next) => router(req, res, next));
  app.use(express.json()); app.use('/api/auth', createAdminAuthRouter());
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: 'Fixture request denied' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://localhost:${server.address().port}`; saveSettings({ publicUrl: base });
  t.after(() => new Promise(resolve => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await ctx.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
  const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const grant = ownerId => createActivityGrantUrl({ baseUrl: base, ownerId, teamId: team, now: clock });
  async function api(path, body, { method = 'POST', headers = {}, context = ctx } = {}) {
    const response = await context.request.fetch(base + path, { method, headers: { Origin: base, 'X-CG-Request': '1', ...headers },
      ...(body === undefined ? {} : { data: body }) });
    const text = await response.text();
    return { status: response.status(), headers: response.headers(), body: text.startsWith('{') ? JSON.parse(text) : text };
  }
  async function openLink(ownerId = 'U_ACTIVITY_KEY') {
    await page.goto(grant(ownerId)); await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/); return new URL(page.url()).pathname;
  }
  async function signAssertion(path = '/activity/auth/login') {
    const result = await api(path + '/options', {});
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body.options.allowCredentials ?? [], []);
    return page.evaluate(options => globalThis.ChannelGatePasskeys.get(options), result.body.options);
  }
  async function csrfFor(path) {
    const response = await ctx.request.get(base + path + '/passkeys');
    return JSON.parse(/\)\((\{"mode":"manage"[\s\S]+?), globalThis\);<\/script>/.exec(await response.text())[1]).csrf;
  }
  let linkSession, passkeySession, primary;
  await t.test('a Slack link enrolls a discoverable verified passkey through mobile UI', async () => {
    linkSession = await openLink();
    await page.getByRole('link', { name: 'Passkeys', exact: true }).click();
    await page.locator('#add-passkey').waitFor({ state: 'visible' });
    await page.locator('#passkey-name').fill('Phone <fixture>');
    await page.locator('#add-passkey').click();
    await page.locator('#status').filter({ hasText: 'Passkey saved.' }).waitFor();
    assert.equal(await page.locator('#passkey-list li span').innerText(), 'Phone <fixture>');
    const credentials = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    assert.equal(credentials.length, 1); assert.equal(credentials[0].isResidentCredential, true);
    const account = activityAccount({ ownerId: 'U_ACTIVITY_KEY', teamId: team, origin: base });
    primary = activityPasskeys(account.id)[0]; assert.ok(activityPasskey(primary.id).publicKey.length);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    }
  });
  await t.test('return login has no username and mints only an Activity path cookie', async () => {
    await page.goto(base + '/activity/login');
    assert.equal(await page.locator('input').count(), 0);
    const response = page.waitForResponse(r => r.url().endsWith('/auth/login/verify'));
    await page.locator('#sign-in').click(); await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
    passkeySession = new URL(page.url()).pathname;
    assert.notEqual(passkeySession, linkSession);
    const cookie = (await ctx.cookies()).find(c => c.path === passkeySession);
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Lax');
    assert.match((await (await response).allHeaders())['set-cookie'], /Max-Age=43200/);
    assert.equal((await ctx.cookies()).some(c => c.name === 'cg_session'), false);
    const account = activityAccount({ ownerId: 'U_ACTIVITY_KEY', teamId: team, origin: base });
    assert.ok(activityPasskeys(account.id)[0].lastUsedAt);
    assert.equal((await api('/api/auth/me', undefined, { method: 'GET' })).status, 401);
  });
  await t.test('Activity credentials cannot sign in to admin and admin credentials cannot sign in to Activity', async () => {
    await page.goto(base + '/activity/login');
    const activityResponse = await signAssertion('/api/auth/login');
    assert.notEqual((await api('/api/auth/login/verify', { response: activityResponse })).status, 200);
    const { generateRegistrationOptions, verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const accounts = await import('../src/config/admin-accounts.js');
    await setUser('U_ACTIVITY_ADMIN', { isAdmin: true });
    const account = accounts.ensureUserAdminAccount('U_ACTIVITY_ADMIN');
    const options = await generateRegistrationOptions({ rpName: 'Admin fixture', rpID: 'localhost', userName: 'Admin fixture',
      userID: Buffer.from(account.userHandle, 'base64url'), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    const response = await page.evaluate(options => globalThis.ChannelGatePasskeys.create(options), options);
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: options.challenge, expectedOrigin: base, expectedRPID: 'localhost', requireUserVerification: true });
    assert.equal(verified.verified, true);
    accounts.saveAdminPasskey({ accountId: account.id, authVersion: account.authVersion, credential: verified.registrationInfo.credential,
      deviceType: verified.registrationInfo.credentialDeviceType, backedUp: verified.registrationInfo.credentialBackedUp });
    const adminId = response.id;
    const result = await api('/activity/auth/login/options', {});
    const adminAssertion = await page.evaluate(options => globalThis.ChannelGatePasskeys.get(options),
      { ...result.body.options, allowCredentials: [{ type: 'public-key', id: adminId }] });
    assert.notEqual((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 200);
    await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: Buffer.from(adminId, 'base64url').toString('base64') });
  });
  await t.test('origins, CSRF and ownership protect enrollment and deletion', async () => {
    const csrf = await csrfFor(linkSession), path = linkSession + '/api/passkeys/register/options';
    assert.equal((await api(path, {}, { headers: { 'X-CG-CSRF': 'wrong' } })).status, 403);
    assert.equal((await api(path, {}, { headers: { 'X-CG-CSRF': csrf, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await api('/activity/auth/login/options', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const foreign = await openLink('U_ACTIVITY_OTHER'), foreignCsrf = await csrfFor(foreign);
    assert.equal((await api(foreign + '/api/passkeys/' + primary.id, undefined, { method: 'DELETE', headers: { 'X-CG-CSRF': foreignCsrf } })).status, 404);
    assert.ok(activityPasskey(primary.id));
    const other = await browser.newContext(); t.after(() => other.close());
    assert.equal((await api(path, {}, { context: other, headers: { 'X-CG-CSRF': csrf } })).status, 401);
  });
  await t.test('registration is bound to its original browser session and consumes failed responses', async () => {
    const firstCsrf = await csrfFor(linkSession);
    const options = await api(linkSession + '/api/passkeys/register/options', {}, { headers: { 'X-CG-CSRF': firstCsrf } });
    assert.equal(options.status, 200);
    const nextSession = await openLink(), nextCsrf = await csrfFor(nextSession);
    const result = await api(nextSession + '/api/passkeys/register/verify', { response: {} }, { headers: { 'X-CG-CSRF': nextCsrf } });
    assert.equal(result.status, 401);
    assert.equal((await api(linkSession + '/api/passkeys/register/verify', { response: {} }, { headers: { 'X-CG-CSRF': firstCsrf } })).status, 401);
  });
  await t.test('login rejects replay, browser swapping, userHandle changes, revoked users and teams', async () => {
    await page.goto(base + '/activity/login');
    let response = await signAssertion();
    const other = await browser.newContext(); t.after(() => other.close());
    assert.equal((await api('/activity/auth/login/verify', { response }, { context: other })).status, 401);
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 200);
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 401);
    response = await signAssertion(); response.response.userHandle = 'wrong';
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 401);
    response = await signAssertion(); await setUser('U_ACTIVITY_KEY', { approved: false });
    assert.notEqual((await api('/activity/auth/login/verify', { response })).status, 200);
    assert.equal((await api(passkeySession + '/api/threads', undefined, { method: 'GET' })).status, 403);
    await setUser('U_ACTIVITY_KEY', { approved: true });
    response = await signAssertion(); team = 'T_OTHER';
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 403); team = 'T_ACTIVITY_KEY';
    response = await signAssertion(); live = false;
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 403); live = true;
    response = await signAssertion(); clock += 5 * 60_000;
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 401);
  });
  await t.test('credentials survive transient daemon reset and pending ceremonies do not', async () => {
    const response = await signAssertion(); resetActivityStateForTests(); router = createRouter();
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 401);
    await page.locator('#sign-in').click(); await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
    passkeySession = new URL(page.url()).pathname;
    assert.equal((await api(passkeySession + '/api/threads', undefined, { method: 'GET' })).status, 200);
    await page.getByRole('link', { name: 'Passkeys', exact: true }).click();
    await page.locator('#passkey-list li').waitFor();
    assert.equal(await page.locator('#passkey-list li span').innerText(), 'Phone <fixture>');
  });
  await t.test('successful sign-ins do not accumulate exponential failure penalties', async () => {
    await page.goto(base + '/activity/login');
    for (let i = 0; i < 41; i++) {
      const response = await signAssertion();
      const login = await api('/activity/auth/login/verify', { response });
      assert.equal(login.status, 200, `successful login ${i}: ${JSON.stringify(login)}`);
      passkeySession = login.body.url;
    }
  });
  await t.test('fixed twelve-hour expiry presents sign-in and expired Slack links offer passkeys', async () => {
    const link = grant('U_ACTIVITY_KEY'); clock += ACTIVITY_SESSION_TTL_MS;
    assert.equal((await api(passkeySession + '/api/threads', undefined, { method: 'GET' })).status, 401);
    await page.goto(base + passkeySession); await page.locator('#sign-in').waitFor();
    assert.match(await page.title(), /Sign in/);
    await page.goto(link); await page.locator('#status').filter({ hasText: 'link expired' }).waitFor();
    await page.locator('#sign-in').click(); await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
    passkeySession = new URL(page.url()).pathname;
  });
  await t.test('owner removal invalidates in-flight login and sessions made with the removed key', async () => {
    linkSession = await openLink();
    const csrf = await csrfFor(linkSession);
    await page.goto(base + '/activity/login'); const response = await signAssertion();
    assert.equal((await api(linkSession + '/api/passkeys/' + primary.id, undefined, { method: 'DELETE', headers: { 'X-CG-CSRF': csrf } })).status, 200);
    assert.equal(activityPasskey(primary.id), null);
    assert.equal((await api('/activity/auth/login/verify', { response })).status, 401);
    assert.equal((await api(passkeySession + '/api/threads', undefined, { method: 'GET' })).status, 401);
    assert.equal((await api(linkSession + '/api/threads', undefined, { method: 'GET' })).status, 200);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM activity_passkeys').get().n, 0);
  });
  assert.deepEqual(errors, []);
});
