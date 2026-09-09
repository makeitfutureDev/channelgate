// Import skills from directories on the daemon host into the catalog: the bundled starter
// library shipped in this checkout, and the operator's own skill folders (`~/.claude/skills`,
// `~/.agents/skills`, or GATEWAY_SKILL_SOURCES) — the places grants were copied from before the
// catalog existed. A folder-owned skill keeps its directory name as its slug, so every stored
// grant still resolves, and it is re-imported by content hash on each boot: the directory stays
// authoritative for that skill, the catalog mirrors it. A directory that disappears tombstones
// its skill; one that comes back restores it.
import { buildPluginSkill, PLUGIN_MANIFESTS } from "./plugin-package.js";
import { readdir, readFile, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { putSkillRevision, listSkills, tombstoneSkill, restoreSkill, isValidSlug } from "./catalog.js";
import { isSkillManifestPath, MAX_FILES } from "./files.js";

export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("./bundled/", import.meta.url));

const SKIP_NAMES = new Set([".git", ".DS_Store", "node_modules", "__pycache__"]);

async function isDirLike(p, { dereference }) {
  try {
    const info = dereference ? await stat(p) : await lstat(p);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function hasPluginManifest(dir) {
  for (const manifest of Object.values(PLUGIN_MANIFESTS)) {
    try { const info = await lstat(path.join(dir, manifest)); if (info.isFile() || info.isSymbolicLink()) return true; } catch { /* absent */ }
  }
  return false;
}

async function hasManifest(dir) {
  try {
    const entries = await readdir(dir);
    return entries.some((e) => isSkillManifestPath(e));
  } catch {
    return false;
  }
}

// Read every file below `dir` as a bundle ({ path, content: Buffer, executable }). Nested skill
// folders (a subdirectory with its own SKILL.md) belong to that skill and are skipped, as are
// gateway marker files and VCS/system noise. Symlinks are followed when `dereference` is set —
// the operator's own folders are often links into a store of available skills.
export async function readSkillDirectory(dir, { dereference = true, plugin = false } = {}) {
  const files = [];
  const walk = async (current, rel) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith(".gateway-")) continue;
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let info;
      try {
        info = dereference && !plugin ? await stat(abs) : await lstat(abs);
      } catch {
        continue; // dangling link or vanished entry
      }
      if (plugin && info.isSymbolicLink()) throw new Error(`plugin packages cannot contain symlinks: ${relPath}`);
      if (info.isDirectory()) {
        // A nested skill is its own skill; never fold it into this one.
        if (!plugin && (await hasManifest(abs) || await hasPluginManifest(abs))) continue;
        await walk(abs, relPath);
        continue;
      }
      if (!info.isFile()) continue;
      if (files.length >= MAX_FILES) throw new Error(`skill folder has more than ${MAX_FILES} files`);
      files.push({ path: relPath, content: await readFile(abs), executable: (info.mode & 0o111) !== 0 });
    }
  };
  await walk(dir, "");
  return files;
}

// Import one skill directory as a revision. Returns the catalog result plus the slug used.
export async function importSkillDirectory(dir, { slug = "", ownerKind = "folder", sourceId = null, sourcePath = dir, sourceRef = "", status = "active", createdBy = "", dereference = true } = {}) {
  const plugin = await hasPluginManifest(dir);
  if (plugin && (await lstat(dir)).isSymbolicLink()) throw new Error("plugin source cannot be a symlink");
  const raw = await readSkillDirectory(dir, { dereference, plugin });
  const files = plugin ? buildPluginSkill(raw) : raw;
  return putSkillRevision({ slug, files, ownerKind, sourceId, sourcePath, sourceRef, status, createdBy });
}

// Import every immediate child of `root` that holds a SKILL.md. The child's name is the slug.
export async function importSkillTree(root, { ownerKind = "folder", sourceId = null, sourceRef = "", status = "active", createdBy = "", dereference = true, requireRoot = false } = {}) {
  const result = { root, imported: [], unchanged: [], conflicts: [], errors: [], presentSlugs: [] };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    // Optional host discovery may have no directory yet. An explicitly configured source
    // must report a failed read, so its last good catalog revision is not mistaken for a
    // successful empty sync. Use the actual read failure rather than a racy existence probe.
    if (requireRoot) result.errors.push({ slug: "(source root)", error: `Cannot read skill source directory: ${err?.message || String(err)}` });
    return result;
  }
  const rootPlugin = await hasPluginManifest(root);
  if (rootPlugin) entries = [{ name: path.basename(root), pluginRoot: true }];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    const dir = entry.pluginRoot ? root : path.join(root, entry.name);
    if (!(await isDirLike(dir, { dereference }))) continue;
    const plugin = await hasPluginManifest(dir);
    if (!(await hasManifest(dir)) && !plugin) continue;
    if (!plugin && !isValidSlug(entry.name)) {
      result.errors.push({ slug: entry.name, error: "folder name is not a valid skill slug" });
      continue;
    }
    try {
      const r = await importSkillDirectory(dir, { slug: plugin ? "" : entry.name, ownerKind, sourceId, sourcePath: dir, sourceRef, status, createdBy, dereference });
      if (r.conflict) result.conflicts.push({ slug: entry.name, reason: r.reason });
      else {
        result.presentSlugs.push(r.skill.slug);
        (r.changed ? result.imported : result.unchanged).push({ slug: r.skill.slug, created: r.created, revisionNo: r.revision?.revisionNo });
      }
    } catch (err) {
      result.errors.push({ slug: entry.name, error: err?.message || String(err) });
    }
  }
  return result;
}

// The operator's host skill folders (the pre-catalog grant sources). Folder-owned skills whose
// directory is gone from every source dir are tombstoned; a returning one is restored by the
// import itself. An operator's exclusion is never undone here.
export async function importHostSkillFolders(dirs = []) {
  const results = [];
  const present = new Set();
  // Tombstoned folder skills before the import: the ones that come back count as restored
  // whether the catalog restored them on re-import (same bytes) or this pass does.
  const wasDeleted = new Set(listSkills({ includeDeleted: true, ownerKind: "folder" }).filter((s) => s.deleted && !s.excluded && s.sourceId == null).map((s) => s.slug.toLowerCase()));
  for (const dir of dirs) {
    const r = await importSkillTree(dir, { ownerKind: "folder", sourceRef: dir });
    results.push(r);
    for (const s of r.presentSlugs) present.add(s.toLowerCase());
  }
  let tombstoned = 0;
  let restored = 0;
  for (const skill of listSkills({ includeDeleted: true, ownerKind: "folder" })) {
    if (skill.sourceId != null) continue;
    const key = skill.slug.toLowerCase();
    const here = present.has(key);
    if (!here && !skill.deleted && !results.some((r) => r.errors.length)) {
      tombstoneSkill(skill.slug);
      tombstoned++;
    } else if (here && skill.deleted && !skill.excluded) {
      restoreSkill(skill.slug);
      restored++;
    } else if (here && wasDeleted.has(key)) {
      restored++; // the re-import itself brought it back
    }
  }
  return { results, tombstoned, restored };
}

// The starter library shipped with the gateway (src/gateway/skills/bundled/).
export async function importBundledSkills({ version = "" } = {}) {
  return importSkillTree(BUNDLED_SKILLS_DIR, { ownerKind: "bundled", sourceRef: version ? `channelgate@${version}` : "channelgate", dereference: false });
}
