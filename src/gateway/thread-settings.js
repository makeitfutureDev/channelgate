// Optional settings for one thread. These rows never rewrite channel metadata, the shared
// skill tree or the channel's runtime posture. A whole section is committed with one CAS.
import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { emitConfigChange } from '../config/change-events.js';
import { assertValidEnvName, assertValidEnvValue, normalizeChannelEnv } from '../config/channel-env.js';
import { sanitizeSkillGrantNames } from './access-grants.js';
import { getSkill, getTemplate, resolveTemplateSkills } from './skills/catalog.js';
import { assertValidSwapRuleFields } from './egress/catalog-rules.js';

export const THREAD_SETTINGS_SECTIONS = Object.freeze(['mcp', 'skills', 'secrets']);
const MCP_FIELDS = new Set(['composioToken', 'composioTokenLabel', 'toolboxToken', 'makeToolboxUrl', 'makeToolboxKey', 'noDefaultTokens', 'allowedMcps', 'allowedCodexMcps']);

function sectionKind(section) {
  if (!THREAD_SETTINGS_SECTIONS.includes(section)) throw new Error('Unknown thread settings section.');
  return `settings_${section}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// A stale card carries only this digest, never an old token or environment value.
export function threadSettingsFingerprint(value = {}) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Thread settings must be an object.');
  return value;
}

function names(value) {
  if (!Array.isArray(value) || value.length > 1024 || value.some(name => typeof name !== 'string')) throw new Error('Invalid thread skill selection.');
  const clean = sanitizeSkillGrantNames(value);
  if (clean.length !== new Set(value.map(name => name.trim())).size) throw new Error('Invalid thread skill selection.');
  return clean;
}

function validateSection(section, raw) {
  const value = object(raw);
  const fields = section === 'mcp' ? MCP_FIELDS : new Set(section === 'skills' ? ['skills', 'skillTemplate'] : ['env', 'removed']);
  if (Object.keys(value).some(key => !fields.has(key))) throw new Error('Unsupported thread settings field.');
  const out = structuredClone(value);
  if (section === 'mcp') {
    for (const [key, item] of Object.entries(out)) {
      if (key === 'noDefaultTokens') {
        if (typeof item !== 'boolean') throw new Error('Invalid thread connector fallback.');
      } else if (key.startsWith('allowed')) {
        if (!Array.isArray(item) || item.length > 512) throw new Error('Invalid thread MCP selection.');
      } else if (typeof item !== 'string' || Buffer.byteLength(item) > 16_384 || /[\r\n\0]/.test(item)) {
        throw new Error('Invalid thread connection value.');
      }
    }
  } else if (section === 'skills') {
    if (out.skills !== undefined) out.skills = names(out.skills);
    if (out.skillTemplate !== undefined && (typeof out.skillTemplate !== 'string' || out.skillTemplate.length > 160)) throw new Error('Invalid thread skill template.');
  } else {
    if (out.env !== undefined) {
      object(out.env);
      for (const [name, entry] of Object.entries(out.env)) {
        assertValidEnvName(name);
        assertValidSwapRuleFields(object(entry));
      }
      const normalized = normalizeChannelEnv(out.env);
      if (Object.keys(normalized).length !== Object.keys(out.env).length) throw new Error('Invalid thread environment variables.');
      for (const entry of Object.values(normalized)) {
        if (entry.provider === 'local') assertValidEnvValue(entry.value);
      }
      out.env = normalized;
    }
    if (out.removed !== undefined) {
      if (!Array.isArray(out.removed) || out.removed.length > 32) throw new Error('Invalid thread variable removals.');
      out.removed = [...new Set(out.removed.map(assertValidEnvName))];
    }
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 768_000) throw new Error('Thread settings are too large.');
  return out;
}

export function getThreadSettings(slug, threadKey, section) {
  const kind = sectionKind(section);
  if (!slug || !threadKey) return {};
  const row = getDb().prepare('SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?').get(slug, threadKey, kind);
  return row ? validateSection(section, JSON.parse(row.value)) : {};
}

export function setThreadSettings(slug, threadKey, section, next, { expected } = {}) {
  const kind = sectionKind(section);
  if (!slug || !threadKey) throw new Error('Thread settings need a channel and thread.');
  const value = validateSection(section, next);
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (expected !== undefined) {
      const fingerprint = typeof expected === 'string' ? expected : threadSettingsFingerprint(expected);
      if (threadSettingsFingerprint(getThreadSettings(slug, threadKey, section)) !== fingerprint) throw new Error('Thread settings changed. Reopen this section before applying your changes.');
    }
    if (Object.keys(value).length) {
      db.prepare('INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?) ON CONFLICT(slug, thread_key, kind) DO UPDATE SET value = excluded.value').run(slug, threadKey, kind, JSON.stringify(value));
    } else {
      db.prepare('DELETE FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = ?').run(slug, threadKey, kind);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  emitConfigChange('thread-settings', { slug, threadKey, section });
  return structuredClone(value);
}

// A thread may add shared skills, but cannot grant anybody's personal skill (even via a
// template/dependency). Inherited organization/channel skills remain part of every thread.
export function resolveThreadSkillGrants(settings = {}, { channelId = '', lookupSkill = getSkill, lookupTemplate = getTemplate, resolveTemplate = resolveTemplateSkills } = {}) {
  const stored = validateSection('skills', settings);
  const template = stored.skillTemplate ? lookupTemplate(stored.skillTemplate) : null;
  if (stored.skillTemplate && !template) throw new Error('Thread skill template is no longer available.');
  const selected = [...(stored.skills || []), ...(template ? resolveTemplate(template).skills.map(skill => skill.slug) : [])];
  const visited = new Set();
  const visit = name => {
    const key = name.toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const skill = lookupSkill(name);
    if (!skill || skill.deleted || skill.visibility === 'personal' || (skill.channelScope && skill.channelScope !== channelId)) throw new Error('Thread skill grant is no longer available.');
    for (const dependency of sanitizeSkillGrantNames(skill.requires || [])) visit(dependency);
  };
  for (const name of selected) visit(name);
  return sanitizeSkillGrantNames(selected);
}

// Only connection/grant fields can override channel metadata. In particular, tool policy,
// access membership, home mounts, network, cwd and engine authentication cannot be escalated.
export function resolveThreadSettingsMeta(meta, settings = {}, { slug = '', threadKey = '' } = {}) {
  const mcp = validateSection('mcp', settings.mcp || {});
  const secrets = validateSection('secrets', settings.secrets || {});
  return {
    ...meta, ...mcp,
    threadEnv: secrets.env || {}, threadEnvRemoved: secrets.removed || [],
    threadSettingsKey: threadKey, threadSettingsSlug: slug,
  };
}
