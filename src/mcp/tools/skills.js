// Skills tools for the gateway control MCP server: what is active in this conversation, the
// catalog, templates, authoring, proposals, usage, and (admins) source sync. Shaped like the
// channel MCP tools — manager-safe changes go through requireManage and the control-plane
// approval card; reads are open to anyone allowed in the channel. Registered via register(server, ctx).
import { z } from "zod";
import { getUser, isAdmin, isApproved } from "../../config/store.js";
import { getOrgAccessGrants, getSkillsContextWarnTokens } from "../../config/settings.js";
import { resolveAccessGrants } from "../../gateway/access-grants.js";
import { getSkill, listSkills, listCategories, skillBundle, revisionFile, listProposals, listSources } from "../../gateway/skills/catalog.js";
import { resolveSkillProfile } from "../../gateway/skills/resolve.js";
import { listTemplateSummaries, previewTemplate, applyTemplateToChannel } from "../../gateway/skills/templates.js";
import { skillUsageReport } from "../../gateway/skills/usage.js";
import { fileToApi } from "../../gateway/skills/files.js";
import {
  createLocalSkill,
  updateLocalSkill,
  grantSkillsToChannel,
  revokeSkillsFromChannel,
  proposeSkillChange,
  decideSkillProposal,
  describeOwner,
} from "../../gateway/skills/authoring.js";
import { syncOneSource, runScheduledSkillSync } from "../../gateway/skills/index.js";

const MAX_TEXT = 12000;
const FILE_INPUT = z.object({
  path: z.string().describe("Path inside the skill folder, e.g. SKILL.md or references/ids.md"),
  content: z.string().describe("File content (text), or base64 when encoding is base64"),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

function clipText(s, n = MAX_TEXT) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}\n… (${str.length - n} more characters)` : str;
}

function skillLine(skill, { detail = true } = {}) {
  const bits = [];
  if (skill.version) bits.push(`v${skill.version}`);
  if (skill.category) bits.push(skill.category);
  bits.push(skill.ownerKind === "git" ? "git source" : skill.ownerKind);
  const desc = skill.description ? ` — ${skill.description.length > 140 ? `${skill.description.slice(0, 137)}…` : skill.description}` : "";
  return `• \`${skill.slug}\`${detail ? ` (${bits.join(", ")})` : ""}${desc}`;
}

export function register(server, ctx) {
  const { slug, createdBy, text, requireAdmin, requireManage, loadMeta } = ctx;

  const approvedAuthor = async () => Boolean(createdBy) && ((await isAdmin(createdBy)) || (await isApproved(createdBy)));

  // The conversation's profile: organization + channel grants (durable) plus the requester's own.
  const channelProfile = async () => {
    const meta = (await loadMeta()) || {};
    const user = createdBy ? (await getUser(createdBy)) || {} : {};
    const shared = resolveAccessGrants({ organization: getOrgAccessGrants(), channel: meta });
    const effective = resolveAccessGrants({ organization: getOrgAccessGrants(), channel: meta, user });
    const warnTokens = getSkillsContextWarnTokens();
    return {
      meta,
      shared,
      effective,
      profile: resolveSkillProfile(effective.skills, { warnTokens }),
      sharedProfile: resolveSkillProfile(shared.skills, { warnTokens }),
      orgSkills: new Set((getOrgAccessGrants().skills || []).map((s) => String(s).toLowerCase())),
      channelSkills: new Set((meta.skills || []).map((s) => String(s).toLowerCase())),
    };
  };

  server.registerTool(
    "list_skills",
    {
      description: "List the skills in the gateway's catalog (bundled, locally authored, imported host folders, synced git sources). Optional text query and category filter. Use show_channel_skills for what is active HERE.",
      inputSchema: { query: z.string().optional(), category: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ query = "", category = "", limit = 60 }) => {
      const skills = listSkills({ query, category, limit });
      if (!skills.length) return text(query || category ? "No catalog skill matches that." : "The catalog is empty — an admin adds sources or skills in the admin UI under Skills, or create one here with create_skill.");
      const cats = listCategories().slice(0, 12).map((c) => `${c.category} (${c.count})`).join(", ");
      return text(clipText(`${skills.length} skill(s)${query ? ` matching "${query}"` : ""}${category ? ` in ${category}` : ""}:\n${skills.map((s) => skillLine(s)).join("\n")}${cats ? `\n\nCategories: ${cats}` : ""}\nRead one with get_skill_file; grant here with add_channel_skills.`));
    },
  );

  server.registerTool(
    "show_channel_skills",
    { description: "Show the skills active in this conversation: grants by tier (organization / this channel / your personal), dependencies pulled in automatically, anything missing or awaiting review, and the estimated always-on context cost.", inputSchema: {} },
    async () => {
      const { profile, orgSkills, channelSkills, effective } = await channelProfile();
      if (!effective.skills.length) return text("No skills are granted here yet. A manager can apply a template (list_skill_templates → apply_skill_template) or add skills by slug (add_channel_skills).");
      const tier = (e) => {
        const k = e.slug.toLowerCase();
        if (e.via === "dependency") return `required by ${e.requiredBy.join(", ")}`;
        if (orgSkills.has(k)) return "organization";
        if (channelSkills.has(k)) return "this channel";
        return "your personal grant";
      };
      const lines = profile.active.map((e) => `• \`${e.slug}\` — ${tier(e)}${e.revision?.version ? `, v${e.revision.version}` : ""} (~${e.tokens} tokens)`);
      const extra = [];
      if (profile.unknown.length) extra.push(`Not in the catalog (materialized from a host folder if one exists): ${profile.unknown.map((s) => `\`${s}\``).join(", ")}`);
      if (profile.staged.length) extra.push(`Awaiting admin review, not active yet: ${profile.staged.map((s) => `\`${s.slug}\``).join(", ")}`);
      if (profile.removed.length) extra.push(`Removed from their source (tombstoned): ${profile.removed.map((s) => `\`${s.slug}\``).join(", ")}`);
      if (profile.missingDependencies.length) extra.push(`Missing dependencies: ${profile.missingDependencies.map((m) => `\`${m.slug}\` (for ${m.requiredBy})`).join(", ")}`);
      const cost = `Always-on context: ~${profile.contextTokens} tokens across ${profile.active.length} skill(s)${profile.contextTokens > profile.warnTokens ? ` — above the ${profile.warnTokens}-token soft cap; consider removing skills that never fire (skill_usage_report)` : ""}.`;
      const overlaps = profile.overlaps.length ? `\nOverlapping triggers: ${profile.overlaps.map((o) => `\`${o.a}\` ↔ \`${o.b}\``).join(", ")}` : "";
      return text(clipText(`${lines.join("\n")}\n\n${cost}${overlaps}${extra.length ? `\n\n${extra.join("\n")}` : ""}`));
    },
  );

  server.registerTool(
    "add_channel_skills",
    {
      description: "ADMINS / CHANNEL MANAGERS. Grant one or more catalog skills in this conversation (by slug from list_skills). Their dependencies are granted with them. Takes effect on the next message.",
      inputSchema: { slugs: z.array(z.string()).min(1) },
    },
    async ({ slugs }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its skills.");
      const known = [];
      const unknown = [];
      for (const s of slugs) {
        const skill = getSkill(s);
        if (skill && !skill.deleted) known.push(skill.slug);
        else unknown.push(s);
      }
      if (!known.length) return text(`None of those are catalog skills: ${unknown.join(", ")}. See list_skills.`);
      const r = await grantSkillsToChannel(slug, known);
      if (!r) return text("Channel isn't set up yet — send a normal message first.");
      const profile = resolveSkillProfile(r.names, { warnTokens: getSkillsContextWarnTokens() });
      return text(`✅ Granted here: ${r.added.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${unknown.length ? `\nUnknown (ignored): ${unknown.join(", ")}` : ""}${profile.staged.length ? `\nAwaiting admin review before they activate: ${profile.staged.map((s) => s.slug).join(", ")}` : ""}\nActive on the next message. Always-on context now ~${profile.contextTokens} tokens.`);
    },
  );

  server.registerTool(
    "remove_channel_skills",
    {
      description: "ADMINS / CHANNEL MANAGERS. Stop granting one or more skills in this conversation (by slug). Organization-wide grants cannot be removed here. Takes effect on the next message.",
      inputSchema: { slugs: z.array(z.string()).min(1) },
    },
    async ({ slugs }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its skills.");
      const r = await revokeSkillsFromChannel(slug, slugs);
      if (!r) return text("Channel isn't set up yet.");
      const org = new Set((getOrgAccessGrants().skills || []).map((s) => String(s).toLowerCase()));
      const stillOrg = slugs.filter((s) => org.has(String(s).toLowerCase()));
      return text(`🗑️ Removed ${r.removed.length} grant(s)${r.removed.length ? `: ${r.removed.map((s) => `\`${s}\``).join(", ")}` : ""}.${stillOrg.length ? `\nStill active from the organization tier (an admin changes that in Settings): ${stillOrg.join(", ")}` : ""}\nNow granted here: ${r.names.join(", ") || "(none)"}. Active on the next message.`);
    },
  );

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
      description: "Show what applying a template to this conversation would change (skills added/kept/removed, dependencies, context cost) without applying it.",
      inputSchema: { template: z.string(), mode: z.enum(["add", "replace"]).optional() },
    },
    async ({ template, mode = "add" }) => {
      const meta = (await loadMeta()) || {};
      const p = previewTemplate(template, meta.skills || [], { mode });
      if (!p) return text(`No template named "${template}". See list_skill_templates.`);
      return text(`Template **${p.template.name}**, mode ${mode}:\n• add: ${p.add.join(", ") || "(nothing)"}\n• keep: ${p.keep.join(", ") || "(nothing)"}${mode === "replace" ? `\n• remove: ${p.remove.join(", ") || "(nothing)"}` : ""}${p.missing.length ? `\n• template names skills not in the catalog: ${p.missing.join(", ")}` : ""}\nResulting grants (${p.names.length}): ${p.names.join(", ") || "(none)"}\nAlways-on context: ~${p.profile.contextTokens} tokens${p.profile.warnings.length ? `\nWarnings: ${p.profile.warnings.join("; ")}` : ""}`);
    },
  );

  server.registerTool(
    "apply_skill_template",
    {
      description: "ADMINS / CHANNEL MANAGERS. Apply a skill template to this conversation: copies the template's current skills into this channel's grants (mode add = keep existing grants, replace = exactly the template). A snapshot — later template edits do not follow. Active on the next message.",
      inputSchema: { template: z.string(), mode: z.enum(["add", "replace"]).optional() },
    },
    async ({ template, mode = "add" }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its skills.");
      const r = await applyTemplateToChannel(slug, template, { mode });
      if (!r) return text(`Could not apply "${template}": unknown template, or this channel isn't set up yet.`);
      return text(`✅ Applied **${r.template.name}** (${mode}): +${r.add.length} skill(s)${r.remove.length ? `, −${r.remove.length}` : ""}.\nGranted here now (${r.names.length}): ${r.names.join(", ") || "(none)"}\nAlways-on context ~${r.profile.contextTokens} tokens.${r.profile.staged.length ? `\nAwaiting admin review: ${r.profile.staged.map((s) => s.slug).join(", ")}` : ""} Active on the next message.`);
    },
  );

  server.registerTool(
    "get_skill_file",
    {
      description: "Read a file of a catalog skill (default SKILL.md) — its effective revision — without granting it. Binary files are described, not dumped.",
      inputSchema: { skill: z.string(), file: z.string().optional() },
    },
    async ({ skill: key, file = "SKILL.md" }) => {
      const skill = getSkill(key);
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

  server.registerTool(
    "create_skill",
    {
      description: "Add a NEW skill to the shared catalog from files (SKILL.md with name + description frontmatter is required; add references/*, scripts/* as needed) and grant it in this conversation. Any approved member may create skills. Read the skill-authoring skill first.",
      inputSchema: {
        slug: z.string().optional().describe("Folder name; defaults to the frontmatter name, slugified"),
        files: z.array(FILE_INPUT).min(1),
        note: z.string().optional(),
        grant_here: z.boolean().optional().describe("Grant the new skill in this conversation (default true)"),
      },
    },
    async ({ slug: wanted = "", files, note = "", grant_here = true }) => {
      if (!(await approvedAuthor())) return text("Only approved members can add skills to the library.");
      try {
        const r = await createLocalSkill({ slug: wanted, files, note, createdBy, grantTo: grant_here ? slug : "" });
        return text(`✅ Created \`${r.skill.slug}\` (revision ${r.revision.revisionNo}, ${r.revision.fileCount} file(s))${r.granted ? `, granted here${r.granted.added.length > 1 ? ` with ${r.granted.added.filter((s) => s !== r.skill.slug).join(", ")}` : ""} — active on the next message` : ""}.\nOther channels can add it with add_channel_skills; an admin can add it to a template or grant it organization-wide (propose_skill_change with kind "promote").`);
      } catch (err) {
        return text(`🚫 Could not create the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "update_skill",
    {
      description: "Publish a new revision of a locally authored skill you created (managers/admins: any local skill). Pass only the files that change; the rest of the current revision is kept. Bundled/imported/synced skills are changed through propose_skill_change.",
      inputSchema: { skill: z.string(), files: z.array(FILE_INPUT).min(1), remove: z.array(z.string()).optional(), note: z.string().optional() },
    },
    async ({ skill: key, files, remove = [], note = "" }) => {
      const skill = getSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      if (skill.ownerKind !== "local") return text(`\`${skill.slug}\` is ${describeOwner(skill)} — send a proposal instead (propose_skill_change).`);
      const own = skill.createdBy && skill.createdBy === createdBy;
      if (!own && !(await requireManage())) return text(`\`${skill.slug}\` was authored by someone else; propose a change (propose_skill_change) or ask a manager/admin.`);
      try {
        const r = updateLocalSkill({ skill, files, remove, note, createdBy });
        return text(r.changed ? `✅ \`${skill.slug}\` is now revision ${r.revision.revisionNo} (${r.revision.fileCount} file(s)). Channels that grant it get the new files on their next message.` : `\`${skill.slug}\` is unchanged — those files match the current revision.`);
      } catch (err) {
        return text(`🚫 Could not update the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "propose_skill_change",
    {
      description: "Propose a change to a shared skill you cannot edit directly (kind change: the changed files + a note), or ask for a skill to be granted organization-wide (kind promote). An admin reviews it with decide_skill_proposal or in the admin UI.",
      inputSchema: { skill: z.string(), note: z.string(), files: z.array(FILE_INPUT).optional(), kind: z.enum(["change", "promote"]).optional() },
    },
    async ({ skill: key, note, files = [], kind = "change" }) => {
      if (!(await approvedAuthor())) return text("Only approved members can file proposals.");
      try {
        const { proposal, skill } = proposeSkillChange({ skill: key, kind, files, note, proposedBy: createdBy, channelSlug: slug });
        return text(`📝 Proposal #${proposal.id} filed for \`${proposal.slug}\` (${kind}${skill ? `, ${describeOwner(skill)}` : ", new skill"}). An admin reviews it (list_skill_proposals / decide_skill_proposal, or the admin UI under Skills).`);
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
      description: "ADMINS. Approve or reject a skill proposal. Approving a change publishes a new revision (pinned as a local override when the skill comes from a source); approving a promotion grants the skill organization-wide.",
      inputSchema: { id: z.number().int(), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
    },
    async ({ id, decision, note = "" }) => {
      if (!(await requireAdmin())) return text("Only admins can decide skill proposals.");
      try {
        const r = decideSkillProposal(id, { decision, decidedBy: createdBy, note });
        if (decision === "reject") return text(`Proposal #${id} rejected.`);
        return text(`✅ Proposal #${id} approved${r.revision ? ` — \`${r.proposal.slug}\` is now revision ${r.revision.revisionNo}${r.pinned ? " (pinned as a local override of its source; unpin in the admin UI to follow the source again)" : ""}` : ""}${r.promoted ? ` — \`${r.proposal.slug}\` is now granted organization-wide` : ""}.`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "skill_usage_report",
    { description: "Which skills fired in this conversation recently (exact for Claude's Skill tool, inferred for Codex file reads) and which granted skills never fired.", inputSchema: { days: z.number().int().min(1).max(365).optional() } },
    async ({ days = 30 }) => {
      const { shared } = await channelProfile();
      const r = skillUsageReport({ channelSlug: slug, days, grants: shared.skills });
      const used = r.used.length ? r.used.map((u) => `• \`${u.slug}\` — ${u.total}× (${u.exact} exact, ${u.inferred} inferred), last ${u.lastTs.slice(0, 10)}`).join("\n") : "• (no skill use recorded)";
      const never = r.neverUsed.length ? r.neverUsed.map((n) => `\`${n.slug}\``).join(", ") : "(none)";
      return text(clipText(`Skill use here in the last ${r.days} days:\n${used}\n\nGranted but never fired: ${never}\n_${r.notes[0]}_`));
    },
  );

  server.registerTool(
    "sync_skill_sources",
    { description: "ADMINS. Pull the configured git skill sources now (all, or one by id). Review-mode sources stage new revisions for approval.", inputSchema: { id: z.number().int().optional() } },
    async ({ id } = {}) => {
      if (!(await requireAdmin())) return text("Only admins can sync skill sources.");
      const results = id ? [{ id, url: listSources().find((s) => s.id === id)?.url || `#${id}`, ...(await syncOneSource(id, { log: () => {} })) }] : await runScheduledSkillSync({ log: () => {} });
      if (!results.length) return text("No git sources are configured (admin UI → Skills → Sources).");
      return text(results.map((r) => (r.ok ? `✅ ${r.url}: ${r.discovered} skill(s) — ${r.created} new, ${r.updated} updated, ${r.staged} staged for review, ${r.unchanged} unchanged${r.tombstoned ? `, ${r.tombstoned} removed` : ""}${r.conflicts.length ? `, conflicts: ${r.conflicts.map((c) => c.slug).join(", ")}` : ""}` : `🚫 ${r.url}: ${r.error}`)).join("\n"));
    },
  );
}
