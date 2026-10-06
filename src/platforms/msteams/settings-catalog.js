// Teams catalog pages share the same credential, grant and catalog stores as Slack Settings.
// Card state carries identifiers only; stored credentials never become input defaults.
import { listChannelEnv, patchChannelEnv } from '../../config/channel-env.js';
import { listOrgEnv, listUserEnv, patchOrgEnv, patchUserEnv } from '../../config/scoped-env.js';
import { getDefaultComposioToken, getDefaultToolboxToken, getOrgAccessGrants, getComposioMode } from '../../config/settings.js';
import { getChannelMeta } from '../../config/store.js';
import { effectiveMeta } from '../../gateway/run.js';
import { resolveMakeToolboxUpdate } from '../../gateway/make-toolbox.js';
import { selectionFieldForEngine, persistedSelectionForEngine } from '../../gateway/mcp-discovery.js';
import { requireAdapter } from '../../engines/registry.js';
import { listSkills } from '../../gateway/skills/catalog.js';
import { canSeeSkill, grantSkillsToChannel, revokeSkillsFromChannel } from '../../gateway/skills/authoring.js';
import { assignTemplateToChannel, channelSkillGrants, listTemplateSummaries, templateOfMeta } from '../../gateway/skills/templates.js';
import { ensureChannelFolder } from '../../gateway/folders.js';
import { logEvent } from '../../util/logger.js';

const PAGE_SIZE = 6;
const SCOPES = ['channel', 'personal', 'organization'];
const label = scope => ({ channel: 'Channel', organization: 'Organization', personal: 'Personal' })[scope];
const str = value => typeof value === 'string' ? value.trim() : '';
const configured = value => value ? `Configured${typeof value === 'string' && value.length >= 12 ? ` (••••${value.slice(-4)})` : ''}` : 'Not configured';
const keyFor = (engine, item) => engine === 'codex' ? `${item.kind || ''}:${item.id || ''}` : str(item.name).toLowerCase();
const orgKeys = () => new Set((getOrgAccessGrants().skills || []).map(value => value.toLowerCase()));

function pageSlice(items, requested, size = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(0, Number.isSafeInteger(Number(requested)) ? Number(requested) : 0), totalPages - 1);
  return { items: items.slice(page * size, (page + 1) * size), page, totalPages };
}
function pager(ui, pageKey, page, totalPages, extra = {}) {
  const actions = [];
  if (page) actions.push(ui.execute('Previous', 'settings.catalog.page', { page: pageKey, index: page - 1, ...extra }, 'none'));
  if (page + 1 < totalPages) actions.push(ui.execute('Next', 'settings.catalog.page', { page: pageKey, index: page + 1, ...extra }, 'none'));
  return actions;
}
function skillItems(ctx) {
  const channel = new Set(channelSkillGrants(effectiveMeta(ctx.meta)).map(value => value.toLowerCase()));
  const org = orgKeys();
  const direct = new Set((ctx.meta.skills || []).map(value => value.toLowerCase()));
  const rows = new Map();
  for (const skill of listSkills({ viewer: ctx.userIsAdmin ? '*' : ctx.ownerId })) {
    const key = skill.slug.toLowerCase();
    const active = channel.has(key) || org.has(key);
    if (skill.visibility === 'personal' || !canSeeSkill(skill, { userId: ctx.ownerId, isAdmin: ctx.userIsAdmin, active })) continue;
    rows.set(key, { key: skill.slug, name: skill.name || skill.slug, description: skill.description || '', active, inherited: org.has(key), direct: direct.has(key) });
  }
  // Preserve removal controls for legacy grants whose source disappeared.
  for (const key of ctx.meta.skills || []) if (!rows.has(key.toLowerCase())) rows.set(key.toLowerCase(), { key, name: key, description: 'Unavailable in catalog', direct: true, active: true, inherited: org.has(key.toLowerCase()) });
  return [...rows.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}
async function cloudItems(ctx, engine) {
  const field = selectionFieldForEngine(engine);
  const direct = ctx.meta[field] || [];
  const org = getOrgAccessGrants()[field] || [];
  const directKeys = new Set(direct.map(item => keyFor(engine, item)));
  const inheritedKeys = new Set(org.map(item => keyFor(engine, item)));
  const available = await requireAdapter(engine).discoverMcps({ channelId: engine === 'codex' && ctx.meta.codexAuthSource === 'channel' ? ctx.channelId : '' });
  const rows = new Map();
  for (const source of [...available, ...direct, ...org]) {
    const key = keyFor(engine, source);
    if (!key || rows.has(key)) continue;
    rows.set(key, { key, name: source.name || source.id || key, direct: directKeys.has(key), inherited: inheritedKeys.has(key), source });
  }
  return [...rows.values()].sort((a, b) => Number(b.direct || b.inherited) - Number(a.direct || a.inherited) || a.name.localeCompare(b.name));
}

export async function renderCatalogPage(page, ctx, ui) {
  const body = [], actions = [];
  if (page === 'secrets') {
    body.push(ui.heading('Variables'), ui.text('Values are write-only. Rotating a value keeps its existing destination rule unless you replace or clear Used on hosts. Personal variables belong to you; organization variables are shared across conversations.'));
    const rows = [
      ...listChannelEnv(ctx.meta).map(row => ({ ...row, scope: 'channel' })),
      ...(await listUserEnv(ctx.ownerId)).map(row => ({ ...row, scope: 'personal' })),
      ...listOrgEnv().map(row => ({ ...row, scope: 'organization' })),
    ];
    const slice = pageSlice(rows, ctx.state.variablePage);
    body.push(ui.text(`${rows.length} variables — page ${slice.page + 1}/${slice.totalPages}`));
    for (const row of slice.items) {
      body.push(ui.text(`${label(row.scope)} · ${row.name} · ${row.last4 ? `••••${row.last4}` : 'set'} · ${row.provider}\n${row.protected ? 'Hidden' : 'Readable'}${row.hosts.length ? ` · Used on: ${row.hosts.join(', ').slice(0, 700)}` : ''}${row.setBy ? `\nSet by: ${String(row.setBy).slice(0, 100)}` : ''}${Number.isFinite(Number(row.setAt)) && Number(row.setAt) > 0 && Number(row.setAt) <= 8.64e15 ? ` · ${new Date(Number(row.setAt)).toISOString()}` : ''}`));
      if (row.scope !== 'organization' || ctx.userIsAdmin) body.push(ui.buttons([
        ui.execute('Update', 'settings.catalog.page', { page: 'secrets', variableScope: row.scope, variableName: row.name }, 'none'),
        ui.execute('Remove', 'settings.variable.remove', { variableScope: row.scope, name: row.name }, 'none'),
      ]));
    }
    const scope = SCOPES.includes(ctx.state.variableScope) && (ctx.state.variableScope !== 'organization' || ctx.userIsAdmin) ? ctx.state.variableScope : 'channel';
    body.push(ui.heading('Add or update variable'), ui.choice('variableScope', 'Scope', scope, SCOPES.filter(value => value !== 'organization' || ctx.userIsAdmin).map(value => ({ title: label(value), value }))),
      ui.input('variableName', 'Name', ctx.state.variableName || ''), ui.input('variableValue', 'New value (never displayed)', ''),
      ui.choice('variableHostsMode', 'Used on hosts', 'preserve', [{ title: 'Keep existing rule', value: 'preserve' }, { title: 'Replace rule with hosts below', value: 'replace' }, { title: 'Clear declared rule', value: 'clear' }]),
      ui.input('variableHosts', 'Hosts (comma-separated; HTTPS hostnames only)', ''));
    actions.push(ui.execute('Save variable', 'settings.variable.save'), ...pager(ui, page, slice.page, slice.totalPages));
    return { body, actions };
  }
  if (page === 'skills') {
    const effective = effectiveMeta(ctx.meta);
    const template = templateOfMeta(effective);
    const templates = listTemplateSummaries();
    const templateSlice = pageSlice(templates, ctx.state.templatePage, 20);
    const choices = [...templateSlice.items];
    if (template && !choices.some(item => item.slug === template.slug)) choices.push(template);
    body.push(ui.heading('Skills'), ui.text(`Template: ${String(template?.name || 'None').slice(0, 100)}\nChannel skills: ${channelSkillGrants(effective).join(', ').slice(0, 800) || 'None'}\nOrganization skills: ${(getOrgAccessGrants().skills || []).join(', ').slice(0, 800) || 'None'}`),
      ui.choice('skillTemplate', 'Skill template', template?.slug || 'none', [{ title: 'None', value: 'none' }, ...choices.map(item => ({ title: String(item.name || item.slug).slice(0, 100), value: item.slug }))]),
      ui.buttons([ui.execute('Apply template', 'settings.template')]));
    if (templateSlice.totalPages > 1) body.push(ui.text(`Templates — page ${templateSlice.page + 1}/${templateSlice.totalPages}`), ui.buttons(pager(ui, page, templateSlice.page, templateSlice.totalPages, { catalog: 'templates' })));
    const all = skillItems(ctx), slice = pageSlice(all, ctx.state.skillPage);
    body.push(ui.text(`${all.length} catalog skills — page ${slice.page + 1}/${slice.totalPages}`));
    for (const item of slice.items) {
      body.push(ui.text(`${item.name} · ${item.inherited ? 'Organization (inherited)' : item.active ? 'Active in channel' : 'Inactive'}${item.description ? `\n${item.description.slice(0, 350)}` : ''}`));
      if (!item.inherited) body.push(ui.buttons([ui.execute(item.active ? 'Deactivate' : 'Activate', 'settings.skills.toggle', { key: item.key, activate: !item.active }, 'none')]));
    }
    actions.push(...pager(ui, page, slice.page, slice.totalPages));
    return { body, actions };
  }
  if (page !== 'mcp') return null;
  const meta = ctx.meta;
  body.push(ui.heading('MCP connections'), ui.text(`Composio (${getComposioMode()}): ${configured(meta.composioToken)}${meta.composioTokenLabel ? ` · ${meta.composioTokenLabel}` : ''}\nToolbox: ${configured(meta.toolboxToken)}\nMake MCP: ${configured(meta.makeToolboxUrl && meta.makeToolboxKey)}\nOrganization Composio: ${configured(getDefaultComposioToken())}\nOrganization Toolbox: ${configured(getDefaultToolboxToken())}`),
    ui.text('Leave token fields blank to keep their stored value.'), ui.input('composioToken', 'New Composio token', ''),
    ui.input('composioTokenLabel', 'Composio account label', meta.composioTokenLabel || ''), ui.input('toolboxToken', 'New Toolbox token', ''),
    ui.input('makeToolboxUrl', 'Make MCP server URL', meta.makeToolboxUrl || ''), ui.input('makeToolboxKey', 'New Make MCP token', ''),
    ui.buttons([ui.execute('Save connections', 'settings.connections.save')]),
    ui.text(`Inherited organization/personal credentials: ${meta.noDefaultTokens ? 'Disabled' : 'Enabled'}`),
    ui.buttons([ui.execute(meta.noDefaultTokens ? 'Enable inherited credentials' : 'Disable inherited credentials', 'settings.connections.fallback', { enabled: Boolean(meta.noDefaultTokens) }, 'none')]));
  const disconnect = [];
  if (meta.composioToken) disconnect.push(ui.execute('Disconnect Composio', 'settings.connections.remove', { connection: 'composio' }, 'none'));
  if (meta.toolboxToken) disconnect.push(ui.execute('Disconnect Toolbox', 'settings.connections.remove', { connection: 'toolbox' }, 'none'));
  if (meta.makeToolboxUrl || meta.makeToolboxKey) disconnect.push(ui.execute('Disconnect Make MCP', 'settings.connections.remove', { connection: 'make' }, 'none'));
  if (disconnect.length) body.push(ui.buttons(disconnect));
  body.push(ui.heading('Cloud MCP'));
  if (!ctx.userIsAdmin) { body.push(ui.text('Only administrators can manage Cloud MCP.')); return { body, actions }; }
  const engine = ctx.state.cloudEngine === 'codex' ? 'codex' : 'claude';
  body.push(ui.buttons(['claude', 'codex'].map(value => ui.execute(value === 'codex' ? 'Codex catalog' : 'Claude catalog', 'settings.catalog.page', { page: 'mcp', engine: value, index: 0 }, 'none'))));
  const all = await cloudItems(ctx, engine), slice = pageSlice(all, ctx.state.cloudPage);
  body.push(ui.text(`${engine} — ${all.length} capabilities — page ${slice.page + 1}/${slice.totalPages}`));
  for (const item of slice.items) {
    body.push(ui.text(`${item.name} · ${item.inherited ? 'Organization (inherited)' : item.direct ? 'Active in channel' : 'Inactive'}`));
    if (!item.inherited) body.push(ui.buttons([ui.execute(item.direct ? 'Deactivate' : 'Activate', 'settings.cloud.toggle', { engine, key: item.key, activate: !item.direct }, 'none')]));
  }
  actions.push(...pager(ui, page, slice.page, slice.totalPages, { engine }));
  return { body, actions };
}

async function fresh(ctx) {
  const expected = { ownerId: ctx.ownerId, channelId: ctx.channelId, slug: ctx.entry.slug };
  const current = await ctx.authorize();
  if (!current || current.ownerId !== expected.ownerId || current.channelId !== expected.channelId || current.entry.slug !== expected.slug) throw new Error('These settings expired. Open Settings again.');
  return current;
}
function requireScope(scope, ctx) {
  if (!SCOPES.includes(scope)) throw new Error('Choose a valid variable scope.');
  if (scope === 'organization' && !ctx.userIsAdmin) throw new Error('Only administrators can change organization variables.');
  if (scope === 'personal' && !ctx.ownerId) throw new Error('No authenticated personal account.');
}
async function variableUpdate(ctx, scope, mutation) {
  requireScope(scope, ctx);
  const options = { ...mutation, actor: ctx.ownerId };
  if (scope === 'organization') patchOrgEnv(options);
  else if (scope === 'personal') await patchUserEnv(ctx.ownerId, options);
  else await ctx.patch(current => ({ env: patchChannelEnv(current.env, options) }));
}
async function record(ctx, type, details) {
  await logEvent(type, { channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, ...details });
}

export async function handleCatalogAction(action, data, ctx, _ui) {
  if (action === 'settings.catalog.page') {
    if (!['secrets', 'mcp', 'skills'].includes(data.page)) throw new Error('Unknown settings page.');
    ctx.state.tab = data.page;
    const index = Number.isSafeInteger(Number(data.index)) && Number(data.index) >= 0 ? Number(data.index) : 0;
    ctx.state[data.page === 'skills' && data.catalog === 'templates' ? 'templatePage' : { secrets: 'variablePage', mcp: 'cloudPage', skills: 'skillPage' }[data.page]] = index;
    if (data.page === 'mcp' && data.engine) {
      if (!['claude', 'codex'].includes(data.engine)) throw new Error('Unknown engine.');
      ctx.state.cloudEngine = data.engine;
    }
    if (data.page === 'secrets' && data.variableName) {
      requireScope(data.variableScope, await fresh(ctx));
      ctx.state.variableName = str(data.variableName);
      ctx.state.variableScope = data.variableScope;
    }
    return true;
  }
  const known = ['settings.variable.save', 'settings.variable.remove', 'settings.connections.save', 'settings.connections.remove', 'settings.connections.fallback', 'settings.cloud.toggle', 'settings.skills.toggle', 'settings.template'];
  if (!known.includes(action)) return false;
  const current = await fresh(ctx);
  if (action === 'settings.variable.save' || action === 'settings.variable.remove') {
    const saving = action.endsWith('.save');
    const scope = data.variableScope;
    requireScope(scope, current);
    if (saving) {
      const mode = data.variableHostsMode || 'preserve';
      if (!['preserve', 'replace', 'clear'].includes(mode)) throw new Error('Invalid Used on hosts option.');
      const set = { name: data.variableName, value: data.variableValue };
      if (mode !== 'preserve') set.hosts = mode === 'clear' ? [] : str(data.variableHosts).split(',').map(host => host.trim()).filter(Boolean);
      await variableUpdate(current, scope, { set });
    } else await variableUpdate(current, scope, { remove: data.name });
    ctx.state.tab = 'secrets';
    ctx.state.notice = saving ? 'Variable saved. Its value remains hidden.' : 'Variable removed.';
    return true;
  }
  if (action === 'settings.connections.save') {
    const form = Object.fromEntries(['composioToken', 'composioTokenLabel', 'toolboxToken', 'makeToolboxUrl', 'makeToolboxKey'].map(key => [key, str(data[key])]));
    for (const key of ['composioToken', 'toolboxToken', 'makeToolboxKey']) if (form[key] && form[key].length < 6) throw new Error('Connection tokens must contain at least six characters.');
    await current.patch(stored => {
      const patch = resolveMakeToolboxUpdate(stored, { makeToolboxUrl: form.makeToolboxUrl, makeToolboxKey: form.makeToolboxKey });
      if (form.composioToken) patch.composioToken = form.composioToken;
      if (typeof data.composioTokenLabel === 'string') patch.composioTokenLabel = form.composioTokenLabel;
      if (form.toolboxToken) patch.toolboxToken = form.toolboxToken;
      return patch;
    });
    await record(current, 'channel_connections_updated', { connections: ['Composio', 'Toolbox', 'Make MCP'] });
    ctx.state.tab = 'mcp'; ctx.state.notice = 'Connection settings saved.';
    return true;
  }
  if (action === 'settings.connections.remove') {
    const patches = { composio: { composioToken: '' }, toolbox: { toolboxToken: '' }, make: { makeToolboxUrl: '', makeToolboxKey: '' } };
    if (!Object.hasOwn(patches, data.connection)) throw new Error('Unknown connection.');
    const patch = patches[data.connection];
    await current.patch(() => patch);
    await record(current, 'channel_connection_removed', { connection: data.connection });
    ctx.state.tab = 'mcp'; ctx.state.notice = 'Connection removed.';
    return true;
  }
  if (action === 'settings.connections.fallback') {
    if (typeof data.enabled !== 'boolean') throw new Error('Invalid inherited credential setting.');
    await current.patch(() => ({ noDefaultTokens: !data.enabled }));
    ctx.state.tab = 'mcp'; ctx.state.notice = 'Inherited credential setting saved.';
    return true;
  }
  if (action === 'settings.cloud.toggle') {
    if (!current.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    if (!['claude', 'codex'].includes(data.engine) || typeof data.activate !== 'boolean' || !str(data.key)) throw new Error('Invalid Cloud MCP selection.');
    const engine = data.engine, key = str(data.key), field = selectionFieldForEngine(engine);
    if ((getOrgAccessGrants()[field] || []).some(item => keyFor(engine, item) === key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
    let selection = null;
    if (data.activate) {
      const available = await requireAdapter(engine).discoverMcps({ channelId: engine === 'codex' && current.meta.codexAuthSource === 'channel' ? current.channelId : '' });
      selection = persistedSelectionForEngine(engine, available.find(item => keyFor(engine, item) === key));
      if (!selection) throw new Error('That MCP capability is no longer available.');
    }
    // Discovery is asynchronous; roles may have changed while it ran.
    const latest = await fresh(ctx);
    if (!latest.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    await latest.patch((stored, authorized) => {
      if (!authorized.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
      if ((getOrgAccessGrants()[field] || []).some(item => keyFor(engine, item) === key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
      return { [field]: [...(stored[field] || []).filter(item => keyFor(engine, item) !== key), ...(selection ? [selection] : [])] };
    });
    ctx.state.tab = 'mcp'; ctx.state.notice = 'Cloud MCP selection saved.';
    return true;
  }
  if (action === 'settings.skills.toggle') {
    const key = str(data.key);
    if (!key || typeof data.activate !== 'boolean') throw new Error('Invalid skill selection.');
    if (orgKeys().has(key.toLowerCase())) throw new Error('Organization skills are inherited and cannot be changed here.');
    const item = skillItems(current).find(skill => skill.key.toLowerCase() === key.toLowerCase());
    if (!item) throw new Error('That skill is no longer available to this channel.');
    if (data.activate) await grantSkillsToChannel(current.entry.slug, [item.key]);
    else await revokeSkillsFromChannel(current.entry.slug, [item.key], { deactivate: true });
    const meta = await getChannelMeta(current.entry.slug);
    await ensureChannelFolder(current.entry.slug, effectiveMeta(meta));
    await record(current, data.activate ? 'skill_granted' : 'skill_revoked', { skills: [item.key] });
    ctx.state.tab = 'skills'; ctx.state.notice = `Skill ${data.activate ? 'activated' : 'deactivated'}.`;
    return true;
  }
  if (action === 'settings.template') {
    if (typeof data.skillTemplate !== 'string') throw new Error('Choose a skill template.');
    const assigned = await assignTemplateToChannel(current.entry.slug, str(data.skillTemplate));
    if (!assigned) throw new Error('That skill template is no longer available.');
    const meta = await getChannelMeta(current.entry.slug);
    await ensureChannelFolder(current.entry.slug, effectiveMeta(meta));
    await record(current, 'skill_template_assigned', { template: assigned.skillTemplate || 'none' });
    ctx.state.tab = 'skills'; ctx.state.notice = 'Skill template saved.';
    return true;
  }
  return false;
}
