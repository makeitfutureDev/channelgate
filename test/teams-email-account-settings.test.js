import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { renderCatalogPage, handleCatalogAction, EMAIL_ACCOUNT_FIELDS } = await import('../src/platforms/msteams/settings-catalog.js');
const { handleTeamsSettings, teamsSettingsUi } = await import('../src/platforms/msteams/settings.js');
const { setEmailAccountVerifierForTests } = await import('../src/gateway/email-account-store.js');
const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, patchChannelMeta, getUser, setUser } = await import('../src/config/store.js');

const ui = {
  text: text => ({ type: 'TextBlock', text }), heading: text => ({ type: 'TextBlock', text }),
  input: (id, label, value) => ({ type: 'Input.Text', id, label, value }),
  choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, value, choices }),
  execute: (title, action, data = {}, associatedInputs) => ({ title, action, data, associatedInputs }),
  buttons: actions => ({ type: 'ActionSet', actions }),
};
let counter = 0;
async function context({ admin = false, fields = {} } = {}) {
  const channelId = `msteams:email-settings-${++counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `email-${counter}`, platform: 'msteams', type: 'channel', isDM: false });
  const meta = { ...defaultChannelMeta({ channelId, name: entry.name, platform: 'msteams', type: 'channel', isDM: false }), ...fields };
  await saveChannelMeta(entry.slug, meta);
  const ownerId = `msteams:email-user-${counter}`;
  await setUser(ownerId, { approved: true, isAdmin: admin });
  const ctx = { entry, meta, ownerId, channelId, userIsAdmin: admin, userIsApproved: true, state: {}, source: 'teams_settings' };
  ctx.authorize = async () => { ctx.meta = await getChannelMeta(entry.slug); ctx.userIsAdmin = Boolean((await getUser(ownerId)).isAdmin); return ctx; };
  ctx.patch = async updater => { const fresh = await ctx.authorize(); ctx.meta = await patchChannelMeta(entry.slug, current => updater(current, fresh)); return ctx.meta; };
  return ctx;
}
const invoke = (ctx, action, data) => handleCatalogAction(action, data, ctx, ui);
const PASSWORD = 'imap-secret-fixture-never-rendered';
const SMTP_PASSWORD = 'smtp-secret-fixture-never-rendered';
const account = (overrides = {}) => ({ name: 'work', address: 'work@example.com', displayName: 'Work desk', imapHost: 'imap.example.com', imapPort: '', imapUser: 'work@example.com',
  imapPassword: PASSWORD, smtpHost: 'smtp.example.com', smtpPort: '465', smtpUser: '', smtpPassword: '', ...overrides });
const inputs = card => card.body.filter(item => item.type === 'Input.Text' || item.type === 'Input.ChoiceSet').map(item => item.id);
const removeActions = card => card.body.flatMap(item => item.actions || []).filter(action => action.action === 'settings.email.remove' || action.verb === 'settings.email.remove');

const verified = [];
setEmailAccountVerifierForTests(async record => { verified.push({ name: record.name, imap: record.imap.password, smtp: record.smtp.password }); });
test.after(() => setEmailAccountVerifierForTests(null));

test('the MCPs page lists email accounts for both scopes and shows inputs only on a private card', async () => {
  const ctx = await context();
  const empty = await renderCatalogPage('mcp', ctx, ui);
  assert.match(JSON.stringify(empty), /Email accounts.*No email account is connected to this conversation.*My email accounts.*no personal email account/s);
  for (const id of ['emailScope', ...EMAIL_ACCOUNT_FIELDS]) assert.ok(inputs(empty).includes(id), `${id} input present`);
  assert.deepEqual(empty.body.find(item => item.id === 'emailScope').choices.map(item => item.value), ['channel', 'personal']);
  assert.ok(empty.body.some(item => item.actions?.some(action => action.action === 'settings.email.save')));

  await invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() });
  await invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account({ name: 'mine', address: 'me@example.com', imapUser: 'me@example.com' }) });
  const card = await renderCatalogPage('mcp', ctx, ui);
  const text = JSON.stringify(card);
  assert.match(text, /work · work@example.com · IMAP imap.example.com:993 · SMTP smtp.example.com:465/);
  assert.match(text, /mine · me@example.com · IMAP imap.example.com:993/);
  assert.deepEqual(removeActions(card).map(action => action.data), [{ emailScope: 'channel', name: 'work' }, { emailScope: 'personal', name: 'mine' }]);
  assert.ok(!text.includes(PASSWORD) && !text.includes(SMTP_PASSWORD));
  for (const id of ['imapPassword', 'smtpPassword']) assert.equal(card.body.find(item => item.id === id).value, '');

  // A public space card (Google Chat) keeps the masked list and its remove buttons but offers no inputs.
  ctx.publicCredentials = true;
  const publicCard = await renderCatalogPage('mcp', ctx, ui);
  assert.equal(removeActions(publicCard).length, 2);
  assert.ok(!inputs(publicCard).some(id => id === 'emailScope' || EMAIL_ACCOUNT_FIELDS.includes(id)));
  assert.match(JSON.stringify(publicCard), /private browser settings/);
  assert.ok(!JSON.stringify(publicCard).includes(PASSWORD));

  // A shared channel card has no personal block and no scope choice; its save button is pinned to the channel.
  ctx.publicCredentials = false; ctx.isShared = true;
  const shared = await renderCatalogPage('mcp', ctx, ui);
  assert.ok(!inputs(shared).includes('emailScope'));
  assert.doesNotMatch(JSON.stringify(shared), /mine · me@example.com|My email accounts/);
  assert.deepEqual(shared.body.flatMap(item => item.actions || []).find(action => action.action === 'settings.email.save').data, { emailScope: 'channel' });
});

test('saving stores a verified channel or personal account with derived defaults and keeps passwords on update', async () => {
  const ctx = await context();
  verified.length = 0;
  await invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account(), ownerId: 'forged', channelId: 'forged' });
  assert.equal(ctx.state.tab, 'mcp');
  assert.equal(ctx.state.notice, 'Email account "work" connected — IMAP and SMTP logins verified.');
  assert.ok(!ctx.state.notice.includes(PASSWORD));
  const stored = (await getChannelMeta(ctx.entry.slug)).emailAccounts;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].imap, { host: 'imap.example.com', port: 993, security: 'tls', user: 'work@example.com', password: PASSWORD });
  assert.deepEqual(stored[0].smtp, { host: 'smtp.example.com', port: 465, security: 'tls', user: 'work@example.com', password: PASSWORD });
  assert.equal(stored[0].setBy, ctx.ownerId);
  assert.deepEqual(verified, [{ name: 'work', imap: PASSWORD, smtp: PASSWORD }]);

  // Updating with blank passwords keeps the stored ones; a new SMTP password applies on its own.
  await invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account({ displayName: 'Renamed desk', imapPassword: '', smtpPassword: SMTP_PASSWORD }) });
  const updated = (await getChannelMeta(ctx.entry.slug)).emailAccounts;
  assert.equal(updated.length, 1);
  assert.equal(updated[0].displayName, 'Renamed desk');
  assert.equal(updated[0].imap.password, PASSWORD);
  assert.equal(updated[0].smtp.password, SMTP_PASSWORD);

  await invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account({ name: 'mine', address: 'me@example.com', imapUser: 'me@example.com' }) });
  const personal = (await getUser(ctx.ownerId)).emailAccounts;
  assert.equal(personal.length, 1);
  assert.equal(personal[0].name, 'mine');
  assert.equal(personal[0].imap.password, PASSWORD);
  assert.equal((await getUser('forged')), null);
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts.length, 1, 'a personal save never touches the channel list');

  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'organization', ...account() }), /belongs to this conversation or to you/);
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account({ name: 'Bad Name' }) }), /Account name/);
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account({ name: 'fresh', imapPassword: '' }) }), /IMAP password is required/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts.length, 1);
});

test('a failed login test leaves nothing stored and surfaces the server message', async () => {
  const ctx = await context();
  setEmailAccountVerifierForTests(async () => { throw new Error('IMAP login failed (imap.example.com:993): Invalid credentials'); });
  try {
    await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() }), /IMAP login failed \(imap\.example\.com:993\): Invalid credentials/);
    await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account() }), /IMAP login failed/);
  } finally {
    setEmailAccountVerifierForTests(async () => {});
  }
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts, undefined);
  assert.equal((await getUser(ctx.ownerId)).emailAccounts, undefined);
  assert.equal(ctx.state.notice, undefined);
  // Authority is rechecked after the slow connection test, before the write.
  let calls = 0;
  const authorize = ctx.authorize;
  ctx.authorize = async () => { if (++calls > 1) throw new Error('membership revoked'); return authorize(); };
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() }), /membership revoked/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts, undefined);
});

test('removal goes through the confirmation card and the real card masks password inputs', async () => {
  const ctx = await context();
  ctx.isShared = false;
  await invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() });
  await invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account({ name: 'mine', address: 'me@example.com', imapUser: 'me@example.com' }) });
  const real = teamsSettingsUi('state-1');
  for (const id of ['imapPassword', 'smtpPassword']) assert.equal(real.input(id, 'x').style, 'password');
  assert.equal(real.input('imapHost', 'x').style, undefined);

  const confirm = await handleTeamsSettings('settings.email.remove', { emailScope: 'channel', name: 'work', imapPassword: 'should-not-persist' }, ctx, 'state-1');
  assert.match(JSON.stringify(confirm), /Confirm change.*Remove the email account work from this conversation\?/s);
  assert.deepEqual(ctx.state.confirmation.data, { emailScope: 'channel', name: 'work' });
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts.length, 1, 'nothing changes before confirmation');
  await assert.rejects(handleTeamsSettings('settings.confirm', { token: 'wrong' }, ctx, 'state-1'), /no longer available/);
  const card = await handleTeamsSettings('settings.confirm', { token: ctx.state.confirmation.token }, ctx, 'state-1');
  assert.deepEqual((await getChannelMeta(ctx.entry.slug)).emailAccounts, []);
  assert.equal(ctx.state.notice, 'Email account "work" removed.');
  const text = JSON.stringify(card);
  assert.match(text, /No email account is connected to this conversation/);
  assert.match(text, /mine · me@example.com/);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(card.body.some(item => item.id === 'imapPassword' && item.style === 'password' && item.value === ''));
  assert.ok(card.body.some(item => item.id === 'smtpPassword' && item.style === 'password' && item.value === ''));
  await assert.rejects(handleTeamsSettings('settings.confirm', { token: ctx.state.confirmation?.token }, ctx, 'state-1'), /no longer available/);

  const personalConfirm = await handleTeamsSettings('settings.email.remove', { emailScope: 'personal', name: 'mine' }, ctx, 'state-1');
  assert.match(JSON.stringify(personalConfirm), /Remove your personal email account mine\?/);
  await handleTeamsSettings('settings.confirm', { token: ctx.state.confirmation.token }, ctx, 'state-1');
  assert.deepEqual((await getUser(ctx.ownerId)).emailAccounts, []);
  await assert.rejects(invoke(ctx, 'settings.email.remove', { emailScope: 'personal', name: 'mine' }), /No email account named "mine"/);
});

test('public cards refuse saves, shared cards refuse personal scope, and lost authorization blocks writes', async () => {
  const ctx = await context();
  ctx.publicCredentials = true;
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() }), /private browser settings/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts, undefined);
  ctx.publicCredentials = false; ctx.isShared = true;
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account() }), /authenticated settings window/);
  await assert.rejects(invoke(ctx, 'settings.email.remove', { emailScope: 'personal', name: 'work' }), /authenticated settings window/);
  assert.equal((await getUser(ctx.ownerId)).emailAccounts, undefined);
  await invoke(ctx, 'settings.email.save', { emailScope: 'channel', ...account() });
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts.length, 1);
  ctx.isShared = false; ctx.ownerId = '';
  await assert.rejects(invoke(ctx, 'settings.email.save', { emailScope: 'personal', ...account() }), /authenticated settings window/);
  ctx.authorize = async () => { throw new Error('membership revoked'); };
  await assert.rejects(invoke(ctx, 'settings.email.remove', { emailScope: 'channel', name: 'work' }), /membership revoked/);
  assert.equal((await getChannelMeta(ctx.entry.slug)).emailAccounts.length, 1);
});

test("a conversation's accounts are a manager's call: admins-only policy refuses a member, admits an admin", async () => {
  const member = await context({ fields: { manageAccess: 'admins' } });
  await assert.rejects(invoke(member, 'settings.email.save', { emailScope: 'channel', ...account() }), /managers or an admin/);
  assert.equal((await getChannelMeta(member.entry.slug)).emailAccounts, undefined);
  // The member's own account is still theirs to connect.
  await invoke(member, 'settings.email.save', { emailScope: 'personal', ...account({ name: 'mine', address: 'me@example.com', imapUser: 'me@example.com' }) });
  assert.equal((await getUser(member.ownerId)).emailAccounts[0].name, 'mine');
  const admin = await context({ admin: true, fields: { manageAccess: 'admins' } });
  await invoke(admin, 'settings.email.save', { emailScope: 'channel', ...account() });
  assert.equal((await getChannelMeta(admin.entry.slug)).emailAccounts[0].name, 'work');
  await assert.rejects(invoke(member, 'settings.email.remove', { emailScope: 'channel', name: 'work' }), /managers or an admin/);
});
