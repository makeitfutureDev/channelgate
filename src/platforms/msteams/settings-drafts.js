// Requester-bound, expiring card state holds drafts only in daemon memory. Nothing is persisted
// until a scope Apply; credentials never ride a rendered input default or action payload.
import { renderCatalogPage, skillItems, cloudItems } from './settings-catalog.js';
import { getThreadSettings, setThreadSettings, threadSettingsFingerprint, resolveThreadSettingsMeta, resolveThreadSkillGrants } from '../../gateway/thread-settings.js';
import { normalizeChannelEnv, patchChannelEnv, normalizeEnvName } from '../../config/channel-env.js';
import { getOrgAccessGrants } from '../../config/settings.js';
import { selectionFieldForEngine, persistedSelectionForEngine } from '../../gateway/mcp-discovery.js';
import { requireAdapter } from '../../engines/registry.js';
import { getSkill, getTemplate, resolveTemplateSkills } from '../../gateway/skills/catalog.js';
import { canSeeSkill } from '../../gateway/skills/authoring.js';
import { channelSkillGrants, channelProvidedSkills } from '../../gateway/skills/templates.js';
import { effectiveMeta } from '../../gateway/run.js';
import { resolveMakeToolboxUpdate } from '../../gateway/make-toolbox.js';
import { logEvent } from '../../util/logger.js';

const PAGES = ['secrets', 'skills', 'mcp'];
const section = page => page === 'secrets' ? 'secrets' : page;
const connectionFields = ['composioToken', 'composioTokenLabel', 'toolboxToken', 'makeToolboxUrl', 'makeToolboxKey', 'noDefaultTokens'];
const fields = { secrets: ['env'], skills: ['skills', 'skillsOff', 'skillTemplate'], mcp: [...connectionFields, 'allowedMcps', 'allowedCodexMcps'] };
const project = (meta, page) => Object.fromEntries(fields[page].map(key => [key, meta[key] ?? (['skills', 'skillsOff', 'allowedMcps', 'allowedCodexMcps'].includes(key) ? [] : key === 'env' ? {} : key === 'noDefaultTokens' ? false : '')]));
const copy = value => structuredClone(value);
const keyFor = (engine, item) => engine === 'codex' ? `${item.kind || ''}:${item.id || ''}` : String(item.name || '').trim().toLowerCase();
const pendingMessage = 'Changes in this section are pending. Choose Apply to channel or Apply to thread to save this section only.';

function draftFor(ctx, page) {
  ctx.state.settingsDrafts ||= {};
  if (!ctx.state.settingsDrafts[page]) {
    const thread = ctx.sessionKey ? getThreadSettings(ctx.entry.slug, ctx.sessionKey, section(page)) : {};
    ctx.state.settingsDrafts[page] = { source: 'channel', channelBase: copy(project(ctx.meta, page)), threadBase: copy(thread), variables: {}, skills: {}, cloud: {}, patch: {} };
  }
  return ctx.state.settingsDrafts[page];
}
function variablesPatch(base, draft, ownerId, thread = false) {
  let env = normalizeChannelEnv(base.env);
  let removed = [...(base.removed || [])];
  for (const [name, change] of Object.entries(draft.variables)) {
    if (change.remove) {
      if (env[name]) env = patchChannelEnv(env, { remove: name });
      if (thread && !removed.includes(name)) removed.push(name);
    } else {
      env = patchChannelEnv(env, { set: change.set, actor: ownerId, scopeNoun: thread ? 'This thread' : 'This channel' });
      removed = removed.filter(item => item !== name);
    }
  }
  return thread ? { env, removed } : { env };
}
function skillsPatch(base, draft, ctx, thread = false) {
  const org = new Set((getOrgAccessGrants().skills || []).map(name => name.toLowerCase()));
  const channel = new Set(channelSkillGrants(effectiveMeta(ctx.meta)).map(name => name.toLowerCase()));
  const provided = new Set(channelProvidedSkills({ ...ctx.meta, ...base, ...draft.patch }).map(name => name.toLowerCase()));
  const threadProvided = thread ? new Set(resolveThreadSkillGrants({ skillTemplate: draft.patch.skillTemplate ?? base.skillTemplate ?? '' }, { channelId: ctx.channelId }).map(name => name.toLowerCase())) : new Set();
  let skills = [...(base.skills || [])], off = [...(base.skillsOff || [])];
  for (const [name, active] of Object.entries(draft.skills)) {
    const key = name.toLowerCase();
    if (org.has(key)) throw new Error('Organization skills are inherited and cannot be changed here.');
    if (thread && !active && channel.has(key)) throw new Error('Channel skills remain inherited in threads. Use Apply to channel to deactivate this skill.');
    if (thread && !active && threadProvided.has(key)) throw new Error('This skill is provided by the thread template. Clear or change that template before removing the skill.');
    skills = skills.filter(item => item.toLowerCase() !== key);
    off = off.filter(item => item.toLowerCase() !== key);
    if (active) skills.push(name);
    else if (!thread && provided.has(key)) off.push(name);
  }
  return { skills, ...(!thread ? { skillsOff: off } : {}), ...draft.patch };
}
function viewMeta(ctx, page, draft) {
  if (draft.reset) return { ...ctx.meta };
  const base = draft.source === 'channel' ? draft.channelBase : draft.threadBase;
  if (page === 'secrets') {
    const patch = variablesPatch(base, draft, ctx.ownerId, draft.source === 'thread');
    return { ...ctx.meta, env: patch.env };
  }
  if (page === 'skills') {
    const patch = skillsPatch(base, draft, ctx, false);
    return draft.source === 'thread' ? { ...ctx.meta, ...patch, skills: [...channelSkillGrants(effectiveMeta(ctx.meta)), ...resolveThreadSkillGrants({ skills: patch.skills, skillTemplate: patch.skillTemplate || '' }, { channelId: ctx.channelId })] } : { ...ctx.meta, ...patch };
  }
  const patch = { ...base, ...draft.patch };
  for (const engine of ['claude', 'codex']) {
    const field = selectionFieldForEngine(engine);
    let selections = [...(base[field] ?? ctx.meta[field] ?? [])];
    for (const change of Object.values(draft.cloud).filter(item => item.engine === engine)) {
      selections = selections.filter(item => keyFor(engine, item) !== change.key);
      if (change.activate && change.selection) selections.push(change.selection);
    }
    patch[field] = selections;
  }
  return draft.source === 'thread' ? resolveThreadSettingsMeta(ctx.meta, { mcp: patch }, { slug: ctx.entry.slug, threadKey: ctx.sessionKey }) : { ...ctx.meta, ...patch };
}

export function captureCatalogDraft(data, ctx) {
  const page = ctx.state.tab;
  if (!PAGES.includes(page)) return;
  const draft = draftFor(ctx, page);
  if (draft.reset) return;
  if (page === 'skills' && typeof data.skillTemplate === 'string' && data.skillTemplate !== draft.renderedTemplate) {
    const key = data.skillTemplate === 'none' ? '' : data.skillTemplate.trim();
    if (key && !getTemplate(key)) throw new Error('That skill template is no longer available.');
    draft.patch.skillTemplate = key;
  }
  if (page === 'mcp') {
    for (const field of connectionFields.filter(key => key !== 'noDefaultTokens')) {
      if (typeof data[field] !== 'string') continue;
      if (data[field].length > 8000) throw new Error('That connection value is too large.');
      const value = data[field].trim();
      if (['composioToken', 'toolboxToken', 'makeToolboxKey'].includes(field)) {
        if (value && value.length < 6) throw new Error('Connection tokens must contain at least six characters.');
        if (value) draft.patch[field] = value;
      } else if (value !== draft.rendered?.[field] && (field !== 'composioTokenLabel' || value || !ctx.isShared)) draft.patch[field] = value;
    }
    if (data.draftFallback !== undefined) {
      if (!['on', 'off'].includes(data.draftFallback)) throw new Error('Invalid inherited credential setting.');
      const disabled = data.draftFallback === 'off';
      if (disabled !== draft.rendered?.noDefaultTokens) draft.patch.noDefaultTokens = disabled;
    }
  }
  if (page === 'secrets' && typeof data.variableValue === 'string' && data.variableValue) stageVariable(data, ctx, draft);
}

function stageVariable(data, ctx, draft) {
  if (data.variableScope && !['channel', 'thread'].includes(data.variableScope)) throw new Error('Personal and organization variables require authenticated settings.');
  const mode = data.variableHostsMode || 'preserve';
  if (!['preserve', 'replace', 'clear'].includes(mode)) throw new Error('Invalid Used on hosts option.');
  const set = { name: data.variableName, value: data.variableValue };
  if (mode !== 'preserve') set.hosts = mode === 'clear' ? [] : String(data.variableHosts || '').split(',').map(host => host.trim()).filter(Boolean);
  const env = viewMeta(ctx, 'secrets', draft).env;
  if (mode === 'preserve') {
    const existing = normalizeChannelEnv(env)[normalizeEnvName(set.name)];
    for (const field of ['hosts', 'headers', 'format', 'exposure']) if (existing?.[field] !== undefined) set[field] = copy(existing[field]);
  }
  patchChannelEnv(env, { set, actor: ctx.ownerId }); // Strict validation before storing a draft.
  const name = normalizeEnvName(set.name);
  if (!Object.hasOwn(draft.variables, name) && Object.keys(draft.variables).length >= 64) throw new Error('Apply or discard the pending variables before adding more changes.');
  draft.variables[name] = { set: { ...set, name } };
  ctx.state.variableName = '';
}

export async function renderDraftCatalogPage(page, ctx, ui) {
  const draft = draftFor(ctx, page), meta = viewMeta(ctx, page, draft);
  // This scope console never mixes personal or organization writes into either Apply button.
  const content = await renderCatalogPage(page, { ...ctx, meta, isShared: true }, ui);
  draft.renderedTemplate = meta.skillTemplate || 'none';
  draft.rendered = { makeToolboxUrl: meta.makeToolboxUrl || '', composioTokenLabel: '', noDefaultTokens: Boolean(meta.noDefaultTokens) };
  const visibleSkills = new Set(skillItems({ ...ctx, meta, isShared: true }).map(item => item.key.toLowerCase()));
  const threadInheritedSkills = page === 'skills' && draft.source === 'thread' ? new Set([
    ...channelSkillGrants(effectiveMeta(ctx.meta)), ...resolveThreadSkillGrants({ skillTemplate: draft.patch.skillTemplate ?? draft.threadBase.skillTemplate ?? '' }, { channelId: ctx.channelId }),
  ].map(name => name.toLowerCase())) : new Set();
  draft.visibleSkills = [...visibleSkills];
  const actionsFor = (actions = []) => actions.flatMap(action => {
    const verb = action.verb;
    if (['settings.connections.save', 'settings.template'].includes(verb)) return [];
    let mapped = null;
    if (verb === 'settings.variable.save') mapped = ['Add to pending changes', 'settings.draft.variable'];
    else if (verb === 'settings.variable.remove') mapped = ['Remove from list', 'settings.draft.variable.remove'];
    else if (verb === 'settings.skills.toggle') {
      if (threadInheritedSkills.has(String(action.data.key).toLowerCase())) return [];
      mapped = [action.title, 'settings.draft.skill'];
    }
    else if (verb === 'settings.cloud.toggle') mapped = [action.title, 'settings.draft.cloud'];
    else if (verb === 'settings.connections.remove') mapped = [action.title, 'settings.draft.disconnect'];
    else if (verb === 'settings.connections.fallback') return [];
    const payload = { ...action.data }; delete payload.cgAction; delete payload.stateId;
    return [ui.execute(mapped?.[0] || action.title, mapped?.[1] || verb, payload)];
  });
  content.body = content.body.flatMap(row => {
    if (row.id === 'variableScope') return [];
    if (row.type !== 'ActionSet') return [row];
    const actions = actionsFor(row.actions);
    return actions.length ? [ui.buttons(actions)] : [];
  });
  content.actions = actionsFor(content.actions);
  if (page === 'mcp') content.body.splice(2, 0, ui.choice('draftFallback', 'Inherited organization/personal credentials', meta.noDefaultTokens ? 'off' : 'on', [{ label: 'Enabled', value: 'on' }, { label: 'Disabled', value: 'off' }]));
  if (draft.source === 'thread') content.body.unshift(ui.text('Editing thread overrides. Blank credentials follow the channel until replaced. Channel and organization skills remain inherited. Removing a variable here suppresses its channel value; personal and organization fallbacks remain.'));
  if (page === 'secrets') content.body.push(ui.text('Thread variables are injected only into that thread’s runs. Threads share the channel container; readable values do not provide privacy between its members.'));
  const pending = Object.keys(draft.variables).length + Object.keys(draft.skills).length + Object.keys(draft.cloud).length + Object.keys(draft.patch).length;
  content.body.unshift(ui.text(`Viewing ${draft.source} values · ${pending + Number(Boolean(draft.reset))} pending changes. Apply saves only this section; changes in other sections stay pending.`),
    ui.buttons([ui.execute('Channel values', 'settings.draft.source', { page, source: 'channel' }), ...(ctx.sessionKey ? [ui.execute('Thread values', 'settings.draft.source', { page, source: 'thread' })] : [])]));
  content.actions.push(ui.execute('Discard changes', 'settings.draft.discard', { page }, 'none'));
  if (draft.source === 'thread') content.actions.push(ui.execute('Follow channel', 'settings.draft.follow', { page }, 'none'));
  content.body.push(ui.buttons([ui.execute('Apply to channel', 'settings.draft.apply', { page, scope: 'channel' }), ...(ctx.sessionKey ? [ui.execute('Apply to thread', 'settings.draft.apply', { page, scope: 'thread' })] : [])]));
  return content;
}

function validateSkillEdits(ctx, draft) {
  const available = skillItems({ ...ctx, isShared: true });
  for (const name of Object.keys(draft.skills)) if (!available.some(item => item.key.toLowerCase() === name.toLowerCase())) throw new Error('A selected skill is no longer available to this conversation.');
  if (draft.patch.skillTemplate) {
    const template = getTemplate(draft.patch.skillTemplate);
    if (!template) throw new Error('That skill template is no longer available.');
    const active = new Set(channelSkillGrants(effectiveMeta(ctx.meta)).map(name => name.toLowerCase()));
    const visited = new Set();
    const visit = name => {
      if (visited.has(name.toLowerCase())) return;
      visited.add(name.toLowerCase());
      const skill = getSkill(name);
      if (!skill || skill.visibility === 'personal' || (skill.channelScope && skill.channelScope !== ctx.channelId)
        || !canSeeSkill(skill, { userId: ctx.ownerId, isAdmin: false, active: active.has(name.toLowerCase()) })) throw new Error('That template includes skills unavailable to this conversation.');
      for (const dependency of skill.requires || []) visit(dependency);
    };
    for (const skill of resolveTemplateSkills(template).skills) visit(skill.slug);
  }
}
async function cloudPatch(ctx, draft, base) {
  if (Object.keys(draft.cloud).length && !ctx.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
  const patch = { ...draft.patch };
  for (const engine of ['claude', 'codex']) {
    const changes = Object.values(draft.cloud).filter(item => item.engine === engine);
    if (!changes.length) continue;
    const field = selectionFieldForEngine(engine), inherited = getOrgAccessGrants()[field] || [];
    let selected = [...(base[field] ?? ctx.meta[field] ?? [])];
    const available = changes.some(item => item.activate) ? await requireAdapter(engine).discoverMcps({ channelId: engine === 'codex' && ctx.meta.codexAuthSource === 'channel' ? ctx.channelId : '' }) : [];
    for (const change of changes) {
      if (inherited.some(item => keyFor(engine, item) === change.key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
      selected = selected.filter(item => keyFor(engine, item) !== change.key);
      if (change.activate) {
        const selection = persistedSelectionForEngine(engine, available.find(item => keyFor(engine, item) === change.key));
        if (!selection) throw new Error('A selected MCP capability is no longer available.');
        selected.push(selection);
      }
    }
    patch[field] = selected;
  }
  if (Object.hasOwn(patch, 'makeToolboxUrl') || Object.hasOwn(patch, 'makeToolboxKey')) Object.assign(patch,
    resolveMakeToolboxUpdate({ ...ctx.meta, ...base }, { ...patch, ...(patch.makeToolboxUrl === '' && patch.makeToolboxKey === '' ? { clearMakeToolbox: true } : {}) }));
  return patch;
}

export async function handleDraftCatalogAction(action, data, ctx) {
  if (!action.startsWith('settings.draft.')) return false;
  const page = data.page || ctx.state.tab;
  if (!PAGES.includes(page) || page !== ctx.state.tab) throw new Error('Open the settings section you want to edit.');
  const actionPage = { 'settings.draft.variable': 'secrets', 'settings.draft.variable.remove': 'secrets',
    'settings.draft.disconnect': 'mcp', 'settings.draft.cloud': 'mcp', 'settings.draft.skill': 'skills' };
  if (Object.hasOwn(actionPage, action) && page !== actionPage[action]) throw new Error('This control belongs to another settings section.');
  const draft = draftFor(ctx, page);
  if (draft.reset && !['settings.draft.apply', 'settings.draft.source', 'settings.draft.discard', 'settings.draft.follow'].includes(action)) throw new Error('Apply or discard Follow channel before making more edits.');
  if (action === 'settings.draft.follow') {
    if (draft.source !== 'thread' || !ctx.sessionKey) throw new Error('Open the thread values before clearing its overrides.');
    draft.reset = true; draft.variables = {}; draft.skills = {}; draft.cloud = {}; draft.patch = {};
    ctx.state.notice = 'Following the channel is pending. Apply to thread to clear this section’s overrides.';
    return true;
  }
  if (action === 'settings.draft.source' || action === 'settings.draft.discard') {
    if (action.endsWith('.source') && !['channel', 'thread'].includes(data.source)) throw new Error('Unknown settings scope.');
    if (data.source === 'thread' && !ctx.sessionKey) throw new Error('Open Settings from the thread you want to change.');
    const pending = Object.keys(draft.variables).length + Object.keys(draft.skills).length + Object.keys(draft.cloud).length + Object.keys(draft.patch).length + Number(Boolean(draft.reset));
    if (action.endsWith('.source') && pending && data.source !== draft.source) throw new Error('Apply or discard pending changes before switching the values you are editing.');
    if (action.endsWith('.source') && data.source === draft.source) return true;
    const source = data.source || draft.source;
    delete ctx.state.settingsDrafts[page];
    draftFor(ctx, page).source = source;
    ctx.state.notice = action.endsWith('.discard') ? 'Pending changes discarded.' : '';
    return true;
  }
  if (action === 'settings.draft.variable') {
    if (!data.variableValue) throw new Error('Give the variable a value.');
    // The form was already captured by the router; don't double-store it.
  } else if (action === 'settings.draft.variable.remove') {
    const name = normalizeEnvName(data.name);
    if (!Object.hasOwn(viewMeta(ctx, page, draft).env || {}, name)) throw new Error('That variable is no longer in this list.');
    draft.variables[name] = { remove: true };
  } else if (action === 'settings.draft.disconnect') {
    const patches = { composio: { composioToken: '', composioTokenLabel: '' }, toolbox: { toolboxToken: '' }, make: { makeToolboxUrl: '', makeToolboxKey: '' } };
    if (!Object.hasOwn(patches, data.connection)) throw new Error('Unknown connection.');
    Object.assign(draft.patch, patches[data.connection]);
  } else if (action === 'settings.draft.skill') {
    if (typeof data.activate !== 'boolean' || !draft.visibleSkills?.includes(String(data.key).toLowerCase())) throw new Error('That skill is not available in these settings.');
    if (!Object.hasOwn(draft.skills, data.key) && Object.keys(draft.skills).length >= 128) throw new Error('Apply or discard the pending skills before adding more changes.');
    draft.skills[data.key] = data.activate;
  } else if (action === 'settings.draft.cloud') {
    if (!ctx.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    if (!['claude', 'codex'].includes(data.engine) || typeof data.activate !== 'boolean') throw new Error('Invalid Cloud MCP selection.');
    const items = await cloudItems({ ...ctx, meta: viewMeta(ctx, page, draft) }, data.engine);
    const item = items.find(item => item.key === data.key);
    if (!item || item.inherited) throw new Error('That MCP capability cannot be changed here.');
    if (!Object.hasOwn(draft.cloud, `${data.engine}:${data.key}`) && Object.keys(draft.cloud).length >= 128) throw new Error('Apply or discard the pending MCP selections before adding more changes.');
    draft.cloud[`${data.engine}:${data.key}`] = { engine: data.engine, key: data.key, activate: data.activate, selection: item.source };
  } else if (action === 'settings.draft.apply') {
    if (!['channel', 'thread'].includes(data.scope)) throw new Error('Choose a valid Apply scope.');
    if (data.scope === 'thread' && !ctx.sessionKey) throw new Error('Open Settings from the thread you want to change.');
    if (draft.reset) {
      if (data.scope !== 'thread') throw new Error('Follow channel clears thread overrides. Choose Apply to thread.');
      await ctx.authorize();
      setThreadSettings(ctx.entry.slug, ctx.sessionKey, section(page), {}, { expected: draft.threadBase });
      delete ctx.state.settingsDrafts[page]; draftFor(ctx, page).source = 'thread';
      ctx.state.notice = 'This section now follows the channel. Applies to the next turn.';
      await logEvent('settings_batch_applied', { channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, section: page, scope: 'thread', reset: true });
      return true;
    }
    await ctx.authorize();
    if (page === 'skills') await validateSkillEdits(ctx, draft);
    const base = data.scope === 'channel' ? draft.channelBase : draft.threadBase;
    let patch = page === 'secrets' ? variablesPatch(base, draft, ctx.ownerId, data.scope === 'thread')
      : page === 'skills' ? skillsPatch(base, draft, ctx, data.scope === 'thread') : await cloudPatch(ctx, draft, base);
    await ctx.authorize(); // Discovery can outlive an admin/membership change.
    if (page === 'skills') validateSkillEdits(ctx, draft);
    if (page === 'mcp' && Object.keys(draft.cloud).length && !ctx.userIsAdmin) throw new Error('Only administrators can manage Cloud MCP.');
    if (page === 'mcp') for (const change of Object.values(draft.cloud)) {
      if ((getOrgAccessGrants()[selectionFieldForEngine(change.engine)] || []).some(item => keyFor(change.engine, item) === change.key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
    }
    if (data.scope === 'channel') {
      await ctx.patch(current => {
        if (threadSettingsFingerprint(project(current, page)) !== threadSettingsFingerprint(draft.channelBase)) throw new Error('Channel settings changed. Discard and reopen this section before applying.');
        if (page === 'skills') validateSkillEdits({ ...ctx, meta: current }, draft);
        if (page === 'mcp') for (const change of Object.values(draft.cloud)) {
          if ((getOrgAccessGrants()[selectionFieldForEngine(change.engine)] || []).some(item => keyFor(change.engine, item) === change.key)) throw new Error('Organization MCP grants are inherited and cannot be changed here.');
        }
        return patch;
      });
    } else {
      patch = { ...base, ...patch };
      if (page === 'skills') resolveThreadSkillGrants(patch, { channelId: ctx.channelId });
      setThreadSettings(ctx.entry.slug, ctx.sessionKey, section(page), patch, { expected: draft.threadBase });
    }
    await logEvent('settings_batch_applied', { channel: ctx.channelId, slug: ctx.entry.slug, author: ctx.ownerId, section: page, scope: data.scope });
    delete ctx.state.settingsDrafts[page];
    draftFor(ctx, page).source = data.scope;
    ctx.state.notice = `${data.scope === 'channel' ? 'Channel' : 'Thread'} ${page === 'secrets' ? 'variables' : page} saved. Applies to the next turn.`;
    return true;
  } else throw new Error('Unknown pending settings action.');
  ctx.state.notice = pendingMessage;
  return true;
}
