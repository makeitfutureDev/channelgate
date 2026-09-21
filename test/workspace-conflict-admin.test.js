import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const fsRoot = tempDir("cg-workspace-warning-");
process.env.CG_FS_ROOT = fsRoot;
const shared = path.join(fsRoot, "shared-project");
const sharedAlias = path.join(fsRoot, "shared-project-alias");
const separate = path.join(fsRoot, "separate-project");
await mkdir(shared, { recursive: true });
await symlink(shared, sharedAlias, "dir");
await mkdir(separate, { recursive: true });

const { defaultChannelMeta, listChannels, saveChannelMeta, upsertChannelEntry } = await import("../src/config/store.js");
const { workspaceAssignmentsAtPath, workspaceConflictsBySlug } = await import("../src/gateway/workspace-assignments.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

async function conversation(channelId, name, { type = "channel", isDM = false, workDir = shared } = {}) {
  const entry = await upsertChannelEntry(channelId, { name, type, isDM, platform: "slack" });
  await saveChannelMeta(entry.slug, {
    ...defaultChannelMeta({ channelId, name, type, isDM, platform: "slack" }),
    workDir,
    // These values prove the warning is about folder ownership, even when the runtime guard's
    // shared selections happen to be compatible.
    skills: [],
    memory: true,
  });
  return { ...entry, channelId };
}

const first = await conversation("C_WORKDIR_FIRST", "first-project");
const second = await conversation("C_WORKDIR_SECOND", "second-project", { workDir: sharedAlias });
const dm = await conversation("D_WORKDIR_DM", "Fixture Person", { type: "im", isDM: true });
const alone = await conversation("C_WORKDIR_ALONE", "separate-project", { workDir: separate });

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function getJson(url) {
  const response = await fetch(base + url);
  return { response, json: await response.json() };
}

test("workspace assignment helper marks every conversation sharing one effective folder", async () => {
  const all = await listChannels();
  const conflicts = workspaceConflictsBySlug(all);
  assert.deepEqual([...conflicts.keys()].sort(), [first.slug, second.slug, dm.slug].sort());
  assert.equal(conflicts.get(first.slug).path, shared);
  assert.deepEqual(
    conflicts.get(first.slug).conversations.map((item) => item.channelId).sort(),
    [second.channelId, dm.channelId].sort(),
  );
  assert.equal(conflicts.has(alone.slug), false);
  assert.deepEqual(workspaceAssignmentsAtPath(all, separate).map((item) => item.channelId), [alone.channelId]);
});

test("conversation APIs expose duplicate-folder warnings for channels and DMs", async () => {
  const channels = await getJson("/channels");
  assert.equal(channels.response.status, 200);
  const firstRow = channels.json.channels.find((item) => item.channelId === first.channelId);
  const aloneRow = channels.json.channels.find((item) => item.channelId === alone.channelId);
  assert.equal(firstRow.workDirConflict.path, shared);
  assert.deepEqual(firstRow.workDirConflict.conversations.map((item) => item.channelId).sort(), [second.channelId, dm.channelId].sort());
  assert.equal(aloneRow.workDirConflict, null);

  const dms = await getJson("/dms");
  assert.equal(dms.response.status, 200);
  const dmRow = dms.json.dms.find((item) => item.channelId === dm.channelId);
  assert.deepEqual(dmRow.workDirConflict.conversations.map((item) => item.channelId).sort(), [first.channelId, second.channelId].sort());
});

test("folder browser reports existing assignments before the folder is selected", async () => {
  const used = await getJson(`/fs/list?path=${encodeURIComponent(shared)}`);
  assert.equal(used.response.status, 200);
  assert.deepEqual(used.json.assignedConversations.map((item) => item.channelId).sort(), [first.channelId, second.channelId, dm.channelId].sort());

  const unused = path.join(fsRoot, "unused-project");
  await mkdir(unused);
  const clear = await getJson(`/fs/list?path=${encodeURIComponent(unused)}`);
  assert.equal(clear.response.status, 200);
  assert.deepEqual(clear.json.assignedConversations, []);
});

test("admin UI paints duplicate conversations and the folder warning in red", async () => {
  const [html, client, css] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="fs-conflict" class="fs-conflict" role="alert" hidden/);
  assert.match(client, /workDirConflictSummary/);
  assert.match(client, /className = "list-item conv-item" \+ \(conflictText \? " workdir-conflict"/);
  assert.match(client, /Already assigned to .*Selecting it here will share one working folder between conversations/);
  assert.match(client, /if \(!\(await refreshConversationRows\(\)\)\) renderConvList\(\)/);
  assert.match(css, /\.conv-item\.workdir-conflict[^}]*rgba\(229, 96, 77/);
  assert.match(css, /\.fs-conflict[^}]*color: var\(--danger\)/);
});
