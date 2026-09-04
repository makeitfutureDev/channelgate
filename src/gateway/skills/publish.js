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
import { getSkillsGithubToken, getSkillsPublish } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";

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
  return { owner: parsed.owner, repo: parsed.repo, branch: cfg.branch || "main", subpath: cfg.subpath || "skills", mode: cfg.mode || "commit", url: `https://github.com/${parsed.owner}/${parsed.repo}` };
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

// Publish one revision. Returns { published, commit, files, deleted, adopted } or { published:false, reason }.
export async function publishRevision({ slug, revisionId = null, message = "", actor = "", fetchImpl = fetch } = {}) {
  const target = publishTarget();
  if (!target || target.mode === "off") return { published: false, reason: "publishing is not configured" };
  const token = getSkillsGithubToken();
  if (!token) return { published: false, reason: "no GitHub token is configured for the skills platform" };
  const skill = getSkill(slug);
  if (!skill) throw new SkillCatalogError("skill not found", { status: 404 });
  const revision = getRevision(revisionId ?? skill.pinnedRevisionId ?? skill.currentRevisionId);
  if (!revision || revision.skillId !== skill.id) throw new SkillCatalogError("revision not found", { status: 404 });
  const files = revisionFiles(revision.id);
  const dir = `${target.subpath.replace(/^\/+|\/+$/g, "")}/${skill.slug}`.replace(/^\/+/, "");
  const remote = await listRemoteFiles(fetchImpl, token, target, dir);
  const note = message || `skill(${skill.slug}): revision ${revision.revisionNo}${revision.version ? ` v${revision.version}` : ""}${revision.note ? ` — ${revision.note}` : ""}`;
  let lastCommit = "";
  const written = [];
  for (const f of files) {
    const p = `${dir}/${f.path}`;
    const r = await gh(fetchImpl, token, "PUT", `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`, {
      message: note,
      content: f.content.toString("base64"),
      branch: target.branch,
      ...(remote.has(p) ? { sha: remote.get(p) } : {}),
    });
    if (!r.ok) throw new SkillCatalogError(`GitHub ${r.status} writing ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
    lastCommit = r.json?.commit?.sha || lastCommit;
    written.push(p);
    remote.delete(p);
  }
  const deleted = [];
  for (const [p, sha] of remote) {
    const r = await gh(fetchImpl, token, "DELETE", `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`, { message: `${note} (remove ${p.slice(dir.length + 1)})`, sha, branch: target.branch });
    if (!r.ok) throw new SkillCatalogError(`GitHub ${r.status} deleting ${p}: ${r.text.slice(0, 200)}`, { status: 502 });
    lastCommit = r.json?.commit?.sha || lastCommit;
    deleted.push(p);
  }
  markRevisionPublished(revision.id, { ref: lastCommit });
  let adopted = false;
  const source = publishSource(target);
  if (source && skill.ownerKind === "local") {
    adoptSkillIntoSource(skill.slug, source.id, { sourcePath: dir, sourceRef: lastCommit });
    adopted = true;
  }
  logEvent("skill_published", { skill: skill.slug, revision: revision.revisionNo, commit: lastCommit, files: written.length, deleted: deleted.length, adopted, author: actor });
  return { published: true, commit: lastCommit, repo: target.url, branch: target.branch, path: dir, files: written, deleted, adopted };
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
