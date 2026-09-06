// Legacy Skills Manager stub cleanup + the Codex skill-tree link.
//
// Until 2026-09 the gateway materialized a channel's Skills Manager favorites as native STUB
// folders under `.claude/skills/` (a SKILL.md whose body fetched the real instructions over the
// `makeitfuture-skills` MCP mid-turn). Skills now come from the gateway's own catalog as real files
// (src/gateway/skills/), and Skills Manager is a standalone product with no runtime link to the
// gateway. What remains here: the marker that identifies a leftover stub so the materializer can
// replace it and the workspace provisioner can prune it, the legacy CLAUDE.md favorites-block
// splitter the instruction-file writer still strips, and the `.agents/skills` link for Codex.
import { mkdir, readdir, symlink, readlink, lstat, rm, access } from "node:fs/promises";
import path from "node:path";
import { archiveWorkspaceEntry, openWorkspaceDirectory, directoryPath } from "./skills/workspace-backup.js";

const FAV_START = "<!-- SKILLS-MANAGER-FAVORITES:START -->";
const FAV_END = "<!-- SKILLS-MANAGER-FAVORITES:END -->";
// The marker every generated stub folder carried. Still recognized so an old channel folder is
// cleaned up on its next message instead of shadowing a catalog skill of the same name.
const STUB_MARKER = ".gateway-library-stub";

// Split instruction-file content into the base (everything before the legacy favorites block) and
// the block. Still used by ensureInstructionFiles (folders.js) to strip the block on rewrite.
export function splitFavorites(content) {
  const i = content.indexOf(FAV_START);
  if (i === -1) return { base: content, block: "" };
  const j = content.indexOf(FAV_END, i);
  const end = j === -1 ? content.length : j + FAV_END.length;
  return { base: content.slice(0, i), block: content.slice(i, end) };
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Is this folder one of the OLD generated library stubs (vs. a real skill)?
export function isLibraryStub(dir) {
  return exists(path.join(dir, STUB_MARKER));
}

// Remove every leftover stub folder under a skills dir. Only marker-bearing folders are touched;
// a real skill folder of any origin is never removed here.
export async function pruneLegacyLibraryStubs(skillsDir) {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return 0; // no skills dir yet
  }
  let removed = 0;
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink())) continue;
    const dir = path.join(skillsDir, e.name);
    if (await isLibraryStub(dir)) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// Detect any existing entry (file or symlink) at a path.
async function pathKind(p) {
  try {
    return (await lstat(p)).isSymbolicLink() ? "link" : "file";
  } catch {
    return null;
  }
}

// Codex discovers repo-scoped skills under `.agents/skills`, while Claude discovers them under
// `.claude/skills`. Keep `.claude/skills` canonical and expose that exact tree to Codex through a
// relative symlink, so granted skills, channel-memory, and gateway-usage stay in lockstep without
// duplicate copies. Authoritative workspace callers archive conflicting entries, including
// symlink nodes without following their targets. Other callers preserve existing project entries.
export async function ensureCodexSkillsLink(cwd, { authoritative = false, backupDir = "" } = {}) {
  const claudeSkills = path.join(cwd, ".claude", "skills");
  const agentsDir = path.join(cwd, ".agents");
  const codexSkills = path.join(agentsDir, "skills");

  let parent;
  try {
    parent = await lstat(agentsDir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) {
    if (!authoritative) return false;
    await archiveWorkspaceEntry(agentsDir, backupDir);
  }
  if ((await pathKind(codexSkills)) !== null) {
    if (!authoritative) return false;
    const info = await lstat(codexSkills);
    if (info.isSymbolicLink() && (await readlink(codexSkills)) === "../.claude/skills") return false;
    await archiveWorkspaceEntry(codexSkills, backupDir);
  }

  await mkdir(agentsDir, { recursive: true });
  const handle = await openWorkspaceDirectory(agentsDir);
  try {
    await symlink(path.relative(agentsDir, claudeSkills), path.join(directoryPath(handle), "skills"), "dir");
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false; // another provisioner won the race
    throw err;
  } finally { await handle.close(); }
}
