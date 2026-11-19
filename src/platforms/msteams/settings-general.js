import { assertEngineSelectable } from "../../engines/selection.js";
// Teams General Settings share Slack's stores/policy. Runtime forms save one complete scope;
// legacy per-field actions remain valid for previously posted cards.
//
// What runs is chosen as Harness → License → model → effort (src/gateway/license-pool.js). The
// Harness control keeps the input id `<scope>_engine`; the license step is `<scope>_license` and
// `<scope>_also`, and exists only while the harness has several licenses usable here. What is
// stored is unchanged: the first license as `engine`, the rest as `licensePool` beside it.
import { getEngine, getEnginePool, getDefaultModel } from '../../config/settings.js';
import { engineLabel, harnessOf, isEngineId, modelBelongsToEngine, effortBelongsToModel, modelsForEngine, effortsForModel } from '../../engines/registry.js';
import { harnessLabel, isHarnessId, storeLicensePool } from '../../engines/license-state.js';
import { LICENSE_POOL_ANY, describeSelectionText, harnessSelection, licensePicker, readLicensePool, resolveLicensePick, selectableHarnesses, selectableLicenses } from '../../gateway/license-pool.js';
import { licenseListText, readLicenseChoice } from '../license-choice.js';
import { effectiveMeta } from '../../gateway/run.js';
import { channelMode, modeSettingsPatch, canManage, isAuthorized, networkLabel } from '../../gateway/modes.js';
import { getThreadEngine, getThreadModel, getThreadEffort, getThreadLicensePool, resolveThreadEngine, setThreadEngine, setThreadModel, setThreadEffort, setThreadRuntimeOverrides } from '../../gateway/thread-engine.js';
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
const labels = { mode: 'Mode', access: 'Who can use it here', manageAccess: 'Who can manage this channel', autoMode: 'Auto — automatically approve tool requests', cleanMode: 'Lean — bare model without skills or connectors', allowNetwork: 'Allow network', skillRuntimeSwap: 'Skill model swap — a skill’s preferred engine/model may take over the turn', allowedUsers: 'Guest access — named users', managers: 'Named managers' };
const flagFields = ['autoMode', 'cleanMode', 'allowNetwork', 'skillRuntimeSwap'];
const namedFields = ['allowedUsers', 'managers'];
// Full rosters are repeated for two native multi-selects. Bound this to keep the entire card
// below Teams' payload limit; large rosters use the authenticated browser's channel editor.
const MAX_NATIVE_ROSTER = 25;
const MAX_GENERAL_BODY_BYTES = 20_000; // Reserve room for navigation, notices and the attachment.
const actor = ctx => ({ authorId: ctx.ownerId, isAdminUser: Boolean(ctx.userIsAdmin), isApprovedUser: Boolean(ctx.userIsApproved) });
const managed = (meta, ctx) => isAuthorized(meta, ctx.ownerId, Boolean(meta.isDM), actor(ctx)) && canManage(meta, actor(ctx));
const defaultChoice = label => ({ label, value: RUNTIME_DEFAULT_VALUE });
const compatible = (candidates, engine) => candidates.find(value => value && modelBelongsToEngine(value, engine)) || '';
// A selection is compared and drafted as text: "" | "any" | a JSON list (what a thread row stores).
const poolKey = pool => storeLicensePool(readLicensePool(pool));
const SELECTION_FIELDS = Object.freeze([...RUNTIME_FIELDS, 'licensePool']);
const usableHere = (meta, engine) => selectableLicenses(harnessOf(engine), meta).includes(engine);
const describe = (meta, engine, pool) => describeSelectionText({ engine, pool, meta }) || engineLabel(engine);
// What a scope runs on when it names no harness of its own: the DM template's selection, else the
// gateway default's.
function parentSelection(meta) {
  const parent = effectiveMeta({ ...meta, engine: '', licensePool: '' });
  return parent.engine ? { engine: parent.engine, pool: parent.licensePool || '' } : { engine: getEngine(), pool: getEnginePool() };
}
const parentEngine = meta => parentSelection(meta).engine;
// The level ABOVE each scope, in the shape harnessSelection reads: a channel sits on its parent,
// a session on the conversation.
const aboveChannel = meta => { const parent = parentSelection(meta); return { ...meta, engine: parent.engine, licensePool: parent.pool }; };
const aboveThread = meta => effectiveMeta(meta);
const ownChannel = meta => ({ engine: meta.engine || '', model: meta.model || '', effort: meta.effort || '', licensePool: poolKey(meta.licensePool) });
// A pool row means nothing without a pin.
const ownThread = (engine, model, effort, pool) => ({ engine, model, effort, licensePool: engine ? poolKey(pool) : '' });

export async function generalRuntimeScopes(ctx) {
  const meta = ctx.meta, effective = effectiveMeta(meta), locked = false;
  const engine = effective.engine || getEngine();
  const pool = effective.engine ? effective.licensePool || '' : getEnginePool();
  const inheritedModel = compatible([effectiveMeta({ ...meta, model: '' }).model, getDefaultModel(engine)], engine);
  const model = compatible([effective.model, inheritedModel], engine);
  const inheritedEffort = effectiveMeta({ ...meta, effort: '' }).effort || '';
  const efforts = effortsForModel(engine, model);
  const harnesses = selectableHarnesses(meta).map(value => ({ label: harnessLabel(value), value }));
  const parent = parentSelection(meta);
  const channel = {
    engine, pool, model, inheritedEngine: parent.engine,
    values: ownChannel(meta),
    inherited: { engine: `Inherited default (${describe(meta, parent.engine, parent.pool)})`, model: inheritedModel ? `Inherited default (${inheritedModel})` : 'Engine default', effort: inheritedEffort && efforts.includes(inheritedEffort) ? `Inherited default (${inheritedEffort})` : 'Engine default' },
    harnesses,
  };
  if (!ctx.sessionKey) return { channel, thread: null, locked };
  const [pin, pinModel, pinEffort, pinPool, activeEngine, mintedEngine] = await Promise.all([
    getThreadEngine(ctx.entry.slug, ctx.sessionKey), getThreadModel(ctx.entry.slug, ctx.sessionKey), getThreadEffort(ctx.entry.slug, ctx.sessionKey), getThreadLicensePool(ctx.entry.slug, ctx.sessionKey),
    resolveThreadEngine(ctx.entry.slug, ctx.sessionKey, effective), getSessionEngine(ctx.entry.slug, ctx.sessionKey),
  ]);
  const inheritedThreadModel = compatible([model, getDefaultModel(activeEngine)], activeEngine);
  const threadModel = compatible([pinModel, inheritedThreadModel], activeEngine);
  const threadEffort = effective.effort && effortBelongsToModel(effective.effort, activeEngine, threadModel) ? effective.effort : '';
  const sessionEngine = !pin && activeEngine !== engine ? activeEngine : '';
  const source = sessionEngine ? 'Session default' : 'Follow channel';
  return { channel, locked, thread: {
    engine: activeEngine, pool: pin ? pinPool : pool, model: threadModel, harnesses, sessionEngine,
    inheritedEngine: mintedEngine || engine,
    values: ownThread(pin, pinModel, pinEffort, pinPool),
    inherited: { engine: `${mintedEngine && mintedEngine !== engine ? 'Session default' : 'Follow channel'} (${describe(meta, mintedEngine || engine, pool)})`, model: inheritedThreadModel ? `${source} (${inheritedThreadModel})` : `${source} (engine default)`, effort: threadEffort ? `${source} (${threadEffort})` : `${source} (engine default)` },
  } };
}

async function roster(ctx) {
  if (!ctx.listMembers && !ctx.connector?.api?.listMembers) throw new Error('Current conversation membership is unavailable.');
  const members = ctx.listMembers ? await ctx.listMembers() : await ctx.connector.api.listMembers(toConversationId(ctx.channelId));
  return members.filter(member => typeof member.id === 'string' && member.id && member.id.length <= 256 && !member.id.includes(',') &&
    (ctx.isHumanMember ? ctx.isHumanMember(member) : !member.id.startsWith('28:') && member.id !== ctx.connector.botId));
}

// The license step of one picker: License ("Any license" + each), then — for a specific license
// that has others beside it — the licenses to move to when it fails. Nothing at all while the
// harness has a single license usable here.
export function licenseStepRows(ui, prefix, picker) {
  if (!picker.show) return [];
  const rows = [ui.choice(`${prefix}license`, 'License', picker.selected, [{ label: 'Any license', value: LICENSE_POOL_ANY }, ...picker.licenses.map(item => ({ label: item.label, value: item.id }))])];
  if (picker.selected !== LICENSE_POOL_ANY && picker.others.length) {
    rows.push({ type: 'Input.ChoiceSet', id: `${prefix}also`, label: 'If it fails, also use', isMultiSelect: true, style: 'compact',
      value: picker.also.join(','), choices: picker.others.map(item => ({ title: String(item.label).slice(0, 100), value: item.id })) });
  }
  rows.push(ui.text('When a license cannot answer, the turn moves to the next one.'));
  return rows;
}
// Whether any harness offered here has a license step at all — it decides the wording of the
// reload button, so a conversation with one license per harness reads exactly as before.
export const hasLicenseStep = meta => selectableHarnesses(meta).some(harness => selectableLicenses(harness, meta).length > 1);
export const loadLabel = meta => hasLicenseStep(meta) ? 'Load licenses and models' : 'Load models';

function runtimeRows(scope, snapshot, locked, ui, meta) {
  const body = [];
  const models = modelsForEngine(snapshot.engine);
  const efforts = [...new Set([
    ...effortsForModel(snapshot.engine), ...models.flatMap(item => effortsForModel(snapshot.engine, item.value)),
  ])];
  for (const field of RUNTIME_FIELDS) {
    if (field === 'engine') {
      const harness = snapshot.values.engine ? harnessOf(snapshot.values.engine) : '';
      body.push(ui.choice(`${scope}_engine`, 'Harness', harness || RUNTIME_DEFAULT_VALUE, [defaultChoice(snapshot.inherited.engine), ...snapshot.harnesses]));
      if (harness) body.push(...licenseStepRows(ui, `${scope}_`, licensePicker({ harness, meta, engine: snapshot.values.engine, pool: snapshot.values.licensePool })));
      // Teams ChoiceSets do not send change events. Refresh the dependent lists without saving.
      body.push(ui.buttons([ui.execute(loadLabel(meta), 'settings.runtime.models', { scope })]));
      continue;
    }
    let choices = field === 'model' ? models : efforts.map(value => ({ label: value, value }));
    // Keep a saved compatible full model ID visible even if live discovery no longer lists it.
    const saved = snapshot.values[field];
    const selected = field === 'model' && saved && !modelBelongsToEngine(saved, snapshot.engine) ? '' : saved;
    if (field === 'model' && selected && modelBelongsToEngine(selected, snapshot.engine) && !choices.some(item => item.value === selected)) choices = [...choices, { label: `Current: ${selected}`, value: selected }];
    const inherited = field === 'model'
      ? scope === 'thread' ? 'Follow compatible channel model / selected engine default' : 'Default model for selected engine'
      : scope === 'thread' ? 'Follow compatible channel effort / engine default' : 'Engine default';
    body.push(ui.choice(`${scope}_${field}`, field[0].toUpperCase() + field.slice(1), selected || RUNTIME_DEFAULT_VALUE, [defaultChoice(inherited), ...choices]));
  }
  body.push(ui.buttons([ui.execute(scope === 'channel' ? 'Apply to channel' : 'Apply to thread', 'settings.runtime.apply', { scope })]));
  return body;
}

function runtimeDisplay(ctx, scope, snapshot, locked) {
  const draft = ctx.state.runtimeDrafts?.[scope];
  if (!draft) return snapshot;
  const shown = draft.values.engine || snapshot.inheritedEngine;
  if (draft.locked !== locked || draft.inheritedEngine !== snapshot.inheritedEngine ||
    SELECTION_FIELDS.some(field => draft.baseline[field] !== snapshot.values[field]) || !usableHere(ctx.meta, shown)) {
    delete ctx.state.runtimeDrafts[scope];
    return snapshot;
  }
  return { ...snapshot, engine: shown, values: draft.values };
}

// `part` slices the page the way Slack's modal does: 'agent' is the runtime, the mode with its
// options, the network line and the VPN; 'access' is who may use and manage the conversation and
// the named people. Without one (Teams) the page is everything, as before.
export async function renderGeneral(ctx, ui, { part = '' } = {}) {
  const { channel, thread, locked } = await generalRuntimeScopes(ctx);
  ctx.state.runtimeBaseline = { channel: { ...channel.values, locked }, ...(thread ? { thread: { ...thread.values, locked } } : {}) };
  const meta = effectiveMeta(ctx.meta), manager = managed(ctx.meta, ctx);
  const agent = part !== 'access', access = part !== 'agent';
  const steps = hasLicenseStep(ctx.meta)
    ? 'Licenses and models are shown only for the selected harness. After changing Harness or License, use Load licenses and models, then choose model and effort and Apply for that scope.'
    : 'Models are shown only for the selected harness. After changing Harness, use Load models, then choose model and effort and Apply for that scope.';
  const body = !agent ? [] : [ui.text(`${steps} Channel defaults affect new sessions; thread overrides apply to this session.`), ui.heading('Channel defaults'), ...runtimeRows('channel', runtimeDisplay(ctx, 'channel', channel, locked), locked, ui, ctx.meta)];
  if (agent && ctx.meta.codexAuthSource === 'channel') {
    const login = await channelCodexLoginStatus(ctx.channelId).catch(error => {
      if (error.code === "enterprise_required") return { enterpriseRequired: true };
      throw error;
    });
    body.push(ui.text(`Channel Codex login: ${login.enterpriseRequired ? 'Enterprise required; switch to the gateway login in admin Settings to resume runs' : login.authenticated ? 'Signed in' : login.phase === 'pending' ? 'Sign-in in progress' : 'No channel login yet'}.`));
  }
  if (agent && thread) {
    body.push(ui.heading('Current session'), ...runtimeRows('thread', runtimeDisplay(ctx, 'thread', thread, locked), locked, ui, ctx.meta));
    if (thread.sessionEngine) body.push(ui.text(`This session already runs on ${describe(ctx.meta, thread.sessionEngine, thread.pool)}. A channel default does not replace its live engine; choose a harness here to switch it.`));
    body.push(ui.buttons([ui.execute('Follow channel default', 'settings.thread.reset', {}, 'none')]));
  }
  body.push(ui.heading(part === 'agent' ? 'Mode' : ctx.meta.isDM ? 'Mode and network' : 'Access'), ui.text('Only current managers can change channel access settings. Admin tool permissions still require an admin author.'));
  if (manager || ctx.meta.isDM) {
    const policy = ['access', 'manageAccess'];
    const fields = (ctx.meta.isDM ? ['mode', ...flagFields.filter(field => field !== 'allowNetwork')] : [...Object.keys(accessChoices), ...flagFields])
      .filter(field => policy.includes(field) ? access : agent);
    for (const field of fields) {
      const value = field === 'mode' ? channelMode(meta) : field === 'access' ? meta.access || 'approved' : field === 'manageAccess' ? meta.manageAccess || 'admins' : meta[field] ? 'on' : 'off';
      const choices = accessChoices[field] || [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }];
      body.push(ui.choice(`access_${field}`, labels[field], value, choices), ui.buttons([ui.execute(`Apply ${labels[field].split(' — ')[0]}`, 'settings.access', { field })]));
    }
    if (!ctx.meta.isDM && access) {
      if (part) body.push(ui.heading('People'));
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
        else body.push(ui.text('The complete member selectors are too large for this conversation card. Edit guest access and named managers in the authenticated channel settings website. All saved selections remain unchanged.'));
      } catch { body.push(ui.text('Named users cannot be edited until current conversation membership is available.')); }
    }
  } else if (part === 'access') {
    const named = field => accessChoices[field].find(item => item.value === (meta[field] || (field === 'access' ? 'approved' : 'admins')))?.label;
    body.push(ui.text(`${labels.access}: ${named('access')}\n${labels.manageAccess}: ${named('manageAccess')}`));
  } else body.push(ui.text(`Mode: ${channelMode(meta)}${meta.autoMode ? ' · Auto' : ''}${meta.cleanMode ? ' · Lean' : ''}${meta.skillRuntimeSwap ? ' · Skill model swap' : ''}. Only current managers can change channel access settings.`));
  if (!agent) return { body, actions: [] };
  body.push(ui.text(networkLabel(meta, { detail: true })));
  let vpn = unconfiguredChannelVpnStatus(ctx.meta);
  if (!vpn) { try { vpn = await getChannelVpnStatus(ctx.channelId); } catch { vpn = { state: 'unavailable', message: 'VPN status is unavailable for this conversation.' }; } }
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
const optionalInput = (data, key) => {
  const value = data[key];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Select a runtime value and try again.');
  return value.trim();
};
// The Harness control and the license step of one scope, as submitted.
const readSelectionInput = (data, scope) => ({ harness: readRuntimeInput(data, scope, 'engine'),
  license: optionalInput(data, `${scope}_license`), also: optionalInput(data, `${scope}_also`) });
// The license step on the card belongs to another harness: Harness was changed and the card was
// not reloaded, so the person never saw the licenses their choice would save.
export const staleLicenseStep = input => isHarnessId(input.harness) && Boolean(input.license)
  && input.license !== LICENSE_POOL_ANY && harnessOf(input.license) !== input.harness;
// Say WHY a choice cannot be made (switched off, not configured, unknown) before the picker's own
// refusal: a harness with no usable license is asked as its own license, anything that is not a
// harness as the license id it claims to be.
export async function admitSubmittedHarness(value, meta, channelId) {
  if (!value) return;
  if (!isHarnessId(value) || !selectableLicenses(value, meta).length) await assertEngineSelectable(value, { meta, channelId });
}
// A submitted Harness + license step → the `engine` + `licensePool` to store. `own` is the
// scope's stored selection and `above` the level it inherits from: a harness sent WITHOUT a
// license step (one license here, or a card that did not show the step for it) keeps the scope's
// own selection when it is already on that harness, else takes the one the level above runs that
// harness on. A license id in place of a harness — a card posted before the step existed, or a
// typed command — is that one license.
export function submittedSelection(input, { meta, own, above }) {
  const { harness, license = '', also = '' } = input;
  if (!harness) return { engine: '', licensePool: '' };
  if (!isHarnessId(harness)) {
    if (!isEngineId(harness)) throw new Error('That engine is no longer enabled.');
    return resolveLicensePick({ harness: harnessOf(harness), meta, license: harness });
  }
  if (staleLicenseStep(input)) throw new Error('The harness changed. Load its licenses and models before applying.');
  if (license) return resolveLicensePick({ harness, meta, license, also: license === LICENSE_POOL_ANY ? [] : also.split(',').map(id => id.trim()).filter(Boolean) });
  // Refuses a harness with nothing usable here.
  if (!selectableLicenses(harness, meta).length) return resolveLicensePick({ harness, meta });
  // Nothing about the licenses was on the card, so nothing about them changes: a selection whose
  // other licenses are switched off for now is kept as it was stored.
  if (own.engine && harnessOf(own.engine) === harness && usableHere(meta, own.engine)) return { engine: own.engine, licensePool: readLicensePool(own.licensePool) };
  return harnessSelection(harness, above);
}
// Channel writes resolve the selection twice: before the write, to ask the license whether it is
// ready (that check is async), and inside it against the record actually being replaced.
const SETTINGS_MOVED = 'These settings changed. Reopen General before applying your changes.';
async function admitSelection(selection, meta, channelId) {
  if (selection?.engine) await assertEngineSelectable(selection.engine, { meta, channelId });
  return selection;
}
function sameSelection(planned, selection) {
  if (planned.engine !== selection.engine) throw new Error(SETTINGS_MOVED);
  return selection;
}
// A typed license choice (`/settings license …`): names, ids or list numbers of the licenses of
// the harness this scope is on. Empty = follow the inherited default again.
function typedLicenseSelection(value, { meta, own, inheritedEngine }) {
  if (!value) return { engine: '', licensePool: '' };
  const engine = own.engine || inheritedEngine, harness = harnessOf(engine);
  const picker = licensePicker({ harness, meta, engine, pool: own.engine ? own.licensePool : '' });
  if (!picker.show) throw new Error(`${harnessLabel(harness)} has a single license here, so there is nothing to choose.`);
  const choice = readLicenseChoice(value, picker.licenses);
  if (choice.error) {
    // Typed-command replies are one short line; a long list is left to /license.
    const listed = `${choice.error} ${harnessLabel(harness)} licenses here: ${licenseListText(picker.licenses)}.`;
    throw new Error(listed.length <= 300 ? listed : `${choice.error} Send /license to see the licenses here.`);
  }
  return resolveLicensePick({ harness, meta, license: choice.license, also: choice.also });
}
function validatedSelection(current, field, value, inheritedEngine) {
  // Validate the submitted field before dependent fields are cleared. A forged model must
  // produce an error rather than silently clearing the existing model.
  const selected = { ...current, [field]: value };
  if (field !== 'engine') runtimeSettingsPatch({ ...selected, effort: field === 'model' ? '' : selected.effort }, { gatewayEngine: inheritedEngine });
  const next = nextRuntimeTriple(current, field, value, inheritedEngine);
  return runtimeSettingsPatch(next, { gatewayEngine: inheritedEngine }).patch;
}

function assertRuntimeBaseline(ctx, scope, own, locked) {
  const baseline = ctx.state.runtimeBaseline?.[scope];
  if (!baseline || baseline.locked !== locked || SELECTION_FIELDS.some(field => baseline[field] !== own[field])) {
    throw new Error('These settings changed. Reopen General before applying your changes.');
  }
}
function combinedRuntimeSelection(data, scope, meta, inheritedEngine, engine) {
  const form = { engine, model: readRuntimeInput(data, scope, 'model'), effort: readRuntimeInput(data, scope, 'effort') };
  // Resolve defaults against the newly selected engine, including template/channel inheritance.
  const { patch, actualEngine } = runtimeSettingsPatch({ ...form, effort: '' }, { gatewayEngine: inheritedEngine });
  const inherited = scope === 'channel' ? effectiveMeta({ ...meta, engine: actualEngine, model: '', effort: '' }) : effectiveMeta(meta);
  const actualModel = compatible([patch.model, inherited.model, getDefaultModel(actualEngine)], actualEngine);
  if (form.effort && !effortBelongsToModel(form.effort, actualEngine, actualModel)) {
    throw new Error('That effort is not supported by the selected model.');
  }
  return { ...patch, effort: form.effort };
}

// Repaint one scope for the submitted Harness and License without saving anything: Teams
// ChoiceSets send no change events, so this is how the dependent lists follow a choice.
async function stageRuntimeDraft(ctx, scope, data, notice) {
  const fresh = await ctx.authorize(); assertCurrentAuthorized(fresh);
  const scopes = await generalRuntimeScopes(fresh), snapshot = scopes[scope];
  assertRuntimeBaseline(ctx, scope, snapshot.values, scopes.locked);
  const submitted = readSelectionInput(data, scope);
  // A license step left over from the previous harness says nothing about the new one.
  const input = staleLicenseStep(submitted) ? { harness: submitted.harness } : submitted;
  await admitSubmittedHarness(input.harness, fresh.meta, fresh.channelId);
  const selection = await admitSelection(submittedSelection(input, { meta: fresh.meta, own: snapshot.values,
    above: scope === 'channel' ? aboveChannel(fresh.meta) : aboveThread(fresh.meta) }), fresh.meta, fresh.channelId);
  runtimeSettingsPatch({ engine: selection.engine }, { gatewayEngine: snapshot.inheritedEngine });
  const triple = nextRuntimeTriple({ engine: selection.engine, model: readRuntimeInput(data, scope, 'model'), effort: readRuntimeInput(data, scope, 'effort') },
    'engine', selection.engine, snapshot.inheritedEngine);
  ctx.state.runtimeDrafts ||= {};
  ctx.state.runtimeDrafts[scope] = { values: { ...triple, licensePool: poolKey(selection.licensePool) }, baseline: { ...snapshot.values }, locked: scopes.locked, inheritedEngine: snapshot.inheritedEngine };
  ctx.state.tab = 'general';
  ctx.state.notice = notice(hasLicenseStep(fresh.meta));
  return true;
}

export async function handleGeneral(action, data, ctx, _ui) {
  if (action === 'settings.runtime.models') {
    const { scope } = data;
    if (!['channel', 'thread'].includes(scope)) throw new Error('Unknown runtime control.');
    if (scope === 'thread') requireSession(ctx);
    return stageRuntimeDraft(ctx, scope, data, licenses => `${licenses ? 'License and model' : 'Model'} choices refreshed. Use Apply to save your selection.`);
  }
  if (action === 'settings.runtime.apply') {
    const { scope } = data;
    if (!['channel', 'thread'].includes(scope)) throw new Error('Unknown runtime control.');
    if (scope === 'thread') requireSession(ctx);
    const input = readSelectionInput(data, scope);
    // Harness was changed without reloading, so the card still shows the previous harness's
    // licenses. Saving would store licenses the person never saw — show them instead.
    if (staleLicenseStep(input)) {
      return stageRuntimeDraft(ctx, scope, data, () => 'Harness changed, so its licenses and models were loaded. Nothing was saved yet — check the selection, then Apply.');
    }
    if (scope === 'channel') {
      await admitSubmittedHarness(input.harness, ctx.meta, ctx.channelId);
      const planned = await admitSelection(submittedSelection(input, { meta: ctx.meta, own: ownChannel(ctx.meta), above: aboveChannel(ctx.meta) }), ctx.meta, ctx.channelId);
      ctx.meta = await ctx.patch((current, fresh) => {
        assertCurrentAuthorized(fresh, current);
        const locked = false;
        const own = ownChannel(current);
        assertRuntimeBaseline(ctx, scope, own, locked);
        const selection = sameSelection(planned, submittedSelection(input, { meta: current, own, above: aboveChannel(current) }));
        const next = combinedRuntimeSelection(data, scope, current, parentEngine(current), selection.engine);
        return { ...next, licensePool: selection.licensePool };
      });
    } else {
      const session = requireSession(ctx), release = await acquireKeyedLock('teams-settings-runtime', `${ctx.entry.slug}:${session}`);
      try {
        const fresh = await ctx.authorize(); assertCurrentAuthorized(fresh);
        const [engine, model, effort, pool] = await Promise.all([
          getThreadEngine(ctx.entry.slug, session), getThreadModel(ctx.entry.slug, session), getThreadEffort(ctx.entry.slug, session), getThreadLicensePool(ctx.entry.slug, session),
        ]);
        const latest = await ctx.authorize(); assertCurrentAuthorized(latest);
        const locked = false, own = ownThread(engine, model, effort, pool);
        assertRuntimeBaseline(ctx, scope, own, locked);
        // The roster check above can outlive a turn that creates/replaces this live session.
        const mintedEngine = await getSessionEngine(ctx.entry.slug, session);
        const inheritedEngine = mintedEngine || effectiveMeta(latest.meta).engine || getEngine();
        await admitSubmittedHarness(input.harness, latest.meta, ctx.channelId);
        const selection = submittedSelection(input, { meta: latest.meta, own, above: aboveThread(latest.meta) });
        const next = combinedRuntimeSelection(data, scope, latest.meta, inheritedEngine, selection.engine);
        await admitSelection(next, latest.meta, ctx.channelId);
        setThreadRuntimeOverrides(ctx.entry.slug, session, { ...next, licensePool: selection.licensePool }, { expected: { engine, model, effort } });
      } finally { release(); }
    }
    if (ctx.state.runtimeDrafts) delete ctx.state.runtimeDrafts[scope];
    ctx.state.tab = 'general';
    ctx.state.notice = `${scope === 'channel' ? 'Channel defaults' : 'Thread overrides'} updated. Applies to the next turn.`;
    await logEvent(scope === 'channel' ? 'channel_runtime_updated' : 'thread_runtime_updated', {
      channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, fields: [...SELECTION_FIELDS],
    });
    return true;
  }
  if (action === 'settings.runtime') {
    // One field at a time: cards posted before the combined form, and the typed settings commands.
    // `engine` takes a harness (or one license id); `license` takes typed license names for the
    // harness the scope is on.
    const { scope, field } = data;
    if (!['channel', 'thread'].includes(scope) || ![...RUNTIME_FIELDS, 'license'].includes(field)) throw new Error('Unknown runtime control.');
    const typed = field === 'license' ? optionalInput(data, `${scope}_license`) : '';
    const value = field !== 'license' ? readRuntimeInput(data, scope, field) : typed === RUNTIME_DEFAULT_VALUE ? '' : typed;
    // → the selection this field names, or null when the field is the model or the effort.
    const selectionFor = ({ meta, own, above, inheritedEngine }) => field === 'engine' ? submittedSelection({ harness: value }, { meta, own, above })
      : field === 'license' ? typedLicenseSelection(value, { meta, own, inheritedEngine }) : null;
    if (field === 'engine') await admitSubmittedHarness(value, ctx.meta, ctx.channelId);
    if (scope === 'channel') {
      const planned = await admitSelection(selectionFor({ meta: ctx.meta, own: ownChannel(ctx.meta), above: aboveChannel(ctx.meta), inheritedEngine: parentEngine(ctx.meta) }), ctx.meta, ctx.channelId);
      ctx.meta = await ctx.patch((current, fresh) => {
        assertCurrentAuthorized(fresh, current);
        const own = ownChannel(current), inheritedEngine = parentEngine(current);
        const selection = planned && sameSelection(planned, selectionFor({ meta: current, own, above: aboveChannel(current), inheritedEngine }));
        const next = validatedSelection(own, selection ? 'engine' : field, selection ? selection.engine : value, inheritedEngine);
        return selection ? { ...next, licensePool: selection.licensePool } : next;
      });
    } else {
      const session = requireSession(ctx), release = await acquireKeyedLock('teams-settings-runtime', `${ctx.entry.slug}:${session}`);
      try {
        const fresh = await ctx.authorize(); assertCurrentAuthorized(fresh);
        const [engine, model, effort, pool, mintedEngine] = await Promise.all([getThreadEngine(ctx.entry.slug, session), getThreadModel(ctx.entry.slug, session), getThreadEffort(ctx.entry.slug, session), getThreadLicensePool(ctx.entry.slug, session), getSessionEngine(ctx.entry.slug, session)]);
        const latest = await ctx.authorize(); assertCurrentAuthorized(latest);
        const inheritedEngine = mintedEngine || effectiveMeta(latest.meta).engine || getEngine();
        const own = ownThread(engine, model, effort, pool);
        const selection = selectionFor({ meta: latest.meta, own, above: aboveThread(latest.meta), inheritedEngine });
        const next = validatedSelection({ engine, model, effort }, selection ? 'engine' : field, selection ? selection.engine : value, inheritedEngine);
        if (selection) await admitSelection(next, latest.meta, ctx.channelId);
        // A model or effort change leaves the pin's licenses as they are; setThreadEngine clears
        // a pool it is not handed.
        await Promise.all([setThreadEngine(ctx.entry.slug, session, next.engine, { licensePool: selection ? selection.licensePool : pool }), setThreadModel(ctx.entry.slug, session, next.model), setThreadEffort(ctx.entry.slug, session, next.effort)]);
      } finally { release(); }
    }
    if (ctx.state.runtimeDrafts) delete ctx.state.runtimeDrafts[scope];
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
    if (ctx.state.runtimeDrafts) delete ctx.state.runtimeDrafts.thread;
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
        if (!['mode', 'autoMode', 'cleanMode', 'skillRuntimeSwap'].includes(field)) throw new Error('This setting is managed by the DM template.');
      } else assertManager(fresh, current);
      // Revalidate against the roster obtained at this write's authorization boundary.
      if (namedFields.includes(field) && Array.isArray(fresh.members) && value.some(id =>
        !fresh.members.some(member => member.id === id && (fresh.isHumanMember ? fresh.isHumanMember(member) : !member.id.startsWith('28:') && member.id !== fresh.connector.botId)))) {
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
    await setChannelVpnEnabled(ctx.channelId, data.enabled, { actor: ctx.ownerId, source: ctx.source || 'teams-settings', authorize: async () => { const fresh = await ctx.authorize(); return managed(fresh.meta, fresh); } });
    ctx.state.notice = 'VPN request completed. Status reflects the current service state.';
    return true;
  }
  return false;
}
