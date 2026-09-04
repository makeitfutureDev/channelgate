// Authoring and review: create a local skill, revise one, and decide a proposal. Shared by the
// gateway MCP tools (chat) and the admin API so both surfaces apply exactly the same rules:
//   • only a LOCAL skill is edited in place; a bundled/folder/git skill is changed through a
//     proposal whose approval becomes a pinned local-override revision (the source keeps flowing
//     into later revisions; the pin holds until an admin unpins);
//   • a revision is the complete folder — callers may pass only the files that change, and the
//     rest of the current revision is carried over (plus an explicit remove list);
//   • a "promote" proposal, once approved, grants the skill organization-wide.
import { getSkill, putSkillRevision, skillBundle, pinSkill, getProposal, decideProposal, createProposal, normalizeSlug, SkillCatalogError } from "./catalog.js";
import { normalizeSkillFiles, decodeInputFile, isSkillManifestPath } from "./files.js";
import { parseFrontmatter, skillMetadata, slugFromName } from "./frontmatter.js";
import { withDependencies } from "./resolve.js";
import { getOrgAccessGrants, saveSettings } from "../../config/settings.js";
import { patchChannelMeta } from "../../config/store.js";
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

// Add a new locally authored skill. `grantTo` (a channel slug) grants it there at once, with its
// dependencies. Refuses a slug another owner holds.
export async function createLocalSkill({ slug = "", files, note = "", createdBy = "", grantTo = "" } = {}) {
  // "Create" never revises: an existing live skill of that slug — whoever owns it — is refused.
  const manifest = (Array.isArray(files) ? files : []).find((f) => isSkillManifestPath(f?.path));
  const name = manifest ? skillMetadata(parseFrontmatter(Buffer.isBuffer(manifest.content) ? manifest.content.toString("utf8") : String(manifest.content ?? "")).data).name : "";
  const wanted = normalizeSlug(slug) || slugFromName(name);
  const existing = wanted ? getSkill(wanted) : null;
  if (existing && !existing.deleted) {
    throw new SkillCatalogError(`"${existing.slug}" already exists (${describeOwner(existing)}) — update it with update_skill, or propose a change`, { status: 409 });
  }
  const r = putSkillRevision({ slug, files, ownerKind: "local", sourceRef: "manual", note, createdBy, status: "active" });
  if (r.conflict) throw new SkillCatalogError(`${r.reason} — update it with update_skill, or propose a change`, { status: 409 });
  let granted = null;
  if (grantTo) granted = await grantSkillsToChannel(grantTo, [r.skill.slug]);
  logEvent("skill_created", { slug: grantTo, author: createdBy, skill: r.skill.slug, revision: r.revision?.revisionNo });
  return { ...r, granted };
}

// A new revision of a LOCAL skill from partial files. Authorization is the caller's job (author,
// manager or admin); ownership is enforced here.
export function updateLocalSkill({ skill, files = [], remove = [], note = "", createdBy = "" } = {}) {
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  if (skill.ownerKind !== "local") throw new SkillCatalogError(`"${skill.slug}" is ${describeOwner(skill)}; it is changed through a proposal (propose_skill_change), not edited in place`, { status: 409 });
  const merged = mergeSkillFiles(currentFilesOf(skill), files, remove);
  const r = putSkillRevision({ slug: skill.slug, files: merged, ownerKind: "local", sourceRef: "manual", note, createdBy, status: "active" });
  if (r.conflict) throw new SkillCatalogError(r.reason, { status: 409 });
  if (r.changed) logEvent("skill_updated", { author: createdBy, skill: skill.slug, revision: r.revision?.revisionNo });
  return r;
}

export function describeOwner(skill) {
  switch (skill?.ownerKind) {
    case "git":
      return `synced from a git source${skill.sourceId ? ` (#${skill.sourceId})` : ""}`;
    case "folder":
      return "imported from a host skill folder";
    case "bundled":
      return "bundled with the gateway";
    default:
      return `authored locally${skill?.createdBy ? ` by ${skill.createdBy}` : ""}`;
  }
}

// Grant slugs (plus their dependencies) to a conversation. Returns { added, names } or null when
// the conversation is unknown.
export async function grantSkillsToChannel(channelSlug, slugs) {
  let added = [];
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    const current = sanitizeSkillGrantNames(meta.skills || []);
    const have = new Set(current.map((s) => s.toLowerCase()));
    // Store the catalog slug for a catalog skill (a name or a differently-cased folder name
    // resolves to it); a name the catalog does not know is kept as given (a host-folder grant).
    const wanted = [];
    for (const s of sanitizeSkillGrantNames(slugs)) {
      const resolved = getSkill(s)?.slug || s;
      if (!have.has(resolved.toLowerCase()) && !wanted.some((w) => w.toLowerCase() === resolved.toLowerCase())) wanted.push(resolved);
    }
    const { names } = withDependencies([...current, ...wanted]);
    added = names.filter((s) => !have.has(s.toLowerCase()));
    return { skills: names };
  });
  return next ? { added, names: next.skills } : null;
}

export async function revokeSkillsFromChannel(channelSlug, slugs) {
  // Both spellings of every requested name: as given, and the catalog slug it resolves to.
  const drop = new Set();
  for (const s of sanitizeSkillGrantNames(slugs)) {
    drop.add(s.toLowerCase());
    const skill = getSkill(s);
    if (skill) drop.add(skill.slug.toLowerCase());
  }
  let removed = [];
  const next = await patchChannelMeta(channelSlug, (meta) => {
    if (!meta) return null;
    const current = sanitizeSkillGrantNames(meta.skills || []);
    // A grant may be stored under a name that resolves to a slug: drop by either spelling.
    const kept = current.filter((s) => {
      const skill = getSkill(s);
      const hit = drop.has(s.toLowerCase()) || (skill && drop.has(skill.slug.toLowerCase()));
      if (hit) removed.push(s);
      return !hit;
    });
    return { skills: kept };
  });
  return next ? { removed, names: next.skills } : null;
}

// Grant a skill in the organization tier (every conversation).
export function promoteSkillToOrg(slug) {
  const skill = getSkill(slug);
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  const grants = getOrgAccessGrants();
  const current = sanitizeSkillGrantNames(grants.skills || []);
  if (current.some((s) => s.toLowerCase() === skill.slug.toLowerCase())) return { promoted: false, skills: current };
  const { names } = withDependencies([...current, skill.slug]);
  saveSettings({ accessGrants: { ...grants, skills: names } });
  return { promoted: true, skills: names };
}

// File a proposal. A change proposal on an unknown slug proposes a NEW local skill.
export function proposeSkillChange({ skill = "", kind = "change", files = [], note = "", proposedBy = "", channelSlug = "" } = {}) {
  const existing = getSkill(skill);
  const slug = existing?.slug || skill;
  if (kind === "promote" && !existing) throw new SkillCatalogError(`"${skill}" is not in the catalog`, { status: 404 });
  if (kind === "change" && !existing && !(files || []).some((f) => isSkillManifestPath(f?.path))) {
    throw new SkillCatalogError(`"${skill}" is not in the catalog — a proposal for a new skill needs a SKILL.md`, { status: 404 });
  }
  const proposal = createProposal({ slug, kind, files, note, proposedBy, channelSlug });
  logEvent("skill_proposal", { slug: channelSlug, author: proposedBy, skill: slug, kind, proposal: proposal.id });
  return { proposal, skill: existing };
}

// Approve or reject. Approval of a change writes one revision (pinned as an override when the
// skill is source-owned); approval of a promotion grants organization-wide.
export function decideSkillProposal(id, { decision, decidedBy = "", note = "" } = {}) {
  const proposal = getProposal(id);
  if (!proposal) throw new SkillCatalogError("proposal not found", { status: 404 });
  if (proposal.status !== "pending") throw new SkillCatalogError(`proposal #${id} is already ${proposal.status}`, { status: 409 });
  if (decision === "reject") {
    const p = decideProposal(id, { status: "rejected", decidedBy, note });
    logEvent("skill_proposal_decided", { author: decidedBy, proposal: id, skill: p.slug, decision: "rejected" });
    return { proposal: p, revision: null, pinned: false, promoted: false };
  }
  if (decision !== "approve") throw new SkillCatalogError(`decision must be approve or reject`);
  const skill = getSkill(proposal.slug);
  let revision = null;
  let pinned = false;
  let promoted = false;
  if (proposal.kind === "promote") {
    promoted = promoteSkillToOrg(proposal.slug).promoted;
  } else {
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
  }
  const p = decideProposal(id, { status: "approved", decidedBy, note, revisionId: revision?.id ?? null });
  logEvent("skill_proposal_decided", { author: decidedBy, proposal: id, skill: p.slug, decision: "approved", revision: revision?.revisionNo, pinned, promoted });
  return { proposal: p, revision, pinned, promoted };
}
