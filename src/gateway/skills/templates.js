// Channel skill templates: "this channel follows the Development template". A template is data
// (a row: explicit skill slugs and/or categories) edited under Settings → Access Templates; the
// four seeded ones exist so a fresh deployment has something to assign, and admins add more.
//
// A conversation is ASSIGNED a template (`meta.skillTemplate`, a live link): its effective channel
// tier is the template's current skills plus whatever was added to the conversation itself
// (`meta.skills`), so editing a template later reaches every conversation that follows it, and
// "add this skill to the channel" always adds on top of the template. The organization and
// personal tiers union in as before (access-grants.js).
import { getTemplate, listTemplates, upsertTemplate, resolveTemplateSkills, listSkills } from "./catalog.js";
import { withDependencies } from "./resolve.js";
import { patchChannelMeta, listChannels } from "../../config/store.js";
import { getOrgAccessGrants, getSkillsContextWarnTokens } from "../../config/settings.js";
import { sanitizeSkillGrantNames } from "../access-grants.js";

export const BUILTIN_TEMPLATES = Object.freeze([
  {
    slug: "development",
    name: "Development",
    description: "Engineering channels: coding, reviews, tooling and the development workflow.",
    categories: ["Development", "Engineering", "Coding", "dev-tools", "claude-code", "Automation"],
  },
  {
    slug: "sales",
    name: "Sales",
    description: "Sales channels: CRM, deals, outreach and customer records.",
    categories: ["Sales", "CRM"],
  },
  {
    slug: "marketing",
    name: "Marketing",
    description: "Marketing channels: content, campaigns, brand and research.",
    categories: ["Marketing", "Content"],
  },
  {
    slug: "management",
    name: "Management",
    description: "Management channels: projects, planning, reporting and administration.",
    categories: ["Management", "Projects", "Productivity", "Admin"],
  },
]);

// Seed the four built-ins once. An existing row is left alone (admins edit templates), so this
// is safe to run on every boot.
export function seedBuiltinTemplates() {
  const created = [];
  for (const t of BUILTIN_TEMPLATES) {
    if (getTemplate(t.slug)) continue;
    upsertTemplate({ ...t, builtin: true });
    created.push(t.slug);
  }
  return created;
}

export function templateSummary(template) {
  const { skills, missing } = resolveTemplateSkills(template);
  return { ...template, resolved: skills.map((s) => s.slug), resolvedDetail: skills, missing };
}

export function listTemplateSummaries() {
  return listTemplates().map(templateSummary);
}

// The template a conversation follows (by its stored slug), or null.
export function templateOfMeta(meta) {
  const key = typeof meta?.skillTemplate === "string" ? meta.skillTemplate.trim() : "";
  return key ? getTemplate(key) : null;
}

// The skills that live in this channel's section of the skills repository
// (channels/<channelId>/…, or a local skill created with that scope). Personal skills never
// carry a scope, so the shared viewer is right here.
export function channelScopedSkills(channelId) {
  const id = typeof channelId === "string" ? channelId.trim() : "";
  if (!id) return [];
  return listSkills({ channelScope: id, viewer: "" }).map((s) => s.slug);
}

// The conversation's own tier: the assigned template's CURRENT skills, the skills in the
// channel's own repository section, plus the skills added to the conversation itself. This is
// what the grant union takes as the channel tier.
export function channelSkillGrants(meta = {}) {
  const own = sanitizeSkillGrantNames(meta?.skills || []);
  const template = templateOfMeta(meta);
  const scoped = channelScopedSkills(meta?.channelId);
  if (!template && !scoped.length) return own;
  const fromTemplate = template ? resolveTemplateSkills(template).skills.map((s) => s.slug) : [];
  const seen = new Set();
  const out = [];
  for (const s of [...fromTemplate, ...scoped, ...own]) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// A copy of the conversation meta whose `skills` is the full channel tier (template + section +
// own). Used wherever a run or a report resolves grants from a stored meta.
export function withTemplateSkills(meta) {
  if (!meta) return meta;
  if (!templateOfMeta(meta) && !channelScopedSkills(meta.channelId).length) return meta;
  return { ...meta, skills: channelSkillGrants(meta) };
}

// What assigning `templateKey` to a conversation would give it: the template's skills plus the
// conversation's own additions, with dependencies, against its current effective tier. `names` is
// the RESOLVED profile (dependencies included) because that is what the conversation would end up
// running; nothing here is ever stored — assigning writes only the template slug, and the
// conversation's own grant list keeps holding explicit grants only.
//
// `context` is the always-on cost in three labelled numbers, never one ambiguous total: what THIS
// tier's skill descriptions cost, what the ORGANIZATION tier costs (it loads in every conversation
// whatever the template says), and the EFFECTIVE union the conversation actually pays. Reporting
// the tier alone understated a real conversation by the whole organization tier.
export function previewTemplate(templateKey, meta = {}, { additions = null, orgSkills = null } = {}) {
  const template = templateKey ? getTemplate(templateKey) : null;
  if (templateKey && !template) return null;
  const currentTier = channelSkillGrants(meta);
  const own = sanitizeSkillGrantNames(additions ?? meta?.skills ?? []);
  const { skills, missing } = template ? resolveTemplateSkills(template) : { skills: [], missing: [] };
  const have = new Set(own.map((s) => s.toLowerCase()));
  const base = [...skills.map((s) => s.slug).filter((s) => !have.has(s.toLowerCase())), ...own];
  const { names, profile } = withDependencies(base);
  const org = sanitizeSkillGrantNames(orgSkills ?? getOrgAccessGrants().skills ?? []);
  const warnTokens = getSkillsContextWarnTokens();
  const orgProfile = withDependencies(org, { warnTokens }).profile;
  const effective = withDependencies([...org, ...names], { warnTokens });
  const current = new Set(currentTier.map((s) => s.toLowerCase()));
  const next = new Set(names.map((s) => s.toLowerCase()));
  return {
    template: template ? { slug: template.slug, name: template.name, description: template.description, builtin: template.builtin } : null,
    add: names.filter((s) => !current.has(s.toLowerCase())),
    keep: currentTier.filter((s) => next.has(s.toLowerCase())),
    remove: currentTier.filter((s) => !next.has(s.toLowerCase())),
    names,
    missing,
    profile,
    context: {
      tier: profile.contextTokens,
      organization: orgProfile.contextTokens,
      effective: effective.profile.contextTokens,
      names: effective.names,
      warnings: effective.profile.warnings,
    },
  };
}

// Assign (or clear, with "" / "none") the template a conversation follows. The conversation's own
// additions are kept. Returns the preview of the resulting tier, or null when unknown.
export async function assignTemplateToChannel(channelSlug, templateKey) {
  const key = String(templateKey || "").trim();
  const clearing = !key || key.toLowerCase() === "none";
  const template = clearing ? null : getTemplate(key);
  if (!clearing && !template) return null;
  let preview = null;
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    preview = previewTemplate(template?.slug || "", meta);
    return { skillTemplate: template?.slug || "" };
  });
  return next ? { ...preview, channelSlug, skillTemplate: next.skillTemplate || "", skills: channelSkillGrants(next) } : null;
}

// Kept for callers of the earlier name: "apply" now means assign (a live link, not a copy).
export const applyTemplateToChannel = (channelSlug, templateKey) => assignTemplateToChannel(channelSlug, templateKey);

// Which conversations follow each template (for the admin UI).
export async function templateAssignments() {
  const out = new Map();
  for (const ch of await listChannels()) {
    const key = typeof ch.meta?.skillTemplate === "string" ? ch.meta.skillTemplate.trim().toLowerCase() : "";
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ slug: ch.slug, name: ch.name || ch.slug, channelId: ch.channelId });
  }
  return out;
}
