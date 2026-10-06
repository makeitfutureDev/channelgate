// Teams General Settings use the same runtime stores and channel policy as Slack. Every Apply
// action reads one input only; stale neighbouring inputs can never overwrite newer settings.
import { getEngine, getEnabledEngines, getDefaultModel } from '../../config/settings.js';
import { engineLabel, modelBelongsToEngine, effortBelongsToModel, modelsForEngine, effortsForModel } from '../../engines/registry.js';
import { effectiveMeta } from '../../gateway/run.js';
import { channelMode, modeSettingsPatch, canManage, isAuthorized, networkLabel } from '../../gateway/modes.js';
import { getThreadEngine, getThreadModel, getThreadEffort, resolveThreadEngine, setThreadEngine, setThreadModel, setThreadEffort } from '../../gateway/thread-engine.js';
import { getSessionEngine } from '../../gateway/sessions.js';
import { RUNTIME_DEFAULT_VALUE, RUNTIME_FIELDS, nextRuntimeTriple, runtimeSettingsPatch } from '../../gateway/runtime-settings.js';
import { channelCodexLoginStatus } from '../../gateway/channel-codex-login.js';
import { unconfiguredChannelVpnStatus, getChannelVpnStatus, setChannelVpnEnabled } from '../../gateway/channel-vpn-control.js';
import { toConversationId } from './connector.js';
import { acquireKeyedLock } from '../../util/keyed-lock.js';
import { logEvent } from '../../util/logger.js';

const accessChoices = {
  mode: [{ label: 'Read-only', value: 'read' }, { label: 'Worker', value: 'worker' }, { label: 'Admin (full access)', value: 'admin' }],
  access: [{ label: 'Approved members', value: 'approved' }, { label: 'Admins only', value: 'admins' }, { label: 'Locked — named users only', value: 'none' }],
  manageAccess: [{ label: 'Org admins only', value: 'admins' }, { label: 'Approved channel members', value: 'members' }, { label: 'Named managers', value: 'custom' }],
};
const labels = { mode: 'Mode', access: 'Who can use it here', manageAccess: 'Who can manage this channel', autoMode: 'Auto — automatically approve tool requests', cleanMode: 'Lean — bare model without skills or connectors', allowNetwork: 'Allow network', allowedUsers: 'Guest access — named users', managers: 'Named managers' };
const flagFields = ['autoMode', 'cleanMode', 'allowNetwork'];
const namedFields = ['allowedUsers', 'managers'];
// Full rosters are repeated for two native multi-selects. Bound this to keep the entire card
// below Teams' payload limit; large rosters use the authenticated browser's channel editor.
const MAX_NATIVE_ROSTER = 25;
const MAX_GENERAL_BODY_BYTES = 20_000; // Reserve room for navigation, notices and the attachment.
const actor = ctx => ({ authorId: ctx.ownerId, isAdminUser: Boolean(ctx.userIsAdmin), isApprovedUser: Boolean(ctx.userIsApproved) });
const managed = (meta, ctx) => isAuthorized(meta, ctx.ownerId, Boolean(meta.isDM), actor(ctx)) && canManage(meta, actor(ctx));
const defaultChoice = label => ({ label, value: RUNTIME_DEFAULT_VALUE });
const compatible = (candidates, engine) => candidates.find(value => value && modelBelongsToEngine(value, engine)) || '';
const parentEngine = meta => meta.codexAuthSource === 'channel' ? 'codex' : effectiveMeta({ ...meta, engine: '' }).engine || getEngine();

export async function generalRuntimeScopes(ctx) {
  const meta = ctx.meta, effective = effectiveMeta(meta), locked = meta.codexAuthSource === 'channel';
  const engine = locked ? 'codex' : effective.engine || getEngine();
  const inheritedModel = compatible([effectiveMeta({ ...meta, model: '' }).model, getDefaultModel(engine)], engine);
  const model = compatible([effective.model, inheritedModel], engine);
  const inheritedEffort = effectiveMeta({ ...meta, effort: '' }).effort || '';
  const efforts = effortsForModel(engine, model);
  const engines = (locked ? ['codex'] : getEnabledEngines()).map(value => ({ label: engineLabel(value), value }));
  const channel = {
    engine, model,
    values: { engine: locked ? 'codex' : meta.engine || '', model: meta.model || '', effort: meta.effort || '' },
    inherited: { engine: `Inherited default (${engineLabel(parentEngine(meta))})`, model: inheritedModel ? `Inherited default (${inheritedModel})` : 'Engine default', effort: inheritedEffort && efforts.includes(inheritedEffort) ? `Inherited default (${inheritedEffort})` : 'Engine default' },
    engines,
  };
  if (!ctx.sessionKey) return { channel, thread: null, locked };
  const [pin, pinModel, pinEffort, activeEngine, mintedEngine] = await Promise.all([
    getThreadEngine(ctx.entry.slug, ctx.sessionKey), getThreadModel(ctx.entry.slug, ctx.sessionKey), getThreadEffort(ctx.entry.slug, ctx.sessionKey), resolveThreadEngine(ctx.entry.slug, ctx.sessionKey, effective),
    getSessionEngine(ctx.entry.slug, ctx.sessionKey),
  ]);
  const inheritedThreadModel = compatible([model, getDefaultModel(activeEngine)], activeEngine);
  const threadModel = compatible([pinModel, inheritedThreadModel], activeEngine);
  const threadEffort = effective.effort && effortBelongsToModel(effective.effort, activeEngine, threadModel) ? effective.effort : '';
  const sessionEngine = !pin && activeEngine !== engine ? activeEngine : '';
  const source = sessionEngine ? 'Session default' : 'Follow channel';
  return { channel, locked, thread: {
    engine: activeEngine, model: threadModel, engines, sessionEngine,
    values: { engine: locked ? 'codex' : pin, model: pinModel, effort: pinEffort },
    inherited: { engine: `${mintedEngine && mintedEngine !== engine ? 'Session default' : 'Follow channel'} (${engineLabel(locked ? 'codex' : mintedEngine || engine)})`, model: inheritedThreadModel ? `${source} (${inheritedThreadModel})` : `${source} (engine default)`, effort: threadEffort ? `${source} (${threadEffort})` : `${source} (engine default)` },
  } };
}

async function roster(ctx) {
  if (!ctx.connector?.api?.listMembers) throw new Error('Current Teams membership is unavailable.');
  const members = await ctx.connector.api.listMembers(toConversationId(ctx.channelId));
  return members.filter(member => typeof member.id === 'string' && member.id && member.id.length <= 256 && !member.id.includes(',') && !member.id.startsWith('28:') && member.id !== ctx.connector.botId);
}

function runtimeRows(scope, snapshot, locked, ui) {
  const body = [];
  for (const field of RUNTIME_FIELDS) {
    if (field === 'engine' && locked) { body.push(ui.text('Engine: Codex — locked to this channel’s Codex login.')); continue; }
    let choices = field === 'engine' ? snapshot.engines : field === 'model' ? modelsForEngine(snapshot.engine) : effortsForModel(snapshot.engine, snapshot.model).map(value => ({ label: value, value }));
    // Keep a saved compatible full model ID visible even if live discovery no longer lists it.
    const selected = snapshot.values[field];
    if (field === 'model' && selected && modelBelongsToEngine(selected, snapshot.engine) && !choices.some(item => item.value === selected)) choices = [...choices, { label: `Current: ${selected}`, value: selected }];
    body.push(ui.choice(`${scope}_${field}`, field[0].toUpperCase() + field.slice(1), selected || RUNTIME_DEFAULT_VALUE, [defaultChoice(snapshot.inherited[field]), ...choices]));
    body.push(ui.buttons([ui.execute(`Apply ${scope} ${field}`, 'settings.runtime', { scope, field })]));
  }
  return body;
}

export async function renderGeneral(ctx, ui) {
  const { channel, thread, locked } = await generalRuntimeScopes(ctx);
  const meta = effectiveMeta(ctx.meta), manager = managed(ctx.meta, ctx);
  const body = [ui.text('Apply each field separately. Channel defaults affect new sessions; current session overrides apply to this session.'), ui.heading('Channel defaults'), ...runtimeRows('channel', channel, locked, ui)];
  if (locked) {
    const login = await channelCodexLoginStatus(ctx.channelId);
    body.push(ui.text(`Channel Codex login: ${login.authenticated ? 'Signed in' : login.phase === 'pending' ? 'Sign-in in progress' : 'No channel login yet'}.`));
  }
  if (thread) {
    body.push(ui.heading('Current session'), ...runtimeRows('thread', thread, locked, ui));
    if (thread.sessionEngine) body.push(ui.text(`This session already runs on ${engineLabel(thread.sessionEngine)}. A channel default does not replace its live engine; choose an engine here to switch it.`));
    body.push(ui.buttons([ui.execute('Follow channel default', 'settings.thread.reset', {}, 'none')]));
  }
  body.push(ui.heading(ctx.meta.isDM ? 'Mode and network' : 'Access'), ui.text('Only current managers can change channel access settings. Admin tool permissions still require an admin author.'));
  if (manager || ctx.meta.isDM) {
    const fields = ctx.meta.isDM ? ['mode', ...flagFields.filter(field => field !== 'allowNetwork')] : [...Object.keys(accessChoices), ...flagFields];
    for (const field of fields) {
      const value = field === 'mode' ? channelMode(meta) : field === 'access' ? meta.access || 'approved' : field === 'manageAccess' ? meta.manageAccess || 'admins' : meta[field] ? 'on' : 'off';
      const choices = accessChoices[field] || [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }];
      body.push(ui.choice(`access_${field}`, labels[field], value, choices), ui.buttons([ui.execute(`Apply ${labels[field].split(' — ')[0]}`, 'settings.access', { field })]));
    }
    if (!ctx.meta.isDM) {
      try {
        const members = await roster(ctx);
        const namedRows = [];
        for (const field of namedFields) {
          const selected = Array.isArray(meta[field]) ? meta[field] : [];
          if (members.length > MAX_NATIVE_ROSTER) {
            body.push(ui.text(`${labels[field]}: ${selected.length} saved. This conversation has ${members.length} members; edit the complete list in the authenticated channel settings website.`));
            continue;
          }
          if (selected.some(id => !members.some(member => member.id === id))) namedRows.push(ui.text(`${labels[field]} includes former members. Applying this field replaces it with the current members selected below.`));
          namedRows.push({ type: 'Input.ChoiceSet', id: `access_${field}`, label: labels[field], isMultiSelect: true, style: 'compact', value: selected.filter(id => members.some(member => member.id === id)).join(','), choices: members.map(member => ({ title: String(member.name || member.email || member.id).slice(0, 80), value: member.id })) });
          namedRows.push(ui.buttons([ui.execute(`Apply ${labels[field]}`, 'settings.access', { field })]));
        }
        if (Buffer.byteLength(JSON.stringify([...body, ...namedRows])) <= MAX_GENERAL_BODY_BYTES) body.push(...namedRows);
        else body.push(ui.text('The complete member selectors are too large for this Teams card. Edit guest access and named managers in the authenticated channel settings website. All saved selections remain unchanged.'));
      } catch { body.push(ui.text('Named users cannot be edited until current Teams membership is available.')); }
    }
  } else body.push(ui.text(`Mode: ${channelMode(meta)}${meta.autoMode ? ' · Auto' : ''}${meta.cleanMode ? ' · Lean' : ''}. Only current managers can change channel access settings.`));
  body.push(ui.text(networkLabel(meta, { detail: true })));
  let vpn = unconfiguredChannelVpnStatus(ctx.meta);
  if (!vpn) { try { vpn = await getChannelVpnStatus(ctx.channelId); } catch { vpn = { state: 'unavailable', message: 'VPN status is unavailable for this Teams conversation.' }; } }
  body.push(ui.heading('VPN'), ui.text(vpn.message || `VPN: ${vpn.state}`));
  if (vpn.configured && manager && !vpn.busy && vpn.state !== 'unavailable') {
    const enabled = !(vpn.enabled || vpn.running || ['on', 'starting'].includes(vpn.state));
    if (!enabled || (vpn.allowNetwork && !vpn.missingSecrets?.length && vpn.state !== 'stopping')) body.push(ui.buttons([ui.execute(enabled ? 'Enable VPN' : 'Disable VPN', 'settings.vpn', { enabled }, 'none')]));
  }
  return { body, actions: [] };
}

function assertCurrentAuthorized(ctx, meta = ctx.meta) {
  if (!isAuthorized(meta, ctx.ownerId, Boolean(meta.isDM), actor(ctx))) throw new Error('You are no longer authorized to use this conversation.');
}
function assertManager(ctx, meta) {
  assertCurrentAuthorized(ctx, meta);
  if (meta.isDM || !canManage(meta, actor(ctx))) throw new Error('Only admins and current channel managers can change access settings.');
}
function requireSession(ctx) {
  if (!ctx.sessionKey) throw new Error('Open Settings from the session you want to change.');
  return ctx.sessionKey;
}
function readRuntimeInput(data, scope, field) {
  const value = data[`${scope}_${field}`];
  if (typeof value !== 'string' || value.length > 128) throw new Error('Select a runtime value and try again.');
  return value === RUNTIME_DEFAULT_VALUE ? '' : value.trim();
}
function validatedSelection(current, field, value, inheritedEngine) {
  // Validate the submitted field before dependent fields are cleared. A forged model must
  // produce an error rather than silently clearing the existing model.
  const selected = { ...current, [field]: value };
  if (field !== 'engine') runtimeSettingsPatch({ ...selected, effort: field === 'model' ? '' : selected.effort }, { gatewayEngine: inheritedEngine });
  const next = nextRuntimeTriple(current, field, value, inheritedEngine);
  return runtimeSettingsPatch(next, { gatewayEngine: inheritedEngine }).patch;
}

export async function handleGeneral(action, data, ctx, _ui) {
  if (action === 'settings.runtime') {
    const { scope, field } = data;
    if (!['channel', 'thread'].includes(scope) || !RUNTIME_FIELDS.includes(field)) throw new Error('Unknown runtime control.');
    const value = readRuntimeInput(data, scope, field);
    if (scope === 'channel') {
      ctx.meta = await ctx.patch((current, fresh) => {
        assertCurrentAuthorized(fresh, current);
        if (field === 'engine' && current.codexAuthSource === 'channel') throw new Error('This channel uses its own Codex login, so its engine is Codex.');
        const own = { engine: current.codexAuthSource === 'channel' ? 'codex' : current.engine || '', model: current.model || '', effort: current.effort || '' };
        return validatedSelection(own, field, value, parentEngine(current));
      });
    } else {
      const session = requireSession(ctx), release = await acquireKeyedLock('teams-settings-runtime', `${ctx.entry.slug}:${session}`);
      try {
        const fresh = await ctx.authorize(); assertCurrentAuthorized(fresh);
        if (field === 'engine' && fresh.meta.codexAuthSource === 'channel') throw new Error('This channel uses its own Codex login, so its engine is Codex.');
        const [engine, model, effort, mintedEngine] = await Promise.all([getThreadEngine(ctx.entry.slug, session), getThreadModel(ctx.entry.slug, session), getThreadEffort(ctx.entry.slug, session), getSessionEngine(ctx.entry.slug, session)]);
        const latest = await ctx.authorize(); assertCurrentAuthorized(latest);
        const inheritedEngine = latest.meta.codexAuthSource === 'channel' ? 'codex' : mintedEngine || effectiveMeta(latest.meta).engine || getEngine();
        const next = validatedSelection({ engine: latest.meta.codexAuthSource === 'channel' ? 'codex' : engine, model, effort }, field, value, inheritedEngine);
        if (latest.meta.codexAuthSource === 'channel' && (field === 'engine' || next.engine && next.engine !== 'codex')) throw new Error('This channel uses its own Codex login, so its engine is Codex.');
        await Promise.all([setThreadEngine(ctx.entry.slug, session, latest.meta.codexAuthSource === 'channel' ? '' : next.engine), setThreadModel(ctx.entry.slug, session, next.model), setThreadEffort(ctx.entry.slug, session, next.effort)]);
      } finally { release(); }
    }
    ctx.state.notice = `${scope === 'channel' ? 'Channel default' : 'Current session'} ${field} updated. Applies to the next turn.`;
    await logEvent(scope === 'channel' ? 'channel_runtime_updated' : 'thread_runtime_updated', { channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, field });
    return true;
  }
  if (action === 'settings.thread.reset') {
    const session = requireSession(ctx), release = await acquireKeyedLock('teams-settings-runtime', `${ctx.entry.slug}:${session}`);
    try {
      const fresh = await ctx.authorize(); assertCurrentAuthorized(fresh);
      await Promise.all([setThreadEngine(ctx.entry.slug, session, ''), setThreadModel(ctx.entry.slug, session, ''), setThreadEffort(ctx.entry.slug, session, '')]);
    } finally { release(); }
    ctx.state.notice = 'Session overrides cleared. Its model and effort follow channel defaults; an existing session retains its engine until you explicitly switch it.';
    return true;
  }
  if (action === 'settings.access') {
    const field = data.field;
    if (![...Object.keys(accessChoices), ...flagFields, ...namedFields].includes(field)) throw new Error('Unknown access control.');
    const raw = data[`access_${field}`];
    if (typeof raw !== 'string' && !(namedFields.includes(field) && raw === undefined)) throw new Error('Select an access value and try again.');
    let value = raw;
    if (accessChoices[field] && !accessChoices[field].some(option => option.value === value)) throw new Error('Invalid access setting.');
    if (flagFields.includes(field)) { if (!['on', 'off'].includes(value)) throw new Error('Invalid access option.'); value = value === 'on'; }
    if (namedFields.includes(field)) {
      value = [...new Set(String(raw || '').split(',').map(id => id.trim()).filter(Boolean))];
      if (value.length > 100) throw new Error('Choose up to 100 current members.');
      const fresh = await ctx.authorize(); assertManager(fresh, fresh.meta);
      const members = await roster(fresh);
      if (value.some(id => !members.some(member => member.id === id))) throw new Error('Named users must be current conversation members.');
    }
    ctx.meta = await ctx.patch((current, fresh) => {
      if (current.isDM) {
        assertCurrentAuthorized(fresh, current);
        if (!['mode', 'autoMode', 'cleanMode'].includes(field)) throw new Error('This setting is managed by the DM template.');
      } else assertManager(fresh, current);
      // Revalidate against the roster obtained at this write's authorization boundary.
      if (namedFields.includes(field) && Array.isArray(fresh.members) && value.some(id =>
        id.startsWith('28:') || id === fresh.connector.botId || !fresh.members.some(member => member.id === id))) {
        throw new Error('Named users must still be current human conversation members.');
      }
      const baseline = effectiveMeta(current);
      // Current channel managers may enable Admin just as Slack Access does. DM Admin remains
      // admin-only. Actual tool bypass still checks the author at every run.
      const patch = field === 'mode' ? modeSettingsPatch(baseline, { mode: value }, { canEnableAdmin: !current.isDM || fresh.userIsAdmin }) : ['autoMode', 'cleanMode'].includes(field) ? modeSettingsPatch(baseline, { [field]: value }, { isAdminUser: fresh.userIsAdmin }) : { [field]: value };
      return current.isDM && ['user', 'admin'].includes(current.template) ? { ...baseline, ...patch, template: 'custom' } : patch;
    });
    ctx.state.notice = 'Access setting saved. Applies to this conversation’s next runs.';
    return true;
  }
  if (action === 'settings.vpn') {
    if (typeof data.enabled !== 'boolean') throw new Error('Invalid VPN setting.');
    await setChannelVpnEnabled(ctx.channelId, data.enabled, { actor: ctx.ownerId, source: 'teams-settings', authorize: async () => { const fresh = await ctx.authorize(); return managed(fresh.meta, fresh); } });
    ctx.state.notice = 'VPN request completed. Status reflects the current service state.';
    return true;
  }
  return false;
}
