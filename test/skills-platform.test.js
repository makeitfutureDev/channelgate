// Skills platform Core (docs/SKILLS.md): the frontmatter reader, the file-bundle rules, the
// catalog's revision/ownership/tombstone model, the profile resolver (dependencies, cycles,
// context estimate), the write-on-change materializer, folder import, the GitHub tarball sync
// (with the branch-with-slash fix), templates, usage capture, and the authoring/proposal rules.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, lstat, symlink, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ensureTestEnv, tempDir } from "./helpers.js";

const scratch = ensureTestEnv();
const frontmatter = await import("../src/gateway/skills/frontmatter.js");
const files = await import("../src/gateway/skills/files.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const resolve = await import("../src/gateway/skills/resolve.js");
const materialize = await import("../src/gateway/skills/materialize.js");
const importer = await import("../src/gateway/skills/import-folder.js");
const gitSync = await import("../src/gateway/skills/git-sync.js");
const skillsPlatform = await import("../src/gateway/skills/index.js");
const templates = await import("../src/gateway/skills/templates.js");
const usage = await import("../src/gateway/skills/usage.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const { retireStandaloneGatewaySkills } = await import("../src/gateway/skills/retire.js");
const { enableSkills } = await import("../src/gateway/folders.js");
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, getChannelMeta, setUser, getUser } = await import("../src/config/store.js");
const { saveSettings, getSettings, getOrgAccessGrants } = await import("../src/config/settings.js");
const { toolTarget } = await import("../src/engines/stream.js");
const { progressFromCodexEvent } = await import("../src/engines/codex.js");
const skillTools = await import("../src/mcp/tools/skills.js");

const md = (name, description, extra = "", body = `# ${name}\n`) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}` });

test("promoting video understanding into gateway-usage retires its catalog entry and every durable grant", async () => {
  catalog.putSkillRevision({ files: [md("video-understanding", "old standalone video workflow")], ownerKind: "local" });
  catalog.upsertTemplate({ slug: "video-test", name: "Video", skills: ["video-understanding", "keep-template"] });
  const entry = await upsertChannelEntry("C_RETIRED_VIDEO", { name: "retired-video", type: "channel" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: entry.channelId, name: entry.name, type: "channel", isDM: false }), skills: ["video-understanding", "keep-channel"] });
  await setUser("U_RETIRED_VIDEO", { name: "Viewer", skills: ["video-understanding", "keep-user"] });
  saveSettings({
    accessGrants: { skills: ["video-understanding", "keep-org"] },
    channelTemplate: { skills: ["video-understanding", "keep-new-channel"] },
    dmTemplates: { user: { skills: ["video-understanding", "keep-dm"] }, admin: { skills: ["video-understanding"] } },
  });

  const first = retireStandaloneGatewaySkills();
  const second = retireStandaloneGatewaySkills();

  assert.equal(first.catalog, 1);
  assert.deepEqual(second, { catalog: 0, users: 0, channels: 0, templates: 0, settings: 0 });
  assert.equal(catalog.getSkill("video-understanding").excluded, true);
  assert.deepEqual(catalog.getTemplate("video-test").skills, ["keep-template"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, ["keep-channel"]);
  assert.deepEqual((await getUser("U_RETIRED_VIDEO")).skills, ["keep-user"]);
  assert.deepEqual(getSettings().accessGrants.skills, ["keep-org"]);
  assert.deepEqual(getSettings().channelTemplate.skills, ["keep-new-channel"]);
  assert.deepEqual(getSettings().dmTemplates.user.skills, ["keep-dm"]);
  assert.deepEqual(getSettings().dmTemplates.admin.skills, []);
});

// ── frontmatter ──────────────────────────────────────────────────────────────────────────────

test("frontmatter reader handles quoted scalars, folded blocks, lists, nested maps and keeps the body", () => {
  const text = `---
name: "customer record"
description: >-
  Load the customer record.
  Use when a deal is named.
category: 'Sales'
version: 2.0.0
tags:
  - crm
  - "hub spot"
requires: [makeitfuture-organization, Deal Desk]
allowed-tools: Read Grep
metadata:
  author: Tib
  version: 9
# a comment
complexity: intermediate   # trailing comment
---

# Body starts here
`;
  const p = frontmatter.parseFrontmatter(text);
  assert.equal(p.hasFrontmatter, true);
  assert.equal(p.data.name, "customer record");
  assert.equal(p.data.description, "Load the customer record. Use when a deal is named.");
  assert.deepEqual(p.data.tags, ["crm", "hub spot"]);
  assert.deepEqual(p.data.requires, ["makeitfuture-organization", "Deal Desk"]);
  assert.equal(p.data.metadata.author, "Tib");
  assert.equal(p.data.complexity, "intermediate");
  assert.equal(p.body.trim(), "# Body starts here");
  const m = frontmatter.skillMetadata(p.data);
  assert.equal(m.version, "2.0.0"); // the top-level key wins over metadata.version
  assert.deepEqual(m.requires, ["makeitfuture-organization", "deal-desk"]);
  assert.deepEqual(m.allowedTools, ["Read Grep"]);
  assert.equal(m.category, "Sales");
});

test("frontmatter reader never throws: no header, unterminated header, and dependencies alias", () => {
  assert.equal(frontmatter.parseFrontmatter("# just markdown").hasFrontmatter, false);
  assert.equal(frontmatter.parseFrontmatter("---\nname: x\n# never closed").hasFrontmatter, false);
  const m = frontmatter.skillMetadata({ name: "x", description: "y", dependencies: "a, b" });
  assert.deepEqual(m.requires, ["a", "b"]);
  assert.equal(frontmatter.slugFromName("  Deal Desk / EU  "), "deal-desk-eu");
});

// ── files ────────────────────────────────────────────────────────────────────────────────────

test("file-bundle rules reject traversal, absolute and reserved paths, and require a SKILL.md", () => {
  for (const bad of ["../x", "/etc/passwd", "a/../../b", "a\\b", ".gateway-skill.json", ""]) {
    assert.throws(() => files.normalizeSkillPath(bad), files.SkillFileError, bad);
  }
  assert.equal(files.normalizeSkillPath("./references//ids.md"), "references/ids.md");
  assert.throws(() => files.normalizeSkillFiles([{ path: "references/a.md", content: "x" }]), /SKILL\.md/);
  assert.throws(() => files.normalizeSkillFiles([md("a", "b"), { path: "skill.MD", content: "dup" }]), /duplicate/);
  const bundle = files.normalizeSkillFiles([{ path: "b.md", content: "b" }, md("a", "b"), { path: "logo.png", content: Buffer.from([137, 80, 0, 1]).toString("base64"), encoding: "base64" }]);
  assert.deepEqual(bundle.map((f) => f.path), ["SKILL.md", "b.md", "logo.png"]);
  assert.equal(files.classifyBytes("logo.png", bundle[2].content).binary, true);
  assert.equal(files.fileToApi(bundle[2]).encoding, "base64");
  assert.equal(files.hashSkillFiles(bundle), files.hashSkillFiles([...bundle].reverse()), "hash is order-independent");
});

// ── catalog ──────────────────────────────────────────────────────────────────────────────────

test("catalog stores lossless revisions, dedupes by hash, indexes frontmatter, and refuses cross-owner writes", () => {
  const first = catalog.putSkillRevision({ files: [md("Alpha Skill", "Alpha does things", "allowed-tools: Read\ncategory: Development\n"), { path: "references/a.md", content: "A" }], ownerKind: "local", createdBy: "U1" });
  assert.equal(first.created, true);
  assert.equal(first.skill.slug, "alpha-skill");
  assert.equal(first.skill.category, "Development");
  assert.equal(first.skill.meta["allowed-tools"], "Read", "unknown-to-columns keys survive in the derived index");
  const again = catalog.putSkillRevision({ files: [{ path: "references/a.md", content: "A" }, md("Alpha Skill", "Alpha does things", "allowed-tools: Read\ncategory: Development\n")], ownerKind: "local" });
  assert.equal(again.changed, false, "same bytes → no new revision");
  const v2 = catalog.putSkillRevision({ files: [md("Alpha Skill", "Alpha does more", "version: 2.0.0\nrequires: [beta-skill]\n")], ownerKind: "local" });
  assert.equal(v2.revision.revisionNo, 2);
  assert.deepEqual(v2.skill.requires, ["beta-skill"]);
  assert.equal(catalog.revisionFiles(v2.revision.id).length, 1, "a revision is the complete folder — the dropped reference is gone");
  const stolen = catalog.putSkillRevision({ files: [md("Alpha Skill", "from git")], ownerKind: "git", sourceId: 99 });
  assert.equal(stolen.conflict, true);
  assert.match(stolen.reason, /owned by local/);
  // Lookup by slug, name, and case-insensitively.
  assert.equal(catalog.getSkill("ALPHA-SKILL").slug, "alpha-skill");
  assert.equal(catalog.getSkill("alpha skill").slug, "alpha-skill");
  const bytes = catalog.revisionFile(v2.revision.id, "SKILL.md").content.toString("utf8");
  assert.match(bytes, /^---\nname: Alpha Skill/, "SKILL.md bytes are stored verbatim, frontmatter included");
});

test("catalog: staged revisions need approval, pins roll back, tombstones restore on reappearance", () => {
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/skills", mode: "review" });
  const staged = catalog.putSkillRevision({ files: [md("Gamma", "Gamma v1")], ownerKind: "git", sourceId: src.id, sourcePath: "skills/gamma", status: "staged", sourceRef: "aaa" });
  assert.equal(staged.revision.status, "staged");
  assert.equal(staged.skill.currentRevisionId, null, "nothing active until approved");
  assert.equal(catalog.effectiveRevisionFor(staged.skill), null);
  assert.equal(catalog.listStagedRevisions().some((r) => r.slug === "gamma"), true);
  catalog.approveRevision(staged.revision.id, { decidedBy: "admin" });
  const gamma = catalog.getSkill("gamma");
  assert.equal(gamma.currentRevisionId, staged.revision.id);
  const v2 = catalog.putSkillRevision({ files: [md("Gamma", "Gamma v2")], ownerKind: "git", sourceId: src.id, sourcePath: "skills/gamma", status: "active", sourceRef: "bbb" });
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("gamma")).revisionNo, 2);
  catalog.pinSkill("gamma", 1);
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("gamma")).revisionNo, 1, "pin = rollback");
  // The derived columns are rebuilt from the newest ACTIVATED revision, so the pin has to be read
  // back through them too: a rolled-back skill that still advertises v2's description is describing
  // files the conversation never receives.
  assert.equal(catalog.getSkill("gamma").description, "Gamma v1", "a pinned skill advertises the pinned revision");
  assert.equal(catalog.listSkills({ query: "gamma" }).find((x) => x.slug === "gamma").description, "Gamma v1", "and so does its catalog row");
  assert.throws(() => catalog.pinSkill("gamma", 7), /not found/);
  catalog.pinSkill("gamma", null);
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("gamma")).revisionNo, 2);
  assert.equal(catalog.getSkill("gamma").description, "Gamma v2", "unpinned follows the current revision again");
  assert.equal(catalog.tombstoneMissingSourceSkills(src.id, []), 1);
  assert.equal(catalog.getSkill("gamma").deleted, true);
  const back = catalog.putSkillRevision({ files: [md("Gamma", "Gamma v2")], ownerKind: "git", sourceId: src.id, sourcePath: "skills/gamma", status: "active", sourceRef: "bbb" });
  assert.equal(back.changed, false);
  assert.equal(catalog.getSkill("gamma").deleted, false, "a returning skill is restored, no new revision");
  assert.throws(() => catalog.rejectRevision(v2.revision.id), /active revision cannot be rejected/);
  const removed = catalog.removeSource(src.id);
  assert.equal(removed.tombstoned, 1);
  assert.equal(catalog.getSource(src.id), null);
});

test("catalog: an operator exclusion survives re-puts (syncs) until restored; a source drop still comes back", () => {
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/sticky", mode: "auto" });
  const put = (body) => catalog.putSkillRevision({ files: [md("Delta", "Delta skill", "", body)], ownerKind: "git", sourceId: src.id, sourcePath: "skills/delta", status: "active", sourceRef: "ccc" });
  put("v1");
  const before = catalog.catalogStats();
  assert.equal(catalog.excludeSkill("delta"), true);
  assert.equal(catalog.excludeSkill("delta"), false, "already excluded");
  assert.deepEqual([catalog.getSkill("delta").deleted, catalog.getSkill("delta").excluded], [true, true]);
  // Same bytes again — what every sync does: stays out (this is what undid the migrated exclusions).
  assert.equal(put("v1").changed, false);
  assert.equal(catalog.getSkill("delta").deleted, true, "a sync must not undo an exclusion");
  // New bytes: the revision is stored (current when included again) but the skill stays out.
  assert.equal(put("v2").changed, true);
  assert.equal(catalog.getSkill("delta").deleted, true);
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("delta")).revisionNo, 2);
  assert.equal(catalog.listSkills().some((s) => s.slug === "delta"), false);
  assert.equal(catalog.listSkills({ includeDeleted: true }).find((s) => s.slug === "delta").excluded, true);
  assert.equal(catalog.catalogStats().excluded, before.excluded + 1);
  assert.equal(catalog.catalogStats().tombstoned, before.tombstoned, "an exclusion is not counted as a source removal");
  assert.equal(catalog.tombstoneMissingSourceSkills(src.id, []), 0, "already out");
  assert.equal(catalog.restoreSkill("delta"), true);
  const back = catalog.getSkill("delta");
  assert.deepEqual([back.deleted, back.excluded], [false, false]);
  assert.equal(catalog.effectiveRevisionFor(back).revisionNo, 2, "included again on its newest revision");
  assert.equal(catalog.catalogStats().excluded, before.excluded);
});

// ── resolver ─────────────────────────────────────────────────────────────────────────────────

test("profile resolver pulls dependencies, reports missing links and cycles, and estimates context", () => {
  catalog.putSkillRevision({ files: [md("Dep Root", "Root skill needs a leaf and a ghost", "requires: [dep-leaf, dep-ghost]\n")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Dep Leaf", "Leaf that points back up", "requires: [dep-root]\n")], ownerKind: "local" });
  const p = resolve.resolveSkillProfile(["dep-root", "not-in-catalog"], { warnTokens: 10 });
  assert.deepEqual(p.slugs, ["dep-root", "dep-leaf"]);
  assert.equal(p.active[1].via, "dependency");
  assert.deepEqual(p.active[1].requiredBy, ["dep-root"]);
  assert.deepEqual(p.unknown, ["not-in-catalog"]);
  assert.deepEqual(p.missingDependencies, [{ slug: "dep-ghost", requiredBy: "dep-root" }]);
  assert.equal(p.cycles.length, 1);
  assert.ok(p.contextTokens > 10);
  assert.ok(p.warnings.some((w) => /soft cap/.test(w)));
  assert.ok(p.warnings.some((w) => /dep-ghost/.test(w)));
  const { names } = resolve.withDependencies(["dep-root"]);
  assert.deepEqual(names, ["dep-root", "dep-leaf"]);
});

// ── materializer + enableSkills ──────────────────────────────────────────────────────────────

test("materializer writes real files write-on-change, keeps project-owned folders, replaces stubs and prunes", async () => {
  const root = tempDir("cg-skills-mat-");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  catalog.putSkillRevision({ files: [md("Mat Skill", "Materialize me"), { path: "references/deep/x.md", content: "deep" }, { path: "scripts/run.sh", content: "#!/bin/sh\n", executable: true }], ownerKind: "local" });
  // A project-owned folder (no marker) and a legacy Skills Manager stub.
  await mkdir(path.join(skillsDir, "project-owned"), { recursive: true });
  await writeFile(path.join(skillsDir, "project-owned", "SKILL.md"), "# mine\n");
  catalog.putSkillRevision({ files: [md("Project Owned", "catalog copy must not win")], ownerKind: "local" });
  await mkdir(path.join(skillsDir, "stubbed"), { recursive: true });
  await writeFile(path.join(skillsDir, "stubbed", ".gateway-library-stub"), "");
  await writeFile(path.join(skillsDir, "stubbed", "SKILL.md"), "stub\n");
  catalog.putSkillRevision({ files: [md("Stubbed", "real body replaces the stub")], ownerKind: "local" });

  const r1 = await enableSkills(skillsDir, ["mat-skill", "project-owned", "stubbed", "nope-nowhere"]);
  assert.deepEqual(r1.enabled, ["mat-skill", "project-owned", "stubbed"]);
  assert.deepEqual(r1.missing, ["nope-nowhere"]);
  assert.equal(r1.states["project-owned"], "project");
  assert.equal(await readFile(path.join(skillsDir, "mat-skill", "references", "deep", "x.md"), "utf8"), "deep");
  assert.ok(((await lstat(path.join(skillsDir, "mat-skill", "scripts", "run.sh"))).mode & 0o111) !== 0, "executables stay executable");
  assert.equal(await readFile(path.join(skillsDir, "project-owned", "SKILL.md"), "utf8"), "# mine\n", "project-owned folder untouched");
  assert.match(await readFile(path.join(skillsDir, "stubbed", "SKILL.md"), "utf8"), /real body/, "stub replaced by real content");
  const manifest = JSON.parse(await readFile(path.join(skillsDir, "mat-skill", ".gateway-skill.json"), "utf8"));
  assert.equal(manifest.revisionNo, 1);

  // Second pass with the same revision: untouched (write-on-change). Then a new revision rewrites.
  const before = (await lstat(path.join(skillsDir, "mat-skill", "SKILL.md"))).mtimeMs;
  const r2 = await enableSkills(skillsDir, ["mat-skill", "project-owned", "stubbed"]);
  assert.equal(r2.states["mat-skill"], "unchanged");
  assert.equal((await lstat(path.join(skillsDir, "mat-skill", "SKILL.md"))).mtimeMs, before);
  catalog.putSkillRevision({ files: [md("Mat Skill", "Materialize me v2")], ownerKind: "local" });
  const r3 = await enableSkills(skillsDir, ["mat-skill", "project-owned", "stubbed"]);
  assert.equal(r3.states["mat-skill"], "written");
  await assert.rejects(lstat(path.join(skillsDir, "mat-skill", "references")), { code: "ENOENT" }, "files the new revision dropped are gone");

  // Grant ends: the managed copy is pruned, the project-owned folder stays.
  await enableSkills(skillsDir, ["project-owned"]);
  await assert.rejects(lstat(path.join(skillsDir, "mat-skill")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(skillsDir, "stubbed")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(skillsDir, "project-owned", "SKILL.md"), "utf8"), "# mine\n");
});

test("materialization resolves dependencies live: a dependency approved after the grant arrives on the next pass", async () => {
  const root = tempDir("cg-skills-deps-");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/late-dep", mode: "review" });
  catalog.putSkillRevision({ files: [md("Needs Late", "needs a dependency", "requires: [late-dep]\n")], ownerKind: "local" });
  const staged = catalog.putSkillRevision({ files: [md("Late Dep", "arrives later")], ownerKind: "git", sourceId: src.id, status: "staged" });
  const first = await enableSkills(skillsDir, ["needs-late"]);
  assert.deepEqual(first.enabled, ["needs-late"]);
  assert.deepEqual(first.missing, ["late-dep"], "the staged dependency is reported, not silently dropped");
  catalog.approveRevision(staged.revision.id);
  const second = await enableSkills(skillsDir, ["needs-late"]);
  assert.deepEqual(second.enabled.sort(), ["late-dep", "needs-late"], "no grant edit needed once the dependency is approved");
  assert.equal(await readFile(path.join(skillsDir, "late-dep", "SKILL.md"), "utf8"), md("Late Dep", "arrives later").content);
  await enableSkills(skillsDir, []);
  await assert.rejects(lstat(path.join(skillsDir, "late-dep")), { code: "ENOENT" }, "a dependency is pruned with the grant that pulled it in");
});

test("a grant with no approved revision is reported missing, never materialized", async () => {
  const root = tempDir("cg-skills-staged-");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/staged-only", mode: "review" });
  catalog.putSkillRevision({ files: [md("Staged Only", "awaiting review")], ownerKind: "git", sourceId: src.id, status: "staged" });
  const r = await enableSkills(skillsDir, ["staged-only"]);
  assert.deepEqual(r.missing, ["staged-only"]);
  assert.equal(r.states["staged-only"], "staged");
  await assert.rejects(lstat(path.join(skillsDir, "staged-only")), { code: "ENOENT" });
});

// ── folder import ────────────────────────────────────────────────────────────────────────────

test("host folder import keeps directory names as slugs, follows the operator's symlinks, skips nested skills, and tombstones vanished folders", async () => {
  const store = tempDir("cg-skills-store-");
  const hostDir = tempDir("cg-skills-host-");
  await mkdir(path.join(store, "real-skill", "references"), { recursive: true });
  await writeFile(path.join(store, "real-skill", "SKILL.md"), md("Real Skill", "from the host").content);
  await writeFile(path.join(store, "real-skill", "references", "r.md"), "ref");
  await mkdir(path.join(store, "real-skill", "inner"), { recursive: true });
  await writeFile(path.join(store, "real-skill", "inner", "SKILL.md"), md("Inner", "nested skill").content);
  await symlink(path.join(store, "real-skill"), path.join(hostDir, "Linked-Skill"));
  await mkdir(path.join(hostDir, "plain"), { recursive: true });
  await writeFile(path.join(hostDir, "plain", "SKILL.md"), md("Plain", "plain folder").content);
  await mkdir(path.join(hostDir, "not-a-skill"), { recursive: true });
  await writeFile(path.join(hostDir, "not-a-skill", "README.md"), "no manifest");

  const r = await importer.importHostSkillFolders([hostDir]);
  const slugs = r.results[0].presentSlugs;
  assert.deepEqual(slugs.sort(), ["Linked-Skill", "plain"]);
  const linked = catalog.getSkill("linked-skill");
  assert.equal(linked.slug, "Linked-Skill", "the directory name is the slug, case kept");
  assert.equal(linked.ownerKind, "folder");
  const paths = catalog.revisionFiles(catalog.effectiveRevisionFor(linked).id).map((f) => f.path);
  assert.deepEqual(paths, ["SKILL.md", "references/r.md"], "nested skill folders are not folded in");
  // Grants stored under the folder name resolve through the catalog.
  const root = tempDir("cg-skills-hostmat-");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const enabled = await enableSkills(skillsDir, ["Linked-Skill"]);
  assert.equal(enabled.states["Linked-Skill"], "written");
  // The folder disappears → tombstone; it returns → restore.
  const again = await importer.importHostSkillFolders([tempDir("cg-skills-empty-")]);
  assert.equal(again.tombstoned, 2);
  assert.equal(catalog.getSkill("plain").deleted, true);
  const back = await importer.importHostSkillFolders([hostDir]);
  assert.equal(back.restored, 2);
  // An operator's exclusion is not undone by the import, even though the folder is still there.
  assert.equal(catalog.excludeSkill("plain"), true);
  const still = await importer.importHostSkillFolders([hostDir]);
  assert.equal(still.restored, 0);
  assert.equal(catalog.getSkill("plain").excluded, true);
  assert.equal(catalog.restoreSkill("plain"), true);
  assert.equal(catalog.getSkill("plain").deleted, false);
});

test("bundled starter library imports as bundled skills", async () => {
  const r = await importer.importBundledSkills({ version: "test" });
  assert.ok(r.presentSlugs.includes("skill-authoring"));
  assert.equal(catalog.getSkill("skill-authoring").ownerKind, "bundled");
  const again = await importer.importBundledSkills({ version: "test" });
  assert.equal(again.imported.length, 0, "a second boot changes nothing");
});

// ── git sync ─────────────────────────────────────────────────────────────────────────────────

function tarEntry(name, content, mode = 0o644) {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

function repoTarball(entries) {
  return gzipSync(Buffer.concat([...entries.map(([n, c, m]) => tarEntry(n, Buffer.from(c), m)), Buffer.alloc(1024)]));
}

function fakeGitHub({ branches = ["main"], sha = "0123456789abcdef", tarball }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/branches")) return { ok: true, json: async () => branches.map((name) => ({ name })) };
    if (url.includes("/commits/")) return { ok: true, json: async () => ({ sha }) };
    if (url.includes("/tarball/")) return { ok: true, arrayBuffer: async () => tarball };
    return { ok: false, status: 404, text: async () => "not found" };
  };
  return { fetchImpl, calls };
}

test("git sync: tree URLs with a slash in the branch resolve against the branch list", async () => {
  assert.deepEqual(gitSync.parseRepoUrl("https://github.com/o/r/tree/feat/x/skills/").treePath, "feat/x/skills");
  assert.deepEqual(gitSync.splitTreePath("feat/x/skills", ["main", "feat/x"]), { ref: "feat/x", subpath: "skills" });
  assert.deepEqual(gitSync.splitTreePath("feat/x/skills", []), { ref: "feat", subpath: "x/skills" }, "no branch list → the old first-segment behaviour");
  assert.deepEqual(gitSync.parseRepoUrl("git@github.com:o/r.git"), { owner: "o", repo: "r", treePath: "", ref: "", subpath: "" });
  assert.throws(() => gitSync.parseRepoUrl("https://gitlab.com/o/r"), /cannot parse/);
});

test("git source sync authenticates with that source's own optional token", async () => {
  const tarball = repoTarball([["r-sha/skill/SKILL.md", md("Source Auth", "private source").content]]);
  const gh = fakeGitHub({ tarball });
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/source-auth", ref: "main", mode: "auto", secret: "ghp_source_only" });
  const result = await skillsPlatform.syncOneSource(src.id, { fetchImpl: gh.fetchImpl, log: () => {} });
  assert.equal(result.ok, true);
  assert.ok(gh.calls.length > 0);
  assert.ok(gh.calls.every((c) => c.init.headers.Authorization === "Bearer ghp_source_only"));
  catalog.removeSource(src.id);
});

test("git sync discovers nested skills from a tarball, stages in review mode, activates in auto mode, tombstones removals", async () => {
  const tarball = repoTarball([
    ["r-sha/README.md", "root readme"],
    ["r-sha/skills/docx/SKILL.md", md("Docx", "Work with Word documents", "category: Development\n").content],
    ["r-sha/skills/docx/references/x.md", "ref"],
    ["r-sha/skills/docx/scripts/run.sh", "#!/bin/sh\n", 0o755],
    ["r-sha/skills/docx/nested/SKILL.md", md("Nested", "a nested skill").content],
    ["r-sha/skills/docx/nested/deep.md", "deep"],
    ["r-sha/skills/broken/SKILL.md", "no frontmatter at all"],
    ["r-sha/elsewhere/other/SKILL.md", md("Other", "outside the subpath").content],
  ]);
  const gh = fakeGitHub({ branches: ["main", "feat/skills-v2"], tarball });
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/repo/tree/feat/skills-v2/skills", mode: "review" });
  let r = await gitSync.syncGitSource(src, { fetchImpl: gh.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.discovered, 3, "docx, nested, broken — 'other' is outside the subpath");
  assert.equal(r.staged, 2);
  assert.equal(r.skipped.length, 1, "the manifest without name/description is skipped, not fatal");
  assert.ok(gh.calls.some(({ url }) => /commits\/feat%2Fskills-v2$/.test(url) || /commits\/feat\/skills-v2$/.test(url)), "the head is resolved for the real branch");
  assert.equal(catalog.getSkill("docx").currentRevisionId, null, "review mode: nothing active yet");
  const docxFiles = catalog.revisionFiles(catalog.listStagedRevisions().find((x) => x.slug === "docx").id).map((f) => `${f.path}${f.executable ? "*" : ""}`);
  assert.deepEqual(docxFiles, ["SKILL.md", "references/x.md", "scripts/run.sh*"], "nested skill's files belong to the nested skill; executable bit kept");
  assert.equal(catalog.getSource(src.id).lastSyncRef, "0123456789abcdef");

  catalog.updateSource(src.id, { mode: "auto" });
  r = await gitSync.syncGitSource(src, { fetchImpl: gh.fetchImpl });
  assert.equal(r.unchanged, 2, "same bytes, no new revision");
  assert.ok(catalog.getSkill("docx").currentRevisionId, "auto mode activates the staged copy");

  // Upstream drops the nested skill: tombstoned, not deleted.
  const smaller = repoTarball([["r-sha/skills/docx/SKILL.md", md("Docx", "Work with Word documents", "category: Development\n").content]]);
  r = await gitSync.syncGitSource(src, { fetchImpl: fakeGitHub({ branches: ["main", "feat/skills-v2"], tarball: smaller }).fetchImpl });
  assert.equal(r.tombstoned, 1);
  assert.equal(catalog.getSkill("nested").deleted, true);
  assert.equal(catalog.listRevisions(catalog.getSkill("nested").id).length, 1, "revisions survive a tombstone");

  // A failing GitHub call records the error on the source and keeps last-good state.
  r = await gitSync.syncGitSource(src, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }) });
  assert.equal(r.ok, false);
  assert.match(catalog.getSource(src.id).lastSyncError, /GitHub 500/);
  assert.ok(catalog.getSkill("docx").currentRevisionId, "last-good stays active");
  // A pinned source never asks for the head.
  catalog.updateSource(src.id, { pinnedRef: "fedcba" });
  const pinned = fakeGitHub({ branches: ["main", "feat/skills-v2"], tarball: smaller });
  await gitSync.syncGitSource(src, { fetchImpl: pinned.fetchImpl });
  assert.ok(!pinned.calls.some(({ url }) => url.includes("/commits/")), "pinned ref skips head resolution");
  assert.ok(pinned.calls.some(({ url }) => url.includes("/tarball/fedcba")));
});

test("git sync refuses a slug another owner holds and reports it as a conflict", async () => {
  catalog.putSkillRevision({ files: [md("Held Locally", "authored here")], ownerKind: "local" });
  const tarball = repoTarball([["r-sha/held-locally/SKILL.md", md("Held Locally", "from upstream").content]]);
  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/conflict", mode: "auto" });
  const r = await gitSync.syncGitSource(src, { fetchImpl: fakeGitHub({ tarball }).fetchImpl });
  assert.equal(r.conflicts.length, 1);
  assert.equal(catalog.getSkill("held-locally").ownerKind, "local");
});

// ── templates ────────────────────────────────────────────────────────────────────────────────

test("templates resolve explicit skills, preview against a conversation, and are followed live", async () => {
  templates.seedBuiltinTemplates();
  assert.equal(templates.seedBuiltinTemplates().length, 0, "seeding is idempotent");
  catalog.putSkillRevision({ files: [md("Sales Play", "A sales skill", "category: sales\nrequires: [crm-base]\n")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("CRM Base", "Base CRM skill", "category: Internal\n")], ownerKind: "local" });
  catalog.upsertTemplate({ slug: "sales", name: "Sales", skills: ["sales-play"] });
  const sales = templates.templateSummary(catalog.getTemplate("Sales"));
  assert.ok(sales.resolved.includes("sales-play"), "explicit selection resolves");
  const preview = templates.previewTemplate("sales", { skills: ["existing-grant"] });
  assert.deepEqual(preview.keep, ["existing-grant"]);
  assert.ok(preview.add.includes("sales-play") && preview.add.includes("crm-base"), "the dependency rides along");

  const entry = await upsertChannelEntry("C_SKILLS_TPL", { name: "skills-tpl", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: "C_SKILLS_TPL", name: "skills-tpl", type: "channel", isDM: false }), skills: ["existing-grant"] });
  const assigned = await templates.assignTemplateToChannel(entry.slug, "sales");
  assert.equal(assigned.skillTemplate, "sales");
  assert.ok(assigned.skills.includes("sales-play") && assigned.skills.includes("existing-grant"));
  const stored = await getChannelMeta(entry.slug);
  assert.deepEqual(stored.skills, ["existing-grant"], "the conversation's own additions stay separate");
  assert.equal(stored.skillTemplate, "sales");
  // Editing the template later changes what the follower gets (live link, not a snapshot).
  catalog.upsertTemplate({ slug: "sales", name: "Sales", categories: [], skills: [] });
  assert.deepEqual(templates.channelSkillGrants(await getChannelMeta(entry.slug)), ["existing-grant"]);
  assert.equal(await templates.assignTemplateToChannel("no-such-channel", "sales"), null);
});

// A template's own skills are never the whole always-on cost: the organization tier loads in every
// conversation whatever the template says, so a preview that counted only the template understated
// the number an admin sizes a template against. Both are reported, each labelled.
test("a template preview reports its own tier, the organization tier, and the effective total", () => {
  catalog.putSkillRevision({ files: [md("Ctx Tier", "a skill the template brings")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Ctx Org", "a skill every conversation already loads")], ownerKind: "local" });
  catalog.upsertTemplate({ slug: "ctx", name: "Ctx", skills: ["ctx-tier"] });
  const before = getOrgAccessGrants().skills || [];
  saveSettings({ accessGrants: { skills: ["ctx-org"] } });
  try {
    const preview = templates.previewTemplate("ctx", {});
    assert.equal(preview.context.tier, preview.profile.contextTokens, "the template's own estimate is still there, labelled");
    assert.ok(preview.context.tier > 0 && preview.context.organization > 0);
    assert.equal(preview.context.effective, preview.context.tier + preview.context.organization, "both tiers are always on");
    assert.deepEqual(preview.context.names.sort(), ["ctx-org", "ctx-tier"], "the effective total is the union, dependencies included");

    // A skill the template shares with the organization tier is loaded once, so it is counted once.
    catalog.upsertTemplate({ slug: "ctx", name: "Ctx", skills: ["ctx-tier", "ctx-org"] });
    const shared = templates.previewTemplate("ctx", {});
    assert.equal(shared.context.effective, shared.context.tier, "no double counting");
  } finally {
    saveSettings({ accessGrants: { skills: before } });
  }
});

// ── usage ────────────────────────────────────────────────────────────────────────────────────

test("usage recorder: Claude's Skill tool is exact, a SKILL.md read is inferred, deduped per run; the report lists never-used grants", () => {
  catalog.putSkillRevision({ files: [md("Used Skill", "fires")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Idle Skill", "never fires")], ownerKind: "local" });
  const rec = usage.createSkillUsageRecorder({ channelSlug: "usage-ch", conversationId: "C_USAGE", userId: "U1", engine: "claude", sessionId: "s1", runId: "r1", origin: "slack_foreground" });
  rec.onEvent({ kind: "tool_use", name: "Read", target: "SKILL.md", path: "/work/.claude/skills/used-skill/SKILL.md" });
  rec.onEvent({ kind: "tool_use", name: "Skill", target: "Used Skill" });
  rec.onEvent({ kind: "tool_use", name: "Skill", target: "Used Skill" });
  rec.onEvent({ kind: "tool_use", name: "Bash", target: "cat x" , path: "" });
  rec.onEvent({ kind: "tool_use", name: "cat .agents/skills/project-only/SKILL.md" });
  rec.onEvent({ kind: "tool_use", name: "Read", path: "/work/.claude/skills/used-skill/references/a.md" });
  assert.equal(rec.seen().get("used-skill"), "exact");
  assert.equal(rec.seen().get("project-only"), "inferred");
  assert.equal(toolTarget("Skill", { skill: "Used Skill", args: "" }), "Used Skill");
  const report = usage.skillUsageReport({ channelSlug: "usage-ch", days: 7, grants: ["used-skill", "idle-skill"] });
  const used = report.used.find((u) => u.slug === "used-skill");
  assert.equal(used.exact, 1);
  assert.equal(used.inferred, 1, "the first (inferred) read and the later exact call are both kept — different signals");
  assert.deepEqual(report.neverUsed.map((n) => n.slug), ["idle-skill"]);
  assert.equal(report.used.find((u) => u.slug === "project-only").inCatalog, false);
  assert.deepEqual(report.channels.map((c) => c.channelSlug), ["usage-ch"]);
  assert.equal(report.channels[0].total, 3, "channel rollups preserve both exact and inferred signals");
});

test("usage recorder: Claude's plugin-qualified skill name attributes to the catalog skill", () => {
  catalog.putSkillRevision({ files: [md("Plugin Skill", "fires through a plugin")], ownerKind: "local" });
  const rec = usage.createSkillUsageRecorder({ channelSlug: "usage-plugin", conversationId: "C_USAGE_PLUGIN", userId: "U1", engine: "claude", sessionId: "s2", runId: "r2", origin: "slack_foreground" });
  rec.onEvent({ kind: "tool_use", name: "Skill", target: "gateway-shared-skills:plugin-skill" });
  rec.onEvent({ kind: "tool_use", name: "Skill", target: "some-plugin:not-in-catalog" });
  assert.equal(rec.seen().get("plugin-skill"), "exact", "the plugin prefix is stripped before the catalog lookup");
  assert.equal(rec.seen().get("not-in-catalog"), "exact", "an unmatched plugin skill still records under its bare slug");
  const report = usage.skillUsageReport({ channelSlug: "usage-plugin", days: 7, grants: ["plugin-skill"] });
  const used = report.used.find((u) => u.slug === "plugin-skill");
  assert.equal(used.inCatalog, true, "the row carries the catalog slug, not the qualified name");
  assert.equal(used.exact, 1);
  assert.equal(report.used.find((u) => u.slug === "not-in-catalog").inCatalog, false);
  assert.deepEqual(report.neverUsed, []);
  const rows = [];
  const spy = usage.createSkillUsageRecorder({ engine: "claude", record: (row) => rows.push(row) });
  spy.onEvent({ kind: "tool_use", name: "Skill", target: "gateway-shared-skills:plugin-skill" });
  assert.equal(rows[0].slug, "plugin-skill");
  assert.equal(rows[0].signal, "exact");
  assert.ok(rows[0].skillId, "the row carries the catalog skill id (was NULL for every Claude run)");
  assert.ok(rows[0].revisionId, "…and the effective revision id");
  assert.equal(usage.unqualifySkillName("plain-slug"), "", "an unqualified name is left alone");
});

// The exact shape a Codex run produced when a granted skill's read went unrecorded: ONE
// `bash -lc` line that reads the always-on guide first and the granted skill second. The matcher
// stopped at the first hit, so the guide was recorded and the granted skill — the reason the run
// happened at all — was not.
test("usage recorder: one compound Codex shell command records EVERY skill it reads", () => {
  catalog.putSkillRevision({ files: [md("Compound Guide", "the always-on guide")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Compound Granted", "the granted skill")], ownerKind: "local" });
  const folder = "/home/agent/ChannelGate/slack/compound-usage";
  const command = `sed -n '1,240p' ${folder}/.claude/skills/compound-guide/SKILL.md && sed -n '1,320p' ${folder}/.claude/skills/compound-granted/SKILL.md`;
  const mapped = progressFromCodexEvent({ type: "item.started", item: { id: "item_1", type: "command_execution", command } });
  assert.equal(mapped.event.kind, "tool_use");
  assert.equal(mapped.event.name, command, "Codex carries the whole shell line as the tool name");

  const rows = [];
  const rec = usage.createSkillUsageRecorder({ channelSlug: "compound-usage", engine: "codex", runId: "r-compound", record: (row) => rows.push(row) });
  rec.onEvent(mapped.event);
  assert.deepEqual(rows.map((r) => r.slug).sort(), ["compound-granted", "compound-guide"], "both reads are recorded, not just the first");
  assert.ok(rows.every((r) => r.signal === "inferred"), "a shell read stays an inferred signal");
  assert.ok(rows.every((r) => r.skillId && r.revisionId), "each row attributes to the catalog skill and its effective revision");
  assert.equal(rec.seen().get("compound-granted"), "inferred");
});

test("usage recorder: a SKILL.md read is caught through either skills dir, quoted, ~-relative, or mid-command", () => {
  const shapes = [
    ["wc -l .claude/skills/wc-a/SKILL.md .claude/skills/wc-b/SKILL.md", ["wc-a", "wc-b"]],
    ['cat "$HOME/ChannelGate/slack/x/.agents/skills/quoted-skill/SKILL.md"', ["quoted-skill"]],
    ["sed -n '1,80p' ~/.claude/skills/tilde-skill/SKILL.md; rg '^#' '.agents/skills/symlinked-skill/SKILL.md'", ["tilde-skill", "symlinked-skill"]],
    ["cd /w && cat skills/relative-skill/SKILL.md | head -40", ["relative-skill"]],
    ["cat myskills/not-a-skill/SKILL.md", []],
    ["cat .claude/skills/dup-skill/SKILL.md .claude/skills/dup-skill/SKILL.md", ["dup-skill"]],
  ];
  for (const [command, expected] of shapes) {
    assert.deepEqual(usage.skillSlugsFromText(command), expected, command);
  }
  assert.equal(usage.skillSlugFromText(shapes[0][0]), "wc-a", "the single-slug helper still answers with the first one");
});

test("chat verb: add_channel_skills reports the over-cap warning to the person who caused it", async () => {
  const entry = await upsertChannelEntry("C_SKILL_WARN", { name: "skill-warn", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_SKILL_WARN", name: "skill-warn", type: "channel", isDM: false }));
  catalog.putSkillRevision({ files: [md("Warn Heavy", "a heavy always-on description that eats the budget")], ownerKind: "local" });
  const before = getSettings().skillsContextWarnTokens;
  saveSettings({ skillsContextWarnTokens: 1 });
  try {
    const tools = new Map();
    skillTools.register({ registerTool: (name, _def, handler) => tools.set(name, handler) }, {
      channelId: "C_SKILL_WARN",
      slug: entry.slug,
      createdBy: "U_SKILL_WARN",
      text: (body) => ({ content: [{ type: "text", text: body }] }),
      requireAdmin: async () => true,
      requireManage: async () => true,
      loadMeta: async () => getChannelMeta(entry.slug),
    });
    const reply = (await tools.get("add_channel_skills")({ slugs: ["warn-heavy"] })).content.map((c) => c.text).join("\n");
    assert.match(reply, /Granted here: `warn-heavy`/);
    assert.match(reply, /always-on skill descriptions cost about \d+ tokens per turn \(soft cap 1\)/, "the warning reaches the reply instead of being computed and dropped");
    const projected = Number(reply.match(/Always-on context now ~(\d+) tokens/)[1]);
    assert.match(reply, /Current before grant: ~0 tokens/);
    assert.ok(reply.includes(`projected next message: ~${projected} tokens (soft cap 1)`));
    const repeated = (await tools.get("add_channel_skills")({ slugs: ["warn-heavy"] })).content.map((c) => c.text).join("\n");
    assert.ok(repeated.includes(`Current before grant: ~${projected} tokens; projected next message: ~${projected} tokens`));
  } finally {
    saveSettings({ skillsContextWarnTokens: before });
  }
});


// ── authoring + proposals ────────────────────────────────────────────────────────────────────

test("authoring: create grants here with dependencies, update merges files, source-owned skills need a proposal that pins an override", async () => {
  const entry = await upsertChannelEntry("C_SKILLS_AUTH", { name: "skills-auth", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_SKILLS_AUTH", name: "skills-auth", type: "channel", isDM: false }));
  catalog.putSkillRevision({ files: [md("Auth Dep", "a dependency")], ownerKind: "local" });
  const created = await authoring.createLocalSkill({ files: [md("Auth New", "new skill", "requires: [auth-dep]\n"), { path: "references/r.md", content: "r" }], createdBy: "U_AUTHOR", grantTo: entry.slug });
  assert.equal(created.skill.slug, "auth-new");
  assert.deepEqual(created.granted.added, ["auth-new"], "only the skill itself is stored as a grant");
  assert.deepEqual(created.granted.dependencies, [{ slug: "auth-dep", requiredBy: ["auth-new"] }], "its dependency is reported, not stored");
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, ["auth-new"]);
  await assert.rejects(authoring.createLocalSkill({ files: [md("Auth New", "dup")], createdBy: "U2" }), /already exists/);

  const updated = await authoring.updateLocalSkill({ skill: catalog.getSkill("auth-new"), files: [{ path: "references/more.md", content: "more" }], remove: ["references/r.md"], createdBy: "U_AUTHOR" });
  assert.deepEqual(catalog.revisionFiles(updated.revision.id).map((f) => f.path), ["SKILL.md", "references/more.md"], "partial files merge over the current revision");

  const src = catalog.addSource({ kind: "git", url: "https://github.com/example/owned", mode: "auto" });
  catalog.putSkillRevision({ files: [md("Upstream", "upstream v1")], ownerKind: "git", sourceId: src.id, status: "active", sourceRef: "u1" });
  await assert.rejects(authoring.updateLocalSkill({ skill: catalog.getSkill("upstream"), files: [md("Upstream", "hacked")] }), /proposal/);
  const { proposal } = authoring.proposeSkillChange({ skill: "upstream", files: [md("Upstream", "improved locally")], note: "typo fix", proposedBy: "U2", channelSlug: entry.slug });
  assert.equal(proposal.status, "pending");
  assert.throws(() => authoring.proposeSkillChange({ skill: "ghost", kind: "promote", note: "x" }), /not in the catalog/);
  const decided = await authoring.decideSkillProposal(proposal.id, { decision: "approve", decidedBy: "U_ADMIN" });
  assert.equal(decided.pinned, true, "an approved change to a source-owned skill is a pinned override");
  assert.equal(decided.proposal.status, "approved");
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("upstream")).id, decided.revision.id);
  // Upstream keeps flowing into new revisions, but the pin holds until an admin unpins.
  catalog.putSkillRevision({ files: [md("Upstream", "upstream v2")], ownerKind: "git", sourceId: src.id, status: "active", sourceRef: "u2" });
  assert.equal(catalog.effectiveRevisionFor(catalog.getSkill("upstream")).id, decided.revision.id);
  await assert.rejects(authoring.decideSkillProposal(proposal.id, { decision: "reject" }), /already approved/);

  // Promotion grants organization-wide (settings accessGrants).
  saveSettings({ accessGrants: { skills: [] } });
  const promo = authoring.proposeSkillChange({ skill: "auth-new", kind: "promote", note: "everyone needs it", proposedBy: "U2" });
  const promoted = await authoring.decideSkillProposal(promo.proposal.id, { decision: "approve", decidedBy: "U_ADMIN" });
  assert.equal(promoted.promoted, true);
  assert.deepEqual(getOrgAccessGrants().skills, ["auth-new"], "the organization tier holds the promoted skill, not its dependency");
  assert.deepEqual(resolve.resolveSkillProfile(getOrgAccessGrants().skills).slugs, ["auth-new", "auth-dep"], "the dependency still resolves into the profile");
  const rejected = await authoring.decideSkillProposal(authoring.proposeSkillChange({ skill: "auth-new", files: [md("Auth New", "no")], note: "n", proposedBy: "U3" }).proposal.id, { decision: "reject", decidedBy: "U_ADMIN", note: "not needed" });
  assert.equal(rejected.proposal.status, "rejected");
  assert.equal(rejected.proposal.decisionNote, "not needed");
  const revoked = await authoring.revokeSkillsFromChannel(entry.slug, ["Auth New"]);
  assert.deepEqual(revoked.removed, ["auth-new"], "revoke resolves a name to its slug");
});

// A grant list is a list of GRANTS. `requires:` dependencies are resolved at materialization and
// in every profile (docs/SKILLS.md), so they must never be written into a stored grant list: doing
// so turned a dependency into a direct channel/user/organization grant, lost the "required by …"
// attribution in the skills and usage views, and stranded the dependency when its parent was
// revoked.
test("granting stores only what was granted: a dependency keeps its provenance, materializes with its parent and leaves with it", async () => {
  const root = tempDir("cg-skills-prov-");
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  const entry = await upsertChannelEntry("C_GRANT_PROV", { name: "grant-prov", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_GRANT_PROV", name: "grant-prov", type: "channel", isDM: false }));
  catalog.putSkillRevision({ files: [md("Prov Parent", "the granted skill", "requires: [prov-dep]\n")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Prov Dep", "what it requires")], ownerKind: "local" });

  // The chat-verb / admin-API path (grantSkillsToChannel is what both call).
  const granted = await authoring.grantSkillsToChannel(entry.slug, ["Prov Parent"]);
  assert.deepEqual(granted.added, ["prov-parent"], "the name resolves to its slug");
  assert.deepEqual(granted.dependencies, [{ slug: "prov-dep", requiredBy: ["prov-parent"] }], "the dependency is reported to the caller");
  assert.deepEqual(granted.names, ["prov-parent"]);
  const meta = await getChannelMeta(entry.slug);
  assert.deepEqual(meta.skills, ["prov-parent"], "and never written into channel_meta.skills");
  assert.deepEqual(templates.channelSkillGrants(meta), ["prov-parent"], "nor into the channel tier the grant union takes");

  // So the profile still attributes it — "required by prov-parent", not "added to this channel".
  const profile = resolve.resolveSkillProfile(templates.channelSkillGrants(meta));
  assert.deepEqual(profile.slugs, ["prov-parent", "prov-dep"]);
  assert.equal(profile.active.find((e) => e.slug === "prov-dep").via, "dependency");
  assert.deepEqual(profile.active.find((e) => e.slug === "prov-dep").requiredBy, ["prov-parent"]);
  const report = usage.skillUsageReport({ channelSlug: entry.slug, grants: templates.channelSkillGrants(meta) });
  assert.deepEqual(report.neverUsed.find((n) => n.slug === "prov-dep"), { slug: "prov-dep", name: "Prov Dep", via: "dependency", requiredBy: ["prov-parent"] }, "the usage view keeps the attribution too");

  // Materialization resolves the dependency anyway: nothing that used to be written stops being written.
  assert.deepEqual((await enableSkills(skillsDir, meta.skills)).enabled.sort(), ["prov-dep", "prov-parent"]);

  // Removing the dependency is not a removal: it is required by a skill that stays granted.
  const dropDep = await authoring.revokeSkillsFromChannel(entry.slug, ["prov-dep"]);
  assert.deepEqual(dropDep.removed, []);
  assert.deepEqual(dropDep.stillRequired, [{ slug: "prov-dep", requiredBy: ["prov-parent"] }]);
  assert.deepEqual(dropDep.names, ["prov-parent"]);

  // Removing the parent takes the dependency with it — no stranded grant, and the folder is pruned.
  const dropParent = await authoring.revokeSkillsFromChannel(entry.slug, ["prov-parent"]);
  assert.deepEqual(dropParent.removed, ["prov-parent"]);
  assert.deepEqual(dropParent.names, []);
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, [], "the dependency is not left behind as a channel grant");
  assert.deepEqual((await enableSkills(skillsDir, (await getChannelMeta(entry.slug)).skills)).enabled, []);
  await assert.rejects(lstat(path.join(skillsDir, "prov-dep")), { code: "ENOENT" });

  // An EXPLICIT grant of the dependency is a grant like any other and survives its parent's removal.
  await authoring.grantSkillsToChannel(entry.slug, ["prov-dep", "prov-parent"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, ["prov-dep", "prov-parent"]);
  await authoring.revokeSkillsFromChannel(entry.slug, ["prov-parent"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, ["prov-dep"], "what was granted on its own stays granted");

  // The user and organization tiers use the same helper and behave the same way.
  await setUser("U_PROV", { name: "Prov", skills: [] });
  const mine = await authoring.grantSkillsToUser("U_PROV", ["prov-parent"]);
  assert.deepEqual(mine.names, ["prov-parent"]);
  assert.deepEqual(mine.dependencies.map((d) => d.slug), ["prov-dep"]);
  assert.deepEqual((await getUser("U_PROV")).skills, ["prov-parent"]);
  saveSettings({ accessGrants: { skills: [] } });
  assert.deepEqual(authoring.grantSkillsToOrg(["prov-parent"]).names, ["prov-parent"]);
  assert.deepEqual(getOrgAccessGrants().skills, ["prov-parent"]);
});
