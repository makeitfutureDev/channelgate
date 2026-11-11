import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { saveChannelMeta, defaultChannelMeta, upsertChannelEntry, patchChannelMeta, getChannelMeta, listChannels, setUser } = await import("../src/config/store.js");
const { createWorkspaceProjectionReader, workspaceProjection } = await import("../src/config/workspace-links.js");
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

test("a full workspace listing resolves each stored directory only once", () => {
  const rows = Array.from({ length: 256 }, (_, n) => ({
    slug: `projection-${n}`,
    meta: { channelId: `C_PROJECTION_${n}`, workDir: `/fixture/project-${Math.floor(n / 4)}`,
      skills: [`skill-${n}`], allowedUsers: [`U_${n}`], model: `model-${n}`,
      ...(n % 4 === 3 ? { codeChannel: { originSlug: `projection-${n - 3}` } } : {}) },
  }));
  const calls = new Map();
  const read = createWorkspaceProjectionReader(rows, (slug, meta) => {
    calls.set(slug, (calls.get(slug) || 0) + 1);
    assert.equal(meta.cleanMode, false);
    return meta.workDir;
  });
  for (const row of rows) {
    const expected = workspaceProjection(row.slug, row.meta, rows, (_slug, meta) => meta.workDir);
    assert.deepEqual(read(row.slug), expected);
  }
  assert.equal(calls.size, rows.length);
  assert.ok([...calls.values()].every((count) => count === 1), "filesystem work grows with channels, not channel pairs");
  assert.equal(read("missing-channel"), null);
  assert.equal(calls.size, rows.length);
});

test("workspace listing results cannot mutate another linked result or its stored snapshot", () => {
  const rows = [
    { slug: "owner", meta: { workDir: "/shared", skills: ["shared"], allowedUsers: ["U_OWNER"], env: { FIXTURE: { value: "original" } } } },
    { slug: "follower", meta: { workDir: "/shared", skills: [], allowedUsers: [] } },
  ];
  const read = createWorkspaceProjectionReader(rows, (_slug, meta) => meta.workDir);
  const follower = read("follower");
  follower.skills.push("changed");
  follower.allowedUsers.length = 0;
  follower.env.FIXTURE.value = "changed";
  assert.deepEqual(read("owner").skills, ["shared"]);
  assert.deepEqual(read("follower").allowedUsers, ["U_OWNER"]);
  assert.equal(read("follower").env.FIXTURE.value, "original");
  assert.equal(rows[0].meta.env.FIXTURE.value, "original");
});

test("a new workspace listing observes changed directory resolution and owner authorization", () => {
  const rows = [
    { slug: "owner", meta: { workDir: "/shared", access: "approved", allowedUsers: ["U_OWNER"], skills: ["old"] } },
    { slug: "follower", meta: { workDir: "/alias", access: "none", allowedUsers: [], skills: [] } },
  ];
  let aliasTarget = "/shared";
  const resolve = (_slug, meta) => meta.workDir === "/alias" ? aliasTarget : meta.workDir;
  assert.equal(createWorkspaceProjectionReader(rows, resolve)("follower").workspaceLink.slug, "owner");
  const revoked = structuredClone(rows);
  revoked[0].meta.allowedUsers = [];
  revoked[0].meta.access = "none";
  revoked[0].meta.skills = [];
  const restricted = createWorkspaceProjectionReader(revoked, resolve)("follower");
  assert.equal(restricted.access, "none");
  assert.deepEqual(restricted.allowedUsers, []);
  assert.deepEqual(restricted.skills, []);
  aliasTarget = "/separate";
  const detached = createWorkspaceProjectionReader(revoked, resolve)("follower");
  assert.equal(detached.workspaceLink, undefined);
  assert.equal(detached.access, "none");
});

test("fresh listings apply DM template changes and the current preferred owner", async () => {
  const { getDmTemplates, saveSettings } = await import("../src/config/settings.js");
  const previous = getDmTemplates();
  const rows = [
    { slug: "older-follower", meta: { workDir: "/shared", workspaceOwnerSlug: "dm-owner", skills: ["local"], model: "local-model" } },
    { slug: "dm-owner", meta: { workDir: "/shared", isDM: true, type: "im", template: "user", allowedUsers: ["U_OWNER"], excludedUsers: ["U_EXCLUDED"] } },
  ];
  const read = () => createWorkspaceProjectionReader(rows, (_slug, meta) => meta.workDir)("older-follower");
  try {
    saveSettings({ dmTemplates: { ...previous, user: { ...previous.user, skills: ["before"], allowNetwork: true } } });
    assert.deepEqual(read().skills, ["before"]);
    saveSettings({ dmTemplates: { ...previous, user: { ...previous.user, skills: ["after"], allowNetwork: false } } });
    const updated = read();
    assert.equal(updated.workspaceLink.slug, "dm-owner");
    assert.equal(updated.workspacePolicyIsDM, true);
    assert.equal(updated.model, "local-model");
    assert.deepEqual(updated.skills, ["after"]);
    assert.equal(updated.allowNetwork, false);
    assert.deepEqual(updated.excludedUsers, ["U_EXCLUDED"]);
    const moved = structuredClone(rows);
    moved[1].meta.workDir = "/elsewhere";
    const promoted = createWorkspaceProjectionReader(moved, (_slug, meta) => meta.workDir)("older-follower");
    assert.equal(promoted.workspaceLink, undefined);
    assert.deepEqual(promoted.skills, ["local"]);
  } finally {
    saveSettings({ dmTemplates: previous });
  }
});

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

test("shared folders follow the first conversation live and reject divergent shared edits", async () => {
  const root = tempDir("cg-workspace-linked-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  await mkdir(workDir, { recursive: true });
  const a = await channel("C_WORKSPACE_COLLISION_A", { workDir, skills: ["workspace-shared"], memory: true });
  const b = await channel("C_WORKSPACE_COLLISION_B", { workDir, skills: [], memory: false, model: "own-model" });
  try {
    let linked = await getChannelMeta(b.slug);
    assert.equal(linked.workspaceLink.slug, a.slug);
    assert.deepEqual(linked.skills, ["workspace-shared"]);
    assert.equal(linked.memory, true);
    assert.equal(linked.model, "own-model");
    assert.equal((await syncWorkspaceSkills({ log: quiet })).ok, true);
    await patchChannelMeta(a.slug, { memory: false });
    assert.equal((await getChannelMeta(b.slug)).memory, false);
    const listing = await listChannels();
    assert.deepEqual(listing.find((row) => row.slug === b.slug).meta, await getChannelMeta(b.slug));
    assert.equal(listing.find((row) => row.slug === b.slug).meta.memory, false);
    await assert.rejects(patchChannelMeta(b.slug, { memory: true }), { code: "workspace_setting_linked" });
    await patchChannelMeta(b.slug, { model: "other-model" });
    assert.equal((await getChannelMeta(b.slug)).model, "other-model");
    assert.equal((await getChannelMeta(a.slug)).workspaceLink, undefined);
    await patchChannelMeta(b.slug, { workDir: "" });
    assert.equal((await getChannelMeta(b.slug)).workspaceLink, undefined);
    await patchChannelMeta(b.slug, { memory: true });
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

test("an older conversation joining a folder follows its established owner, with safe owner departure", async () => {
  const root = tempDir("cg-workspace-owner-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  await mkdir(workDir, { recursive: true });
  const older = await channel("C_LINK_OLDER", { memory: false });
  const owner = await channel("C_LINK_OWNER", { workDir, memory: true,
    env: { VPN_PASSWORD: { value: "fixture-secret" } }, vpnService: { version: 1 },
    allowNetwork: true, allowedUsers: ["U_OWNER"] });
  try {
    await patchChannelMeta(older.slug, { workDir });
    let linked = await getChannelMeta(older.slug);
    assert.equal(linked.workspaceLink.slug, owner.slug);
    assert.equal(linked.memory, true);
    const scoped = await createLocalSkill({ slug: "linked-owner-scoped", files: files("linked-owner-scoped", 1), channelId: "C_LINK_OWNER", publish: false });
    const { channelSkillGrants, withTemplateSkills } = await import("../src/gateway/skills/templates.js");
    assert.ok(channelSkillGrants(linked).includes(scoped.skill.slug));
    assert.ok(withTemplateSkills(linked).skills.includes(scoped.skill.slug));
    assert.deepEqual(linked.allowedUsers, ["U_OWNER"]);
    const { resolveChannelEnv } = await import("../src/config/channel-env.js");
    assert.equal((await resolveChannelEnv({ ...linked, vpnService: undefined })).VPN_PASSWORD, "fixture-secret", "fixture would expose the service credential without its metadata");
    assert.equal((await resolveChannelEnv(linked)).VPN_PASSWORD, undefined, "operator service credentials stay excluded");
    await assert.rejects(patchChannelMeta(older.slug, { allowedUsers: ["U_OTHER"] }), { code: "workspace_setting_linked" });
    await patchChannelMeta(older.slug, { effort: "high" });
    assert.equal((await getChannelMeta(older.slug)).workspaceLink.slug, owner.slug);
    await patchChannelMeta(owner.slug, { memory: false, allowedUsers: ["U_CHANGED"] });
    await patchChannelMeta(owner.slug, { workDir: "" });
    linked = await getChannelMeta(older.slug);
    assert.equal(linked.workspaceLink, undefined);
    assert.equal(linked.memory, false);
    assert.deepEqual(linked.allowedUsers, ["U_CHANGED"]);
    assert.ok(channelSkillGrants(linked).includes(scoped.skill.slug), "source section skills survive owner departure");
  } finally {
    await patchChannelMeta(older.slug, { workDir: "" });
    await patchChannelMeta(owner.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("cross-platform followers receive actual surface guidance without rewriting the shared manual", async () => {
  const { linkedWorkspaceGuidePreamble } = await import("../src/gateway/guide.js");
  assert.equal(await linkedWorkspaceGuidePreamble({ platform: "slack", workspaceLink: { platform: "slack" } }), "");
  const prefix = await linkedWorkspaceGuidePreamble({ platform: "googlechat", workspaceLink: { platform: "slack" } });
  assert.match(prefix, /Actual chat surface.*Google Chat/);
  assert.match(prefix, /End actual chat surface/);
});

test("a follower keeps its trusted default-workspace link when the filesystem root narrows", async () => {
  const previousRoot = process.env.CG_FS_ROOT;
  const owner = await channel("C_NARROW_OWNER");
  const workDir = workspaceFolder(owner.slug);
  await mkdir(workDir, { recursive: true });
  const follower = await channel("C_NARROW_FOLLOWER", { workDir });
  try {
    process.env.CG_FS_ROOT = tempDir("cg-narrow-root-");
    await patchChannelMeta(follower.slug, { model: "independent-model" });
    const linked = await getChannelMeta(follower.slug);
    assert.equal(linked.workspaceLink.slug, owner.slug);
    assert.equal(linked.model, "independent-model");
    const { effectiveWorkDir } = await import("../src/gateway/folders.js");
    assert.equal(effectiveWorkDir(follower.slug, linked), workDir);
  } finally {
    await patchChannelMeta(follower.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("linked access exclusions and source restrictions apply in channels and DMs", async () => {
  const root = tempDir("cg-linked-access-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  await mkdir(workDir);
  const owner = await channel("C_LINK_ACCESS_OWNER", { workDir, excludedUsers: ["U_EXCLUDED"] });
  const follower = await channel("C_LINK_ACCESS_FOLLOWER", { workDir });
  const dm = await channel("D_LINK_ACCESS_FOLLOWER", { workDir, isDM: true, template: "user" });
  const { isAuthorized } = await import("../src/gateway/modes.js");
  try {
    for (const entry of [follower, dm]) {
      const linked = await getChannelMeta(entry.slug);
      assert.equal(isAuthorized(linked, "U_EXCLUDED", entry === dm, { isApprovedUser: true }), false);
      await assert.rejects(patchChannelMeta(entry.slug, { excludedUsers: [] }), { code: "workspace_setting_linked" });
    }
    await patchChannelMeta(owner.slug, { access: "admins", excludedUsers: [] });
    assert.equal(isAuthorized(await getChannelMeta(dm.slug), "U_APPROVED", true, { isApprovedUser: true }), false, "a DM cannot bypass source channel access");
    await patchChannelMeta(dm.slug, { workDir: "" });
    assert.equal(isAuthorized(await getChannelMeta(dm.slug), "U_APPROVED", true, { isApprovedUser: true }), false, "separation preserves the effective restriction alongside copied files and credentials");
    await patchChannelMeta(dm.slug, { access: "approved" });
    assert.equal(isAuthorized(await getChannelMeta(dm.slug), "U_APPROVED", true, { isApprovedUser: true }), true, "the detached policy can be explicitly changed");
    await patchChannelMeta(owner.slug, { access: "approved", excludedUsers: ["U_NEW"] });
    assert.equal(isAuthorized(await getChannelMeta(follower.slug), "U_NEW", false, { isApprovedUser: true }), false);
  } finally {
    for (const entry of [follower, dm, owner]) await patchChannelMeta(entry.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("explicit unlink preserves source section skills and DM mode without reapplying its template", async () => {
  const root = tempDir("cg-linked-unlink-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  await mkdir(workDir);
  const owner = await channel("C_LINK_UNLINK_OWNER", { workDir, allowBash: true, profile: "worker" });
  const scoped = await createLocalSkill({ slug: "unlink-source-scoped", files: files("unlink-source-scoped", 1), channelId: "C_LINK_UNLINK_OWNER", publish: false });
  const follower = await channel("D_LINK_UNLINK_FOLLOWER", { workDir, isDM: true, template: "user" });
  try {
    await patchChannelMeta(follower.slug, { workDir: "" });
    const detached = await getChannelMeta(follower.slug);
    const { effectiveMeta } = await import("../src/gateway/run.js");
    const { channelSkillGrants } = await import("../src/gateway/skills/templates.js");
    assert.equal(detached.workspaceLink, undefined);
    assert.equal(detached.template, "custom");
    assert.equal(effectiveMeta(detached).allowBash, true);
    assert.ok(channelSkillGrants(detached).includes(scoped.skill.slug));
    // Later additions in the former source's section do not silently re-link the detached setup.
    const later = await createLocalSkill({ slug: "unlink-source-later", files: files("unlink-source-later", 1), channelId: "C_LINK_UNLINK_OWNER", publish: false });
    assert.equal(channelSkillGrants(await getChannelMeta(follower.slug)).includes(later.skill.slug), false);
  } finally {
    await patchChannelMeta(follower.slug, { workDir: "" });
    await patchChannelMeta(owner.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("a promoted owner remains the source when an older conversation joins before it saves", async () => {
  const root = tempDir("cg-linked-promoted-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const workDir = path.join(root, "project");
  await mkdir(workDir);
  const older = await channel("C_PROMOTED_OLDER");
  const owner = await channel("C_PROMOTED_ORIGINAL", { workDir, memory: true });
  const promoted = await channel("C_PROMOTED_FOLLOWER", { workDir });
  try {
    await patchChannelMeta(owner.slug, { workDir: "" });
    assert.equal((await getChannelMeta(promoted.slug)).workspaceLink, undefined);
    await patchChannelMeta(older.slug, { workDir });
    assert.equal((await getChannelMeta(older.slug)).workspaceLink.slug, promoted.slug);
    assert.equal((await getChannelMeta(promoted.slug)).workspaceLink, undefined);
  } finally {
    for (const entry of [older, promoted, owner]) await patchChannelMeta(entry.slug, { workDir: "" });
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});
