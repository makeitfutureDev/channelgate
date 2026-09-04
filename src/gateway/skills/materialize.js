// Native materialization: write a catalog skill's files into a `.claude/skills/<slug>/` folder
// (the tree Claude reads through its plugin and Codex through the `.agents/skills` link) as REAL
// files — no stub, no mid-turn fetch. Every folder this writes carries the gateway's managed
// marker plus a small manifest naming the revision it holds, so a later call is write-on-change
// (same revision → nothing touched) and pruning only ever removes what the gateway itself put
// there. A folder without the marker is project-owned and always wins over the catalog.
//
// The tree lives under an agent-writable workspace: directories are (re)created as real
// directories and files are published no-follow (safe-fs.js), so a planted symlink is replaced,
// never followed.
import { readdir, rm, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { ensureRealDir, readNoFollow, writeNoFollow } from "../safe-fs.js";
import { getSkill, skillBundle } from "./catalog.js";
import { isLibraryStub } from "../library-skills.js";

// Shared with folders.js (the same marker the pre-catalog copies used, so an existing channel's
// managed folders are recognized and upgraded in place).
export const MANAGED_SKILL_MARKER = ".gateway-managed-skill";
export const SKILL_MANIFEST_FILE = ".gateway-skill.json";

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readSkillManifest(dir) {
  const raw = await readNoFollow(path.join(dir, SKILL_MANIFEST_FILE));
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

// Is this folder one the gateway materialized (marker present)? Symlinked folders never count.
export async function isManagedSkillDir(dir) {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return false;
  } catch {
    return false;
  }
  return exists(path.join(dir, MANAGED_SKILL_MARKER));
}

// Write one revision's files into skillsDir/<slug>. Returns "written" | "unchanged".
export async function materializeBundle(skillsDir, slug, { revision, files }) {
  const dest = path.join(skillsDir, slug);
  const manifest = await readSkillManifest(dest);
  if (manifest && manifest.revisionId === revision.id && manifest.hash === revision.contentHash && (await exists(path.join(dest, MANAGED_SKILL_MARKER)))) {
    return "unchanged";
  }
  // A different revision (or a stub, or a half-written folder): rebuild from scratch so a file
  // the previous revision had and this one dropped does not linger.
  if (await exists(dest)) await rm(dest, { recursive: true, force: true });
  await ensureRealDir(skillsDir, slug);
  for (const f of files) {
    const segments = f.path.split("/");
    const name = segments.pop();
    const dir = segments.length ? await ensureRealDir(dest, ...segments) : dest;
    const target = path.join(dir, name);
    await writeNoFollow(target, f.content, { mode: f.executable ? 0o755 : 0o644 });
    if (f.executable) await chmod(target, 0o755).catch(() => {});
  }
  await writeNoFollow(path.join(dest, MANAGED_SKILL_MARKER), "gateway-owned\n");
  await writeNoFollow(
    path.join(dest, SKILL_MANIFEST_FILE),
    `${JSON.stringify({ slug, revisionId: revision.id, revisionNo: revision.revisionNo, hash: revision.contentHash, version: revision.version, materializedAt: new Date().toISOString() })}\n`,
  );
  return "written";
}

// Materialize one catalog skill by grant name. Returns one of:
//   { state: "written" | "unchanged", slug }   — the catalog copy is in place
//   { state: "project", slug }                  — a project-owned folder of that name wins
//   { state: "staged" | "removed" | "unknown" } — nothing written (no approved revision / tombstoned / not in catalog)
export async function materializeSkill(skillsDir, name, { lookup = getSkill, bundleFor = skillBundle } = {}) {
  const skill = lookup(name);
  if (!skill) return { state: "unknown", slug: String(name) };
  if (skill.deleted) return { state: "removed", slug: skill.slug };
  const bundle = bundleFor(skill);
  if (!bundle) return { state: "staged", slug: skill.slug };
  const dest = path.join(skillsDir, skill.slug);
  if (await exists(dest)) {
    const managed = await isManagedSkillDir(dest);
    const stub = !managed && (await isLibraryStub(dest));
    if (!managed && !stub) return { state: "project", slug: skill.slug };
  }
  const state = await materializeBundle(skillsDir, skill.slug, bundle);
  return { state, slug: skill.slug, revisionNo: bundle.revision.revisionNo };
}

// Remove managed folders whose slug is not wanted. Never touches an unmarked (project-owned)
// folder, a symlink, or a library stub (those have their own pruner).
export async function pruneManagedSkills(skillsDir, keep) {
  const wanted = new Set([...keep].map((s) => String(s).toLowerCase()));
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || wanted.has(entry.name.toLowerCase())) continue;
    const dir = path.join(skillsDir, entry.name);
    if (await isManagedSkillDir(dir)) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
