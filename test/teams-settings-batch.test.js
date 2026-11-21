// Teams settings window: pending changes per section, one Save area (Apply to channel / Apply to
// thread / Discard), validated whole-section Apply, and the compact full-width layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, patchChannelMeta, setUser } = await import('../src/config/store.js');
const { addSchedule, listForChannel, updateSchedule } = await import('../src/config/schedules.js');
const { getThreadSettings, setThreadSettings } = await import('../src/gateway/thread-settings.js');
const { getThreadEngine } = await import('../src/gateway/thread-engine.js');
const { putSkillRevision } = await import('../src/gateway/skills/catalog.js');
const { adaptiveCardAttachment } = await import('../src/platforms/msteams/cards.js');
const { modelsForEngine } = await import('../src/engines/registry.js');
const { getDb } = await import('../src/db/index.js');

const SESSION = 'original-session';
const SECRET_A = 'batch-secret-value-aaaa-0001';
const SECRET_B = 'batch-secret-value-bbbb-0002';
const TOKEN = 'batch-composio-token-0003';
let sequence = 0;
const nodes = item => !item || typeof item !== 'object' ? [] : [item, ...Object.values(item).flatMap(nodes)];
const input = (card, id) => nodes(card.body).find(item => item.id === id);
const actions = card => nodes(card.body).filter(item => typeof item.type === 'string' && item.type.startsWith('Action.'));
const action = (card, verb, match = {}) => actions(card).find(item => item.data?.cgAction === verb && Object.entries(match).every(([key, value]) => item.data[key] === value));
const texts = card => nodes(card.body).filter(item => item.type === 'TextBlock').map(item => item.text).join('\n');
const value = result => result.body.task?.type === 'continue' ? result.body.task.value.card.content : result.body.task?.value || result.body.value;
const failed = card => typeof card === 'string' && /^Action could not be completed/.test(card);
// A refused batch re-renders the card with a value-free reason; nothing is written.
const notSaved = card => { assert.equal(typeof card, 'object', 'a refusal still renders the card'); const text = texts(card); assert.match(text, /Not saved: [^\n]*Nothing was written\./); return text; };

async function fixture({ admin = true, manageAccess = 'admins' } = {}) {
  const suffix = ++sequence, channelId = `teams:19:batch-${suffix}@thread.v2`, owner = `29:batch-${suffix}`;
  const entry = await upsertChannelEntry(channelId, { name: `Batch ${suffix}`, platform: 'msteams', type: 'mpim' });
  const meta = { channelId, isDM: false, platform: 'msteams', engine: 'claude', access: 'approved', manageAccess, allowBash: true, allowNetwork: false };
  await saveChannelMeta(entry.slug, meta); await setUser(owner, { approved: true, isAdmin: admin });
  const sent = [];
  const connector = { botId: '28:bot', api: { sendActivity: async () => ({ messageId: 'file-consent' }), listMembers: async () => [{ id: owner, name: 'Batch owner' }, { id: '29:peer', name: 'Peer' }] },
    postCard: async payload => { sent.push(payload); return { messageId: 'card1' }; }, updateCard: async () => {}, openDm: async () => '' };
  const controls = createTeamsControls({ connector, publicUrl: () => 'https://gateway.example' });
  await controls.onCommand({ message: { text: '/settings', trigger: 'message', conversationId: channelId, rawConversationId: channelId.slice(6), userId: owner, isDM: false, threadKey: 'root' },
    entry, meta, sessionKey: SESSION, authorIsAdmin: admin, reply: async () => {} });
  const invoke = async (data, verb) => value(await controls.onInvoke({ type: 'invoke', name: verb === 'settings.open' ? 'task/fetch' : 'task/submit', from: { id: owner },
    conversation: { id: channelId.slice(6) }, replyToId: 'card1', serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { data: { ...data, cgAction: verb } } }));
  const menu = await invoke({ stateId: sent[0].card.actions[0].data.stateId }, 'settings.open');
  const stateId = actions(menu)[0].data.stateId;
  const go = page => invoke({ stateId, page }, 'settings.page');
  const run = (verb, data = {}) => invoke({ stateId, ...data }, verb);
  return { controls, entry, owner, channelId, menu, stateId, go, run, invoke };
}
const channelEnv = async f => (await getChannelMeta(f.entry.slug)).env || {};

test('every editable section ends with one Save area; Resume stays read-only; Teams limits hold', async () => {
  const f = await fixture();
  for (const page of ['general', 'secrets', 'mcp', 'skills', 'automations', 'resume']) {
    const card = await f.go(page);
    adaptiveCardAttachment(card);
    assert.equal(card.version, '1.4');
    assert.deepEqual(card.msteams, { width: 'Full' });
    assert.deepEqual(card.actions, []);
    assert.ok(nodes(card).filter(item => item.type === 'ActionSet').every(set => set.actions.length <= 6), page);
    const save = card.body.at(-1);
    if (page === 'resume') {
      assert.equal(actions(card).filter(item => /apply/.test(item.data?.cgAction || '')).length, 0, 'Resume has no Apply');
      continue;
    }
    assert.equal(save.type, 'Container');
    assert.match(save.items[0].text, /^Save /);
    const titles = save.items.at(-1).actions.map(item => item.title);
    assert.deepEqual(titles.slice(0, 2), ['Apply to channel', 'Apply to thread'], page);
    assert.ok(titles.includes('Discard changes'), page);
    // Only the Save area applies.
    assert.equal(actions(card).filter(item => ['settings.draft.apply', 'settings.runtime.apply', 'settings.automation.apply'].includes(item.data?.cgAction)).length, 2, page);
  }
});

test('variables stage across navigation, never echo a value, and save only the chosen scope', async () => {
  const f = await fixture();
  await patchChannelMeta(f.entry.slug, { env: { GITHUB_TOKEN: { provider: 'local', value: 'ghp_channel_batch_value_000000000001', setAt: 5 } } });
  let card = await f.go('secrets');
  assert.equal(input(card, 'variableValue').value, '');
  assert.equal(input(card, 'variableValue').style, 'password');
  card = await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'github_token', variableValue: SECRET_A, variableHostsMode: 'preserve' });
  card = await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'ACME_TOKEN', variableValue: SECRET_B, variableHostsMode: 'replace', variableHosts: 'api.acme.example' });
  assert.match(texts(card), /Pending changes \(2\)/);
  assert.match(texts(card), /Set GITHUB_TOKEN \(new value hidden\)/);
  assert.ok(!JSON.stringify(card).includes(SECRET_A) && !JSON.stringify(card).includes(SECRET_B));
  // Other sections show the draft is pending; coming back keeps it.
  const skills = await f.go('skills');
  assert.match(texts(skills), /Pending, not saved yet: Variables \(2\)/);
  assert.ok(actions(skills).some(item => item.title === 'Variables (2)'));
  card = await f.go('secrets');
  assert.match(texts(card), /Pending changes \(2\)/);
  assert.equal((await channelEnv(f)).GITHUB_TOKEN.value, 'ghp_channel_batch_value_000000000001', 'staging writes nothing');
  // Apply to thread: only the thread store changes.
  card = await f.run('settings.draft.apply', { page: 'secrets', scope: 'thread' });
  assert.match(texts(card), /2 Variables changes saved to this thread/);
  const thread = getThreadSettings(f.entry.slug, SESSION, 'secrets');
  assert.deepEqual(Object.keys(thread.env).sort(), ['ACME_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(thread.env.GITHUB_TOKEN.value, SECRET_A);
  assert.deepEqual(thread.env.ACME_TOKEN.hosts, ['api.acme.example']);
  assert.deepEqual(Object.keys(await channelEnv(f)), ['GITHUB_TOKEN']);
  assert.equal((await channelEnv(f)).GITHUB_TOKEN.value, 'ghp_channel_batch_value_000000000001');
  assert.deepEqual(getThreadSettings(f.entry.slug, 'another-session', 'secrets'), {}, 'a sibling thread is untouched');
  assert.match(texts(card), /This thread · GITHUB_TOKEN · ••••0001/);
  // The same intent applied to the channel writes only the channel.
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'ACME_TOKEN', variableValue: SECRET_B, variableHostsMode: 'replace', variableHosts: 'api.acme.example' });
  await f.run('settings.draft.apply', { page: 'secrets', scope: 'channel' });
  assert.equal((await channelEnv(f)).ACME_TOKEN.value, SECRET_B);
  assert.equal(getThreadSettings(f.entry.slug, SESSION, 'secrets').env.ACME_TOKEN.value, SECRET_B, 'the thread row is its own');
  const logs = JSON.stringify(getDb().prepare('SELECT * FROM events').all());
  assert.match(logs, /settings_batch_applied/);
  assert.ok(!logs.includes(SECRET_A) && !logs.includes(SECRET_B), 'no value in any log row');
});

test('a thread batch with one value lacking a fixed destination saves nothing', async () => {
  const f = await fixture();
  await f.go('secrets');
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'GITHUB_TOKEN', variableValue: SECRET_A });
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'DB_PASSWORD', variableValue: SECRET_B });
  const refused = await f.run('settings.draft.apply', { page: 'secrets', scope: 'thread' });
  assert.match(notSaved(refused), /DB_PASSWORD needs a fixed destination/);
  assert.ok(!JSON.stringify(refused).includes(SECRET_B) && !JSON.stringify(refused).includes(SECRET_A));
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'secrets'), {});
  // The channel accepts a readable password, as it always has.
  await f.run('settings.draft.apply', { page: 'secrets', scope: 'channel' });
  assert.equal((await channelEnv(f)).DB_PASSWORD.value, SECRET_B);
});

test('Apply saves only the open section; Discard drops only its own drafts', async () => {
  const f = await fixture();
  putSkillRevision({ slug: 'batch-shared-skill', files: [{ path: 'SKILL.md', content: '---\nname: batch-shared-skill\ndescription: Shared\n---\nDo it.\n' }] });
  await f.go('skills');
  await f.run('settings.draft.skill', { key: 'batch-shared-skill', activate: true });
  await f.go('secrets');
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'GITHUB_TOKEN', variableValue: SECRET_A });
  await f.run('settings.draft.apply', { page: 'secrets', scope: 'thread' });
  assert.ok(getThreadSettings(f.entry.slug, SESSION, 'secrets').env.GITHUB_TOKEN);
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'skills'), {}, 'the Skills draft is still only pending');
  let skills = await f.go('skills');
  assert.match(texts(skills), /Activate skill batch-shared-skill/);
  await f.go('secrets');
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'OTHER_TOKEN', variableValue: SECRET_B, variableHostsMode: 'replace', variableHosts: 'api.other.example' });
  await f.run('settings.draft.discard', { page: 'secrets' });
  skills = await f.go('skills');
  assert.match(texts(skills), /Activate skill batch-shared-skill/, 'discarding Variables kept Skills');
  await f.run('settings.draft.apply', { page: 'skills', scope: 'thread' });
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'skills').skills, ['batch-shared-skill']);
  assert.ok(!((await getChannelMeta(f.entry.slug)).skills || []).includes('batch-shared-skill'), 'the channel grant tier is unchanged');
});

test('stale drafts are refused without overwriting the concurrent change', async () => {
  const f = await fixture();
  await f.go('secrets');
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'GITHUB_TOKEN', variableValue: SECRET_A });
  setThreadSettings(f.entry.slug, SESSION, 'secrets', { env: { OTHER_TOKEN: { provider: 'local', value: SECRET_B, hosts: ['api.other.example'] } } });
  await patchChannelMeta(f.entry.slug, { env: { NEWER_TOKEN: { provider: 'local', value: 'newer-channel-value-0001', hosts: ['api.newer.example'] } } });
  for (const scope of ['thread', 'channel']) assert.match(notSaved(await f.run('settings.draft.apply', { page: 'secrets', scope })), /changed while you were editing/);
  assert.deepEqual(Object.keys(getThreadSettings(f.entry.slug, SESSION, 'secrets').env), ['OTHER_TOKEN']);
  assert.deepEqual(Object.keys(await channelEnv(f)), ['NEWER_TOKEN']);
  await f.run('settings.draft.discard', { page: 'secrets' });
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'GITHUB_TOKEN', variableValue: SECRET_A });
  await f.run('settings.draft.apply', { page: 'secrets', scope: 'thread' });
  assert.deepEqual(Object.keys(getThreadSettings(f.entry.slug, SESSION, 'secrets').env).sort(), ['GITHUB_TOKEN', 'OTHER_TOKEN']);
});

test('revoked access refuses Apply before any write', async () => {
  const f = await fixture({ admin: false });
  await f.go('secrets');
  await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'GITHUB_TOKEN', variableValue: SECRET_A });
  await setUser(f.owner, { approved: false, isAdmin: false });
  for (const scope of ['thread', 'channel']) assert.ok(failed(await f.run('settings.draft.apply', { page: 'secrets', scope })));
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'secrets'), {});
  assert.deepEqual(await channelEnv(f), {});
});

test('MCP connection overrides go to the thread masked, and invalid batches save nothing', async () => {
  const f = await fixture({ admin: false });
  await patchChannelMeta(f.entry.slug, { composioToken: 'channel-composio-token-0001', makeToolboxUrl: 'https://eu1.make.com/mcp/server/channel', makeToolboxKey: 'channel-make-key-0001' });
  let card = await f.go('mcp');
  for (const id of ['composioToken', 'makeToolboxKey']) assert.equal(input(card, id).value, '');
  card = await f.run('settings.draft.connections', { composioToken: TOKEN, composioTokenLabel: 'Thread account' });
  assert.ok(!JSON.stringify(card).includes(TOKEN));
  await f.run('settings.draft.disconnect', { connection: 'make' });
  card = await f.run('settings.draft.apply', { page: 'mcp', scope: 'thread' });
  assert.ok(!JSON.stringify(card).includes(TOKEN));
  assert.match(texts(card), /This thread — Composio: Own account \(Thread account\) · Make MCP: Disconnected in this thread/);
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'mcp'), { composioToken: TOKEN, composioTokenLabel: 'Thread account', makeToolboxUrl: '', makeToolboxKey: '' });
  const channel = await getChannelMeta(f.entry.slug);
  assert.equal(channel.composioToken, 'channel-composio-token-0001');
  assert.equal(channel.makeToolboxKey, 'channel-make-key-0001');
  // A Make URL with neither its own token nor the channel's saves none of the batch.
  await f.run('settings.draft.connections', { composioToken: 'replacement-token-0002', makeToolboxUrl: 'https://eu1.make.com/mcp/server/thread' });
  const refused = await f.run('settings.draft.apply', { page: 'mcp', scope: 'thread' });
  notSaved(refused);
  assert.ok(!JSON.stringify(refused).includes('replacement-token-0002'));
  assert.equal(getThreadSettings(f.entry.slug, SESSION, 'mcp').composioToken, TOKEN);
  // Cloud MCP stays administrator-only.
  assert.match(notSaved(await f.run('settings.draft.cloud', { engine: 'claude', key: 'anything', activate: true })), /Only administrators/);
});

test('Follow channel clears only this thread section on Apply to thread', async () => {
  const f = await fixture();
  setThreadSettings(f.entry.slug, SESSION, 'secrets', { env: { GITHUB_TOKEN: { provider: 'local', value: SECRET_A } } });
  setThreadSettings(f.entry.slug, SESSION, 'mcp', { composioToken: TOKEN });
  await f.go('secrets');
  await f.run('settings.draft.follow', { page: 'secrets' });
  assert.match(notSaved(await f.run('settings.draft.variable', { variableScope: 'pending', variableName: 'X_TOKEN', variableValue: SECRET_B })), /Following the channel is pending/);
  assert.match(notSaved(await f.run('settings.draft.apply', { page: 'secrets', scope: 'channel' })), /applies to a thread/);
  await f.run('settings.draft.apply', { page: 'secrets', scope: 'thread' });
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'secrets'), {});
  assert.equal(getThreadSettings(f.entry.slug, SESSION, 'mcp').composioToken, TOKEN, 'other sections keep their overrides');
});

test('a thread can only add shared skills; channel skills and personal skills are refused there', async () => {
  const f = await fixture();
  putSkillRevision({ slug: 'batch-channel-skill', files: [{ path: 'SKILL.md', content: '---\nname: batch-channel-skill\ndescription: Channel\n---\nDo it.\n' }] });
  putSkillRevision({ slug: 'batch-personal-skill', files: [{ path: 'SKILL.md', content: '---\nname: batch-personal-skill\ndescription: Mine\n---\nDo it.\n' }], visibility: 'personal', createdBy: f.owner });
  await patchChannelMeta(f.entry.slug, { skills: ['batch-channel-skill'] });
  const card = await f.go('skills');
  assert.ok(!texts(card).includes('batch-personal-skill'), 'a personal skill is never offered');
  notSaved(await f.run('settings.draft.skill', { key: 'batch-personal-skill', activate: true }));
  await f.run('settings.draft.skill', { key: 'batch-channel-skill', activate: false });
  assert.match(notSaved(await f.run('settings.draft.apply', { page: 'skills', scope: 'thread' })), /only remove skills it added/);
  assert.deepEqual(getThreadSettings(f.entry.slug, SESSION, 'skills'), {});
  await f.run('settings.draft.apply', { page: 'skills', scope: 'channel' });
  assert.ok(!((await getChannelMeta(f.entry.slug)).skills || []).includes('batch-channel-skill'));
});

test('General: Apply to channel saves runtime and access together; Apply to thread refuses access edits', async () => {
  const f = await fixture();
  const model = modelsForEngine('codex')[0].value;
  let card = await f.go('general');
  assert.equal(actions(card).filter(item => item.data?.cgAction === 'settings.access').length, 0, 'no per-field access Apply buttons');
  const refused = await f.run('settings.runtime.apply', { scope: 'thread', thread_engine: 'claude', access_allowNetwork: 'on' });
  assert.match(notSaved(refused), /Access settings apply to the whole conversation/);
  assert.equal(await getThreadEngine(f.entry.slug, SESSION), '');
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  card = await f.go('general');
  await f.run('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: model, channel_effort: '__default__', access_allowNetwork: 'on', access_autoMode: 'on' });
  const meta = await getChannelMeta(f.entry.slug);
  assert.equal(meta.engine, 'codex');
  assert.equal(meta.allowNetwork, true);
  assert.equal(meta.autoMode, true);
});

test('General: a non-manager cannot change access and the runtime half is not saved either', async () => {
  const f = await fixture({ admin: false, manageAccess: 'admins' });
  await f.go('general');
  // The access controls are not on a non-manager's card, so a forged one is refused outright.
  const refused = await f.run('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: modelsForEngine('codex')[0].value, channel_effort: '__default__', access_access: 'none' });
  assert.match(notSaved(refused), /not on this card/);
  const meta = await getChannelMeta(f.entry.slug);
  assert.equal(meta.engine, 'claude');
  assert.equal(meta.access, 'approved');
});

test('General edits stay pending across navigation and a concurrent change discards them', async () => {
  const f = await fixture();
  await f.go('general');
  // Leaving General carries its inputs: the changed access choice is kept as a draft.
  await f.invoke({ stateId: f.stateId, page: 'skills', access_allowNetwork: 'on', access_mode: 'worker' }, 'settings.page');
  let card = await f.go('general');
  assert.equal(input(card, 'access_allowNetwork').value, 'on');
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false, 'nothing saved yet');
  await f.run('settings.general.discard');
  card = await f.go('general');
  assert.equal(input(card, 'access_allowNetwork').value, 'off');
  await f.invoke({ stateId: f.stateId, page: 'skills', access_allowNetwork: 'on' }, 'settings.page');
  await patchChannelMeta(f.entry.slug, { allowNetwork: true });
  card = await f.go('general');
  assert.match(texts(card), /changed meanwhile, so your pending General changes were discarded/);
});

test('automations stage a batch; thread Apply changes only loops running in this exact thread', async () => {
  const f = await fixture();
  const channelTask = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'Channel task', description: 'Channel task', cron: '0 * * * *', createdBy: f.owner });
  const loop = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'Thread loop', description: 'Thread loop', cron: '*/5 * * * *', createdBy: f.owner, loop: true, threadTs: SESSION, resumeThread: true });
  const otherLoop = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'Other loop', description: 'Other loop', cron: '*/5 * * * *', createdBy: f.owner, loop: true, threadTs: 'other-session', resumeThread: true });
  await f.go('automations');
  await f.run('settings.automation.toggle', { id: channelTask.id, enabled: false });
  await f.run('settings.automation.delete', { id: loop.id });
  assert.equal(listForChannel(f.channelId).length, 3, 'staging writes nothing');
  assert.match(notSaved(await f.run('settings.automation.apply', { scope: 'thread' })), /runs in the channel, not in this thread/);
  assert.equal(listForChannel(f.channelId).length, 3);
  assert.equal(listForChannel(f.channelId).find(row => row.id === channelTask.id).enabled, true, 'the refused batch wrote nothing');
  await f.run('settings.automation.undo', { id: channelTask.id });
  await f.run('settings.automation.apply', { scope: 'thread' });
  assert.deepEqual(listForChannel(f.channelId).map(row => row.id).sort(), [channelTask.id, otherLoop.id].sort());
  await f.run('settings.automation.delete', { id: otherLoop.id });
  assert.match(notSaved(await f.run('settings.automation.apply', { scope: 'thread' })), /runs in the channel/);
  // A row changed after staging rejects the whole batch.
  await f.run('settings.automation.toggle', { id: channelTask.id, enabled: false });
  updateSchedule(channelTask.id, { cron: '30 * * * *' });
  assert.match(notSaved(await f.run('settings.automation.apply', { scope: 'channel' })), /changed or was removed/);
  assert.equal(listForChannel(f.channelId).length, 2);
  await f.run('settings.automation.discard');
  await f.run('settings.automation.toggle', { id: channelTask.id, enabled: false });
  await f.run('settings.automation.apply', { scope: 'channel' });
  assert.equal(listForChannel(f.channelId).find(row => row.id === channelTask.id).enabled, false);
});

test('General: a manager demoted after the card rendered saves neither access nor runtime', async () => {
  const f = await fixture({ admin: true, manageAccess: 'admins' });
  await f.go('general');
  await setUser(f.owner, { approved: true, isAdmin: false });
  const refused = await f.run('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: modelsForEngine('codex')[0].value, channel_effort: '__default__', access_allowNetwork: 'on' });
  assert.match(notSaved(refused), /Only admins and current channel managers/);
  const meta = await getChannelMeta(f.entry.slug);
  assert.equal(meta.engine, 'claude');
  assert.equal(meta.allowNetwork, false);
});
