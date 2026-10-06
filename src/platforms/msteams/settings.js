// Teams' private settings console. The opaque card state owns conversation/session authority;
// submitted fields are values only and are never saved in the navigation state.
import { randomUUID } from 'node:crypto';
import { getChannelMeta, patchChannelMeta, isAdmin, isApproved } from '../../config/store.js';
import { isAuthorized } from '../../gateway/modes.js';
import { logChannelPolicyChange } from '../../config/channel-audit.js';
import { listForChannel, countEnabledForChannel, updateSchedule, deleteSchedule } from '../../config/schedules.js';
import { getScheduleMaxPerChannel } from '../../config/settings.js';
import { logEvent } from '../../util/logger.js';
import { nextCronRun } from '../../util/cron.js';
import { zonedStamp, daemonTimeZone } from '../../util/timezone.js';
import { resolveResumeSession } from '../../slack/resume-session.js';
import { effectiveMeta } from '../../gateway/run.js';
import { renderGeneral, handleGeneral } from './settings-general.js';
import { renderCatalogPage, handleCatalogAction } from './settings-catalog.js';

export const TEAMS_SETTINGS_PAGES = Object.freeze([
  ['general', 'General'], ['secrets', 'Variables'], ['mcp', 'MCPs'],
  ['skills', 'Skills'], ['automations', 'Automations'], ['resume', 'Resume'],
]);
const validPage = page => TEAMS_SETTINGS_PAGES.some(([id]) => id === page);
const text = value => ({ type: 'TextBlock', text: String(value).slice(0, 2400), wrap: true });

export function teamsSettingsUi(stateId) {
  const execute = (title, verb, data = {}, associatedInputs = 'auto') => {
    const payload = { ...data, cgAction: verb, stateId };
    return { type: 'Action.Execute', title: String(title).slice(0, 80), verb, data: payload, associatedInputs,
      fallback: { type: 'Action.Submit', title: String(title).slice(0, 80), data: payload, associatedInputs } };
  };
  return {
    text, execute,
    heading: value => ({ ...text(value), weight: 'Bolder', separator: true }),
    buttons: actions => ({ type: 'ActionSet', actions }),
    choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, style: 'compact',
      value: String(value ?? ''), choices: choices.map(item => ({ title: String(item.title || item.label || item.value).slice(0, 100), value: String(item.value) })) }),
    input: (id, label, value = '') => ({ type: 'Input.Text', id, label, value: String(value), maxLength: 8000,
      // Teams supports client-side masking as an extension to the Adaptive Card input style.
      ...(['variableValue', 'composioToken', 'toolboxToken', 'makeToolboxKey'].includes(id) ? { style: 'password' } : {}) }),
  };
}

export function createTeamsSettingsContext(state, { connector, authorize }) {
  const context = { state, connector, ownerId: state.message.userId,
    channelId: state.message.conversationId, sessionKey: state.sessionKey, entry: state.entry, meta: state.meta };
  context.authorize = async () => {
    const fresh = await authorize({ channelId: context.channelId, slug: state.entry.slug, ownerId: context.ownerId }, { connector });
    // Roles/policy may have changed during the roster request. Read them again after it returns.
    const persisted = await getChannelMeta(state.entry.slug);
    const userIsAdmin = await isAdmin(context.ownerId);
    const userIsApproved = await isApproved(context.ownerId);
    const meta = persisted || fresh.meta;
    if (!meta || !isAuthorized(meta, context.ownerId, Boolean(meta.isDM), { isAdminUser: userIsAdmin, isApprovedUser: userIsApproved })) {
      throw new Error('Your access to these settings has changed.');
    }
    Object.assign(context, { meta, entry: fresh.entry || state.entry, userIsAdmin, userIsApproved, members: fresh.members });
    state.meta = meta;
    return context;
  };
  context.patch = async updater => {
    const fresh = await context.authorize();
    let before;
    const after = await patchChannelMeta(state.entry.slug, current => {
      if (!current || !isAuthorized(current, context.ownerId, Boolean(current.isDM), {
        isAdminUser: fresh.userIsAdmin, isApprovedUser: fresh.userIsApproved,
      })) throw new Error('Your access to these settings has changed.');
      before = current;
      return typeof updater === 'function' ? updater(current, fresh) : updater;
    });
    await logChannelPolicyChange({ channelId: context.channelId, slug: state.entry.slug,
      actor: context.ownerId, before, after, source: 'teams_settings' });
    context.meta = after; state.meta = after;
    return after;
  };
  return context;
}

function automations(ctx, ui) {
  const rows = listForChannel(ctx.channelId);
  const pages = Math.max(1, Math.ceil(rows.length / 12));
  const page = Math.min(Math.max(0, Number.isSafeInteger(ctx.state.automationPage) ? ctx.state.automationPage : 0), pages - 1);
  const body = [ui.heading('Automations'), ui.text(`${rows.length} automations — page ${page + 1}/${pages}. Times are shown in ${daemonTimeZone()}. Ask the agent to create a task or reminder.`)];
  for (const row of rows.slice(page * 12, (page + 1) * 12)) {
    const next = row.runAt || (row.enabled && row.cron ? nextCronRun(row.cron) : null);
    body.push(ui.heading(String(row.description || row.loopReason || row.prompt || row.id).slice(0, 120)),
      ui.text(`${row.loop ? 'Loop' : row.kind === 'reminder' ? 'Reminder' : 'Task'} · ${row.enabled ? 'On' : 'Paused'}${row.cron ? ` · ${row.cron}` : ''}${next ? ` · Next: ${zonedStamp(next)}` : ''}${row.loop ? ` · Ticks remaining: ${row.ticksRemaining ?? '—'}` : ''}`),
      ui.text(`Creator: ${String(row.createdBy || 'Unknown').slice(0, 100)} · Last status: ${String(row.lastStatus || 'Not run yet').slice(0, 120)}`));
    const actions = [];
    if (!row.loop && !row.once && !row.runAt) actions.push(ui.execute(row.enabled ? 'Pause' : 'Resume', 'settings.automation.toggle', { id: row.id, enabled: !row.enabled }, 'none'));
    actions.push(ui.execute(row.loop ? 'Stop loop' : row.once || row.runAt ? 'Cancel' : 'Delete', 'settings.automation.delete', { id: row.id }, 'none'));
    body.push(ui.buttons(actions));
  }
  if (!rows.length) body.push(ui.text('No automations for this conversation.'));
  const actions = [];
  if (page) actions.push(ui.execute('Previous', 'settings.automation.page', { page: page - 1 }, 'none'));
  if (page + 1 < pages) actions.push(ui.execute('Next', 'settings.automation.page', { page: page + 1 }, 'none'));
  return { body, actions };
}

async function resume(ctx, ui) {
  const current = await resolveResumeSession({ entry: ctx.entry, meta: effectiveMeta(ctx.meta), isAdminAuthor: ctx.userIsAdmin }, ctx.sessionKey);
  const body = [ui.heading('Resume Session')];
  if (!current.command) body.push(ui.text(current.inThread ? 'This session has not run a turn yet.' : 'Open settings from the session you want to resume.'));
  else body.push(ui.text(`Engine: ${current.engine}`), ui.text(`Session: ${current.sessionId}`), ui.text(`Folder: ${current.workDir}`),
    { ...ui.input('resumeCommand', 'Copy terminal command', current.command), isMultiline: true });
  return { body, actions: [] };
}

export async function buildTeamsSettings(ctx, stateId) {
  const ui = teamsSettingsUi(stateId);
  const page = validPage(ctx.state.tab) ? ctx.state.tab : 'general';
  ctx.state.tab = page;
  const content = page === 'general' ? await renderGeneral(ctx, ui)
    : page === 'automations' ? automations(ctx, ui)
      : page === 'resume' ? await resume(ctx, ui) : await renderCatalogPage(page, ctx, ui);
  // Three tabs per row keeps every page visible without exceeding Teams' action-row limit.
  const tabs = TEAMS_SETTINGS_PAGES.map(([id, title]) => ui.execute(id === page ? `• ${title}` : title, 'settings.page', { page: id }, 'none'));
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [ui.heading('Channel settings'), ui.text(`Settings for ${ctx.entry.name || 'this conversation'}. Changes apply to the next turn.`),
      ui.buttons(tabs.slice(0, 3)), ui.buttons(tabs.slice(3)),
      ...(ctx.state.notice ? [ui.text(ctx.state.notice)] : []), ...content.body], actions: content.actions || [] };
}

const destructive = (action, data) => action.endsWith('.remove') || action.endsWith('.delete') || action === 'settings.thread.reset'
  || (['settings.cloud.toggle', 'settings.skills.toggle'].includes(action) && data.activate === false);
const confirmationFields = new Set(['scope', 'variableScope', 'name', 'id', 'key', 'engine', 'activate', 'connection', 'field']);
function confirmationDetails(action, data, ctx) {
  const name = String(data.name || data.key || '').slice(0, 100);
  if (action === 'settings.variable.remove') return `Remove the ${data.variableScope} variable ${name}?`;
  if (action === 'settings.connections.remove') return `Disconnect the ${data.connection} connection for this conversation?`;
  if (action === 'settings.thread.reset') return 'Clear this session’s engine, model and effort overrides?';
  if (action === 'settings.automation.delete') {
    const row = listForChannel(ctx.channelId).find(item => item.id === data.id);
    if (!row) throw new Error('This automation is no longer in this conversation.');
    return `Remove automation: ${String(row.description || row.loopReason || row.prompt || row.id).slice(0, 120)}?`;
  }
  return `Deactivate ${name} for this conversation?`;
}

export async function handleTeamsSettings(action, data, ctx, stateId) {
  const ui = teamsSettingsUi(stateId);
  await ctx.authorize();
  if (action === 'settings.page') {
    if (!validPage(data.page)) throw new Error('Unknown settings page.');
    ctx.state.tab = data.page; ctx.state.notice = ''; ctx.state.confirmation = null;
    return buildTeamsSettings(ctx, stateId);
  }
  if (action === 'settings.confirm.cancel') {
    ctx.state.confirmation = null;
    return buildTeamsSettings(ctx, stateId);
  }
  if (action === 'settings.confirm') {
    const pending = ctx.state.confirmation;
    if (!pending || pending.token !== data.token) throw new Error('This confirmation is no longer available.');
    ctx.state.confirmation = null; // Consume before applying; replay can never apply twice.
    action = pending.action; data = pending.data; ctx.confirmed = true;
  } else if (destructive(action, data)) {
    const details = confirmationDetails(action, data, ctx);
    const token = randomUUID();
    ctx.state.confirmation = { token, action, data: Object.fromEntries(Object.entries(data).filter(([key]) => confirmationFields.has(key))) };
    return { type: 'AdaptiveCard', version: '1.4', body: [ui.heading('Confirm change'),
      ui.text(details)], actions: [
      ui.execute('Confirm', 'settings.confirm', { token }, 'none'), ui.execute('Cancel', 'settings.confirm.cancel', {}, 'none')] };
  }
  if (action.startsWith('settings.automation.')) {
    if (action === 'settings.automation.page') {
      if (!Number.isSafeInteger(data.page) || data.page < 0) throw new Error('Unknown automations page.');
      ctx.state.automationPage = data.page; ctx.state.tab = 'automations';
      return buildTeamsSettings(ctx, stateId);
    }
    const row = listForChannel(ctx.channelId).find(item => item.id === data.id);
    if (!row) throw new Error('This automation is no longer in this conversation.');
    if (action === 'settings.automation.delete') {
      deleteSchedule(row.id, ctx.channelId);
      await logEvent('schedule_deleted', { channel: ctx.channelId, slug: ctx.entry.slug, schedule: row.id, author: ctx.ownerId, via: 'teams_settings' });
      ctx.state.notice = 'Automation removed.';
    } else if (action === 'settings.automation.toggle') {
      if (typeof data.enabled !== 'boolean' || row.loop || row.once || row.runAt) throw new Error('Only recurring automations can be paused or resumed.');
      if (data.enabled && !row.enabled && countEnabledForChannel(ctx.channelId) >= getScheduleMaxPerChannel()) throw new Error('This conversation has reached its enabled automation limit.');
      updateSchedule(row.id, { enabled: data.enabled });
      await logEvent('schedule_updated', { channel: ctx.channelId, slug: ctx.entry.slug, schedule: row.id, enabled: data.enabled, author: ctx.ownerId, via: 'teams_settings' });
      ctx.state.notice = data.enabled ? 'Automation resumed.' : 'Automation paused.';
    } else throw new Error('Unknown automation action.');
    ctx.state.tab = 'automations';
  } else if (!await handleGeneral(action, data, ctx, ui) && !await handleCatalogAction(action, data, ctx, ui)) {
    throw new Error('Unsupported settings action.');
  }
  await ctx.authorize();
  return buildTeamsSettings(ctx, stateId);
}
