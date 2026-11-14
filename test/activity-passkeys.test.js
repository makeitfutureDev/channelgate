import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { setUser } = await import('../src/config/store.js');
const { saveSettings } = await import('../src/config/settings.js');
const { getDb } = await import('../src/db/index.js');
const { createActivityRouter, createActivityBrowserLoginHandler, createActivityGrantUrl, resetActivityStateForTests, ACTIVITY_SESSION_TTL_MS } = await import('../src/web/activity.js');
const { activityAccount, activityPasskeys, activityPasskey } = await import('../src/config/activity-passkeys.js');
const { createWebApp } = await import('../src/web/app.js');

test('Activity passkeys use real browser signatures, persistent identities and isolated sessions', { skip: !process.env.CG_BROWSER_MODULE, timeout: 60_000 }, async t => {
  resetActivityStateForTests();
  await setUser('U_ACTIVITY_KEY', { approved: true });
  await setUser('U_ACTIVITY_OTHER', { approved: true });
  let base, clock = Date.now(), team = 'T_ACTIVITY_KEY', live = true, lastOwner;
  const createRouter = () => createActivityRouter({ getClient: () => live ? {} : null, getTeamId: () => team,
    getBaseUrl: () => base, now: () => clock, snapshot: async (_client, ownerId) => { lastOwner = ownerId; return { rows: [], total: 0 }; }, refreshKey: () => 'fixture', readSubscriptions: async () => ({ subscriptions: [] }) });
  let router = createRouter();
  const app = express();
  app.use('/fonts', express.static(fileURLToPath(new URL('../public/fonts', import.meta.url))));
  app.get('/favicon.svg', (_req, res) => res.sendFile('favicon.svg', { root: fileURLToPath(new URL('../public/', import.meta.url)) }));
  app.get('/activity-sign-in', createActivityBrowserLoginHandler({ getBaseUrl: () => base }));
  app.use('/activity', (req, res, next) => router(req, res, next));
  app.use(createWebApp());
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: 'Fixture request denied' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://localhost:${server.address().port}`; saveSettings({ publicUrl: base, apiKey: 'fixture-activity-run-api-key' });
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
  async function signAssertion(path = '/activity/auth/login', credentialId) {
    const result = await api(path + '/options', {});
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body.options.allowCredentials ?? [], []);
    return page.evaluate(options => globalThis.ChannelGatePasskeys.get(options), { ...result.body.options,
      ...(credentialId ? { allowCredentials: [{ type: 'public-key', id: credentialId }] } : {}) });
  }
  async function csrfFor(path) {
    const response = await ctx.request.get(base + path + '/passkeys');
    return JSON.parse(/\)\((\{"mode":"manage"[\s\S]+?), globalThis\);<\/script>/.exec(await response.text())[1]).csrf;
  }
  let linkSession, passkeySession, primary;
  await t.test('a Slack link enrolls a discoverable verified passkey through mobile UI', async () => {
    linkSession = await openLink();
    assert.equal(await page.locator('header a').filter({ hasText: 'Passkeys' }).count(), 0);
    assert.equal(await page.locator('.privacy a').filter({ hasText: /passkeys/i }).count(), 0);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Manage passkeys', exact: true }).click();
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
  await t.test('installed macOS Chrome signs in in a regular tab and resumes through shared cookies', async () => {
    for (const entry of ['/activity/login', '/activity/open#' + 'A'.repeat(43)]) {
      const installed = await ctx.newPage();
      installed.setDefaultTimeout(7000);
      await installed.addInitScript(() => {
        Object.defineProperty(globalThis.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.0.0 Safari/537.36' });
        const match = globalThis.matchMedia.bind(globalThis);
        globalThis.matchMedia = query => query === '(display-mode: standalone)' ? { matches: true } : match(query);
      });
      await installed.goto(base + entry);
      if (entry.includes('/open')) await installed.locator('#status').filter({ hasText: /private link expired/ }).waitFor();
      const ceremonyRequests = [];
      installed.on('request', request => { if (request.url().endsWith('/auth/login/options')) ceremonyRequests.push(request.url()); });
      const tabOpened = ctx.waitForEvent('page');
      await installed.getByRole('button', { name: 'Continue in browser' }).click();
      const tab = await tabOpened; tab.setDefaultTimeout(7000);
      await tab.waitForURL(base + '/activity-sign-in');
      await tab.waitForLoadState('domcontentloaded');
      await installed.waitForResponse(response => response.url().endsWith('/activity/app/session'));
      assert.equal(new URL(installed.url()).pathname, entry.split('#')[0], 'an older live session must not complete this sign-in');
      assert.equal(await tab.evaluate(() => globalThis.opener === null), true);
      assert.equal(new URL(tab.url()).pathname.startsWith('/activity/'), false, 'ceremony page stays outside the app scope');
      const response = await ctx.request.get(base + '/activity-sign-in');
      assert.match(response.headers()['cache-control'], /no-store/);
      assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'/);
      const tabCdp = await ctx.newCDPSession(tab);
      await tabCdp.send('WebAuthn.enable');
      const { authenticatorId: tabAuthenticator } = await tabCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      const credentials = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
      for (const credential of credentials) await tabCdp.send('WebAuthn.addCredential', { authenticatorId: tabAuthenticator, credential: { ...credential, signCount: activityPasskey(primary.id).counter } });
      await tab.bringToFront();
      const verifiedResponse = tab.waitForResponse(response => response.url().endsWith('/auth/login/verify'));
      await tab.getByRole('button', { name: 'Sign in with a passkey' }).click();
      const verified = await verifiedResponse;
      assert.equal(verified.status(), 200, JSON.stringify(await verified.json()));
      await tab.getByText('You are signed in. Return to the Activity app to continue.').waitFor();
      await installed.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
      const destination = new URL(installed.url()).pathname;
      assert.equal((await api(destination + '/api/threads', undefined, { method: 'GET' })).status, 200);
      assert.equal(lastOwner, 'U_ACTIVITY_KEY');
      assert.deepEqual(ceremonyRequests, [], 'the installed window never invokes its restricted authenticator');
      assert.equal((await ctx.cookies()).some(cookie => cookie.name === 'cg_session'), false);
      const sessionCookie = (await ctx.cookies()).find(cookie => cookie.path === destination);
      assert.equal(sessionCookie.httpOnly, true);
      const signed = (await tabCdp.send('WebAuthn.getCredentials', { authenticatorId: tabAuthenticator })).credentials;
      for (const credential of signed) {
        await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: credential.credentialId });
        await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
      }
      await installed.close(); await tab.close();
      await page.bringToFront();
    }
  });
  await t.test('the same linked admin key signs into Activity while Activity-only keys remain barred from admin', async () => {
    await page.goto(base + '/activity/login');
    const accounts = await import('../src/config/admin-accounts.js');
    const { createAdminSession } = await import('../src/web/auth.js');
    let setupCookie;
    createAdminSession({ headers: {} }, { setHeader: (_name, value) => { setupCookie = value.split(';')[0]; } }, accounts.ensureBootstrapAdmin(), { bootstrap: true });
    const setupDenied = await ctx.request.get(base + '/activity/from-admin', { maxRedirects: 0, headers: { Cookie: setupCookie } });
    assert.equal(setupDenied.status(), 303); assert.equal(setupDenied.headers().location, '/activity/login');
    assert.equal(setupDenied.headers()['set-cookie'], undefined);
    const activityResponse = await signAssertion('/api/auth/login');
    assert.notEqual((await api('/api/auth/login/verify', { response: activityResponse })).status, 200);
    const { generateRegistrationOptions, verifyRegistrationResponse } = await import('@simplewebauthn/server');
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
    const before = accounts.adminPasskeyById(adminId);
    let adminAssertion = await signAssertion('/activity/auth/login', adminId);
    const activityLogin = await api('/activity/auth/login/verify', { response: adminAssertion });
    assert.equal(activityLogin.status, 200, JSON.stringify(activityLogin));
    assert.equal((await api(activityLogin.body.url + '/api/threads', undefined, { method: 'GET' })).status, 200);
    assert.equal(lastOwner, 'U_ACTIVITY_ADMIN');
    assert.ok(accounts.adminPasskeyById(adminId).counter > before.counter);
    assert.ok(accounts.adminPasskeyById(adminId).lastUsedAt);
    assert.equal((await ctx.cookies()).some(c => c.name === 'cg_session'), false, 'Activity login alone does not mint admin authority');
    await page.goto(base + activityLogin.body.url + '/passkeys');
    assert.match(await page.locator('main').innerText(), /administrator passkeys already work/);
    assert.equal(await page.locator('#add-passkey').count(), 0, 'do not ask existing admins to enroll a second key');
    await page.goto(base + '/activity/login');
    adminAssertion = await signAssertion('/api/auth/login', adminId);
    assert.equal((await api('/api/auth/login/verify', { response: adminAssertion })).status, 200);
    for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { Referer: 'https://sibling.example/attack' }, { Origin: 'https://evil.example' }]) {
      const denied = await ctx.request.get(base + '/activity/from-admin', { maxRedirects: 0, headers });
      assert.equal(denied.status(), 403); assert.equal(denied.headers()['set-cookie'], undefined);
    }
    await page.goto(base + '/overview');
    await page.getByRole('link', { name: 'My Activity ↗', exact: true }).waitFor();
    const requests = [];
    const track = req => { if (req.url().endsWith('/auth/login/options')) requests.push(req.url()); };
    page.on('request', track);
    await page.getByRole('link', { name: 'My Activity ↗', exact: true }).click();
    await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
    page.off('request', track); assert.deepEqual(requests, [], 'the admin shortcut does not start another passkey ceremony');
    const handoff = new URL(page.url()).pathname;
    assert.equal((await api(handoff + '/api/threads', undefined, { method: 'GET' })).status, 200);
    assert.equal(lastOwner, 'U_ACTIVITY_ADMIN');
    await page.goto(base + '/activity/from-admin?ownerId=U_ACTIVITY_OTHER');
    await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
    await api(new URL(page.url()).pathname + '/api/threads', undefined, { method: 'GET' });
    assert.equal(lastOwner, 'U_ACTIVITY_ADMIN', 'the shortcut never takes identity from query parameters');
    const anonymous = await browser.newContext(); t.after(() => anonymous.close());
    const denied = await anonymous.request.get(base + '/activity/from-admin', { maxRedirects: 0, headers: { Authorization: 'Bearer fixture-activity-run-api-key' } });
    assert.equal(denied.status(), 303); assert.equal(denied.headers().location, '/activity/login');
    assert.equal(denied.headers()['set-cookie'], undefined);
    accounts.revokeAdminSessions(account.id);
    assert.equal((await api(handoff + '/api/threads', undefined, { method: 'GET' })).status, 401);
    assert.equal((await api(activityLogin.body.url + '/api/threads', undefined, { method: 'GET' })).status, 401);
    await page.goto(base + '/activity/login');
    adminAssertion = await signAssertion('/activity/auth/login', adminId);
    accounts.revokeAdminSessions(account.id);
    assert.equal((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 401, 'revoking admin sessions invalidates an already-open Activity ceremony');
    for (const state of ['disabled', 'unlinked']) {
      adminAssertion = await signAssertion('/activity/auth/login', adminId);
      if (state === 'disabled') getDb().prepare('UPDATE admin_accounts SET enabled=0 WHERE id=?').run(account.id);
      else getDb().prepare('UPDATE admin_accounts SET user_id=NULL WHERE id=?').run(account.id);
      assert.equal((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 401, state);
      getDb().prepare('UPDATE admin_accounts SET enabled=1,user_id=? WHERE id=?').run('U_ACTIVITY_ADMIN', account.id);
    }
    adminAssertion = await signAssertion('/activity/auth/login', adminId); team = 'T_OTHER';
    assert.equal((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 403); team = 'T_ACTIVITY_KEY';
    adminAssertion = await signAssertion('/activity/auth/login', adminId);
    await setUser('U_ACTIVITY_ADMIN', { isAdmin: false, approved: true });
    assert.notEqual((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 200);
    await setUser('U_ACTIVITY_ADMIN', { isAdmin: true });
    adminAssertion = await signAssertion('/activity/auth/login', adminId);
    const beforeRemoval = await api('/activity/auth/login/verify', { response: adminAssertion });
    assert.equal(beforeRemoval.status, 200);
    adminAssertion = await signAssertion('/activity/auth/login', adminId);
    // Isolate the missing-key guard from the authVersion bump performed by normal admin removal.
    getDb().prepare('DELETE FROM admin_passkeys WHERE id=?').run(adminId);
    assert.equal((await api('/activity/auth/login/verify', { response: adminAssertion })).status, 401);
    assert.equal((await api(beforeRemoval.body.url + '/api/threads', undefined, { method: 'GET' })).status, 401);
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
    assert.equal(await page.locator('header a').filter({ hasText: 'Passkeys' }).count(), 0);
    assert.equal(await page.locator('.privacy a').filter({ hasText: /passkeys/i }).count(), 0);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Manage passkeys', exact: true }).click();
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
