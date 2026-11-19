// Atomic config patches (M4): patchChannelMeta merges only the supplied keys inside a write
// transaction, and saveSettings merges settings.json the same way. Runs against a throwaway
// gateway dir + SQLite file — the env is set BEFORE the store module is imported so getDb()
// opens the scratch DB, never the real ~/.claude-gateway one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

const dir = ensureTestEnv();

const { saveChannelMeta, getChannelMeta, patchChannelMeta, defaultChannelMeta, getUser, setUser, listChannels, upsertChannelEntry } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { getProgressView, saveSettings, settingsForApi, getChannelTemplate, applyChannelTemplate, getDmTemplates } = await import("../src/config/settings.js");

test("a shared owner policy update bounds directory work while snapshotting every follower", async (t) => {
  const root = tempDir("cg-follower-snapshot-scale-");
  const workDir = path.join(root, "shared-project");
  mkdirSync(workDir);
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const db = getDb();
  const count = 128;
  for (let n = 0; n < count; n++) {
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run(`snapshot-scale-${n}`, JSON.stringify({
      channelId: `C_SNAPSHOT_SCALE_${n}`, workDir, access: "approved", allowedUsers: ["U_BEFORE"], model: `local-${n}`,
    }));
  }
  const originalRealpath = fs.realpathSync;
  let resolutions = 0;
  t.mock.method(fs, "realpathSync", function (candidate, ...args) {
    if (path.resolve(String(candidate)) === workDir) resolutions++;
    return Reflect.apply(originalRealpath, this, [candidate, ...args]);
  });
  syncBuiltinESMExports();
  try {
    await patchChannelMeta("snapshot-scale-0", { access: "none", allowedUsers: [] });
    t.diagnostic(`${resolutions} directory resolutions for a ${count}-conversation owner update`);
    assert.ok(resolutions <= 20 * count, `${resolutions} directory resolutions exceed the linear write budget ${20 * count}`);
    const follower = await getChannelMeta(`snapshot-scale-${count - 1}`);
    assert.equal(follower.workspaceLink.slug, "snapshot-scale-0");
    assert.equal(follower.access, "none");
    assert.deepEqual(follower.allowedUsers, []);
    assert.equal(follower.model, `local-${count - 1}`);
    const raw = JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get(`snapshot-scale-${count - 1}`).data);
    assert.equal(raw.access, "none");
    assert.deepEqual(raw.allowedUsers, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    db.prepare("DELETE FROM channel_meta WHERE slug LIKE ?").run("snapshot-scale-%");
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("one metadata patch decides each custom work folder once and reads settings once per snapshot", async (t) => {
  const root = tempDir("cg-patch-hotpath-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const db = getDb();
  const count = 96;
  const custom = 48;
  const dirs = new Set();
  for (let n = 0; n < count; n++) {
    const meta = { channelId: `C_PATCH_HOTPATH_${n}`, access: "approved", allowedUsers: [`U_${n}`], model: `local-${n}` };
    if (n < custom) {
      meta.workDir = path.join(root, "customers", `project-${n}`);
      mkdirSync(meta.workDir, { recursive: true });
      dirs.add(meta.workDir);
    }
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run(`patch-hotpath-${n}`, JSON.stringify(meta));
  }
  const originalRealpath = fs.realpathSync;
  const originalRead = fs.readFileSync;
  let resolutions = 0;
  let settingsReads = 0;
  t.mock.method(fs, "realpathSync", function (candidate, ...args) {
    if (dirs.has(path.resolve(String(candidate)))) resolutions++;
    return Reflect.apply(originalRealpath, this, [candidate, ...args]);
  });
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (path.basename(String(file)) === "settings.json" && String(file).startsWith(dir)) settingsReads++;
    return Reflect.apply(originalRead, this, [file, ...args]);
  });
  syncBuiltinESMExports();
  const measure = async (label, run, snapshots) => {
    resolutions = 0;
    settingsReads = 0;
    const result = await run();
    t.diagnostic(`${label}: ${resolutions} custom-folder resolutions, ${settingsReads} settings reads for ${count} conversations (${custom} custom)`);
    // Two realpaths decide one folder (containment, then the daemon-tree boundary) and a snapshot
    // decides each folder once; the budget leaves room for a third. The old path asked about
    // every folder for every projection:
    // some 50 resolutions and 12 settings reads per CONVERSATION for a single patch.
    assert.ok(resolutions <= snapshots * 3 * (custom + 1), `${label}: ${resolutions} resolutions exceed ${snapshots} snapshot(s) of ${custom} folders`);
    assert.ok(settingsReads <= snapshots * 4, `${label}: ${settingsReads} settings reads for ${snapshots} snapshot(s)`);
    return result;
  };
  try {
    // The Slack membership sweep: one small patch per conversation on every reconnect.
    const patched = await measure("patch", () => patchChannelMeta("patch-hotpath-0", (current) => current.botMembership === "pending" ? null : { botMembership: "pending" }), 2);
    assert.equal(patched.botMembership, "pending");
    assert.equal(patched.workDir, path.join(root, "customers", "project-0"));
    assert.equal(await measure("no-op patch", () => patchChannelMeta("patch-hotpath-0", (current) => current.botMembership === "pending" ? null : { botMembership: "pending" }), 1), null);
    const read = await measure("read", () => getChannelMeta(`patch-hotpath-${count - 1}`), 1);
    assert.equal(read.model, `local-${count - 1}`);
    assert.equal(read.workspaceLink, undefined);

    // The bound must not come from skipping the comparison: pointing a conversation at another
    // one's custom folder still links it to that owner, and leaving unlinks it.
    const joined = await measure("join", () => patchChannelMeta(`patch-hotpath-${count - 1}`, { workDir: path.join(root, "customers", "project-3") }), 2);
    assert.equal(joined.workspaceLink.slug, "patch-hotpath-3");
    assert.deepEqual(joined.allowedUsers, ["U_3"]);
    const left = await measure("leave", () => patchChannelMeta(`patch-hotpath-${count - 1}`, { workDir: "" }), 2);
    assert.equal(left.workspaceLink, undefined);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    db.prepare("DELETE FROM channel_meta WHERE slug LIKE ?").run("patch-hotpath-%");
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("a patch callback editing a linked setting in place is refused and changes nothing", async () => {
  const root = tempDir("cg-patch-alias-");
  const workDir = path.join(root, "shared");
  mkdirSync(workDir);
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  const db = getDb();
  const raw = (slug) => JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get(slug).data);
  db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("patch-alias-owner", JSON.stringify({ channelId: "C_ALIAS_OWNER", workDir, access: "approved", allowedUsers: ["U_OWNER"] }));
  db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("patch-alias-follower", JSON.stringify({ channelId: "C_ALIAS_FOLLOWER", workDir, access: "none", allowedUsers: [] }));
  try {
    assert.equal((await getChannelMeta("patch-alias-follower")).workspaceLink.slug, "patch-alias-owner");
    // The projection handed to the callback carries the OWNER's list. Editing it in place must not
    // edit the snapshot the linked-setting check compares against — that would wave the edit
    // through and store a private access list on the follower.
    await assert.rejects(
      patchChannelMeta("patch-alias-follower", (current) => { current.allowedUsers.push("U_INTRUDER"); return {}; }),
      (error) => error.code === "workspace_setting_linked",
    );
    assert.deepEqual(raw("patch-alias-follower").allowedUsers, []);
    assert.deepEqual(raw("patch-alias-owner").allowedUsers, ["U_OWNER"]);
    assert.deepEqual((await getChannelMeta("patch-alias-follower")).allowedUsers, ["U_OWNER"]);
    // An unlinked conversation's in-place edit is saved as before.
    const owner = await patchChannelMeta("patch-alias-owner", (current) => { current.allowedUsers.push("U_SECOND"); return {}; });
    assert.deepEqual(owner.allowedUsers, ["U_OWNER", "U_SECOND"]);
    assert.deepEqual((await getChannelMeta("patch-alias-follower")).allowedUsers, ["U_OWNER", "U_SECOND"]);
  } finally {
    db.prepare("DELETE FROM channel_meta WHERE slug LIKE ?").run("patch-alias-%");
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("channel listing reads metadata once, preserves missing rows and observes later writes", async (t) => {
  const entries = [];
  for (let n = 0; n < 8; n++) {
    const channelId = `C_LIST_SNAPSHOT_${n}`;
    const entry = await upsertChannelEntry(channelId, { name: `list-snapshot-${n}`, type: "channel", platform: "slack" });
    entries.push(entry);
    if (n !== 7) await saveChannelMeta(entry.slug, { channelId, allowedUsers: ["U_BEFORE"], access: "approved" });
  }
  const db = getDb();
  const prepare = db.prepare;
  let metadataReads = 0;
  t.mock.method(db, "prepare", function (sql, ...args) {
    if (/\bSELECT\b.*\bFROM channel_meta\b/i.test(sql)) metadataReads++;
    return Reflect.apply(prepare, this, [sql, ...args]);
  });
  const first = await listChannels();
  assert.equal(metadataReads, 1, "a listing takes one snapshot, not one full table scan per channel");
  assert.equal(first.find((row) => row.slug === entries[7].slug).meta, null);
  await patchChannelMeta(entries[0].slug, { allowedUsers: [], access: "none" });
  metadataReads = 0;
  const second = await listChannels();
  assert.equal(metadataReads, 1);
  const changed = second.find((row) => row.slug === entries[0].slug).meta;
  assert.deepEqual(changed.allowedUsers, []);
  assert.equal(changed.access, "none");
  assert.deepEqual(first.find((row) => row.slug === entries[0].slug).meta.allowedUsers, ["U_BEFORE"]);
});

test("patchChannelMeta merges only the supplied keys", async () => {
  await saveChannelMeta("chan-a", { adminMode: false, allowBash: false, skills: ["a"] });
  const next = await patchChannelMeta("chan-a", { allowBash: true });
  assert.equal(next.allowBash, true);
  assert.equal(next.adminMode, false); // untouched key survives
  assert.deepEqual(next.skills, ["a"]);
  assert.deepEqual(await getChannelMeta("chan-a"), next);
});

test("patchChannelMeta: two writers patching different keys both persist", async () => {
  await saveChannelMeta("chan-b", { adminMode: false, allowBash: false, memory: false });
  await patchChannelMeta("chan-b", { adminMode: true });
  await patchChannelMeta("chan-b", { memory: true });
  const meta = await getChannelMeta("chan-b");
  assert.equal(meta.adminMode, true); // NOT clobbered by the second patch
  assert.equal(meta.memory, true);
  assert.equal(meta.allowBash, false);
});

test("retired conversation-level nudge fields cannot be read or written back", async () => {
  await saveChannelMeta("chan-retired-nudges", { channelId: "C_OLD", nudges: true, memory: true });
  assert.deepEqual(await getChannelMeta("chan-retired-nudges"), { channelId: "C_OLD", memory: true });
  const next = await patchChannelMeta("chan-retired-nudges", { nudges: false, allowBash: true });
  assert.equal(Object.hasOwn(next, "nudges"), false);
  assert.equal(next.allowBash, true);
});

test("patchChannelMeta function form derives the partial from the current record", async () => {
  await saveChannelMeta("chan-c", { allowedMcps: [{ name: "one" }] });
  const next = await patchChannelMeta("chan-c", (cur) => ({ allowedMcps: [...cur.allowedMcps, { name: "two" }] }));
  assert.deepEqual(next.allowedMcps.map((m) => m.name), ["one", "two"]);
});

test("channel and DM-template defaults preserve a separate Codex MCP selection", () => {
  const channel = defaultChannelMeta({ channelId: "C1", name: "one", type: "channel", isDM: false });
  assert.deepEqual(channel.allowedMcps, []);
  assert.deepEqual(channel.allowedCodexMcps, []);

  const templates = getDmTemplates();
  assert.deepEqual(templates.user.allowedCodexMcps, []);
  assert.deepEqual(templates.admin.allowedCodexMcps, []);
});

test("new-channel template defaults to autonomous approved-domain network and round-trips", () => {
  assert.deepEqual(
    { allowBash: getChannelTemplate().allowBash, autoMode: getChannelTemplate().autoMode, allowNetwork: getChannelTemplate().allowNetwork },
    { allowBash: true, autoMode: true, allowNetwork: true },
  );
  saveSettings({ channelTemplate: { ...getChannelTemplate(), allowNetwork: false, skills: ["channel-skill"] } });
  assert.equal(getChannelTemplate().autoMode, true);
  assert.equal(getChannelTemplate().allowNetwork, false);
  assert.deepEqual(settingsForApi().channelTemplate.skills, ["channel-skill"]);
  const seeded = applyChannelTemplate(defaultChannelMeta({ channelId: "C_NEW", name: "new", type: "channel", isDM: false }));
  assert.equal(seeded.autoMode, true);
  assert.equal(seeded.allowNetwork, false);
  assert.equal(seeded.profile, undefined);
  const dm = applyChannelTemplate(defaultChannelMeta({ channelId: "D_NEW", name: "dm", type: "im", isDM: true }));
  assert.equal(dm.autoMode, false);
  assert.equal(dm.allowNetwork, false);
});

test("patchChannelMeta function returning null writes nothing", async () => {
  const res = await patchChannelMeta("chan-missing", (cur) => (cur ? { allowBash: true } : null));
  assert.equal(res, null);
  assert.equal(await getChannelMeta("chan-missing"), null);
});

test("setUser transaction merges field-scoped patches without clearing omitted values", async () => {
  await setUser("U_PATCH", { name: "Ada", approved: true, composioToken: "kept" });
  await setUser("U_PATCH", { approved: false, composioToken: undefined });
  assert.deepEqual(await getUser("U_PATCH"), {
    name: "Ada",
    approved: false,
    isAdmin: false,
    replyMentions: false,
    composioToken: "kept",
    skills: [],
    allowedMcps: [],
    allowedCodexMcps: [],
    allowedOpenCodeMcps: [],
  });
});

test("saveSettings merges only supplied keys and skips undefined", () => {
  saveSettings({ engine: "claude", contextWindow: 200000 });
  saveSettings({ engine: "codex", contextWindow: undefined });
  const stored = JSON.parse(readFileSync(path.join(dir, "config", "settings.json"), "utf8"));
  assert.equal(stored.engine, "codex");
  assert.equal(stored.contextWindow, 200000); // undefined means "leave as-is"
});

test("legacy progressView settings are ignored in favor of native streaming", () => {
  saveSettings({ progressView: "log" });
  const stored = JSON.parse(readFileSync(path.join(dir, "config", "settings.json"), "utf8"));
  assert.equal(stored.progressView, "log"); // legacy value may remain on disk
  assert.equal(getProgressView(), "stream");
  assert.equal(settingsForApi().progressView, "stream");
});
