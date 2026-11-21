// Teams settings: pending changes per section, saved as ONE validated batch either to the
// conversation ("Apply to channel") or as this thread's own overrides ("Apply to thread").
//
// A draft is a list of edit INTENTS ("set FOO", "remove BAR", "activate skill S") kept in the
// requester-bound, expiring card state (controls.js: owner, conversation and tenant bound, 15
// minutes) — daemon memory only. A staged variable value or connection token stays there until
// Apply, Discard or expiry: it is never rendered, never echoed in a notice, never logged and never
// placed in an action payload. Apply re-authorizes, re-validates every intent against the chosen
// scope's CURRENT value and the fingerprint it was staged against, and writes nothing unless the
// whole section is valid. Drafts in other sections are untouched by an Apply or a Discard here.
//
// Thread scope writes only gateway/thread-settings.js rows. What a thread may hold — and why some
// edits are refused there — is that module's contract.
import { normalizeChannelEnv, normalizeEnvName, assertValidEnvName, assertValidEnvValue, patchChannelEnv, setChannelEnvVar, listEnvVars } from '../../config/channel-env.js';
import { assertValidSwapRuleFields } from '../../gateway/egress/catalog-rules.js';
import { listOrgEnv, listUserEnv } from '../../config/scoped-env.js';
import { getOrgAccessGrants, getComposioMode } from '../../config/settings.js';
import { getChannelMeta } from '../../config/store.js';
import { enterpriseFeatureEnabled } from '../../ee/feature-entitlements.js';
import { engineAvailableForChannel } from '../../gateway/channel-engines.js';
import { effectiveMeta } from '../../gateway/run.js';
import { resolveMakeToolboxUpdate } from '../../gateway/make-toolbox.js';
import { selectionFieldForEngine, persistedSelectionForEngine } from '../../gateway/mcp-discovery.js';
import { assertNewMcpSelections } from '../../gateway/mcp-selection.js';
import { requireAdapter, engineLabel } from '../../engines/registry.js';
import { getSkill } from '../../gateway/skills/catalog.js';
import { grantSkillsToChannel, revokeSkillsFromChannel } from '../../gateway/skills/authoring.js';
import { assignTemplateToChannel, channelSkillGrants, listTemplateSummaries, templateOfMeta } from '../../gateway/skills/templates.js';
import { ensureChannelFolder } from '../../gateway/folders.js';
import { getThreadSettings, setThreadSettings, settingsFingerprint, threadSectionFingerprint, threadVariableRule, threadVariableRuleError, assertThreadSkillGrantable, THREAD_MCP_SELECTION_FIELDS } from '../../gateway/thread-settings.js';
import { cloudItems, handleCatalogAction, keyFor, mailAndPersonalRows, orgKeys, pageSlice, pager, skillItems } from './settings-catalog.js';
import { logEvent } from '../../util/logger.js';

export const DRAFT_SECTIONS = Object.freeze(['secrets', 'mcp', 'skills']);
const MAX_OPS = 64;
// Staged values live in daemon memory for up to 15 minutes in up to 500 windows: bound each draft.
const MAX_DRAFT_BYTES = 96_000;
const SECTION_NAMES = { secrets: 'Variables', mcp: 'MCPs', skills: 'Skills' };
const CLOUD_ENGINES = ['claude', 'codex', 'codex-channel'];
const str = value => typeof value === 'string' ? value.trim() : '';
const scopeWord = scope => scope === 'thread' ? 'this thread' : 'the channel';

// ── Draft state ──────────────────────────────────────────────────────────────────────────────

export function draftOf(ctx, section) {
  return ctx.state.drafts?.[section] || null;
}
export function pendingCount(ctx, section) {
  if (section === 'general') return ctx.state.generalDraft ? Object.keys(ctx.state.generalDraft.inputs || {}).length + Object.keys(ctx.state.runtimeDrafts || {}).length : 0;
  return draftOf(ctx, section)?.ops.length || 0;
}
export function discardDraft(ctx, section) {
  if (ctx.state.drafts) delete ctx.state.drafts[section];
}

// What each scope looked like when the first edit was staged. Fingerprints only (HMAC with a
// per-process key, gateway/thread-settings.js) — the card state never keeps a stored value.
function channelProjection(meta = {}, section) {
  if (section === 'secrets') return { env: normalizeChannelEnv(meta.env) };
  if (section === 'skills') return { skills: meta.skills || [], skillsOff: meta.skillsOff || [], skillTemplate: meta.skillTemplate || '' };
  return Object.fromEntries(['composioToken', 'composioTokenLabel', 'makeToolboxUrl', 'makeToolboxKey', ...THREAD_MCP_SELECTION_FIELDS].map(key => [key, meta[key] ?? '']));
}
const channelFingerprint = (meta, section) => settingsFingerprint(channelProjection(meta, section));
const threadFingerprint = (ctx, section) => ctx.sessionKey ? threadSectionFingerprint(ctx.entry.slug, ctx.sessionKey, section) : '';

function stage(ctx, section, op, { replace = () => false } = {}) {
  ctx.state.drafts ||= {};
  const draft = ctx.state.drafts[section] ||= { ops: [], baseline: { channel: channelFingerprint(ctx.meta, section), thread: threadFingerprint(ctx, section) } };
  if (draft.ops.some(item => item.op === 'follow') && op.op !== 'follow') throw new Error('Following the channel is pending for this section. Apply it to the thread, or discard it, before staging other changes.');
  // Built aside and committed only when it fits, so a refused edit leaves the draft as it was.
  const next = [...(op.op === 'follow' ? [] : draft.ops.filter(item => !replace(item))), op];
  if (next.length > MAX_OPS || Buffer.byteLength(JSON.stringify(next)) > MAX_DRAFT_BYTES) throw new Error('Apply or discard the pending changes in this section before staging more.');
  draft.ops = next;
  return draft;
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

function pendingRows(ctx, section, ui) {
  const draft = draftOf(ctx, section);
  if (!draft?.ops.length) return [];
  const lines = draft.ops.map(op => {
    if (op.op === 'follow') return 'Follow the channel: clear all of this thread’s overrides in this section';
    if (op.op === 'set') return `Set ${op.name} (new value hidden)${op.hostsMode === 'replace' ? ` · Used on: ${op.hosts.join(', ')}` : op.hostsMode === 'clear' ? ' · clear its declared hosts' : ''}`;
    if (op.op === 'remove') return `Remove ${op.name}`;
    if (op.op === 'restore') return `Show ${op.name} again in this thread`;
    if (op.op === 'connections') return `Connection: ${[op.composioToken ? 'new Composio token (hidden)' : '', op.composioTokenLabel !== undefined ? `Composio label "${op.composioTokenLabel}"` : '', op.makeToolboxUrl ? `Make URL ${op.makeToolboxUrl}` : '', op.makeToolboxKey ? 'new Make token (hidden)' : ''].filter(Boolean).join(', ')}`;
    if (op.op === 'disconnect') return `Disconnect ${op.connection === 'make' ? 'Make MCP' : 'Composio'}`;
    if (op.op === 'cloud') return `${op.activate ? 'Activate' : 'Deactivate'} ${op.name} (${engineLabel(op.engine)})`;
    if (op.op === 'skill') return `${op.activate ? 'Activate' : 'Deactivate'} skill ${op.key}`;
    if (op.op === 'template') return `Skill template: ${op.slug || 'None'} (channel only)`;
    return op.op;
  });
  return [ui.heading(`Pending changes (${lines.length})`), ui.text(lines.map(line => `• ${line}`).join('\n').slice(0, 2400)),
    ui.text('Not saved yet. Use Apply to channel or Apply to thread below; other sections keep their own pending changes.')];
}

function variableLine(row, scope) {
  const where = { channel: 'Channel', thread: 'This thread', hidden: 'Hidden in this thread', personal: 'Personal', organization: 'Organization' }[scope];
  if (scope === 'hidden') return `${where} · ${row.name} · the channel value is not used in this thread`;
  return `${where} · ${row.name} · ${row.last4 ? `••••${row.last4}` : 'set'} · ${row.protected ? 'Hidden' : 'Readable'}${row.hosts.length ? ` · Used on: ${row.hosts.join(', ').slice(0, 500)}` : ''}${row.setBy ? ` · Set by ${String(row.setBy).slice(0, 60)}` : ''}`;
}

async function renderVariables(ctx, ui) {
  const thread = ctx.sessionKey ? getThreadSettings(ctx.entry.slug, ctx.sessionKey, 'secrets') : {};
  const body = [ui.heading('Variables'),
    ui.text('Values are write-only and never shown. Stage changes below, then Apply to channel (the whole conversation) or Apply to thread (this thread only).'),
    ...(ctx.sessionKey ? [ui.text('Thread variables are always hidden behind the egress proxy and need a fixed destination: a known credential name or "Used on hosts". They work only while this thread is the only work in the conversation’s container, and never on a host or legacy-bridge run.')] : [])];
  body.push(...pendingRows(ctx, 'secrets', ui));
  const rows = [
    ...listEnvVars(ctx.meta.env).map(row => ({ row, scope: 'channel' })),
    ...listEnvVars(thread.env).map(row => ({ row, scope: 'thread' })),
    ...(thread.removed || []).map(name => ({ row: { name, hosts: [] }, scope: 'hidden' })),
    ...(ctx.isShared ? [] : (await listUserEnv(ctx.ownerId)).map(row => ({ row, scope: 'personal' }))),
    ...(ctx.isShared ? [] : listOrgEnv().map(row => ({ row, scope: 'organization' }))),
  ];
  const slice = pageSlice(rows, ctx.state.variablePage);
  body.push(ui.heading('Saved variables'), ui.text(`${rows.length} variables — page ${slice.page + 1}/${slice.totalPages}`));
  for (const { row, scope } of slice.items) {
    body.push(ui.text(variableLine(row, scope)));
    if (scope === 'hidden') body.push(ui.buttons([ui.execute('Stage: show again', 'settings.draft.variable.restore', { name: row.name }, 'none')]));
    else if (scope === 'channel' || scope === 'thread') body.push(ui.buttons([
      ui.execute('Change', 'settings.catalog.page', { page: 'secrets', variableScope: 'channel', variableName: row.name, index: slice.page }, 'none'),
      ui.execute('Stage removal', 'settings.draft.variable.remove', { name: row.name }, 'none')]));
    else if (scope === 'personal' || ctx.userIsAdmin) body.push(ui.buttons([
      ui.execute('Update', 'settings.catalog.page', { page: 'secrets', variableScope: scope, variableName: row.name, index: slice.page }, 'none'),
      ui.execute('Remove now', 'settings.variable.remove', { variableScope: scope, name: row.name }, 'none')]));
  }
  const scopes = [{ title: 'Channel or this thread (pending until Apply)', value: 'pending' },
    ...(ctx.isShared ? [] : [{ title: 'Personal (saved now, only your runs)', value: 'personal' }]),
    ...(!ctx.isShared && ctx.userIsAdmin && enterpriseFeatureEnabled('organizationVariables') ? [{ title: 'Organization (saved now)', value: 'organization' }] : [])];
  const chosen = ['personal', 'organization'].includes(ctx.state.variableScope) && scopes.some(item => item.value === ctx.state.variableScope) ? ctx.state.variableScope : 'pending';
  body.push(ui.heading('Add or change a variable'), ui.choice('variableScope', 'Where', chosen, scopes),
    ui.input('variableName', 'Name', ctx.state.variableName || ''), ui.input('variableValue', 'New value (never displayed)', ''),
    ui.choice('variableHostsMode', 'Used on hosts', 'preserve', [{ title: 'Keep existing rule', value: 'preserve' }, { title: 'Replace rule with hosts below', value: 'replace' }, { title: 'Clear declared rule', value: 'clear' }]),
    ui.input('variableHosts', 'Hosts (comma-separated; HTTPS hostnames only)', ''),
    ui.buttons([ui.execute('Add variable', 'settings.draft.variable')]));
  return { body, actions: pager(ui, 'secrets', slice.page, slice.totalPages) };
}

function connectionState(meta = {}) {
  const composio = meta.composioToken ? `Configured${meta.composioTokenLabel ? ` (${String(meta.composioTokenLabel).slice(0, 80)})` : ''}` : 'Not configured';
  const make = meta.makeToolboxUrl && meta.makeToolboxKey ? 'Configured' : 'Not configured';
  return { composio, make };
}
function threadConnectionState(thread = {}) {
  const composio = !Object.hasOwn(thread, 'composioToken') ? 'Follows the channel' : thread.composioToken ? `Own account${thread.composioTokenLabel ? ` (${thread.composioTokenLabel.slice(0, 80)})` : ''}` : 'Disconnected in this thread';
  const make = !Object.hasOwn(thread, 'makeToolboxUrl') ? 'Follows the channel' : thread.makeToolboxUrl ? 'Own Make MCP' : 'Disconnected in this thread';
  return { composio, make };
}

async function renderMcp(ctx, ui) {
  const meta = ctx.meta, thread = ctx.sessionKey ? getThreadSettings(ctx.entry.slug, ctx.sessionKey, 'mcp') : {};
  const channel = connectionState(meta), own = threadConnectionState(thread);
  const sdk = getComposioMode() === 'sdk';
  const body = [ui.heading('MCP connections'),
    ui.text(`Channel — Composio (${getComposioMode()}): ${channel.composio} · Make MCP: ${channel.make}${ctx.sessionKey ? `\nThis thread — Composio: ${own.composio} · Make MCP: ${own.make}` : ''}`),
    ...(sdk ? [ui.text('Composio runs in SDK mode: saved Composio tokens are inactive until it is switched back to Personal mode.')] : [])];
  body.push(...pendingRows(ctx, 'mcp', ui));
  body.push(ui.text('Tokens are never shown. Leave a field blank to keep what is saved. Add the change, then Apply to channel or Apply to thread.'),
    ui.input('composioToken', 'New Composio token', ''), ui.input('composioTokenLabel', 'Composio account label (blank keeps it)', ''),
    ui.input('makeToolboxUrl', 'Make MCP server URL', ''), ui.input('makeToolboxKey', 'New Make MCP token', ''),
    ui.buttons([ui.execute('Add connection changes', 'settings.draft.connections'),
      ui.execute('Stage: disconnect Composio', 'settings.draft.disconnect', { connection: 'composio' }, 'none'),
      ui.execute('Stage: disconnect Make', 'settings.draft.disconnect', { connection: 'make' }, 'none')]));
  body.push(...await mailAndPersonalRows(ctx, ui));
  body.push(ui.heading('Cloud MCP'));
  const actions = [];
  if (!ctx.userIsAdmin) { body.push(ui.text('Only administrators can manage Cloud MCP.')); return { body, actions }; }
  const engines = CLOUD_ENGINES.filter(id => engineAvailableForChannel(ctx.meta, id));
  const engine = engines.includes(ctx.state.cloudEngine) ? ctx.state.cloudEngine : 'claude';
  body.push(ui.text('A thread can only ADD Cloud MCP capabilities; channel and organization ones stay active in every thread.'),
    ui.buttons(engines.map(value => ui.execute(`${engineLabel(value)} catalog`, 'settings.catalog.page', { page: 'mcp', engine: value, index: 0 }, 'none'))));
  const threadKeys = new Set((thread[selectionFieldForEngine(engine)] || []).map(item => keyFor(engine, item)));
  const all = await cloudItems(ctx, engine), slice = pageSlice(all, ctx.state.cloudPage);
  body.push(ui.text(`${engineLabel(engine)} — ${all.length} capabilities — page ${slice.page + 1}/${slice.totalPages}`));
  for (const item of slice.items) {
    const state = item.inherited ? 'Organization (inherited)' : item.direct ? 'Active in channel' : threadKeys.has(item.key) ? 'Added in this thread' : 'Inactive';
    body.push(ui.text(`${item.name} · ${state}${item.selectable ? '' : ` · unavailable: ${item.admissionReason}`}`));
    const active = item.direct || threadKeys.has(item.key);
    if (!item.inherited && (active || item.selectable)) body.push(ui.buttons([ui.execute(active ? 'Stage: deactivate' : 'Stage: activate', 'settings.draft.cloud', { engine, key: item.key, activate: !active }, 'none')]));
  }
  actions.push(...pager(ui, 'mcp', slice.page, slice.totalPages, { engine }));
  return { body, actions };
}

function renderSkills(ctx, ui) {
  const effective = effectiveMeta(ctx.meta);
  const template = templateOfMeta(effective);
  const thread = ctx.sessionKey ? getThreadSettings(ctx.entry.slug, ctx.sessionKey, 'skills') : {};
  const threadSkills = new Set((thread.skills || []).map(name => name.toLowerCase()));
  const body = [ui.heading('Skills'), ui.text(`Template: ${String(template?.name || 'None').slice(0, 100)}\nChannel skills: ${channelSkillGrants(effective).join(', ').slice(0, 700) || 'None'}\nOrganization skills: ${(getOrgAccessGrants().skills || []).join(', ').slice(0, 500) || 'None'}${ctx.sessionKey ? `\nAdded in this thread: ${(thread.skills || []).join(', ').slice(0, 500) || 'None'}` : ''}`),
    ...(ctx.sessionKey ? [ui.text('A thread can only ADD shared skills; the conversation’s and organization’s skills stay active in every thread. Personal skills cannot be added to a thread.')] : [])];
  body.push(...pendingRows(ctx, 'skills', ui));
  if (enterpriseFeatureEnabled('skillTemplates')) {
    const templates = listTemplateSummaries(), templateSlice = pageSlice(templates, ctx.state.templatePage, 20);
    const choices = [...templateSlice.items];
    if (template && !choices.some(item => item.slug === template.slug)) choices.push(template);
    body.push(ui.choice('skillTemplate', 'Skill template (channel only)', template?.slug || 'none', [{ title: 'None', value: 'none' }, ...choices.map(item => ({ title: String(item.name || item.slug).slice(0, 100), value: item.slug }))]),
      ui.buttons([ui.execute('Stage template', 'settings.draft.template')]));
    if (templateSlice.totalPages > 1) body.push(ui.text(`Templates — page ${templateSlice.page + 1}/${templateSlice.totalPages}`), ui.buttons(pager(ui, 'skills', templateSlice.page, templateSlice.totalPages, { catalog: 'templates' })));
  } else if (effective.skillTemplate) {
    body.push(ui.choice('skillTemplate', 'Clear saved template', 'none', [{ title: 'None', value: 'none' }]), ui.buttons([ui.execute('Stage template', 'settings.draft.template')]));
  }
  const all = skillItems(ctx), slice = pageSlice(all, ctx.state.skillPage);
  body.push(ui.heading('Catalog skills'), ui.text(`${all.length} skills — page ${slice.page + 1}/${slice.totalPages}`));
  for (const item of slice.items) {
    const added = threadSkills.has(item.key.toLowerCase());
    body.push(ui.text(`${item.name} · ${item.inherited ? 'Organization (inherited)' : item.active ? 'Active in channel' : added ? 'Added in this thread' : 'Inactive'}${item.description ? `\n${item.description.slice(0, 300)}` : ''}`));
    const active = item.active || added;
    if (!item.inherited) body.push(ui.buttons([ui.execute(active ? 'Stage: deactivate' : 'Stage: activate', 'settings.draft.skill', { key: item.key, activate: !active }, 'none')]));
  }
  return { body, actions: pager(ui, 'skills', slice.page, slice.totalPages) };
}

export async function renderDraftPage(page, ctx, ui) {
  const content = page === 'secrets' ? await renderVariables(ctx, ui) : page === 'mcp' ? await renderMcp(ctx, ui) : renderSkills(ctx, ui);
  const pending = pendingCount(ctx, page);
  return { ...content, save: { title: SECTION_NAMES[page], verb: 'settings.draft.apply', discard: 'settings.draft.discard', data: { page }, pending,
    thread: Boolean(ctx.sessionKey), follow: Boolean(ctx.sessionKey) } };
}

// ── Staging ──────────────────────────────────────────────────────────────────────────────────

function stageVariable(data, ctx) {
  const name = assertValidEnvName(data.variableName);
  const value = assertValidEnvValue(typeof data.variableValue === 'string' ? data.variableValue : '');
  const hostsMode = data.variableHostsMode || 'preserve';
  if (!['preserve', 'replace', 'clear'].includes(hostsMode)) throw new Error('Invalid Used on hosts option.');
  const hosts = hostsMode === 'replace' ? assertValidSwapRuleFields({ hosts: str(data.variableHosts).split(',').map(host => host.trim()).filter(Boolean) }).hosts || [] : [];
  if (hostsMode === 'replace' && !hosts.length) throw new Error('List the hosts to replace the rule with, or choose Keep existing rule.');
  stage(ctx, 'secrets', { op: 'set', name, value, hostsMode, hosts }, { replace: item => item.name === name });
  ctx.state.variableName = '';
  return name;
}

export async function stageDraft(action, data, ctx) {
  const page = { 'settings.draft.variable': 'secrets', 'settings.draft.variable.remove': 'secrets', 'settings.draft.variable.restore': 'secrets',
    'settings.draft.connections': 'mcp', 'settings.draft.disconnect': 'mcp', 'settings.draft.cloud': 'mcp',
    'settings.draft.skill': 'skills', 'settings.draft.template': 'skills' }[action];
  if (!page) return false;
  ctx.state.tab = page;
  if (action === 'settings.draft.variable') {
    const name = stageVariable(data, ctx);
    ctx.state.notice = `${name} added to the pending changes. Its value stays hidden until you apply it.`;
  } else if (action === 'settings.draft.variable.remove' || action === 'settings.draft.variable.restore') {
    const name = normalizeEnvName(data.name);
    assertValidEnvName(name);
    stage(ctx, 'secrets', { op: action.endsWith('.remove') ? 'remove' : 'restore', name }, { replace: item => item.name === name });
    ctx.state.notice = `${action.endsWith('.remove') ? 'Removal' : 'Restore'} of ${name} staged.`;
  } else if (action === 'settings.draft.connections') {
    const op = { op: 'connections' };
    for (const key of ['composioToken', 'makeToolboxKey']) {
      const value = str(data[key]);
      if (value.length > 8000) throw new Error('That connection value is too large.');
      if (value && value.length < 6) throw new Error('Connection tokens must contain at least six characters.');
      if (value) op[key] = value;
    }
    const url = str(data.makeToolboxUrl), label = str(data.composioTokenLabel);
    if (url.length > 2000 || label.length > 200) throw new Error('That connection value is too large.');
    if (url) op.makeToolboxUrl = url;
    if (label) op.composioTokenLabel = label;
    if (Object.keys(op).length === 1) throw new Error('Type a new token, label or URL first.');
    const previous = draftOf(ctx, 'mcp')?.ops.find(item => item.op === 'connections') || {};
    stage(ctx, 'mcp', { ...previous, ...op }, { replace: item => item.op === 'connections' || (item.op === 'disconnect' && ((item.connection === 'composio' && (op.composioToken || op.composioTokenLabel)) || (item.connection === 'make' && (op.makeToolboxUrl || op.makeToolboxKey)))) });
    ctx.state.notice = 'Connection changes added to the pending changes. Tokens stay hidden.';
  } else if (action === 'settings.draft.disconnect') {
    if (!['composio', 'make'].includes(data.connection)) throw new Error('Unknown connection.');
    stage(ctx, 'mcp', { op: 'disconnect', connection: data.connection }, { replace: item => item.op === 'disconnect' && item.connection === data.connection });
    ctx.state.notice = `Disconnecting ${data.connection === 'make' ? 'Make MCP' : 'Composio'} is staged.`;
  } else if (action === 'settings.draft.cloud') {
    if (!ctx.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    if (!CLOUD_ENGINES.includes(data.engine) || !engineAvailableForChannel(ctx.meta, data.engine) || typeof data.activate !== 'boolean' || !str(data.key)) throw new Error('Invalid Cloud MCP selection.');
    const item = (await cloudItems(ctx, data.engine)).find(entry => entry.key === str(data.key));
    if (!item || item.inherited) throw new Error('That MCP capability cannot be changed here.');
    stage(ctx, 'mcp', { op: 'cloud', engine: data.engine, key: item.key, name: String(item.name).slice(0, 120), activate: data.activate },
      { replace: entry => entry.op === 'cloud' && entry.engine === data.engine && entry.key === item.key });
    ctx.state.notice = `${data.activate ? 'Activating' : 'Deactivating'} ${item.name} is staged.`;
  } else if (action === 'settings.draft.skill') {
    const key = str(data.key);
    if (!key || typeof data.activate !== 'boolean') throw new Error('Invalid skill selection.');
    const item = skillItems(ctx).find(skill => skill.key.toLowerCase() === key.toLowerCase());
    if (!item || item.inherited) throw new Error(item ? 'Organization skills are inherited and cannot be changed here.' : 'That skill is no longer available to this conversation.');
    stage(ctx, 'skills', { op: 'skill', key: item.key, activate: data.activate }, { replace: entry => entry.op === 'skill' && entry.key.toLowerCase() === item.key.toLowerCase() });
    ctx.state.notice = `${data.activate ? 'Activating' : 'Deactivating'} ${item.key} is staged.`;
  } else if (action === 'settings.draft.template') {
    if (typeof data.skillTemplate !== 'string' || data.skillTemplate.length > 200) throw new Error('Choose a skill template.');
    const slug = str(data.skillTemplate) === 'none' ? '' : str(data.skillTemplate);
    stage(ctx, 'skills', { op: 'template', slug }, { replace: entry => entry.op === 'template' });
    ctx.state.notice = 'Template change staged. Templates apply to the whole channel only.';
  }
  return true;
}

// ── Apply ────────────────────────────────────────────────────────────────────────────────────

function variableSet(op, ownerId, scopeNoun) {
  return { name: op.name, value: op.value, actor: ownerId, scopeNoun,
    ...(op.hostsMode === 'replace' ? { hosts: op.hosts } : op.hostsMode === 'clear' ? { hosts: [] } : {}) };
}

function channelSecretsPatch(current, ops, ownerId) {
  let env = current.env;
  for (const op of ops) {
    if (op.op === 'set') env = patchChannelEnv(env, { set: variableSet(op, ownerId, 'This channel'), actor: ownerId });
    else if (op.op === 'remove') env = patchChannelEnv(env, { remove: op.name });
    else throw new Error(op.op === 'follow' ? 'Following the channel applies to a thread. Use Apply to thread.' : `Showing ${op.name} again applies to this thread only. Use Apply to thread.`);
  }
  return { env };
}

function threadSecrets(current, ops, { channelEnv, ownerId }) {
  let env = normalizeChannelEnv(current.env);
  const removed = new Set(current.removed || []);
  for (const op of ops) {
    if (op.op === 'follow') { env = {}; removed.clear(); continue; }
    if (op.op === 'set') {
      env = setChannelEnvVar(env, { ...variableSet(op, ownerId, 'This thread') });
      const entry = { ...env[op.name] };
      delete entry.exposure; delete entry.approvedHosts;
      if (!threadVariableRule(op.name, entry)) throw new Error(threadVariableRuleError(op.name));
      env = { ...env, [op.name]: entry };
      removed.delete(op.name);
    } else if (op.op === 'remove') {
      if (env[op.name]) { env = { ...env }; delete env[op.name]; }
      else if (channelEnv[op.name]) removed.add(op.name);
      else throw new Error(`${op.name} is not set on this channel or thread.`);
    } else if (op.op === 'restore') {
      if (!removed.delete(op.name)) throw new Error(`${op.name} is not hidden in this thread.`);
    }
  }
  return { ...(Object.keys(env).length ? { env } : {}), ...(removed.size ? { removed: [...removed].sort() } : {}) };
}

async function cloudSelection(engine, key, channelId) {
  const available = await requireAdapter(engine).discoverMcps({ channelId: engine === 'codex-channel' ? channelId : '' });
  const selection = persistedSelectionForEngine(engine, available.find(item => keyFor(engine, item) === key));
  if (!selection) throw new Error('A selected MCP capability is no longer available.');
  return selection;
}

// Discovery and admission are slow and asynchronous: resolve every activation BEFORE the write
// and re-check administrator standing afterwards.
async function resolvedCloudOps(ops, fresh) {
  const cloud = ops.filter(op => op.op === 'cloud');
  if (!cloud.length) return [];
  if (!fresh.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
  const out = [];
  for (const op of cloud) {
    const field = selectionFieldForEngine(op.engine);
    if ((getOrgAccessGrants()[field] || []).some(item => keyFor(op.engine, item) === op.key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
    out.push({ ...op, field, selection: op.activate ? await cloudSelection(op.engine, op.key, fresh.channelId) : null });
  }
  return out;
}

function channelMcpPatch(current, ops, cloud) {
  const next = { ...current }, patch = {};
  for (const op of ops) {
    if (op.op === 'connections') {
      if (op.composioToken) patch.composioToken = op.composioToken;
      if (op.composioTokenLabel !== undefined) patch.composioTokenLabel = op.composioTokenLabel;
      if (op.makeToolboxUrl || op.makeToolboxKey) Object.assign(patch, resolveMakeToolboxUpdate({ ...next, ...patch }, { makeToolboxUrl: op.makeToolboxUrl, makeToolboxKey: op.makeToolboxKey }));
    } else if (op.op === 'disconnect') {
      Object.assign(patch, op.connection === 'make' ? { makeToolboxUrl: '', makeToolboxKey: '' } : { composioToken: '' });
    } else if (op.op === 'follow') throw new Error('Following the channel applies to a thread. Use Apply to thread.');
  }
  for (const op of cloud) {
    const list = (patch[op.field] ?? current[op.field] ?? []).filter(item => keyFor(op.engine, item) !== op.key);
    patch[op.field] = op.selection ? [...list, op.selection] : list;
  }
  return patch;
}

function threadMcp(current, ops, cloud, { channelMeta }) {
  let next = { ...current };
  const channelActive = (op) => [...(getOrgAccessGrants()[op.field] || []), ...(channelMeta[op.field] || [])].some(item => keyFor(op.engine, item) === op.key);
  for (const op of ops) {
    if (op.op === 'follow') { next = {}; continue; }
    if (op.op === 'connections') {
      if (op.composioToken) { next.composioToken = op.composioToken; if (op.composioTokenLabel === undefined) delete next.composioTokenLabel; }
      if (op.composioTokenLabel !== undefined) {
        if (!next.composioToken) throw new Error('A thread’s Composio label belongs to its own Composio token. Add a token for this thread first.');
        next.composioTokenLabel = op.composioTokenLabel;
      }
      if (op.makeToolboxUrl || op.makeToolboxKey) {
        const base = next.makeToolboxUrl ? { makeToolboxUrl: next.makeToolboxUrl, makeToolboxKey: next.makeToolboxKey } : { makeToolboxUrl: channelMeta.makeToolboxUrl, makeToolboxKey: '' };
        Object.assign(next, resolveMakeToolboxUpdate(base, { makeToolboxUrl: op.makeToolboxUrl, makeToolboxKey: op.makeToolboxKey }));
        if (!next.makeToolboxKey) throw new Error('A thread’s own Make MCP needs its own token.');
      }
    } else if (op.op === 'disconnect') {
      if (op.connection === 'make') Object.assign(next, { makeToolboxUrl: '', makeToolboxKey: '' });
      else { next.composioToken = ''; delete next.composioTokenLabel; }
    }
  }
  for (const op of cloud) {
    const own = (next[op.field] || []).filter(item => keyFor(op.engine, item) !== op.key);
    if (op.activate) {
      if (channelActive(op)) throw new Error(`${op.name} is already active for the whole conversation.`);
      next[op.field] = [...own, op.selection];
    } else {
      if (own.length === (next[op.field] || []).length) throw new Error(`${op.name} is active for the whole conversation. A thread can only remove what it added; use Apply to channel.`);
      next[op.field] = own;
    }
    if (!next[op.field].length) delete next[op.field];
  }
  return next;
}

function skillOpsFor(ctx, fresh, ops, scope) {
  const items = skillItems(fresh);
  for (const op of ops.filter(item => item.op === 'skill')) {
    if (orgKeys().has(op.key.toLowerCase())) throw new Error('Organization skills are inherited and cannot be changed here.');
    if (op.activate && !items.some(item => item.key.toLowerCase() === op.key.toLowerCase())) throw new Error(`The skill ${op.key} is no longer available to this conversation.`);
  }
  if (scope === 'thread' && ops.some(op => op.op === 'template')) throw new Error('Skill templates apply to the whole channel. Use Apply to channel, or discard the template change.');
}

async function applyChannel(page, ctx, draft) {
  const ops = draft.ops;
  if (page === 'secrets') {
    await ctx.patch(current => {
      if (channelFingerprint(current, 'secrets') !== draft.baseline.channel) throw new Error('This conversation’s variables changed while you were editing. Discard your changes and reopen Variables.');
      return channelSecretsPatch(current, ops, ctx.ownerId);
    });
    return;
  }
  if (page === 'mcp') {
    const fresh = await ctx.authorize();
    const cloud = await resolvedCloudOps(ops, fresh);
    for (const op of cloud.filter(item => item.selection)) {
      await assertNewMcpSelections(op.engine, [op.selection], fresh.meta[op.field] || [], { channelId: op.engine === 'codex-channel' ? fresh.channelId : '' });
    }
    await ctx.patch((current, authorized) => {
      if (cloud.length && !authorized.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
      if (channelFingerprint(current, 'mcp') !== draft.baseline.channel) throw new Error('This conversation’s MCP settings changed while you were editing. Discard your changes and reopen MCPs.');
      return channelMcpPatch(current, ops, cloud);
    });
    return;
  }
  const fresh = await ctx.authorize();
  if (ops.some(op => op.op === 'follow')) throw new Error('Following the channel applies to a thread. Use Apply to thread.');
  skillOpsFor(ctx, fresh, ops, 'channel');
  const template = ops.find(op => op.op === 'template');
  if (template?.slug && !enterpriseFeatureEnabled('skillTemplates')) throw new Error('Skill templates require Enterprise.');
  const latest = await getChannelMeta(fresh.entry.slug);
  if (channelFingerprint(latest || {}, 'skills') !== draft.baseline.channel) throw new Error('This conversation’s skills changed while you were editing. Discard your changes and reopen Skills.');
  // Every intent is validated above; the writes below are the same stores Slack's Skills tab uses.
  if (template && !(await assignTemplateToChannel(fresh.entry.slug, template.slug))) throw new Error('That skill template is no longer available.');
  const on = ops.filter(op => op.op === 'skill' && op.activate).map(op => op.key);
  const off = ops.filter(op => op.op === 'skill' && !op.activate).map(op => op.key);
  if (on.length) await grantSkillsToChannel(fresh.entry.slug, on);
  if (off.length) await revokeSkillsFromChannel(fresh.entry.slug, off, { deactivate: true });
  const meta = await getChannelMeta(fresh.entry.slug);
  ctx.meta = meta; ctx.state.meta = meta;
  await ensureChannelFolder(fresh.entry.slug, effectiveMeta(meta));
}

async function applyThread(page, ctx, draft) {
  const fresh = await ctx.authorize();
  if (!fresh.sessionKey) throw new Error('Open Settings from the thread you want to change.');
  const slug = fresh.entry.slug, key = fresh.sessionKey;
  const current = getThreadSettings(slug, key, page);
  let next;
  if (page === 'secrets') next = threadSecrets(current, draft.ops, { channelEnv: normalizeChannelEnv(fresh.meta.env), ownerId: ctx.ownerId });
  else if (page === 'mcp') {
    const cloud = await resolvedCloudOps(draft.ops, fresh);
    for (const op of cloud.filter(item => item.selection)) {
      await assertNewMcpSelections(op.engine, [op.selection], [...(fresh.meta[op.field] || []), ...(current[op.field] || [])], { channelId: op.engine === 'codex-channel' ? fresh.channelId : '' });
    }
    const latest = await ctx.authorize();
    if (cloud.length && !latest.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    next = threadMcp(current, draft.ops, cloud, { channelMeta: latest.meta });
  } else {
    skillOpsFor(ctx, fresh, draft.ops, 'thread');
    const channelActive = new Set([...channelSkillGrants(effectiveMeta(fresh.meta)), ...(getOrgAccessGrants().skills || [])].map(name => name.toLowerCase()));
    let skills = draft.ops.some(op => op.op === 'follow') ? [] : [...(current.skills || [])];
    for (const op of draft.ops.filter(item => item.op === 'skill')) {
      const lower = op.key.toLowerCase();
      if (op.activate) {
        if (channelActive.has(lower)) throw new Error(`${op.key} is already active for the whole conversation.`);
        assertThreadSkillGrantable(op.key, { channelId: fresh.channelId, lookupSkill: getSkill });
        if (!skills.some(name => name.toLowerCase() === lower)) skills.push(op.key);
      } else {
        if (!skills.some(name => name.toLowerCase() === lower)) throw new Error(`${op.key} is active for the whole conversation. A thread can only remove skills it added; use Apply to channel.`);
        skills = skills.filter(name => name.toLowerCase() !== lower);
      }
    }
    next = skills.length ? { skills } : {};
  }
  // One compare-and-swap: refused when the thread's section changed since the first edit.
  if (threadSectionFingerprint(slug, key, page) !== draft.baseline.thread) throw new Error('This thread’s settings changed while you were editing. Discard your changes and reopen this section.');
  setThreadSettings(slug, key, page, next, { expected: draft.baseline.thread });
}

export async function handleDraftAction(action, data, ctx) {
  // Personal and organization variables are not conversation settings: they save at once, through
  // the same checked path as before (the author's own store; organization for admins only).
  if (action === 'settings.draft.variable' && ['personal', 'organization'].includes(data.variableScope)) {
    return handleCatalogAction('settings.variable.save', data, ctx, {});
  }
  if (await stageDraft(action, data, ctx)) return true;
  if (action !== 'settings.draft.apply' && action !== 'settings.draft.discard' && action !== 'settings.draft.follow') return false;
  const page = data.page;
  if (!DRAFT_SECTIONS.includes(page)) throw new Error('Open the settings section you want to save.');
  ctx.state.tab = page;
  if (action === 'settings.draft.discard') {
    discardDraft(ctx, page);
    ctx.state.notice = `Pending ${SECTION_NAMES[page]} changes discarded. Other sections keep theirs.`;
    return true;
  }
  if (action === 'settings.draft.follow') {
    if (!ctx.sessionKey) throw new Error('Open Settings from the thread you want to change.');
    stage(ctx, page, { op: 'follow' });
    ctx.state.notice = `Following the channel is staged: Apply to thread clears this thread’s ${SECTION_NAMES[page]} overrides.`;
    return true;
  }
  const scope = data.scope;
  if (!['channel', 'thread'].includes(scope)) throw new Error('Choose Apply to channel or Apply to thread.');
  const draft = draftOf(ctx, page);
  if (!draft?.ops.length) { ctx.state.notice = `No pending ${SECTION_NAMES[page]} changes.`; return true; }
  if (scope === 'thread' && !ctx.sessionKey) throw new Error('Open Settings from the thread you want to change.');
  if (scope === 'channel') await applyChannel(page, ctx, draft);
  else await applyThread(page, ctx, draft);
  const count = draft.ops.length;
  // Names and kinds only — never a value, a token or a host list.
  await logEvent('settings_batch_applied', { channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, section: page, scope, via: ctx.source || 'teams_settings',
    changes: draft.ops.map(op => ({ op: op.op, ...(op.name ? { name: op.name } : {}), ...(op.key ? { key: op.key } : {}), ...(op.connection ? { connection: op.connection } : {}) })) });
  discardDraft(ctx, page);
  ctx.state.notice = `${count} ${SECTION_NAMES[page]} change${count === 1 ? '' : 's'} saved to ${scopeWord(scope)}. ${scope === 'thread' ? 'They apply to this thread’s next turn and its background work.' : 'They apply to the next turn.'}`;
  return true;
}
