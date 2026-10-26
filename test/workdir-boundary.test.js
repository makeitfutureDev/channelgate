// The work-folder boundary (security audit 2026-10-23, batch 2). A channel's work folder is
// bind-mounted read-write into its container and browsed by the file explorer, and the containment
// root defaults to the daemon's home — so the daemon's own trees and other conversations' folders
// are refused regardless of the root, at every door: the MCP tool, the admin PUT, and the runtime
// resolver (which fails an already-stored value closed with the remedy).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { ensureTestEnv, tempDir } from "./helpers.js";

import os from "node:os";
ensureTestEnv();
// The test scratch root IS the gateway runtime root, so the fake home and the visible workspace
// must live beside it (as in production: ~/.channelgate vs ~/ChannelGate), not under it. The
// allowlisted root is pinned at the temp dir so every candidate below is INSIDE it: the boundary
// must hold even where the old containment check passes.
process.env.CG_WORKSPACE_DIR = tempDir("cg-wd-workspace-");
// The common parent of the scratch gateway root and the per-test temp dirs (both under /tmp).
process.env.CG_FS_ROOT = path.dirname(realpathSync(os.tmpdir()));
process.env.PATH = `${path.resolve("test/fixtures")}${path.delimiter}${process.env.PATH || ""}`;

const { forbiddenWorkDirReason, forbiddenWorkDirMessage, otherChannelWorkDirs, sensitiveWorkDirRoots } = await import("../src/gateway/workdir-boundary.js");
const { configDir, gatewayRoot, workspaceFolder, workspaceRoot, runtimeArtifactsRoot } = await import("../src/config/paths.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const ensure = (p) => { mkdirSync(p, { recursive: true }); return real(p); };

// A fake daemon home under the scratch root, with the trees the predicate names.
const HOME = real(tempDir("cg-wd-home-"));
for (const rel of [".ssh", ".claude", ".codex", path.join(".config", "containers"), path.join(".local", "share", "containers"), path.join("Code", "project"), path.join("Code", "project", "sub")]) ensure(path.join(HOME, rel));
const PROJECT = real(path.join(HOME, "Code", "project"));
const GATEWAY_ROOT = ensure(gatewayRoot());
const CONFIG = ensure(configDir());
const VISIBLE = ensure(workspaceRoot());
const ARTIFACTS = ensure(runtimeArtifactsRoot());

const ADMIN = "U_WORKDIR_ADMIN";
await setUser(ADMIN, { name: "Boundary Admin", isAdmin: true, approved: true });
const mine = await upsertChannelEntry("C_WD_MINE", { name: "wd-mine", type: "channel", isDM: false });
await saveChannelMeta(mine.slug, defaultChannelMeta({ channelId: "C_WD_MINE", name: "wd-mine", type: "channel", isDM: false }));
const other = await upsertChannelEntry("C_WD_OTHER", { name: "wd-other", type: "channel", isDM: false });
const OTHER_CUSTOM = ensure(path.join(HOME, "Code", "other-project"));
await saveChannelMeta(other.slug, { ...defaultChannelMeta({ channelId: "C_WD_OTHER", name: "wd-other", type: "channel", isDM: false }), workDir: OTHER_CUSTOM });
const MY_DEFAULT = ensure(workspaceFolder(mine.slug, "slack"));
const OTHER_DEFAULT = ensure(workspaceFolder(other.slug, "slack"));

const opts = { slug: mine.slug, home: HOME };

test("the daemon's own trees are refused in both directions, whatever the root allows", () => {
  assert.equal(forbiddenWorkDirReason(PROJECT, opts), "", "an ordinary project directory is allowed");
  assert.equal(forbiddenWorkDirReason(path.join(PROJECT, "sub"), opts), "");
  assert.match(forbiddenWorkDirReason(HOME, opts), /home directory itself/);
  assert.match(forbiddenWorkDirReason(path.dirname(HOME), opts), /parent of the gateway account's home/);
  assert.match(forbiddenWorkDirReason(GATEWAY_ROOT, opts), /gateway runtime root/);
  assert.match(forbiddenWorkDirReason(path.join(GATEWAY_ROOT, "logs"), opts), /inside the gateway runtime root/);
  assert.match(forbiddenWorkDirReason(CONFIG, opts), /gateway (runtime root|config directory)/);
  assert.match(forbiddenWorkDirReason(path.join(HOME, ".ssh"), opts), /SSH directory/);
  assert.match(forbiddenWorkDirReason(path.join(HOME, ".claude"), opts), /Claude Code home/);
  assert.match(forbiddenWorkDirReason(path.join(HOME, ".codex"), opts), /Codex home/);
  assert.match(forbiddenWorkDirReason(path.join(HOME, ".config", "containers"), opts), /container engine/);
  assert.match(forbiddenWorkDirReason(path.join(HOME, ".local", "share", "containers"), opts), /container engine/);
  assert.match(forbiddenWorkDirReason(ARTIFACTS, opts), /runtime artifact tree/);
  assert.match(forbiddenWorkDirReason(path.join(ARTIFACTS, "slack", "x"), opts), /runtime artifact tree/);
  // Nonexistent paths never throw; a nonexistent ordinary path is simply not forbidden here.
  assert.equal(forbiddenWorkDirReason(path.join(PROJECT, "does-not-exist"), opts), "");
  assert.match(forbiddenWorkDirReason(path.join(GATEWAY_ROOT, "does-not-exist"), opts), /inside the gateway runtime root/);
  assert.ok(sensitiveWorkDirRoots({ home: HOME }).some((r) => r.path === HOME && r.exact));
});

test("the visible workspace root, its platform folders and other conversations' folders are refused; the channel's own are not", () => {
  assert.match(forbiddenWorkDirReason(VISIBLE, opts), /workspace root itself/);
  assert.match(forbiddenWorkDirReason(path.dirname(VISIBLE), opts), /parent of the (ChannelGate workspace root|gateway account's home|hidden runtime artifact tree)/);
  assert.match(forbiddenWorkDirReason(path.join(VISIBLE, "slack"), opts), /platform folder/);
  assert.equal(forbiddenWorkDirReason(MY_DEFAULT, opts), "", "the channel's own default folder");
  assert.match(forbiddenWorkDirReason(OTHER_DEFAULT, opts), /another conversation's work folder \(wd-other\)/);
  // Another conversation's CUSTOM folder is an admin's explicit choice twice over (two channels on
  // one repository), so it, its parent and its subfolders stay allowed; only the gateway-made
  // default folders are each other's.
  assert.equal(forbiddenWorkDirReason(OTHER_CUSTOM, opts), "");
  assert.equal(forbiddenWorkDirReason(path.join(HOME, "Code"), opts), "");
  assert.equal(forbiddenWorkDirReason(ensure(path.join(OTHER_CUSTOM, "packages", "api")), opts), "");
  assert.match(forbiddenWorkDirReason(path.dirname(OTHER_DEFAULT), opts), /platform folder|parent of another conversation's work folder/);
  // The other channel sees the same thing from its side, and its own folders are allowed.
  assert.equal(forbiddenWorkDirReason(OTHER_CUSTOM, { slug: other.slug, home: HOME }), "");
  assert.match(forbiddenWorkDirReason(MY_DEFAULT, { slug: other.slug, home: HOME }), /another conversation's work folder \(wd-mine\)/);
  // The store-backed list names both folders of the other channel and never the asking one's.
  const listed = otherChannelWorkDirs({ exceptSlug: mine.slug }).map((c) => c.path);
  assert.ok(listed.includes(OTHER_DEFAULT) && !listed.includes(OTHER_CUSTOM), "default folders only");
  assert.ok(!listed.includes(MY_DEFAULT));
  // An explicit list replaces the store lookup.
  assert.equal(forbiddenWorkDirReason(OTHER_CUSTOM, { ...opts, channels: [] }), "");
});

test("set_channel_workdir refuses the daemon's trees and other channels' folders even inside the allowed root", async () => {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: "C_WD_MINE", slug: mine.slug, authorId: ADMIN, threadKey: "1700000000.000100", principalTrusted: true, engine: "claude" });
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);
  const set = tools.get("set_channel_workdir");
  // (The home-relative trees are proven above with the home override; the tool uses the real home.)
  for (const [dir, why] of [[GATEWAY_ROOT, /gateway runtime root/], [VISIBLE, /workspace root/], [ARTIFACTS, /runtime artifact tree/]]) {
    const result = await set({ path: dir });
    assert.match(result.content[0].text, /^Refused: /, dir);
    assert.match(result.content[0].text, why, dir);
    assert.equal((await getChannelMeta(mine.slug)).workDir || "", "", "nothing was written");
  }
  const ok = await set({ path: PROJECT });
  assert.match(ok.content[0].text, /now runs in/);
  assert.equal((await getChannelMeta(mine.slug)).workDir, PROJECT);
  await tools.get("clear_channel_workdir")({});
  assert.equal((await getChannelMeta(mine.slug)).workDir || "", "");
});

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const put = async (body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/channels/C_WD_MINE/meta`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
};

test("the admin UI workDir field refuses the same paths with a named reason", async () => {
  for (const [dir, why] of [[GATEWAY_ROOT, /gateway runtime root/], [path.join(VISIBLE, "slack"), /platform folder/]]) {
    const { status, json } = await put({ workDir: dir });
    assert.equal(status, 400, dir);
    assert.match(json.error, /^workDir refused: /);
    assert.match(json.error, why);
    assert.equal((await getChannelMeta(mine.slug)).workDir || "", "");
  }
  const ok = await put({ workDir: PROJECT });
  assert.equal(ok.status, 200);
  assert.equal((await getChannelMeta(mine.slug)).workDir, PROJECT);
  // Round-tripping the now-stored value is not re-validated (unchanged), and blank clears it.
  assert.equal((await put({ workDir: PROJECT, memory: true })).status, 200);
  assert.equal((await put({ workDir: "" })).status, 200);
  assert.equal((await getChannelMeta(mine.slug)).workDir || "", "");
});

test("an already-stored forbidden work folder is never mounted: the spawn fails closed with the remedy", async () => {
  const settings = { fullAccessHome: false, egressMode: "proxy", image: "test-workdir-boundary" };
  const meta = { ...(await getChannelMeta(mine.slug)), platform: "slack", channelId: "C_WD_MINE" };
  // Stored out of band (the way a pre-boundary install would hold it); the resolver is the door.
  for (const dir of [GATEWAY_ROOT, OTHER_DEFAULT]) {
    assert.throws(() => resolveRuntime(mine.slug, { ...meta, workDir: dir }, { settings }), (error) => {
      assert.match(error.message, /never mounts that into a container/);
      assert.match(error.message, /set_channel_workdir/);
      assert.ok(error.message.includes(dir));
      return true;
    }, dir);
  }
  // The hot-path resolver falls back to the default folder for the static trees rather than
  // provisioning the lockdown file inside them.
  assert.equal(effectiveWorkDir(mine.slug, { ...meta, workDir: GATEWAY_ROOT }), MY_DEFAULT);
  // An ordinary custom folder still resolves and mounts as before — including one another
  // conversation also uses (a shared repository).
  const target = resolveRuntime(mine.slug, { ...meta, workDir: PROJECT }, { settings });
  assert.equal(target.workDir, PROJECT);
  assert.equal(resolveRuntime(mine.slug, { ...meta, workDir: OTHER_CUSTOM }, { settings }).workDir, OTHER_CUSTOM);
  assert.equal(forbiddenWorkDirMessage(mine.slug, GATEWAY_ROOT, "x").includes("clear_channel_workdir"), true);
});

test("admin selection may link an exact default workspace; raw runtime metadata still fails closed", async () => {
  const { patchChannelMeta } = await import("../src/config/store.js");
  await patchChannelMeta(other.slug, { workDir: "" });
  const result = await put({ workDir: OTHER_DEFAULT });
  assert.equal(result.status, 200);
  const linked = await getChannelMeta(mine.slug);
  assert.equal(linked.workspaceLink.slug, other.slug);
  assert.equal(resolveRuntime(mine.slug, linked, { settings: { fullAccessHome: false, egressMode: "proxy", image: "test" } }).workDir, OTHER_DEFAULT);
  await patchChannelMeta(other.slug, { workDir: OTHER_CUSTOM });
  const promoted = await getChannelMeta(mine.slug);
  assert.equal(promoted.workspaceLink, undefined);
  assert.equal(resolveRuntime(mine.slug, promoted, { settings: { fullAccessHome: false, egressMode: "proxy", image: "test" } }).workDir, OTHER_DEFAULT);
  await put({ workDir: "" });
});
