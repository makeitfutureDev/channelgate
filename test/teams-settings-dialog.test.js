import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, setUser } = await import('../src/config/store.js');
const { addSchedule, listForChannel } = await import('../src/config/schedules.js');

let sequence = 0;
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(nodes)];
const actions = card => nodes(card).filter(item => item.type?.startsWith('Action.'));
function continued(result) {
  assert.equal(result.status, 200);
  assert.equal(result.body.task.type, 'continue');
  assert.equal(result.body.task.value.card.contentType, 'application/vnd.microsoft.card.adaptive');
  return result.body.task.value.card.content;
}
function denied(result) {
  assert.equal(result.status, 200);
  assert.equal(result.body.task.type, 'message');
  assert.match(result.body.task.value, /Reopen|could not be completed/);
}
async function fixture(t) {
  const suffix = ++sequence, owner = `29:dialog-${suffix}`, tenant = `tenant-${suffix}`;
  const nativeId = `19:dialog-${suffix}@thread.v2`, channelId = `teams:${nativeId}`;
  const entry = await upsertChannelEntry(channelId, { name: `Dialog ${suffix}`, platform: 'msteams', type: 'mpim' });
  const meta = { channelId, platform: 'msteams', isDM: false, access: 'approved', manageAccess: 'admins', engine: 'claude', allowNetwork: false };
  await saveChannelMeta(entry.slug, meta);
  await setUser(owner, { approved: true, isAdmin: true });
  let clock = 1_000_000, roster = [{ id: owner }], approvalCalls = 0;
  const posted = [], updated = [], replies = [];
  const connector = { botId: '28:dialog-bot', api: { listMembers: async () => roster,
    sendActivity: async () => assert.fail('Settings must not send a file-consent activity') },
    postCard: async payload => { posted.push(payload); return { messageId: `launch-${posted.length}` }; },
    updateCard: async payload => updated.push(payload), openDm: async () => assert.fail('Settings must not open a DM') };
  const controls = createTeamsControls({ connector, now: () => clock,
    approval: async () => { approvalCalls++; return { ok: true }; } });
  t.after(() => controls.stop());
  const command = async (text = '/settings') => {
    await controls.onCommand({ message: { text, trigger: 'message', userId: owner, conversationId: channelId,
      rawConversationId: nativeId, isDM: false, threadKey: 'source-thread',
      raw: { tenantId: tenant, activity: { recipient: { id: connector.botId } } } }, entry, meta,
    sessionKey: 'source-session', authorIsAdmin: true, reply: async text => replies.push(text) });
    assert.deepEqual(replies, []);
    return posted.at(-1).card.actions[0].data;
  };
  const invoke = (name, data, overrides = {}) => controls.onInvoke({ type: 'invoke', name, id: `action-${++sequence}`,
    from: { id: owner }, recipient: { id: connector.botId }, conversation: { id: nativeId },
    channelData: { tenant: { id: tenant } }, serviceUrl: 'https://smba.trafficmanager.net/teams/',
    value: { data }, ...overrides });
  const open = async launcher => {
    const result = await invoke('task/fetch', launcher);
    const card = continued(result);
    return { card, result, stateId: actions(card).find(action => action.data?.stateId).data.stateId };
  };
  const submit = (stateId, cgAction, data = {}, overrides = {}) => invoke('task/submit', { ...data, stateId, cgAction }, overrides);
  return { owner, tenant, nativeId, channelId, entry, connector, controls, posted, updated, replies,
    command, invoke, open, submit, advance: ms => { clock += ms; }, removeMember: () => { roster = []; },
    approvalCalls: () => approvalCalls };
}

test('Teams launcher opens a native dialog and saves without publishing any form to chat', async t => {
  const f = await fixture(t), launcher = await f.command();
  assert.equal(f.posted[0].conversationId, f.nativeId);
  assert.equal(f.posted[0].threadKey, 'source-thread');
  assert.equal(f.posted[0].card.actions[0].type, 'Action.Submit');
  assert.equal(launcher.msteams.type, 'task/fetch');
  assert.ok(!nodes(f.posted[0].card).some(item => item.type?.startsWith('Input.')));
  const dialog = await f.open(launcher);
  assert.notEqual(dialog.stateId, launcher.stateId);
  assert.equal(dialog.result.body.task.value.width, 'large');
  assert.equal(dialog.result.body.task.value.height, 'large');
  const general = continued(await f.submit(dialog.stateId, 'settings.page', { page: 'general' }));
  for (const action of actions(general)) {
    assert.equal(action.type, 'Action.Submit');
    assert.equal(action.fallback, undefined);
    assert.equal(action.data.msteams, undefined);
  }
  continued(await f.submit(dialog.stateId, 'settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }));
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, true);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.updated, []);
});

test('Teams dialog launch and submissions reject different actor, conversation, tenant and bot', async t => {
  const f = await fixture(t), launcher = await f.command(), dialog = await f.open(launcher);
  const overrides = [
    { from: { id: '29:foreign' } }, { conversation: { id: '19:foreign@thread.v2' } },
    { channelData: { tenant: { id: 'foreign-tenant' } } }, { channelData: {} },
    { recipient: { id: '28:foreign-bot' } },
  ];
  for (const override of overrides) {
    denied(await f.invoke('task/fetch', launcher, override));
    denied(await f.submit(dialog.stateId, 'settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }, override));
  }
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.updated, []);
});

test('Teams dialog ignores submitted identity and reply targets and accepts envelope tenant fallback', async t => {
  const f = await fixture(t), launcher = await f.command();
  const card = continued(await f.invoke('task/fetch', { ...launcher, actorId: '29:forged', tenantId: 'forged', conversationId: 'teams:forged' }, {
    channelData: {}, conversation: { id: `${f.nativeId};messageid=source-thread`, tenantId: f.tenant }, replyToId: 'forged-reply',
  }));
  const stateId = actions(card)[0].data.stateId;
  continued(await f.submit(stateId, 'settings.access', { field: 'allowNetwork', access_allowNetwork: 'on',
    actorId: '29:forged', tenantId: 'forged', conversationId: 'teams:forged', sessionKey: 'forged-session' }, { replyToId: 'forged-reply' }));
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, true);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.updated, []);
});

test('Teams popup checks current approval and roster on both opening and save', async t => {
  for (const revoke of ['approval', 'membership']) {
    const f = await fixture(t), launcher = await f.command(), dialog = await f.open(launcher);
    if (revoke === 'approval') await setUser(f.owner, { approved: false, isAdmin: false });
    else f.removeMember();
    denied(await f.invoke('task/fetch', launcher));
    denied(await f.submit(dialog.stateId, 'settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }));
    assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
    assert.deepEqual(f.updated, []);
  }
});

test('Teams launchers expire independently of their later opened dialog', async t => {
  const f = await fixture(t), launcher = await f.command();
  f.advance(10 * 60_000);
  const dialog = await f.open(launcher);
  f.advance(5 * 60_000 + 1);
  denied(await f.invoke('task/fetch', launcher));
  continued(await f.submit(dialog.stateId, 'settings.page', { page: 'automations' }));
  f.advance(10 * 60_000);
  denied(await f.submit(dialog.stateId, 'settings.access', { field: 'allowNetwork', access_allowNetwork: 'on' }));
  assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  assert.deepEqual(f.updated, []);
});

test('Teams popup state cannot be submitted through card Execute, legacy Submit or extension transports', async t => {
  const f = await fixture(t), launcher = await f.command(), dialog = await f.open(launcher);
  const mutation = { stateId: dialog.stateId, cgAction: 'settings.access', field: 'allowNetwork', access_allowNetwork: 'on' };
  for (const [name, overrides] of [
    ['adaptiveCard/action', { value: { action: { type: 'Action.Execute', verb: mutation.cgAction, data: mutation } } }],
    ['', { type: 'message', value: mutation }],
    ['composeExtension/submitAction', {}],
  ]) {
    const result = await f.invoke(name, mutation, overrides);
    assert.notEqual(result.body.task?.type, 'continue');
    assert.equal((await getChannelMeta(f.entry.slug)).allowNetwork, false);
  }
  denied(await f.invoke('task/fetch', mutation));
  denied(await f.submit(launcher.stateId, mutation.cgAction, mutation));
  assert.deepEqual(f.updated, []);
});

test('Teams task invokes reject approval, model and file actions before unrelated handlers', async t => {
  const f = await fixture(t), launcher = await f.command(), dialog = await f.open(launcher);
  for (const stateId of [launcher.stateId, dialog.stateId]) {
    for (const name of ['task/fetch', 'task/submit']) {
      for (const cgAction of ['approval.respond', 'model.save', 'files.download']) {
        denied(await f.invoke(name, { stateId, cgAction, id: 'forged-approval', relative: 'AGENTS.md' }));
      }
    }
  }
  assert.equal(f.approvalCalls(), 0);
  assert.deepEqual(f.updated, []);
});

test('separate Teams dialog openings isolate confirmation state and never trust replacement targets', async t => {
  const f = await fixture(t), launcher = await f.command();
  const first = await f.open(launcher), second = await f.open(launcher);
  assert.notEqual(first.stateId, second.stateId);
  const original = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'First reminder', runAt: '2030-01-01T00:00:00Z', once: true });
  const replacement = addSchedule({ channelId: f.channelId, slug: f.entry.slug, prompt: 'Second reminder', runAt: '2030-01-02T00:00:00Z', once: true });
  const confirm = continued(await f.submit(first.stateId, 'settings.automation.delete', { id: original.id }));
  const token = confirm.actions.find(action => action.data.cgAction === 'settings.confirm').data.token;
  assert.ok(confirm.actions.every(action => action.type === 'Action.Submit'));
  assert.equal(listForChannel(f.channelId).length, 2);
  denied(await f.submit(second.stateId, 'settings.confirm', { token }));
  continued(await f.submit(second.stateId, 'settings.page', { page: 'automations' }));
  continued(await f.submit(first.stateId, 'settings.confirm', { token, id: replacement.id }));
  assert.deepEqual(listForChannel(f.channelId).map(row => row.id), [replacement.id]);
  denied(await f.submit(first.stateId, 'settings.confirm', { token }));
  assert.equal(listForChannel(f.channelId).length, 1);
  assert.equal(f.posted.length, 1);
  assert.deepEqual(f.updated, []);
});

test('malformed dialog submissions return task errors without reflecting submitted secrets', async t => {
  const f = await fixture(t), launcher = await f.command(), dialog = await f.open(launcher);
  const result = await f.submit(dialog.stateId, 'settings.access', { privateValue: { secret: 'do-not-reflect-this' } });
  denied(result);
  assert.doesNotMatch(JSON.stringify(result), /do-not-reflect-this/);
  assert.deepEqual(f.updated, []);
});
