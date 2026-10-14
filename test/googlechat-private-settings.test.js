import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createConversationSettingsGrantUrl, createConversationSettingsRouter, resetConversationSettingsStateForTests, CONVERSATION_SETTINGS_GRANT_TTL_MS } = await import('../src/web/conversation-settings.js');
const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, setUser, getUser } = await import('../src/config/store.js');
const { listOrgEnv, patchOrgEnv } = await import('../src/config/scoped-env.js');

let counter = 0;
async function fixture(t, { admin = false } = {}) {
  resetConversationSettingsStateForTests();
  t.after(resetConversationSettingsStateForTests);
  const channelId = `gchat:spaces/private-settings-${++counter}`, ownerId = `gchat:users/private-${counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `private-${counter}`, platform: 'googlechat', isDM: false, type: 'channel' });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId, name: entry.name, platform: 'googlechat', isDM: false, type: 'channel' }));
  await setUser(ownerId, { approved: true, isAdmin: admin });
  let revoked = false, mismatch = false, checks = 0;
  const app = express();
  app.use('/conversation-settings', createConversationSettingsRouter({ authorize: async grant => {
    checks++;
    assert.equal(grant.ownerId, ownerId);
    assert.equal(grant.channelId, channelId);
    if (revoked) throw new Error('Membership revoked');
    return { entry, meta: await getChannelMeta(entry.slug), userId: mismatch ? 'wrong-owner' : ownerId, members: [{ id: ownerId }] };
  } }));
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grant = options => createConversationSettingsGrantUrl({ baseUrl: base, channelId, slug: entry.slug, ownerId, ...options });
  const open = async () => {
    const url = grant();
    const exchange = await fetch(url, { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    const route = exchange.headers.get('location'), cookie = exchange.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + route, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text(), csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    return { url, exchange, route, cookie, response, html, csrf };
  };
  const post = async (opened, data, headers = {}) => fetch(base + opened.route, { method: 'POST', redirect: 'manual', headers: { cookie: opened.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf: opened.csrf, ...data }) });
  return { base, entry, ownerId, channelId, open, grant, post, revoke: () => { revoked = true; }, mismatch: () => { mismatch = true; }, checks: () => checks };
}

test('private settings grant is one-use; browser password forms never contain stored secrets', async t => {
  const f = await fixture(t);
  const opened = await f.open();
  assert.match(opened.exchange.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(opened.response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(opened.response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(opened.html, /name="variableValue" type="password"/);
  assert.match(opened.html, /name="personalComposioToken" type="password"/);
  assert.equal((await fetch(opened.url, { redirect: 'manual' })).status, 410);
  assert.equal((await fetch(f.base + opened.route)).status, 401);
  assert.equal((await fetch(f.base + opened.route, { headers: { cookie: opened.cookie.replace(/=.*/, '=wrong') } })).status, 401);
  const secret = 'browser-only-test-fixture-secret';
  const saved = await f.post(opened, { action: 'settings.variable.save', variableScope: 'channel', variableName: 'BROWSER_PRIVATE_TOKEN', variableValue: secret });
  assert.equal(saved.status, 303);
  assert.equal((await getChannelMeta(f.entry.slug)).env.BROWSER_PRIVATE_TOKEN.value, secret);
  const html = await (await fetch(f.base + opened.route, { headers: { cookie: opened.cookie } })).text();
  assert.ok(html.includes('BROWSER_PRIVATE_TOKEN'));
  assert.ok(!html.includes(secret));
  assert.ok(f.checks() >= 6);
});

test('CSRF, hostile origin, forged authority and personal scopes are checked server-side', async t => {
  const f = await fixture(t);
  const opened = await f.open();
  const data = { action: 'settings.variable.save', variableScope: 'personal', variableName: 'BROWSER_PERSONAL_TOKEN', variableValue: 'personal-test-fixture-secret', ownerId: 'forged', channelId: 'forged' };
  assert.equal((await f.post(opened, { ...data, csrf: 'wrong' })).status, 403);
  assert.equal((await f.post(opened, data, { origin: 'https://hostile.example' })).status, 403);
  assert.equal((await f.post(opened, data, { origin: 'null' })).status, 403);
  assert.equal((await f.post(opened, data)).status, 303);
  assert.equal((await getUser(f.ownerId)).env.BROWSER_PERSONAL_TOKEN.value, data.variableValue);
  assert.equal(await getUser('forged'), null);
  assert.equal((await f.post(opened, { ...data, variableScope: 'organization', userIsAdmin: 'true' })).status, 403);
  assert.ok(!listOrgEnv().some(row => row.name === data.variableName));
  assert.equal((await f.post(opened, { action: 'settings.personal.save', personalComposioToken: 'connection-test-fixture-secret', ownerId: 'forged' })).status, 303);
  assert.equal((await getUser(f.ownerId)).composioToken, 'connection-test-fixture-secret');
  assert.equal((await f.post(opened, { action: 'settings.connections.save', makeToolboxUrl: 'https://eu1.make.com/mcp/server/browser-fixture', makeToolboxKey: 'make-connection-fixture-secret' })).status, 303);
  assert.equal((await f.post(opened, { action: 'settings.connections.save', toolboxToken: 'rotated-toolbox-fixture-secret', makeToolboxUrl: '' })).status, 303);
  const meta = await getChannelMeta(f.entry.slug);
  assert.equal(meta.makeToolboxUrl, 'https://eu1.make.com/mcp/server/browser-fixture');
  assert.equal(meta.makeToolboxKey, 'make-connection-fixture-secret');
  assert.equal(meta.toolboxToken, 'rotated-toolbox-fixture-secret');
  const html = await (await fetch(f.base + opened.route, { headers: { cookie: opened.cookie } })).text();
  for (const value of ['personal-test-fixture-secret', 'connection-test-fixture-secret', 'make-connection-fixture-secret', 'rotated-toolbox-fixture-secret']) assert.ok(!html.includes(value));
  assert.equal((await f.post(opened, { action: 'settings.cloud.toggle' })).status, 400);
});

test('membership, account identity and organization roles are rechecked throughout browser session', async t => {
  const f = await fixture(t, { admin: true });
  const opened = await f.open();
  const data = { action: 'settings.variable.save', variableScope: 'organization', variableName: 'PRIVATE_ORG_BROWSER_TOKEN', variableValue: 'org-test-fixture-secret' };
  assert.equal((await f.post(opened, data)).status, 303);
  assert.ok(listOrgEnv().some(row => row.name === data.variableName));
  t.after(() => patchOrgEnv({ remove: data.variableName }));
  await setUser(f.ownerId, { isAdmin: false });
  assert.equal((await f.post(opened, { action: 'settings.variable.remove', variableScope: 'organization', name: data.variableName })).status, 403);
  f.revoke();
  assert.equal((await fetch(f.base + opened.route, { headers: { cookie: opened.cookie } })).status, 403);
  assert.equal((await f.post(opened, { ...data, variableScope: 'channel' })).status, 403);
  assert.equal((await fetch(f.grant(), { redirect: 'manual' })).status, 403);
});

test('browser grants expire, bind the original origin, and reject workspace identity changes', async t => {
  const f = await fixture(t);
  assert.equal(createConversationSettingsGrantUrl({ baseUrl: 'javascript:alert(1)' }), '');
  assert.equal((await fetch(f.grant({ now: Date.now() - CONVERSATION_SETTINGS_GRANT_TTL_MS - 1 }), { redirect: 'manual' })).status, 410);
  const wrongOrigin = createConversationSettingsGrantUrl({ baseUrl: 'https://other.example', channelId: f.channelId, slug: f.entry.slug, ownerId: f.ownerId });
  assert.equal((await fetch(wrongOrigin.replace('https://other.example', f.base), { redirect: 'manual' })).status, 403);
  const opened = await f.open();
  f.mismatch();
  assert.equal((await fetch(f.base + opened.route, { headers: { cookie: opened.cookie } })).status, 403);
});
