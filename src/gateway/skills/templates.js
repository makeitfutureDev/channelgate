// Channel skill templates: "apply the Development template to this channel". A template is data
// (a row: explicit skill slugs and/or categories); the four seeded ones exist so a fresh
// deployment has something to apply, and an admin can edit or add more. Applying copies a
// SNAPSHOT of the resolved slugs into the conversation's own grant list — never a live link, so a
// later template edit does not silently rewrite every channel that ever used it.
import { getTemplate, listTemplates, upsertTemplate, resolveTemplateSkills } from "./catalog.js";
import { withDependencies } from "./resolve.js";
import { patchChannelMeta } from "../../config/store.js";
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

// What applying `templateKey` to a conversation whose grants are `currentGrants` would do.
// mode "add" keeps the current grants and adds the template's; "replace" makes the grant list
// exactly the template's. Dependencies of the final list are pulled in automatically.
export function previewTemplate(templateKey, currentGrants = [], { mode = "add" } = {}) {
  const template = getTemplate(templateKey);
  if (!template) return null;
  const current = sanitizeSkillGrantNames(currentGrants);
  const { skills, missing } = resolveTemplateSkills(template);
  const templateSlugs = skills.map((s) => s.slug);
  const have = new Set(current.map((s) => s.toLowerCase()));
  const base = mode === "replace" ? templateSlugs : [...current, ...templateSlugs.filter((s) => !have.has(s.toLowerCase()))];
  const { names, profile } = withDependencies(base);
  const final = new Set(names.map((s) => s.toLowerCase()));
  return {
    template: { slug: template.slug, name: template.name, description: template.description, builtin: template.builtin },
    mode,
    add: names.filter((s) => !have.has(s.toLowerCase())),
    keep: current.filter((s) => final.has(s.toLowerCase())),
    remove: mode === "replace" ? current.filter((s) => !final.has(s.toLowerCase())) : [],
    names,
    missing,
    profile,
  };
}

// Apply the template to a conversation (its stored channel meta). Returns the preview that was
// applied, or null when the conversation is unknown / the template does not exist.
export async function applyTemplateToChannel(channelSlug, templateKey, { mode = "add" } = {}) {
  let applied = null;
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    applied = previewTemplate(templateKey, meta.skills || [], { mode });
    if (!applied) return null;
    return { skills: applied.names };
  });
  return next ? { ...applied, channelSlug, skills: next.skills } : null;
}
