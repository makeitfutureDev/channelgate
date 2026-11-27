// One conversation's skill picker, shared by every surface that edits it (Slack Settings → Skills
// and the Activity dashboard's Skills page), so who may add what — and what "remove here" means —
// cannot differ between them. Rows are what the VIEWER can see: personal skills are never offered
// to a conversation, and a hand-written grant missing from the catalog stays visible so it can be
// removed.
import { getOrgAccessGrants } from "../../config/settings.js";
import { canSeeSkill, grantSkillsToChannel, revokeSkillsFromChannel } from "./authoring.js";
import { listSkills } from "./catalog.js";
import { channelScopedSkills, channelSkillGrants, channelSkillsOff, listTemplateSummaries, templateOfMeta } from "./templates.js";

/** Every skill row for `meta` as `userId` sees it: direct grants first, then active, then by name. */
export function channelSkillRows(meta, { userId = "", userIsAdmin = false } = {}) {
  const direct = new Set((meta?.skills || []).map((value) => String(value).toLowerCase()));
  const organization = new Set((getOrgAccessGrants().skills || []).map((value) => String(value).toLowerCase()));
  const scoped = new Set(channelScopedSkills(meta?.channelId).map((value) => value.toLowerCase()));
  const template = templateOfMeta(meta);
  const templateSummary = template ? listTemplateSummaries().find((entry) => entry.slug === template.slug) : null;
  const fromTemplate = new Set((templateSummary?.resolved || []).map((value) => String(value).toLowerCase()));
  // A template or channel-section skill this conversation deactivated (meta.skillsOff) is off here.
  const off = channelSkillsOff(meta);
  const active = new Set([...direct, ...organization, ...[...scoped, ...fromTemplate].filter((key) => !off.has(key))]);
  const rows = new Map();
  for (const skill of listSkills({ viewer: userIsAdmin ? "*" : userId || "" })) {
    const key = skill.slug.toLowerCase();
    if (!canSeeSkill(skill, { userId, isAdmin: userIsAdmin, active: active.has(key) })) continue;
    if (skill.visibility === "personal") continue;
    rows.set(key, {
      key: skill.slug,
      name: skill.name || skill.slug,
      description: skill.description || "",
      direct: direct.has(key),
      inherited: organization.has(key),
      template: fromTemplate.has(key) && !off.has(key),
      scoped: scoped.has(key) && !off.has(key),
      active: active.has(key),
    });
  }
  // A hand-written or legacy direct grant may not be in the governed catalog. Keep it visible so
  // a manager can deactivate it instead of trapping an unrenderable grant in the channel record.
  for (const slug of meta?.skills || []) {
    const key = String(slug).toLowerCase();
    if (!key || rows.has(key)) continue;
    rows.set(key, { key: String(slug), name: String(slug), description: "Not currently in the catalog", direct: true, active: true });
  }
  return [...rows.values()].sort((a, b) => Number(b.direct) - Number(a.direct) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/** Case-insensitive difference between the current and the picked direct grants. */
export function skillSelectionDiff(current = [], picked = []) {
  const now = new Set(current.map((value) => String(value).toLowerCase()));
  const next = new Set(picked.map((value) => String(value).toLowerCase()));
  return {
    added: picked.filter((value) => !now.has(String(value).toLowerCase())),
    removed: current.filter((value) => !next.has(String(value).toLowerCase())),
  };
}

/**
 * Make `picked` the conversation's direct skill grants. Every addition must be a non-personal
 * catalog skill `userId` can see; a removal also turns a template/section copy off HERE only.
 * Throws before writing anything when an addition is refused. → `{ added, removed }`.
 */
export async function applyChannelSkillSelection(channelSlug, meta, picked = [], { userId = "", userIsAdmin = false } = {}) {
  const { added, removed } = skillSelectionDiff(meta?.skills || [], picked);
  if (added.length) {
    const visible = new Map(listSkills({ viewer: userIsAdmin ? "*" : userId }).map((skill) => [skill.slug.toLowerCase(), skill]));
    const active = new Set(channelSkillGrants(meta).map((item) => item.toLowerCase()));
    for (const slug of added) {
      const skill = visible.get(slug.toLowerCase());
      if (!skill || skill.visibility === "personal" || !canSeeSkill(skill, { userId, isAdmin: userIsAdmin, active: active.has(slug.toLowerCase()) })) {
        throw Object.assign(new Error(`${slug} is no longer available to this channel.`), { status: 400, refused: slug });
      }
    }
    await grantSkillsToChannel(channelSlug, added);
  }
  if (removed.length) await revokeSkillsFromChannel(channelSlug, removed, { deactivate: true });
  return { added, removed };
}
