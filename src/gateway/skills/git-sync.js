// Sync skills from a GitHub repository into the catalog. Ported from Skills Manager's sync job
// and kept to the same shape it proved out: resolve the branch head through the commits API,
// download the whole repository as ONE tarball (no per-file API calls, binaries round-trip),
// treat every directory that holds a SKILL.md as a skill, bundle that directory's files (a nested
// skill's files belong to the nested skill), and store each as a content-hashed revision.
//
// What is different here, on purpose:
//   • The stored bytes are the repository's raw files — frontmatter included (lossless).
//   • A `/tree/<branch>/<path>` URL with a slash in the branch name resolves against the
//     repository's real branch list instead of taking the first path segment (the Skills Manager
//     defect that broke every `feat/...` branch).
//   • A source in `review` mode stages every new or changed skill for an admin; `auto` activates.
//   • A source can be pinned to one commit; removed skills tombstone, never vanish.
//   • Ingest limits (file count/size, path rules) come from files.js and reject before storage.
import { buildPluginSkill, PLUGIN_MANIFESTS } from "./plugin-package.js";
import { gunzipSync } from "node:zlib";
import { putSkillRevision, tombstoneMissingSourceSkills, recordSourceSync, getSource, listSources, SkillCatalogError } from "./catalog.js";
import { normalizeSkillPath, isSkillManifestPath, MAX_FILE_BYTES, MAX_FILES } from "./files.js";
import { parseFrontmatter, skillMetadata, slugFromName } from "./frontmatter.js";

export const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
const USER_AGENT = "channelgate-skill-sync";

// ── URL parsing ─────────────────────────────────────────────────────────────────────────────

// Accepts https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), owner/repo, and
// the /tree/<branch-or-tag>/<subpath> form. For a tree URL the branch/subpath split is ambiguous
// when the branch name contains "/", so it is returned as `treePath` for resolveTreeRef to settle
// against the repository's branch list.
export function parseRepoUrl(input) {
  const cleaned = String(input ?? "").trim();
  const tree = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/(.+?)\/?$/);
  if (tree) return { owner: tree[1], repo: tree[2], treePath: tree[3].replace(/\/+$/, ""), ref: "", subpath: "" };
  const noGit = cleaned.replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    noGit.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/) ||
    noGit.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/) ||
    noGit.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) throw new SkillCatalogError(`cannot parse a GitHub owner/repo from "${cleaned}"`);
  return { owner: m[1], repo: m[2], treePath: "", ref: "", subpath: "" };
}

function ghHeaders(token) {
  const h = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(url, { token, fetchImpl }) {
  const res = await fetchImpl(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SkillCatalogError(`GitHub ${res.status} for ${url.replace(/^https:\/\/api\.github\.com/, "")}: ${body.slice(0, 200)}`, { status: 502 });
  }
  return res.json();
}

export async function listBranches({ owner, repo, token = "", fetchImpl = fetch }) {
  const names = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await ghJson(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${page}`, { token, fetchImpl });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) if (r?.name) names.push(String(r.name));
    if (rows.length < 100) break;
  }
  return names;
}

// Split a tree path ("feat/skills-v2/skills/docx") into { ref, subpath } using the real branch
// list: the longest branch name that prefixes the path wins. Falls back to the first segment.
export function splitTreePath(treePath, branches = []) {
  const segments = String(treePath).split("/").filter(Boolean);
  const candidates = branches
    .filter((b) => treePath === b || treePath.startsWith(`${b}/`))
    .sort((a, b) => b.length - a.length);
  if (candidates.length) {
    const ref = candidates[0];
    return { ref, subpath: treePath.slice(ref.length).replace(/^\/+/, "") };
  }
  return { ref: segments[0] || "", subpath: segments.slice(1).join("/") };
}

export async function resolveTreeRef(parsed, { token = "", fetchImpl = fetch } = {}) {
  if (!parsed.treePath) return { ref: parsed.ref, subpath: parsed.subpath };
  let branches = [];
  try {
    branches = await listBranches({ owner: parsed.owner, repo: parsed.repo, token, fetchImpl });
  } catch {
    branches = []; // a tag or an unreachable branch list — fall back to the first segment
  }
  return splitTreePath(parsed.treePath, branches);
}

export async function resolveHeadSha({ owner, repo, ref, token = "", fetchImpl = fetch }) {
  const target = ref ? `commits/${ref.split("/").map(encodeURIComponent).join("/")}` : "commits/HEAD";
  const json = await ghJson(`https://api.github.com/repos/${owner}/${repo}/${target}`, { token, fetchImpl });
  if (!json?.sha) throw new SkillCatalogError(`no commit sha for ${owner}/${repo}@${ref || "HEAD"}`, { status: 502 });
  return String(json.sha);
}

// ── Tarball reading (no dependency: ustar + GNU long names + pax headers) ─────────────────────

function octal(buf) {
  const s = buf.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!s) return 0;
  if (buf[0] & 0x80) {
    // base-256 (GNU) size for very large entries
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
    return n;
  }
  return parseInt(s, 8) || 0;
}

function cstr(buf) {
  const i = buf.indexOf(0);
  return (i === -1 ? buf : buf.subarray(0, i)).toString("utf8");
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  const text = buf.toString("utf8");
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

// Yield every regular file in a (gunzipped) tar buffer as { path, content, mode }.
export function* readTar(tar, { includeLinks = false } = {}) {
  let offset = 0;
  let longName = "";
  let pax = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const name = cstr(header.subarray(0, 100));
    const prefix = header.subarray(257, 262).toString("ascii") === "ustar" ? cstr(header.subarray(345, 500)) : "";
    const mode = octal(header.subarray(100, 108));
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue; // global pax header
    const entryPath = pax.path || longName || (prefix ? `${prefix}/${name}` : name);
    longName = "";
    pax = {};
    if (includeLinks && (type === "1" || type === "2")) yield { path: entryPath, content: Buffer.alloc(0), mode, unsafeLink: true };
    if (type !== "0" && type !== "\0" && type !== "7") continue; // directories, links, devices
    yield { path: entryPath, content: Buffer.from(data), mode };
  }
}

export async function fetchRepoFiles({ owner, repo, sha, token = "", fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(sha)}`, {
    headers: ghHeaders(token),
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SkillCatalogError(`GitHub tarball ${res.status} for ${owner}/${repo}@${sha}: ${body.slice(0, 200)}`, { status: 502 });
  }
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_TARBALL_BYTES) throw new SkillCatalogError(`repository tarball exceeds ${MAX_TARBALL_BYTES / 1024 / 1024} MB`);
  const tar = gunzipSync(gz, { maxOutputLength: MAX_TARBALL_BYTES * 4 });
  return tarToFiles(tar);
}

// Map<repoRelativePath, { content, mode }> with the tarball's top-level `owner-repo-sha/` stripped.
export function tarToFiles(tar) {
  const files = new Map();
  const unsafeLinks = [];
  for (const entry of readTar(tar, { includeLinks: true })) {
    const rel = entry.path.replace(/^\.\//, "").replace(/^[^/]+\//, "");
    if (!rel) continue;
    if (entry.unsafeLink) { unsafeLinks.push(rel); continue; }
    files.set(rel, { content: entry.content, mode: entry.mode });
  }
  files.unsafeLinks = unsafeLinks;
  return files;
}

// ── Discovery ───────────────────────────────────────────────────────────────────────────────

// Every directory (under `subpath`, when set) that holds a SKILL.md is a skill; a file belongs to
// the DEEPEST skill directory that prefixes its path. Returns [{ dir, files, oversized }].
export function discoverSkills(files, subpath = "") {
  const scope = String(subpath || "").replace(/^\/+|\/+$/g, "");
  const inScope = (p) => !scope || p === scope || p.startsWith(`${scope}/`);
  const pluginDirs = [...new Set([...files.keys(), ...(files.unsafeLinks || [])].filter((p) => inScope(p) && Object.values(PLUGIN_MANIFESTS).some((m) => p === m || p.endsWith(`/${m}`))).map((p) => p.split("/").slice(0, -2).join("/")))].sort();
  const outerPlugins = pluginDirs.filter((d) => !pluginDirs.some((parent) => parent !== d && (!parent || d.startsWith(`${parent}/`))));
  const pluginSkills = outerPlugins.map((dir) => {
    const prefix = dir ? `${dir}/` : "";
    if (files.unsafeLinks?.some((p) => p.startsWith(prefix))) throw new Error(`plugin package cannot contain symlinks: ${dir || "."}`);
    const bundle = [...files].filter(([p]) => p.startsWith(prefix) && !p.split("/").includes(".git")).map(([p, f]) => ({ path: p.slice(prefix.length), content: f.content, executable: (f.mode & 0o111) !== 0 }));
    // A failed package must fail discovery before sync can tombstone the last approved copy.
    return { dir, files: buildPluginSkill(bundle), oversized: [] };
  });
  const skillDirs = [];
  for (const p of files.keys()) {
    if (!isSkillManifestPath(p.split("/").pop()) || !inScope(p) || outerPlugins.some((d) => !d || p.startsWith(`${d}/`))) continue;
    skillDirs.push(p.split("/").slice(0, -1).join("/"));
  }
  skillDirs.sort();
  const out = [...pluginSkills];
  for (const dir of skillDirs) {
    const prefix = dir ? `${dir}/` : "";
    const bundle = [];
    const oversized = [];
    for (const [p, entry] of files) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (!rel) continue;
      if (outerPlugins.some((d) => !d || p.startsWith(`${d}/`))) continue;
      // A deeper skill directory owns this file.
      if (skillDirs.some((d) => d.length > dir.length && d.startsWith(prefix) && p.startsWith(`${d}/`))) continue;
      if (/(^|\/)\.git\//.test(`${rel}/`) || rel.split("/").some((seg) => seg === ".git")) continue;
      let safe;
      try {
        safe = normalizeSkillPath(rel);
      } catch {
        continue; // a path the catalog would refuse (traversal, control chars) is skipped
      }
      if (entry.content.length > MAX_FILE_BYTES) {
        oversized.push(rel);
        continue;
      }
      if (bundle.length >= MAX_FILES) break;
      bundle.push({ path: safe, content: entry.content, executable: (entry.mode & 0o111) !== 0 });
    }
    out.push({ dir, files: bundle, oversized });
  }
  return out;
}

// ── The sync ────────────────────────────────────────────────────────────────────────────────

// Sync one git source. `token` is the daemon's GitHub token (optional, for private repositories
// and API rate limits); it never enters the catalog or a channel folder. Returns the stats that
// are also recorded on the source row.
export async function syncGitSource(source, { token = "", fetchImpl = fetch, log = () => {} } = {}) {
  // Always the stored row: a caller's object may predate a mode/pin change made since.
  const src = getSource(typeof source === "number" ? source : source?.id) || (typeof source === "object" ? source : null);
  if (!src) throw new SkillCatalogError("source not found", { status: 404 });
  const stats = { discovered: 0, created: 0, updated: 0, staged: 0, unchanged: 0, tombstoned: 0, conflicts: [], skipped: [], oversized: [] };
  try {
    const parsed = parseRepoUrl(src.url);
    const tree = await resolveTreeRef(parsed, { token, fetchImpl });
    const ref = src.ref || tree.ref;
    const subpath = src.subpath || tree.subpath;
    const sha = src.pinnedRef || (await resolveHeadSha({ owner: parsed.owner, repo: parsed.repo, ref, token, fetchImpl }));
    log(`[skills] syncing ${parsed.owner}/${parsed.repo}@${ref || "HEAD"} (${sha.slice(0, 7)})${subpath ? ` under ${subpath}` : ""}`);
    const files = await fetchRepoFiles({ owner: parsed.owner, repo: parsed.repo, sha, token, fetchImpl });
    const skills = discoverSkills(files, subpath);
    stats.discovered = skills.length;
    const present = [];
    for (const skill of skills) {
      const manifest = skill.files.find((f) => isSkillManifestPath(f.path));
      if (!manifest) continue;
      const md = skillMetadata(parseFrontmatter(manifest.content.toString("utf8")).data);
      if (!md.name || !md.description) {
        stats.skipped.push({ dir: skill.dir, reason: "SKILL.md has no name/description" });
        continue;
      }
      const slug = slugFromName(md.name) || slugFromName(skill.dir.split("/").pop());
      if (!slug) {
        stats.skipped.push({ dir: skill.dir, reason: "name slugifies to nothing" });
        continue;
      }
      for (const o of skill.oversized) stats.oversized.push(`${skill.dir}/${o}`);
      let r;
      try {
        r = putSkillRevision({
          slug,
          files: skill.files,
          ownerKind: "git",
          sourceId: src.id,
          sourcePath: skill.dir || ".",
          sourceRef: sha,
          note: `sync ${parsed.owner}/${parsed.repo}@${sha.slice(0, 7)}`,
          status: src.mode === "auto" ? "active" : "staged",
        });
      } catch (err) {
        stats.skipped.push({ dir: skill.dir, reason: err?.message || String(err) });
        continue;
      }
      if (r.conflict) {
        stats.conflicts.push({ slug, reason: r.reason });
        continue;
      }
      present.push(r.skill.slug);
      if (!r.changed) stats.unchanged++;
      else if (r.revision?.status === "staged") stats.staged++;
      else if (r.created) stats.created++;
      else stats.updated++;
    }
    if (!stats.skipped.length && !stats.conflicts.length) stats.tombstoned = tombstoneMissingSourceSkills(src.id, present);
    recordSourceSync(src.id, { ok: true, ref: sha, stats });
    return { ok: true, ref: sha, ...stats };
  } catch (err) {
    const message = err?.message || String(err);
    recordSourceSync(src.id, { ok: false, error: message, stats });
    return { ok: false, error: message, ...stats };
  }
}

// Sync every enabled git source, one after another; one failure never stops the others.
export async function syncAllGitSources(opts = {}) {
  const out = [];
  for (const src of listSources()) {
    if (src.kind !== "git" || !src.enabled) continue;
    out.push({ id: src.id, url: src.url, ...(await syncGitSource(src, opts)) });
  }
  return out;
}
