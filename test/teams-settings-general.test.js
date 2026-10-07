import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { renderGeneral, handleGeneral, generalRuntimeScopes } = await import('../src/platforms/msteams/settings-general.js');
const { nextRuntimeTriple, runtimeSettingsPatch } = await import('../src/gateway/runtime-settings.js');
const { saveSettings } = await import('../src/config/settings.js');
const { modelsForEngine, modelBelongsToEngine } = await import('../src/engines/registry.js');
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadEngine, setThreadModel, setThreadEffort, setThreadRuntimeOverrides, setThreadClean, getThreadClean, setThreadSudo, getThreadSudo } = await import('../src/gateway/thread-engine.js');
const { getDb } = await import('../src/db/index.js');
const { saveSession } = await import('../src/gateway/sessions.js');
const { teamsSettingsUi } = await import('../src/platforms/msteams/settings.js');
const { adaptiveCardAttachment } = await import('../src/platforms/msteams/cards.js');

const ui = {
  text: text => ({ type: 'TextBlock', text }), heading: text => ({ type: 'TextBlock', text, weight: 'Bolder' }),
  choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, value, choices: choices.map(item => ({ title: item.label || item.value, value: item.value })) }),
  execute: (title, verb, data = {}, associatedInputs = 'auto') => ({ type: 'Action.Execute', title, verb, data, associatedInputs }),
  buttons: actions => ({ type: 'ActionSet', actions }),
};
let count = 0;
function context(meta = {}, options = {}) {
  const ctx = {
    entry: { slug: `teams-general-${++count}` }, meta: { access: 'approved', ...meta }, ownerId: '29:owner', channelId: 'msteams:19:conversation@thread.tacv2', sessionKey: '1234', userIsAdmin: false, userIsApproved: true, state: {},
    connector: { api: { listMembers: async () => [{ id: '29:owner', name: 'Owner' }, { id: '29:guest', name: 'Guest' }] } },
    ...options,
  };
  ctx.authorize = options.authorize || (async () => ctx);
  ctx.patch = async updater => { const fresh = await ctx.authorize(); const patch = updater(ctx.meta, fresh); ctx.meta = { ...ctx.meta, ...patch }; return ctx.meta; };
  return ctx;
}

test('runtime forms show only each scope engine models with one Apply at the end', async () => {
  saveSettings({ engine: 'claude', defaultCodexModel: 'gpt-6-sol', defaultClaudeModel: 'opus', engineEnabled: {} });
  const ctx = context({ engine: 'claude', model: 'opus' });
  await saveSession(ctx.entry.slug, ctx.sessionKey, 'codex-session', 'codex');
  const scopes = await generalRuntimeScopes(ctx);
  assert.equal(scopes.thread.engine, 'codex');
  assert.match(scopes.thread.inherited.engine, /Session default \(Codex\)/);
  assert.equal(scopes.thread.model, 'gpt-6-sol');
  const { body } = await renderGeneral(ctx, ui);
  const channelModels = body.find(row => row.id === 'channel_model').choices;
  const sessionModels = body.find(row => row.id === 'thread_model').choices;
  assert.ok(channelModels.some(item => item.value.startsWith('claude-')));
  assert.ok(!sessionModels.some(item => item.value.startsWith('claude-')));
  assert.ok(sessionModels.some(item => item.value.startsWith('gpt-')));
  assert.ok(!channelModels.some(item => item.value.startsWith('gpt-')));
  for (const [engine, choices] of [['claude', channelModels], ['codex', sessionModels]]) {
    assert.ok(choices.every(item => item.value === '__default__' || modelBelongsToEngine(item.value, engine)));
    assert.equal(choices[0].value, '__default__');
  }
  const applies = body.filter(row => row.type === 'ActionSet').flatMap(row => row.actions).filter(action => action.verb === 'settings.runtime.apply');
  assert.deepEqual(applies.map(item => item.title), ['Apply to channel', 'Apply to thread']);
  assert.equal(body.filter(row => row.type === 'ActionSet').flatMap(row => row.actions).filter(action => action.verb === 'settings.runtime').length, 0);
  for (const scope of ['channel', 'thread']) {
    const lastInput = body.findIndex(row => row.id === `${scope}_effort`);
    assert.equal(body[lastInput + 1].actions[0].data.scope, scope);
  }
});

test('loading engine models stages a scoped choice without writes, then Apply saves it', async () => {
  const ctx = context({ engine: 'claude', model: 'opus', effort: 'high' });
  await setThreadEngine(ctx.entry.slug, ctx.sessionKey, 'claude');
  const before = { ...ctx.meta };
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.models', { scope: 'channel', channel_engine: 'codex', channel_model: 'opus', channel_effort: 'high', thread_engine: 'codex' }, ctx, ui);
  const { body } = await renderGeneral(ctx, ui);
  const choice = id => body.find(row => row.id === id);
  assert.equal(choice('channel_engine').value, 'codex');
  assert.equal(choice('channel_model').value, '__default__');
  assert.ok(choice('channel_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'codex')));
  assert.ok(choice('thread_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'claude')));
  assert.deepEqual(ctx.meta, before);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'claude');
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: modelsForEngine('codex')[0].value, channel_effort: 'high' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'codex');
  assert.equal(ctx.meta.model, modelsForEngine('codex')[0].value);
  assert.equal(ctx.state.runtimeDrafts.channel, undefined);
});

test('thread model preview resolves the default to the retained session engine', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await saveSession(ctx.entry.slug, ctx.sessionKey, 'retained-codex', 'codex');
  await setThreadEngine(ctx.entry.slug, ctx.sessionKey, 'claude');
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.models', { scope: 'thread', thread_engine: '__default__', thread_model: 'opus', thread_effort: 'max' }, ctx, ui);
  const { body } = await renderGeneral(ctx, ui);
  assert.equal(body.find(row => row.id === 'thread_engine').value, '__default__');
  assert.equal(body.find(row => row.id === 'thread_model').value, '__default__');
  assert.ok(body.find(row => row.id === 'thread_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'codex')));
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'claude');
  assert.equal(ctx.meta.engine, 'claude');
});

test('channel model preview resolves its inherited engine independently of the current engine', async () => {
  saveSettings({ engine: 'claude', engineEnabled: {} });
  const ctx = context({ engine: 'codex', model: modelsForEngine('codex')[0].value, effort: 'ultra' });
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.models', { scope: 'channel', channel_engine: '__default__', channel_model: ctx.meta.model, channel_effort: 'ultra' }, ctx, ui);
  const { body } = await renderGeneral(ctx, ui);
  assert.equal(body.find(row => row.id === 'channel_engine').value, '__default__');
  assert.equal(body.find(row => row.id === 'channel_model').value, '__default__');
  assert.equal(body.find(row => row.id === 'channel_effort').value, '__default__');
  assert.ok(body.find(row => row.id === 'channel_model').choices.slice(1).every(item => modelBelongsToEngine(item.value, 'claude')));
  assert.equal(ctx.meta.engine, 'codex'); assert.equal(ctx.meta.effort, 'ultra');
});

test('model previews reject stale/disabled/locked/unauthorized forms without writes', async () => {
  const data = { scope: 'channel', channel_engine: 'codex', channel_model: '__default__', channel_effort: '__default__' };
  const stale = context({ engine: 'claude', model: 'opus' });
  await renderGeneral(stale, ui); stale.meta.model = 'sonnet';
  await assert.rejects(handleGeneral('settings.runtime.models', data, stale, ui), /settings changed/);
  assert.equal(stale.meta.model, 'sonnet');
  const disabled = context({ engine: 'claude' });
  await renderGeneral(disabled, ui); saveSettings({ engineEnabled: { codex: false } });
  try { await assert.rejects(handleGeneral('settings.runtime.models', data, disabled, ui), /no longer enabled/); }
  finally { saveSettings({ engineEnabled: {} }); }
  const locked = context({ engine: 'codex', codexAuthSource: 'channel' });
  const lockedCard = await renderGeneral(locked, ui);
  assert.ok(!JSON.stringify(lockedCard).includes('settings.runtime.models'));
  assert.ok(lockedCard.body.filter(row => row.id?.endsWith('_model')).every(row => row.choices.slice(1).every(item => modelBelongsToEngine(item.value, 'codex'))));
  await assert.rejects(handleGeneral('settings.runtime.models', data, locked, ui), /own Codex login/);
  const revoked = context({ engine: 'claude' });
  await renderGeneral(revoked, ui);
  revoked.authorize = async () => ({ ...revoked, userIsApproved: false });
  await assert.rejects(handleGeneral('settings.runtime.models', data, revoked, ui), /no longer authorized/);
  for (const ctx of [stale, disabled, locked, revoked]) assert.equal(ctx.state.runtimeDrafts, undefined);
});

test('stale model drafts are discarded and compatible full model IDs remain visible', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.models', { scope: 'channel', channel_engine: 'codex', channel_model: 'opus', channel_effort: '__default__' }, ctx, ui);
  ctx.meta.engine = 'claude'; ctx.meta.model = 'sonnet';
  const { body } = await renderGeneral(ctx, ui);
  assert.equal(body.find(row => row.id === 'channel_engine').value, 'claude');
  assert.equal(ctx.state.runtimeDrafts.channel, undefined);
  const full = context({ engine: 'claude', model: 'claude-sonnet-5-20990101' });
  const rendered = await renderGeneral(full, ui);
  assert.ok(rendered.body.find(row => row.id === 'channel_model').choices.some(item => item.value === full.meta.model));
});

test('one channel Apply saves the full valid triple and ignores other-scope inputs', async () => {
  const ctx = context({ engine: 'claude', model: 'opus', cleanMode: true });
  await setThreadEngine(ctx.entry.slug, ctx.sessionKey, 'claude');
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: 'gpt-6-sol', channel_effort: 'high', thread_engine: 'codex', access_cleanMode: 'off' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'codex'); assert.equal(ctx.meta.model, 'gpt-6-sol'); assert.equal(ctx.meta.effort, 'high');
  assert.equal(ctx.meta.cleanMode, true); assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'claude');
});

test('one thread Apply saves its triple while channel and thread posture remain unchanged', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await setThreadClean(ctx.entry.slug, ctx.sessionKey, true); await setThreadSudo(ctx.entry.slug, ctx.sessionKey, true);
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: 'codex', thread_model: 'gpt-6-sol', thread_effort: 'high', channel_engine: 'codex' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'codex');
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'gpt-6-sol');
  assert.equal(await getThreadEffort(ctx.entry.slug, ctx.sessionKey), 'high');
  assert.equal(ctx.meta.engine, 'claude'); assert.equal(await getThreadClean(ctx.entry.slug, ctx.sessionKey), true); assert.equal(await getThreadSudo(ctx.entry.slug, ctx.sessionKey), true);
});

test('combined Apply rejects incomplete/incompatible/disabled selections before writing', async () => {
  const ctx = context({ engine: 'claude', model: 'opus', effort: 'high' });
  await renderGeneral(ctx, ui);
  const before = { ...ctx.meta };
  for (const form of [
    { channel_engine: 'codex', channel_model: 'opus', channel_effort: 'high' },
    { channel_engine: 'claude', channel_model: 'opus', channel_effort: 'ultra' },
    { channel_engine: 'codex', channel_model: 'gpt-6-sol' },
  ]) {
    await assert.rejects(handleGeneral('settings.runtime.apply', { scope: 'channel', ...form }, ctx, ui));
    assert.deepEqual(ctx.meta, before);
  }
  saveSettings({ engineEnabled: { codex: false } });
  await assert.rejects(handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: 'gpt-6-sol', channel_effort: 'high' }, ctx, ui), /no longer enabled/);
  assert.deepEqual(ctx.meta, before); saveSettings({ engineEnabled: {} });
});

test('combined Apply refuses stale channel/thread forms without overwriting newer values', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await renderGeneral(ctx, ui);
  ctx.meta.model = 'sonnet';
  await assert.rejects(handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: 'gpt-6-sol', channel_effort: 'high' }, ctx, ui), /settings changed/);
  assert.equal(ctx.meta.model, 'sonnet'); assert.equal(ctx.meta.engine, 'claude');
  await setThreadModel(ctx.entry.slug, ctx.sessionKey, 'sonnet');
  await assert.rejects(handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: 'codex', thread_model: 'gpt-6-sol', thread_effort: 'high' }, ctx, ui), /settings changed/);
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'sonnet'); assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
});
test('combined Apply rechecks revoked authority before any scope write', async () => {
  for (const scope of ['channel', 'thread']) {
    const ctx = context({ engine: 'claude', model: 'opus' });
    await renderGeneral(ctx, ui);
    ctx.authorize = async () => ({ ...ctx, userIsAdmin: false, userIsApproved: false });
    await assert.rejects(handleGeneral('settings.runtime.apply', { scope, [`${scope}_engine`]: 'codex', [`${scope}_model`]: 'gpt-6-sol', [`${scope}_effort`]: 'high' }, ctx, ui), /no longer authorized/);
    assert.equal(ctx.meta.engine, 'claude'); assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
  }
});

test('combined defaults use retained session engine and dedicated channel login locks', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await saveSession(ctx.entry.slug, ctx.sessionKey, 'retained-codex', 'codex');
  await renderGeneral(ctx, ui);
  await handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: '__default__', thread_model: 'gpt-6-sol', thread_effort: 'high' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'gpt-6-sol');
  const locked = context({ codexAuthSource: 'channel', engine: 'codex' });
  await renderGeneral(locked, ui);
  await assert.rejects(handleGeneral('settings.runtime.apply', { scope: 'channel', channel_engine: 'claude', channel_model: 'opus', channel_effort: 'high' }, locked, ui), /own Codex login/);
  await handleGeneral('settings.runtime.apply', { scope: 'channel', channel_model: 'gpt-6-sol', channel_effort: 'high' }, locked, ui);
  assert.equal(locked.meta.engine, 'codex'); assert.equal(locked.meta.model, 'gpt-6-sol');
});
test('default-engine Apply re-resolves a session minted during the final membership check', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await saveSession(ctx.entry.slug, ctx.sessionKey, 'before-check', 'claude');
  await renderGeneral(ctx, ui);
  let checks = 0;
  ctx.authorize = async () => {
    if (++checks === 2) await saveSession(ctx.entry.slug, ctx.sessionKey, 'during-check', 'codex');
    return ctx;
  };
  await handleGeneral('settings.runtime.apply', { scope: 'thread', thread_engine: '__default__', thread_model: 'gpt-6-sol', thread_effort: 'high' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'gpt-6-sol');
});

test('thread triple storage rolls back all fields on failure and checks its expected snapshot', async () => {
  const ctx = context(); const db = getDb();
  setThreadRuntimeOverrides(ctx.entry.slug, ctx.sessionKey, { engine: 'claude', model: 'opus', effort: 'high' });
  db.exec("CREATE TEMP TRIGGER reject_runtime_effort BEFORE INSERT ON thread_overrides WHEN NEW.kind = 'effort' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try {
    assert.throws(() => setThreadRuntimeOverrides(ctx.entry.slug, ctx.sessionKey, { engine: 'codex', model: 'gpt-6-sol', effort: 'low' }), /test failure/);
  } finally { db.exec('DROP TRIGGER reject_runtime_effort'); }
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'claude'); assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'opus'); assert.equal(await getThreadEffort(ctx.entry.slug, ctx.sessionKey), 'high');
  assert.throws(() => setThreadRuntimeOverrides(ctx.entry.slug, ctx.sessionKey, { engine: 'codex' }, { expected: { engine: '', model: '', effort: '' } }), /Thread settings changed/);
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), 'opus');
});

test('authorized user can edit Settings runtime independently of text model command policy', async () => {
  saveSettings({ modelChangeAccess: 'admins', engineEnabled: {} });
  const ctx = context({ engine: 'claude', model: 'opus', effort: 'high', cleanMode: true });
  await handleGeneral('settings.runtime', { scope: 'channel', field: 'engine', channel_engine: 'codex', channel_model: 'FORGED-NEIGHBOUR' }, ctx, ui);
  assert.equal(ctx.meta.engine, 'codex');
  assert.equal(ctx.meta.model, '');
  assert.equal(ctx.meta.effort, 'high');
  assert.equal(ctx.meta.cleanMode, true);
});

test('disabled engines and forged incompatible model/effort fields are rejected without effects', async () => {
  const ctx = context({ engine: 'claude', model: 'opus' });
  await assert.rejects(handleGeneral('settings.runtime', { scope: 'channel', field: 'model', channel_model: 'gpt-6-sol' }, ctx, ui), /model does not belong/);
  assert.equal(ctx.meta.model, 'opus');
  await assert.rejects(handleGeneral('settings.runtime', { scope: 'channel', field: 'effort', channel_effort: 'ultra' }, ctx, ui), /effort is not supported/);
  saveSettings({ engineEnabled: { codex: false } });
  await assert.rejects(handleGeneral('settings.runtime', { scope: 'channel', field: 'engine', channel_engine: 'codex' }, ctx, ui), /no longer enabled/);
  assert.equal(ctx.meta.engine, 'claude');
  saveSettings({ engineEnabled: {} });
});

test('thread engine change removes incompatible dependents and reset never changes channel', async () => {
  const ctx = context({ engine: 'codex', model: 'gpt-6-sol' });
  await Promise.all([setThreadEngine(ctx.entry.slug, ctx.sessionKey, 'codex'), setThreadModel(ctx.entry.slug, ctx.sessionKey, 'gpt-6-sol'), setThreadEffort(ctx.entry.slug, ctx.sessionKey, 'ultra')]);
  await handleGeneral('settings.runtime', { scope: 'thread', field: 'engine', thread_engine: 'claude' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), 'claude');
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), '');
  assert.equal(await getThreadEffort(ctx.entry.slug, ctx.sessionKey), '');
  await handleGeneral('settings.thread.reset', {}, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
  assert.equal(ctx.meta.engine, 'codex');
  await assert.rejects(handleGeneral('settings.thread.reset', {}, context({}, { sessionKey: '' }), ui), /Open Settings/);
});

test('clearing a thread engine validates dependents against its unpinned fallback', async () => {
  const ctx = context({ engine: 'claude' });
  await Promise.all([setThreadEngine(ctx.entry.slug, ctx.sessionKey, 'codex'), setThreadModel(ctx.entry.slug, ctx.sessionKey, 'gpt-6-sol')]);
  const scopes = await generalRuntimeScopes(ctx);
  assert.match(scopes.thread.inherited.engine, /Follow channel \(Claude\)/);
  await handleGeneral('settings.runtime', { scope: 'thread', field: 'engine', thread_engine: '__default__' }, ctx, ui);
  assert.equal(await getThreadEngine(ctx.entry.slug, ctx.sessionKey), '');
  assert.equal(await getThreadModel(ctx.entry.slug, ctx.sessionKey), '');
});

test('channel login locks both engine selectors and rejects forged changes', async () => {
  const ctx = context({ engine: 'claude', codexAuthSource: 'channel' });
  const { body } = await renderGeneral(ctx, ui);
  assert.ok(!body.some(row => row.id === 'channel_engine' || row.id === 'thread_engine'));
  for (const scope of ['channel', 'thread']) await assert.rejects(handleGeneral('settings.runtime', { scope, field: 'engine', [`${scope}_engine`]: 'claude' }, ctx, ui), /own Codex login/);
});

test('manager authority is rechecked against latest metadata and fresh roles at mutation', async () => {
  const ctx = context({ manageAccess: 'custom', managers: ['29:owner'] });
  ctx.patch = async updater => updater({ ...ctx.meta, managers: [] }, ctx);
  await assert.rejects(handleGeneral('settings.access', { field: 'autoMode', access_autoMode: 'on' }, ctx, ui), /current channel managers/);
  const demoted = context({ manageAccess: 'admins' }, { userIsAdmin: true });
  demoted.authorize = async () => ({ ...demoted, userIsAdmin: false });
  await assert.rejects(handleGeneral('settings.access', { field: 'mode', access_mode: 'admin' }, demoted, ui), /current channel managers/);
});

test('named guest/managers use fresh native roster ids and reject outsiders and forgery', async () => {
  const ctx = context({ manageAccess: 'members' });
  await handleGeneral('settings.access', { field: 'allowedUsers', access_allowedUsers: '29:guest' }, ctx, ui);
  assert.deepEqual(ctx.meta.allowedUsers, ['29:guest']);
  await assert.rejects(handleGeneral('settings.access', { field: 'managers', access_managers: '29:outsider', channelId: 'OTHER' }, ctx, ui), /current conversation members/);
  assert.equal(ctx.meta.managers, undefined);
  ctx.connector.api.listMembers = async () => [];
  await assert.rejects(handleGeneral('settings.access', { field: 'allowedUsers', access_allowedUsers: '29:guest' }, ctx, ui), /current conversation members/);
  assert.deepEqual(ctx.meta.allowedUsers, ['29:guest']);
});

test('mode flags preserve independent values and cannot forge privileged DM controls', async () => {
  const ctx = context({ manageAccess: 'members', cleanMode: true, allowBash: false });
  await handleGeneral('settings.access', { field: 'autoMode', access_autoMode: 'on', access_cleanMode: 'off' }, ctx, ui);
  assert.equal(ctx.meta.allowBash, true); assert.equal(ctx.meta.cleanMode, true);
  await handleGeneral('settings.access', { field: 'mode', access_mode: 'read' }, ctx, ui);
  assert.equal(ctx.meta.autoMode, false); assert.equal(ctx.meta.cleanMode, true);
  const dm = context({ isDM: true, template: 'custom' });
  await assert.rejects(handleGeneral('settings.access', { field: 'mode', access_mode: 'admin' }, dm, ui), /Only administrators/);
  await assert.rejects(handleGeneral('settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }, dm, ui), /DM template/);
});

test('render never includes secrets and nonmanagers see policy readouts', async () => {
  const ctx = context({ env: { NEVER: { value: 'private-secret-value' } }, composioToken: 'private-secret-value', allowNetwork: false });
  const rendered = await renderGeneral(ctx, ui);
  assert.ok(!rendered.body.some(row => row.id?.startsWith('access_')));
  assert.match(JSON.stringify(rendered), /network off/);
  assert.doesNotMatch(JSON.stringify(rendered), /private-secret-value/);
  assert.equal(await handleGeneral('settings.unrelated', {}, ctx, ui), false);
});

test('large rosters explicitly defer named lists rather than dropping saved choices', async () => {
  const ctx = context({ manageAccess: 'members', allowedUsers: ['29:owner'] });
  ctx.connector.api.listMembers = async () => Array.from({ length: 60 }, (_, index) => ({ id: `29:${index}`, name: `Member ${index}` }));
  const rendered = await renderGeneral(ctx, ui);
  assert.ok(!rendered.body.some(row => row.id === 'access_allowedUsers' || row.id === 'access_managers'));
  assert.match(JSON.stringify(rendered), /60 members; edit the complete list/);
  assert.deepEqual(ctx.meta.allowedUsers, ['29:owner']);
  assert.ok(Buffer.byteLength(JSON.stringify(rendered)) < 24_000);
});

test('worst-case native member IDs and selected names fit Teams attachment budget', async () => {
  const members = Array.from({ length: 25 }, (_, index) => ({ id: `29:${String(index).padStart(3, '0')}${'x'.repeat(250)}`, name: 'x'.repeat(80) }));
  const ctx = context({ manageAccess: 'members', engine: 'codex', allowedUsers: members.map(member => member.id), managers: members.map(member => member.id) });
  ctx.connector.api.listMembers = async () => members;
  const { body, actions } = await renderGeneral(ctx, teamsSettingsUi('60b36ffa-8a37-4e3a-965f-723047ef362f'));
  const card = { type: 'AdaptiveCard', version: '1.4', body, actions };
  const attachment = adaptiveCardAttachment(card);
  assert.ok(Buffer.byteLength(JSON.stringify(attachment)) < 24_000);
  assert.match(JSON.stringify(body), /complete member selectors are too large/);
  assert.ok(!body.some(row => row.id === 'access_allowedUsers' || row.id === 'access_managers'));
  assert.deepEqual(ctx.meta.allowedUsers, members.map(member => member.id));
});

test('shared helpers validate runtime triples while clearing only incompatible dependencies', () => {
  assert.deepEqual(nextRuntimeTriple({ engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' }, 'engine', 'claude', 'claude'), { engine: 'claude', model: '', effort: '' });
  assert.throws(() => runtimeSettingsPatch({ engine: 'unknown' }), /no longer enabled/);
  assert.throws(() => nextRuntimeTriple({}, 'unknown', '', 'claude'), /Unknown runtime/);
});
