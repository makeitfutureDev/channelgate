// The local skill catalog — the one source of truth for every skill a conversation can be
// granted (docs/SKILLS.md). Backed by the gateway's SQLite database (migration 14): a `skills` row
// per slug, immutable content-hashed `skill_revisions`, and the exact bytes of every file in
// `skill_revision_files`. The parsed frontmatter columns are a DERIVED index, rebuilt from the
// activated revision every time; the bytes are canonical.
//
// Ownership is explicit (owner_kind + source_id): a skill that arrived from a git source is only
// ever changed by that source's next sync, a locally authored skill only through the authoring
// paths, and a slug that is claimed by one owner is refused to every other (a conflict, reported,
// never a silent overwrite). Removal is a tombstone (deleted_at), so a channel that still grants
// the skill keeps a readable reason instead of a hole.
//
// Everything here is synchronous SQLite (node:sqlite), like the rest of src/config; the daemon and
// the spawned MCP server both open the same file, and the write transactions below serialize them.
import path from "node:path";
import { getDb, fromJson, toJson } from "../../db/index.js";
import { parseFrontmatter, skillMetadata, slugFromName } from "./frontmatter.js";
import { normalizeSkillFiles, hashSkillFiles, isSkillManifestPath, classifyBytes, sha256, MAX_FILE_BYTES } from "./files.js";

export const OWNER_KINDS = Object.freeze(["bundled", "local", "folder", "git"]);
export const SOURCE_KINDS = Object.freeze(["git", "folder", "gateway"]);
export const VISIBILITIES = Object.freeze(["org", "personal"]);
export const SOURCE_MODES = Object.freeze(["auto", "review"]);
export const REVISION_STATUSES = Object.freeze(["active", "staged", "rejected"]);

export class SkillCatalogError extends Error {
  constructor(message, { code = "catalog", status = 400 } = {}) {
    super(message);
    this.name = "SkillCatalogError";
    this.code = code;
    this.status = status;
  }
}

export const nowIso = () => new Date().toISOString();

// A catalog slug is also a folder name under .claude/skills/: one safe path segment. Folder-owned
// skills keep their directory's exact name (that is what existing grants say); authored and synced
// skills use the Skills Manager slug form of their name.
const SLUG_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export function isValidSlug(slug) {
  return SLUG_RE.test(String(slug || ""));
}

export function normalizeSlug(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (isValidSlug(s)) return s;
  return slugFromName(s);
}

function tx(fn) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already gone */
    }
    throw err;
  }
}

// ── Row mapping ─────────────────────────────────────────────────────────────────────────────

function rowToSkill(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    ownerKind: r.owner_kind,
    sourceId: r.source_id ?? null,
    sourcePath: r.source_path,
    currentRevisionId: r.current_revision_id ?? null,
    pinnedRevisionId: r.pinned_revision_id ?? null,
    category: r.category,
    tags: fromJson(r.tags, []) || [],
    requires: fromJson(r.requires, []) || [],
    version: r.version,
    meta: fromJson(r.meta, {}) || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    deletedAt: r.deleted_at || "",
    deleted: Boolean(r.deleted_at),
    visibility: r.visibility === "personal" ? "personal" : "org",
    stagedCount: Number(r.staged_count || 0),
  };
}

function rowToRevision(r) {
  if (!r) return null;
  return {
    id: r.id,
    skillId: r.skill_id,
    revisionNo: r.revision_no,
    status: r.status,
    contentHash: r.content_hash,
    version: r.version,
    sourceRef: r.source_ref,
    note: r.note,
    fileCount: r.file_count,
    totalBytes: r.total_bytes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    publishedRef: r.published_ref || "",
    publishedAt: r.published_at || "",
  };
}

function rowToFile(r) {
  const content = Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content);
  return { path: r.path, content, size: r.size, sha256: r.sha256, contentType: r.content_type, executable: Boolean(r.executable) };
}

function rowToSource(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    url: r.url,
    ref: r.ref,
    subpath: r.subpath,
    pinnedRef: r.pinned_ref,
    mode: r.mode,
    enabled: Boolean(r.enabled),
    lastSyncAt: r.last_sync_at,
    lastSyncRef: r.last_sync_ref,
    lastSyncError: r.last_sync_error,
    lastSyncStats: fromJson(r.last_sync_stats, {}) || {},
    createdAt: r.created_at,
    createdBy: r.created_by,
    hasSecret: Boolean(r.secret),
  };
}

function rowToTemplate(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    skills: fromJson(r.skills, []) || [],
    categories: fromJson(r.categories, []) || [],
    builtin: Boolean(r.builtin),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProposal(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    status: r.status,
    files: fromJson(r.files, []) || [],
    note: r.note,
    proposedBy: r.proposed_by,
    channelSlug: r.channel_slug,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    revisionId: r.revision_id ?? null,
  };
}

const SKILL_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM skill_revisions r WHERE r.skill_id = s.id AND r.status = 'staged') AS staged_count
  FROM skills s`;

// ── Skills ──────────────────────────────────────────────────────────────────────────────────

// Find a skill by slug, else by the folder name it was imported from, else by its frontmatter
// name — all case-insensitive, so a grant written as a name still resolves. Tombstoned skills
// are returned too (with `deleted`); callers decide.
export function getSkill(key) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const db = getDb();
  let row = db.prepare(`${SKILL_SELECT} WHERE s.slug = ? COLLATE NOCASE`).get(k);
  if (!row) row = db.prepare(`${SKILL_SELECT} WHERE s.source_path <> '' AND (s.source_path = ? COLLATE NOCASE OR s.source_path LIKE ? COLLATE NOCASE) ORDER BY s.deleted_at = '' DESC LIMIT 1`).get(k, `%/${k.replace(/[%_]/g, "")}`);
  if (!row) row = db.prepare(`${SKILL_SELECT} WHERE s.name = ? COLLATE NOCASE ORDER BY s.deleted_at = '' DESC LIMIT 1`).get(k);
  if (!row) {
    const slug = slugFromName(k);
    if (slug && slug !== k) row = db.prepare(`${SKILL_SELECT} WHERE s.slug = ?`).get(slug);
  }
  return rowToSkill(row);
}

export function getSkillById(id) {
  return rowToSkill(getDb().prepare(`${SKILL_SELECT} WHERE s.id = ?`).get(Number(id)));
}

// `viewer` narrows personal skills: "" (nobody) hides every personal skill, a user id shows that
// user's own, "*" (an admin surface) shows all.
export function listSkills({ includeDeleted = false, ownerKind = "", sourceId = null, category = "", query = "", limit = 0, viewer = "*", visibility = "" } = {}) {
  const where = [];
  const args = [];
  if (!includeDeleted) where.push("s.deleted_at = ''");
  if (visibility) {
    where.push("s.visibility = ?");
    args.push(visibility);
  }
  if (viewer !== "*") {
    where.push("(s.visibility <> 'personal' OR s.created_by = ?)");
    args.push(String(viewer || ""));
  }
  if (ownerKind) {
    where.push("s.owner_kind = ?");
    args.push(ownerKind);
  }
  if (sourceId != null) {
    where.push("s.source_id = ?");
    args.push(Number(sourceId));
  }
  if (category) {
    where.push("s.category = ? COLLATE NOCASE");
    args.push(category);
  }
  if (query) {
    const q = `%${String(query).trim().toLowerCase()}%`;
    where.push("(lower(s.slug) LIKE ? OR lower(s.name) LIKE ? OR lower(s.description) LIKE ? OR lower(s.tags) LIKE ? OR lower(s.category) LIKE ?)");
    args.push(q, q, q, q, q);
  }
  const sql = `${SKILL_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY s.slug${limit > 0 ? ` LIMIT ${Number(limit)}` : ""}`;
  return getDb().prepare(sql).all(...args).map(rowToSkill);
}

export function listCategories() {
  return getDb()
    .prepare("SELECT category, COUNT(*) AS n FROM skills WHERE deleted_at = '' AND category <> '' GROUP BY category COLLATE NOCASE ORDER BY n DESC, category")
    .all()
    .map((r) => ({ category: r.category, count: r.n }));
}

export function getRevision(id) {
  if (id == null) return null;
  return rowToRevision(getDb().prepare("SELECT * FROM skill_revisions WHERE id = ?").get(Number(id)));
}

export function listRevisions(skillId) {
  return getDb().prepare("SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY revision_no DESC").all(Number(skillId)).map(rowToRevision);
}

export function revisionFiles(revisionId) {
  return getDb().prepare("SELECT * FROM skill_revision_files WHERE revision_id = ? ORDER BY path").all(Number(revisionId)).map(rowToFile);
}

export function revisionFile(revisionId, filePath) {
  const row = getDb().prepare("SELECT * FROM skill_revision_files WHERE revision_id = ? AND path = ? COLLATE NOCASE").get(Number(revisionId), String(filePath));
  return row ? rowToFile(row) : null;
}

// The revision a channel receives: the operator's pin when set, else the newest active one.
export function effectiveRevisionFor(skill) {
  if (!skill) return null;
  const id = skill.pinnedRevisionId ?? skill.currentRevisionId;
  return id == null ? null : getRevision(id);
}

function latestRevisionRow(db, skillId) {
  return db.prepare("SELECT * FROM skill_revisions WHERE skill_id = ? AND status <> 'rejected' ORDER BY revision_no DESC LIMIT 1").get(skillId);
}

function activeRevisionRow(db, skillId) {
  return db.prepare("SELECT * FROM skill_revisions WHERE skill_id = ? AND status = 'active' ORDER BY revision_no DESC LIMIT 1").get(skillId);
}

// Rebuild the derived index columns from a revision's SKILL.md and make it the current one.
function activateRow(db, skillId, revisionId, now) {
  const manifest = db.prepare("SELECT content FROM skill_revision_files WHERE revision_id = ? AND path = 'SKILL.md' COLLATE NOCASE").get(revisionId);
  const text = manifest ? Buffer.from(manifest.content).toString("utf8") : "";
  const parsed = parseFrontmatter(text);
  const md = skillMetadata(parsed.data);
  db.prepare("UPDATE skill_revisions SET status = 'active' WHERE id = ?").run(revisionId);
  db.prepare(
    `UPDATE skills SET current_revision_id = ?, name = ?, description = ?, category = ?, tags = ?, requires = ?, version = ?, meta = ?, updated_at = ?, deleted_at = '' WHERE id = ?`,
  ).run(revisionId, md.name, md.description, md.category, toJson(md.tags), toJson(md.requires), md.version, toJson(parsed.data), now, skillId);
  return md;
}

function insertRevision(db, { skillId, files, status, hash, version, sourceRef, note, createdBy, now }) {
  const last = db.prepare("SELECT MAX(revision_no) AS n FROM skill_revisions WHERE skill_id = ?").get(skillId);
  const revisionNo = Number(last?.n || 0) + 1;
  const total = files.reduce((n, f) => n + f.content.length, 0);
  const res = db
    .prepare(
      `INSERT INTO skill_revisions(skill_id, revision_no, status, content_hash, version, source_ref, note, file_count, total_bytes, created_at, created_by)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(skillId, revisionNo, status, hash, version, sourceRef, note, files.length, total, now, createdBy);
  const revisionId = Number(res.lastInsertRowid);
  const ins = db.prepare("INSERT INTO skill_revision_files(revision_id, path, content, size, sha256, content_type, executable) VALUES(?, ?, ?, ?, ?, ?, ?)");
  for (const f of files) {
    const { contentType } = classifyBytes(f.path, f.content);
    ins.run(revisionId, f.path, f.content, f.content.length, sha256(f.content), contentType, f.executable ? 1 : 0);
  }
  return revisionId;
}

// Store a revision of a skill (creating the skill when new). `files` is a bundle in the API
// shape ({ path, content, encoding? }) or Buffers. Unchanged content (same hash as the newest
// non-rejected revision) writes nothing. Returns { changed, created, conflict, skill, revision }.
export function putSkillRevision({
  slug = "",
  files,
  ownerKind = "local",
  sourceId = null,
  sourcePath = "",
  sourceRef = "",
  note = "",
  createdBy = "",
  status = "active",
  visibility = "org",
  now = nowIso(),
} = {}) {
  if (!OWNER_KINDS.includes(ownerKind)) throw new SkillCatalogError(`unknown owner kind "${ownerKind}"`);
  if (!VISIBILITIES.includes(visibility)) throw new SkillCatalogError(`unknown visibility "${visibility}"`);
  if (!["active", "staged"].includes(status)) throw new SkillCatalogError(`a new revision is active or staged, not "${status}"`);
  const normalized = normalizeSkillFiles(files);
  const manifest = normalized.find((f) => isSkillManifestPath(f.path));
  const parsed = parseFrontmatter(manifest.content.toString("utf8"));
  const md = skillMetadata(parsed.data);
  if (!md.name) throw new SkillCatalogError("SKILL.md frontmatter needs a name", { code: "frontmatter" });
  if (!md.description) throw new SkillCatalogError("SKILL.md frontmatter needs a description", { code: "frontmatter" });
  const resolvedSlug = normalizeSlug(slug) || slugFromName(md.name) || slugFromName(path.posix.basename(sourcePath));
  if (!isValidSlug(resolvedSlug)) throw new SkillCatalogError(`cannot derive a valid slug for "${md.name}"`, { code: "slug" });
  const hash = hashSkillFiles(normalized);
  const sid = sourceId == null ? null : Number(sourceId);

  return tx((db) => {
    const existing = db.prepare("SELECT * FROM skills WHERE slug = ? COLLATE NOCASE").get(resolvedSlug);
    if (existing && (existing.owner_kind !== ownerKind || (existing.source_id ?? null) !== sid)) {
      return { changed: false, created: false, conflict: true, skill: rowToSkill(existing), revision: null, reason: `slug "${resolvedSlug}" is owned by ${existing.owner_kind}${existing.source_id ? ` source #${existing.source_id}` : ""}` };
    }
    let skillId = existing?.id;
    let created = false;
    if (!existing) {
      const res = db
        .prepare(
          `INSERT INTO skills(slug, name, description, owner_kind, source_id, source_path, category, tags, requires, version, meta, created_at, updated_at, created_by, visibility)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(resolvedSlug, md.name, md.description, ownerKind, sid, sourcePath, md.category, toJson(md.tags), toJson(md.requires), md.version, toJson(parsed.data), now, now, createdBy, visibility);
      skillId = Number(res.lastInsertRowid);
      created = true;
    } else {
      const latest = latestRevisionRow(db, skillId);
      if (latest && latest.content_hash === hash) {
        // Same bytes as the newest revision: nothing new to store. A staged copy that the source
        // now delivers in auto mode activates; a tombstoned skill that reappears comes back.
        if (latest.status === "staged" && status === "active") {
          activateRow(db, skillId, latest.id, now);
        } else if (existing.deleted_at && status === "active" && latest.status === "active") {
          db.prepare("UPDATE skills SET deleted_at = '', updated_at = ? WHERE id = ?").run(now, skillId);
        }
        if (sourcePath && existing.source_path !== sourcePath) db.prepare("UPDATE skills SET source_path = ? WHERE id = ?").run(sourcePath, skillId);
        return { changed: false, created: false, conflict: false, skill: getSkillById(skillId), revision: getRevision(latest.id) };
      }
    }
    const revisionId = insertRevision(db, { skillId, files: normalized, status, hash, version: md.version, sourceRef, note, createdBy, now });
    if (status === "active") activateRow(db, skillId, revisionId, now);
    else db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(now, skillId);
    if (sourcePath) db.prepare("UPDATE skills SET source_path = ? WHERE id = ?").run(sourcePath, skillId);
    return { changed: true, created, conflict: false, skill: getSkillById(skillId), revision: getRevision(revisionId) };
  });
}

// Make a staged revision the active one (an admin approved a synced change). Older staged
// revisions of the same skill are superseded (rejected) so a stale one cannot be approved later.
export function approveRevision(revisionId, { decidedBy = "", now = nowIso() } = {}) {
  return tx((db) => {
    const rev = db.prepare("SELECT * FROM skill_revisions WHERE id = ?").get(Number(revisionId));
    if (!rev) throw new SkillCatalogError("revision not found", { status: 404 });
    if (rev.status === "rejected") throw new SkillCatalogError("a rejected revision cannot be approved");
    activateRow(db, rev.skill_id, rev.id, now);
    db.prepare("UPDATE skill_revisions SET status = 'rejected', note = CASE WHEN note = '' THEN 'superseded' ELSE note || ' (superseded)' END WHERE skill_id = ? AND status = 'staged' AND revision_no < ?").run(rev.skill_id, rev.revision_no);
    if (decidedBy) db.prepare("UPDATE skill_revisions SET note = CASE WHEN note = '' THEN ? ELSE note END WHERE id = ?").run(`approved by ${decidedBy}`, rev.id);
    return getRevision(rev.id);
  });
}

export function rejectRevision(revisionId, { note = "" } = {}) {
  return tx((db) => {
    const rev = db.prepare("SELECT * FROM skill_revisions WHERE id = ?").get(Number(revisionId));
    if (!rev) throw new SkillCatalogError("revision not found", { status: 404 });
    if (rev.status === "active") throw new SkillCatalogError("the active revision cannot be rejected — pin or roll back instead");
    db.prepare("UPDATE skill_revisions SET status = 'rejected', note = ? WHERE id = ?").run(note || rev.note, rev.id);
    return getRevision(rev.id);
  });
}

export function listStagedRevisions() {
  return getDb()
    .prepare("SELECT r.*, s.slug, s.name AS skill_name, s.owner_kind, s.source_id FROM skill_revisions r JOIN skills s ON s.id = r.skill_id WHERE r.status = 'staged' ORDER BY r.created_at DESC")
    .all()
    .map((r) => ({ ...rowToRevision(r), slug: r.slug, skillName: r.skill_name, ownerKind: r.owner_kind, sourceId: r.source_id ?? null }));
}

// Pin a skill to one of its active revisions (rollback), or clear the pin (follow current).
export function pinSkill(slug, revisionNo, { now = nowIso() } = {}) {
  return tx((db) => {
    const skill = db.prepare("SELECT * FROM skills WHERE slug = ? COLLATE NOCASE").get(String(slug));
    if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
    if (revisionNo == null || revisionNo === "") {
      db.prepare("UPDATE skills SET pinned_revision_id = NULL, updated_at = ? WHERE id = ?").run(now, skill.id);
      return getSkillById(skill.id);
    }
    const rev = db.prepare("SELECT * FROM skill_revisions WHERE skill_id = ? AND revision_no = ?").get(skill.id, Number(revisionNo));
    if (!rev) throw new SkillCatalogError(`revision ${revisionNo} not found`, { status: 404 });
    if (rev.status !== "active") throw new SkillCatalogError(`revision ${revisionNo} is ${rev.status}; only an active revision can be pinned`);
    db.prepare("UPDATE skills SET pinned_revision_id = ?, updated_at = ? WHERE id = ?").run(rev.id, now, skill.id);
    return getSkillById(skill.id);
  });
}

export function tombstoneSkill(slug, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE skills SET deleted_at = ?, updated_at = ? WHERE slug = ? COLLATE NOCASE AND deleted_at = ''").run(now, now, String(slug));
  return res.changes > 0;
}

export function restoreSkill(slug, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE skills SET deleted_at = '', updated_at = ? WHERE slug = ? COLLATE NOCASE AND deleted_at <> ''").run(now, String(slug));
  return res.changes > 0;
}

export function setSkillVisibility(slug, visibility, { now = nowIso() } = {}) {
  if (!VISIBILITIES.includes(visibility)) throw new SkillCatalogError(`unknown visibility "${visibility}"`);
  const res = getDb().prepare("UPDATE skills SET visibility = ?, updated_at = ? WHERE slug = ? COLLATE NOCASE").run(visibility, now, String(slug));
  if (res.changes === 0) throw new SkillCatalogError("skill not found", { status: 404 });
  return getSkill(slug);
}

// A locally authored skill that was published into a repository that is also a git source now
// belongs to that source: the next sync sees its own files (same bytes → unchanged) instead of a
// conflict. The revisions stay; only ownership moves.
export function adoptSkillIntoSource(slug, sourceId, { sourcePath = "", sourceRef = "", now = nowIso() } = {}) {
  const res = getDb()
    .prepare("UPDATE skills SET owner_kind = 'git', source_id = ?, source_path = ?, updated_at = ? WHERE slug = ? COLLATE NOCASE")
    .run(Number(sourceId), sourcePath, now, String(slug));
  if (res.changes === 0) throw new SkillCatalogError("skill not found", { status: 404 });
  if (sourceRef) getDb().prepare("UPDATE skill_revisions SET source_ref = CASE WHEN source_ref = '' OR source_ref = 'manual' THEN ? ELSE source_ref END WHERE skill_id = (SELECT id FROM skills WHERE slug = ? COLLATE NOCASE)").run(sourceRef, String(slug));
  return getSkill(slug);
}

export function markRevisionPublished(revisionId, { ref = "", now = nowIso() } = {}) {
  getDb().prepare("UPDATE skill_revisions SET published_ref = ?, published_at = ? WHERE id = ?").run(String(ref || ""), now, Number(revisionId));
  return getRevision(revisionId);
}

// A source's sync found these slugs; every other live skill of that source is gone upstream and
// becomes a tombstone (never a hard delete: a channel still granting it sees why it is missing).
export function tombstoneMissingSourceSkills(sourceId, presentSlugs, { now = nowIso() } = {}) {
  const present = [...new Set((presentSlugs || []).map(String))];
  const db = getDb();
  const rows = db.prepare("SELECT slug FROM skills WHERE source_id = ? AND deleted_at = ''").all(Number(sourceId));
  const keep = new Set(present.map((s) => s.toLowerCase()));
  let n = 0;
  for (const r of rows) {
    if (keep.has(r.slug.toLowerCase())) continue;
    db.prepare("UPDATE skills SET deleted_at = ?, updated_at = ? WHERE slug = ?").run(now, now, r.slug);
    n++;
  }
  return n;
}

// The bytes of a skill's effective revision as an API/materializer bundle.
export function skillBundle(skill) {
  const revision = effectiveRevisionFor(skill);
  if (!revision) return null;
  return { revision, files: revisionFiles(revision.id) };
}

// ── Sources ─────────────────────────────────────────────────────────────────────────────────

export function listSources() {
  return getDb().prepare("SELECT * FROM skill_sources ORDER BY id").all().map(rowToSource);
}

export function getSource(id) {
  return rowToSource(getDb().prepare("SELECT * FROM skill_sources WHERE id = ?").get(Number(id)));
}

export function findSourceByUrl(url) {
  return rowToSource(getDb().prepare("SELECT * FROM skill_sources WHERE url = ? COLLATE NOCASE").get(String(url)));
}

export function addSource({ kind, label = "", url, ref = "", subpath = "", pinnedRef = "", mode = "review", enabled = true, secret = "", createdBy = "", now = nowIso() } = {}) {
  if (!SOURCE_KINDS.includes(kind)) throw new SkillCatalogError(`unknown source kind "${kind}"`);
  if (!SOURCE_MODES.includes(mode)) throw new SkillCatalogError(`unknown source mode "${mode}"`);
  const u = String(url ?? "").trim();
  if (!u) throw new SkillCatalogError("a source needs a URL or folder path");
  if (findSourceByUrl(u)) throw new SkillCatalogError("this source already exists", { status: 409 });
  const res = getDb()
    .prepare(
      `INSERT INTO skill_sources(kind, label, url, ref, subpath, pinned_ref, mode, enabled, secret, created_at, created_by)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kind, String(label || "").trim(), u, String(ref || "").trim(), String(subpath || "").trim().replace(/^\/+|\/+$/g, ""), String(pinnedRef || "").trim(), mode, enabled ? 1 : 0, String(secret || ""), now, createdBy);
  return getSource(Number(res.lastInsertRowid));
}

export function updateSource(id, patch = {}) {
  const cur = getSource(id);
  if (!cur) throw new SkillCatalogError("source not found", { status: 404 });
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  if (!SOURCE_MODES.includes(next.mode)) throw new SkillCatalogError(`unknown source mode "${next.mode}"`);
  getDb()
    .prepare(
      `UPDATE skill_sources SET label = ?, url = ?, ref = ?, subpath = ?, pinned_ref = ?, mode = ?, enabled = ?, last_sync_at = ?, last_sync_ref = ?, last_sync_error = ?, last_sync_stats = ? WHERE id = ?`,
    )
    .run(
      String(next.label || "").trim(),
      String(next.url || "").trim(),
      String(next.ref || "").trim(),
      String(next.subpath || "").trim().replace(/^\/+|\/+$/g, ""),
      String(next.pinnedRef || "").trim(),
      next.mode,
      next.enabled ? 1 : 0,
      next.lastSyncAt || "",
      next.lastSyncRef || "",
      next.lastSyncError || "",
      toJson(next.lastSyncStats || {}),
      cur.id,
    );
  // The peer credential is write-only: set on a non-empty value, cleared explicitly, never read back.
  if (typeof patch.secret === "string" && patch.secret) getDb().prepare("UPDATE skill_sources SET secret = ? WHERE id = ?").run(patch.secret, cur.id);
  if (patch.clearSecret === true) getDb().prepare("UPDATE skill_sources SET secret = '' WHERE id = ?").run(cur.id);
  return getSource(cur.id);
}

// The one reader of a gateway source's credential (peer-sync.js). Never on an API response.
export function sourceSecret(id) {
  return String(getDb().prepare("SELECT secret FROM skill_sources WHERE id = ?").get(Number(id))?.secret || "");
}

export function recordSourceSync(id, { ok, ref = "", error = "", stats = {}, now = nowIso() } = {}) {
  const cur = getSource(id);
  if (!cur) return null;
  return updateSource(id, {
    lastSyncAt: now,
    lastSyncRef: ok ? ref : cur.lastSyncRef,
    lastSyncError: ok ? "" : String(error || "sync failed"),
    lastSyncStats: { ...stats, ok: Boolean(ok), at: now },
  });
}

// Remove a source. Its skills are tombstoned (they keep their revisions, so a channel that still
// grants one sees a reason rather than a hole, and re-adding the source restores them).
export function removeSource(id, { now = nowIso() } = {}) {
  return tx((db) => {
    const cur = db.prepare("SELECT * FROM skill_sources WHERE id = ?").get(Number(id));
    if (!cur) throw new SkillCatalogError("source not found", { status: 404 });
    const n = db.prepare("UPDATE skills SET deleted_at = ?, updated_at = ? WHERE source_id = ? AND deleted_at = ''").run(now, now, cur.id).changes;
    db.prepare("DELETE FROM skill_sources WHERE id = ?").run(cur.id);
    return { removed: true, tombstoned: n };
  });
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────

export function listTemplates() {
  return getDb().prepare("SELECT * FROM skill_templates ORDER BY builtin DESC, name").all().map(rowToTemplate);
}

export function getTemplate(key) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const db = getDb();
  return rowToTemplate(
    db.prepare("SELECT * FROM skill_templates WHERE slug = ? COLLATE NOCASE").get(k) || db.prepare("SELECT * FROM skill_templates WHERE name = ? COLLATE NOCASE").get(k),
  );
}

export function upsertTemplate({ slug, name, description = "", skills = [], categories = [], builtin = false, now = nowIso() } = {}) {
  const s = normalizeSlug(slug || name);
  if (!isValidSlug(s)) throw new SkillCatalogError("a template needs a valid slug");
  const cleanSkills = [...new Set((Array.isArray(skills) ? skills : []).map((x) => normalizeSlug(x)).filter(isValidSlug))];
  const cleanCategories = [...new Set((Array.isArray(categories) ? categories : []).map((x) => String(x || "").trim()).filter(Boolean))];
  getDb()
    .prepare(
      `INSERT INTO skill_templates(slug, name, description, skills, categories, builtin, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description, skills = excluded.skills, categories = excluded.categories, builtin = excluded.builtin, updated_at = excluded.updated_at`,
    )
    .run(s, String(name || s).trim(), String(description || "").trim(), toJson(cleanSkills), toJson(cleanCategories), builtin ? 1 : 0, now, now);
  return getTemplate(s);
}

export function deleteTemplate(slug) {
  return getDb().prepare("DELETE FROM skill_templates WHERE slug = ? COLLATE NOCASE").run(String(slug)).changes > 0;
}

// The live skill list a template stands for: its explicit slugs plus every live skill whose
// category matches one of the template's categories (case-insensitive). Slugs that name a
// missing or tombstoned skill are reported separately, never silently dropped.
export function resolveTemplateSkills(template) {
  const resolved = new Map();
  const missing = [];
  for (const slug of template?.skills || []) {
    const skill = getSkill(slug);
    if (skill && !skill.deleted) resolved.set(skill.slug, { slug: skill.slug, via: "template" });
    else missing.push(slug);
  }
  if (template?.categories?.length) {
    const wanted = new Set(template.categories.map((c) => c.toLowerCase()));
    for (const skill of listSkills()) {
      if (skill.category && wanted.has(skill.category.toLowerCase()) && !resolved.has(skill.slug)) resolved.set(skill.slug, { slug: skill.slug, via: `category:${skill.category}` });
    }
  }
  return { skills: [...resolved.values()], missing };
}

// ── Usage ───────────────────────────────────────────────────────────────────────────────────

export function recordSkillUsage({ ts = nowIso(), slug, skillId = null, revisionId = null, channelSlug = "", conversationId = "", userId = "", engine = "", sessionId = "", runId = "", origin = "", signal = "exact" } = {}) {
  if (!slug) return;
  getDb()
    .prepare(
      `INSERT INTO skill_usage(ts, slug, skill_id, revision_id, channel_slug, conversation_id, user_id, engine, session_id, run_id, origin, signal)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, String(slug), skillId, revisionId, channelSlug, conversationId, userId, engine, sessionId, runId, origin, signal === "inferred" ? "inferred" : "exact");
}

// Per-skill counts since `since` (ISO), optionally for one channel. Exact and inferred are kept
// apart so the report can be honest about Codex's best-effort signal.
export function usageSummary({ channelSlug = "", since = "", limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (channelSlug) {
    where.push("channel_slug = ?");
    args.push(channelSlug);
  }
  if (since) {
    where.push("ts >= ?");
    args.push(since);
  }
  const sql = `SELECT slug,
      SUM(CASE WHEN signal = 'exact' THEN 1 ELSE 0 END) AS exact,
      SUM(CASE WHEN signal = 'inferred' THEN 1 ELSE 0 END) AS inferred,
      COUNT(*) AS total, MAX(ts) AS last_ts, COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT channel_slug) AS channels,
      SUM(CASE WHEN engine = 'claude' THEN 1 ELSE 0 END) AS claude, SUM(CASE WHEN engine = 'codex' THEN 1 ELSE 0 END) AS codex
    FROM skill_usage${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
    GROUP BY slug ORDER BY total DESC, slug LIMIT ${Number(limit) || 500}`;
  return getDb()
    .prepare(sql)
    .all(...args)
    .map((r) => ({ slug: r.slug, exact: r.exact, inferred: r.inferred, total: r.total, lastTs: r.last_ts, users: r.users, channels: r.channels, byEngine: { claude: r.claude, codex: r.codex } }));
}

export function usageCountsBySlug({ since = "" } = {}) {
  const out = new Map();
  for (const row of usageSummary({ since, limit: 100000 })) out.set(row.slug.toLowerCase(), row);
  return out;
}

// ── Proposals ───────────────────────────────────────────────────────────────────────────────

export function createProposal({ slug, kind = "change", files = [], note = "", proposedBy = "", channelSlug = "", now = nowIso() } = {}) {
  if (!["change", "promote", "feedback"].includes(kind)) throw new SkillCatalogError(`unknown proposal kind "${kind}"`);
  const s = normalizeSlug(slug);
  if (!isValidSlug(s)) throw new SkillCatalogError("a proposal needs a valid skill slug");
  const stored = (Array.isArray(files) ? files : []).map((f) => {
    const decoded = normalizeSkillFiles([f], { requireManifest: false })[0];
    const { binary } = classifyBytes(decoded.path, decoded.content);
    return { path: decoded.path, encoding: binary ? "base64" : "utf8", content: binary ? decoded.content.toString("base64") : decoded.content.toString("utf8"), executable: decoded.executable };
  });
  if (kind === "change" && stored.length === 0) throw new SkillCatalogError("a change proposal needs at least one file");
  const res = getDb()
    .prepare(`INSERT INTO skill_proposals(slug, kind, status, files, note, proposed_by, channel_slug, created_at) VALUES(?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .run(s, kind, toJson(stored), String(note || "").trim().slice(0, 4000), proposedBy, channelSlug, now);
  return getProposal(Number(res.lastInsertRowid));
}

export function getProposal(id) {
  return rowToProposal(getDb().prepare("SELECT * FROM skill_proposals WHERE id = ?").get(Number(id)));
}

export function listProposals({ status = "", slug = "", limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (slug) {
    where.push("slug = ? COLLATE NOCASE");
    args.push(slug);
  }
  return getDb()
    .prepare(`SELECT * FROM skill_proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${Number(limit) || 200}`)
    .all(...args)
    .map(rowToProposal);
}

export function decideProposal(id, { status, decidedBy = "", note = "", revisionId = null, now = nowIso() } = {}) {
  if (!["approved", "rejected"].includes(status)) throw new SkillCatalogError(`a decision is approved or rejected, not "${status}"`);
  const res = getDb()
    .prepare("UPDATE skill_proposals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, revision_id = ? WHERE id = ? AND status = 'pending'")
    .run(status, now, decidedBy, String(note || "").trim().slice(0, 2000), revisionId, Number(id));
  if (res.changes === 0) throw new SkillCatalogError("proposal is not pending", { status: 409 });
  return getProposal(id);
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────

export function catalogStats() {
  const db = getDb();
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0);
  return {
    skills: one("SELECT COUNT(*) AS n FROM skills WHERE deleted_at = ''"),
    tombstoned: one("SELECT COUNT(*) AS n FROM skills WHERE deleted_at <> ''"),
    byOwner: Object.fromEntries(db.prepare("SELECT owner_kind, COUNT(*) AS n FROM skills WHERE deleted_at = '' GROUP BY owner_kind").all().map((r) => [r.owner_kind, r.n])),
    staged: one("SELECT COUNT(*) AS n FROM skill_revisions WHERE status = 'staged'"),
    sources: one("SELECT COUNT(*) AS n FROM skill_sources"),
    sourceErrors: one("SELECT COUNT(*) AS n FROM skill_sources WHERE last_sync_error <> ''"),
    templates: one("SELECT COUNT(*) AS n FROM skill_templates"),
    pendingProposals: one("SELECT COUNT(*) AS n FROM skill_proposals WHERE status = 'pending'"),
    usage30d: one("SELECT COUNT(*) AS n FROM skill_usage WHERE ts >= ?", new Date(Date.now() - 30 * 86400000).toISOString()),
  };
}

export { MAX_FILE_BYTES };
