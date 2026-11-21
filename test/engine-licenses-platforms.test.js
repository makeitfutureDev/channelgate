// Engine licenses on the surfaces without a web page: the text commands every platform shares
// (/model, /license, /status), the Microsoft Teams settings and /model cards, and the typed Google
// Chat settings commands. A harness with one license looks as it always did; a harness with
// several gains the license step. ("License" here is an ENGINE license, never the product one.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';

ensureTestEnv();
const { createConversationControls } = await import('../src/platforms/conversation-controls.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { licenseListText, readLicenseChoice } = await import('../src/platforms/license-choice.js');
const { renderGeneral, handleGeneral, generalRuntimeScopes } = await import('../src/platforms/msteams/settings-general.js');
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { parseSettingsCommand, GOOGLE_CHAT_SETTINGS_USAGE } = await import('../src/platforms/googlechat/settings-commands.js');
const { adaptiveSettingsToChat } = await import('../src/platforms/googlechat/cards.js');
const { saveSettings } = await import('../src/config/settings.js');
const { createLicense } = await import('../src/config/engine-licenses.js');
const { licenseLoginHome } = await import('../src/engines/license-state.js');
const { modelsForEngine } = await import('../src/engines/registry.js');
const { getThreadEngine, getThreadModel, getThreadLicensePool, setThreadRuntimeOverrides } = await import('../src/gateway/thread-engine.js');

// A Codex sign-in license an administrator added and signed in (test/engine-licenses.test.js).
const jwt = () => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000, 'https://api.openai.com/auth': { chatgpt_plan_type: 'team', chatgpt_account_id: 'lic-test' } })).toString('base64url')}.fixture`;
function signedInLicense(label) {
  const license = createLicense({ kind: 'codex-login', label, type: 'business' });
  mkdirSync(licenseLoginHome(license.id), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(licenseLoginHome(license.id), 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(), refresh_token: 'fixture-refresh', account_id: 'lic-test' } }), { mode: 0o600 });
  return license;
}
// One license per harness — what every install has before an administrator adds any.
const reset = () => saveSettings({ engineLicenses: [], engine: 'claude', enginePool: '', engineEnabled: { claude: true, codex: true }, engineFallback: true, defaultClaudeModel: 'sonnet', defaultCodexModel: 'gpt-6-sol' });
// Codex with three licenses: its own sign-in, "Work" and "Spare".
function severalLicenses() {
  reset();
  return { work: signedInLicense('Work'), spare: signedInLicense('Spare') };
}

let sequence = 0;
const nextSlug = () => `engine-licenses-platforms-${++sequence}`;
const pin = async slug => ({ engine: await getThreadEngine(slug, 'root'), licensePool: await getThreadLicensePool(slug, 'root') });
async function command(slug, text, meta, { authorIsAdmin = true, picked } = {}) {
  const replies = [];
  const message = makeInbound({ platform: 'msteams', conversationId: `19:${slug}@thread.v2`, messageId: 'command', kind: 'channel', userId: 'teams:license-admin', text, mentionsBot: true });
  const handled = await createConversationControls().command({ message, sessionKey: 'root', slug, meta, authorIsAdmin, reply: async value => replies.push(value), ...(picked ? { picked } : {}) });
  assert.equal(handled, true);
  return replies.at(-1);
}

// ── What a person types ────────────────────────────────────────────────────────────────────────

test('typed license choices: number, id, name, "any", and an ordered list', () => {
  const licenses = [{ id: 'codex', label: 'Default sign-in' }, { id: 'codex-lic-aaaaaaaa', label: 'Work ChatGPT' }, { id: 'codex-lic-bbbbbbbb', label: 'Work spare' }];
  assert.equal(licenseListText(licenses), '1) Default sign-in (codex); 2) Work ChatGPT (codex-lic-aaaaaaaa); 3) Work spare (codex-lic-bbbbbbbb)');
  assert.deepEqual(readLicenseChoice('any', licenses), { license: 'any', also: [] });
  assert.deepEqual(readLicenseChoice('ANY', licenses), { license: 'any', also: [] });
  assert.deepEqual(readLicenseChoice('2', licenses), { license: 'codex-lic-aaaaaaaa', also: [] });
  assert.deepEqual(readLicenseChoice('codex-lic-bbbbbbbb', licenses), { license: 'codex-lic-bbbbbbbb', also: [] });
  assert.deepEqual(readLicenseChoice('work chatgpt', licenses), { license: 'codex-lic-aaaaaaaa', also: [] });
  assert.deepEqual(readLicenseChoice('default', licenses), { license: 'codex', also: [] });
  // The order typed is the order tried, and a license named twice counts once.
  assert.deepEqual(readLicenseChoice('spare, 1, work chatgpt, 3', licenses), { license: 'codex-lic-bbbbbbbb', also: ['codex', 'codex-lic-aaaaaaaa'] });
  // A name that fits several is refused rather than guessed; so is one that fits none.
  assert.match(readLicenseChoice('work', licenses).error, /fits more than one license \(Work ChatGPT \(codex-lic-aaaaaaaa\), Work spare \(codex-lic-bbbbbbbb\)\)/);
  assert.match(readLicenseChoice('2, nope', licenses).error, /No license here is called “nope”/);
  assert.match(readLicenseChoice(' , ', licenses).error, /Name a license/);
});

// ── /license, /model and /status ───────────────────────────────────────────────────────────────

test('/license with one license per harness has nothing to choose and writes nothing', async () => {
  reset();
  const slug = nextSlug(), meta = { engine: 'claude' };
  assert.equal(await command(slug, '/license', meta), 'License selection: Claude Code. Claude Code has a single license here, so there is nothing to choose.');
  for (const text of ['/license any', '/license claude', '/license 1']) {
    assert.equal(await command(slug, text, meta), 'Claude Code has a single license here, so there is nothing to choose.');
  }
  assert.deepEqual(await pin(slug), { engine: '', licensePool: '' });
  // The other commands do not mention licenses at all.
  const status = await command(slug, '/status', meta);
  assert.match(status, /^Harness: Claude Code; model: sonnet; effort: .+\. Idle\.$/);
  const listing = await command(slug, '/model', meta);
  assert.match(listing, /^Harness: Claude Code; model: sonnet\. Harnesses: Claude Code \(claude\), Codex \(codex\)\. Models: /);
  assert.doesNotMatch(`${status}${listing}`, /licen[sc]e/i);
});

test('/license lists a harness\'s licenses when it has several', async () => {
  const { work, spare } = severalLicenses();
  const slug = nextSlug(), meta = { engine: 'codex' };
  const listing = await command(slug, '/license', meta);
  assert.ok(listing.startsWith(`License selection: Codex · Default sign-in. Codex licenses here: 1) Default sign-in (codex); 2) Work (${work.id}); 3) Spare (${spare.id}). Use /license any,`), listing);
  assert.match(listing, /When a license cannot answer, the turn moves to the next one\.$/);
  assert.match(await command(slug, '/model', meta), /^Harness: Codex · Default sign-in; model: gpt-6-sol\. Harnesses: Claude Code \(claude\), Codex \(codex\)\. .+ Licenses: \/license\.$/);
  // Claude Code still has one license in the same conversation.
  assert.match(await command(nextSlug(), '/license', { engine: 'claude' }), /Claude Code has a single license here, so there is nothing to choose\.$/);
});

test('/license any, a named list in the order typed, an unknown name, and default', async () => {
  const { work, spare } = severalLicenses();
  const slug = nextSlug(), meta = { engine: 'codex' };

  assert.equal(await command(slug, '/license any', meta), 'Session license: Codex · any license.');
  assert.deepEqual(await pin(slug), { engine: 'codex', licensePool: 'any' });
  assert.match(await command(slug, '/status', meta), /^Harness: Codex · any license; model: /);

  assert.equal(await command(slug, '/license spare, work', meta), 'Session license: Codex · Spare, then Work.');
  assert.deepEqual(await pin(slug), { engine: spare.id, licensePool: [work.id] });

  // Numbers and ids from the list work too, and the order typed is the order kept.
  assert.equal(await command(slug, `/license 2, ${spare.id}, 1`, meta), 'Session license: Codex · Work, then Spare, Default sign-in.');
  assert.deepEqual(await pin(slug), { engine: work.id, licensePool: [spare.id, 'codex'] });
  assert.match(await command(slug, '/status', meta), /^Harness: Codex · Work, then Spare, Default sign-in; model: /);

  // One license and nothing to move to.
  assert.equal(await command(slug, '/license spare', meta), 'Session license: Codex · Spare.');
  assert.deepEqual(await pin(slug), { engine: spare.id, licensePool: '' });

  // An unknown name is refused with the list, and the selection stays as it was.
  const refused = await command(slug, '/license spare, nope', meta);
  assert.ok(refused.startsWith('No license here is called “nope”. Codex licenses here: 1) Default sign-in (codex);'), refused);
  assert.deepEqual(await pin(slug), { engine: spare.id, licensePool: '' });
  // A license of the other harness is not one of this harness's licenses.
  assert.match(await command(slug, '/license claude', meta), /^No license here is called “claude”\./);
  assert.deepEqual(await pin(slug), { engine: spare.id, licensePool: '' });

  assert.equal(await command(slug, '/license default', meta), 'Session license: inherited default (Codex · Default sign-in).');
  assert.deepEqual(await pin(slug), { engine: '', licensePool: '' });
});

test('/license is open to a member who is not an administrator, within the licenses that are switched on', async () => {
  const { work, spare } = severalLicenses();
  const slug = nextSlug(), meta = { engine: 'codex' };
  assert.doesNotMatch(await command(slug, '/license any', meta, { authorIsAdmin: false }), /restricted to administrators/);
  assert.deepEqual(await pin(slug), { engine: 'codex', licensePool: 'any' });
  await command(slug, '/license default', meta, { authorIsAdmin: false });
  assert.deepEqual(await pin(slug), { engine: '', licensePool: '' });
  // Reading the list is open to everyone, as bare /model is.
  assert.match(await command(slug, '/license', meta, { authorIsAdmin: false }), /^License selection: Codex · Default sign-in\./);
  // A license that is switched off is not offered, so it cannot be named.
  saveSettings({ engineEnabled: { claude: true, codex: true, [work.id]: false, [spare.id]: true } });
  assert.match(await command(slug, '/license work', meta), /^No license here is called “work”\./);
  assert.deepEqual(await pin(slug), { engine: '', licensePool: '' });
});

test('/model <harness> takes the conversation\'s own licenses for that harness', async () => {
  const { work, spare } = severalLicenses();
  const meta = { engine: work.id, licensePool: [spare.id] };

  // A session pinned to Claude Code moves back to Codex on the channel's license and pool.
  const slug = nextSlug();
  setThreadRuntimeOverrides(slug, 'root', { engine: 'claude', model: 'sonnet', effort: '' });
  assert.equal(await command(slug, '/model codex', meta), 'Session harness: Codex · Work, then Spare; model: inherited default.');
  assert.deepEqual(await pin(slug), { engine: work.id, licensePool: [spare.id] });

  // "Any license" on the channel is inherited as such.
  const anySlug = nextSlug();
  assert.equal(await command(anySlug, '/model codex gpt-6-sol', { engine: work.id, licensePool: 'any' }), 'Session harness: Codex · any license; model: gpt-6-sol.');
  assert.deepEqual(await pin(anySlug), { engine: work.id, licensePool: 'any' });
  assert.equal(await getThreadModel(anySlug, 'root'), 'gpt-6-sol');

  // A channel on the other harness says nothing about Codex licenses: its own sign-in, then its
  // other sign-ins — a typed word is never asked which license, and the person named the harness.
  const otherSlug = nextSlug();
  assert.equal(await command(otherSlug, '/model codex', { engine: 'claude' }), 'Session harness: Codex · Default sign-in, then Work, Spare; model: inherited default.');
  assert.deepEqual(await pin(otherSlug), { engine: 'codex', licensePool: [work.id, spare.id] });

  // A license id still pins that one license, and a model-only change keeps the session's licenses.
  const idSlug = nextSlug();
  assert.equal(await command(idSlug, `/model ${spare.id}`, meta), 'Session harness: Codex · Spare; model: inherited default.');
  assert.deepEqual(await pin(idSlug), { engine: spare.id, licensePool: '' });
  assert.equal(await command(slug, '/model gpt-6-sol', meta), 'Session harness: Codex · Work, then Spare; model: gpt-6-sol.');
  assert.deepEqual(await pin(slug), { engine: work.id, licensePool: [spare.id] });

  // The harness word in a session ALREADY pinned to one of that harness's licenses keeps the pin:
  // naming the harness the session is on must not move it to the channel's license.
  assert.equal(await command(idSlug, '/model codex', meta), 'Session harness: Codex · Spare; model: inherited default.');
  assert.deepEqual(await pin(idSlug), { engine: spare.id, licensePool: '' });
  assert.equal(await command(idSlug, '/model codex gpt-6-sol', meta), 'Session harness: Codex · Spare; model: gpt-6-sol.');
  assert.deepEqual(await pin(idSlug), { engine: spare.id, licensePool: '' });
});

test('/status names the harness alone, or the harness and its licenses', async () => {
  reset();
  assert.match(await command(nextSlug(), '/status', { engine: 'codex' }), /^Harness: Codex; model: gpt-6-sol; effort: .+\. Idle\.$/);
  const { work, spare } = severalLicenses();
  assert.match(await command(nextSlug(), '/status', { engine: 'codex' }), /^Harness: Codex · Default sign-in; model: gpt-6-sol; /);
  assert.match(await command(nextSlug(), '/status', { engine: work.id, licensePool: [spare.id] }), /^Harness: Codex · Work, then Spare; model: /);
  assert.match(await command(nextSlug(), '/status', { engine: work.id, licensePool: 'any' }), /^Harness: Codex · any license; model: /);
  // Claude Code has one license here, so it reads as before.
  assert.match(await command(nextSlug(), '/status', { engine: 'claude' }), /^Harness: Claude Code; model: sonnet; /);
});

// ── Microsoft Teams: Settings → General ────────────────────────────────────────────────────────

const ui = {
  text: text => ({ type: 'TextBlock', text }), heading: text => ({ type: 'TextBlock', text, weight: 'Bolder' }),
  choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, value, choices: choices.map(item => ({ title: item.label || item.value, value: item.value })) }),
  execute: (title, verb, data = {}, associatedInputs = 'auto') => ({ type: 'Action.Execute', title, verb, data, associatedInputs }),
  buttons: actions => ({ type: 'ActionSet', actions }),
};
function context(meta = {}) {
  const ctx = {
    entry: { slug: nextSlug() }, meta: { access: 'approved', ...meta }, ownerId: '29:owner', channelId: 'msteams:19:licenses@thread.tacv2', sessionKey: 'root', userIsAdmin: true, userIsApproved: true, state: {},
    connector: { api: { listMembers: async () => [{ id: '29:owner', name: 'Owner' }] } },
  };
  ctx.authorize = async () => ctx;
  ctx.patch = async updater => { const patch = updater(ctx.meta, ctx); ctx.meta = { ...ctx.meta, ...patch }; return ctx.meta; };
  return ctx;
}
const row = (body, id) => body.find(item => item.id === id);
const values = item => item.choices.map(choice => choice.value);
const loadButtons = body => body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions).filter(action => action.verb === 'settings.runtime.models');

test('Teams General with one license per harness shows Harness and no license control', async () => {
  reset();
  const ctx = context({ engine: 'codex' });
  const { body } = await renderGeneral(ctx, ui);
  for (const scope of ['channel', 'thread']) {
    assert.equal(row(body, `${scope}_engine`).label, 'Harness');
    assert.deepEqual(values(row(body, `${scope}_engine`)), ['__default__', 'claude', 'codex']);
    assert.equal(row(body, `${scope}_license`), undefined);
    assert.equal(row(body, `${scope}_also`), undefined);
  }
  assert.equal(row(body, 'channel_engine').value, 'codex');
  assert.deepEqual(loadButtons(body).map(action => action.title), ['Load models', 'Load models']);
  assert.doesNotMatch(JSON.stringify(body), /If it fails, also use|Any license/);

  // Applying a harness there saves that harness's license and no pool.
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'claude', channel_model: '__default__', channel_effort: '__default__' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'claude');
  assert.equal(ctx.meta.licensePool, '');
});

test('Teams General with several licenses shows License and "If it fails, also use"', async () => {
  const { work, spare } = severalLicenses();
  const ctx = context({ engine: work.id, licensePool: [spare.id] });
  const { body } = await renderGeneral(ctx, ui);
  assert.equal(row(body, 'channel_engine').label, 'Harness');
  assert.equal(row(body, 'channel_engine').value, 'codex');
  assert.deepEqual(values(row(body, 'channel_engine')), ['__default__', 'claude', 'codex']);
  const license = row(body, 'channel_license'), also = row(body, 'channel_also');
  assert.equal(license.label, 'License');
  assert.equal(license.value, work.id);
  assert.deepEqual(license.choices, [{ title: 'Any license', value: 'any' }, { title: 'Default sign-in', value: 'codex' }, { title: 'Work', value: work.id }, { title: 'Spare', value: spare.id }]);
  assert.equal(also.label, 'If it fails, also use');
  assert.equal(also.isMultiSelect, true);
  assert.equal(also.value, spare.id);
  assert.deepEqual(also.choices, [{ title: 'Default sign-in', value: 'codex' }, { title: 'Spare', value: spare.id }]);
  assert.ok(body.some(item => item.text === 'When a license cannot answer, the turn moves to the next one.'));
  // The order on the card is harness → license → also → reload → model → effort.
  const order = ['channel_engine', 'channel_license', 'channel_also', 'channel_model', 'channel_effort'].map(id => body.findIndex(item => item.id === id));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every(index => index >= 0));
  assert.ok(loadButtons(body).every(action => action.title === 'Load licenses and models'));
  // The session follows the channel, so it has no harness of its own and no license step yet.
  assert.equal(row(body, 'thread_engine').value, '__default__');
  assert.match(row(body, 'thread_engine').choices[0].title, /Codex · Work, then Spare/);
  assert.equal(row(body, 'thread_license'), undefined);

  // "Any license" leaves nothing to add, so the second control goes away.
  const anyCtx = context({ engine: 'codex', licensePool: 'any' });
  const anyBody = (await renderGeneral(anyCtx, ui)).body;
  assert.equal(row(anyBody, 'channel_license').value, 'any');
  assert.equal(row(anyBody, 'channel_also'), undefined);

  // Google Chat renders the same card: a dropdown and a multi-select.
  const chat = JSON.stringify(adaptiveSettingsToChat({ type: 'AdaptiveCard', body, actions: [] }));
  assert.match(chat, /"name":"channel_license"/);
  assert.match(chat, /"name":"channel_also"[^}]*"type":"MULTI_SELECT"/);
});

test('Teams General saves the license and the licenses to move to, per scope', async () => {
  const { work, spare } = severalLicenses();
  const ctx = context({ engine: 'claude' });
  await renderGeneral(ctx, ui);

  // Choosing Codex and reloading stages the license step without saving anything.
  await handleGeneral('settings.runtime.models', { scope: 'channel', channel_engine: 'codex', channel_model: '__default__', channel_effort: '__default__' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'claude');
  assert.equal(ctx.state.notice, 'License and model choices refreshed. Use Apply to save your selection.');
  let body = (await renderGeneral(ctx, ui)).body;
  assert.equal(row(body, 'channel_engine').value, 'codex');
  assert.equal(row(body, 'channel_license').value, 'codex');
  assert.equal(row(body, 'channel_also').value, '');

  // Teams submits a multi-select as one comma-separated string, in the order chosen.
  const model = modelsForEngine(work.id)[0].value;
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_license: work.id, channel_also: `${spare.id},codex`, channel_model: model, channel_effort: '__default__' }, ctx, ui);
  assert.equal(ctx.meta.engine, work.id);
  assert.deepEqual(ctx.meta.licensePool, [spare.id, 'codex']);
  assert.equal(ctx.meta.model, model);
  assert.equal(ctx.state.notice, 'Channel defaults updated. Applies to the next turn.');

  // The stored selection comes back on the next render, and "Any license" replaces it.
  body = (await renderGeneral(ctx, ui)).body;
  assert.equal(row(body, 'channel_license').value, work.id);
  assert.equal(row(body, 'channel_also').value, `${spare.id},codex`);
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_license: 'any', channel_also: spare.id, channel_model: model, channel_effort: '__default__' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'codex');
  assert.equal(ctx.meta.licensePool, 'any');

  // The session pin carries its own license and pool.
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: 'codex', thread_license: spare.id, thread_also: work.id, thread_model: '__default__', thread_effort: '__default__' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), spare.id);
  assert.deepEqual(await getThreadLicensePool(ctx.entry.slug, 'root'), [work.id]);
  assert.equal(ctx.meta.licensePool, 'any');
  const scopes = await generalRuntimeScopes(ctx);
  assert.equal(scopes.thread.values.engine, spare.id);
  body = (await renderGeneral(ctx, ui)).body;
  assert.equal(row(body, 'thread_license').value, spare.id);
  assert.equal(row(body, 'thread_also').value, work.id);

  // Following the channel again drops the pin and its licenses together.
  await handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: '__default__', thread_model: '__default__', thread_effort: '__default__' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), '');
  assert.equal(await getThreadLicensePool(ctx.entry.slug, 'root'), '');
});

test('Teams General refuses licenses it did not offer and reloads a stale license step', async () => {
  const { work } = severalLicenses();
  const ctx = context({ engine: 'codex' });
  await renderGeneral(ctx, ui);
  const form = { scope: 'channel', channel_model: '__default__', channel_effort: '__default__' };
  // A license of another harness beside this one.
  await assert.rejects(handleGeneral('settings.runtime.apply', { ...form, channel_engine: 'codex', channel_license: work.id, channel_also: 'claude' }, ctx, ui), /Every license in one selection must be a Codex license/);
  await assert.rejects(handleGeneral('settings.runtime.apply', { ...form, channel_engine: 'codex', channel_license: 'codex-lic-00000000' }, ctx, ui), /not available in this conversation/);
  assert.equal(ctx.meta.engine, 'codex');
  assert.equal(ctx.meta.licensePool, undefined);
  // Harness changed to Claude Code while the card still shows Codex licenses: nothing is saved,
  // the card is repainted for the new harness instead.
  await handleGeneral('settings.runtime.apply', { ...form, channel_engine: 'claude', channel_license: work.id, channel_also: 'codex' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'codex');
  assert.match(ctx.state.notice, /^Harness changed, so its licenses and models were loaded\. Nothing was saved yet/);
  const { body } = await renderGeneral(ctx, ui);
  assert.equal(row(body, 'channel_engine').value, 'claude');
  assert.equal(row(body, 'channel_license'), undefined);
});

// ── Typed settings (Google Chat, and Teams cards posted before the combined form) ──────────────

test('typed settings accept harness and license, and the license field saves a selection', async () => {
  assert.deepEqual(parseSettingsCommand('harness codex'), { action: 'settings.runtime', data: { scope: 'thread', field: 'engine', thread_engine: 'codex' } });
  assert.deepEqual(parseSettingsCommand('channel harness default'), { action: 'settings.runtime', data: { scope: 'channel', field: 'engine', channel_engine: '__default__' } });
  assert.deepEqual(parseSettingsCommand('channel license Work, Spare'), { action: 'settings.runtime', data: { scope: 'channel', field: 'license', channel_license: 'Work, Spare' } });
  assert.deepEqual(parseSettingsCommand('license default'), { action: 'settings.runtime', data: { scope: 'thread', field: 'license', thread_license: '__default__' } });
  assert.match(GOOGLE_CHAT_SETTINGS_USAGE, /harness\|model\|effort/);
  assert.match(GOOGLE_CHAT_SETTINGS_USAGE, /license <any\|name\[, name…\]\|default>/);

  const { work, spare } = severalLicenses();
  const ctx = context({ engine: 'codex' });
  const typed = text => { const parsed = parseSettingsCommand(text); return handleGeneral(parsed.action, parsed.data, ctx, ui); };
  await typed('channel license spare, work');
  assert.equal(ctx.meta.engine, spare.id);
  assert.deepEqual(ctx.meta.licensePool, [work.id]);
  await typed('channel license any');
  assert.equal(ctx.meta.licensePool, 'any');
  await assert.rejects(typed('channel license nope'), /^Error: No license here is called “nope”\. Codex licenses here: 1\) Default sign-in \(codex\);/);
  assert.equal(ctx.meta.licensePool, 'any');

  // The session: a license selection, then a model change that leaves those licenses alone.
  await typed('license work, spare');
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), work.id);
  assert.deepEqual(await getThreadLicensePool(ctx.entry.slug, 'root'), [spare.id]);
  await typed(`model ${modelsForEngine(work.id)[0].value}`);
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), work.id);
  assert.deepEqual(await getThreadLicensePool(ctx.entry.slug, 'root'), [spare.id]);
  await typed('license default');
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), '');
  assert.equal(await getThreadLicensePool(ctx.entry.slug, 'root'), '');

  // A bare harness takes the level above's licenses for it, and one license leaves nothing to pick.
  await typed('harness codex');
  assert.equal(await getThreadEngine(ctx.entry.slug, 'root'), 'codex');
  assert.equal(await getThreadLicensePool(ctx.entry.slug, 'root'), 'any');
  await typed('channel harness claude');
  assert.equal(ctx.meta.engine, 'claude');
  assert.equal(ctx.meta.licensePool, '');
  await assert.rejects(typed('channel license any'), /Claude Code has a single license here, so there is nothing to choose\./);
});

// ── Microsoft Teams: the /model card ───────────────────────────────────────────────────────────

function modelCardFixture(meta) {
  const slug = nextSlug(), sent = [], replies = [];
  const message = { ...makeInbound({ platform: 'msteams', kind: 'group', conversationId: `19:${slug}`, messageId: 'root', userId: '29:model-owner', text: '/model', mentionsBot: true }) };
  const context = { meta, userIsAdmin: true };
  const connector = { platform: 'msteams', api: { sendActivity: async () => assert.fail('the picker sends no file consent') }, postCard: async payload => { sent.push(payload); return { messageId: `card-${sent.length}` }; }, updateCard: async payload => sent.push(payload) };
  const native = createTeamsControls({ connector, authorize: async () => context });
  const args = { message, sessionKey: 'group:root', entry: { slug }, meta, authorIsAdmin: true, reply: async value => replies.push(value), controls: createConversationControls() };
  const shown = () => sent.at(-1).card;
  const submit = async (verb, data = {}) => {
    const action = [...shown().actions, ...shown().body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions)].find(item => item.verb === verb);
    assert.ok(action, `the card offers ${verb}`);
    return native.onInvoke({ type: 'invoke', name: 'adaptiveCard/action', serviceUrl: 'https://smba.trafficmanager.net/teams/', from: { id: message.userId },
      conversation: { id: message.rawConversationId }, value: { action: { type: 'Action.Execute', verb, data: { ...action.data, ...data } } } });
  };
  return { native, args, slug, sent, shown, submit };
}

test('the Teams /model card has no license step with one license per harness', async () => {
  reset();
  const f = modelCardFixture({ engine: 'claude', model: 'sonnet' });
  assert.equal(await f.native.onCommand(f.args), true);
  const { body } = f.shown();
  assert.equal(row(body, 'engine').label, 'Harness');
  assert.deepEqual(values(row(body, 'engine')), ['claude', 'codex']);
  assert.equal(row(body, 'license'), undefined);
  assert.equal(row(body, 'also'), undefined);
  assert.equal(body.find(item => item.type === 'ActionSet').actions[0].title, 'Load models');
  assert.doesNotMatch(JSON.stringify(body), /Any license|If it fails/);
});

test('the Teams /model card carries the license step and saves it on the session', async () => {
  const { work, spare } = severalLicenses();
  const f = modelCardFixture({ engine: 'claude', model: 'sonnet' });
  assert.equal(await f.native.onCommand(f.args), true);
  // Claude Code has one license: no step. Loading Codex brings its licenses and models.
  assert.equal(row(f.shown().body, 'license'), undefined);
  assert.equal(f.shown().body.find(item => item.type === 'ActionSet').actions[0].title, 'Load licenses and models');
  await f.submit('model.load', { engine: 'codex' });
  let body = f.shown().body;
  assert.equal(row(body, 'engine').value, 'codex');
  assert.deepEqual(values(row(body, 'license')), ['any', 'codex', work.id, spare.id]);
  assert.equal(row(body, 'license').value, 'codex');
  assert.deepEqual(values(row(body, 'also')), [work.id, spare.id]);
  assert.equal(await getThreadEngine(f.slug, 'group:root'), '');

  // Apply with a license and the ones to move to, in the order chosen.
  const model = modelsForEngine('codex')[0].value;
  const result = await f.submit('model.save', { engine: 'codex', license: 'codex', also: `${spare.id},${work.id}`, model, effort: 'default' });
  assert.equal(result.status, 200);
  assert.equal(await getThreadEngine(f.slug, 'group:root'), 'codex');
  assert.deepEqual(await getThreadLicensePool(f.slug, 'group:root'), [spare.id, work.id]);
  assert.equal(await getThreadModel(f.slug, 'group:root'), model);
  assert.match(JSON.stringify(f.shown()), /Session harness: Codex · Default sign-in, then Spare, Work/);

  // Reopened, the card shows the stored selection; "Any license" replaces it.
  f.sent.length = 0;
  assert.equal(await f.native.onCommand(f.args), true);
  body = f.shown().body;
  assert.match(JSON.stringify(body), /Current harness: Codex · Default sign-in, then Spare, Work/);
  assert.equal(row(body, 'license').value, 'codex');
  assert.equal(row(body, 'also').value, `${spare.id},${work.id}`);
  await f.submit('model.save', { engine: 'codex', license: 'any', also: '', model, effort: 'default' });
  assert.equal(await getThreadEngine(f.slug, 'group:root'), 'codex');
  assert.equal(await getThreadLicensePool(f.slug, 'group:root'), 'any');
});
