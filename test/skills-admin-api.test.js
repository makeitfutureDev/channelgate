// The admin API of the skills platform (src/web/routes/skills.js) over the real admin router:
// catalog reads and the file endpoint, local authoring, a folder source's import + review queue,
// templates (preview/apply), per-conversation grants, usage, proposals, and the settings fields
// (the GitHub token never rides a listing; it is revealable only through the secrets allowlist).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
const { settingsForApi, saveSettings } = await import("../src/config/settings.js");
const { revealableFields, readSecret } = await import("../src/web/secrets.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const { seedBuiltinTemplates } = await import("../src/gateway/skills/templates.js");

const CHANNEL = "C_SKILLS_API";
const entry = await upsertChannelEntry(CHANNEL, { name: "skills-api-test", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: CHANNEL, name: "skills-api-test", type: "channel", isDM: false }));
seedBuiltinTemplates();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  saveSettings({ skillsGithubToken: "", accessGrants: { skills: [] } });
});

async function request(p, { method = "GET", body } = {}) {
  const response = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

const skillMd = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

test("catalog: create a local skill, read it back with its files, update it, pin and roll back, remove and restore", async () => {
  const created = await request("/skills/catalog", { method: "POST", body: { files: [{ path: "SKILL.md", content: skillMd("Api Skill", "created over the API", "category: Development\n") }, { path: "references/r.md", content: "ref" }], note: "first" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.skill.slug, "api-skill");
  assert.equal(created.json.skill.ownerKind, "local");

  const list = await request("/skills/catalog?q=api%20skill");
  assert.equal(list.status, 200);
  assert.ok(list.json.skills.some((s) => s.slug === "api-skill"));
  assert.ok(!("meta" in list.json.skills[0]) || list.json.skills[0].meta === undefined, "listings stay light");

  const detail = await request("/skills/catalog/api-skill");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.files.map((f) => f.path), ["SKILL.md", "references/r.md"]);
  assert.equal(detail.json.revisions.length, 1);
  assert.equal(detail.json.frontmatter.category, "Development");

  const file = await request("/skills/catalog/api-skill/file?path=references/r.md");
  assert.equal(file.json.file.content, "ref");
  assert.equal((await request("/skills/catalog/api-skill/file?path=nope.md")).status, 404);

  const updated = await request("/skills/catalog", { method: "POST", body: { slug: "api-skill", files: [{ path: "SKILL.md", content: skillMd("Api Skill", "updated over the API") }], remove: ["references/r.md"] } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.changed, true);
  assert.deepEqual((await request("/skills/catalog/api-skill")).json.files.map((f) => f.path), ["SKILL.md"]);

  const pinned = await request("/skills/catalog/api-skill/pin", { method: "POST", body: { revisionNo: 1 } });
  assert.equal(pinned.status, 200);
  assert.ok(pinned.json.skill.pinnedRevisionId);
  assert.deepEqual((await request("/skills/catalog/api-skill")).json.files.map((f) => f.path), ["SKILL.md", "references/r.md"], "the pinned revision is the effective one");
  assert.equal((await request("/skills/catalog/api-skill/pin", { method: "POST", body: { revisionNo: 9 } })).status, 404);
  await request("/skills/catalog/api-skill/pin", { method: "POST", body: { revisionNo: null } });

  assert.equal((await request("/skills/catalog/api-skill", { method: "DELETE" })).status, 200);
  assert.equal((await request("/skills/catalog?q=api-skill")).json.skills.length, 0, "removed skills are hidden by default");
  assert.equal((await request("/skills/catalog?q=api-skill&deleted=1")).json.skills[0].deleted, true);
  assert.equal((await request("/skills/catalog/api-skill/restore", { method: "POST", body: {} })).json.skill.deleted, false);

  const bad = await request("/skills/catalog", { method: "POST", body: { files: [{ path: "../evil.md", content: "x" }, { path: "SKILL.md", content: skillMd("Evil", "x") }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /traverse/);
});

test("sources: a folder source imports in review mode, the review queue approves it, and removing the source tombstones its skills", async () => {
  const dir = tempDir("cg-skills-api-src-");
  await mkdir(path.join(dir, "folder-skill", "scripts"), { recursive: true });
  await writeFile(path.join(dir, "folder-skill", "SKILL.md"), skillMd("Folder Skill", "from a folder source", "category: Sales\n"));
  await writeFile(path.join(dir, "folder-skill", "scripts", "go.sh"), "#!/bin/sh\n");
  await chmod(path.join(dir, "folder-skill", "scripts", "go.sh"), 0o755);

  const added = await request("/skills/sources", { method: "POST", body: { kind: "folder", url: dir, label: "test folder", mode: "review" } });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const sourceId = added.json.source.id;
  assert.equal(added.json.sync.imported.length, 1);
  const staged = await request("/skills/staged");
  const rev = staged.json.staged.find((r) => r.slug === "folder-skill");
  assert.ok(rev, "review mode stages the imported skill");
  assert.equal((await request("/skills/catalog/folder-skill")).json.skill.currentRevisionId, null);

  const files = await request(`/skills/revisions/${rev.id}/files?content=1`);
  assert.deepEqual(files.json.files.map((f) => f.path), ["SKILL.md", "scripts/go.sh"]);
  assert.equal(files.json.files[1].executable, true);

  const approved = await request(`/skills/revisions/${rev.id}/approve`, { method: "POST", body: {} });
  assert.equal(approved.status, 200);
  assert.ok((await request("/skills/catalog/folder-skill")).json.skill.currentRevisionId);
  assert.equal((await request("/skills/overview")).json.staged.length, 0);

  const bad = await request("/skills/sources", { method: "POST", body: { kind: "svn", url: "x" } });
  assert.equal(bad.status, 400);
  const dup = await request("/skills/sources", { method: "POST", body: { kind: "folder", url: dir } });
  assert.equal(dup.status, 409);

  const mode = await request(`/skills/sources/${sourceId}`, { method: "PUT", body: { mode: "auto", enabled: false } });
  assert.equal(mode.json.source.mode, "auto");
  assert.equal(mode.json.source.enabled, false);

  const removed = await request(`/skills/sources/${sourceId}`, { method: "DELETE" });
  assert.equal(removed.json.tombstoned, 1);
  assert.equal((await request("/skills/catalog/folder-skill")).json.skill.deleted, true);
});

test("templates: preview and apply to a conversation, grant/revoke, profile and usage endpoints", async () => {
  await request("/skills/catalog", { method: "POST", body: { files: [{ path: "SKILL.md", content: skillMd("Tpl Sales Skill", "sales via template", "category: Sales\nrequires: [tpl-dep]\n") }] } });
  await request("/skills/catalog", { method: "POST", body: { files: [{ path: "SKILL.md", content: skillMd("Tpl Dep", "a dependency") }] } });
  const templates = await request("/skills/templates");
  const sales = templates.json.templates.find((t) => t.slug === "sales");
  assert.ok(sales.resolved.includes("tpl-sales-skill"));

  const preview = await request(`/skills/templates/sales/preview?channel=${entry.slug}&mode=add`);
  assert.equal(preview.status, 200);
  assert.ok(preview.json.preview.add.includes("tpl-sales-skill") && preview.json.preview.add.includes("tpl-dep"));
  assert.equal((await request("/skills/templates/sales/preview?channel=nope")).status, 404);

  const applied = await request("/skills/templates/sales/apply", { method: "POST", body: { channel: entry.slug, mode: "add" } });
  assert.equal(applied.status, 200);
  assert.ok((await getChannelMeta(entry.slug)).skills.includes("tpl-sales-skill"));

  const profile = await request(`/skills/profile/${entry.slug}`);
  assert.equal(profile.status, 200);
  // Applying a template snapshots the dependency INTO the grant list, so it resolves as a grant.
  assert.ok(profile.json.profile.active.some((e) => e.slug === "tpl-dep"));
  assert.ok(profile.json.grants.includes("tpl-dep"));
  assert.equal(typeof profile.json.profile.contextTokens, "number");

  const revoked = await request(`/skills/profile/${entry.slug}/revoke`, { method: "POST", body: { slugs: ["tpl-sales-skill"] } });
  assert.deepEqual(revoked.json.removed, ["tpl-sales-skill"]);
  const granted = await request(`/skills/profile/${entry.slug}/grant`, { method: "POST", body: { slugs: ["Tpl Sales Skill"] } });
  assert.deepEqual(granted.json.added, ["tpl-sales-skill"], "a name resolves to its slug; the dependency is already there");
  assert.equal((await request("/skills/profile/nope/grant", { method: "POST", body: { slugs: ["x"] } })).status, 404);

  const custom = await request("/skills/templates", { method: "POST", body: { slug: "support", name: "Support", categories: ["Support"], skills: ["tpl-dep"] } });
  assert.equal(custom.json.template.builtin, false);
  assert.deepEqual(custom.json.template.resolved, ["tpl-dep"]);
  assert.equal((await request("/skills/templates/support", { method: "DELETE" })).status, 200);
  assert.equal((await request("/skills/templates/support", { method: "DELETE" })).status, 404);

  catalog.recordSkillUsage({ slug: "tpl-sales-skill", channelSlug: entry.slug, engine: "claude", signal: "exact", userId: "U1" });
  const usage = await request(`/skills/usage?channel=${entry.slug}&days=7`);
  assert.equal(usage.json.report.used[0].slug, "tpl-sales-skill");
  assert.ok(usage.json.report.neverUsed.some((n) => n.slug === "tpl-dep"));
  const profiles = await request("/skills/profiles");
  assert.ok(profiles.json.profiles.some((p) => p.slug === entry.slug && p.skills.includes("tpl-sales-skill")));
});

test("proposals: list pending, approve into a revision, reject with a note", async () => {
  const { proposal } = catalog.createProposal({ slug: "tpl-dep", kind: "change", files: [{ path: "SKILL.md", content: skillMd("Tpl Dep", "a dependency, improved") }], note: "wording", proposedBy: "U2" }) && { proposal: catalog.listProposals({ status: "pending" })[0] };
  const pending = await request("/skills/proposals?status=pending");
  assert.ok(pending.json.proposals.some((p) => p.id === proposal.id));
  const approved = await request(`/skills/proposals/${proposal.id}/approve`, { method: "POST", body: { note: "ok" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.revision.revisionNo, 2);
  assert.equal((await request(`/skills/proposals/${proposal.id}/approve`, { method: "POST", body: {} })).status, 409);
  const second = catalog.createProposal({ slug: "tpl-dep", kind: "promote", note: "everywhere", proposedBy: "U3" });
  const rejected = await request(`/skills/proposals/${second.id}/reject`, { method: "POST", body: { note: "no" } });
  assert.equal(rejected.json.proposal.status, "rejected");
  assert.equal(rejected.json.proposal.decisionNote, "no");
});

test("settings: the skills fields save, clamp, and the GitHub token is write-only + revealable through the allowlist", async () => {
  const saved = await request("/settings", { method: "PUT", body: { skillsGithubToken: "ghp_secret_value_1234", skillsSyncIntervalMinutes: 15, skillsContextWarnTokens: 4000 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const api = settingsForApi();
  assert.equal(api.hasSkillsGithubToken, true);
  assert.equal(api.skillsGithubTokenLast4, "1234");
  assert.equal(api.skillsSyncIntervalMinutes, 15);
  assert.equal(api.skillsContextWarnTokens, 4000);
  assert.equal(JSON.stringify(api).includes("ghp_secret_value"), false, "the token never rides a listing");
  assert.ok(revealableFields("settings").includes("skillsGithubToken"));
  assert.equal(await readSecret({ scope: "settings", field: "skillsGithubToken" }), "ghp_secret_value_1234");
  const overview = await request("/skills/overview");
  assert.equal(overview.json.settings.hasGithubToken, true);
  assert.equal(overview.json.settings.syncIntervalMinutes, 15);
  assert.equal((await request("/settings", { method: "PUT", body: { skillsSyncIntervalMinutes: -1 } })).status, 400);
  assert.equal((await request("/settings", { method: "PUT", body: { skillsContextWarnTokens: 0 } })).status, 400);
  await request("/settings", { method: "PUT", body: { clearSkillsGithubToken: true } });
  assert.equal(settingsForApi().hasSkillsGithubToken, false);
});
