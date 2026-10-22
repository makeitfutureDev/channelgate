import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createConversationSettingsGrantUrl, createConversationSettingsRouter, resetConversationSettingsStateForTests } = await import('../src/web/conversation-settings.js');
const { setEmailAccountVerifierForTests } = await import('../src/gateway/email-account-store.js');
const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, setUser, getUser } = await import('../src/config/store.js');

let counter = 0;
async function fixture(t) {
  resetConversationSettingsStateForTests();
  t.after(resetConversationSettingsStateForTests);
  const channelId = `gchat:spaces/email-settings-${++counter}`, ownerId = `gchat:users/email-${counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `email-private-${counter}`, platform: 'googlechat', isDM: false, type: 'channel' });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId, name: entry.name, platform: 'googlechat', isDM: false, type: 'channel' }));
  await setUser(ownerId, { approved: true, isAdmin: false });
  const app = express();
  app.use('/conversation-settings', createConversationSettingsRouter({ authorize: async grant => {
    assert.equal(grant.ownerId, ownerId);
    return { entry, meta: await getChannelMeta(entry.slug), userId: ownerId, members: [{ id: ownerId }] };
  } }));
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = async () => {
    const exchange = await fetch(createConversationSettingsGrantUrl({ baseUrl: base, channelId, slug: entry.slug, ownerId, tab: 'mcp' }), { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    const route = exchange.headers.get('location'), cookie = exchange.headers.get('set-cookie').split(';')[0];
    const response = await fetch(base + route, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text(), csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    return { route, cookie, html, csrf };
  };
  const post = async (opened, data) => fetch(base + opened.route, { method: 'POST', redirect: 'manual', headers: { cookie: opened.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: opened.csrf, ...data }) });
  const reload = async opened => (await fetch(base + opened.route, { headers: { cookie: opened.cookie } })).text();
  return { entry, ownerId, open, post, reload };
}
const PASSWORD = 'browser-imap-secret-fixture';
const SMTP_PASSWORD = 'browser-smtp-secret-fixture';
const account = (overrides = {}) => ({ action: 'settings.email.save', emailScope: 'channel', name: 'work', address: 'work@example.com', displayName: 'Work desk', imapHost: 'imap.example.com', imapPort: '',
  imapUser: 'work@example.com', imapPassword: PASSWORD, smtpHost: 'smtp.example.com', smtpPort: '', smtpUser: 'smtp-user', smtpPassword: SMTP_PASSWORD, ...overrides });

setEmailAccountVerifierForTests(async () => {});
test.after(() => setEmailAccountVerifierForTests(null));

test('the private browser form connects, lists masked and removes channel and personal email accounts', async t => {
  const f = await fixture(t);
  const opened = await f.open();
  assert.match(opened.html, /<h2>Email accounts<\/h2>/);
  assert.match(opened.html, /name="imapPassword" type="password" autocomplete="new-password" maxlength="8000" value=""/);
  assert.match(opened.html, /name="smtpPassword" type="password"/);
  assert.match(opened.html, /<select name="emailScope"><option value="channel">channel<\/option><option value="personal">personal<\/option><\/select>/);
  assert.match(opened.html, /Leave passwords blank to keep the stored ones when editing; blank SMTP user\/password = same as IMAP/);
  assert.match(opened.html, /No email account connected/);

  assert.equal((await f.post(opened, account())).status, 303);
  const channel = (await getChannelMeta(f.entry.slug)).emailAccounts;
  assert.equal(channel.length, 1);
  assert.deepEqual(channel[0].imap, { host: 'imap.example.com', port: 993, security: 'tls', user: 'work@example.com', password: PASSWORD });
  assert.deepEqual(channel[0].smtp, { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'smtp-user', password: SMTP_PASSWORD });
  assert.equal(channel[0].setBy, f.ownerId);

  assert.equal((await f.post(opened, account({ emailScope: 'personal', name: 'mine', address: 'me@example.com', imapUser: 'me@example.com', ownerId: 'forged' }))).status, 303);
  const personal = (await getUser(f.ownerId)).emailAccounts;
  assert.equal(personal.length, 1);
  assert.equal(personal[0].name, 'mine');
  assert.equal(await getUser('forged'), null);
  assert.equal((await getChannelMeta(f.entry.slug)).emailAccounts.length, 1);

  let html = await f.reload(opened);
  assert.match(html, /Saved\. Credential values remain hidden\./);
  assert.match(html, /<li>channel · work · work@example.com · IMAP imap.example.com:993 · SMTP smtp.example.com:587<form method="post">/);
  assert.match(html, /<li>personal · mine · me@example.com · IMAP imap.example.com:993 · SMTP smtp.example.com:587/);
  assert.match(html, /name="action" value="settings.email.remove"><input type="hidden" name="emailScope" value="channel"><input type="hidden" name="name" value="work">/);
  assert.match(html, /name="emailScope" value="personal"><input type="hidden" name="name" value="mine">/);
  assert.ok(!html.includes(PASSWORD) && !html.includes(SMTP_PASSWORD));
  assert.ok(!html.includes('smtp-user'), 'user names are not rendered either');
  assert.match(html, /name="imapPassword" type="password" autocomplete="new-password" maxlength="8000" value=""/);

  assert.equal((await f.post(opened, { action: 'settings.email.remove', emailScope: 'channel', name: 'work' })).status, 303);
  assert.deepEqual((await getChannelMeta(f.entry.slug)).emailAccounts, []);
  assert.equal((await getUser(f.ownerId)).emailAccounts.length, 1);
  assert.equal((await f.post(opened, { action: 'settings.email.remove', emailScope: 'personal', name: 'mine' })).status, 303);
  assert.deepEqual((await getUser(f.ownerId)).emailAccounts, []);
  html = await f.reload(opened);
  assert.match(html, /No email account connected/);
  assert.doesNotMatch(html, /work@example.com|me@example.com/);
});

test('a refused email account save explains the rule, names no password and stores nothing', async t => {
  const f = await fixture(t);
  const opened = await f.open();
  setEmailAccountVerifierForTests(async () => { throw new Error(`IMAP login failed (imap.example.com:993): Invalid credentials`); });
  try {
    assert.equal((await f.post(opened, account())).status, 303);
  } finally {
    setEmailAccountVerifierForTests(async () => {});
  }
  assert.equal((await getChannelMeta(f.entry.slug)).emailAccounts, undefined);
  let html = await f.reload(opened);
  assert.match(html, /Not saved\. IMAP login failed \(imap\.example\.com:993\): Invalid credentials No value was stored\./);
  assert.ok(!html.includes(PASSWORD) && !html.includes(SMTP_PASSWORD));

  assert.equal((await f.post(opened, account({ emailScope: 'organization' }))).status, 303);
  html = await f.reload(opened);
  assert.match(html, /Not saved\. Choose whether the email account belongs to this conversation or to you\./);
  assert.equal((await f.post(opened, account({ address: 'not-an-address' }))).status, 303);
  html = await f.reload(opened);
  assert.match(html, /Not saved\. Email address must look like name@example.com No value was stored\./);
  assert.equal((await getChannelMeta(f.entry.slug)).emailAccounts, undefined);
  assert.equal((await getUser(f.ownerId)).emailAccounts, undefined);
  assert.ok(!html.includes(PASSWORD));
});
