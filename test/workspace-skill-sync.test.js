import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile, readlink, symlink, lstat } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { ensureChannelFolder, workspaceSkillBackupDir } = await import("../src/gateway/folders.js");
const { ensureCodexSkillsLink } = await import("../src/gateway/library-skills.js");
const { saveSettings } = await import("../src/config/settings.js");
const { putSkillRevision } = await import("../src/gateway/skills/catalog.js");
const { workspaceFolder } = await import("../src/config/paths.js");

function catalog(slug, text) {
  return putSkillRevision({ slug, files: [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Test fixture\n---\n${text}\n` }], ownerKind: "local", status: "active" });
}
const exists = async (file) => Boolean(await lstat(file).catch(() => null));

// API saves supply raw channel metadata, whereas runs used to premerge organization grants.
test("raw metadata mirrors organization plus channel grants, replaces local copies and repairs drift", async () => {
  catalog("mirror-org", "Organization instructions");
  catalog("mirror-channel", "Channel instructions");
  saveSettings({ accessGrants: { skills: ["mirror-org"] } });
  try {
    const slug = "mirror-shared";
    const cwd = workspaceFolder(slug);
    const skillsDir = path.join(cwd, ".claude", "skills");
    await mkdir(path.join(skillsDir, "mirror-channel"), { recursive: true });
    await writeFile(path.join(skillsDir, "mirror-channel", "SKILL.md"), "Local draft\n");
    await mkdir(path.join(skillsDir, "unselected"));
    await writeFile(path.join(skillsDir, "unselected", "SKILL.md"), "Unselected draft\n");
    const meta = { skills: ["mirror-channel"], memory: false };
    await ensureChannelFolder(slug, meta);
    assert.deepEqual((await readdir(skillsDir)).sort(), ["gateway-usage", "mirror-channel", "mirror-org"]);
    assert.match(await readFile(path.join(skillsDir, "mirror-channel", "SKILL.md"), "utf8"), /Channel instructions/);
    const backupDir = workspaceSkillBackupDir(cwd);
    const archived = await readdir(backupDir);
    for (const [name, text] of [["mirror-channel", "Local draft\n"], ["unselected", "Unselected draft\n"]]) {
      assert.equal(await readFile(path.join(backupDir, archived.find((entry) => entry.startsWith(`${name}-`)), "SKILL.md"), "utf8"), text);
    }
    await writeFile(path.join(skillsDir, "mirror-channel", "SKILL.md"), "Changed outside gateway\n");
    await ensureChannelFolder(slug, meta);
    assert.match(await readFile(path.join(cwd, ".agents", "skills", "mirror-channel", "SKILL.md"), "utf8"), /Channel instructions/);
    await ensureChannelFolder(slug, { ...meta, skills: [] });
    assert.equal(await exists(path.join(skillsDir, "mirror-channel")), false);
    assert.equal(await exists(path.join(skillsDir, "mirror-org")), true);
  } finally { saveSettings({ accessGrants: { skills: [] } }); }
});

test("clean mode keeps the real project current and excludes optional skills only from the clean run", async () => {
  const slug = "mirror-clean";
  catalog("clean-project", "Project skill");
  const result = await ensureChannelFolder(slug, { cleanMode: true, skills: ["clean-project"], memory: false });
  assert.equal(await exists(path.join(result.cwd, ".claude", "skills", "clean-project")), false);
  assert.equal(await exists(path.join(workspaceFolder(slug), ".agents", "skills", "clean-project", "SKILL.md")), true);
});

test("authoritative Codex alias archives conflicting directories and symlink parents without following them", async () => {
  for (const parentLink of [false, true]) {
    const root = path.join(scratch, `alias-${parentLink}`);
    const outside = path.join(scratch, `outside-${parentLink}`);
    const backupDir = path.join(scratch, `alias-backup-${parentLink}`);
    await mkdir(path.join(root, ".claude", "skills"), { recursive: true });
    if (parentLink) {
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "untouched"), "outside");
      await symlink(outside, path.join(root, ".agents"));
    } else {
      await mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      await writeFile(path.join(root, ".agents", "skills", "local.txt"), "local");
      await writeFile(path.join(root, ".agents", "other.txt"), "other");
    }
    assert.equal(await ensureCodexSkillsLink(root, { authoritative: true, backupDir }), true);
    assert.equal(await readlink(path.join(root, ".agents", "skills")), "../.claude/skills");
    assert.equal(await ensureCodexSkillsLink(root, { authoritative: true, backupDir }), false);
    assert.equal((await readdir(backupDir)).length, 1);
    if (parentLink) assert.deepEqual(await readdir(outside), ["untouched"]);
    else assert.equal(await readFile(path.join(root, ".agents", "other.txt"), "utf8"), "other");
  }
});

test("uncatalogued trusted host skills refresh changed bytes instead of retaining the first copy", async () => {
  const source = path.join(scratch, "host-sources");
  const skill = path.join(source, "host-changing");
  const saved = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = source;
  try {
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "Host version one\n");
    const meta = { skills: ["host-changing"], memory: false };
    const { cwd } = await ensureChannelFolder("mirror-host", meta);
    await writeFile(path.join(skill, "SKILL.md"), "Host version two\n");
    await ensureChannelFolder("mirror-host", meta);
    assert.equal(await readFile(path.join(cwd, ".claude", "skills", "host-changing", "SKILL.md"), "utf8"), "Host version two\n");
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_SKILL_SOURCES;
    else process.env.GATEWAY_SKILL_SOURCES = saved;
  }
});
