import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { buildGoogleChatSettings, handleGoogleChatSettings } = await import('../src/platforms/googlechat/settings.js');
const { chatText, chatAction, chatCard, validateChatCard, MAX_CHAT_CARD_BYTES } = await import('../src/platforms/googlechat/cards.js');
const { googleChatWorkspaceContext } = await import('../src/platforms/googlechat/workspace-access.js');
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, patchChannelMeta, setUser } = await import('../src/config/store.js');
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadRuntimeOverrides } = await import('../src/gateway/thread-engine.js');
const { modelsForEngine } = await import('../src/engines/registry.js');
const { addSchedule, listForChannel } = await import('../src/config/schedules.js');
const { getDb } = await import('../src/db/index.js');
let sequence = 0;
const widgets = card => card.sections.flatMap(section => section.widgets);
const actions = card => widgets(card).flatMap(widget => widget.buttonList?.buttons || []).filter(button => button.onClick?.action);
const input = (card, name) => widgets(card).find(widget => widget.selectionInput?.name === name)?.selectionInput;
const actionData = action => Object.fromEntries(action.onClick.action.parameters.filter(({ key }) => key !== 'cgAction').map(({ key, value }) => [key, key === 'stateId' ? value : JSON.parse(value)]));
async function fixture({ admin = true } = {}) {
  const suffix = ++sequence, channelId = `gchat:spaces/settings-${suffix}`, owner = `owner-${suffix}@example.com`, resource = `users/owner-${suffix}`;
  const entry = await upsertChannelEntry(channelId, { name: `Chat <settings> ${suffix}`, platform: 'googlechat', type: 'channel' });
  const meta = { channelId, platform: 'googlechat', engine: 'claude', access: 'approved', manageAccess: 'admins', allowBash: true, allowNetwork: false };
  await saveChannelMeta(entry.slug, meta);
  await setUser(owner, { approved: true, isAdmin: admin, googleChatUserName: resource });
  const connector = { botUserId: 'users/bot', api: { listMembers: async space => {
    assert.equal(space, channelId.slice(6));
    return [{ id: resource, name: '<Owner>' }, { id: 'users/member', email: 'member@example.com', name: 'Member' }];
  } } };
  const state = { message: { conversationId: channelId, userId: owner }, entry, meta, sessionKey: 'original-session' };
  const options = { connector, authorize: googleChatWorkspaceContext };
  const build = () => buildGoogleChatSettings(state, 'opaque-state', options);
  const apply = (action, data = {}) => handleGoogleChatSettings(action, data, state, 'opaque-state', options);
  return { channelId, owner, resource, entry, state, connector, build, apply };
}

test('Chat renders Slack\'s settings pages as owner-scoped native cards with safe public credential pages', async () => {
  const f = await fixture();
  const general = await f.build();
  assert.ok(input(general, 'channel_engine'));
  assert.ok(input(general, 'thread_engine'));
  assert.match(JSON.stringify(general), /Chat &lt;settings&gt;/);
  // Page navigation is ONE dropdown that acts on change, never a row of tab buttons.
  assert.equal(actions(general).filter(button => button.onClick.action.function === 'settings.page').length, 0);
  const picker = input(general, 'settingsPage');
  assert.deepEqual(picker.items.map(item => [item.text, item.value, item.selected]), [['Agent', 'agent', true], ['Access', 'access', false], ['MCP', 'mcp', false],
    ['Variables', 'variables', false], ['Skills', 'skills', false], ['Schedules', 'schedules', false], ['Diagnostics', 'diagnostics', false], ['You', 'you', false]]);
  // Agent carries the runtime, the mode and its options; who may use the conversation is Access's.
  assert.ok(input(general, 'access_mode') && input(general, 'access_autoMode') && input(general, 'access_allowNetwork'));
  assert.ok(!input(general, 'access_access') && !input(general, 'access_manageAccess') && !input(general, 'access_allowedUsers'));
  assert.equal(picker.type, 'DROPDOWN');
  assert.equal(picker.onChangeAction.function, 'settings.page');
  assert.ok(picker.onChangeAction.parameters.some(({ key, value }) => key === 'cgAction' && value === 'settings.page'));
  assert.ok(!picker.onChangeAction.parameters.some(({ key }) => key === 'cgInputs'), 'the dropdown must submit its own value');
  // Headings open titled sections; no section is empty.
  assert.ok(general.sections.filter(section => section.header).length >= 1);
  assert.ok(general.sections.every(section => section.widgets.length));
  // The dropdown's submitted form value navigates; other submitted inputs are not applied.
  const picked = await f.apply('settings.page', { settingsPage: 'schedules', channel_engine: 'codex' });
  assert.equal(input(picked, 'settingsPage').items.find(item => item.selected).value, 'schedules');
  await assert.rejects(f.apply('settings.page', { settingsPage: 'nope' }), /Unknown settings page/);
  for (const page of ['agent', 'access', 'mcp', 'variables', 'skills', 'schedules', 'diagnostics', 'you']) {
    const card = await f.apply('settings.page', { page });
    validateChatCard(card);
    assert.ok(Buffer.byteLength(JSON.stringify(card)) <= MAX_CHAT_CARD_BYTES);
    assert.ok(card.sections.every(section => section.widgets.length));
    assert.equal(input(card, 'settingsPage').items.find(item => item.selected).value, page);
    if (['variables', 'mcp', 'you'].includes(page)) {
      assert.ok(actions(card).some(button => button.onClick.action.function === 'settings.private'));
      assert.ok(!widgets(card).some(widget => widget.textInput));
    }
  }
  // Ids from cards posted before the Slack page set, and the ids the shared policy stores, still open.
  for (const [legacy, page] of [['general', 'agent'], ['secrets', 'variables'], ['automations', 'schedules'], ['resume', 'diagnostics']]) {
    assert.equal(input(await f.apply('settings.page', { page: legacy }), 'settingsPage').items.find(item => item.selected).value, page);
  }
});

test('Chat Access is its own page, keeps its place after a change and is absent in a direct message', async () => {
  const f = await fixture();
  await f.build();
  const access = await f.apply('settings.page', { page: 'access' });
  assert.ok(input(access, 'access_access') && input(access, 'access_manageAccess') && input(access, 'access_allowedUsers') && input(access, 'access_managers'));
  assert.ok(!input(access, 'access_mode') && !input(access, 'channel_engine'));
  assert.ok(access.sections.some(section => section.header === 'People'));
  const saved = await f.apply('settings.access', { field: 'access', access_access: 'admins' });
  assert.equal((await getChannelMeta(f.entry.slug)).access, 'admins');
  assert.equal(input(saved, 'settingsPage').items.find(item => item.selected).value, 'access');
  // A change made on Agent stays on Agent.
  await f.apply('settings.page', { page: 'agent' });
  const mode = await f.apply('settings.access', { field: 'autoMode', access_autoMode: 'on' });
  assert.equal(input(mode, 'settingsPage').items.find(item => item.selected).value, 'agent');
  await patchChannelMeta(f.entry.slug, { isDM: true });
  f.state.meta = await getChannelMeta(f.entry.slug);
  const dm = await f.build();
  assert.deepEqual(input(dm, 'settingsPage').items.map(item => item.value), ['agent', 'mcp', 'variables', 'skills', 'schedules', 'diagnostics', 'you']);
  assert.ok(input(dm, 'access_mode'));
});

test('Chat Diagnostics explains a session without a turn and You opens only the private form', async () => {
  const f = await fixture();
  await f.build();
  const diagnostics = await f.apply('settings.page', { page: 'diagnostics' });
  assert.ok(diagnostics.sections.some(section => section.header === 'Resume this thread'));
  assert.match(JSON.stringify(diagnostics), /has not run a turn yet/);
  const you = await f.apply('settings.page', { page: 'you' });
  const open = actions(you).find(button => button.onClick.action.function === 'settings.private');
  assert.equal(actionData(open).page, 'you');
  assert.ok(!widgets(you).some(widget => widget.textInput || widget.selectionInput && widget.selectionInput.name !== 'settingsPage'));
});

test('Chat cannot submit credential values or personal/organization variables from a public card', async () => {
  const f = await fixture();
  await f.build();
  for (const action of ['settings.variable.save', 'settings.connections.save', 'settings.personal.save']) {
    await assert.rejects(f.apply(action, { variableScope: 'channel', variableName: 'TEST_TOKEN', variableValue: 'private-input-fixture', composioToken: 'private-input-fixture' }), /private browser/);
  }
  await assert.rejects(f.apply('settings.variable.remove', { variableScope: 'organization', name: 'OTHER_TOKEN' }), /authenticated settings/);
  assert.doesNotMatch(JSON.stringify(await getChannelMeta(f.entry.slug)), /private-input-fixture/);
  assert.doesNotMatch(JSON.stringify(getDb().prepare('SELECT * FROM events').all()), /private-input-fixture/);
});

test('Chat runtime previews and atomic Apply retain original channel/thread scope', async () => {
  const f = await fixture({ admin: false });
  await f.build();
  const preview = await f.apply('settings.runtime.models', { scope: 'channel', channel_engine: 'codex', channel_model: '__default__', channel_effort: '__default__' });
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'claude');
  assert.equal(input(preview, 'channel_engine').items.find(item => item.selected).value, 'codex');
  await f.apply('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: modelsForEngine('codex')[0].value, channel_effort: 'high', thread_engine: 'claude' });
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), '');
  await f.apply('settings.runtime.apply', { scope: 'thread', thread_engine: 'claude', thread_model: modelsForEngine('claude')[0].value, thread_effort: 'high', channel_engine: 'claude' });
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), 'claude');
  assert.equal(await getThreadEffort(f.entry.slug, 'original-session'), 'high');
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  assert.match(JSON.stringify(getDb().prepare('SELECT * FROM events').all()), /googlechat_settings/);
});

test('Chat rejects stale runtime snapshots and validates a whole scope before writing', async () => {
  const f = await fixture();
  await f.build();
  await patchChannelMeta(f.entry.slug, { model: modelsForEngine('claude')[0].value });
  await assert.rejects(f.apply('settings.runtime.apply', { scope: 'channel', channel_engine: 'codex', channel_model: '__default__', channel_effort: '__default__' }), /settings changed/);
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'claude');
  await f.apply('settings.page', { page: 'general' });
  await assert.rejects(f.apply('settings.runtime.apply', { scope: 'thread', thread_engine: 'codex', thread_model: 'forged-model', thread_effort: 'high' }), /model/i);
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), '');
  assert.equal(await getThreadModel(f.entry.slug, 'original-session'), '');
  await setThreadRuntimeOverrides(f.entry.slug, 'original-session', { engine: 'codex', model: '', effort: '' });
  await assert.rejects(f.apply('settings.runtime.apply', { scope: 'thread', thread_engine: 'claude', thread_model: '__default__', thread_effort: '__default__' }), /settings changed/);
  assert.equal(await getThreadEngine(f.entry.slug, 'original-session'), 'codex');
});

test('Chat named access uses authorized roster identities and rechecks roles after roster requests', async () => {
  const f = await fixture();
  await f.build();
  const card = await f.apply('settings.page', { page: 'access' });
  assert.ok(input(card, 'access_allowedUsers').items.some(member => member.value === f.owner));
  await f.apply('settings.access', { field: 'allowedUsers', access_allowedUsers: f.owner + ',member@example.com' });
  assert.deepEqual((await getChannelMeta(f.entry.slug)).allowedUsers, [f.owner, 'member@example.com']);
  await assert.rejects(f.apply('settings.access', { field: 'allowedUsers', access_allowedUsers: 'users/bot' }), /current conversation members/);
  f.connector.api.listMembers = async () => {
    await setUser(f.owner, { approved: true, isAdmin: false });
    return [{ id: f.resource, name: 'Owner' }];
  };
  await assert.rejects(f.apply('settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }), /managers/);
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  await patchChannelMeta(f.entry.slug, { allowedUsers: [] });
  await setUser(f.owner, { approved: false, isAdmin: false });
  await assert.rejects(f.apply('settings.page', { page: 'general' }), /no longer allowed/);
});

test('Chat confirmations are one-use and automation pages stay bounded', async () => {
  const f = await fixture();
  await f.build();
  for (let i = 0; i < 15; i++) addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: `Schedule ${i}`, description: `Schedule ${i}`, cron: '0 * * * *' });
  const card = await f.apply('settings.page', { page: 'automations' });
  const next = actions(card).find(button => button.text === 'Next');
  const last = await f.apply(next.onClick.action.function, actionData(next));
  assert.match(JSON.stringify(last), /Schedule 14/);
  validateChatCard(last);
  const id = listForChannel(f.channelId)[0].id;
  const confirmation = await f.apply('settings.automation.delete', { id });
  const confirm = actions(confirmation).find(button => button.text === 'Confirm');
  await f.apply('settings.confirm', actionData(confirm));
  assert.equal(listForChannel(f.channelId).length, 14);
  await assert.rejects(f.apply('settings.confirm', actionData(confirm)), /no longer available/);
});

test('Cards v2 escapes HTML, serializes value types, and rejects excessive payloads', () => {
  assert.equal(chatText('<a href="bad">&\ntext').textParagraph.text, '&lt;a href=&quot;bad&quot;&gt;&amp;<br>text');
  const action = chatAction('Save', 'settings.test', 'state', { enabled: false, index: 3, key: 'literal' });
  assert.deepEqual(actionData(action), { stateId: 'state', enabled: false, index: 3, key: 'literal' });
  assert.throws(() => chatCard('Too many', Array.from({ length: 101 }, () => chatText('item'))), /too large/);
  assert.throws(() => chatCard('Too big', Array.from({ length: 20 }, () => chatText('x'.repeat(2400)))), /too large/);
  assert.throws(() => chatCard('Too many choices', [{ selectionInput: { items: Array.from({ length: 101 }, () => ({ value: 'x' })) } }]), /too many choices/);
});
