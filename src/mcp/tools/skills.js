// Skills tools for the gateway control MCP server: what is active in this conversation, the
// catalog, templates, personal and channel grants, authoring, proposals, usage, and (admins)
// sources, organization grants and publishing. Registered via register(server, ctx).
//
// Who may change what (operator decision 2026-09-27): a PERSONAL skill is its author's, a CHANNEL
// skill (one in a channel's own section) and the channel's skill set are its members', and
// neither needs anyone's approval — no card, the change is announced in the reply instead. Admins
// moderate only the ORGANIZATION tier: an admin creates and edits shared library skills directly;
// anyone else's organization request becomes a channel skill here plus a proposal an admin
// decides. Deleting a skill from the whole catalog is an admin's call too (a member's "delete"
// deactivates it in their conversation). A skill whose source this gateway cannot write to is
// never edited in place: it is extended with a companion skill. The organization-wide admin tools
// (org grants, governance, sources, proposal decisions) keep their control-plane card.
import { z } from "zod";
import { readFileSync } from "node:fs";
import { getUser, isAdminPrincipal, isApproved, getChannelMeta, getChannelEntry } from "../../config/store.js";
import { getOrgAccessGrants, getSkillsContextWarnTokens, getSkillsPublish, getEngine } from "../../config/settings.js";
import { resolveAccessGrants } from "../../gateway/access-grants.js";
import { getSkill, listSkills, listCategories, skillBundle, revisionFile, listProposals, listSources, addSource, updateSource, removeSource, excludeSkill, restoreSkill, effectiveRevisionFor, listRevisions, usageCountsBySlug, setSkillDiscoverable, getTemplate, SOURCE_KINDS, SOURCE_MODES } from "../../gateway/skills/catalog.js";
import { resolveSkillProfile, checkCompatibility, skillGrantContextChange } from "../../gateway/skills/resolve.js";
import { listTemplateSummaries, previewTemplate, assignTemplateToChannel, withTemplateSkills, templateOfMeta, channelScopedSkills } from "../../gateway/skills/templates.js";
import { skillUsageReport, formatSkillUsageReport } from "../../gateway/skills/usage.js";
import { fileToApi } from "../../gateway/skills/files.js";
import {
  createLocalSkill,
  updateLocalSkill,
  skillEditability,
  skillTier,
  addSkillsToTemplate,
  removeSkillsFromTemplate,
  deleteOwnSkill,
  grantSkillsToChannel,
  revokeSkillsFromChannel,
  grantSkillsToUser,
  revokeSkillsFromUser,
  grantSkillsToOrg,
  revokeSkillsFromOrg,
  proposeSkillChange,
  decideSkillProposal,
  describeOwner,
  canSeeSkill,
  moveSkillScope,
} from "../../gateway/skills/authoring.js";
import { publishRevision, publishTarget } from "../../gateway/skills/publish.js";
import { syncOneSource, runScheduledSkillSync } from "../../gateway/skills/index.js";
// A conversation's granted skills and its skill template are policy: they decide what loads into
// every future run here. The admin UI's grant/revoke/template routes already wrote these rows; the
// chat path wrote nothing at all until now.
import { logEvent } from "../../util/logger.js";

const MAX_TEXT = 12000;
const FILE_INPUT = z.object({
  path: z.string().describe("Path inside the skill folder, e.g. SKILL.md or references/ids.md"),
  content: z.string().describe("File content (text), or base64 when encoding is base64"),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version || "";
  } catch {
    return "";
  }
}

function clipText(s, n = MAX_TEXT) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}\n… (${str.length - n} more characters)` : str;
}

function skillLine(skill, { detail = true } = {}) {
  const bits = [];
  if (skill.version) bits.push(`v${skill.version}`);
  if (skill.category) bits.push(skill.category);
  bits.push(skill.ownerKind === "git" ? "synced" : skill.ownerKind);
  if (skill.visibility === "personal") bits.push("personal");
  const desc = skill.description ? ` — ${skill.description.length > 140 ? `${skill.description.slice(0, 137)}…` : skill.description}` : "";
  return `• \`${skill.slug}\`${detail ? ` (${bits.join(", ")})` : ""}${desc}`;
}

// Dependencies a grant pulls in are NOT grants of that tier: name them as what they are so this
// reads the same way `show_channel_skills` will ("required by …").
function dependencyLine(deps) {
  if (!deps?.length) return "";
  return `\nLoading with them as dependencies (not grants of their own, so they leave with the skill that needs them): ${deps.map((d) => `\`${d.slug}\`${d.requiredBy?.length ? ` (required by ${d.requiredBy.join(", ")})` : ""}`).join(", ")}`;
}

// Something asked to be removed that is no grant here at all — it loads because another skill
// requires it, and it goes when that skill goes.
function stillRequiredLine(entries) {
  if (!entries?.length) return "";
  return `\nNot a grant here, so nothing to remove: ${entries.map((e) => `\`${e.slug}\` loads because ${e.requiredBy.join(" and ")} requires it`).join("; ")}.`;
}

function publishLine(p) {
  if (!p) return "";
  if (p.published) return `\nPublished to ${p.repo}@${p.branch} under ${p.path}${p.adopted ? " (now owned by that source)" : ""}.`;
  if (p.failed) return `\n⚠️ Git publishing failed: ${p.reason}`;
  return "";
}

export function register(server, ctx) {
  const { channelId, slug, createdBy, text, requireAdmin, requireManage, loadMeta } = ctx;
  // Anyone this conversation admits may change ITS skills (the handler re-checks the verified
  // author against the channel's access policy; the run itself was already authorized).
  const memberHere = async () => (ctx.requireChannelAccess ? ctx.requireChannelAccess() : requireManage());
  const ANNOUNCE = "Mention this skill change in your reply so the conversation sees it.";

  // The HTTP run API principal ranks as an admin (its key is an admin credential), but it is not a
  // person: it has no personal grants and cannot own a personal skill.
  const isAdminUser = async () => Boolean(createdBy) && (await isAdminPrincipal(createdBy));
  const approvedAuthor = async () => Boolean(createdBy) && ((await isAdminUser()) || (await isApproved(createdBy)));
  const personalAuthor = async () => !ctx.apiPrincipal && (await approvedAuthor());
  const activeSkillSlugs = async () => {
    const stored = (await loadMeta()) || {};
    const user = createdBy ? (await getUser(createdBy)) || {} : {};
    return new Set(resolveAccessGrants({ organization: getOrgAccessGrants(), channel: withTemplateSkills(stored), user }).skills.map((s) => String(s).toLowerCase()));
  };
  const visibleSkill = async (key) => {
    const skill = getSkill(key);
    if (!skill) return null;
    return canSeeSkill(skill, { userId: createdBy, isAdmin: await isAdminUser(), active: (await activeSkillSlugs()).has(skill.slug.toLowerCase()) }) ? skill : null;
  };

  // The conversation's profile: organization + channel grants (durable) plus the requester's own.
  const channelProfile = async () => {
    const stored = (await loadMeta()) || {};
    const meta = withTemplateSkills(stored);
    const template = templateOfMeta(stored);
    const user = createdBy ? (await getUser(createdBy)) || {} : {};
    const shared = resolveAccessGrants({ organization: getOrgAccessGrants(), channel: meta });
    const effective = resolveAccessGrants({ organization: getOrgAccessGrants(), channel: meta, user });
    const warnTokens = getSkillsContextWarnTokens();
    return {
      meta,
      template,
      user,
      shared,
      effective,
      profile: resolveSkillProfile(effective.skills, { warnTokens }),
      sharedProfile: resolveSkillProfile(shared.skills, { warnTokens }),
      orgSkills: new Set((getOrgAccessGrants().skills || []).map((s) => String(s).toLowerCase())),
      channelSkills: new Set((stored.skills || []).map((s) => String(s).toLowerCase())),
      sectionSkills: new Set(channelScopedSkills(stored.channelId).map((s) => s.toLowerCase())),
      templateSkills: new Set(template ? (meta.skills || []).filter((s) => !(stored.skills || []).some((o) => String(o).toLowerCase() === String(s).toLowerCase()) && !channelScopedSkills(stored.channelId).some((o) => o.toLowerCase() === String(s).toLowerCase())).map((s) => String(s).toLowerCase()) : []),
      channelId: stored.channelId || "",
    };
  };

  // ── Reading ───────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_skills",
    {
      description: "Search the governed skills catalog by slug, name, description, tags, category, or source. Ordinary members see discoverable skills plus skills already active here; admins see all. Use show_channel_skills for what is active HERE.",
      inputSchema: { query: z.string().optional(), category: z.string().optional(), source: z.string().optional().describe("Source id or label"), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ query = "", category = "", source = "", limit = 60 }) => {
      const admin = await isAdminUser();
      const active = admin ? new Set() : await activeSkillSlugs();
      const sourceRow = source ? listSources().find((s) => String(s.id) === source || s.label.toLowerCase() === source.toLowerCase()) : null;
      if (source && !sourceRow) return text(`No skill source named "${source}".`);
      const usage = usageCountsBySlug({ since: new Date(Date.now() - 30 * 86400000).toISOString() });
      const skills = listSkills({ query, category, sourceId: sourceRow?.id ?? null, viewer: admin ? "*" : createdBy || "" })
        .filter((s) => admin || s.discoverable || active.has(s.slug.toLowerCase()))
        .sort((a, b) => (usage.get(b.slug.toLowerCase())?.total || 0) - (usage.get(a.slug.toLowerCase())?.total || 0) || a.slug.localeCompare(b.slug))
        .slice(0, limit);
      if (!skills.length) return text(query || category ? "No catalog skill matches that." : "The catalog is empty — an admin adds sources or skills in the admin UI under Skills, or create one here with create_skill.");
      const cats = listCategories().slice(0, 12).map((c) => `${c.category} (${c.count})`).join(", ");
      return text(clipText(`${skills.length} skill(s)${query ? ` matching "${query}"` : ""}${category ? ` in ${category}` : ""}:\n${skills.map((s) => skillLine(s)).join("\n")}${cats ? `\n\nCategories: ${cats}` : ""}\nRead one with get_skill_file; grant here with add_channel_skills (managers) or for yourself with add_my_skills.`));
    },
  );

  server.registerTool(
    "get_skill_info",
    { description: "Metadata of one catalog skill: description, owner, version, revisions, files, dependencies, publication state — without the body.", inputSchema: { skill: z.string() } },
    async ({ skill: key }) => {
      const skill = await visibleSkill(key);
      if (!skill) return text(`No catalog skill named "${key}". See list_skills.`);
      const rev = effectiveRevisionFor(skill);
      const revs = listRevisions(skill.id);
      const files = rev ? skillBundle(skill).files.map((f) => f.path) : [];
      return text(clipText([
        `\`${skill.slug}\` — ${skill.name}${skill.deleted ? " (removed)" : ""}`,
        skill.description,
        `Owner: ${describeOwner(skill)} · visibility: ${skill.visibility} · category: ${skill.category || "—"} · version: ${skill.version || "—"} · tags: ${skill.tags.join(", ") || "—"}`,
        `Requires: ${skill.requires.join(", ") || "—"}`,
        rev ? `Effective revision: #${rev.revisionNo}${skill.pinnedRevisionId ? " (pinned)" : ""} · ${files.length} file(s): ${files.join(", ")}${rev.publishedRef ? ` · published ${rev.publishedRef.slice(0, 7)}` : ""}` : `No approved revision yet${skill.stagedCount ? ` (${skill.stagedCount} staged for review)` : ""}.`,
        `Revisions: ${revs.map((r) => `#${r.revisionNo} ${r.status}${r.version ? ` v${r.version}` : ""}`).join(", ")}`,
      ].join("\n")));
    },
  );

  server.registerTool(
    "show_channel_skills",
    { description: "Show the skills active in this conversation: grants by tier (organization / this channel / your personal), dependencies pulled in automatically, anything missing or awaiting review, compatibility notes, and the estimated always-on context cost.", inputSchema: {} },
    async () => {
      const { meta, template, profile, orgSkills, channelSkills, templateSkills, sectionSkills, effective } = await channelProfile();
      if (!effective.skills.length) return text("No skills are granted here yet. A manager can assign a template (list_skill_templates → set_channel_skill_template) or add skills by slug (add_channel_skills); you can add skills for your own runs with add_my_skills.");
      const tier = (e) => {
        const k = e.slug.toLowerCase();
        if (e.via === "dependency") return `required by ${e.requiredBy.join(", ")}`;
        if (orgSkills.has(k)) return "organization";
        if (channelSkills.has(k)) return "added to this channel";
        if (sectionSkills.has(k)) return "this channel's section of the skills repository";
        if (templateSkills.has(k)) return `template ${template?.name || meta.skillTemplate}`;
        return "your personal grant";
      };
      const lines = profile.active.map((e) => `• \`${e.slug}\` — ${tier(e)}${e.revision?.version ? `, v${e.revision.version}` : ""} (~${e.tokens} tokens)`);
      const extra = [];
      if (profile.unknown.length) extra.push(`Not in the catalog (materialized from a host folder if one exists): ${profile.unknown.map((s) => `\`${s}\``).join(", ")}`);
      if (profile.staged.length) extra.push(`Awaiting admin review, not active yet: ${profile.staged.map((s) => `\`${s.slug}\``).join(", ")}`);
      if (profile.removed.length) extra.push(`Removed from their source (tombstoned): ${profile.removed.map((s) => `\`${s.slug}\``).join(", ")}`);
      if (profile.missingDependencies.length) extra.push(`Missing dependencies: ${profile.missingDependencies.map((m) => `\`${m.slug}\` (for ${m.requiredBy})`).join(", ")}`);
      const engine = meta.engine || getEngine();
      const compat = profile.active.flatMap((e) => checkCompatibility(e.skill, { engine, platform: meta.platform || "", gatewayVersion: packageVersion(), mcpServers: (meta.allowedMcps || []).map((m) => m?.name).filter(Boolean) }));
      if (compat.length) extra.push(`Compatibility: ${compat.join("; ")}`);
      const cost = `Always-on context: ~${profile.contextTokens} tokens across ${profile.active.length} skill(s)${profile.contextTokens > profile.warnTokens ? ` — above the ${profile.warnTokens}-token soft cap; consider removing skills that never fire (skill_usage_report)` : ""}.`;
      const overlaps = profile.overlaps.length ? `\nOverlapping triggers: ${profile.overlaps.map((o) => `\`${o.a}\` ↔ \`${o.b}\``).join(", ")}` : "";
      const head = template ? `This channel follows the **${template.name}** template (${templateSkills.size} skill(s) from it; add_channel_skills adds on top).\n` : "This channel follows no template (set_channel_skill_template assigns one).\n";
      return text(clipText(`${head}${lines.join("\n")}\n\n${cost}${overlaps}${extra.length ? `\n\n${extra.join("\n")}` : ""}`));
    },
  );

  server.registerTool(
    "get_skill_file",
    {
      description: "Read a file of a catalog skill (default SKILL.md) — its effective revision — without granting it. Binary files are described, not dumped.",
      inputSchema: { skill: z.string(), file: z.string().optional() },
    },
    async ({ skill: key, file = "SKILL.md" }) => {
      const skill = await visibleSkill(key);
      if (!skill) return text(`No catalog skill named "${key}". See list_skills.`);
      const bundle = skillBundle(skill);
      if (!bundle) return text(`\`${skill.slug}\` has no approved revision yet${skill.stagedCount ? ` (${skill.stagedCount} staged for admin review)` : ""}.`);
      const f = revisionFile(bundle.revision.id, file);
      if (!f) return text(`\`${skill.slug}\` has no file "${file}". Files: ${bundle.files.map((x) => x.path).join(", ")}`);
      const api = fileToApi(f, { includeContent: true });
      if (api.encoding === "base64") return text(`${skill.slug}/${api.path} is binary (${api.contentType}, ${api.size} bytes).`);
      return text(clipText(`${skill.slug}/${api.path} (revision ${bundle.revision.revisionNo}${skill.pinnedRevisionId ? ", pinned" : ""}, ${describeOwner(skill)}):\n\n${api.content}`));
    },
  );

  // ── Channel grants (managers) ─────────────────────────────────────────────────────────────

  server.registerTool(
    "add_channel_skills",
    {
      description: "Any member of this conversation. Activate one or more catalog skills here (by slug from list_skills) — also turns a deactivated template or channel skill back on. Whatever they require loads with them (as a dependency, not as a separate grant). No approval needed; takes effect on the next message.",
      inputSchema: { slugs: z.array(z.string()).min(1) },
    },
    async ({ slugs }) => {
      if (!(await memberHere())) return text("Only people allowed in this conversation can change its skills.");
      const known = [];
      const unknown = [];
      for (const s of slugs) {
        const skill = await visibleSkill(s);
        if (skill && !skill.deleted && skill.visibility !== "personal") known.push(skill.slug);
        else unknown.push(s);
      }
      if (!known.length) return text(`None of those are grantable catalog skills: ${unknown.join(", ")}. See list_skills (personal skills are granted with add_my_skills).`);
      const { sharedProfile: beforeProfile } = await channelProfile();
      const r = await grantSkillsToChannel(slug, known);
      if (!r) return text("Channel isn't set up yet — send a normal message first.");
      // Same audit row the admin UI's grant route writes — the chat path used to change what every
      // future run here loads and leave nothing behind. Slugs only; a skill name is not a secret.
      if (r.added.length) await logEvent("skill_granted", { channel: channelId, slug, skills: r.added, author: createdBy });
      // Cost and warnings over the conversation's whole DURABLE tier (organization + template +
      // its own grants), not just the names this call stored: that is what every future run here
      // loads. The soft-cap warning was computed and thrown away, so the person who pushed the
      // channel over the cap was the one person who never heard about it.
      const { sharedProfile: profile } = await channelProfile();
      const { warnings } = skillGrantContextChange(beforeProfile, profile);
      const changed = [...r.added, ...(r.reactivated || []).filter((x) => !r.added.some((a) => a.toLowerCase() === x.toLowerCase()))];
      return text(`✅ Active here: ${changed.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${r.reactivated?.length ? ` (turned back on: ${r.reactivated.join(", ")})` : ""}${dependencyLine(r.dependencies)}${unknown.length ? `\nUnknown or personal (ignored): ${unknown.join(", ")}` : ""}${profile.staged.length ? `\nAwaiting admin review before they activate: ${profile.staged.map((s) => s.slug).join(", ")}` : ""}\nActive on the next message. Always-on context now ~${profile.contextTokens} tokens.${warnings.length ? `\n⚠️ ${warnings.join("\n⚠️ ")}` : ""}${changed.length ? `\n${ANNOUNCE}` : ""}`);
    },
  );

  server.registerTool(
    "remove_channel_skills",
    {
      description: "Any member of this conversation. Deactivate one or more skills HERE (by slug): an explicit grant is removed, and a skill this channel's template or its own channel section brings in is turned off for this conversation only — the skill stays in the catalog. This is what \"delete this skill\" means for a channel member. Organization-wide grants — and skills that load only because another granted skill requires them — cannot be removed here. No approval needed; takes effect on the next message.",
      inputSchema: { slugs: z.array(z.string()).min(1) },
    },
    async ({ slugs }) => {
      if (!(await memberHere())) return text("Only people allowed in this conversation can change its skills.");
      const r = await revokeSkillsFromChannel(slug, slugs, { deactivate: true });
      if (!r) return text("Channel isn't set up yet.");
      if (r.removed.length) await logEvent("skill_revoked", { channel: channelId, slug, skills: r.removed, deactivated: r.deactivated, author: createdBy });
      const org = new Set((getOrgAccessGrants().skills || []).map((s) => String(s).toLowerCase()));
      const stillOrg = slugs.filter((s) => org.has(String(s).toLowerCase()));
      return text(`🗑️ Deactivated here: ${r.removed.map((s) => `\`${s}\``).join(", ") || "(nothing)"}.${r.deactivated?.length ? ` (${r.deactivated.join(", ")} stay in the catalog and in other conversations; add_channel_skills turns them back on here.)` : ""}${stillOrg.length ? `\nStill active from the organization tier (an admin changes that with remove_org_skills): ${stillOrg.join(", ")}` : ""}${stillRequiredLine(r.stillRequired)}\nNow granted here: ${r.names.join(", ") || "(none)"}. Active on the next message.${r.removed.length ? `\n${ANNOUNCE}` : ""}`);
    },
  );

  // ── Your own tier (any approved member; only your own runs change) ────────────────────────

  server.registerTool(
    "add_my_skills",
    { description: "Add catalog skills to YOUR OWN grants — they load in your runs in every conversation (like starring in a skill library). Whatever they require loads with them (as a dependency, not as a separate grant). No approval needed; only your own context changes.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await personalAuthor())) return text("Only approved members have personal skill grants.");
      const known = [];
      const unknown = [];
      for (const s of slugs) {
        const skill = await visibleSkill(s);
        if (skill && !skill.deleted) known.push(skill.slug);
        else unknown.push(s);
      }
      if (!known.length) return text(`None of those are catalog skills you can see: ${unknown.join(", ")}.`);
      const r = await grantSkillsToUser(createdBy, known);
      return text(`✅ Added to your skills: ${r.added.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${dependencyLine(r.dependencies)}${unknown.length ? `\nUnknown (ignored): ${unknown.join(", ")}` : ""}\nYours now (${r.names.length}): ${r.names.join(", ")}. Active on your next message.`);
    },
  );

  server.registerTool(
    "remove_my_skills",
    { description: "Remove skills from YOUR OWN grants. Organization and channel grants are unaffected.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!createdBy || ctx.apiPrincipal) return text("No verified user context — personal skill grants can only be changed from your own Slack message.");
      const r = await revokeSkillsFromUser(createdBy, slugs);
      return text(`🗑️ Removed ${r.removed.length} of your grant(s)${r.removed.length ? `: ${r.removed.join(", ")}` : ""}. Yours now: ${r.names.join(", ") || "(none)"}.${stillRequiredLine(r.stillRequired)}`);
    },
  );

  // ── Templates ─────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_skill_templates",
    { description: "List the channel skill templates (Development, Sales, Marketing, Management, and any custom ones) with the skills each currently resolves to.", inputSchema: {} },
    async () => {
      const templates = listTemplateSummaries();
      if (!templates.length) return text("No templates are defined yet (an admin creates them in the admin UI under Skills).");
      return text(clipText(templates.map((t) => `• **${t.name}** (\`${t.slug}\`)${t.description ? ` — ${t.description}` : ""}\n  ${t.resolved.length ? `${t.resolved.length} skill(s): ${t.resolved.join(", ")}` : "resolves to no skills yet"}${t.categories.length ? `\n  categories: ${t.categories.join(", ")}` : ""}${t.missing.length ? `\n  missing: ${t.missing.join(", ")}` : ""}`).join("\n")));
    },
  );

  server.registerTool(
    "preview_skill_template",
    {
      description: "Show what this conversation's skills would be if it followed a template (its own added skills kept): skills gained/kept/dropped, dependencies, context cost. Nothing changes.",
      inputSchema: { template: z.string() },
    },
    async ({ template }) => {
      const meta = (await loadMeta()) || {};
      const p = previewTemplate(template, meta);
      if (!p) return text(`No template named "${template}". See list_skill_templates.`);
      // Two numbers, both labelled: this tier alone, and what the conversation actually pays once
      // the organization tier (always on, whatever the template says) is counted with it.
      return text(`Following **${p.template.name}** here would give:\n• gain: ${p.add.join(", ") || "(nothing)"}\n• keep: ${p.keep.join(", ") || "(nothing)"}\n• drop: ${p.remove.join(", ") || "(nothing)"}${p.missing.length ? `\n• template names skills not in the catalog: ${p.missing.join(", ")}` : ""}\nChannel tier (${p.names.length}): ${p.names.join(", ") || "(none)"}\nAlways-on context: this tier adds ~${p.context.tier} tokens; effective total ~${p.context.effective} tokens per turn (organization tier ~${p.context.organization}, loaded in every conversation)${p.context.warnings.length ? `\nWarnings: ${p.context.warnings.join("; ")}` : ""}`);
    },
  );

  server.registerTool(
    "update_skill_template",
    {
      description: "ADMINS. Add skills to, or remove skills from, a skill template (Development, Sales, …). Every conversation following the template gets the change on its next message. Anyone else asks with propose_skill_change kind template.",
      inputSchema: {
        template: z.string().describe("Template slug or name (list_skill_templates)"),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    async ({ template, add = [], remove = [] }) => {
      if (!(await requireAdmin())) return text("Only admins edit skill templates. Ask for it with propose_skill_change (kind template).");
      if (!add.length && !remove.length) return text("Name skills to add or remove.");
      try {
        const out = [];
        if (add.length) {
          const r = addSkillsToTemplate(template, add, { actor: createdBy });
          out.push(`Added: ${r.added.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${r.refused.length ? ` · not added (unknown, deleted or personal): ${r.refused.join(", ")}` : ""}`);
        }
        if (remove.length) {
          const r = removeSkillsFromTemplate(template, remove, { actor: createdBy });
          out.push(`Removed: ${r.removed.map((s) => `\`${s}\``).join(", ") || "(none of those were in it)"}`);
        }
        const tpl = listTemplateSummaries().find((t) => t.slug === (getTemplate(template)?.slug || template));
        return text(`✅ **${tpl?.name || template}** template updated. ${out.join("\n")}\nNow ${tpl?.resolved.length ?? 0} skill(s): ${tpl?.resolved.join(", ") || "(none)"}. Conversations following it get the change on their next message.\n${ANNOUNCE}`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "set_channel_skill_template",
    {
      description: "Any member of this conversation. Make this conversation follow a skill template (Development, Sales, …): it gets the template's CURRENT skills, live, plus whatever add_channel_skills adds on top. `template: \"none\"` stops following. No approval needed; active on the next message.",
      inputSchema: { template: z.string() },
    },
    async ({ template }) => {
      if (!(await memberHere())) return text("Only people allowed in this conversation can change its skills.");
      const r = await assignTemplateToChannel(slug, template);
      if (!r) return text(`Could not assign "${template}": unknown template, or this channel isn't set up yet.`);
      // Same event kind the admin UI's template route writes, so both surfaces read alike.
      await logEvent("skill_template_assigned", { channel: channelId, slug, template: r.template?.slug || "none", author: createdBy });
      if (!r.template) return text(`✅ This channel follows no template now. Its own added skills stay (${r.names.length}): ${r.names.join(", ") || "(none)"}.`);
      return text(`✅ This channel now follows **${r.template.name}**: +${r.add.length} skill(s)${r.remove.length ? `, −${r.remove.length}` : ""}. Channel tier (${r.names.length}): ${r.names.join(", ") || "(none)"}\nAlways-on context ~${r.context.effective} tokens per turn (this tier ~${r.context.tier} + the organization tier ~${r.context.organization}).${r.profile.staged.length ? `\nAwaiting admin review: ${r.profile.staged.map((s) => s.slug).join(", ")}` : ""} Template edits follow automatically; add_channel_skills adds on top. Active on the next message.`);
    },
  );

  // ── Authoring ─────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "create_skill",
    {
      description: "Create a NEW skill from files (SKILL.md with name + description frontmatter is required; add references/*, scripts/* as needed). Where it lives: by default a CHANNEL skill of this conversation (active here automatically, editable by its members; in a DM, a personal skill). Only when the user explicitly asks for an organization-wide skill pass scope \"organization\": an admin's goes straight into the shared library; anyone else's is created here as a channel skill and an admin is asked to promote it. personal:true keeps it private to you. No approval card for channel or personal skills. Read the skill-authoring skill first.",
      inputSchema: {
        slug: z.string().optional().describe("Folder name; defaults to the frontmatter name, slugified"),
        files: z.array(FILE_INPUT).min(1),
        note: z.string().optional(),
        grant_here: z.boolean().optional().describe("For an organization skill an admin creates, also activate it in this conversation (default true). Channel and personal skills are active automatically."),
        personal: z.boolean().optional().describe("Private to you and active in your own runs everywhere (default false). Cannot be combined with scope channel."),
        scope: z.enum(["channel", "organization", "library"]).optional().describe("Omit unless the user said where it belongs. channel (the default in a channel): this conversation's own skill. organization (alias library): the shared library for every conversation — only when the user explicitly asked for an organization-level skill."),
      },
    },
    async ({ slug: wanted = "", files, note = "", grant_here = true, personal = false, scope }) => {
      if (!(await approvedAuthor())) return text("Only approved members can add skills.");
      if (personal && ctx.apiPrincipal) return text("An HTTP API run has no personal catalog — create a shared skill instead (personal: false).");
      const { channelId, meta: scopeMeta } = await channelProfile();
      const inChannel = Boolean(channelId) && !scopeMeta.isDM;
      const admin = await isAdminUser();
      const wantsOrg = scope === "organization" || scope === "library";
      // A personal skill with scope channel is still refused by createLocalSkill, with its reason.
      let tier = personal ? "personal" : wantsOrg ? "organization" : scope === "channel" ? "channel" : inChannel ? "channel" : ctx.apiPrincipal ? "organization" : "personal";
      if (tier === "channel" && !personal && !inChannel) return text("A channel skill needs a channel: create it from that channel, make it personal, or ask for an organization skill.");
      // Admins moderate the organization tier: anyone else's organization skill starts life where
      // they are (a channel skill here, or personal in a DM) with a promotion request for an admin.
      let promoteRequest = false;
      if (tier === "organization" && !admin) {
        promoteRequest = true;
        tier = inChannel ? "channel" : "personal";
        if (tier === "personal" && !(await personalAuthor())) return text("Only admins can add organization skills from here.");
      }
      try {
        const r = await createLocalSkill({
          slug: wanted,
          files,
          note,
          createdBy,
          grantTo: tier === "organization" && grant_here ? slug : "",
          personal: tier === "personal",
          channelId: tier === "channel" || (personal && scope === "channel") ? channelId : "",
        });
        let proposalLine = "";
        if (promoteRequest) {
          try {
            const { proposal } = proposeSkillChange({ skill: r.skill.slug, kind: "promote", note: note || `Requested as an organization skill by ${createdBy}.`, proposedBy: createdBy, channelSlug: slug });
            proposalLine = `\n📝 Organization-wide use needs an admin: promotion request #${proposal.id} is filed (list_skill_proposals / decide_skill_proposal, or the admin UI under Skills → Review). Until then it works ${tier === "channel" ? "in this conversation" : "in your own runs"}.`;
          } catch (err) {
            proposalLine = `\n⚠️ Could not file the promotion request: ${err?.message || err}`;
          }
        }
        const label = tier === "personal" ? "personal skill" : tier === "channel" ? "channel skill" : "organization skill";
        const where = tier === "personal" ? "active in your own runs" : tier === "channel" ? "active in this conversation automatically; any member here can edit or deactivate it" : r.granted ? `in the shared library and active here${r.granted.dependencies?.length ? ` (it requires ${r.granted.dependencies.map((d) => d.slug).join(", ")}, which load with it)` : ""}` : "in the shared library, not active anywhere yet";
        return text(`✅ Created ${label} \`${r.skill.slug}\` (revision ${r.revision.revisionNo}, ${r.revision.fileCount} file(s)) — ${where}. Takes effect on the next message.${publishLine(r.published)}${proposalLine}\n${ANNOUNCE}`);
      } catch (err) {
        return text(`🚫 Could not create the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "update_skill",
    {
      description: "Publish a new revision of a skill (pass only the files that change; the rest is kept). Personal skills: their author. Channel skills: any member of that channel. Organization skills: admins directly — anyone else's edit is filed as a change proposal for an admin. No approval card otherwise. A skill whose source this gateway cannot write to (bundled, another repository, a host folder, a peer gateway) is never edited in place: create a companion skill instead.",
      inputSchema: { skill: z.string(), files: z.array(FILE_INPUT).min(1), remove: z.array(z.string()).optional(), note: z.string().optional() },
    },
    async ({ skill: key, files, remove = [], note = "" }) => {
      const skill = await visibleSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      const edit = skillEditability(skill);
      if (!edit.editable) {
        return text(`\`${skill.slug}\` is ${describeOwner(skill)} — this gateway cannot write to that source, so it is not edited in place (a sync would bring the old files back). Extend it instead: create_skill a companion skill (e.g. \`${skill.slug}-extras\`, a channel skill by default) whose SKILL.md says when to use it together with \`${skill.slug}\`, lists \`requires: [${skill.slug}]\` in its frontmatter so the original loads with it, and carries the additional references/scripts.`);
      }
      const tier = skillTier(skill);
      const admin = await isAdminUser();
      let allowed = admin;
      if (!allowed && tier === "personal") allowed = Boolean(createdBy) && skill.createdBy === createdBy;
      if (!allowed && tier === "channel") allowed = skill.channelScope === ((await loadMeta())?.channelId || channelId) && (await memberHere());
      if (!allowed) {
        if (tier === "organization" && (await approvedAuthor())) {
          try {
            const { proposal } = proposeSkillChange({ skill: skill.slug, kind: "change", files, note: note || `Edit requested by ${createdBy}.`, proposedBy: createdBy, channelSlug: slug });
            return text(`📝 \`${skill.slug}\` is an organization skill, so an admin approves edits to it: change proposal #${proposal.id} is filed with your files${remove.length ? " (file removals cannot ride a proposal — mention them to the admin)" : ""}. Nothing changes until an admin approves it.`);
          } catch (err) {
            return text(`🚫 Could not file the change proposal: ${err?.message || err}`);
          }
        }
        if (tier === "channel") return text(`\`${skill.slug}\` belongs to another channel; its members (or an admin) change it. propose_skill_change sends them your edit.`);
        return text(`\`${skill.slug}\` is someone else's; propose a change (propose_skill_change).`);
      }
      try {
        const r = await updateLocalSkill({ skill, files, remove, note, createdBy });
        if (!r.changed) return text(`\`${skill.slug}\` is unchanged — those files match the current revision.`);
        const pinNote = r.pinned && r.via === "repository" && !r.published?.published ? " It is pinned here until the repository has these files, so a sync cannot revert it." : "";
        return text(`✅ \`${skill.slug}\` is now revision ${r.revision.revisionNo} (${r.revision.fileCount} file(s)). Conversations that use it get the new files on their next message.${publishLine(r.published)}${pinNote}\n${ANNOUNCE}`);
      } catch (err) {
        return text(`🚫 Could not update the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "delete_skill",
    {
      description: "Delete a skill from the WHOLE catalog (tombstone; an admin can restore it). Admins: any locally authored skill; anyone: their own personal skill. For anyone else it deactivates the skill in this conversation and files a delete request for an admin. When a member says \"delete this skill\" about a channel skill they usually mean remove_channel_skills (deactivate it here).",
      inputSchema: { skill: z.string() },
    },
    async ({ skill: key }) => {
      const skill = await visibleSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      const admin = await isAdminUser();
      const ownPersonal = skill.visibility === "personal" && Boolean(createdBy) && skill.createdBy === createdBy;
      if (admin || ownPersonal) {
        try {
          deleteOwnSkill({ skill, userId: createdBy, isAdmin: admin });
          return text(`🗑️ Removed \`${skill.slug}\` from the catalog. Conversations that used it drop it on their next message; an admin can restore it in the admin UI.\n${ANNOUNCE}`);
        } catch (err) {
          return text(`🚫 ${err?.message || err}`);
        }
      }
      if (!(await approvedAuthor())) return text("Only approved members can ask for a skill to be deleted.");
      let here = "";
      if (await memberHere()) {
        const r = await revokeSkillsFromChannel(slug, [skill.slug], { deactivate: true });
        if (r?.removed?.length) {
          await logEvent("skill_revoked", { channel: channelId, slug, skills: r.removed, deactivated: r.deactivated, author: createdBy });
          here = `Deactivated \`${skill.slug}\` in this conversation. `;
        }
      }
      try {
        const { proposal } = proposeSkillChange({ skill: skill.slug, kind: "delete", note: `Delete requested by ${createdBy}.`, proposedBy: createdBy, channelSlug: slug });
        return text(`🗑️ ${here}Deleting it from the whole catalog is an admin's decision: delete request #${proposal.id} is filed.${here ? `\n${ANNOUNCE}` : ""}`);
      } catch (err) {
        return text(`🚫 ${here}Could not file the delete request: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "propose_skill_change",
    {
      description: "Ask an admin for a change you cannot make yourself: kind change (the changed files + a note) for an organization skill, feedback (note only), promote (a personal or channel skill becomes an organization skill; an organization skill gets granted everywhere), delete (remove a shared skill from the whole catalog), or template (add the skill to the skill template named in `template` — templates are admin-edited skill sets such as Development or Sales). An admin reviews it with decide_skill_proposal or in the admin UI.",
      inputSchema: {
        skill: z.string(),
        note: z.string(),
        files: z.array(FILE_INPUT).optional(),
        kind: z.enum(["change", "feedback", "promote", "delete", "template"]).optional(),
        template: z.string().optional().describe("For kind template: the template slug or name (list_skill_templates)"),
      },
    },
    async ({ skill: key, note, files = [], kind = "change", template = "" }) => {
      if (!(await approvedAuthor())) return text("Only approved members can file proposals.");
      try {
        const { proposal, skill } = proposeSkillChange({ skill: key, kind, files, note, proposedBy: createdBy, channelSlug: slug, template });
        return text(`📝 Proposal #${proposal.id} filed for \`${proposal.slug}\` (${kind}${proposal.target ? ` → template ${proposal.target}` : ""}${skill ? `, ${describeOwner(skill)}` : ", new skill"}). An admin reviews it (list_skill_proposals / decide_skill_proposal, or the admin UI under Skills → Review).`);
      } catch (err) {
        return text(`🚫 Could not file the proposal: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "list_skill_proposals",
    { description: "ADMINS. List skill proposals (default: pending).", inputSchema: { status: z.enum(["pending", "approved", "rejected", "all"]).optional() } },
    async ({ status = "pending" }) => {
      if (!(await requireAdmin())) return text("Only admins can review skill proposals.");
      const rows = listProposals({ status: status === "all" ? "" : status });
      if (!rows.length) return text(`No ${status === "all" ? "" : `${status} `}proposals.`);
      return text(clipText(rows.map((p) => `• #${p.id} ${p.kind} \`${p.slug}\` by ${p.proposedBy || "?"}${p.channelSlug ? ` in ${p.channelSlug}` : ""} — ${p.status}${p.files.length ? `, ${p.files.length} file(s): ${p.files.map((f) => f.path).join(", ")}` : ""}${p.note ? `\n  ${p.note.slice(0, 300)}` : ""}`).join("\n")));
    },
  );

  server.registerTool(
    "decide_skill_proposal",
    {
      description: "ADMINS. Approve or reject a skill proposal. Approving a change publishes a new revision (pinned as a local override when the skill comes from a source); approving a promotion makes a personal skill an organization skill or grants an organization skill everywhere; approving feedback closes it.",
      inputSchema: { id: z.number().int(), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
    },
    async ({ id, decision, note = "" }) => {
      if (!(await requireAdmin())) return text("Only admins can decide skill proposals.");
      try {
        const r = await decideSkillProposal(id, { decision, decidedBy: createdBy, note });
        if (decision === "reject") return text(`Proposal #${id} rejected.`);
        return text(`✅ Proposal #${id} approved${r.revision ? ` — \`${r.proposal.slug}\` is now revision ${r.revision.revisionNo}${r.pinned ? " (pinned as a local override of its source; unpin in the admin UI to follow the source again)" : ""}` : ""}${r.promoted ? ` — \`${r.proposal.slug}\` promoted` : ""}${r.deleted ? ` — \`${r.proposal.slug}\` removed from the catalog (restorable in the admin UI)` : ""}${r.templated ? ` — \`${r.proposal.slug}\` added to the ${r.proposal.target} template (every conversation following it gets it on its next message)` : ""}.${publishLine(r.published)}`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "set_skill_scope",
    {
      description: "ADMINS. Move a skill between the shared library and a channel's section of the skills repository: scope library makes it available to every conversation (the channel it leaves keeps it as an explicit grant); scope channel keeps it for one customer/project only. Moves the files in the repository too.",
      inputSchema: {
        skill: z.string(),
        scope: z.enum(["library", "channel"]),
        channel: z.string().optional().describe("Channel slug for scope channel (default: this conversation)"),
      },
    },
    async ({ skill: key, scope, channel = "" }) => {
      const skill = await visibleSkill(key);
      if (!skill) return text(`No catalog skill named "${key}".`);
      let channelId = "";
      if (scope === "channel") {
        const stored = channel ? await getChannelMeta(channel) : await loadMeta();
        channelId = stored?.channelId || "";
        if (!channelId || stored?.isDM) return text(channel ? `No channel "${channel}".` : "A channel section needs a channel: run this from the customer's channel or name it with channel.");
      }
      // Either direction changes the organization tier (a skill joins or leaves the shared library),
      // which admins moderate; a member asks for it with propose_skill_change kind promote.
      if (!(await requireAdmin())) return text("Only admins move skills between the shared library and a channel (a member can ask with propose_skill_change, kind promote).");
      try {
        const r = await moveSkillScope({ slug: skill.slug, channelId, actor: createdBy });
        if (!r.moved) return text(`\`${skill.slug}\` is already ${scope === "channel" ? "in that channel's section" : "in the shared library"}.`);
        const repo = r.repo?.moved ? ` Repository: ${r.repo.from} → ${r.repo.path}.` : r.repo === null ? " (not published yet — it moves in the repository when it is)" : "";
        const kept = r.kept?.added?.length ? ` The channel keeps it as an explicit grant.` : "";
        return text(`✅ \`${skill.slug}\` is now ${scope === "channel" ? "channel-specific (granted there automatically)" : "in the shared library"}.${repo}${kept} Active on the next message.`);
      } catch (err) {
        return text(`🚫 Could not move the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "publish_skill",
    { description: "ADMINS / CHANNEL MANAGERS. Push a local skill's current revision to the configured Git repository now (normally automatic on create/update/approve).", inputSchema: { skill: z.string() } },
    async ({ skill: key }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can publish skills.");
      const target = publishTarget();
      if (!target) return text("Git publishing is not configured (Admin → Skills → Sources → Publishing).");
      const skill = await visibleSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      try {
        const r = await publishRevision({ slug: skill.slug, actor: createdBy });
        return text(r.published ? `✅ Published \`${skill.slug}\` to ${r.repo}@${r.branch} under ${r.path} (${r.files.length} file(s)${r.deleted.length ? `, ${r.deleted.length} removed` : ""}).${r.adopted ? " It is now owned by that source." : ""}` : `Not published: ${r.reason}`);
      } catch (err) {
        return text(`🚫 Publishing failed: ${err?.message || err}`);
      }
    },
  );

  // ── Usage ─────────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "skill_usage_report",
    { description: "This conversation's skill usage: one total per skill, recorded user/channel attribution, exact time window, inferred-read provenance and granted skills never used. Missing historical identities stay unknown.", inputSchema: { days: z.number().int().min(1).max(365).optional() } },
    async ({ days = 30 }) => {
      const { shared } = await channelProfile();
      const r = skillUsageReport({ channelSlug: slug, days, grants: shared.skills, includeAttribution: true });
      const entry = await getChannelEntry(channelId);
      const ids = [...new Set(r.attribution.rows.map((row) => row.userId).filter(Boolean))];
      const userNames = new Map(await Promise.all(ids.map(async (id) => [id, (await getUser(id))?.name || ""])));
      return text(clipText(formatSkillUsageReport(r, { conversationId: channelId, conversationName: entry?.name || "", userNames })));
    },
  );

  // ── Organization tier and sources (admins) ────────────────────────────────────────────────

  server.registerTool(
    "add_org_skills",
    { description: "ADMINS. Grant skills organization-wide (every conversation). Whatever they require loads with them (as a dependency, not as a separate grant).", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await requireAdmin())) return text("Only admins change the organization tier.");
      const known = slugs.map((s) => getSkill(s)).filter((s) => s && !s.deleted && s.visibility !== "personal").map((s) => s.slug);
      if (!known.length) return text("None of those are grantable catalog skills.");
      const r = grantSkillsToOrg(known);
      return text(`✅ Organization-wide now: +${r.added.length} (${r.added.join(", ") || "nothing new"}). Total ${r.names.length}: ${r.names.join(", ")}. Every conversation gets them on its next message.${dependencyLine(r.dependencies)}`);
    },
  );

  server.registerTool(
    "remove_org_skills",
    { description: "ADMINS. Stop granting skills organization-wide.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await requireAdmin())) return text("Only admins change the organization tier.");
      const r = revokeSkillsFromOrg(slugs);
      return text(`🗑️ Removed ${r.removed.length} organization grant(s)${r.removed.length ? `: ${r.removed.join(", ")}` : ""}. Organization-wide now: ${r.names.join(", ") || "(none)"}.${stillRequiredLine(r.stillRequired)}`);
    },
  );

  server.registerTool(
    "set_skill_governance",
    {
      description: "ADMINS. Enable/disable a catalog skill, approve/revoke organization-wide discoverability, or make/unmake it mandatory in every conversation. Mandatory implies enabled and discoverable.",
      inputSchema: { skill: z.string(), enabled: z.boolean().optional(), discoverable: z.boolean().optional(), mandatory: z.boolean().optional() },
    },
    async ({ skill: key, enabled, discoverable, mandatory }) => {
      if (!(await requireAdmin())) return text("Only admins change catalog governance.");
      const skill = getSkill(key);
      if (!skill) return text(`No catalog skill named "${key}".`);
      if (enabled === false) {
        revokeSkillsFromOrg([skill.slug]);
        excludeSkill(skill.slug);
      } else if (enabled === true) restoreSkill(skill.slug);
      const mandatoryNow = (getOrgAccessGrants().skills || []).some((s) => String(s).toLowerCase() === skill.slug.toLowerCase());
      if (typeof discoverable === "boolean" && !(mandatoryNow && discoverable === false && mandatory !== false)) setSkillDiscoverable(skill.slug, discoverable);
      if (typeof mandatory === "boolean") {
        if (mandatory) {
          restoreSkill(skill.slug);
          setSkillDiscoverable(skill.slug, true);
          grantSkillsToOrg([skill.slug]);
        } else revokeSkillsFromOrg([skill.slug]);
      }
      const next = getSkill(skill.slug);
      const isMandatory = (getOrgAccessGrants().skills || []).some((s) => String(s).toLowerCase() === next.slug.toLowerCase());
      return text(`✅ \`${next.slug}\`: ${next.deleted ? "disabled" : "enabled"}, ${next.discoverable ? "discoverable" : "admin/current-channel only"}, ${isMandatory ? "mandatory in every conversation" : "optional"}. Active on the next message.`);
    },
  );

  server.registerTool(
    "list_skill_sources",
    { description: "ADMINS. The configured skill sources (GitHub repositories, host folders, peer gateways) with their mode and last sync.", inputSchema: {} },
    async () => {
      if (!(await requireAdmin())) return text("Only admins see skill sources.");
      const sources = listSources();
      if (!sources.length) return text("No sources yet. Add one with add_skill_source (or the admin UI → Skills → Sources).");
      return text(clipText(sources.map((s) => `• #${s.id} ${s.kind} ${s.label ? `**${s.label}** ` : ""}${s.url}${s.ref ? ` @${s.ref}` : ""}${s.subpath ? ` /${s.subpath}` : ""} — mode ${s.mode}${s.enabled ? "" : ", disabled"}${s.pinnedRef ? `, pinned ${s.pinnedRef.slice(0, 7)}` : ""}${s.lastSyncAt ? `, last sync ${s.lastSyncAt.slice(0, 16).replace("T", " ")} (${s.lastSyncStats?.discovered ?? "?"} skills)` : ", never synced"}${s.lastSyncError ? `\n  ⚠️ ${s.lastSyncError}` : ""}`).join("\n")));
    },
  );

  server.registerTool(
    "add_skill_source",
    {
      description: "ADMINS. Add a skill source: a GitHub repository (URL, optionally a /tree/<branch>/<folder> link), a folder on the gateway host, or a peer gateway (its URL + an access token minted there with the sync scope). Syncs immediately; review mode stages new skills for approval.",
      inputSchema: { kind: z.enum(SOURCE_KINDS), url: z.string(), label: z.string().optional(), ref: z.string().optional(), subpath: z.string().optional(), mode: z.enum(SOURCE_MODES).optional(), token: z.string().optional().describe("gateway kind: the peer's access token (never echoed)") },
    },
    async ({ kind, url, label = "", ref = "", subpath = "", mode = "review", token = "" }) => {
      if (!(await requireAdmin())) return text("Only admins add skill sources.");
      try {
        const source = addSource({ kind, url, label, ref, subpath, mode, secret: token, createdBy });
        const r = await syncOneSource(source.id, { log: () => {} });
        return text(r.ok ? `✅ Source #${source.id} added and synced: ${r.discovered} skill(s) — ${r.created} new, ${r.updated} updated, ${r.staged} staged for review${r.conflicts?.length ? `, conflicts: ${r.conflicts.map((c) => c.slug).join(", ")}` : ""}.` : `Source #${source.id} added, but the first sync failed: ${r.error}`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "set_skill_source",
    { description: "ADMINS. Change a source: mode (review/auto), enabled, pinned commit, label.", inputSchema: { id: z.number().int(), mode: z.enum(SOURCE_MODES).optional(), enabled: z.boolean().optional(), pinned_ref: z.string().optional(), label: z.string().optional() } },
    async ({ id, mode, enabled, pinned_ref, label }) => {
      if (!(await requireAdmin())) return text("Only admins change skill sources.");
      try {
        const s = updateSource(id, { ...(mode ? { mode } : {}), ...(typeof enabled === "boolean" ? { enabled } : {}), ...(pinned_ref !== undefined ? { pinnedRef: pinned_ref } : {}), ...(label !== undefined ? { label } : {}) });
        return text(`✅ Source #${s.id}: mode ${s.mode}${s.enabled ? "" : ", disabled"}${s.pinnedRef ? `, pinned ${s.pinnedRef.slice(0, 7)}` : ""}.`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "remove_skill_source",
    { description: "ADMINS. Remove a source; its skills are tombstoned (restorable) and no longer granted.", inputSchema: { id: z.number().int() } },
    async ({ id }) => {
      if (!(await requireAdmin())) return text("Only admins remove skill sources.");
      try {
        const r = removeSource(id);
        return text(`🗑️ Source #${id} removed; ${r.tombstoned} skill(s) tombstoned.`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "set_skill_excluded",
    { description: "ADMINS. Exclude a synced/bundled skill from the catalog (it stays out across syncs and imports; conversations drop it) or include it again.", inputSchema: { skill: z.string(), excluded: z.boolean() } },
    async ({ skill: key, excluded }) => {
      if (!(await requireAdmin())) return text("Only admins exclude skills.");
      const skill = getSkill(key);
      if (!skill) return text(`No catalog skill named "${key}".`);
      if (excluded) excludeSkill(skill.slug);
      else restoreSkill(skill.slug);
      return text(excluded ? `🚫 \`${skill.slug}\` excluded — it stays out of the catalog across syncs. Include it again with excluded: false.` : `✅ \`${skill.slug}\` included again.`);
    },
  );

  server.registerTool(
    "sync_skill_sources",
    { description: "ADMINS. Pull the configured skill sources now (all, or one by id). Review-mode sources stage new revisions for approval.", inputSchema: { id: z.number().int().optional() } },
    async ({ id } = {}) => {
      if (!(await requireAdmin())) return text("Only admins can sync skill sources.");
      let results;
      try {
        results = id ? [await syncOneSource(id, { log: () => {} })] : await runScheduledSkillSync({ log: () => {} });
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
      if (!results.length) return text("No sources are configured (add_skill_source, or admin UI → Skills → Sources).");
      return text(results.map((r) => (r.ok ? `✅ ${r.url}: ${r.discovered} skill(s) — ${r.created} new, ${r.updated} updated, ${r.staged} staged for review, ${r.unchanged} unchanged${r.tombstoned ? `, ${r.tombstoned} removed` : ""}${r.conflicts?.length ? `, conflicts: ${r.conflicts.map((c) => c.slug).join(", ")}` : ""}` : `🚫 ${r.url}: ${r.error}`)).join("\n"));
    },
  );

  // Publishing status is useful context for authors without being a tool of its own.
  void getSkillsPublish;
}
