// Skills tools for the gateway control MCP server: what is active in this conversation, the
// catalog, templates, personal and channel grants, authoring, proposals, usage, and (admins)
// sources, organization grants and publishing. Shaped like the channel MCP tools — manager-safe
// changes go through requireManage and the control-plane approval card; reads are open to anyone
// allowed in the channel; a member's own tier needs no card. Registered via register(server, ctx).
import { z } from "zod";
import { readFileSync } from "node:fs";
import { getUser, isAdmin, isApproved } from "../../config/store.js";
import { getOrgAccessGrants, getSkillsContextWarnTokens, getSkillsPublish, getEngine } from "../../config/settings.js";
import { resolveAccessGrants } from "../../gateway/access-grants.js";
import { getSkill, listSkills, listCategories, skillBundle, revisionFile, listProposals, listSources, addSource, updateSource, removeSource, excludeSkill, restoreSkill, effectiveRevisionFor, listRevisions, SOURCE_KINDS, SOURCE_MODES } from "../../gateway/skills/catalog.js";
import { resolveSkillProfile, checkCompatibility } from "../../gateway/skills/resolve.js";
import { listTemplateSummaries, previewTemplate, assignTemplateToChannel, withTemplateSkills, templateOfMeta } from "../../gateway/skills/templates.js";
import { skillUsageReport } from "../../gateway/skills/usage.js";
import { fileToApi } from "../../gateway/skills/files.js";
import {
  createLocalSkill,
  updateLocalSkill,
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
} from "../../gateway/skills/authoring.js";
import { publishRevision, publishTarget } from "../../gateway/skills/publish.js";
import { syncOneSource, runScheduledSkillSync } from "../../gateway/skills/index.js";

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

function publishLine(p) {
  if (!p) return "";
  if (p.published) return `\nPublished to ${p.repo}@${p.branch} under ${p.path}${p.adopted ? " (now owned by that source)" : ""}.`;
  if (p.failed) return `\n⚠️ Git publishing failed: ${p.reason}`;
  return "";
}

export function register(server, ctx) {
  const { slug, createdBy, text, requireAdmin, requireManage, loadMeta } = ctx;

  const isAdminUser = async () => Boolean(createdBy) && (await isAdmin(createdBy));
  const approvedAuthor = async () => Boolean(createdBy) && ((await isAdminUser()) || (await isApproved(createdBy)));
  const visibleSkill = async (key) => {
    const skill = getSkill(key);
    if (!skill) return null;
    return canSeeSkill(skill, { userId: createdBy, isAdmin: await isAdminUser() }) ? skill : null;
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
      templateSkills: new Set(template ? (meta.skills || []).filter((s) => !(stored.skills || []).some((o) => String(o).toLowerCase() === String(s).toLowerCase())).map((s) => String(s).toLowerCase()) : []),
    };
  };

  // ── Reading ───────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_skills",
    {
      description: "List the skills in the gateway's catalog (bundled, locally authored, imported host folders, synced sources; your own personal skills too). Optional text query and category filter. Use show_channel_skills for what is active HERE.",
      inputSchema: { query: z.string().optional(), category: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ query = "", category = "", limit = 60 }) => {
      const skills = listSkills({ query, category, limit, viewer: (await isAdminUser()) ? "*" : createdBy || "" });
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
      const { meta, template, profile, orgSkills, channelSkills, templateSkills, effective } = await channelProfile();
      if (!effective.skills.length) return text("No skills are granted here yet. A manager can assign a template (list_skill_templates → set_channel_skill_template) or add skills by slug (add_channel_skills); you can add skills for your own runs with add_my_skills.");
      const tier = (e) => {
        const k = e.slug.toLowerCase();
        if (e.via === "dependency") return `required by ${e.requiredBy.join(", ")}`;
        if (orgSkills.has(k)) return "organization";
        if (channelSkills.has(k)) return "added to this channel";
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
      description: "ADMINS / CHANNEL MANAGERS. Grant one or more catalog skills in this conversation (by slug from list_skills). Their dependencies are granted with them. Takes effect on the next message.",
      inputSchema: { slugs: z.array(z.string()).min(1) },
    },
    async ({ slugs }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its skills.");
      const known = [];
      const unknown = [];
      for (const s of slugs) {
        const skill = getSkill(s);
        if (skill && !skill.deleted && skill.visibility !== "personal") known.push(skill.slug);
        else unknown.push(s);
      }
      if (!known.length) return text(`None of those are grantable catalog skills: ${unknown.join(", ")}. See list_skills (personal skills are granted with add_my_skills).`);
      const r = await grantSkillsToChannel(slug, known);
      if (!r) return text("Channel isn't set up yet — send a normal message first.");
      const profile = resolveSkillProfile(r.names, { warnTokens: getSkillsContextWarnTokens() });
      return text(`✅ Granted here: ${r.added.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${unknown.length ? `\nUnknown or personal (ignored): ${unknown.join(", ")}` : ""}${profile.staged.length ? `\nAwaiting admin review before they activate: ${profile.staged.map((s) => s.slug).join(", ")}` : ""}\nActive on the next message. Always-on context now ~${profile.contextTokens} tokens.`);
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
      return text(`🗑️ Removed ${r.removed.length} grant(s)${r.removed.length ? `: ${r.removed.map((s) => `\`${s}\``).join(", ")}` : ""}.${stillOrg.length ? `\nStill active from the organization tier (an admin changes that with remove_org_skills): ${stillOrg.join(", ")}` : ""}\nNow granted here: ${r.names.join(", ") || "(none)"}. Active on the next message.`);
    },
  );

  // ── Your own tier (any approved member; only your own runs change) ────────────────────────

  server.registerTool(
    "add_my_skills",
    { description: "Add catalog skills to YOUR OWN grants — they load in your runs in every conversation (like starring in a skill library). Dependencies come along. No approval needed; only your own context changes.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await approvedAuthor())) return text("Only approved members have personal skill grants.");
      const known = [];
      const unknown = [];
      for (const s of slugs) {
        const skill = await visibleSkill(s);
        if (skill && !skill.deleted) known.push(skill.slug);
        else unknown.push(s);
      }
      if (!known.length) return text(`None of those are catalog skills you can see: ${unknown.join(", ")}.`);
      const r = await grantSkillsToUser(createdBy, known);
      return text(`✅ Added to your skills: ${r.added.map((s) => `\`${s}\``).join(", ") || "(nothing new)"}${unknown.length ? `\nUnknown (ignored): ${unknown.join(", ")}` : ""}\nYours now (${r.names.length}): ${r.names.join(", ")}. Active on your next message.`);
    },
  );

  server.registerTool(
    "remove_my_skills",
    { description: "Remove skills from YOUR OWN grants. Organization and channel grants are unaffected.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!createdBy) return text("No user context.");
      const r = await revokeSkillsFromUser(createdBy, slugs);
      return text(`🗑️ Removed ${r.removed.length} of your grant(s)${r.removed.length ? `: ${r.removed.join(", ")}` : ""}. Yours now: ${r.names.join(", ") || "(none)"}.`);
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
      return text(`Following **${p.template.name}** here would give:\n• gain: ${p.add.join(", ") || "(nothing)"}\n• keep: ${p.keep.join(", ") || "(nothing)"}\n• drop: ${p.remove.join(", ") || "(nothing)"}${p.missing.length ? `\n• template names skills not in the catalog: ${p.missing.join(", ")}` : ""}\nChannel tier (${p.names.length}): ${p.names.join(", ") || "(none)"}\nAlways-on context: ~${p.profile.contextTokens} tokens${p.profile.warnings.length ? `\nWarnings: ${p.profile.warnings.join("; ")}` : ""}`);
    },
  );

  server.registerTool(
    "set_channel_skill_template",
    {
      description: "ADMINS / CHANNEL MANAGERS. Make this conversation follow a skill template (Development, Sales, …): it gets the template's CURRENT skills, live, plus whatever add_channel_skills adds on top. `template: \"none\"` stops following. Active on the next message.",
      inputSchema: { template: z.string() },
    },
    async ({ template }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its skills.");
      const r = await assignTemplateToChannel(slug, template);
      if (!r) return text(`Could not assign "${template}": unknown template, or this channel isn't set up yet.`);
      if (!r.template) return text(`✅ This channel follows no template now. Its own added skills stay (${r.names.length}): ${r.names.join(", ") || "(none)"}.`);
      return text(`✅ This channel now follows **${r.template.name}**: +${r.add.length} skill(s)${r.remove.length ? `, −${r.remove.length}` : ""}. Channel tier (${r.names.length}): ${r.names.join(", ") || "(none)"}\nAlways-on context ~${r.profile.contextTokens} tokens.${r.profile.staged.length ? `\nAwaiting admin review: ${r.profile.staged.map((s) => s.slug).join(", ")}` : ""} Template edits follow automatically; add_channel_skills adds on top. Active on the next message.`);
    },
  );

  // ── Authoring ─────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "create_skill",
    {
      description: "Add a NEW skill to the shared catalog from files (SKILL.md with name + description frontmatter is required; add references/*, scripts/* as needed) and grant it in this conversation. `personal: true` keeps it private to you (granted to your own runs only). Any approved member may create skills. Read the skill-authoring skill first.",
      inputSchema: {
        slug: z.string().optional().describe("Folder name; defaults to the frontmatter name, slugified"),
        files: z.array(FILE_INPUT).min(1),
        note: z.string().optional(),
        grant_here: z.boolean().optional().describe("Grant the new skill in this conversation (default true)"),
        personal: z.boolean().optional().describe("Only you can see and use it (default false)"),
      },
    },
    async ({ slug: wanted = "", files, note = "", grant_here = true, personal = false }) => {
      if (!(await approvedAuthor())) return text("Only approved members can add skills to the library.");
      try {
        const r = await createLocalSkill({ slug: wanted, files, note, createdBy, grantTo: grant_here ? slug : "", personal });
        const where = personal ? "granted to your own runs" : r.granted ? `granted here${r.granted.added.length > 1 ? ` with ${r.granted.added.filter((s) => s !== r.skill.slug).join(", ")}` : ""}` : "not granted anywhere yet";
        return text(`✅ Created \`${r.skill.slug}\` (revision ${r.revision.revisionNo}, ${r.revision.fileCount} file(s), ${personal ? "personal" : "organization"} skill), ${where} — active on the next message.${publishLine(r.published)}\n${personal ? "Promote it to the organization later with propose_skill_change (kind promote)." : "Other channels can add it with add_channel_skills; an admin can add it to a template or grant it organization-wide."}`);
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
      const skill = await visibleSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      if (skill.ownerKind !== "local") return text(`\`${skill.slug}\` is ${describeOwner(skill)} — send a proposal instead (propose_skill_change).`);
      const own = skill.createdBy && skill.createdBy === createdBy;
      if (!own && !(await requireManage())) return text(`\`${skill.slug}\` was authored by someone else; propose a change (propose_skill_change) or ask a manager/admin.`);
      try {
        const r = await updateLocalSkill({ skill, files, remove, note, createdBy });
        return text(r.changed ? `✅ \`${skill.slug}\` is now revision ${r.revision.revisionNo} (${r.revision.fileCount} file(s)). Channels that grant it get the new files on their next message.${publishLine(r.published)}` : `\`${skill.slug}\` is unchanged — those files match the current revision.`);
      } catch (err) {
        return text(`🚫 Could not update the skill: ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "delete_skill",
    { description: "Remove a locally authored skill you created (admins: any local skill) from the catalog. Its revisions are kept and an admin can restore it.", inputSchema: { skill: z.string() } },
    async ({ skill: key }) => {
      const skill = await visibleSkill(key);
      if (!skill || skill.deleted) return text(`No catalog skill named "${key}".`);
      try {
        deleteOwnSkill({ skill, userId: createdBy, isAdmin: await isAdminUser() });
        return text(`🗑️ Removed \`${skill.slug}\` from the catalog. Conversations that granted it drop it on their next message; an admin can restore it in the admin UI.`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
      }
    },
  );

  server.registerTool(
    "propose_skill_change",
    {
      description: "Propose a change to a shared skill you cannot edit directly (kind change: the changed files + a note), leave feedback (kind feedback: note only), or ask for a skill to be promoted (kind promote: a personal skill becomes an organization skill; an organization skill gets granted everywhere). An admin reviews it with decide_skill_proposal or in the admin UI.",
      inputSchema: { skill: z.string(), note: z.string(), files: z.array(FILE_INPUT).optional(), kind: z.enum(["change", "feedback", "promote"]).optional() },
    },
    async ({ skill: key, note, files = [], kind = "change" }) => {
      if (!(await approvedAuthor())) return text("Only approved members can file proposals.");
      try {
        const { proposal, skill } = proposeSkillChange({ skill: key, kind, files, note, proposedBy: createdBy, channelSlug: slug });
        return text(`📝 Proposal #${proposal.id} filed for \`${proposal.slug}\` (${kind}${skill ? `, ${describeOwner(skill)}` : ", new skill"}). An admin reviews it (list_skill_proposals / decide_skill_proposal, or the admin UI under Skills → Review).`);
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
        return text(`✅ Proposal #${id} approved${r.revision ? ` — \`${r.proposal.slug}\` is now revision ${r.revision.revisionNo}${r.pinned ? " (pinned as a local override of its source; unpin in the admin UI to follow the source again)" : ""}` : ""}${r.promoted ? ` — \`${r.proposal.slug}\` promoted` : ""}.${publishLine(r.published)}`);
      } catch (err) {
        return text(`🚫 ${err?.message || err}`);
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
    { description: "Which skills fired in this conversation recently (exact for Claude's Skill tool, inferred for Codex file reads) and which granted skills never fired.", inputSchema: { days: z.number().int().min(1).max(365).optional() } },
    async ({ days = 30 }) => {
      const { shared } = await channelProfile();
      const r = skillUsageReport({ channelSlug: slug, days, grants: shared.skills });
      const used = r.used.length ? r.used.map((u) => `• \`${u.slug}\` — ${u.total}× (${u.exact} exact, ${u.inferred} inferred), last ${u.lastTs.slice(0, 10)}`).join("\n") : "• (no skill use recorded)";
      const never = r.neverUsed.length ? r.neverUsed.map((n) => `\`${n.slug}\``).join(", ") : "(none)";
      return text(clipText(`Skill use here in the last ${r.days} days:\n${used}\n\nGranted but never fired: ${never}\n_${r.notes[0]}_`));
    },
  );

  // ── Organization tier and sources (admins) ────────────────────────────────────────────────

  server.registerTool(
    "add_org_skills",
    { description: "ADMINS. Grant skills organization-wide (every conversation). Dependencies come along.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await requireAdmin())) return text("Only admins change the organization tier.");
      const known = slugs.map((s) => getSkill(s)).filter((s) => s && !s.deleted && s.visibility !== "personal").map((s) => s.slug);
      if (!known.length) return text("None of those are grantable catalog skills.");
      const r = grantSkillsToOrg(known);
      return text(`✅ Organization-wide now: +${r.added.length} (${r.added.join(", ") || "nothing new"}). Total ${r.names.length}: ${r.names.join(", ")}. Every conversation gets them on its next message.`);
    },
  );

  server.registerTool(
    "remove_org_skills",
    { description: "ADMINS. Stop granting skills organization-wide.", inputSchema: { slugs: z.array(z.string()).min(1) } },
    async ({ slugs }) => {
      if (!(await requireAdmin())) return text("Only admins change the organization tier.");
      const r = revokeSkillsFromOrg(slugs);
      return text(`🗑️ Removed ${r.removed.length} organization grant(s)${r.removed.length ? `: ${r.removed.join(", ")}` : ""}. Organization-wide now: ${r.names.join(", ") || "(none)"}.`);
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
