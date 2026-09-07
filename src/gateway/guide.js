// The "gateway-usage" skill: the operating manual the agent reads to work inside Slack (how to
// write replies, tag people, set reminders, make tables/canvases, run background jobs, etc.). It
// is a GATEWAY-MANAGED skill — like `channel-memory`, we materialize it into every channel folder
// per run so it's always present and always current, no symlinks (confinement denies reading
// anything outside the folder, so the bytes must live inside it).
//
// Source model — a per-file OVERLAY:
//   • the built-in DEFAULT ships in the repo at src/gateway/gateway-usage/ (in git — the
//     restorable baseline). Never written to at runtime.
//   • admin OVERRIDES live at ~/.channelgate/config/gateway-usage/ (runtime, gitignored).
//   The ACTIVE guide is default ∪ override with the override winning per file. So an admin can
//   rewrite any file live (full "B" customization) and restore the default at any time — while a
//   gateway update that adds/changes default files still shows through for files nobody overrode.
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { readNoFollow, writeNoFollow, ensureRealDir } from "./safe-fs.js";
import { DEFAULT_PLATFORM, platformOr, isPlatformId } from "../platforms/registry.js";

const SKILL = "gateway-usage";
const MARKER = ".gateway-usage-skill"; // ours to refresh/prune (≠ granted skills / library stubs)

const here = path.dirname(fileURLToPath(import.meta.url));
export function defaultGuideDir() {
  return path.join(here, "gateway-usage");
}
export function overrideGuideDir() {
  return path.join(gatewayRoot(), "config", "gateway-usage");
}

// A guide file path is valid iff it's SKILL.md, references/<slug>.md, scripts/<slug>.py, or
// platforms/<platformId>/<slug>.md — no traversal. The platform segment is checked
// against the registry, so an admin cannot create a directory for a platform that does not exist
// (it would silently never be read, which reads as "my edit was ignored").
const FILE_RE = /^(SKILL\.md|references\/[A-Za-z0-9._-]+\.md|scripts\/[A-Za-z0-9._-]+\.py|platforms\/([a-z0-9]+)\/[A-Za-z0-9._-]+\.md)$/;
export function validGuideFile(file) {
  const f = String(file || "").trim().replace(/^\.\//, "");
  const m = FILE_RE.exec(f);
  if (!m || f.includes("..")) return "";
  if (m[2] && !isPlatformId(m[2])) return "";
  return f;
}

// Where a platform file lands once materialized: platforms/<id>/x.md overlays references/x.md,
// and platforms/<id>/SKILL.md overlays SKILL.md.
export function guideTargetPath(rel) {
  const m = /^platforms\/[a-z0-9]+\/(.+)$/.exec(rel);
  if (!m) return rel;
  return m[1] === "SKILL.md" ? "SKILL.md" : `references/${m[1]}`;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Relative source paths under a guide dir: SKILL.md at the root, references/*.md,
// scripts/*.py, and platforms/<id>/*.md. Missing dir → [].
async function listGuideFiles(dir) {
  const out = [];
  if (await exists(path.join(dir, "SKILL.md"))) out.push("SKILL.md");
  try {
    for (const e of await readdir(path.join(dir, "references"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(`references/${e.name}`);
    }
  } catch {
    /* no references dir */
  }
  try {
    for (const e of await readdir(path.join(dir, "scripts"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".py")) out.push(`scripts/${e.name}`);
    }
  } catch {
    /* no scripts dir */
  }
  try {
    for (const platform of await readdir(path.join(dir, "platforms"), { withFileTypes: true })) {
      if (!platform.isDirectory() || !isPlatformId(platform.name)) continue;
      for (const e of await readdir(path.join(dir, "platforms", platform.name), { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".md")) out.push(`platforms/${platform.name}/${e.name}`);
      }
    }
  } catch {
    /* no platforms dir */
  }
  return out;
}

// The active SOURCE set: relPath → { src, overridden }. Override wins per file; union of both dirs.
// These are the files an admin can read and rewrite, including every platforms/<id>/ file — the
// platform resolution below happens afterwards, per channel.
async function activeFiles() {
  const def = defaultGuideDir();
  const ovr = overrideGuideDir();
  const overrideRels = new Set(await listGuideFiles(ovr));
  const rels = new Set([...(await listGuideFiles(def)), ...overrideRels]);
  const map = new Map();
  for (const rel of rels) {
    const overridden = overrideRels.has(rel);
    map.set(rel, { src: path.join(overridden ? ovr : def, rel), overridden });
  }
  return map;
}

// Resolve the source set down to what ONE platform's channel folder should contain:
//   • platforms/<platform>/x.md replaces references/x.md (or SKILL.md), keeping the shared path
//   • platforms/<other>/… is dropped entirely — a Teams channel never sees Slack's reply mechanics
//   • the adapter's guideDrop removes shared files describing capabilities this surface lacks,
//     UNLESS the platform supplies its own version of that file
// Returns targetRel → { src, overridden }.
export async function resolvedGuideFiles(platform = DEFAULT_PLATFORM) {
  const adapter = platformOr(platform);
  const sources = await activeFiles();
  const out = new Map();
  const platformOwned = new Set();

  for (const [rel, entry] of sources) {
    if (!rel.startsWith("platforms/")) continue;
    const [, owner] = rel.split("/");
    if (owner !== adapter.id) continue;
    const target = guideTargetPath(rel);
    platformOwned.add(target);
    out.set(target, entry);
  }
  for (const [rel, entry] of sources) {
    if (rel.startsWith("platforms/")) continue;
    if (platformOwned.has(rel)) continue; // the platform supplies its own version
    if (adapter.guideDrop.includes(rel)) continue;
    out.set(rel, entry);
  }
  return out;
}

// Placeholders every guide source may use, so a shared file can name the surface it is running on
// without being forked per platform.
function containerAccessNote(target) {
  if (!Array.isArray(target?.container?.mounts)) {
    return "**Container access:** no resolved runtime target was supplied when this guide was generated. Do not infer host access from the author's role; check the current runtime before claiming a path is mounted or absent.";
  }
  const homes = target.container.mounts.filter((m) => m.kind === "operator-home").map((m) => m.target);
  const setting = target.settings?.fullAccessHome === true ? "on" : "off";
  const access = homes.length
    ? `This channel's resolved runtime includes the operator-home mount at ${homes.map((home) => JSON.stringify(home)).join(", ")}. Every admitted author can read that mounted home; write-capable bypass tools still require an admin author in Admin mode.`
    : "This channel's resolved runtime has no operator-home mount. The working folder, clean workspace and artifacts remain its host directory mounts; the author's admin role alone adds no mount.";
  return `**Container access for this run:** gateway setting \`containerFullAccessHome\` is **${setting}**. ${access} \`$HOME\` and \`~\` still refer to the channel's own home volume, not the operator's home. See \`references/administration.md\` for the boundary and the optional grant.`;
}

function substitutePlatform(content, adapter, target) {
  return String(content)
    .replaceAll("{{PLATFORM}}", adapter.label)
    .replaceAll("{{PLATFORM_ID}}", adapter.id)
    .replaceAll("{{CONTAINER_ACCESS}}", containerAccessNote(target));
}

// Is any file currently overridden by an admin?
export async function guideIsOverridden() {
  return (await listGuideFiles(overrideGuideDir())).length > 0;
}

// All existing managed-content files under a materialized skill folder, as relative paths.
async function listSkillFolderFiles(skillDir) {
  const out = [];
  try {
    for (const e of await readdir(skillDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(e.name);
    }
  } catch {
    return out;
  }
  try {
    for (const e of await readdir(path.join(skillDir, "references"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(`references/${e.name}`);
    }
  } catch {
    /* none */
  }
  try {
    for (const e of await readdir(path.join(skillDir, "scripts"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".py")) out.push(`scripts/${e.name}`);
    }
  } catch {
    /* none */
  }
  return out;
}

// No-follow on both sides — the skill folder sits in the agent-writable workspace, so a planted
// symlink reads as "missing" and is replaced as a node (exclusive temp + rename), never written
// through. Callers pre-create the (verified-real) parent directory.
async function writeIfChanged(file, content) {
  if ((await readNoFollow(file)) === content) return;
  await writeNoFollow(file, content);
}

// Materialize (refresh) the gateway-usage skill into a channel folder's .claude/skills, resolved
// for the channel's PLATFORM. Syncs the active file set write-on-change and prunes stale files, so
// an admin edit/reset — or a channel moving between surfaces — propagates on the next message. Marker-guarded: if a real (granted) skill of the same name is already there
// (no marker), leave it untouched. Best-effort — a source read failure skips that file, never wipes.
export async function applyGatewayGuide(cwd, { platform = DEFAULT_PLATFORM, target } = {}) {
  const adapter = platformOr(platform);
  const skillDir = path.join(cwd, ".claude", "skills", SKILL);
  // Respect a foreign skill of the same name: exists, has a SKILL.md, but isn't ours.
  if ((await exists(path.join(skillDir, "SKILL.md"))) && !(await exists(path.join(skillDir, MARKER)))) return;

  const files = await resolvedGuideFiles(adapter.id);
  // Recreate the managed path as REAL directories (a swapped-in symlink would redirect every
  // write below), then sync file-by-file with no-follow writes.
  await ensureRealDir(cwd, ".claude", "skills", SKILL);
  await writeIfChanged(path.join(skillDir, MARKER), "");

  const keep = new Set();
  for (const [rel, { src }] of files) {
    let content;
    try {
      content = substitutePlatform(await readFile(src, "utf8"), adapter, target);
    } catch {
      continue; // unreadable source — skip (don't prune the existing copy either)
    }
    keep.add(rel);
    // ensureRealDir takes ONE segment per argument — it mkdirs each without `recursive`. Passing
    // "references/deep" as a single segment made mkdir throw ENOENT on the missing parent, and the
    // rejection propagated out of applyGatewayGuide into every message. Split the relative path.
    if (rel.includes("/")) await ensureRealDir(skillDir, ...path.dirname(rel).split("/"));
    await writeIfChanged(path.join(skillDir, rel), content);
  }
  // Prune files we no longer ship (but never a source we merely failed to read this run).
  for (const rel of await listSkillFolderFiles(skillDir)) {
    if (!keep.has(rel)) await rm(path.join(skillDir, rel), { force: true });
  }
}

// ── Admin operations behind the gateway MCP tools ─────────────────────────────

// Overwrite one guide file's content in the override overlay. Propagates on the next message.
export async function updateGatewayGuide({ file, content }) {
  const f = validGuideFile(file);
  if (!f) throw new Error(`Invalid guide file "${file}" — use "SKILL.md", "references/<name>.md", "scripts/<name>.py", or "platforms/<platform>/<name>.md".`);
  const body = String(content ?? "");
  if (!body.trim()) throw new Error("Refusing to write empty content — pass the new file body.");
  const dest = path.join(overrideGuideDir(), f);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body.endsWith("\n") ? body : body + "\n");
  return { file: f, path: dest };
}

// Restore the built-in default: one file (drop its override → falls back to default), or all of it
// (remove the whole override overlay). Returns what was reset.
export async function resetGatewayGuide({ file } = {}) {
  const ovr = overrideGuideDir();
  if (file) {
    const f = validGuideFile(file);
    if (!f) throw new Error(`Invalid guide file "${file}" — use "SKILL.md", "references/<name>.md", "scripts/<name>.py", or "platforms/<platform>/<name>.md".`);
    await rm(path.join(ovr, f), { force: true });
    // If that emptied the overlay, remove the (now-stale) override dir entirely.
    if (!(await guideIsOverridden())) await rm(ovr, { recursive: true, force: true });
    return { file: f };
  }
  await rm(ovr, { recursive: true, force: true });
  return { file: "" };
}

// Read the active guide for inspection: with `file`, that file's content + whether it's overridden;
// without, the file list flagged default/override + whether any override is active.
export async function readGatewayGuide({ file } = {}) {
  const files = await activeFiles();
  if (file) {
    const f = validGuideFile(file);
    if (!f) throw new Error(`Invalid guide file "${file}" — use "SKILL.md", "references/<name>.md", or "platforms/<platform>/<name>.md".`);
    const entry = files.get(f);
    if (!entry) throw new Error(`No such guide file "${f}".`);
    const content = await readFile(entry.src, "utf8");
    return { file: f, overridden: entry.overridden, content };
  }
  const list = [...files.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([rel, { overridden }]) => ({ file: rel, overridden }));
  return { files: list, overridden: await guideIsOverridden() };
}
