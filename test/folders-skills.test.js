import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureTestEnv } from "./helpers.js";

// The grant materializer resolves names against the skill catalog (SQLite), so the scratch
// gateway root must be pinned BEFORE folders.js is imported — never the real ~/.channelgate.
ensureTestEnv();
const { ensureCodexSkillsLink } = await import("../src/gateway/library-skills.js");
const { enableSkills } = await import("../src/gateway/folders.js");

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cg-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Codex skill discovery symlinks .agents/skills to the canonical Claude skill tree", async (t) => {
  const root = await tempDir(t);
  const skillDir = path.join(root, ".claude", "skills", "gateway-usage");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# Gateway usage\n");

  assert.equal(await ensureCodexSkillsLink(root), true);

  const link = path.join(root, ".agents", "skills");
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readlink(link), path.join("..", ".claude", "skills"));
  assert.equal(await readFile(path.join(link, "gateway-usage", "SKILL.md"), "utf8"), "# Gateway usage\n");
  assert.equal(await ensureCodexSkillsLink(root), false, "re-provisioning is idempotent");
});

test("Codex skill discovery preserves a project-owned .agents/skills directory", async (t) => {
  const root = await tempDir(t);
  const nativeSkill = path.join(root, ".agents", "skills", "native", "SKILL.md");
  await mkdir(path.dirname(nativeSkill), { recursive: true });
  await writeFile(nativeSkill, "# Native project skill\n");

  assert.equal(await ensureCodexSkillsLink(root), false);
  assert.equal((await lstat(path.join(root, ".agents", "skills"))).isDirectory(), true);
  assert.equal(await readFile(nativeSkill, "utf8"), "# Native project skill\n");
});

test("Codex skill discovery does not traverse a project-owned .agents symlink", async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await symlink(outside, path.join(root, ".agents"), "dir");

  assert.equal(await ensureCodexSkillsLink(root), false);
  await assert.rejects(lstat(path.join(outside, "skills")), { code: "ENOENT" });
});

test("revoking managed skills prunes only gateway-owned copies", async (t) => {
  const root = await tempDir(t);
  const skills = path.join(root, ".claude", "skills");
  const owned = path.join(skills, "formerly-granted");
  const project = path.join(skills, "project-owned");
  await mkdir(owned, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(owned, ".gateway-managed-skill"), "gateway-owned\n");
  await writeFile(path.join(owned, "SKILL.md"), "# Old grant\n");
  await writeFile(path.join(project, "SKILL.md"), "# Project skill\n");

  await enableSkills(skills, []);

  await assert.rejects(lstat(owned), { code: "ENOENT" });
  assert.equal(await readFile(path.join(project, "SKILL.md"), "utf8"), "# Project skill\n");
});

test("skill provisioning rejects path-traversal grant names at the filesystem sink", async (t) => {
  const root = await tempDir(t);
  const skills = path.join(root, ".claude", "skills");
  const outside = path.join(root, ".claude", "outside");
  await mkdir(skills, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "SKILL.md"), "# Must remain outside grants\n");

  const result = await enableSkills(skills, ["../outside", "nested/skill", "nested\\skill"]);

  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.missing, []);
  assert.equal(await readFile(path.join(outside, "SKILL.md"), "utf8"), "# Must remain outside grants\n");
});
