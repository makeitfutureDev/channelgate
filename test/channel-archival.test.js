import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { handleMemberLeftChannel } = await import("../src/slack/members.js");
const { ensureChannelFolder, updateChannelInstructions } = await import("../src/gateway/folders.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { workspaceFolder } = await import("../src/config/paths.js");
const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry, patchChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { createLocalSkill, updateLocalSkill, grantSkillsToChannel } = await import("../src/gateway/skills/authoring.js");
const { syncWorkspaceSkills } = await import("../src/gateway/skills/workspace-sync.js");

async function channel(id, patch = {}) {
  const name = id.toLowerCase();
  const entry = await upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name, type: "channel", isDM: false }), ...patch });
  return entry;
}

test("bot removal archives the conversation without provisioning its folder", async () => {
  let stored = { channelId: "C_ARCHIVE", allowedUsers: ["U_GUEST"], instructions: "Keep configuration" };
  let provisioned = 0;
  const deps = {
    botUserId: "U_BOT",
    getChannelEntry: async () => ({ slug: "archive-bot", channelId: "C_ARCHIVE" }),
    patchChannelMeta: async (_slug, patch) => {
      const partial = typeof patch === "function" ? patch(stored) : patch;
      if (!partial) return null;
      stored = { ...stored, ...partial };
      return stored;
    },
    ensureChannelFolder: async () => { provisioned++; },
  };
  assert.equal(await handleMemberLeftChannel({ channel: "C_ARCHIVE", user: "U_BOT" }, deps), true);
  assert.equal(stored.archived, true);
  assert.deepEqual(stored.allowedUsers, ["U_GUEST"]);
  assert.equal(stored.instructions, "Keep configuration");
  assert.equal(provisioned, 0);
  assert.equal(await handleMemberLeftChannel({ channel: "C_ARCHIVE", user: "U_GUEST" }, deps), true);
  assert.deepEqual(stored.allowedUsers, []);
  assert.equal(stored.archived, true);
  assert.equal(provisioned, 0, "departed guest cleanup must not provision an archived conversation");
});

test("archived provisioning rejects before creating any workspace", async () => {
  const slug = "archive-never-provisioned";
  await assert.rejects(ensureChannelFolder(slug, { archived: true }), { code: "channel_archived" });
  await assert.rejects(access(workspaceFolder(slug)), { code: "ENOENT" });
  await assert.rejects(updateChannelInstructions(slug, { archived: true }, { text: "Do not write" }), { code: "channel_archived" });
  assert.throws(() => resolveRuntime(slug, { archived: true }), { code: "channel_archived" });
});

test("archival stops skill and instruction propagation, and reactivation converges changes", async () => {
  const entry = await channel("C_ARCHIVE_SYNC", { instructions: "Before removal" });
  const files = (revision) => [{ path: "SKILL.md", content: `---\nname: archive-sync-fixture\ndescription: Archive regression fixture\n---\nRevision ${revision}\n` }];
  const authored = await createLocalSkill({ slug: "archive-sync-fixture", files: files(1), publish: false });
  await grantSkillsToChannel(entry.slug, [authored.skill.slug]);
  assert.equal((await syncWorkspaceSkills({ channelSlugs: [entry.slug], log: () => {} })).ok, true);
  const cwd = workspaceFolder(entry.slug);
  const skillFile = path.join(cwd, ".claude", "skills", authored.skill.slug, "SKILL.md");
  const instructionsFile = path.join(cwd, "CLAUDE.md");
  const initialInstructions = await readFile(instructionsFile, "utf8");
  assert.match(initialInstructions, /Before removal/);
  await patchChannelMeta(entry.slug, { archived: true, instructions: "After removal", memory: false });
  await updateLocalSkill({ skill: authored.skill, files: files(2), publish: false });
  const skipped = await syncWorkspaceSkills({ channelSlugs: [entry.slug], log: () => {} });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.synced.includes(entry.slug), false);
  assert.match(await readFile(skillFile, "utf8"), /Revision 1/);
  assert.equal(await readFile(instructionsFile, "utf8"), initialInstructions);
  // A caller holding metadata from before the leave event cannot bypass the persisted archive.
  await assert.rejects(ensureChannelFolder(entry.slug, { ...(await getChannelMeta(entry.slug)), archived: false }), { code: "channel_archived" });
  await assert.rejects(updateChannelInstructions(entry.slug, { archived: false }, { text: "Blocked manual edit" }), { code: "channel_archived" });
  assert.equal(await readFile(instructionsFile, "utf8"), initialInstructions);
  await patchChannelMeta(entry.slug, { archived: false });
  const resumed = await syncWorkspaceSkills({ channelSlugs: [entry.slug], log: () => {} });
  assert.equal(resumed.ok, true);
  assert.ok(resumed.synced.includes(entry.slug));
  assert.match(await readFile(skillFile, "utf8"), /Revision 2/);
  assert.match(await readFile(instructionsFile, "utf8"), /Before removal/, "existing channel instructions survive reactivation");
  await assert.rejects(access(path.join(cwd, ".claude", "skills", "channel-memory", "SKILL.md")), { code: "ENOENT" });
});

test("admin lists retain archived channels while edits and bulk resets leave their configuration untouched", async () => {
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const archived = await channel("C_ARCHIVE_ADMIN", {
    access: "admins", manageAccess: "users", managers: ["U_MANAGER"], allowedUsers: ["U_GUEST"], instructions: "Archived fixture instructions",
  });
  const active = await channel("C_ARCHIVE_ADMIN_ACTIVE", { access: "admins", allowedUsers: ["U_ACTIVE_GUEST"] });
  await ensureChannelFolder(archived.slug, await getChannelMeta(archived.slug));
  await patchChannelMeta(archived.slug, { archived: true });
  const archivedMeta = await getChannelMeta(archived.slug);
  const instructionsFile = path.join(workspaceFolder(archived.slug), "CLAUDE.md");
  const originalFile = await readFile(instructionsFile, "utf8");
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ connected: false }) } }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = "GET", body) => {
    const response = await fetch(base + url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const listed = await request("/channels");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.channels.find((item) => item.channelId === "C_ARCHIVE_ADMIN")?.meta.archived, true);
    for (const [url, body] of [
      ["/channels/C_ARCHIVE_ADMIN/meta", { memory: false, archived: false }],
      ["/channels/C_ARCHIVE_ADMIN/instructions", { channel: "Forbidden rewrite" }],
    ]) {
      const result = await request(url, "PUT", body);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "channel_archived");
      assert.deepEqual(await getChannelMeta(archived.slug), archivedMeta);
      assert.equal(await readFile(instructionsFile, "utf8"), originalFile);
    }
    const reset = await request("/channels/reset-access", "POST", {});
    assert.equal(reset.status, 200);
    assert.ok(reset.body.count > 0, "the reset still processes active channels");
    assert.deepEqual((await getChannelMeta(active.slug)).allowedUsers, []);
    assert.deepEqual(await getChannelMeta(archived.slug), archivedMeta);
    assert.equal(await readFile(instructionsFile, "utf8"), originalFile);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
