// Teams settings → Automations as pending changes: pause, resume, delete and stop are staged, then
// saved as one validated batch. Apply to channel changes any of this conversation's automations.
// Apply to thread changes only an automation whose runs EXECUTE in this exact thread — a loop
// resumed in this thread's own session (scheduler.js loopTick); an ordinary schedule merely
// delivered to a thread runs in a fresh session of its own and stays channel-owned.
import { listForChannel, countEnabledForChannel, updateSchedule, deleteSchedule } from '../../config/schedules.js';
import { getScheduleMaxPerChannel } from '../../config/settings.js';
import { getDb } from '../../db/index.js';
import { nextCronRun } from '../../util/cron.js';
import { zonedStamp, daemonTimeZone } from '../../util/timezone.js';
import { logEvent } from '../../util/logger.js';

const PAGE = 12;
const recurring = row => !row.loop && !row.once && !row.runAt;
export const boundToThread = (row, sessionKey) => Boolean(sessionKey && row.loop && row.resumeThread && row.threadTs && row.threadTs === sessionKey);
const titleOf = row => String(row.description || row.loopReason || row.prompt || row.id).slice(0, 120);
const draftOf = ctx => ctx.state.automationDraft ||= {};

export function automationPending(ctx) {
  return Object.keys(ctx.state.automationDraft || {}).length;
}

export function renderAutomations(ctx, ui, title = 'Automations') {
  const rows = listForChannel(ctx.channelId), draft = draftOf(ctx);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(Math.max(0, Number.isSafeInteger(ctx.state.automationPage) ? ctx.state.automationPage : 0), pages - 1);
  const body = [ui.heading(title), ui.text(`${rows.length} automations — page ${page + 1}/${pages}. Times are shown in ${daemonTimeZone()}. Ask the agent to create a task or reminder.`),
    ui.text('Stage changes, then Apply once. Existing automations keep running until you apply. Apply to thread changes only automations that run in this exact thread; channel schedules stay channel-owned.')];
  if (automationPending(ctx)) body.push(ui.text(`${automationPending(ctx)} pending change${automationPending(ctx) === 1 ? '' : 's'} — not saved yet.`));
  for (const row of rows.slice(page * PAGE, (page + 1) * PAGE)) {
    const edit = draft[row.id];
    const enabled = edit && typeof edit.enabled === 'boolean' ? edit.enabled : row.enabled;
    const next = row.runAt || (enabled && row.cron ? nextCronRun(row.cron) : null);
    body.push(ui.heading(titleOf(row)),
      ui.text(`${row.loop ? 'Loop' : row.kind === 'reminder' ? 'Reminder' : 'Task'} · ${enabled ? 'On' : 'Paused'}${row.cron ? ` · ${row.cron}` : ''}${next ? ` · Next: ${zonedStamp(next)}` : ''}${row.loop ? ` · Ticks remaining: ${row.ticksRemaining ?? '—'}` : ''}${edit ? (edit.remove ? ' · Removal pending' : ' · Change pending') : ''}`),
      ui.text(`Runs in: ${boundToThread(row, ctx.sessionKey) ? 'this thread' : 'the channel'} · Creator: ${String(row.createdBy || 'Unknown').slice(0, 100)} · Last status: ${String(row.lastStatus || 'Not run yet').slice(0, 120)}`));
    const actions = [];
    if (!edit?.remove && recurring(row)) actions.push(ui.execute(enabled ? 'Stage: pause' : 'Stage: resume', 'settings.automation.toggle', { id: row.id, enabled: !enabled }, 'none'));
    if (!edit?.remove) actions.push(ui.execute(row.loop ? 'Stage: stop loop' : row.once || row.runAt ? 'Stage: cancel' : 'Stage: delete', 'settings.automation.delete', { id: row.id }, 'none'));
    if (edit) actions.push(ui.execute('Undo', 'settings.automation.undo', { id: row.id }, 'none'));
    body.push(ui.buttons(actions));
  }
  if (!rows.length) body.push(ui.text('No automations for this conversation.'));
  const actions = [];
  if (page) actions.push(ui.execute('Previous', 'settings.automation.page', { page: page - 1 }, 'none'));
  if (page + 1 < pages) actions.push(ui.execute('Next', 'settings.automation.page', { page: page + 1 }, 'none'));
  return { body, actions, save: { title: 'Automations', verb: 'settings.automation.apply', discard: 'settings.automation.discard', data: {}, pending: automationPending(ctx),
    thread: Boolean(ctx.sessionKey), follow: false } };
}

// The fields that decide what an automation does and when; a staged edit is refused when any of
// them changed after it was staged (another card, the agent or the scheduler wrote the row).
const CONFIG_FIELDS = ['channelId', 'slug', 'cron', 'runAt', 'once', 'intervalDays', 'prompt', 'description', 'createdBy', 'kind', 'delivery', 'loop', 'loopId', 'threadTs', 'resumeThread', 'enabled', 'sudo'];
const snapshot = row => Object.fromEntries(CONFIG_FIELDS.map(key => [key, row[key] ?? null]));
const sameRow = (row, baseline) => JSON.stringify(snapshot(row)) === JSON.stringify(baseline);

export async function handleAutomations(action, data, ctx) {
  if (!action.startsWith('settings.automation.')) return false;
  ctx.state.tab = 'automations';
  if (action === 'settings.automation.page') {
    if (!Number.isSafeInteger(data.page) || data.page < 0) throw new Error('Unknown automations page.');
    ctx.state.automationPage = data.page;
    return true;
  }
  const draft = draftOf(ctx);
  if (action === 'settings.automation.discard') {
    ctx.state.automationDraft = {};
    ctx.state.notice = 'Pending automation changes discarded. Other sections keep theirs.';
    return true;
  }
  if (action === 'settings.automation.apply') {
    const scope = data.scope;
    if (!['channel', 'thread'].includes(scope)) throw new Error('Choose Apply to channel or Apply to thread.');
    const fresh = await ctx.authorize();
    if (scope === 'thread' && !fresh.sessionKey) throw new Error('Open Settings from the thread you want to change.');
    const entries = Object.entries(draft);
    if (!entries.length) { ctx.state.notice = 'No pending automation changes.'; return true; }
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Validate the WHOLE batch against the rows as they are now, then write.
      const current = new Map(listForChannel(fresh.channelId).map(row => [row.id, row]));
      for (const [id, edit] of entries) {
        const row = current.get(id);
        if (!row || !sameRow(row, edit.baseline)) throw new Error(`"${row ? titleOf(row) : id}" changed or was removed after you staged a change. Undo that change and try again.`);
        if (scope === 'thread' && !boundToThread(row, fresh.sessionKey)) throw new Error(`"${titleOf(row)}" runs in the channel, not in this thread. Use Apply to channel, or undo that change.`);
        if (!edit.remove && (typeof edit.enabled !== 'boolean' || !recurring(row))) throw new Error('Only recurring automations can be paused or resumed.');
      }
      const enabling = entries.reduce((sum, [id, edit]) => sum + Number(!edit.remove && edit.enabled === true && !current.get(id).enabled), 0);
      if (enabling && countEnabledForChannel(fresh.channelId) + enabling > getScheduleMaxPerChannel()) throw new Error('This conversation has reached its enabled automation limit.');
      for (const [id, edit] of entries) {
        if (edit.remove) deleteSchedule(id, fresh.channelId);
        else if (!updateSchedule(id, { enabled: edit.enabled }, { enabled: current.get(id).enabled })) throw new Error('An automation changed while saving. Nothing was saved.');
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    }
    ctx.state.automationDraft = {};
    ctx.state.notice = `${entries.length} automation change${entries.length === 1 ? '' : 's'} saved to ${scope === 'thread' ? 'this thread' : 'the channel'}.`;
    await logEvent('schedules_batch_updated', { channel: fresh.channelId, slug: fresh.entry.slug, author: fresh.ownerId, scope, via: ctx.source || 'teams_settings',
      schedules: entries.map(([id, edit]) => ({ id, removed: Boolean(edit.remove), ...(edit.remove ? {} : { enabled: edit.enabled }) })) });
    return true;
  }
  const row = listForChannel(ctx.channelId).find(item => item.id === data.id);
  if (!row) throw new Error('This automation is no longer in this conversation.');
  if (action === 'settings.automation.undo') delete draft[row.id];
  else if (action === 'settings.automation.delete') {
    if (!draft[row.id] && Object.keys(draft).length >= 64) throw new Error('Apply or discard the pending automation changes first.');
    draft[row.id] = { baseline: draft[row.id]?.baseline || snapshot(row), remove: true };
  } else if (action === 'settings.automation.toggle') {
    if (typeof data.enabled !== 'boolean' || !recurring(row)) throw new Error('Only recurring automations can be paused or resumed.');
    if (!draft[row.id] && Object.keys(draft).length >= 64) throw new Error('Apply or discard the pending automation changes first.');
    const baseline = draft[row.id]?.baseline || snapshot(row);
    if (data.enabled === baseline.enabled) delete draft[row.id];
    else draft[row.id] = { baseline, enabled: data.enabled };
  } else throw new Error('Unknown automation action.');
  ctx.state.notice = action === 'settings.automation.undo' ? 'Staged automation change undone.' : 'Automation change staged. Apply to save it.';
  return true;
}
