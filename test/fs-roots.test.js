// Additional allowed roots (Settings → Container runtime → `fsRoots`): host directories outside
// the primary allowlisted root that an admin may point a working folder or an additional folder
// at — a mounted file server under /mnt, say. Validated on save, realpath'd at read time, offered
// by the folder picker at the primary root, and honoured by every door that resolves a channel
// path (working folder PUT, additional folders, set_channel_workdir, list_folders).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const PRIMARY = realpathSync(tempDir("cg-fsroots-primary-"));
const SHARE = realpathSync(tempDir("cg-fsroots-share-"));
process.env.CG_FS_ROOT = PRIMARY;
process.env.CG_WORKSPACE_DIR = path.join(PRIMARY, "ChannelGate");
process.env.PATH = `${path.resolve("test/fixtures")}${path.delimiter}${process.env.PATH || ""}`;

const { allowedFsRoots, allowedRootFor, resolveWithinRoots } = await import("../src/web/security.js");
const { settingsForApi, saveSettings } = await import("../src/config/settings.js");
const { gatewayRoot } = await import("../src/config/paths.js");
const { validateExtraFolder } = await import("../src/gateway/extra-folders.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const ensure = (p) => { mkdirSync(p, { recursive: true }); return realpathSync(p); };
const PROJECT = ensure(path.join(PRIMARY, "Code", "project"));
const COMERCIAL = ensure(path.join(SHARE, "comercial", "Comercial"));
mkdirSync(gatewayRoot(), { recursive: true });

const ADMIN = "U_FSROOTS_ADMIN";
await setUser(ADMIN, { name: "Roots Admin", isAdmin: true, approved: true });
const chan = await upsertChannelEntry("C_FSROOTS", { name: "fsroots", type: "channel", isDM: false });
await saveChannelMeta(chan.slug, { ...defaultChannelMeta({ channelId: "C_FSROOTS", name: "fsroots", type: "channel", isDM: false }), workDir: PROJECT });

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const request = async (route, { method = "GET", body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() };
};

test("without extra roots, a folder outside the primary root is refused everywhere and the picker cannot reach it", async () => {
  assert.deepEqual(allowedFsRoots(), [PRIMARY]);
  assert.equal(resolveWithinRoots(COMERCIAL), null);
  assert.match(validateExtraFolder(COMERCIAL, { slug: chan.slug, workDir: PROJECT }).error, /outside the allowed root/);
  assert.match(validateExtraFolder(COMERCIAL, { slug: chan.slug, workDir: PROJECT }).error, /Additional allowed roots/);
  const put = await request("/channels/C_FSROOTS/meta", { method: "PUT", body: { extraFolders: [{ path: COMERCIAL }] } });
  assert.equal(put.status, 400);
  assert.match(put.json.error, /^extraFolders refused: .*outside the allowed root/);
  assert.equal((await request(`/fs/list?path=${encodeURIComponent(COMERCIAL)}`)).status, 400);
  const primary = await request("/fs/list");
  assert.equal(primary.status, 200);
  assert.deepEqual(primary.json.otherRoots, []);
});

test("the settings PUT validates fsRoots: existing absolute directories only, never the daemon's trees", async () => {
  for (const [roots, why] of [[["relative/path"], /not an absolute path/], [[path.join(SHARE, "missing")], /not an existing directory/], [[gatewayRoot()], /fsRoots refused: .*gateway runtime root/], ["not-an-array", /must be an array/]]) {
    const r = await request("/settings", { method: "PUT", body: { fsRoots: roots } });
    assert.equal(r.status, 400, JSON.stringify(roots));
    assert.match(r.json.error, why);
    assert.deepEqual(settingsForApi().fsRoots, [], "nothing stored");
  }
  const ok = await request("/settings", { method: "PUT", body: { fsRoots: [` ${SHARE} `, "", SHARE] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(settingsForApi().fsRoots, [SHARE], "trimmed, deduplicated, read back");
  assert.deepEqual(allowedFsRoots(), [PRIMARY, SHARE]);
  assert.equal(allowedRootFor(COMERCIAL), SHARE);
  assert.equal(resolveWithinRoots(COMERCIAL), COMERCIAL);
});

test("with the share as an allowed root, it can be an additional folder or a working folder, and the picker offers it", async () => {
  assert.deepEqual(validateExtraFolder(COMERCIAL, { slug: chan.slug, workDir: PROJECT }), { path: COMERCIAL });
  const put = await request("/channels/C_FSROOTS/meta", { method: "PUT", body: { extraFolders: [{ path: COMERCIAL, mode: "rw" }] } });
  assert.equal(put.status, 200);
  assert.deepEqual((await getChannelMeta(chan.slug)).extraFolders, [{ path: COMERCIAL, mode: "rw" }]);
  await request("/channels/C_FSROOTS/meta", { method: "PUT", body: { extraFolders: [] } });
  // Picker: the share is listed at the primary root and browsable; Up stops at the share's top.
  const primary = await request("/fs/list");
  assert.deepEqual(primary.json.otherRoots, [SHARE]);
  assert.deepEqual(primary.json.roots, [PRIMARY, SHARE]);
  const inside = await request(`/fs/list?path=${encodeURIComponent(COMERCIAL)}`);
  assert.equal(inside.status, 200);
  assert.equal(inside.json.parent, path.dirname(COMERCIAL));
  const top = await request(`/fs/list?path=${encodeURIComponent(SHARE)}`);
  assert.equal(top.json.parent, null, "the parent of an allowed root is not browsable");
  assert.deepEqual(top.json.otherRoots, [], "other roots are listed only at the primary root");
  // Working folder too.
  const wd = await request("/channels/C_FSROOTS/meta", { method: "PUT", body: { workDir: COMERCIAL } });
  assert.equal(wd.status, 200);
  assert.equal((await getChannelMeta(chan.slug)).workDir, COMERCIAL);
  await request("/channels/C_FSROOTS/meta", { method: "PUT", body: { workDir: PROJECT } });
  // The MCP tools follow the same roots.
  const tools = new Map();
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctxFromClaims({ channelId: "C_FSROOTS", slug: chan.slug, authorId: ADMIN, threadKey: "1700000000.000300", principalTrusted: true, engine: "claude" }));
  const listed = (await tools.get("list_folders")({})).content[0].text;
  assert.ok(listed.includes("Other allowed roots") && listed.includes(SHARE));
  assert.match((await tools.get("list_folders")({ path: COMERCIAL })).content[0].text, new RegExp(`📂 ${COMERCIAL.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  assert.match((await tools.get("add_channel_folder")({ path: COMERCIAL, mode: "ro" })).content[0].text, /✅ .*read-only/);
  await tools.get("remove_channel_folder")({ path: COMERCIAL });
  // Removing the root makes an already-stored entry fail closed at spawn, like any other refusal.
  await saveSettings({ fsRoots: [] });
  assert.deepEqual(allowedFsRoots(), [PRIMARY]);
  assert.match(validateExtraFolder(COMERCIAL, { slug: chan.slug, workDir: PROJECT }).error, /outside the allowed root/);
});
