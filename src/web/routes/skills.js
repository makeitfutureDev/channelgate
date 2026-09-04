// Skills platform admin routes (mounted by createAdminRouter under /api): the catalog, its
// revisions and files, sources and their sync, templates (preview/apply per conversation),
// channel profiles, usage, and proposals. Every listing returns metadata only; a file's bytes
// come one at a time. The daemon's GitHub token lives in settings (write-only, revealed only
// through /api/secrets/reveal) and never appears here.
import { Router } from "express";
import {
  listSkills,
  getSkill,
  listCategories,
  listRevisions,
  revisionFiles,
  revisionFile,
  getRevision,
  approveRevision,
  rejectRevision,
  listStagedRevisions,
  pinSkill,
  tombstoneSkill,
  restoreSkill,
  listSources,
  getSource,
  addSource,
  updateSource,
  removeSource,
  getTemplate,
  upsertTemplate,
  deleteTemplate,
  listProposals,
  usageCountsBySlug,
  catalogStats,
  SOURCE_KINDS,
  SOURCE_MODES,
  SkillCatalogError,
} from "../../gateway/skills/catalog.js";
import { fileToApi, SkillFileError } from "../../gateway/skills/files.js";
import { resolveSkillProfile } from "../../gateway/skills/resolve.js";
import { listTemplateSummaries, previewTemplate, applyTemplateToChannel, templateSummary } from "../../gateway/skills/templates.js";
import { skillUsageReport } from "../../gateway/skills/usage.js";
import { createLocalSkill, updateLocalSkill, decideSkillProposal, describeOwner, grantSkillsToChannel, revokeSkillsFromChannel } from "../../gateway/skills/authoring.js";
import { importSkillTree, importHostSkillFolders } from "../../gateway/skills/import-folder.js";
import { syncOneSource, runScheduledSkillSync } from "../../gateway/skills/index.js";
import { resolveAccessGrants } from "../../gateway/access-grants.js";
import { getOrgAccessGrants, getSkillsContextWarnTokens, getSkillsSyncIntervalMinutes, getSkillsGithubToken } from "../../config/settings.js";
import { getChannelMeta, listChannels } from "../../config/store.js";
import { skillSourceDirs } from "../../gateway/folders.js";
import { logEvent } from "../../util/logger.js";

const ADMIN_UI = "admin-ui";

function guard(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err instanceof SkillCatalogError || err instanceof SkillFileError) return res.status(err.status || 400).json({ error: err.message, path: err.path || undefined });
      next(err);
    }
  };
}

function skillToApi(skill, usage = null) {
  const u = usage?.get(skill.slug.toLowerCase());
  return {
    ...skill,
    meta: undefined,
    owner: describeOwner(skill),
    usage30d: u ? { total: u.total, exact: u.exact, inferred: u.inferred, lastTs: u.lastTs } : { total: 0, exact: 0, inferred: 0, lastTs: "" },
  };
}

function channelGrants(slug) {
  return getChannelMeta(slug).then((meta) => (meta ? resolveAccessGrants({ organization: getOrgAccessGrants(), channel: meta }) : null));
}

export function createSkillsRouter() {
  const router = Router();

  // ── Overview ──────────────────────────────────────────────────────────────────────────────
  router.get("/skills/overview", guard(async (_req, res) => {
    res.json({
      stats: catalogStats(),
      sources: listSources(),
      templates: listTemplateSummaries(),
      staged: listStagedRevisions(),
      proposals: listProposals({ status: "pending" }),
      hostFolders: skillSourceDirs(),
      settings: {
        syncIntervalMinutes: getSkillsSyncIntervalMinutes(),
        contextWarnTokens: getSkillsContextWarnTokens(),
        hasGithubToken: Boolean(getSkillsGithubToken()),
      },
    });
  }));

  // ── Catalog ───────────────────────────────────────────────────────────────────────────────
  router.get("/skills/catalog", guard(async (req, res) => {
    const usage = usageCountsBySlug({ since: new Date(Date.now() - 30 * 86400000).toISOString() });
    const skills = listSkills({
      includeDeleted: req.query.deleted === "1",
      ownerKind: typeof req.query.owner === "string" ? req.query.owner : "",
      category: typeof req.query.category === "string" ? req.query.category : "",
      query: typeof req.query.q === "string" ? req.query.q : "",
    }).map((s) => skillToApi(s, usage));
    res.json({ skills, categories: listCategories() });
  }));

  router.get("/skills/catalog/:slug", guard(async (req, res) => {
    const skill = getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: "skill not found" });
    const revisions = listRevisions(skill.id);
    const effectiveId = skill.pinnedRevisionId ?? skill.currentRevisionId;
    const files = effectiveId != null ? revisionFiles(effectiveId).map((f) => fileToApi(f)) : [];
    const usage = skillUsageReport({ days: 90 }).used.find((u) => u.slug.toLowerCase() === skill.slug.toLowerCase()) || null;
    res.json({ skill: skillToApi(skill), revisions, effectiveRevisionId: effectiveId, files, usage, frontmatter: skill.meta });
  }));

  router.get("/skills/catalog/:slug/file", guard(async (req, res) => {
    const skill = getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: "skill not found" });
    const revisionId = req.query.revision ? Number(req.query.revision) : (skill.pinnedRevisionId ?? skill.currentRevisionId);
    if (revisionId == null) return res.status(404).json({ error: "no revision" });
    const rev = getRevision(revisionId);
    if (!rev || rev.skillId !== skill.id) return res.status(404).json({ error: "revision not found" });
    const file = revisionFile(revisionId, String(req.query.path || "SKILL.md"));
    if (!file) return res.status(404).json({ error: "file not found" });
    res.json({ file: fileToApi(file, { includeContent: true }), revision: rev });
  }));

  // Create or update a locally authored skill from the admin UI.
  router.post("/skills/catalog", guard(async (req, res) => {
    const body = req.body || {};
    const files = Array.isArray(body.files) ? body.files : [];
    const existing = body.slug ? getSkill(body.slug) : null;
    if (existing && !existing.deleted) {
      const r = updateLocalSkill({ skill: existing, files, remove: body.remove || [], note: body.note || "", createdBy: ADMIN_UI });
      return res.json({ ok: true, changed: r.changed, skill: skillToApi(r.skill), revision: r.revision });
    }
    const r = await createLocalSkill({ slug: body.slug || "", files, note: body.note || "", createdBy: ADMIN_UI });
    res.status(201).json({ ok: true, created: r.created, skill: skillToApi(r.skill), revision: r.revision });
  }));

  router.delete("/skills/catalog/:slug", guard(async (req, res) => {
    const skill = getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: "skill not found" });
    tombstoneSkill(skill.slug);
    logEvent("skill_removed", { skill: skill.slug, author: ADMIN_UI });
    res.json({ ok: true });
  }));

  router.post("/skills/catalog/:slug/restore", guard(async (req, res) => {
    const skill = getSkill(req.params.slug);
    if (!skill) return res.status(404).json({ error: "skill not found" });
    restoreSkill(skill.slug);
    res.json({ ok: true, skill: skillToApi(getSkill(skill.slug)) });
  }));

  router.post("/skills/catalog/:slug/pin", guard(async (req, res) => {
    const revisionNo = req.body?.revisionNo == null || req.body?.revisionNo === "" ? null : Number(req.body.revisionNo);
    const skill = pinSkill(req.params.slug, revisionNo);
    logEvent("skill_pinned", { skill: skill.slug, revision: revisionNo, author: ADMIN_UI });
    res.json({ ok: true, skill: skillToApi(skill) });
  }));

  // ── Revisions (staged review) ─────────────────────────────────────────────────────────────
  router.get("/skills/staged", guard(async (_req, res) => res.json({ staged: listStagedRevisions() })));

  router.get("/skills/revisions/:id/files", guard(async (req, res) => {
    const rev = getRevision(Number(req.params.id));
    if (!rev) return res.status(404).json({ error: "revision not found" });
    const includeContent = req.query.content === "1";
    res.json({ revision: rev, files: revisionFiles(rev.id).map((f) => fileToApi(f, { includeContent: includeContent && f.content.length <= 256 * 1024 })) });
  }));

  router.post("/skills/revisions/:id/approve", guard(async (req, res) => {
    const rev = approveRevision(Number(req.params.id), { decidedBy: ADMIN_UI });
    logEvent("skill_revision_approved", { revision: rev.id, skill: rev.skillId, author: ADMIN_UI });
    res.json({ ok: true, revision: rev });
  }));

  router.post("/skills/revisions/:id/reject", guard(async (req, res) => {
    const rev = rejectRevision(Number(req.params.id), { note: String(req.body?.note || "rejected in the admin UI") });
    res.json({ ok: true, revision: rev });
  }));

  // ── Sources ───────────────────────────────────────────────────────────────────────────────
  router.get("/skills/sources", guard(async (_req, res) => res.json({ sources: listSources(), hostFolders: skillSourceDirs() })));

  router.post("/skills/sources", guard(async (req, res) => {
    const b = req.body || {};
    if (!SOURCE_KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${SOURCE_KINDS.join(", ")}` });
    if (b.mode && !SOURCE_MODES.includes(b.mode)) return res.status(400).json({ error: `mode must be one of ${SOURCE_MODES.join(", ")}` });
    const source = addSource({ kind: b.kind, label: b.label || "", url: b.url, ref: b.ref || "", subpath: b.subpath || "", pinnedRef: b.pinnedRef || "", mode: b.mode || "review", enabled: b.enabled !== false, createdBy: ADMIN_UI });
    logEvent("skill_source_added", { source: source.id, kind: source.kind, author: ADMIN_UI });
    let sync = null;
    if (b.syncNow !== false) sync = source.kind === "git" ? await syncOneSource(source.id, { log: () => {} }) : await importSkillTree(source.url, { ownerKind: "git", sourceId: source.id, sourceRef: source.url, status: source.mode === "auto" ? "active" : "staged" });
    res.status(201).json({ ok: true, source: getSource(source.id), sync });
  }));

  router.put("/skills/sources/:id", guard(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ["label", "url", "ref", "subpath", "pinnedRef", "mode"]) if (typeof b[k] === "string") patch[k] = b[k];
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    res.json({ ok: true, source: updateSource(Number(req.params.id), patch) });
  }));

  router.delete("/skills/sources/:id", guard(async (req, res) => {
    const r = removeSource(Number(req.params.id));
    logEvent("skill_source_removed", { source: Number(req.params.id), tombstoned: r.tombstoned, author: ADMIN_UI });
    res.json({ ok: true, ...r });
  }));

  router.post("/skills/sources/:id/sync", guard(async (req, res) => {
    const source = getSource(Number(req.params.id));
    if (!source) return res.status(404).json({ error: "source not found" });
    const result = source.kind === "git"
      ? await syncOneSource(source.id, { log: () => {} })
      : await importSkillTree(source.url, { ownerKind: "git", sourceId: source.id, sourceRef: source.url, status: source.mode === "auto" ? "active" : "staged" });
    res.json({ ok: true, result, source: getSource(source.id) });
  }));

  router.post("/skills/sources/sync-all", guard(async (_req, res) => {
    res.json({ ok: true, results: await runScheduledSkillSync({ log: () => {} }) });
  }));

  router.post("/skills/sources/refresh-host", guard(async (_req, res) => {
    res.json({ ok: true, result: await importHostSkillFolders(skillSourceDirs()) });
  }));

  // ── Templates ─────────────────────────────────────────────────────────────────────────────
  router.get("/skills/templates", guard(async (_req, res) => res.json({ templates: listTemplateSummaries() })));

  router.post("/skills/templates", guard(async (req, res) => {
    const b = req.body || {};
    const existing = b.slug ? getTemplate(b.slug) : null;
    const t = upsertTemplate({ slug: b.slug, name: b.name, description: b.description || "", skills: b.skills || [], categories: b.categories || [], builtin: existing ? existing.builtin : false });
    res.json({ ok: true, template: templateSummary(t) });
  }));

  router.delete("/skills/templates/:slug", guard(async (req, res) => {
    const t = getTemplate(req.params.slug);
    if (!t) return res.status(404).json({ error: "template not found" });
    deleteTemplate(t.slug);
    res.json({ ok: true });
  }));

  router.get("/skills/templates/:slug/preview", guard(async (req, res) => {
    const channel = String(req.query.channel || "");
    const meta = channel ? await getChannelMeta(channel) : null;
    if (channel && !meta) return res.status(404).json({ error: "conversation not found" });
    const preview = previewTemplate(req.params.slug, meta?.skills || [], { mode: req.query.mode === "replace" ? "replace" : "add" });
    if (!preview) return res.status(404).json({ error: "template not found" });
    res.json({ preview });
  }));

  router.post("/skills/templates/:slug/apply", guard(async (req, res) => {
    const channel = String(req.body?.channel || "");
    if (!channel) return res.status(400).json({ error: "channel (slug) is required" });
    const r = await applyTemplateToChannel(channel, req.params.slug, { mode: req.body?.mode === "replace" ? "replace" : "add" });
    if (!r) return res.status(404).json({ error: "template or conversation not found" });
    logEvent("skill_template_applied", { slug: channel, template: req.params.slug, mode: r.mode, added: r.add.length, author: ADMIN_UI });
    res.json({ ok: true, applied: r });
  }));

  // ── Profiles + usage ──────────────────────────────────────────────────────────────────────
  router.get("/skills/profile/:channel", guard(async (req, res) => {
    const grants = await channelGrants(req.params.channel);
    if (!grants) return res.status(404).json({ error: "conversation not found" });
    const profile = resolveSkillProfile(grants.skills, { warnTokens: getSkillsContextWarnTokens() });
    res.json({ grants: grants.skills, profile: { ...profile, active: profile.active.map((e) => ({ slug: e.slug, name: e.name, via: e.via, requiredBy: e.requiredBy, tokens: e.tokens, revisionNo: e.revision?.revisionNo, version: e.revision?.version, ownerKind: e.skill.ownerKind })) } });
  }));

  router.post("/skills/profile/:channel/grant", guard(async (req, res) => {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : [];
    if (!slugs.length) return res.status(400).json({ error: "slugs is required" });
    const r = await grantSkillsToChannel(req.params.channel, slugs);
    if (!r) return res.status(404).json({ error: "conversation not found" });
    logEvent("skill_granted", { slug: req.params.channel, skills: r.added, author: ADMIN_UI });
    res.json({ ok: true, ...r });
  }));

  router.post("/skills/profile/:channel/revoke", guard(async (req, res) => {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : [];
    if (!slugs.length) return res.status(400).json({ error: "slugs is required" });
    const r = await revokeSkillsFromChannel(req.params.channel, slugs);
    if (!r) return res.status(404).json({ error: "conversation not found" });
    logEvent("skill_revoked", { slug: req.params.channel, skills: r.removed, author: ADMIN_UI });
    res.json({ ok: true, ...r });
  }));

  router.get("/skills/profiles", guard(async (_req, res) => {
    const out = [];
    for (const ch of await listChannels()) {
      const grants = ch.meta ? resolveAccessGrants({ organization: getOrgAccessGrants(), channel: ch.meta }) : { skills: [] };
      const profile = resolveSkillProfile(grants.skills, { warnTokens: getSkillsContextWarnTokens() });
      out.push({ slug: ch.slug, name: ch.name, platform: ch.platform, isDM: ch.isDM, skills: profile.slugs, contextTokens: profile.contextTokens, warnings: profile.warnings.length });
    }
    res.json({ profiles: out });
  }));

  router.get("/skills/usage", guard(async (req, res) => {
    const channel = String(req.query.channel || "");
    const grants = channel ? await channelGrants(channel) : null;
    res.json({ report: skillUsageReport({ channelSlug: channel, days: Number(req.query.days) || 30, grants: grants ? grants.skills : null }) });
  }));

  // ── Proposals ─────────────────────────────────────────────────────────────────────────────
  router.get("/skills/proposals", guard(async (req, res) => {
    const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status : "";
    res.json({ proposals: listProposals({ status: status || "" }) });
  }));

  router.post("/skills/proposals/:id/approve", guard(async (req, res) => {
    res.json({ ok: true, ...decideSkillProposal(Number(req.params.id), { decision: "approve", decidedBy: ADMIN_UI, note: String(req.body?.note || "") }) });
  }));

  router.post("/skills/proposals/:id/reject", guard(async (req, res) => {
    res.json({ ok: true, ...decideSkillProposal(Number(req.params.id), { decision: "reject", decidedBy: ADMIN_UI, note: String(req.body?.note || "") }) });
  }));

  return router;
}
