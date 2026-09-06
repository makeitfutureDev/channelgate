import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { saveChannelMeta, defaultChannelMeta, upsertChannelEntry, patchChannelMeta, setUser } = await import("../src/config/store.js");
const { workspaceFolder } = await import("../src/config/paths.js");
const { createLocalSkill, updateLocalSkill, grantSkillsToChannel, revokeSkillsFromChannel } = await import("../src/gateway/skills/authoring.js");
const { upsertTemplate } = await import("../src/gateway/skills/catalog.js");
const { assignTemplateToChannel } = await import("../src/gateway/skills/templates.js");
const { syncWorkspaceSkills, syncWorkspaceSkillsOrThrow, startWorkspaceSkillSync } = await import("../src/gateway/skills/workspace-sync.js");
const quiet = () => {};
const files = (slug, version) => [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Workspace revision ${version}\n---\n\nRevision ${version}\n` }];

async function channel(id, patch = {}) {
  const name = id.toLowerCase();
  const entry = await upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name, type: "channel", isDM: false }), ...patch });
  return entry;
}

test("daemon reconciliation writes changed revisions and removes revoked grants without an engine run", async () => {
  const entry = await channel("C_WORKSPACE_SYNC");
  const authored = await createLocalSkill({ slug: "workspace-sync", files: files("workspace-sync", 1), publish: false });
  await grantSkillsToChannel(entry.slug, [authored.skill.slug]);
  const timer = startWorkspaceSkillSync({ intervalMs: 60_000, log: quiet });
  try {
    assert.equal((await timer.runNow()).ok, true);
    const file = path.join(workspaceFolder(entry.slug), ".claude", "skills", authored.skill.slug, "SKILL.md");
    assert.match(await readFile(file, "utf8"), /Revision 1/);
    assert.equal((await timer.runNow()).unchanged, true);

    await updateLocalSkill({ skill: authored.skill, files: files("workspace-sync", 2), publish: false });
    assert.equal((await timer.runNow()).unchanged, false);
    assert.match(await readFile(file, "utf8"), /Revision 2/);

    await revokeSkillsFromChannel(entry.slug, [authored.skill.slug]);
    assert.equal((await timer.runNow()).ok, true);
    await assert.rejects(access(file), { code: "ENOENT" });
  } finally {
    timer.stop();
  }
});

test("template edits converge and personal user grants never enter the shared folder", async () => {
  const entry = await channel("C_WORKSPACE_TEMPLATE");
  const shared = await createLocalSkill({ slug: "workspace-shared", files: files("workspace-shared", 1), publish: false });
  const personal = await createLocalSkill({ slug: "workspace-personal", files: files("workspace-personal", 1), personal: true, createdBy: "U_PRIVATE", publish: false });
  await setUser("U_PRIVATE", { skills: [personal.skill.slug] });
  upsertTemplate({ slug: "workspace-template", name: "Workspace template", skills: [shared.skill.slug] });
  await assignTemplateToChannel(entry.slug, "workspace-template");
  assert.equal((await syncWorkspaceSkills({ force: false, log: quiet })).ok, true);
  const skills = path.join(workspaceFolder(entry.slug), ".claude", "skills");
  assert.match(await readFile(path.join(skills, shared.skill.slug, "SKILL.md"), "utf8"), /Revision 1/);
  await assert.rejects(access(path.join(skills, personal.skill.slug)), { code: "ENOENT" });
  upsertTemplate({ slug: "workspace-template", name: "Workspace template", skills: [] });
  assert.equal((await syncWorkspaceSkills({ force: false, log: quiet })).unchanged, false);
  await assert.rejects(access(path.join(skills, shared.skill.slug)), { code: "ENOENT" });
});

test("conflicting shared folders fail before replacement, and unchanged failures retry after repair", async () => {
  const root = tempDir("cg-workspace-collision-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  const sentinel = path.join(workDir, ".claude", "skills", "sentinel", "SKILL.md");
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "Keep until conflict is resolved");
  const a = await channel("C_WORKSPACE_COLLISION_A", { workDir, skills: ["workspace-shared"] });
  const b = await channel("C_WORKSPACE_COLLISION_B", { workDir, skills: [] });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await syncWorkspaceSkills({ force: false, log: quiet });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failed.map((item) => item.slug).sort(), [a.slug, b.slug].sort());
      assert.match(result.failed[0].error, /different shared skill grants/);
      assert.equal(await readFile(sentinel, "utf8"), "Keep until conflict is resolved");
    }
    await assert.rejects(syncWorkspaceSkillsOrThrow({ log: quiet }), (error) => {
      assert.equal(error.code, "workspace_sync_failed");
      assert.equal(error.saved, true);
      assert.match(error.message, /^Saved, but workspace skills/);
      return true;
    });
    await patchChannelMeta(b.slug, { skills: ["workspace-shared"] });
    const recovered = await syncWorkspaceSkills({ force: false, log: quiet });
    assert.equal(recovered.ok, true);
    assert.match(await readFile(path.join(workDir, ".claude", "skills", "workspace-shared", "SKILL.md"), "utf8"), /Revision 1/);
  } finally {
    await patchChannelMeta(a.slug, { workDir: "" });
    await patchChannelMeta(b.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("a running reconciliation timer observes grant changes while no chat run is active", async () => {
  const entry = await channel("C_WORKSPACE_TIMER");
  await syncWorkspaceSkills({ log: quiet });
  const file = path.join(workspaceFolder(entry.slug), ".claude", "skills", "workspace-shared", "SKILL.md");
  const timer = startWorkspaceSkillSync({ intervalMs: 20, log: quiet });
  try {
    await grantSkillsToChannel(entry.slug, ["workspace-shared"]);
    const deadline = Date.now() + 3000;
    let found = false;
    while (!found && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      found = await access(file).then(() => true, () => false);
    }
    assert.equal(found, true, "the timer materializes the grant before any engine spawn");
  } finally {
    timer.stop();
  }
});
