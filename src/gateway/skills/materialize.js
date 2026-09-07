// Native materialization: write a catalog skill's files into a `.claude/skills/<slug>/` folder
// (the tree Claude reads through its plugin and Codex through the `.agents/skills` link) as REAL
// files — no stub, no mid-turn fetch. Every folder this writes carries the gateway's managed
// marker plus a small manifest naming the revision it holds. Write-on-change verifies the actual
// files as well as the manifest. Ordinary callers preserve project-owned folders; authoritative
// workspace callers archive them and make the selected catalog skills authoritative.
//
// The tree lives under an agent-writable workspace: directories are (re)created as real
// directories and files are published no-follow (safe-fs.js), so a planted symlink is replaced,
// never followed.
import { readdir, rm, lstat, open, mkdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getSkill, skillBundle } from "./catalog.js";
import { normalizeSkillFiles, SkillFileError } from "./files.js";
import { archiveWorkspaceEntry, directoryPath, openWorkspaceDirectory, openChildDirectory } from "./workspace-backup.js";

// Shared with folders.js (the same marker the pre-catalog copies used, so an existing channel's
// managed folders are recognized and upgraded in place).
export const MANAGED_SKILL_MARKER = ".gateway-managed-skill";
export const SKILL_MANIFEST_FILE = ".gateway-skill.json";

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

const absentCodes = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function validateSlug(slug) {
  if (typeof slug !== "string" || !slug || slug === "." || slug === ".." || /[/\\\u0000-\u001f\u007f]/.test(slug) || Buffer.byteLength(slug) > 255) {
    throw new SkillFileError("a materialized skill needs one safe directory name");
  }
  return slug;
}

// A catalog row is normally prevalidated, but validate again before an authoritative replacement
// can displace local files. File/directory collisions cannot be published as a tree.
function validateBundle({ revision, files } = {}) {
  if (!revision || revision.id == null || typeof revision.contentHash !== "string") throw new SkillFileError("invalid skill revision");
  const normalized = normalizeSkillFiles(files);
  const names = new Set(normalized.map((file) => file.path.toLowerCase()));
  for (const file of normalized) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join("/").toLowerCase())) throw new SkillFileError("file path collides with a directory", { path: file.path });
      parts.pop();
    }
  }
  return { revision, files: normalized };
}

async function readRegularFile(file, maxBytes, expectedMode = null) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || (expectedMode !== null && (info.mode & 0o7777) !== expectedMode)) return null;
    // Bound the read even when an agent appends after fstat. No FIFO/device can block this path.
    const content = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset <= maxBytes ? content.subarray(0, offset) : null;
  } catch (error) {
    if (absentCodes.has(error?.code)) return null;
    throw error;
  } finally { await handle?.close(); }
}

async function manifestAt(dir) {
  const raw = await readRegularFile(path.join(dir, SKILL_MANIFEST_FILE), 64 * 1024, 0o644);
  if (raw === null) return null;
  try {
    const manifest = JSON.parse(raw.toString("utf8"));
    return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
  } catch { return null; }
}

export async function readSkillManifest(dir) {
  let handle;
  try {
    handle = await openWorkspaceDirectory(dir);
    return await manifestAt(directoryPath(handle));
  } catch (error) {
    if (absentCodes.has(error?.code)) return null;
    throw error;
  } finally { await handle?.close(); }
}

// Is this folder one the gateway materialized (marker present)? Symlinked folders never count.
export async function isManagedSkillDir(dir) {
  let handle;
  try {
    handle = await openWorkspaceDirectory(dir);
    return await readRegularFile(path.join(directoryPath(handle), MANAGED_SKILL_MARKER), 128) !== null;
  } catch (error) {
    if (absentCodes.has(error?.code)) return false;
    throw error;
  } finally { await handle?.close(); }
}

async function managedChild(parent, name) {
  let child;
  try {
    child = await openChildDirectory(parent, name);
    return await readRegularFile(path.join(directoryPath(child), MANAGED_SKILL_MARKER), 128) !== null;
  } catch (error) {
    if (absentCodes.has(error?.code)) return false;
    throw error;
  } finally { await child?.close(); }
}

async function treeMatches(handle, expected, prefix = "") {
  const dir = directoryPath(handle);
  const entries = await readdir(dir, { withFileTypes: true });
  const children = new Set([...expected.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length).split("/")[0]));
  if (entries.length !== children.size) return false;
  for (const entry of entries) {
    if (!children.has(entry.name)) return false;
    const relative = `${prefix}${entry.name}`;
    const file = expected.get(relative);
    if (file) {
      if (!entry.isFile()) return false;
      const actual = await readRegularFile(path.join(dir, entry.name), file.content.length, file.mode);
      if (!actual?.equals(file.content)) return false;
    } else {
      if (!entry.isDirectory()) return false;
      let child;
      try {
        child = await openChildDirectory(handle, entry.name);
        if (((await child.stat()).mode & 0o7777) !== 0o755 || !(await treeMatches(child, expected, `${relative}/`))) return false;
      } catch (error) {
        if (absentCodes.has(error?.code)) return false;
        throw error;
      } finally { await child?.close(); }
    }
  }
  return true;
}

async function bundleMatches(parent, slug, { revision, files }) {
  let handle;
  try {
    handle = await openChildDirectory(parent, slug);
    if (((await handle.stat()).mode & 0o7777) !== 0o755) return false;
    const dir = directoryPath(handle);
    const manifest = await manifestAt(dir);
    if (!manifest || manifest.slug !== slug || manifest.revisionId !== revision.id || manifest.hash !== revision.contentHash || manifest.revisionNo !== revision.revisionNo || manifest.version !== revision.version) return false;
    const manifestBytes = await readRegularFile(path.join(dir, SKILL_MANIFEST_FILE), 64 * 1024, 0o644);
    if (!manifestBytes) return false;
    const expected = new Map(files.map((file) => [file.path, { content: file.content, mode: file.executable ? 0o755 : 0o644 }]));
    expected.set(MANAGED_SKILL_MARKER, { content: Buffer.from("gateway-owned\n"), mode: 0o644 });
    expected.set(SKILL_MANIFEST_FILE, { content: manifestBytes, mode: 0o644 });
    return await treeMatches(handle, expected);
  } catch (error) {
    if (absentCodes.has(error?.code)) return false;
    throw error;
  } finally { await handle?.close(); }
}

async function writeBundleFile(root, file) {
  const parts = file.path.split("/");
  const name = parts.pop();
  let dir = root;
  try {
    for (const part of parts) {
      const child = await openChildDirectory(dir, part, { create: true });
      await child.chmod(0o755);
      if (dir !== root) await dir.close();
      dir = child;
    }
    const handle = await open(path.join(directoryPath(dir), name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.executable ? 0o755 : 0o644);
    try {
      await handle.writeFile(file.content);
      await handle.chmod(file.executable ? 0o755 : 0o644);
    } finally { await handle.close(); }
  } finally { if (dir !== root) await dir.close(); }
}

// Stage the complete validated tree before replacing the prior node. All traversal is relative
// to pinned directory descriptors, including comparisons of agent-writable files.
export async function materializeBundle(skillsDir, slug, input, { recordMaterializationTime = true } = {}) {
  validateSlug(slug);
  const bundle = validateBundle(input);
  const parent = await openWorkspaceDirectory(skillsDir);
  const stagingName = `.gateway-skill-stage-${randomUUID()}`;
  const staging = path.join(directoryPath(parent), stagingName);
  let stage;
  try {
    if (await bundleMatches(parent, slug, bundle)) return "unchanged";
    await mkdir(staging, { mode: 0o700 });
    stage = await openChildDirectory(parent, stagingName);
    for (const file of bundle.files) await writeBundleFile(stage, file);
    await writeBundleFile(stage, { path: MANAGED_SKILL_MARKER, content: "gateway-owned\n" });
    const revision = bundle.revision;
    await writeBundleFile(stage, {
      path: SKILL_MANIFEST_FILE,
      content: `${JSON.stringify({ slug, revisionId: revision.id, revisionNo: revision.revisionNo, hash: revision.contentHash, version: revision.version, ...(recordMaterializationTime ? { materializedAt: new Date().toISOString() } : {}) })}\n`,
    });
    await stage.chmod(0o755);
    const destination = path.join(directoryPath(parent), slug);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return "written";
  } finally {
    await stage?.close();
    await rm(staging, { recursive: true, force: true });
    await parent.close();
  }
}

// Materialize one catalog skill by grant name. Returns one of:
//   { state: "written" | "unchanged", slug }   — the catalog copy is in place
//   { state: "project", slug }                  — a project-owned folder of that name wins
//   { state: "staged" | "removed" | "unknown" } — nothing written (no approved revision / tombstoned / not in catalog)
export async function materializeSkill(skillsDir, name, { lookup = getSkill, bundleFor = skillBundle, authoritative = false, backupDir = "", recordMaterializationTime = true } = {}) {
  const skill = lookup(name);
  if (!skill) return { state: "unknown", slug: String(name) };
  if (skill.deleted) return { state: "removed", slug: skill.slug };
  const input = bundleFor(skill);
  if (!input) return { state: "staged", slug: skill.slug };
  validateSlug(skill.slug);
  const bundle = validateBundle(input);
  const dest = path.join(skillsDir, skill.slug);
  if (await exists(dest)) {
    const managed = await isManagedSkillDir(dest);
    let stub = false;
    let handle;
    try {
      handle = await openWorkspaceDirectory(dest);
      stub = !managed && await exists(path.join(directoryPath(handle), ".gateway-library-stub"));
    } catch (error) {
      if (!absentCodes.has(error?.code)) throw error;
    } finally { await handle?.close(); }
    if (!managed && !stub) {
      if (!authoritative) return { state: "project", slug: skill.slug };
      await archiveWorkspaceEntry(dest, backupDir);
    }
  }
  const state = await materializeBundle(skillsDir, skill.slug, bundle, { recordMaterializationTime });
  return { state, slug: skill.slug, revisionNo: bundle.revision.revisionNo };
}

// Remove managed folders whose slug is not wanted. Never touches an unmarked (project-owned)
// folder, a symlink, or a library stub (those have their own pruner).
export async function pruneManagedSkills(skillsDir, keep, { authoritative = false, backupDir = "" } = {}) {
  const wanted = new Set([...keep].map((s) => String(s).toLowerCase()));
  let parent;
  try {
    parent = await openWorkspaceDirectory(skillsDir);
    const entries = await readdir(directoryPath(parent), { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if ((!authoritative && !entry.isDirectory()) || wanted.has(entry.name.toLowerCase())) continue;
      if (await managedChild(parent, entry.name)) {
        await rm(path.join(directoryPath(parent), entry.name), { recursive: true, force: true });
        removed++;
      } else if (authoritative) {
        await archiveWorkspaceEntry(path.join(skillsDir, entry.name), backupDir);
        removed++;
      }
    }
    return removed;
  } catch (error) {
    if (absentCodes.has(error?.code) && !parent) return 0;
    throw error;
  } finally { await parent?.close(); }
}
