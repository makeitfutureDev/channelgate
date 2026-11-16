// Additional folders (src/gateway/extra-folders.js): admin-declared host directories mounted into
// a channel's container beside its work folder, at their identical paths. The validator at every
// door (MCP tools, admin PUT, the runtime resolver), the mount and fingerprint, the lockdown file's
// additionalDirectories, and the run preamble.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
process.env.CG_WORKSPACE_DIR = tempDir("cg-xf-workspace-");
process.env.CG_FS_ROOT = path.dirname(realpathSync(os.tmpdir()));
process.env.PATH = `${path.resolve("test/fixtures")}${path.delimiter}${process.env.PATH || ""}`;

const { normalizeExtraFolders, validateExtraFolder, resolveExtraFoldersForSpawn, extraFolderMounts, extraFolderDirectories, describeExtraFolders, MAX_EXTRA_FOLDERS } = await import("../src/gateway/extra-folders.js");
const { gatewayRoot, workspaceFolder } = await import("../src/config/paths.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { containerMountFingerprint, buildCreateArgs } = await import("../src/runtimes/container/lifecycle.js");
const { buildSettings } = await import("../src/gateway/folders.js");
const { runtimeAccessPreamble } = await import("../src/gateway/runtime-access.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser, patchChannelMeta } = await import("../src/config/store.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const ensure = (p) => { mkdirSync(p, { recursive: true }); return real(p); };

const HOME = real(tempDir("cg-xf-home-"));
const PROJECT = ensure(path.join(HOME, "Code", "project"));
const SHARED = ensure(path.join(HOME, "Projects", "client"));
const SHARED_SUB = ensure(path.join(SHARED, "website"));
const OTHER = ensure(path.join(HOME, "Projects", "assets"));
const LINK = path.join(HOME, "Projects", "client-link");
symlinkSync(SHARED, LINK);
const GATEWAY_ROOT = ensure(gatewayRoot());

const ADMIN = "U_XF_ADMIN";
const MEMBER = "U_XF_MEMBER";
await setUser(ADMIN, { name: "Folder Admin", isAdmin: true, approved: true });
await setUser(MEMBER, { name: "Folder Member", isAdmin: false, approved: true });
const mine = await upsertChannelEntry("C_XF_MINE", { name: "xf-mine", type: "channel", isDM: false });
await saveChannelMeta(mine.slug, { ...defaultChannelMeta({ channelId: "C_XF_MINE", name: "xf-mine", type: "channel", isDM: false }), workDir: PROJECT });
const other = await upsertChannelEntry("C_XF_OTHER", { name: "xf-other", type: "channel", isDM: false });
await saveChannelMeta(other.slug, defaultChannelMeta({ channelId: "C_XF_OTHER", name: "xf-other", type: "channel", isDM: false }));
const OTHER_DEFAULT = ensure(workspaceFolder(other.slug, "slack"));

const SETTINGS = { enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:test", idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", fullAccessHome: false, egressMode: "proxy" };
const baseMeta = () => ({ platform: "slack", channelId: "C_XF_MINE", runtime: "container", workDir: PROJECT });

test("normalizeExtraFolders keeps absolute, deduplicated entries with a known mode", () => {
  assert.deepEqual(normalizeExtraFolders(undefined), []);
  assert.deepEqual(normalizeExtraFolders([" /a ", "/a", { path: "/b", mode: "ro" }, { path: "relative" }, { path: "/c", mode: "nonsense" }]),
    [{ path: "/a", mode: "rw" }, { path: "/b", mode: "ro" }, { path: "/c", mode: "rw" }]);
  assert.equal(normalizeExtraFolders(Array.from({ length: 40 }, (_, i) => `/f${i}`)).length, MAX_EXTRA_FOLDERS);
});

test("validateExtraFolder follows a symlink to its real directory and refuses the daemon's trees, overlaps and duplicates", () => {
  const opts = { slug: mine.slug, workDir: PROJECT };
  assert.deepEqual(validateExtraFolder(SHARED, opts), { path: SHARED });
  assert.deepEqual(validateExtraFolder(LINK, opts), { path: SHARED }, "a symlink is stored as its real target, never as the link");
  assert.match(validateExtraFolder("relative/path", opts).error, /ABSOLUTE|absolute/);
  assert.match(validateExtraFolder(path.join(HOME, "missing"), opts).error, /does not exist/);
  assert.match(validateExtraFolder(GATEWAY_ROOT, opts).error, /^Refused: .*gateway runtime root/);
  assert.match(validateExtraFolder(OTHER_DEFAULT, opts).error, /^Refused: .*another conversation's work folder/);
  assert.match(validateExtraFolder(PROJECT, opts).error, /already this channel's working folder/);
  assert.match(validateExtraFolder(path.join(PROJECT, "sub"), { ...opts, workDir: PROJECT }).error ?? "does not exist", /does not exist|inside this channel's working folder/);
  ensure(path.join(PROJECT, "sub"));
  assert.match(validateExtraFolder(path.join(PROJECT, "sub"), opts).error, /inside this channel's working folder/);
  assert.match(validateExtraFolder(path.join(HOME, "Code"), opts).error, /contains this channel's working folder/);
  const others = [{ path: SHARED, mode: "rw" }];
  assert.match(validateExtraFolder(SHARED, { ...opts, others }).error, /already on this channel's additional folders/);
  assert.match(validateExtraFolder(SHARED_SUB, { ...opts, others }).error, /overlaps the additional folder/);
  assert.match(validateExtraFolder(path.join(HOME, "Projects"), { ...opts, others }).error, /overlaps the additional folder/);
  assert.deepEqual(validateExtraFolder(OTHER, { ...opts, others }), { path: OTHER });
});

test("the resolver mounts each folder at its identical path with its mode, and the mount fingerprint changes with the list", () => {
  const plain = resolveRuntime(mine.slug, baseMeta(), { settings: SETTINGS });
  assert.deepEqual(extraFolderDirectories(plain), []);
  const t = resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: SHARED, mode: "rw" }, { path: OTHER, mode: "ro" }] }, { settings: SETTINGS });
  const mounts = t.container.mounts.filter((m) => m.kind === "extra-folder");
  assert.deepEqual(mounts, [
    { kind: "extra-folder", type: "bind", source: SHARED, target: SHARED, mode: "rw" },
    { kind: "extra-folder", type: "bind", source: OTHER, target: OTHER, mode: "ro" },
  ]);
  assert.deepEqual(extraFolderDirectories(t), [{ path: SHARED, mode: "rw" }, { path: OTHER, mode: "ro" }]);
  assert.notEqual(containerMountFingerprint(t), containerMountFingerprint(plain), "a changed list recreates the container");
  const roOnly = resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: SHARED, mode: "ro" }] }, { settings: SETTINGS });
  const rw = resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: SHARED, mode: "rw" }] }, { settings: SETTINGS });
  assert.notEqual(containerMountFingerprint(roOnly), containerMountFingerprint(rw), "so does a mode change");
  // The create argv carries the bind with the read-only suffix where declared.
  const args = buildCreateArgs(t, { uidStrategy: "keep-id", cgroupLimits: false, cli: "podman" });
  assert.ok(args.includes(`${SHARED}:${SHARED}`));
  assert.ok(args.includes(`${OTHER}:${OTHER}:ro`));
  // Pure helpers used by the mount builder.
  assert.deepEqual(extraFolderMounts({ extraFolders: [{ path: "/x", mode: "ro" }, { path: "rel" }] }), [{ kind: "extra-folder", type: "bind", source: "/x", target: "/x", mode: "ro" }]);
  assert.equal(describeExtraFolders([{ path: "/x", mode: "ro" }, { path: "/y" }]), "/x (read-only), /y (read-write)");
});

test("an already-stored entry that no longer passes fails the spawn closed with the remedy", () => {
  for (const [dir, why] of [[GATEWAY_ROOT, /gateway runtime root/], [path.join(HOME, "vanished"), /does not exist/], [PROJECT, /already this channel's working folder/], [OTHER_DEFAULT, /another conversation's work folder/]]) {
    assert.throws(() => resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: dir, mode: "rw" }] }, { settings: SETTINGS }), (error) => {
      assert.equal(error.code, "extra_folder_refused");
      assert.match(error.message, /never mounts that into a container/);
      assert.match(error.message, /remove_channel_folder/);
      assert.match(error.message, why);
      assert.ok(error.message.includes(dir));
      return true;
    }, dir);
  }
  // Two stored entries that overlap each other are refused too.
  assert.throws(() => resolveExtraFoldersForSpawn(mine.slug, { extraFolders: [{ path: SHARED }, { path: SHARED_SUB }] }, { workDir: PROJECT }), /overlaps the additional folder/);
  // A host (sudo) target adds nothing: the daemon account sees the whole filesystem already.
  assert.deepEqual(resolveExtraFoldersForSpawn(mine.slug, { extraFolders: [] }, { workDir: PROJECT }), []);
});

test("the lockdown file lists every mounted additional folder as an additional directory in BOTH variants", async () => {
  const t = resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: SHARED, mode: "rw" }, { path: OTHER, mode: "ro" }] }, { settings: SETTINGS });
  const shared = await buildSettings({ _slug: mine.slug, allowedMcps: [] }, { target: t });
  assert.deepEqual(shared.permissions.additionalDirectories, [SHARED, OTHER]);
  const bypass = await buildSettings({ _slug: mine.slug, adminMode: true, allowedMcps: [] }, { allowBypass: true, target: t });
  assert.deepEqual(bypass.permissions.additionalDirectories, [SHARED, OTHER], "no operator home without the grant");
  const none = await buildSettings({ _slug: mine.slug, allowedMcps: [] }, { target: resolveRuntime(mine.slug, baseMeta(), { settings: SETTINGS }) });
  assert.deepEqual(none.permissions.additionalDirectories, []);
});

test("the run preamble names the mounted additional folders and their modes, and stays silent without any", () => {
  const t = resolveRuntime(mine.slug, { ...baseMeta(), extraFolders: [{ path: SHARED, mode: "rw" }, { path: OTHER, mode: "ro" }] }, { settings: SETTINGS });
  const note = runtimeAccessPreamble(t, { clean: false, allowNetwork: true, dangerouslySkip: false });
  assert.match(note, /Additional folders an admin declared for this channel are mounted at their identical host paths/);
  assert.ok(note.includes(`${SHARED} (read-write)`));
  assert.ok(note.includes(`${OTHER} (read-only)`));
  const plain = runtimeAccessPreamble(resolveRuntime(mine.slug, baseMeta(), { settings: SETTINGS }), { clean: false, allowNetwork: true, dangerouslySkip: false });
  assert.doesNotMatch(plain, /Additional folders an admin declared/);
});

function toolsFor(authorId) {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: "C_XF_MINE", slug: mine.slug, authorId, threadKey: "1700000000.000200", principalTrusted: true, engine: "claude" });
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);
  return tools;
}

test("add_channel_folder / remove_channel_folder / list_channel_folders: admins only, validated, stored as real paths", async () => {
  const admin = toolsFor(ADMIN);
  const member = toolsFor(MEMBER);
  assert.match((await member.get("add_channel_folder")({ path: SHARED })).content[0].text, /Only admins/);
  assert.match((await admin.get("list_channel_folders")()).content[0].text, /mounts no additional folders/);
  for (const [dir, why] of [[GATEWAY_ROOT, /gateway runtime root/], [PROJECT, /already this channel's working folder/], [path.join(HOME, "Code"), /contains this channel's working folder/], [OTHER_DEFAULT, /another conversation's work folder/]]) {
    assert.match((await admin.get("add_channel_folder")({ path: dir })).content[0].text, why, dir);
    assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders || [], [], "nothing was written");
  }
  assert.match((await admin.get("add_channel_folder")({ path: LINK, mode: "ro" })).content[0].text, /✅ .*read-only/);
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, [{ path: SHARED, mode: "ro" }], "the link's real target");
  assert.match((await admin.get("add_channel_folder")({ path: SHARED_SUB })).content[0].text, /overlaps the additional folder/);
  assert.match((await admin.get("add_channel_folder")({ path: OTHER })).content[0].text, /✅ .*read-write/);
  const listed = (await admin.get("list_channel_folders")()).content[0].text;
  assert.ok(listed.includes(`${SHARED} — read-only`) && listed.includes(`${OTHER} — read-write`));
  assert.match((await member.get("remove_channel_folder")({ path: SHARED })).content[0].text, /Only admins/);
  assert.match((await admin.get("remove_channel_folder")({ path: path.join(HOME, "nope") })).content[0].text, /not one of this channel's additional folders/);
  assert.match((await admin.get("remove_channel_folder")({ path: SHARED })).content[0].text, /no longer mounted/);
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, [{ path: OTHER, mode: "rw" }]);
  await admin.get("remove_channel_folder")({ path: OTHER });
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, []);
});

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const put = async (body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/channels/C_XF_MINE/meta`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};

test("the admin UI's Additional folders field validates every changed entry against the saved work folder and refuses with a named reason", async () => {
  for (const [dir, why] of [[GATEWAY_ROOT, /gateway runtime root/], [PROJECT, /already this channel's working folder/], [OTHER_DEFAULT, /another conversation's work folder/]]) {
    const { status, json } = await put({ extraFolders: [{ path: dir, mode: "rw" }] });
    assert.equal(status, 400, dir);
    assert.match(json.error, /^extraFolders refused: /);
    assert.match(json.error, why);
    assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders || [], []);
  }
  // Two overlapping entries in one save refuse the whole save.
  assert.equal((await put({ extraFolders: [{ path: SHARED }, { path: SHARED_SUB }] })).status, 400);
  const ok = await put({ extraFolders: [{ path: LINK, mode: "ro" }, { path: OTHER }] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, [{ path: SHARED, mode: "ro" }, { path: OTHER, mode: "rw" }]);
  // Round-tripping the stored list is not re-validated; an unrelated save keeps it; omitting the key keeps it.
  assert.equal((await put({ extraFolders: [{ path: SHARED, mode: "ro" }, { path: OTHER, mode: "rw" }], memory: true })).status, 200);
  assert.equal((await put({ memory: false })).status, 200);
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, [{ path: SHARED, mode: "ro" }, { path: OTHER, mode: "rw" }]);
  // Moving the work folder INTO a listed folder in the same save is refused against the new folder.
  const moved = await put({ workDir: SHARED_SUB, extraFolders: [{ path: SHARED, mode: "ro" }] });
  assert.equal(moved.status, 400);
  assert.match(moved.json.error, /contains this channel's working folder/);
  assert.equal((await getChannelMeta(mine.slug)).workDir, PROJECT, "the refused save wrote nothing");
  // An empty list clears.
  assert.equal((await put({ extraFolders: [] })).status, 200);
  assert.deepEqual((await getChannelMeta(mine.slug)).extraFolders, []);
  await patchChannelMeta(mine.slug, { extraFolders: [] });
});
