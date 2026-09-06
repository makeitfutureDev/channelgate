import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, lstat, rm, chmod, symlink, readlink } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { materializeSkill, materializeBundle, pruneManagedSkills, MANAGED_SKILL_MARKER } = await import("../src/gateway/skills/materialize.js");
const { archiveWorkspaceEntry } = await import("../src/gateway/skills/workspace-backup.js");

const bundle = {
  revision: { id: 42, revisionNo: 2, contentHash: "same-catalog-revision", version: "1.0" },
  files: [
    { path: "SKILL.md", content: "---\nname: selected\ndescription: selected skill\n---\nCurrent instructions\n" },
    { path: "references/guide.md", content: "Current reference\n" },
    { path: "scripts/check.sh", content: "#!/bin/sh\ntrue\n", executable: true },
    { path: "assets/pixel.bin", content: Buffer.from([0, 255, 17, 128]) },
  ],
};
const options = { lookup: () => ({ slug: "selected" }), bundleFor: () => bundle };

async function fixture() {
  const root = tempDir("cg-workspace-skills-");
  const skills = path.join(root, ".claude", "skills");
  const backup = path.join(root, "daemon-owned-backups");
  await mkdir(skills, { recursive: true });
  return { root, skills, backup, selected: path.join(skills, "selected") };
}

async function assertCurrent(dir) {
  for (const file of bundle.files) {
    const current = path.join(dir, file.path);
    assert.deepEqual(await readFile(current), Buffer.from(file.content));
    assert.equal((await lstat(current)).mode & 0o7777, file.executable ? 0o755 : 0o644);
  }
}

test("unchanged materialization verifies the actual bundle without rewriting files", async () => {
  const f = await fixture();
  assert.equal((await materializeSkill(f.skills, "selected", options)).state, "written");
  const before = await lstat(path.join(f.selected, "SKILL.md"));
  const treeBefore = await lstat(f.selected);
  assert.equal((await materializeSkill(f.skills, "selected", options)).state, "unchanged");
  const after = await lstat(path.join(f.selected, "SKILL.md"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await lstat(f.selected)).ino, treeBefore.ino);
  await assertCurrent(f.selected);
});

test("same-revision content, deletion, extra files and executable drift are repaired", async (t) => {
  const corruptions = {
    "edited instructions": (f) => writeFile(path.join(f.selected, "SKILL.md"), "stale local body"),
    "missing reference": (f) => rm(path.join(f.selected, "references", "guide.md")),
    "unselected extra file": (f) => writeFile(path.join(f.selected, "extra.md"), "stale"),
    "extra empty directory": (f) => mkdir(path.join(f.selected, "old-directory")),
    "lost script executable bit": (f) => chmod(path.join(f.selected, "scripts", "check.sh"), 0o644),
    "added instruction executable bit": (f) => chmod(path.join(f.selected, "SKILL.md"), 0o755),
    "directory mode drift": (f) => chmod(path.join(f.selected, "references"), 0o700),
    "missing binary asset": (f) => rm(path.join(f.selected, "assets", "pixel.bin")),
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    await t.test(name, async () => {
      const f = await fixture();
      await materializeSkill(f.skills, "selected", options);
      await corrupt(f);
      assert.equal((await materializeSkill(f.skills, "selected", options)).state, "written");
      await assertCurrent(f.selected);
      assert.equal((await materializeSkill(f.skills, "selected", options)).state, "unchanged");
    });
  }
});

test("authoritative materialization archives an unmarked override; ordinary calls preserve it", async () => {
  const f = await fixture();
  await mkdir(f.selected);
  await writeFile(path.join(f.selected, "SKILL.md"), "local project instructions");
  assert.equal((await materializeSkill(f.skills, "selected", options)).state, "project");
  await assert.rejects(materializeSkill(f.skills, "selected", { ...options, authoritative: true }), /backupDir/);
  assert.equal(await readFile(path.join(f.selected, "SKILL.md"), "utf8"), "local project instructions");
  const result = await materializeSkill(f.skills, "selected", { ...options, authoritative: true, backupDir: f.backup });
  assert.equal(result.state, "written");
  await assertCurrent(f.selected);
  const archived = await readdir(f.backup);
  assert.equal(archived.length, 1);
  assert.equal((await lstat(f.backup)).mode & 0o777, 0o700);
  assert.equal(await readFile(path.join(f.backup, archived[0], "SKILL.md"), "utf8"), "local project instructions");
});

test("authoritative pruning removes obsolete nodes, retains requested built-ins and archives local entries", async () => {
  const f = await fixture();
  await materializeSkill(f.skills, "selected", options);
  for (const name of ["local-obsolete", "gateway-usage", "channel-memory"]) {
    await mkdir(path.join(f.skills, name));
    await writeFile(path.join(f.skills, name, "SKILL.md"), name);
  }
  await writeFile(path.join(f.skills, "loose-file"), "local data");
  const outside = path.join(f.root, "external");
  await mkdir(outside);
  await writeFile(path.join(outside, "SKILL.md"), "external instructions");
  await symlink(outside, path.join(f.skills, "obsolete-link"));
  assert.equal(await pruneManagedSkills(f.skills, ["gateway-usage", "channel-memory"], { authoritative: true, backupDir: f.backup }), 4);
  assert.deepEqual((await readdir(f.skills)).sort(), ["channel-memory", "gateway-usage"]);
  const archived = await readdir(f.backup);
  assert.equal(archived.length, 3);
  const link = archived.find((name) => name.startsWith("obsolete-link-"));
  assert.equal(await readlink(path.join(f.backup, link)), outside);
  assert.equal(await readFile(path.join(outside, "SKILL.md"), "utf8"), "external instructions");
});

test("legacy pruning preserves unmarked folders and symlinks", async () => {
  const f = await fixture();
  await mkdir(f.selected);
  await writeFile(path.join(f.selected, "SKILL.md"), "local");
  await symlink(f.selected, path.join(f.skills, "project-link"));
  assert.equal(await pruneManagedSkills(f.skills, []), 0);
  assert.deepEqual((await readdir(f.skills)).sort(), ["project-link", "selected"]);
});

test("same-revision planted file and directory symlinks are repaired without touching their targets", async (t) => {
  for (const relative of ["SKILL.md", "references", ".gateway-skill.json", MANAGED_SKILL_MARKER]) {
    await t.test(relative, async () => {
      const f = await fixture();
      await materializeSkill(f.skills, "selected", options);
      const external = path.join(f.root, "outside");
      await mkdir(external);
      await writeFile(path.join(external, "guide.md"), "external reference");
      const target = relative === "references" ? external : path.join(external, "guide.md");
      await rm(path.join(f.selected, relative), { recursive: true, force: true });
      await symlink(target, path.join(f.selected, relative));
      const result = await materializeSkill(f.skills, "selected", { ...options, authoritative: true, backupDir: f.backup });
      assert.equal(result.state, "written");
      await assertCurrent(f.selected);
      assert.equal(await readFile(path.join(external, "guide.md"), "utf8"), "external reference");
      assert.equal((await materializeSkill(f.skills, "selected", options)).state, "unchanged");
    });
  }
});

test("a same-name directory symlink is archived as a link, not traversed", async () => {
  const f = await fixture();
  const external = path.join(f.root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "SKILL.md"), "external skill");
  await symlink(external, f.selected);
  assert.equal((await materializeSkill(f.skills, "selected", { ...options, authoritative: true, backupDir: f.backup })).state, "written");
  assert.equal((await lstat(f.selected)).isDirectory(), true);
  assert.equal(await readFile(path.join(external, "SKILL.md"), "utf8"), "external skill");
  const archived = await readdir(f.backup);
  assert.equal(await readlink(path.join(f.backup, archived[0])), external);
});

test("invalid source bundles fail before the local skill is archived or removed", async (t) => {
  for (const files of [
    [{ path: "../outside", content: "bad" }],
    [{ path: "SKILL.md", content: "x" }, { path: "refs", content: "file" }, { path: "refs/nested.md", content: "collision" }],
  ]) {
    await t.test(files[0].path + files.length, async () => {
      const f = await fixture();
      await mkdir(f.selected);
      await writeFile(path.join(f.selected, "SKILL.md"), "local original");
      await assert.rejects(materializeSkill(f.skills, "selected", { ...options, bundleFor: () => ({ ...bundle, files }), authoritative: true, backupDir: f.backup }));
      assert.equal(await readFile(path.join(f.selected, "SKILL.md"), "utf8"), "local original");
      await assert.rejects(lstat(f.backup), { code: "ENOENT" });
    });
  }
});

test("a symlinked discovery root or parent cannot redirect materialization", async () => {
  const f = await fixture();
  const external = path.join(f.root, "external");
  await mkdir(external);
  await rm(f.skills, { recursive: true });
  await symlink(external, f.skills);
  await assert.rejects(materializeBundle(f.skills, "selected", bundle), /ENOTDIR|ELOOP/);
  assert.deepEqual(await readdir(external), []);
});

test("archive rejects a discovery-tree target and a symlinked backup parent", async () => {
  const f = await fixture();
  await mkdir(f.selected);
  await writeFile(path.join(f.selected, "SKILL.md"), "local");
  await assert.rejects(archiveWorkspaceEntry(f.selected, path.join(f.skills, "backup")), /outside/);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, f.backup);
  await assert.rejects(archiveWorkspaceEntry(f.selected, f.backup), /ENOTDIR|ELOOP/);
  assert.equal(await readFile(path.join(f.selected, "SKILL.md"), "utf8"), "local");
  assert.deepEqual(await readdir(outside), []);
});

test("archiving a conflicting engine container permits daemon backups under the same home workDir", async () => {
  const home = tempDir("cg-workspace-home-backup-");
  const backup = path.join(home, ".channelgate", "skill-backups", "fixture");
  const external = path.join(home, "external");
  await mkdir(external);
  await writeFile(path.join(external, "untouched"), "external data");
  for (const container of [".claude", ".agents"]) {
    const entry = path.join(home, container);
    await symlink(external, entry);
    const archived = await archiveWorkspaceEntry(entry, backup);
    assert.equal(await readlink(archived), external);
    await assert.rejects(lstat(entry), { code: "ENOENT" });
  }
  assert.deepEqual(await readdir(external), ["untouched"]);
});

test("backups cannot be placed in another engine's skill discovery tree", async () => {
  const f = await fixture();
  await mkdir(f.selected);
  await assert.rejects(archiveWorkspaceEntry(f.selected, path.join(f.root, ".agents", "skills", "backup")), /outside/);
  await assert.rejects(archiveWorkspaceEntry(f.selected, path.join(f.root, ".codex", "skills", "backup")), /outside/);
  assert.equal((await lstat(f.selected)).isDirectory(), true);
});

test("cross-device archives copy complete directories and preserve symlink nodes", async (t) => {
  const f = await fixture();
  await mkdir(path.join(f.selected, "scripts"), { recursive: true });
  await writeFile(path.join(f.selected, "scripts", "run.sh"), "original script", { mode: 0o755 });
  await symlink("scripts/run.sh", path.join(f.selected, "local-link"));
  // Exercise the EXDEV fallback deterministically without requiring a second host mount.
  t.mock.method(fsPromises, "rename", async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const archived = await archiveWorkspaceEntry(f.selected, f.backup);
  assert.equal(await readFile(path.join(archived, "scripts", "run.sh"), "utf8"), "original script");
  assert.equal((await lstat(path.join(archived, "scripts", "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readlink(path.join(archived, "local-link")), "scripts/run.sh");
  await assert.rejects(lstat(f.selected), { code: "ENOENT" });
});

test("a failed cross-device archive retains the complete original and removes the partial copy", async (t) => {
  const f = await fixture();
  await mkdir(f.selected);
  await writeFile(path.join(f.selected, "SKILL.md"), "must remain available");
  t.mock.method(fsPromises, "rename", async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); });
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, "open", async (file, ...args) => {
    if (String(file).endsWith("/SKILL.md")) throw Object.assign(new Error("fixture unreadable"), { code: "EACCES" });
    return originalOpen(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(archiveWorkspaceEntry(f.selected, f.backup), { code: "EACCES" });
  assert.equal(await readFile(path.join(f.selected, "SKILL.md"), "utf8"), "must remain available");
  assert.deepEqual(await readdir(f.backup), []);
});
