// Teams' conversation settings console. The opaque card state owns conversation/session authority;
// submitted fields are values only; pending edits live in bounded, expiring daemon memory.
import { randomUUID } from 'node:crypto';
import { getChannelMeta, patchChannelMeta, isAdmin, isApproved } from '../../config/store.js';
import { isAuthorized } from '../../gateway/modes.js';
import { logChannelPolicyChange } from '../../config/channel-audit.js';
import { listForChannel } from '../../config/schedules.js';
import { resolveResumeSession } from '../../slack/resume-session.js';
import { effectiveMeta } from '../../gateway/run.js';
import { renderGeneral, handleGeneral, captureGeneralDraft } from './settings-general.js';
import { handleCatalogAction } from './settings-catalog.js';
import { captureCatalogDraft, renderDraftCatalogPage, handleDraftCatalogAction } from './settings-drafts.js';
import { renderAutomations, handleAutomations } from './settings-automations.js';
import { settingsPanels } from './settings-layout.js';

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
    buttons: actions => ({ type: 'ActionSet', spacing: 'Small', actions }),
    choice: (id, label, value, choices) => ({ type: 'Input.ChoiceSet', id, label, style: 'compact',
      value: String(value ?? ''), choices: choices.map(item => ({ title: String(item.title || item.label || item.value).slice(0, 100), value: String(item.value) })) }),
    input: (id, label, value = '') => ({ type: 'Input.Text', id, label, value: String(value), maxLength: 8000,
      // Teams supports client-side masking as an extension to the Adaptive Card input style.
      ...(['variableValue', 'composioToken', 'toolboxToken', 'makeToolboxKey'].includes(id) ? { style: 'password' } : {}) }),
  };
}

export function createTeamsSettingsContext(state, { connector, authorize }) {
  const context = { state, connector, ownerId: state.message.userId,
    channelId: state.message.conversationId, sessionKey: state.sessionKey, entry: state.entry, meta: state.meta,
    isShared: state.sharedSettings === true };
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

async function resume(ctx, ui) {
  const current = await resolveResumeSession({ entry: ctx.entry, meta: effectiveMeta(ctx.meta), isAdminAuthor: ctx.userIsAdmin && !ctx.isShared }, ctx.sessionKey);
  const body = [ui.heading('Resume Session')];
  if (!current.command) body.push(ui.text(current.sessionId && ctx.isShared
    ? 'This session has a private administrator runtime. Open Resume in authenticated settings.'
    : current.inThread ? 'This session has not run a turn yet.' : 'Open settings from the session you want to resume.'));
  else body.push(ui.text(`Engine: ${current.engine}`), ui.text(`Session: ${current.sessionId}`), ui.text(`Folder: ${current.workDir}`),
    { ...ui.input('resumeCommand', 'Copy terminal command', current.command), isMultiline: true });
  return { body, actions: [] };
}

export async function buildTeamsSettings(ctx, stateId) {
  const ui = teamsSettingsUi(stateId);
  const page = validPage(ctx.state.tab) ? ctx.state.tab : '';
  ctx.state.tab = page;
  const content = page === 'general' ? await renderGeneral(ctx, ui)
    : page === 'automations' ? renderAutomations(ctx, ui)
      : page === 'resume' ? await resume(ctx, ui)
        : page ? await renderDraftCatalogPage(page, ctx, ui) : { body: [], actions: [] };
  // Two tabs per row keep long labels readable in narrow Teams/mobile surfaces.
  const tabs = TEAMS_SETTINGS_PAGES.map(([id, title]) => ui.execute(id === page ? `✓ ${title}` : title, 'settings.page', { page: id }, 'auto'));
  const sectionTitle = TEAMS_SETTINGS_PAGES.find(([id]) => id === page)?.[1];
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    msteams: { width: 'Full' },
    body: [{ ...ui.text('Channel settings'), size: 'Large', weight: 'Bolder', spacing: 'None' },
      { ...ui.text(ctx.entry.name || 'This conversation'), size: 'Small', isSubtle: true, spacing: 'Small' },
      ...(ctx.isShared ? [{ ...ui.text('Your controls · Other members can open /settings'), size: 'Small', isSubtle: true, spacing: 'Small' }] : []),
      ui.buttons(tabs.slice(0, 2)), ui.buttons(tabs.slice(2, 4)), ui.buttons(tabs.slice(4)),
      ...(ctx.state.notice ? [{ type: 'Container', style: 'emphasis', spacing: 'Medium', items: [{ ...ui.text(ctx.state.notice), size: 'Small' }] }] : []),
      ...(page ? settingsPanels(content, sectionTitle) : [{ ...ui.text('Choose a section to edit its settings.'), size: 'Small', isSubtle: true, spacing: 'Medium' }])], actions: [] };
}

const destructive = (action, data) => !action.startsWith('settings.draft.') && (action.endsWith('.remove') || action.endsWith('.delete') || action === 'settings.thread.reset'
  || (['settings.cloud.toggle', 'settings.skills.toggle'].includes(action) && data.activate === false));
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
  if (action === 'settings.page' && ctx.state.tab === 'general') captureGeneralDraft(data, ctx);
  if ((action.startsWith('settings.draft.') && action !== 'settings.draft.discard') || ['settings.page', 'settings.catalog.page'].includes(action)) captureCatalogDraft(data, ctx);
  if (ctx.isShared && action.startsWith('settings.variable.') && data.variableScope !== 'channel') {
    throw new Error('Personal and organization variables require authenticated settings.');
  }
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
  if (await handleDraftCatalogAction(action, data, ctx) || await handleAutomations(action, data, ctx, ui)) {
    // Drafts and their two scope Apply actions own all newly rendered editable catalog controls.
  } else if (!await handleGeneral(action, data, ctx, ui) && !await handleCatalogAction(action, data, ctx, ui)) {
    throw new Error('Unsupported settings action.');
  }
  await ctx.authorize();
  return buildTeamsSettings(ctx, stateId);
}
