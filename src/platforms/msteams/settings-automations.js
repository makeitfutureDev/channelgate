// Automation edits remain drafts until a scoped Apply. Thread scope can edit only existing
// thread-bound schedules; an ordinary schedule's delivery thread is not its execution session.
import { listForChannel, countEnabledForChannel, updateSchedule, deleteSchedule } from '../../config/schedules.js';
import { getScheduleMaxPerChannel } from '../../config/settings.js';
import { getDb } from '../../db/index.js';
import { isAuthorized } from '../../gateway/modes.js';
import { nextCronRun } from '../../util/cron.js';
import { zonedStamp, daemonTimeZone } from '../../util/timezone.js';
import { logEvent } from '../../util/logger.js';

const CONFIG_FIELDS = ['channelId', 'slug', 'cron', 'runAt', 'once', 'intervalDays', 'matchPrefix', 'prompt', 'description', 'createdBy', 'createdAt', 'kind', 'ack', 'ackEmoji', 'escalateAfterMin', 'dmAfterMin', 'escalationStyle', 'notify', 'notifyUserId', 'delivery', 'loop', 'loopId', 'threadTs', 'resumeThread', 'loopReason', 'loopNoop', 'enabled'];
const snapshot = row => Object.fromEntries(CONFIG_FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
const matches = (row, baseline) => JSON.stringify(snapshot(row)) === JSON.stringify(baseline);
const threadBound = (row, ctx) => Boolean(ctx.sessionKey && row.resumeThread && row.threadTs === ctx.sessionKey);
function draftFor(ctx) {
  return ctx.state.automationDraft ||= {};
}

export function renderAutomations(ctx, ui) {
  const rows = listForChannel(ctx.channelId), draft = draftFor(ctx);
  const pages = Math.max(1, Math.ceil(rows.length / 12));
  const page = Math.min(Math.max(0, Number.isSafeInteger(ctx.state.automationPage) ? ctx.state.automationPage : 0), pages - 1);
  const body = [ui.heading('Automations'), ui.text(`${rows.length} automations — page ${page + 1}/${pages}. Times are shown in ${daemonTimeZone()}. Ask the agent to create a task or reminder.`),
    ui.text('Stage changes, then Apply once. Apply saves only Automations; changes in other sections stay pending. Apply to thread changes only automations already bound to this exact thread. Channel schedules and daily delivery threads remain channel-owned.')];
  for (const row of rows.slice(page * 12, (page + 1) * 12)) {
    const edit = draft[row.id], enabled = edit && typeof edit.enabled === 'boolean' ? edit.enabled : row.enabled;
    const next = row.runAt || (enabled && row.cron ? nextCronRun(row.cron) : null);
    body.push(ui.heading(String(row.description || row.loopReason || row.prompt || row.id).slice(0, 120)),
      ui.text(`${row.loop ? 'Loop' : row.kind === 'reminder' ? 'Reminder' : 'Task'} · ${enabled ? 'On' : 'Paused'}${row.cron ? ` · ${row.cron}` : ''}${next ? ` · Next: ${zonedStamp(next)}` : ''}${row.loop ? ` · Ticks remaining: ${row.ticksRemaining ?? '—'}` : ''}${edit ? edit.remove ? ' · Removal staged' : ' · Change staged' : ''}`),
      ui.text(`Scope: ${threadBound(row, ctx) ? 'This thread' : 'Channel / another thread'} · Creator: ${String(row.createdBy || 'Unknown').slice(0, 100)} · Last status: ${String(row.lastStatus || 'Not run yet').slice(0, 120)}`));
    const actions = [];
    if (!edit?.remove && !row.loop && !row.once && !row.runAt) actions.push(ui.execute(enabled ? 'Stage pause' : 'Stage resume', 'settings.automation.toggle', { id: row.id, enabled: !enabled }, 'none'));
    if (!edit?.remove) actions.push(ui.execute(row.loop ? 'Stage stop loop' : row.once || row.runAt ? 'Stage cancel' : 'Stage delete', 'settings.automation.delete', { id: row.id }, 'none'));
    if (edit) actions.push(ui.execute('Undo staged change', 'settings.automation.undo', { id: row.id }, 'none'));
    body.push(ui.buttons(actions));
  }
  if (!rows.length) body.push(ui.text('No automations for this conversation.'));
  body.push(ui.text(`${Object.keys(draft).length} pending changes. Existing automations keep running until Apply.`));
  const actions = [];
  if (page) actions.push(ui.execute('Previous', 'settings.automation.page', { page: page - 1 }, 'none'));
  if (page + 1 < pages) actions.push(ui.execute('Next', 'settings.automation.page', { page: page + 1 }, 'none'));
  actions.push(ui.execute('Apply to channel', 'settings.automation.apply', { scope: 'channel' }, 'none'));
  if (ctx.sessionKey) actions.push(ui.execute('Apply to thread', 'settings.automation.apply', { scope: 'thread' }, 'none'));
  return { body, actions };
}

async function authorized(ctx) {
  const expected = { ownerId: ctx.ownerId, channelId: ctx.channelId, slug: ctx.entry.slug, sessionKey: ctx.sessionKey };
  const fresh = await ctx.authorize();
  if (!fresh || Object.entries(expected).some(([key, value]) => (key === 'slug' ? fresh.entry?.slug : fresh[key]) !== value)) throw new Error('These settings expired. Open Settings again.');
  if (!isAuthorized(fresh.meta, fresh.ownerId, Boolean(fresh.meta.isDM), { isAdminUser: fresh.userIsAdmin, isApprovedUser: fresh.userIsApproved })) throw new Error('Your access to these settings has changed.');
  return fresh;
}

export async function handleAutomations(action, data, ctx, _ui) {
  if (!action.startsWith('settings.automation.')) return false;
  if (action === 'settings.automation.page') {
    if (!Number.isSafeInteger(data.page) || data.page < 0) throw new Error('Unknown automations page.');
    ctx.state.automationPage = data.page; ctx.state.tab = 'automations';
    return true;
  }
  const fresh = await authorized(ctx), draft = draftFor(ctx);
  if (action === 'settings.automation.apply') {
    if (!['channel', 'thread'].includes(data.scope)) throw new Error('Choose channel or thread scope.');
    if (data.scope === 'thread' && !fresh.sessionKey) throw new Error('Open Settings from the thread you want to change.');
    const entries = Object.entries(draft);
    if (!entries.length) { ctx.state.notice = 'No staged automation changes.'; return true; }
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = listForChannel(fresh.channelId), current = new Map(rows.map(row => [row.id, row]));
      for (const [id, edit] of entries) {
        const row = current.get(id);
        if (!row || !matches(row, edit.baseline)) throw new Error('An automation changed or was removed. Undo its staged change and reopen Automations.');
        if (data.scope === 'thread' && !threadBound(row, fresh)) throw new Error('Apply to thread can change only automations already bound to this exact thread. Use Apply to channel for channel automations.');
        if (!edit.remove && (typeof edit.enabled !== 'boolean' || row.loop || row.once || row.runAt)) throw new Error('Only recurring automations can be paused or resumed.');
      }
      const enabledDelta = entries.reduce((delta, [id, edit]) => {
        const row = current.get(id);
        return delta + Number(!edit.remove && edit.enabled) - Number(row.enabled);
      }, 0);
      if (enabledDelta > 0 && countEnabledForChannel(fresh.channelId) + enabledDelta > getScheduleMaxPerChannel()) throw new Error('This conversation has reached its enabled automation limit.');
      for (const [id, edit] of entries) {
        if (edit.remove) deleteSchedule(id, fresh.channelId);
        else updateSchedule(id, { enabled: edit.enabled });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    ctx.state.automationDraft = {};
    ctx.state.notice = `${entries.length} automation changes applied to ${data.scope === 'thread' ? 'this thread' : 'the channel'}.`;
    await logEvent('schedules_batch_updated', { channel: fresh.channelId, slug: fresh.entry.slug, author: fresh.ownerId, scope: data.scope,
      schedules: entries.map(([id, edit]) => ({ id, removed: Boolean(edit.remove), ...(!edit.remove ? { enabled: edit.enabled } : {}) })) });
  } else {
    const row = listForChannel(fresh.channelId).find(item => item.id === data.id);
    if (!row) throw new Error('This automation is no longer in this conversation.');
    if (action === 'settings.automation.undo') delete draft[row.id];
    else if (action === 'settings.automation.delete') draft[row.id] = { baseline: draft[row.id]?.baseline || snapshot(row), remove: true };
    else if (action === 'settings.automation.toggle') {
      if (typeof data.enabled !== 'boolean' || row.loop || row.once || row.runAt) throw new Error('Only recurring automations can be paused or resumed.');
      const baseline = draft[row.id]?.baseline || snapshot(row);
      if (data.enabled === baseline.enabled) delete draft[row.id];
      else draft[row.id] = { baseline, enabled: data.enabled };
    } else throw new Error('Unknown automation action.');
    ctx.state.notice = 'Automation change staged. Apply to save the pending list.';
  }
  ctx.state.tab = 'automations';
  return true;
}
