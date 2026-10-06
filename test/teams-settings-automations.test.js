import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { renderAutomations, handleAutomations } = await import('../src/platforms/msteams/settings-automations.js');
const { addSchedule, listForChannel, updateSchedule } = await import('../src/config/schedules.js');
const { getDb } = await import('../src/db/index.js');
const { saveSettings } = await import('../src/config/settings.js');
const { teamsSettingsUi } = await import('../src/platforms/msteams/settings.js');
let n = 0;
function context() {
  const ctx = { ownerId: '29:owner', channelId: `msteams:automation-${++n}`, entry: { slug: `automation-${n}` }, sessionKey: 'thread-1', meta: { access: 'approved' }, userIsAdmin: false, userIsApproved: true, state: {} };
  ctx.authorize = async () => ctx;
  return ctx;
}
const create = (ctx, extra = {}) => addSchedule({ channelId: ctx.channelId, slug: ctx.entry.slug, prompt: 'Check status', description: 'Status', createdBy: ctx.ownerId, cron: '* * * * *', ...extra });
const stage = (ctx, row, enabled) => handleAutomations('settings.automation.toggle', { id: row.id, enabled }, ctx);
const apply = (ctx, scope = 'channel') => handleAutomations('settings.automation.apply', { scope }, ctx);

test('automation changes stage across rows, then Apply saves the complete batch', async () => {
  const ctx = context(), first = create(ctx), second = create(ctx);
  await stage(ctx, first, false);
  await handleAutomations('settings.automation.delete', { id: second.id }, ctx);
  assert.equal(listForChannel(ctx.channelId).length, 2); assert.equal(listForChannel(ctx.channelId)[0].enabled, true);
  const card = renderAutomations(ctx, teamsSettingsUi('opaque'));
  assert.deepEqual(card.actions.filter(action => action.verb === 'settings.automation.apply').map(action => action.title), ['Apply to channel', 'Apply to thread']);
  await apply(ctx);
  const rows = listForChannel(ctx.channelId); assert.equal(rows.length, 1); assert.equal(rows[0].enabled, false);
  assert.deepEqual(ctx.state.automationDraft, {});
});

test('thread Apply requires exact existing session binding and never changes channel schedules', async () => {
  const ctx = context(), thread = create(ctx, { resumeThread: true, threadTs: ctx.sessionKey }), channel = create(ctx, { delivery: 'daily-thread', threadTs: ctx.sessionKey });
  await stage(ctx, thread, false); await stage(ctx, channel, false);
  await assert.rejects(apply(ctx, 'thread'), /only automations already bound/);
  assert.ok(listForChannel(ctx.channelId).every(row => row.enabled));
  await handleAutomations('settings.automation.undo', { id: channel.id }, ctx);
  await apply(ctx, 'thread');
  const rows = listForChannel(ctx.channelId); assert.equal(rows.find(row => row.id === thread.id).enabled, false); assert.equal(rows.find(row => row.id === channel.id).enabled, true);
});

test('stale config and revoked access reject the full batch; execution status can advance', async () => {
  const ctx = context(), first = create(ctx), second = create(ctx);
  await stage(ctx, first, false); await stage(ctx, second, false);
  updateSchedule(second.id, { prompt: 'Changed by another member' });
  await assert.rejects(apply(ctx), /automation changed/); assert.ok(listForChannel(ctx.channelId).every(row => row.enabled));
  await handleAutomations('settings.automation.undo', { id: second.id }, ctx);
  updateSchedule(first.id, { lastRun: '2026-10-06T12:00:00Z', lastStatus: 'Complete', executionState: 'completed' });
  ctx.userIsApproved = false;
  await assert.rejects(apply(ctx), /access.*changed/); assert.ok(listForChannel(ctx.channelId).every(row => row.enabled));
  ctx.userIsApproved = true; await apply(ctx); assert.equal(listForChannel(ctx.channelId)[0].enabled, false);
});

test('automation Apply rolls back every row when a later write fails', async () => {
  const ctx = context(), first = create(ctx), second = create(ctx);
  await stage(ctx, first, false); await stage(ctx, second, false);
  const db = getDb();
  db.exec(`CREATE TEMP TRIGGER fail_automation_batch BEFORE UPDATE ON schedules WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'injected automation failure'); END`);
  try { await assert.rejects(apply(ctx), /injected automation failure/); }
  finally { db.exec('DROP TRIGGER fail_automation_batch'); }
  assert.ok(listForChannel(ctx.channelId).every(row => row.enabled)); assert.equal(Object.keys(ctx.state.automationDraft).length, 2);
});

test('enabled schedule limit is checked over the complete net batch', async () => {
  saveSettings({ scheduleMaxPerChannel: 1 });
  try {
    const ctx = context(), first = create(ctx), second = create(ctx); updateSchedule(second.id, { enabled: false });
    await stage(ctx, second, true); await assert.rejects(apply(ctx), /enabled automation limit/);
    await stage(ctx, first, false); await apply(ctx);
    const rows = listForChannel(ctx.channelId); assert.equal(rows.filter(row => row.enabled).length, 1); assert.equal(rows.find(row => row.id === second.id).enabled, true);
  } finally { saveSettings({ scheduleMaxPerChannel: 5 }); }
});

test('forged row, changed session identity and loops pause are refused', async () => {
  const ctx = context(), other = context(), foreign = create(other), loop = create(ctx, { loop: true, resumeThread: true, threadTs: ctx.sessionKey });
  await assert.rejects(stage(ctx, foreign, false), /no longer in this conversation/);
  await assert.rejects(stage(ctx, loop, false), /Only recurring/);
  ctx.authorize = async () => ({ ...ctx, sessionKey: 'different-thread' });
  await assert.rejects(handleAutomations('settings.automation.delete', { id: loop.id }, ctx), /settings expired/);
});
