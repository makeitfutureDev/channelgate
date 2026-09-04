#!/usr/bin/env node
// One-shot migration from Skills Manager (skillsmanager.uk) into this gateway's skill catalog.
//
// What it moves, using the Skills Manager tokens this gateway ALREADY stores (the retired
// integration kept them in settings.json / users / channel meta; they are never printed):
//   1. Sources  — every active Skills Manager repository → a git source here (mode auto: they were
//                 auto-synced there and are already trusted), then synced (needs the gateway's
//                 GitHub token for private repositories: settings → skillsGithubToken, or
//                 --github-token, or `gh auth token` on this host).
//   2. Grants   — the organization token's effective favorites → the organization tier; each
//                 channel token's favorites → that channel's grants; each user token's favorites →
//                 that user's own tier. Names resolve to catalog slugs after the sync.
//   3. Templates (optional, needs Skills Manager's Supabase service role via SM_SUPABASE_URL +
//                 SM_SUPABASE_SERVICE_KEY): team favorites → templates (Development → development,
//                 Sales & Marketing → sales + marketing, Management → management, Admin → admin);
//                 admin exclusions → tombstones; users' personal skills → personal local skills.
//
// Idempotent: re-running adds nothing twice. `--dry-run` prints the plan and writes nothing.
// Run on the gateway host with the gateway's environment (CHANNELGATE_DIR as the daemon uses it).
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = new Set(process.argv.slice(2));
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? "" : String(process.argv[i + 1] || "");
};
const DRY = args.has("--dry-run");
const SM_URL = (opt("--skills-manager-url") || process.env.SKILLS_MCP_URL || "https://www.skillsmanager.uk/mcp").replace(/\/+$/, "");
const SM_BASE = SM_URL.replace(/\/+mcp$/i, "");
const SUPA_URL = (opt("--supabase-url") || process.env.SM_SUPABASE_URL || "").replace(/\/+$/, "");
const SUPA_KEY = opt("--supabase-key") || process.env.SM_SUPABASE_SERVICE_KEY || "";

const { getSettings, saveSettings, getSkillsGithubToken, getOrgAccessGrants } = await import("../src/config/settings.js");
const { ensureRoot, getUsers, listChannels } = await import("../src/config/store.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const { syncOneSource } = await import("../src/gateway/skills/index.js");
const { seedBuiltinTemplates } = await import("../src/gateway/skills/templates.js");

await ensureRoot();
const log = (m) => console.log(m);
const settings = getSettings();
const orgToken = typeof settings.defaultSkillsToken === "string" ? settings.defaultSkillsToken : "";
if (!orgToken) {
  console.error("No organization Skills Manager token is stored (settings.defaultSkillsToken); nothing to migrate from.");
  process.exit(2);
}

async function mcp(token) {
  const client = new Client({ name: "channelgate-migrate-skills-manager", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(SM_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
const jsonOf = (r) => JSON.parse(textOf(r));

async function favoritesFor(token) {
  const res = await fetch(`${SM_BASE}/api/favorites`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`favorites HTTP ${res.status}`);
  const j = await res.json();
  return (Array.isArray(j?.favorites) ? j.favorites : []).map((f) => String(f?.name || "").trim()).filter(Boolean);
}

async function supabase(pathAndQuery) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Supabase ${res.status} for ${pathAndQuery}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const summary = { sources: { added: 0, existing: 0, synced: 0, failed: [] }, grants: { org: [], channels: {}, users: {} }, unresolved: new Set(), templates: {}, excluded: 0, personal: { imported: 0, skipped: [] } };

// ── 1. sources ──────────────────────────────────────────────────────────────────────────────
log(`Skills Manager: ${SM_URL}${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);
const admin = await mcp(orgToken);
const repos = jsonOf(await admin.callTool({ name: "library_list_skill_repos", arguments: {} })).items || [];
log(`Repositories in Skills Manager: ${repos.length}`);
const sourceIds = [];
for (const repo of repos) {
  const url = String(repo.repo_url || "").trim();
  if (!url) continue;
  const existing = catalog.findSourceByUrl(url);
  if (existing) {
    summary.sources.existing++;
    sourceIds.push(existing.id);
    log(`  = source #${existing.id} already here: ${url}`);
    continue;
  }
  const treeUrl = /\/tree\//.test(url);
  log(`  + ${repo.active ? "add" : "add (disabled in Skills Manager)"} ${repo.name || ""} ${url}${!treeUrl && repo.branch && repo.branch !== "main" ? ` @${repo.branch}` : ""}`);
  if (DRY) continue;
  const source = catalog.addSource({ kind: "git", label: String(repo.name || ""), url, ref: treeUrl ? "" : String(repo.branch || ""), mode: "auto", enabled: repo.active !== false, createdBy: "migration:skills-manager" });
  summary.sources.added++;
  sourceIds.push(source.id);
}

// GitHub token for private repositories.
let ghToken = opt("--github-token") || getSkillsGithubToken();
if (!ghToken) {
  try {
    ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (ghToken && !DRY) {
      saveSettings({ skillsGithubToken: ghToken });
      log("Stored the host's `gh auth token` as the gateway's GitHub token for skill sources (settings → skillsGithubToken).");
    }
  } catch {
    ghToken = "";
  }
}
if (!ghToken) log("WARNING: no GitHub token — private repositories will fail to sync (set skillsGithubToken in Admin → Skills → Sources).");

if (!DRY) {
  for (const id of sourceIds) {
    const r = await syncOneSource(id, { log: () => {} });
    if (r.ok) {
      summary.sources.synced++;
      log(`  ✓ synced ${r.url}: ${r.discovered} skills (${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged${r.conflicts?.length ? `, ${r.conflicts.length} conflicts` : ""})`);
    } else {
      summary.sources.failed.push({ url: r.url, error: r.error });
      log(`  ✗ ${r.url}: ${r.error}`);
    }
  }
}

// ── 2. grants from favorites ────────────────────────────────────────────────────────────────
const resolveNames = (names) => {
  const slugs = [];
  for (const n of names) {
    const skill = catalog.getSkill(n);
    if (skill && !skill.deleted) slugs.push(skill.slug);
    else summary.unresolved.add(n);
  }
  return slugs;
};

const orgFavs = await favoritesFor(orgToken);
log(`Organization token favorites: ${orgFavs.length}`);
const orgSlugs = DRY ? orgFavs : resolveNames(orgFavs);
if (!DRY && orgSlugs.length) summary.grants.org = authoring.grantSkillsToOrg(orgSlugs).added;
else if (DRY) summary.grants.org = orgSlugs;

for (const ch of await listChannels()) {
  const token = ch.meta?.skillsToken;
  if (!token || token === orgToken) continue;
  try {
    const favs = await favoritesFor(token);
    const slugs = DRY ? favs : resolveNames(favs);
    log(`Channel ${ch.slug}: ${favs.length} favorites via its own token`);
    if (!DRY && slugs.length) summary.grants.channels[ch.slug] = (await authoring.grantSkillsToChannel(ch.slug, slugs))?.added || [];
    else summary.grants.channels[ch.slug] = slugs;
  } catch (err) {
    log(`  ✗ channel ${ch.slug}: ${err.message}`);
  }
}

const users = await getUsers();
for (const [userId, user] of Object.entries(users)) {
  const token = user.skillsToken;
  if (!token || token === orgToken) continue;
  try {
    const favs = await favoritesFor(token);
    const slugs = DRY ? favs : resolveNames(favs);
    log(`User ${userId} (${user.name || "?"}): ${favs.length} favorites`);
    if (!DRY && slugs.length) summary.grants.users[userId] = (await authoring.grantSkillsToUser(userId, slugs)).added;
    else summary.grants.users[userId] = slugs;
  } catch (err) {
    log(`  ✗ user ${userId}: ${err.message}`);
  }
}

// ── 3. Supabase extras: team favorites → templates, exclusions, personal skills ─────────────
if (SUPA_URL && SUPA_KEY) {
  log("Supabase: reading team favorites, exclusions and personal skills");
  if (!DRY) seedBuiltinTemplates();
  const teams = await supabase("teams?select=id,name");
  const teamFavs = await supabase("team_favorites?select=team_id,org_skills(name,slug)");
  const byTeam = new Map();
  for (const row of teamFavs) {
    const team = teams.find((t) => t.id === row.team_id)?.name || row.team_id;
    const name = row.org_skills?.name || row.org_skills?.slug;
    if (!name) continue;
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(name);
  }
  const TEMPLATE_FOR = { development: ["development"], "sales & marketing": ["sales", "marketing"], management: ["management"], admin: ["admin"] };
  for (const [team, names] of byTeam) {
    const targets = TEMPLATE_FOR[team.toLowerCase()] || [team.toLowerCase().replace(/[^a-z0-9]+/g, "-")];
    const slugs = DRY ? names : resolveNames(names);
    for (const t of targets) {
      summary.templates[t] = slugs;
      log(`  template ${t} ← team "${team}": ${slugs.length} skill(s)`);
      if (DRY) continue;
      const existing = catalog.getTemplate(t);
      catalog.upsertTemplate({ slug: t, name: existing?.name || t.charAt(0).toUpperCase() + t.slice(1), description: existing?.description || `Migrated from the Skills Manager team "${team}".`, categories: existing?.categories || [], skills: [...new Set([...(existing?.skills || []), ...slugs])], builtin: existing?.builtin || false });
    }
  }
  const excluded = await supabase("org_skills?select=name,slug&excluded=eq.true");
  for (const row of excluded) {
    const skill = catalog.getSkill(row.name || row.slug);
    if (!skill) continue;
    log(`  exclude ${skill.slug}`);
    if (!DRY) catalog.tombstoneSkill(skill.slug);
    summary.excluded++;
  }
  // Personal skills of the users whose tokens the gateway holds (email ↔ user via whoami).
  for (const [userId, user] of Object.entries(users)) {
    if (!user.skillsToken || user.skillsToken === orgToken) continue;
    let email = "";
    try {
      const c = await mcp(user.skillsToken);
      email = jsonOf(await c.callTool({ name: "library_whoami", arguments: {} }))?.user?.email || "";
      await c.close();
    } catch {
      continue;
    }
    if (!email) continue;
    const profiles = await supabase(`profiles?select=id&email=eq.${encodeURIComponent(email)}`);
    const ownerId = profiles[0]?.id;
    if (!ownerId) continue;
    const personal = await supabase(`personal_skills?select=id,name,slug,content,category,tags,version,description&owner_id=eq.${ownerId}`);
    for (const ps of personal) {
      const files = [{ path: "SKILL.md", content: buildSkillMd(ps) }];
      const refs = await supabase(`personal_skill_files?select=path,content,encoding&personal_skill_id=eq.${ps.id}`);
      for (const f of refs) files.push({ path: f.path, content: f.content, encoding: f.encoding === "base64" ? "base64" : "utf8" });
      log(`  personal skill "${ps.name}" for ${userId}${DRY ? "" : ""}`);
      if (DRY) continue;
      try {
        await authoring.createLocalSkill({ files, createdBy: userId, personal: true, publish: false, note: "migrated from Skills Manager (personal)" });
        summary.personal.imported++;
      } catch (err) {
        summary.personal.skipped.push(`${ps.name}: ${err.message}`);
      }
    }
  }
} else {
  log("Supabase credentials not given (SM_SUPABASE_URL / SM_SUPABASE_SERVICE_KEY): team favorites → templates, exclusions and personal skills are skipped.");
}
await admin.close();

// Skills Manager stores org/personal skill bodies with the frontmatter stripped into columns;
// rebuild a header the catalog's reader understands.
function buildSkillMd(row) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '\\"')}"`;
  const lines = ["---", `name: ${esc(row.name)}`, `description: ${esc(row.description || row.name)}`];
  if (row.category) lines.push(`category: ${esc(row.category)}`);
  if (row.version) lines.push(`version: ${esc(row.version)}`);
  if (Array.isArray(row.tags) && row.tags.length) {
    lines.push("tags:");
    for (const t of row.tags) lines.push(`  - ${esc(t)}`);
  }
  lines.push("---", "", String(row.content || "").trim(), "");
  return lines.join("\n");
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────
log("");
log(`Sources: ${summary.sources.added} added, ${summary.sources.existing} already present, ${summary.sources.synced} synced${summary.sources.failed.length ? `, ${summary.sources.failed.length} failed` : ""}`);
log(`Organization grants added: ${summary.grants.org.length}`);
for (const [slug, added] of Object.entries(summary.grants.channels)) log(`Channel ${slug}: +${added.length}`);
for (const [id, added] of Object.entries(summary.grants.users)) log(`User ${id}: +${added.length}`);
if (Object.keys(summary.templates).length) log(`Templates: ${Object.entries(summary.templates).map(([t, s]) => `${t} (${s.length})`).join(", ")}`);
if (summary.excluded) log(`Excluded skills tombstoned: ${summary.excluded}`);
if (summary.personal.imported || summary.personal.skipped.length) log(`Personal skills: ${summary.personal.imported} imported${summary.personal.skipped.length ? `, skipped: ${summary.personal.skipped.join("; ")}` : ""}`);
if (summary.unresolved.size) log(`Favorites that matched no catalog skill (not granted): ${[...summary.unresolved].join(", ")}`);
log(`Catalog now: ${JSON.stringify(catalog.catalogStats())}`);
log(`Organization tier now: ${(getOrgAccessGrants().skills || []).length} skill(s)`);
