// Git publishing: write a skill revision into the configured GitHub repository so skills authored
// or approved in chat land in version control (docs/SKILLS.md, "Publishing"). Uses the GitHub
// Contents API with the daemon's GitHub token — one commit per changed file, the way Skills
// Manager published — under `<subpath>/<slug>/<path>`. Files the previous published revision had
// and this one dropped are deleted. The token never reaches a channel folder or an MCP config.
//
// When the publish repository is also a configured git SOURCE, the published skill is ADOPTED by
// that source (owner git, same source id) so the next sync recognizes its own files instead of
// reporting a conflict — that is how "authored in chat → pushed to GitHub → part of the library"
// closes the loop.
import { getSkill, getRevision, revisionFiles, listSources, adoptSkillIntoSource, markRevisionPublished, SkillCatalogError } from "./catalog.js";
import { parseRepoUrl } from "./git-sync.js";
import { getSkillsPublishGithubToken, getSkillsPublish } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";
import { CHANNEL_SECTION_DIR, normalizeChannelScope, setSkillChannelScope } from "./catalog.js";
import { getChannelEntry } from "../../config/store.js";

const USER_AGENT = "channelgate-skill-publish";

function ghHeaders(token) {
  return { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function gh(fetchImpl, token, method, url, body) {
  const res = await fetchImpl(url, { method, headers: ghHeaders(token), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

// The effective publish target: settings + the parsed repository. null when publishing is off.
export function publishTarget() {
  const cfg = getSkillsPublish();
  if (!cfg.repo) return null;
  const parsed = parseRepoUrl(cfg.repo);
  return { owner: parsed.owner, repo: parsed.repo, branch: cfg.branch || "main", subpath: cfg.subpath === "." ? "" : cfg.subpath || "skills", mode: cfg.mode || "commit", url: `https://github.com/${parsed.owner}/${parsed.repo}` };
}

// Is the publish repository one of the configured git sources? Returns that source or null.
export function publishSource(target = publishTarget()) {
  if (!target) return null;
  for (const src of listSources()) {
    if (src.kind !== "git" || !src.enabled) continue;
    try {
      const p = parseRepoUrl(src.url);
      if (p.owner.toLowerCase() === target.owner.toLowerCase() && p.repo.toLowerCase() === target.repo.toLowerCase()) return src;
    } catch {
      /* not a parseable repo url */
    }
  }
  return null;
}

async function listRemoteFiles(fetchImpl, token, target, dir) {
  // Recursive listing of the skill's folder in the repository (contents API lists one level).
  const out = new Map();
  const walk = async (p) => {
    const r = await gh(fetchImpl, token, "GET", `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(target.branch)}`);
    if (r.status === 404) return;
    if (!r.ok) throw new SkillCatalogError(`GitHub ${r.status} listing ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
    for (const entry of Array.isArray(r.json) ? r.json : []) {
      if (entry.type === "dir") await walk(entry.path);
      else if (entry.type === "file") out.set(entry.path, entry.sha);
    }
  };
  await walk(dir);
  return out;
}

function contentsUrl(target, p) {
  return `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
}

async function putFile(fetchImpl, token, target, p, content, message, sha = "") {
  const r = await gh(fetchImpl, token, "PUT", contentsUrl(target, p), { message, content: content.toString("base64"), branch: target.branch, ...(sha ? { sha } : {}) });
  if (!r.ok) throw new SkillCatalogError(`GitHub ${r.status} writing ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
  return r.json?.commit?.sha || "";
}

async function deleteFile(fetchImpl, token, target, p, sha, message) {
  const r = await gh(fetchImpl, token, "DELETE", contentsUrl(target, p), { message, sha, branch: target.branch });
  if (!r.ok) throw new SkillCatalogError(`GitHub ${r.status} deleting ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
  return r.json?.commit?.sha || "";
}

// Where a skill's files go in the repository: the shared library (`<subpath>/<slug>`; subpath "."
// in Settings = the repository root) or the channel's section (`channels/<channelId>/<slug>`).
export function skillDir(target, { slug, channelScope = "" } = {}) {
  const base = channelScope ? `${CHANNEL_SECTION_DIR}/${normalizeChannelScope(channelScope)}` : (target?.subpath || "").replace(/^\/+|\/+$/g, "");
  return base ? `${base}/${slug}` : slug;
}

// A skill the publish repository already owns is written back to the folder it was synced from
// (moving it is an explicit step, moveSkillFiles); anything else goes where its scope says.
function publishDirFor(target, skill, source) {
  if (source && skill.ownerKind === "git" && skill.sourceId === source.id && skill.sourcePath && skill.sourcePath !== ".") {
    const rel = skill.sourcePath.replace(/^\/+|\/+$/g, "");
    const base = (source.subpath || "").replace(/^\/+|\/+$/g, "");
    return base && !rel.startsWith(`${base}/`) ? `${base}/${rel}` : rel;
  }
  return skillDir(target, skill);
}

// A channel section carries a README naming the channel, so the folder of ids stays readable.
async function ensureSectionReadme(fetchImpl, token, target, channelId, message) {
  const p = `${CHANNEL_SECTION_DIR}/${channelId}/README.md`;
  const r = await gh(fetchImpl, token, "GET", `${contentsUrl(target, p)}?ref=${encodeURIComponent(target.branch)}`);
  if (r.ok) return "";
  if (r.status !== 404) throw new SkillCatalogError(`GitHub ${r.status} reading ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
  const entry = await getChannelEntry(channelId);
  const name = entry?.name ? `#${entry.name}` : channelId;
  const body = `# ${name}\n\nSkills in this folder belong to the Slack channel ${name} (${channelId}). ChannelGate grants them there automatically; move one to the library (the repository root) to share it.\n`;
  return putFile(fetchImpl, token, target, p, Buffer.from(body), message);
}

// Publish one revision. Returns { published, commit, files, deleted, adopted } or { published:false, reason }.
export async function publishRevision({ slug, revisionId = null, message = "", actor = "", fetchImpl = fetch } = {}) {
  const target = publishTarget();
  if (!target || target.mode === "off") return { published: false, reason: "publishing is not configured" };
  const token = getSkillsPublishGithubToken();
  if (!token) return { published: false, reason: "no GitHub token is configured for the skills platform" };
  const skill = getSkill(slug);
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  const revision = getRevision(revisionId ?? skill.pinnedRevisionId ?? skill.currentRevisionId);
  if (!revision || revision.skillId !== skill.id) throw new SkillCatalogError("revision not found", { status: 404 });
  const files = revisionFiles(revision.id);
  const source = publishSource(target);
  const dir = publishDirFor(target, skill, source);
  const remote = await listRemoteFiles(fetchImpl, token, target, dir);
  const note = message || `skill(${skill.slug}): revision ${revision.revisionNo}${revision.version ? ` v${revision.version}` : ""}${revision.note ? ` — ${revision.note}` : ""}`;
  let lastCommit = "";
  const written = [];
  for (const f of files) {
    const p = `${dir}/${f.path}`;
    lastCommit = (await putFile(fetchImpl, token, target, p, f.content, note, remote.get(p))) || lastCommit;
    written.push(p);
    remote.delete(p);
  }
  const deleted = [];
  for (const [p, sha] of remote) {
    lastCommit = (await deleteFile(fetchImpl, token, target, p, sha, `${note} (remove ${p.slice(dir.length + 1)})`)) || lastCommit;
    deleted.push(p);
  }
  if (skill.channelScope) lastCommit = (await ensureSectionReadme(fetchImpl, token, target, skill.channelScope, note)) || lastCommit;
  markRevisionPublished(revision.id, { ref: lastCommit });
  let adopted = false;
  if (source && skill.ownerKind === "local") {
    adoptSkillIntoSource(skill.slug, source.id, { sourcePath: dir, sourceRef: lastCommit });
    adopted = true;
  }
  logEvent("skill_published", { skill: skill.slug, revision: revision.revisionNo, commit: lastCommit, files: written.length, deleted: deleted.length, adopted, author: actor });
  return { published: true, commit: lastCommit, repo: target.url, branch: target.branch, path: dir, files: written, deleted, adopted };
}

// Move a skill's published files between the library and a channel section: the current
// revision is written under the new folder (replacing whatever was there), the old folder is
// deleted, and the catalog is pointed at the new path — the scope follows the path.
export async function moveSkillFiles({ slug, channelId = "", actor = "", fetchImpl = fetch } = {}) {
  const target = publishTarget();
  if (!target || target.mode === "off") throw new SkillCatalogError("publishing is not configured (Admin → Skills → Sources → Publishing)", { status: 409 });
  const token = getSkillsPublishGithubToken();
  if (!token) throw new SkillCatalogError("no GitHub token is configured for the skills platform", { status: 409 });
  const skill = getSkill(slug);
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  const revision = getRevision(skill.pinnedRevisionId ?? skill.currentRevisionId);
  if (!revision) throw new SkillCatalogError("the skill has no active revision to move", { status: 409 });
  const scope = normalizeChannelScope(channelId);
  const source = publishSource(target);
  const fromDir = publishDirFor(target, skill, source);
  const toDir = skillDir(target, { slug: skill.slug, channelScope: scope });
  if (fromDir === toDir) return { moved: false, path: toDir, commit: "" };
  const files = revisionFiles(revision.id);
  const note = `skill(${skill.slug}): move to ${scope ? `the ${scope} channel section` : "the shared library"}`;
  const stale = await listRemoteFiles(fetchImpl, token, target, toDir);
  let lastCommit = "";
  for (const f of files) {
    const p = `${toDir}/${f.path}`;
    lastCommit = (await putFile(fetchImpl, token, target, p, f.content, note, stale.get(p))) || lastCommit;
    stale.delete(p);
  }
  for (const [p, sha] of stale) lastCommit = (await deleteFile(fetchImpl, token, target, p, sha, `${note} (replace ${p})`)) || lastCommit;
  for (const [p, sha] of await listRemoteFiles(fetchImpl, token, target, fromDir)) lastCommit = (await deleteFile(fetchImpl, token, target, p, sha, `${note} (remove ${p})`)) || lastCommit;
  if (scope) lastCommit = (await ensureSectionReadme(fetchImpl, token, target, scope, note)) || lastCommit;
  markRevisionPublished(revision.id, { ref: lastCommit });
  if (source) adoptSkillIntoSource(skill.slug, source.id, { sourcePath: toDir, sourceRef: lastCommit });
  else setSkillChannelScope(skill.slug, scope);
  logEvent("skill_moved", { skill: skill.slug, from: fromDir, to: toDir, scope, commit: lastCommit, author: actor });
  return { moved: true, from: fromDir, path: toDir, commit: lastCommit, repo: target.url, branch: target.branch };
}

// Best-effort publish for the authoring paths: never throws into a chat turn; the result is
// reported in words and the failure logged.
export async function publishQuietly(args) {
  try {
    return await publishRevision(args);
  } catch (err) {
    logEvent("skill_publish_failed", { skill: args?.slug, error: err?.message || String(err) });
    return { published: false, reason: err?.message || String(err), failed: true };
  }
}
