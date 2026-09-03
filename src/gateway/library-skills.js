// ── Skills Manager library skills (native stub folders) ──────────────────────
// When a channel/author has a Skills Manager token active, the library's `library_*` MCP tools are
// injected for the run. Rather than list the user's favorite ("starred") skills as prose in
// CLAUDE.md, we materialize each as a NATIVE skill-stub folder under the channel's `.claude/skills/`:
// a `SKILL.md` whose frontmatter (name + description) drives Claude's own skill triggering, and whose
// body routes the agent to load the real instructions on demand via the `makeitfuture-skills` MCP
// (`library_get_skill_file`). Progressive disclosure — only the descriptions are always-on; the full
// body is fetched when the skill fires. Stubs are refreshed each run and pruned when no token is
// active. LOCAL (admin-granted) skills copied into the folder are left untouched — they always win
// over a library stub of the same name.
import { mkdir, access, readdir, symlink, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { slugify } from "../config/paths.js";
import { ensureRealDir, readNoFollow, writeNoFollow } from "./safe-fs.js";
import { skillsUrl } from "./mcp-catalog.js";
import { getAgentsFile } from "../config/settings.js";

const FAV_START = "<!-- SKILLS-MANAGER-FAVORITES:START -->";
const FAV_END = "<!-- SKILLS-MANAGER-FAVORITES:END -->";
// A marker file dropped inside every generated library-stub folder so we can prune stale stubs and
// tell them apart from real (admin-granted, locally-copied) skills — which we must never clobber.
const STUB_MARKER = ".gateway-library-stub";

// Split instruction-file content into the base (everything before the legacy favorites block) and
// the block. Still used by ensureInstructionFiles (folders.js) + the one-time strip migration below.
export function splitFavorites(content) {
  const i = content.indexOf(FAV_START);
  if (i === -1) return { base: content, block: "" };
  const j = content.indexOf(FAV_END, i);
  const end = j === -1 ? content.length : j + FAV_END.length;
  return { base: content.slice(0, i), block: content.slice(i, end) };
}

// Reassemble base + an optional favorites block with tidy spacing.
function withFavorites(base, block) {
  const b = base.replace(/\s+$/, "");
  return block ? `${b}\n\n${block}\n` : `${b}\n`;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Cache fetched favorites briefly (keyed by token) so we don't hit the API on every message.
const favCache = new Map(); // token -> { favs, at }
const FAV_TTL_MS = 10 * 60 * 1000;

// GET <skills base>/api/favorites with the run's bearer token → a list of { name, description }.
// Derives the base by stripping the trailing /mcp from the configured Skills Manager MCP URL.
export async function fetchLibraryFavorites(token) {
  const cached = favCache.get(token);
  if (cached && Date.now() - cached.at < FAV_TTL_MS) return cached.favs;
  const base = skillsUrl().replace(/\/+mcp\/*$/i, "").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/favorites`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`favorites HTTP ${res.status}`);
  const j = await res.json();
  const favs = (Array.isArray(j?.favorites) ? j.favorites : [])
    .map((f) => ({ name: String(f?.name || "").trim(), description: String(f?.description || "").replace(/\s+/g, " ").trim() }))
    .filter((f) => f.name);
  favCache.set(token, { favs, at: Date.now() });
  return favs;
}

// Is this folder one of OUR generated library stubs (vs. a real granted skill)?
export function isLibraryStub(dir) {
  return exists(path.join(dir, STUB_MARKER));
}

// A YAML single-quoted scalar: the ONE quoting style with no escape sequences at all — the only
// special case is an embedded quote, written doubled. Newlines/tabs are folded to spaces first so
// the value can never break out of its line.
function yamlQuoted(value) {
  return `'${String(value ?? "").replace(/\s+/g, " ").trim().replace(/'/g, "''")}'`;
}

// The SKILL.md for a library stub: frontmatter (name + description) for native triggering, plus a
// body that routes the agent to the authoritative version via the Skills Manager MCP.
// The description is remote, user-authored text from the Skills Manager. Left bare it is a plain
// YAML scalar, so a leading `[`/`{`/`&`/`*`, an embedded `: `, a ` #`, or a newline would change
// the parsed shape of the frontmatter — anything from a dropped description to injected sibling
// keys in a file that steers the agent. Quoting it makes the value inert.
export function libraryStubSkillMd(slug, libraryName, description) {
  const name = libraryName.replace(/"/g, '\\"');
  return `---
name: ${slug}
description: ${yamlQuoted(description)}
---

# ${slug}

This skill is part of the Skills Manager library (MCP). Load its full instructions with the
\`makeitfuture-skills\` tool \`library_get_skill_file\` (name: "${name}", file: "SKILL.md") and
follow them — fetch any files it references the same way.
`;
}

// Write (or refresh) a library-stub folder: the marker + the SKILL.md. Idempotent. The stub tree
// lives in the agent-writable workspace, so the folder is recreated as a REAL directory and both
// files are published no-follow (see safe-fs.js) — a planted symlink is replaced, never followed.
async function writeLibraryStub(skillsDir, slug, libraryName, description) {
  const dir = await ensureRealDir(skillsDir, slug);
  await writeNoFollow(path.join(dir, STUB_MARKER), "");
  await writeNoFollow(path.join(dir, "SKILL.md"), libraryStubSkillMd(slug, libraryName, description));
}

// Remove any library-stub folders whose slug is NOT in `keep` (never touches real granted skills).
async function pruneLibraryStubs(skillsDir, keep) {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return; // no skills dir yet
  }
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink())) continue;
    if (keep.has(e.name)) continue;
    const dir = path.join(skillsDir, e.name);
    if (await isLibraryStub(dir)) await rm(dir, { recursive: true, force: true });
  }
}

// One-time migration: strip the legacy Skills-Manager favorites PROSE block from CLAUDE.md (we no
// longer inject it — stubs supersede it). Keeps everything else (incl. the memory block) intact.
async function stripFavoritesBlock(cwd) {
  if (!getAgentsFile()) return;
  const claude = path.join(cwd, "CLAUDE.md");
  // No-follow: a symlink at CLAUDE.md (the agent can plant one, and a custom project folder may
  // legitimately keep this file as a mirror of AGENTS.md) reads as absent, so this legacy strip
  // never rewrites through a link — folders.js owns the real file either way.
  const cur = await readNoFollow(claude);
  if (cur === null) return;
  const { base, block } = splitFavorites(cur);
  if (!block) return;
  await writeNoFollow(claude, withFavorites(base, ""));
}

// Materialize the channel/author's library favorites as native skill-stub folders under
// `.claude/skills/`, and prune stale ones. With no token (or clean mode) it just removes all stubs.
// Best-effort — a fetch failure leaves existing stubs as-is (never wiped over a transient error).
// The legacy CLAUDE.md favorites block is always stripped (superseded by the stubs).
export async function applyLibrarySkills(cwd, token) {
  // cwd is agent-writable: rebuild .claude/skills as REAL directories before writing under it.
  const skillsDir = await ensureRealDir(cwd, ".claude", "skills");
  await stripFavoritesBlock(cwd);
  await applyLibrarySkillsToDir(skillsDir, token);
}

// Materialize favorites into an arbitrary native skills directory. Run-specific grant overlays
// use this form so a personal Skills Manager token never rewrites the channel's shared tree.
export async function applyLibrarySkillsToDir(skillsDir, token) {
  if (!token) {
    await pruneLibraryStubs(skillsDir, new Set());
    return;
  }
  let favs;
  try {
    favs = await fetchLibraryFavorites(token);
  } catch {
    return; // transient fetch failure — leave existing stubs untouched
  }
  await mkdir(skillsDir, { recursive: true });
  const keep = new Set();
  for (const f of favs) {
    const slug = slugify(f.name);
    if (!slug) continue;
    const dest = path.join(skillsDir, slug);
    // A real (admin-granted, locally-copied) skill of the same name always wins — never clobber it.
    if ((await exists(dest)) && !(await isLibraryStub(dest))) continue;
    keep.add(slug);
    await writeLibraryStub(skillsDir, slug, f.name, f.description);
  }
  await pruneLibraryStubs(skillsDir, keep);
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
// relative symlink, so granted skills, library stubs, channel-memory, and gateway-usage stay in
// lockstep without duplicate copies. Never traverse a symlinked `.agents` parent or replace an
// existing `.agents/skills` entry: either may belong to the project using a custom work directory.
export async function ensureCodexSkillsLink(cwd) {
  const claudeSkills = path.join(cwd, ".claude", "skills");
  const agentsDir = path.join(cwd, ".agents");
  const codexSkills = path.join(agentsDir, "skills");

  let parent;
  try {
    parent = await lstat(agentsDir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) return false;
  if ((await pathKind(codexSkills)) !== null) return false;

  await mkdir(agentsDir, { recursive: true });
  try {
    await symlink(path.relative(agentsDir, claudeSkills), codexSkills, "dir");
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false; // another provisioner won the race
    throw err;
  }
}
