// Authoring and review: create a local skill, revise one, delete your own, decide a proposal,
// and the grant helpers for the three tiers. Shared by the gateway MCP tools (chat), the external
// MCP endpoint and the admin API so every surface applies exactly the same rules:
//   • only a LOCAL skill is edited in place; a bundled/folder/synced skill is changed through a
//     proposal whose approval becomes a pinned local-override revision (the source keeps flowing
//     into later revisions; the pin holds until an admin unpins);
//   • a revision is the complete folder — callers may pass only the files that change, and the
//     rest of the current revision is carried over (plus an explicit remove list);
//   • a PERSONAL skill is visible and grantable only to its author (and admins); a "promote"
//     proposal, once approved, makes it an organization skill;
//   • every new revision of a local skill is published to the configured Git repository when
//     publishing is on (publish.js) — best effort, reported, never blocking.
import { getSkill, putSkillRevision, skillBundle, pinSkill, getProposal, decideProposal, createProposal, normalizeSlug, setSkillVisibility, tombstoneSkill, SkillCatalogError } from "./catalog.js";
import { normalizeSkillFiles, decodeInputFile, isSkillManifestPath } from "./files.js";
import { parseFrontmatter, skillMetadata, slugFromName } from "./frontmatter.js";
import { withDependencies } from "./resolve.js";
import { publishQuietly, publishTarget, publishSource, moveSkillFiles } from "./publish.js";
import { normalizeChannelScope, setSkillChannelScope, listRevisions } from "./catalog.js";
import { getOrgAccessGrants, saveSettings } from "../../config/settings.js";
import { patchChannelMeta, getUser, setUser, getChannelEntry } from "../../config/store.js";
import { sanitizeSkillGrantNames } from "../access-grants.js";
import { logEvent } from "../../util/logger.js";

// Overlay `inputFiles` on the skill's current files; drop `remove` paths. Returns Buffer files.
export function mergeSkillFiles(currentFiles = [], inputFiles = [], remove = []) {
  const byPath = new Map();
  for (const f of currentFiles) byPath.set(f.path.toLowerCase(), { path: f.path, content: f.content, executable: Boolean(f.executable) });
  for (const raw of Array.isArray(inputFiles) ? inputFiles : []) {
    const f = decodeInputFile(raw);
    byPath.set(f.path.toLowerCase(), f);
  }
  for (const p of Array.isArray(remove) ? remove : []) byPath.delete(String(p).trim().replace(/^\.?\//, "").toLowerCase());
  return normalizeSkillFiles([...byPath.values()]);
}

export function currentFilesOf(skill) {
  return skillBundle(skill)?.files || [];
}

export function describeOwner(skill) {
  switch (skill?.ownerKind) {
    case "git":
      return `synced from a source${skill.sourceId ? ` (#${skill.sourceId})` : ""}`;
    case "folder":
      return "imported from a host skill folder";
    case "bundled":
      return "bundled with the gateway";
    default:
      return `${skill?.visibility === "personal" ? "personal, " : ""}authored locally${skill?.createdBy ? ` by ${skill.createdBy}` : ""}`;
  }
}

// May `userId` see this skill at all? Personal skills are their author's (admins see everything).
export function canSeeSkill(skill, { userId = "", isAdmin = false, active = false } = {}) {
  if (!skill) return false;
  if (skill.visibility !== "personal") return isAdmin || skill.discoverable || active;
  return isAdmin || (Boolean(userId) && skill.createdBy === userId);
}

// Add a new locally authored skill. `grantTo` (a channel slug) grants it there at once (its
// `requires:` dependencies come along at materialization, they are not grants of their own);
// `personal` keeps it private to the author (granted to the author's own tier);
// `channelId` scopes it to that channel's section of the skills repository (granted there
// automatically, published under channels/<id>/) — the default is the shared library.
export async function createLocalSkill({ slug = "", files, note = "", createdBy = "", grantTo = "", personal = false, publish = true, channelId = "" } = {}) {
  const scope = normalizeChannelScope(channelId);
  if (scope && personal) throw new SkillCatalogError("a personal skill cannot be scoped to a channel section", { status: 400 });
  // "Create" never revises: an existing live skill of that slug — whoever owns it — is refused.
  const manifest = (Array.isArray(files) ? files : []).find((f) => isSkillManifestPath(f?.path));
  const name = manifest ? skillMetadata(parseFrontmatter(Buffer.isBuffer(manifest.content) ? manifest.content.toString("utf8") : String(manifest.content ?? "")).data).name : "";
  const wanted = normalizeSlug(slug) || slugFromName(name);
  const existing = wanted ? getSkill(wanted) : null;
  if (existing && !existing.deleted) {
    throw new SkillCatalogError(`"${existing.slug}" already exists (${describeOwner(existing)}) — update it with update_skill, or propose a change`, { status: 409 });
  }
  const r = putSkillRevision({ slug, files, ownerKind: "local", sourceRef: "manual", note, createdBy, status: "active", visibility: personal ? "personal" : "org", channelScope: scope });
  if (r.conflict) throw new SkillCatalogError(`${r.reason} — update it with update_skill, or propose a change`, { status: 409 });
  let granted = null;
  if (personal && createdBy) granted = await grantSkillsToUser(createdBy, [r.skill.slug]);
  else if (grantTo && !scope) granted = await grantSkillsToChannel(grantTo, [r.skill.slug]);
  logEvent("skill_created", { slug: grantTo, author: createdBy, skill: r.skill.slug, revision: r.revision?.revisionNo, personal, scope });
  const published = publish && !personal ? await publishQuietly({ slug: r.skill.slug, revisionId: r.revision.id, actor: createdBy }) : { published: false, reason: personal ? "personal skills are not published" : "skipped" };
  return { ...r, granted, published };
}

// A new revision of a LOCAL skill from partial files. Authorization is the caller's job (author,
// manager or admin); ownership is enforced here.
export async function updateLocalSkill({ skill, files = [], remove = [], note = "", createdBy = "", publish = true } = {}) {
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  if (skill.ownerKind !== "local") throw new SkillCatalogError(`"${skill.slug}" is ${describeOwner(skill)}; it is changed through a proposal (propose_skill_change), not edited in place`, { status: 409 });
  const merged = mergeSkillFiles(currentFilesOf(skill), files, remove);
  const r = putSkillRevision({ slug: skill.slug, files: merged, ownerKind: "local", sourceRef: "manual", note, createdBy, status: "active" });
  if (r.conflict) throw new SkillCatalogError(r.reason, { status: 409 });
  if (r.changed) logEvent("skill_updated", { author: createdBy, skill: skill.slug, revision: r.revision?.revisionNo });
  const published = r.changed && publish && skill.visibility !== "personal" ? await publishQuietly({ slug: skill.slug, revisionId: r.revision.id, actor: createdBy }) : { published: false, reason: r.changed ? "not published" : "unchanged" };
  return { ...r, published };
}

// Move a skill between the shared library and a channel's section ("" = the library). The
// repository moves first when the skill has files there (the publish repository's own skills and
// any published local one); a never-published local skill just changes scope. Leaving a section
// keeps the skill in that channel as an explicit grant, so nothing changes for it.
export async function moveSkillScope({ slug, channelId = "", actor = "", fetchImpl = fetch } = {}) {
  const skill = getSkill(slug);
  if (!skill || skill.deleted) throw new SkillCatalogError("skill not found", { status: 404 });
  if (skill.visibility === "personal") throw new SkillCatalogError(`"${skill.slug}" is personal; make it an organization skill before placing it in a section`, { status: 409 });
  const scope = normalizeChannelScope(channelId);
  if (scope && !(await getChannelEntry(scope))) throw new SkillCatalogError(`no channel with id ${scope}`, { status: 404 });
  const from = skill.channelScope || "";
  if (from === scope) return { skill, moved: false, repo: null, kept: null, from, to: scope };
  const source = publishSource(publishTarget());
  const inPublishRepo = skill.ownerKind === "git" && Boolean(source) && skill.sourceId === source.id;
  if (skill.ownerKind !== "local" && !inPublishRepo) {
    throw new SkillCatalogError(`"${skill.slug}" is ${describeOwner(skill)}; only skills in the publish repository or authored here move between sections`, { status: 409 });
  }
  let repo = null;
  if (inPublishRepo || listRevisions(skill.id).some((r) => r.publishedRef)) repo = await moveSkillFiles({ slug: skill.slug, channelId: scope, actor, fetchImpl });
  else setSkillChannelScope(skill.slug, scope);
  let kept = null;
  if (from && !scope) {
    const entry = await getChannelEntry(from);
    if (entry?.slug) kept = await grantSkillsToChannel(entry.slug, [skill.slug]);
  }
  logEvent("skill_scope_changed", { skill: skill.slug, from, to: scope, author: actor, repo: Boolean(repo?.moved) });
  return { skill: getSkill(skill.slug), moved: true, repo, kept, from, to: scope };
}

// Remove a skill you authored (tombstone: revisions stay, restorable by an admin).
export function deleteOwnSkill({ skill, userId = "", isAdmin = false } = {}) {
  if (!skill || skill.deleted) throw new SkillCatalogError("skill not found", { status: 404 });
  if (skill.ownerKind !== "local") throw new SkillCatalogError(`"${skill.slug}" is ${describeOwner(skill)} and cannot be deleted from chat; an admin can exclude it in the admin UI`, { status: 409 });
  if (!isAdmin && skill.createdBy !== userId) throw new SkillCatalogError(`only the author of "${skill.slug}" (or an admin) can delete it`, { status: 403 });
  tombstoneSkill(skill.slug);
  logEvent("skill_removed", { skill: skill.slug, author: userId });
  return getSkill(skill.slug);
}

// ── Grant helpers (organization / conversation / user tiers) ────────────────────────────────
//
// A stored grant list holds EXPLICIT grants only. A `requires:` dependency is never written into
// it: it is resolved on every materialization (folders.js → withDependencies) and in every
// effective profile (resolve.js), so it stays attributed as "required by <parent>" instead of
// masquerading as a direct grant of that tier — and revoking the parent takes the dependency with
// it instead of stranding it as a grant nobody asked for. The helpers below still REPORT the
// dependencies a grant pulls in, so the chat verbs and the admin API can name them.

// The dependencies a grant list resolves to, as { slug, requiredBy } — never stored, only shown.
// Never let a catalog hiccup break a grant write: reporting is best effort.
function dependencyEntries(names) {
  if (!names.length) return [];
  try {
    const { profile } = withDependencies(names);
    return profile.active.filter((e) => e.via === "dependency").map((e) => ({ slug: e.slug, requiredBy: [...e.requiredBy] }));
  } catch {
    return [];
  }
}

function resolveGrantSlugs(slugs, current) {
  const have = new Set(current.map((s) => s.toLowerCase()));
  const added = [];
  for (const s of sanitizeSkillGrantNames(slugs)) {
    // Store the catalog slug for a catalog skill (a name or a differently-cased folder name
    // resolves to it); a name the catalog does not know is kept as given (a host-folder grant).
    const resolved = getSkill(s)?.slug || s;
    if (!have.has(resolved.toLowerCase()) && !added.some((w) => w.toLowerCase() === resolved.toLowerCase())) added.push(resolved);
  }
  const names = [...current, ...added];
  let dependencies = [];
  if (added.length) {
    const before = new Set(dependencyEntries(current).map((e) => e.slug.toLowerCase()));
    dependencies = dependencyEntries(names).filter((e) => !before.has(e.slug.toLowerCase()));
  }
  return { names, added, dependencies };
}

function dropGrantSlugs(slugs, current) {
  const drop = new Set();
  for (const s of sanitizeSkillGrantNames(slugs)) {
    drop.add(s.toLowerCase());
    const skill = getSkill(s);
    if (skill) drop.add(skill.slug.toLowerCase());
  }
  const removed = [];
  const kept = current.filter((s) => {
    const skill = getSkill(s);
    const hit = drop.has(s.toLowerCase()) || (skill && drop.has(skill.slug.toLowerCase()));
    if (hit) removed.push(s);
    return !hit;
  });
  // A name that is no grant of this tier can still be active because something else requires it;
  // say so rather than reporting a removal that changes nothing.
  const stillRequired = dependencyEntries(kept).filter((e) => drop.has(e.slug.toLowerCase()));
  return { names: kept, removed, stillRequired };
}

// Grant slugs to a conversation. Returns { added, dependencies, names } — `names` is the stored
// (explicit) list, `dependencies` what those grants pull in at materialization — or null when the
// conversation is unknown.
export async function grantSkillsToChannel(channelSlug, slugs) {
  let result = null;
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    result = resolveGrantSlugs(slugs, sanitizeSkillGrantNames(meta.skills || []));
    return { skills: result.names };
  });
  return next ? { added: result.added, dependencies: result.dependencies, names: next.skills } : null;
}

export async function revokeSkillsFromChannel(channelSlug, slugs) {
  let result = null;
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    result = dropGrantSlugs(slugs, sanitizeSkillGrantNames(meta.skills || []));
    return { skills: result.names };
  });
  return next ? { removed: result.removed, stillRequired: result.stillRequired, names: next.skills } : null;
}

// A user's own tier: skills only that user's runs carry (Skills Manager's "stars").
export async function grantSkillsToUser(userId, slugs) {
  const user = (await getUser(userId)) || {};
  const result = resolveGrantSlugs(slugs, sanitizeSkillGrantNames(user.skills || []));
  await setUser(userId, { skills: result.names });
  return { added: result.added, dependencies: result.dependencies, names: result.names };
}

export async function revokeSkillsFromUser(userId, slugs) {
  const user = (await getUser(userId)) || {};
  const result = dropGrantSlugs(slugs, sanitizeSkillGrantNames(user.skills || []));
  await setUser(userId, { skills: result.names });
  return { removed: result.removed, stillRequired: result.stillRequired, names: result.names };
}

// The organization tier: every conversation.
export function grantSkillsToOrg(slugs) {
  const grants = getOrgAccessGrants();
  const result = resolveGrantSlugs(slugs, sanitizeSkillGrantNames(grants.skills || []));
  if (result.added.length) saveSettings({ accessGrants: { ...grants, skills: result.names } });
  return { added: result.added, dependencies: result.dependencies, names: result.names };
}

export function revokeSkillsFromOrg(slugs) {
  const grants = getOrgAccessGrants();
  const result = dropGrantSlugs(slugs, sanitizeSkillGrantNames(grants.skills || []));
  if (result.removed.length) saveSettings({ accessGrants: { ...grants, skills: result.names } });
  return { removed: result.removed, stillRequired: result.stillRequired, names: result.names };
}

// Kept for callers of the previous name: grant one skill organization-wide.
export function promoteSkillToOrg(slug) {
  const skill = getSkill(slug);
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  const r = grantSkillsToOrg([skill.slug]);
  return { promoted: r.added.length > 0, skills: r.names };
}

// ── Proposals ───────────────────────────────────────────────────────────────────────────────

// File a proposal. Kinds: change (files + note), feedback (note only), promote (make a personal
// skill an organization skill, or grant an organization skill everywhere — decided on approval).
export function proposeSkillChange({ skill = "", kind = "change", files = [], note = "", proposedBy = "", channelSlug = "" } = {}) {
  const existing = getSkill(skill);
  const slug = existing?.slug || skill;
  if (!["change", "feedback", "promote"].includes(kind)) throw new SkillCatalogError(`unknown proposal kind "${kind}"`);
  if ((kind === "promote" || kind === "feedback") && !existing) throw new SkillCatalogError(`"${skill}" is not in the catalog`, { status: 404 });
  if (kind === "feedback" && !String(note || "").trim()) throw new SkillCatalogError("feedback needs a note");
  if (kind === "change" && !existing && !(files || []).some((f) => isSkillManifestPath(f?.path))) {
    throw new SkillCatalogError(`"${skill}" is not in the catalog — a proposal for a new skill needs a SKILL.md`, { status: 404 });
  }
  const proposal = createProposal({ slug, kind, files: kind === "feedback" ? [] : files, note, proposedBy, channelSlug });
  logEvent("skill_proposal", { slug: channelSlug, author: proposedBy, skill: slug, kind, proposal: proposal.id });
  return { proposal, skill: existing };
}

// Approve or reject. Approval of a change writes one revision (pinned as an override when the
// skill is source-owned) and publishes it; approval of a promotion makes a personal skill an
// organization skill (and publishes it) or, for an organization skill, grants it everywhere;
// approving feedback just closes it.
export async function decideSkillProposal(id, { decision, decidedBy = "", note = "" } = {}) {
  const proposal = getProposal(id);
  if (!proposal) throw new SkillCatalogError("proposal not found", { status: 404 });
  if (proposal.status !== "pending") throw new SkillCatalogError(`proposal #${id} is already ${proposal.status}`, { status: 409 });
  if (decision === "reject") {
    const p = decideProposal(id, { status: "rejected", decidedBy, note });
    logEvent("skill_proposal_decided", { author: decidedBy, proposal: id, skill: p.slug, decision: "rejected" });
    return { proposal: p, revision: null, pinned: false, promoted: false, published: null };
  }
  if (decision !== "approve") throw new SkillCatalogError("decision must be approve or reject");
  const skill = getSkill(proposal.slug);
  let revision = null;
  let pinned = false;
  let promoted = false;
  let published = null;
  if (proposal.kind === "promote") {
    if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
    if (skill.visibility === "personal") {
      setSkillVisibility(skill.slug, "org");
      promoted = true;
      published = await publishQuietly({ slug: skill.slug, actor: decidedBy });
    } else {
      promoted = grantSkillsToOrg([skill.slug]).added.length > 0;
    }
  } else if (proposal.kind === "change") {
    const merged = mergeSkillFiles(skill ? currentFilesOf(skill) : [], proposal.files);
    const r = putSkillRevision({
      slug: skill?.slug || proposal.slug,
      files: merged,
      ownerKind: skill?.ownerKind || "local",
      sourceId: skill?.sourceId ?? null,
      sourcePath: skill?.sourcePath || "",
      sourceRef: `proposal:${proposal.id}`,
      note: note || proposal.note || `proposal #${proposal.id} by ${proposal.proposedBy}`,
      createdBy: decidedBy,
      status: "active",
    });
    if (r.conflict) throw new SkillCatalogError(r.reason, { status: 409 });
    revision = r.revision;
    if (skill && skill.ownerKind !== "local" && revision) {
      pinSkill(skill.slug, revision.revisionNo);
      pinned = true;
    }
    if (revision && (skill?.ownerKind === "local" || !skill)) published = await publishQuietly({ slug: r.skill.slug, revisionId: revision.id, actor: decidedBy });
  }
  const p = decideProposal(id, { status: "approved", decidedBy, note, revisionId: revision?.id ?? null });
  logEvent("skill_proposal_decided", { author: decidedBy, proposal: id, skill: p.slug, decision: "approved", revision: revision?.revisionNo, pinned, promoted });
  return { proposal: p, revision, pinned, promoted, published };
}
