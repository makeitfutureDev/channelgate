// scripts/migrate-channelgate.mjs — the one-time move to ~/.channelgate + ~/ChannelGate/<platform>.
//
// Everything here runs against a fixture built in a temp directory: the real runtime root and the
// real workspace are never touched, and the migration is driven through its explicit root options
// rather than through $HOME.
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  migrateChannelGate, moveTree, buildPathRewrites, rewritePath, busyReason, applyFallback,
  claudeProjectDirName, CLAUDE_PROJECT_NAME_MAX, rewriteTextOccurrences, rewriteJsonlFile,
  auditLegacyPaths, formatAudit, repathChannelGate, classifyJsonPaths, findTextOccurrences,
  CLAUDE_STATE_KEYPATHS, CODEX_STATE_KEYPATHS, parsePathPairs, mergeRules,
} = await import("../scripts/migrate-channelgate.mjs");
const { saveChannelMeta, upsertChannelEntry, getChannelMeta } = await import("../src/config/store.js");
const { getDb, toJson, fromJson } = await import("../src/db/index.js");

// This file drives the migration against a temp fixture, so the store is emptied between tests:
// migrateChannelGate() walks EVERY channel record, and a leftover from an earlier fixture would
// change the counts it reports.
function resetStore() {
  const db = getDb();
  for (const table of ["channels", "channel_meta", "bg_jobs"]) db.exec(`DELETE FROM ${table}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// The pre-rename layout: a flat channels/<slug> under the runtime root and a flat <slug> under the
// workspace root. Four channels — two Slack, one Teams, one with a custom workDir — plus a stored
// absolute path (a background job's log file + cwd) that must be repointed.
async function buildLegacyFixture(t) {
  resetStore();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-migrate-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const legacyRoot = path.join(temp, ".claude-gateway");
  const newRoot = path.join(temp, ".channelgate");
  const legacyWorkspace = path.join(temp, "Slack Agent");
  const newWorkspace = path.join(temp, "ChannelGate");
  const custom = path.join(temp, "projects", "acme-site");

  const channels = [
    { channelId: "C-ops", slug: "ops", platform: "slack" },
    { channelId: "C-design", slug: "design", platform: "slack" },
    { channelId: "teams:19-eng", slug: "engineering", platform: "msteams" },
    { channelId: "C-acme", slug: "acme", platform: "slack", workDir: custom },
  ];

  for (const c of channels) {
    await mkdir(path.join(legacyRoot, "channels", c.slug, ".claude"), { recursive: true });
    await writeFile(path.join(legacyRoot, "channels", c.slug, "meta.json"), JSON.stringify({ name: c.slug }));
    await writeFile(path.join(legacyRoot, "channels", c.slug, ".claude", "settings.json"), JSON.stringify({ stale: legacyRoot }));
    if (c.workDir) {
      await mkdir(c.workDir, { recursive: true });
      await writeFile(path.join(c.workDir, "PROJECT.md"), `# ${c.slug}\n`);
    } else {
      await mkdir(path.join(legacyWorkspace, c.slug), { recursive: true });
      await writeFile(path.join(legacyWorkspace, c.slug, "NOTES.md"), `# ${c.slug}\n`);
    }
  }
  await mkdir(path.join(legacyRoot, "clean-workspaces", "ops"), { recursive: true });
  await writeFile(path.join(legacyRoot, "clean-workspaces", "ops", "scratch.txt"), "clean\n");
  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  // Real gateway STATE in the old root — that, not the directory's mere existence, is what makes
  // the migration recognise it as an install worth moving.
  await mkdir(path.join(legacyRoot, "config"), { recursive: true });
  await writeFile(path.join(legacyRoot, "config", "settings.json"), JSON.stringify({ port: 4747 }));
  await writeFile(path.join(legacyRoot, "update-state.json"), JSON.stringify({ phase: "idle", logFile: path.join(legacyRoot, "logs", "update.log") }, null, 2));

  // The path helpers must resolve to the fixture too: the migration regenerates each channel's
  // sandbox through the normal ensureChannelFolder path, which reads them.
  const prev = { root: process.env.CHANNELGATE_DIR, ws: process.env.CG_WORKSPACE_DIR, fs: process.env.CG_FS_ROOT };
  process.env.CHANNELGATE_DIR = newRoot;
  process.env.CG_WORKSPACE_DIR = newWorkspace;
  // The custom-workDir channel's project lives in the fixture, so the allowed filesystem root has
  // to cover it — otherwise effectiveWorkDir's containment check rejects the stored dir and the
  // channel silently falls back to the default folder, which is not what this fixture models.
  process.env.CG_FS_ROOT = temp;
  t.after(() => {
    process.env.CHANNELGATE_DIR = prev.root;
    process.env.CG_WORKSPACE_DIR = prev.ws;
    if (prev.fs === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = prev.fs;
  });

  return { temp, legacyRoot, newRoot, legacyWorkspace, newWorkspace, custom, channels };
}

// Register the fixture's channels in the (scratch) store so the migration reads real records.
async function registerChannels(fixture) {
  for (const c of fixture.channels) {
    await upsertChannelEntry(c.channelId, { name: c.slug, type: "channel", isDM: false, platform: c.platform });
    await saveChannelMeta(c.slug, { name: c.slug, platform: c.platform, ...(c.workDir ? { workDir: c.workDir } : {}) });
  }
}

function runOptions(fixture, extra = {}) {
  return {
    legacyRoot: fixture.legacyRoot,
    newRoot: fixture.newRoot,
    legacyWorkspace: fixture.legacyWorkspace,
    newWorkspace: fixture.newWorkspace,
    log: () => {},
    ...extra,
  };
}

test("the pre-rename layout migrates to the new roots with a platform folder per channel", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);

  const summary = await migrateChannelGate(runOptions(fx));

  assert.equal(summary.ran, true);
  assert.equal(summary.failed, undefined);
  // The runtime root moved wholesale...
  assert.ok(await exists(fx.newRoot));
  assert.ok(await exists(path.join(fx.newRoot, "logs")));
  // ...and each channel's metadata folder gained its platform component.
  assert.ok(await exists(path.join(fx.newRoot, "channels", "slack", "ops", "meta.json")));
  assert.ok(await exists(path.join(fx.newRoot, "channels", "slack", "design", "meta.json")));
  assert.ok(await exists(path.join(fx.newRoot, "channels", "teams", "engineering", "meta.json")));
  assert.equal(await exists(path.join(fx.newRoot, "channels", "ops")), false);
  assert.equal(await exists(path.join(fx.newRoot, "channels", "engineering")), false);

  // Visible work folders moved into <workspace>/<platform>/<slug>, content intact.
  assert.equal(await readFile(path.join(fx.newWorkspace, "slack", "ops", "NOTES.md"), "utf8"), "# ops\n");
  assert.equal(await readFile(path.join(fx.newWorkspace, "teams", "engineering", "NOTES.md"), "utf8"), "# engineering\n");
  assert.equal(await exists(path.join(fx.legacyWorkspace, "ops")), false);

  // Clean-mode workspaces follow the same rule.
  assert.ok(await exists(path.join(fx.newRoot, "clean-workspaces", "slack", "ops", "scratch.txt")));

  // A custom workDir is never moved and never namespaced — it is the operator's project.
  assert.equal(await readFile(path.join(fx.custom, "PROJECT.md"), "utf8"), "# acme\n");
  assert.equal(await exists(path.join(fx.newWorkspace, "slack", "acme")), false);

  // Breadcrumbs in both old locations.
  assert.match(await readFile(path.join(fx.legacyRoot, "MOVED.md"), "utf8"), /ChannelGate/);
  assert.match(await readFile(path.join(fx.legacyRoot, "MOVED.md"), "utf8"), new RegExp(fx.newRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await readFile(path.join(fx.legacyWorkspace, "MOVED.md"), "utf8"), /<platform>/);
  // The old runtime root now holds ONLY the breadcrumb.
  assert.deepEqual(await readdir(fx.legacyRoot), ["MOVED.md"]);

  assert.equal(summary.channels, 4);
  assert.equal(summary.workspaces, 3);
  assert.equal(summary.metaFolders, 4);
  assert.equal(summary.cleanWorkspaces, 1);
});

test("stored absolute paths under the moved roots are rewritten; a custom workDir is left alone", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);

  // A durable background job whose cwd and log file both point into the pre-rename layout, plus a
  // meta record whose custom workDir sits OUTSIDE the moved roots.
  const jobId = `job-${Date.now()}`;
  getDb()
    .prepare("INSERT INTO bg_jobs(id, data) VALUES(?, ?)")
    .run(jobId, toJson({ id: jobId, slug: "ops", cwd: path.join(fx.legacyWorkspace, "ops"), logFile: path.join(fx.legacyRoot, "logs", `${jobId}.log`) }));

  await migrateChannelGate(runOptions(fx));

  const row = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(jobId).data, {});
  assert.equal(row.cwd, path.join(fx.newWorkspace, "slack", "ops"));
  assert.equal(row.logFile, path.join(fx.newRoot, "logs", `${jobId}.log`));

  assert.equal((await getChannelMeta("acme")).workDir, fx.custom, "a custom workDir must survive verbatim");

  // The update-state file that lives in the runtime root is repathed too.
  const state = JSON.parse(await readFile(path.join(fx.newRoot, "update-state.json"), "utf8"));
  assert.equal(state.logFile, path.join(fx.newRoot, "logs", "update.log"));
});

test("every channel's sandbox settings file is regenerated with the new absolute paths", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);

  const summary = await migrateChannelGate(runOptions(fx));
  assert.equal(summary.regenerated, 4, JSON.stringify(summary.errors));

  const teams = JSON.parse(await readFile(path.join(fx.newRoot, "channels", "teams", "engineering", ".claude", "settings.json"), "utf8"));
  assert.equal(teams.stale, undefined, "the pre-rename settings file must be replaced, not merged");
  assert.ok(
    teams.sandbox.filesystem.allowWrite.some((p) => p.includes(path.join(fx.newWorkspace, "teams", "engineering"))),
    JSON.stringify(teams.sandbox.filesystem.allowWrite),
  );
  assert.equal(JSON.stringify(teams).includes(fx.legacyWorkspace), false);
});

test("--dry-run prints the plan and changes nothing on disk", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const lines = [];

  const summary = await migrateChannelGate(runOptions(fx, { dryRun: true, log: (l) => lines.push(l) }));

  assert.equal(summary.dryRun, true);
  assert.equal(await exists(fx.newRoot), false, "the new runtime root must not be created");
  assert.equal(await exists(fx.newWorkspace), false, "the new workspace must not be created");
  assert.ok(await exists(path.join(fx.legacyRoot, "channels", "ops", "meta.json")));
  assert.ok(await exists(path.join(fx.legacyWorkspace, "ops", "NOTES.md")));
  assert.equal(await exists(path.join(fx.legacyRoot, "MOVED.md")), false, "no breadcrumb on a dry run");

  const plan = lines.join("\n");
  assert.match(plan, /DRY RUN/);
  assert.match(plan, new RegExp(`runtime root\\s+${fx.legacyRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} →`));
  assert.match(plan, /ops:.*→.*ChannelGate\/slack\/ops/);
  assert.match(plan, /engineering:.*→.*ChannelGate\/teams\/engineering/);
  assert.match(plan, /acme: custom workDir — left untouched/);
  // The plan must be COMPLETE, not just the parts that happen to be visible after a real move:
  // on a dry run the runtime root has not moved, so the per-channel folders are still inspected
  // (and counted) at their pre-rename location.
  assert.match(plan, /engineering: channels\/engineering → channels\/teams\/engineering/);
  assert.match(plan, /ops: clean-workspaces\/ops → clean-workspaces\/slack\/ops/);
  assert.equal(summary.metaFolders, 4);
  assert.equal(summary.cleanWorkspaces, 1);
  assert.equal(summary.workspaces, 3);
});

test("a dry run reads the OLD database read-only and creates nothing under the new root", async (t) => {
  const fx = await buildLegacyFixture(t);
  // No CHANNELGATE_DB: this is the shape a real un-migrated machine has, where dbFile() resolves
  // INSIDE the new runtime root. Opening it through getDb() would create that root — and the real
  // migration would then refuse to move anything, because the destination now exists.
  const prevDb = process.env.CHANNELGATE_DB;
  delete process.env.CHANNELGATE_DB;
  t.after(() => {
    if (prevDb === undefined) delete process.env.CHANNELGATE_DB;
    else process.env.CHANNELGATE_DB = prevDb;
  });

  // A standalone database in the OLD root, holding the same records as the fixture.
  const { DatabaseSync } = await import("node:sqlite");
  const legacyDb = new DatabaseSync(path.join(fx.legacyRoot, "gateway.db"));
  legacyDb.exec("CREATE TABLE channels (channel_id TEXT PRIMARY KEY, slug TEXT NOT NULL, data TEXT NOT NULL)");
  legacyDb.exec("CREATE TABLE channel_meta (slug TEXT PRIMARY KEY, data TEXT NOT NULL)");
  for (const c of fx.channels) {
    legacyDb.prepare("INSERT INTO channels(channel_id, slug, data) VALUES(?, ?, ?)").run(c.channelId, c.slug, JSON.stringify({ slug: c.slug, name: c.slug }));
    legacyDb.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run(c.slug, JSON.stringify({ platform: c.platform, ...(c.workDir ? { workDir: c.workDir } : {}) }));
  }
  legacyDb.close();

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { dryRun: true, log: (l) => lines.push(l) }));

  assert.equal(summary.channels, 4, "the plan must see the channels in the OLD database");
  assert.match(lines.join("\n"), /engineering: channels\/engineering → channels\/teams\/engineering/);
  assert.equal(existsSync(fx.newRoot), false, "a dry run must not create the new runtime root (not even a database in it)");
});

test("an existing destination is never clobbered", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // Someone already created the new folder for #ops and put work in it.
  await mkdir(path.join(fx.newWorkspace, "slack", "ops"), { recursive: true });
  await writeFile(path.join(fx.newWorkspace, "slack", "ops", "NOTES.md"), "# already here\n");

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { log: (l) => lines.push(l) }));

  assert.equal(await readFile(path.join(fx.newWorkspace, "slack", "ops", "NOTES.md"), "utf8"), "# already here\n");
  // The source is left in place rather than merged or deleted.
  assert.equal(await readFile(path.join(fx.legacyWorkspace, "ops", "NOTES.md"), "utf8"), "# ops\n");
  assert.match(lines.join("\n"), /ops: SKIPPED — .* already exists \(never clobbered\)/);
  assert.equal(summary.workspaces, 2);
});

test("a cross-device rename falls back to copy + verify + remove", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // Injected rename that fails EXDEV for the runtime root only, exactly as a move across
  // filesystems would (~/ on one disk, the workspace on another).
  let exdevHits = 0;
  const rename = async (from, to) => {
    if (from === fx.legacyRoot) {
      exdevHits++;
      const error = new Error("EXDEV: cross-device link not permitted");
      error.code = "EXDEV";
      throw error;
    }
    const { rename: real } = await import("node:fs/promises");
    return real(from, to);
  };

  const summary = await migrateChannelGate(runOptions(fx, { rename }));

  assert.equal(exdevHits, 1);
  assert.equal(summary.movedRoot, "copy");
  assert.ok(await exists(path.join(fx.newRoot, "logs")));
  assert.ok(await exists(path.join(fx.newRoot, "channels", "slack", "design", "meta.json")));
  // The source is removed only after the copy verifies.
  assert.deepEqual(await readdir(fx.legacyRoot), ["MOVED.md"]);
});

test("moveTree refuses to delete the source when the copy did not land intact", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-move-verify-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const from = path.join(temp, "src");
  await mkdir(path.join(from, "nested"), { recursive: true });
  await writeFile(path.join(from, "nested", "a.txt"), "aaa");
  await writeFile(path.join(from, "b.txt"), "bbb");
  const rename = async () => {
    const error = new Error("EXDEV");
    error.code = "EXDEV";
    throw error;
  };
  // A copy that drops one file — the failure mode the verification exists to catch, and the one
  // that would otherwise destroy data because the source is removed straight afterwards.
  const lossyCopy = async (src, dst) => {
    await mkdir(path.join(dst, "nested"), { recursive: true });
    await writeFile(path.join(dst, "nested", "a.txt"), await readFile(path.join(src, "nested", "a.txt"), "utf8"));
  };
  await assert.rejects(() => moveTree(from, path.join(temp, "dst"), { rename, copy: lossyCopy }), /copy verification failed: b\.txt is missing/);
  assert.ok(existsSync(path.join(from, "b.txt")), "the source must survive a failed verification");

  // A copy that changes a file's contents is caught too.
  const truncatingCopy = async (src, dst) => {
    await mkdir(path.join(dst, "nested"), { recursive: true });
    await writeFile(path.join(dst, "nested", "a.txt"), "");
    await writeFile(path.join(dst, "b.txt"), "");
  };
  await assert.rejects(() => moveTree(from, path.join(temp, "dst2"), { rename, copy: truncatingCopy }), /copy verification failed: .* differs/);
  assert.ok(existsSync(path.join(from, "b.txt")));
});

test("the migration refuses while the pre-rename daemon or a detached job is still running", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // A singleton lock held by THIS process is, as far as the check is concerned, a live daemon.
  await writeFile(path.join(fx.legacyRoot, "gateway.lock"), JSON.stringify({ pid: process.pid, token: "x" }));

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { log: (l) => lines.push(l) }));

  assert.equal(summary.ran, false);
  assert.match(summary.refused, /pre-rename daemon is running/);
  assert.match(lines.join("\n"), /REFUSED/);
  assert.equal(await exists(fx.newRoot), false, "a refusal must not move anything");
  assert.ok(await exists(path.join(fx.legacyWorkspace, "ops", "NOTES.md")));

  // A dead pid in the lock is not a blocker.
  await writeFile(path.join(fx.legacyRoot, "gateway.lock"), JSON.stringify({ pid: 0x7ffffff, token: "x" }));
  assert.equal(await busyReason(fx.legacyRoot, { readActiveJobPids: async () => [] }), "");
  // A live detached background job is.
  assert.match(
    await busyReason(fx.legacyRoot, { readActiveJobPids: async () => [process.pid] }),
    /detached background job\(s\) are still running/,
  );
  // An in-flight self-update transaction is too.
  await writeFile(path.join(fx.legacyRoot, "update.lock"), JSON.stringify({ pid: process.pid }));
  assert.match(await busyReason(fx.legacyRoot, { readActiveJobPids: async () => [] }), /self-update transaction is in flight/);
});

test("after a refusal the daemon is pinned back onto the pre-rename roots", async (t) => {
  const fx = await buildLegacyFixture(t);
  const env = {};
  const pinned = await applyFallback({
    env,
    legacyRoot: fx.legacyRoot,
    newRoot: fx.newRoot,
    legacyWorkspace: fx.legacyWorkspace,
    newWorkspace: fx.newWorkspace,
    log: () => {},
  });
  assert.equal(pinned, true);
  // Env override, not a symlink: reversible, leaves nothing on disk, and a symlinked runtime root
  // would defeat the channel sandbox's wholesale read-deny on that root.
  assert.equal(env.CHANNELGATE_DIR, fx.legacyRoot);
  assert.equal(env.CG_WORKSPACE_DIR, fx.legacyWorkspace);
  assert.equal(existsSync(fx.newRoot), false);
});

test("a stray empty new root is a leftover, not an install: the old root is merged into it", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // Exactly the accident this guards against: something (a test that forgot to pin its env, an
  // engine probe, a curious admin) created the new root with a synthetic engine home in it and
  // nothing else. Existence alone must not make the migration skip forever.
  await mkdir(path.join(fx.newRoot, "engine-state", "opencode", "home"), { recursive: true });

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { log: (l) => lines.push(l) }));

  assert.equal(summary.rootMode, "merge");
  assert.match(lines.join("\n"), /destination exists but holds no state — merging into it/);
  // The old install's contents are now under the new root, alongside the leftover.
  assert.ok(await exists(path.join(fx.newRoot, "config", "settings.json")));
  assert.ok(await exists(path.join(fx.newRoot, "logs")));
  assert.ok(await exists(path.join(fx.newRoot, "engine-state", "opencode", "home")), "the leftover survives");
  assert.ok(await exists(path.join(fx.newRoot, "channels", "slack", "ops", "meta.json")));
  assert.deepEqual(summary.collisions, []);
  // The old root keeps only its breadcrumb.
  assert.deepEqual(await readdir(fx.legacyRoot), ["MOVED.md"]);
});

test("a merge never overwrites: a colliding entry is reported and the old copy stays put", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // Stateless leftover (no gateway.db, no config/) that nonetheless already has a `logs/`.
  await mkdir(path.join(fx.newRoot, "logs"), { recursive: true });
  await writeFile(path.join(fx.newRoot, "logs", "keep.log"), "leftover\n");

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { log: (l) => lines.push(l) }));

  assert.equal(summary.rootMode, "merge");
  assert.deepEqual(summary.collisions, ["logs"]);
  assert.match(lines.join("\n"), /COLLISION: .*logs already exists — left .* in place, nothing overwritten/);
  assert.equal(await readFile(path.join(fx.newRoot, "logs", "keep.log"), "utf8"), "leftover\n");
  // The old copy is untouched, for a human to reconcile.
  assert.ok(await exists(path.join(fx.legacyRoot, "logs")));
  // Everything that did NOT collide still moved.
  assert.ok(await exists(path.join(fx.newRoot, "config", "settings.json")));
});

test("a new root that already holds gateway state is never merged into", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await mkdir(fx.newRoot, { recursive: true });
  await writeFile(path.join(fx.newRoot, "gateway.db"), "live install\n");

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { log: (l) => lines.push(l) }));

  assert.equal(summary.rootMode, "blocked");
  assert.match(lines.join("\n"), /already holds gateway state — NOT touching it/);
  assert.equal(await readFile(path.join(fx.newRoot, "gateway.db"), "utf8"), "live install\n");
  // The pre-rename root is left exactly as it was — no breadcrumb, nothing moved out of it.
  assert.ok(await exists(path.join(fx.legacyRoot, "config", "settings.json")));
  assert.equal(await exists(path.join(fx.legacyRoot, "MOVED.md")), false);
});

test("an empty new workspace root does not stop the per-channel work folders from moving", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await mkdir(fx.newWorkspace, { recursive: true }); // exists, but holds no channel folders

  const summary = await migrateChannelGate(runOptions(fx));

  assert.equal(summary.workspaces, 3);
  assert.equal(await readFile(path.join(fx.newWorkspace, "slack", "ops", "NOTES.md"), "utf8"), "# ops\n");
});

test("a dry run bypasses the busy gate, reports it, and still changes nothing", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  // The live daemon's singleton lock — the state an operator is actually in when they want a
  // preview. A real run must refuse; a dry run must still print the whole plan.
  await writeFile(path.join(fx.legacyRoot, "gateway.lock"), JSON.stringify({ pid: process.pid, token: "x" }));

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { dryRun: true, log: (l) => lines.push(l) }));
  const plan = lines.join("\n");

  assert.equal(summary.ran, true, "a dry run is not refused");
  assert.match(summary.busy, /pre-rename daemon is running/);
  // Reported as the FIRST plan line, so the preview says plainly what a real run would do.
  assert.equal(lines[1], `[migrate] plan:`);
  assert.match(lines[2], /^ {2}• busy: .*pre-rename daemon is running.* — a real run would refuse right now$/);
  // ...and the plan is complete.
  assert.match(plan, /ops: channels\/ops → channels\/slack\/ops/);
  assert.match(plan, /engineering: channels\/engineering → channels\/teams\/engineering/);
  assert.match(plan, /acme: custom workDir — left untouched/);
  assert.equal(summary.channels, 4);
  // Strictly read-only.
  assert.equal(existsSync(fx.newRoot), false);
  assert.equal(existsSync(fx.newWorkspace), false);
  assert.equal(await exists(path.join(fx.legacyRoot, "MOVED.md")), false);
  assert.ok(await exists(path.join(fx.legacyRoot, "channels", "ops", "meta.json")));

  // The same fixture, run for real, still refuses.
  const realLines = [];
  const real = await migrateChannelGate(runOptions(fx, { log: (l) => realLines.push(l) }));
  assert.equal(real.ran, false);
  assert.match(real.refused, /pre-rename daemon is running/);
  assert.match(realLines.join("\n"), /REFUSED/);
  assert.equal(existsSync(fx.newRoot), false);
});

test("re-running the migration is a no-op", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await migrateChannelGate(runOptions(fx));
  const second = await migrateChannelGate(runOptions(fx));
  assert.equal(second.movedRoot, "");
  assert.equal(second.workspaces, 0);
  assert.equal(second.metaFolders, 0);
  assert.equal(second.failed, undefined);
});

test("path rewrite rules are boundary-aware and most-specific-first", () => {
  const rules = buildPathRewrites({
    legacyRoot: "/old/root",
    newRoot: "/new/root",
    legacyWorkspace: "/old/ws",
    newWorkspace: "/new/ws",
    channels: [
      { slug: "ops", platform: "slack", customWorkDir: false },
      { slug: "eng", platform: "msteams", customWorkDir: false },
      { slug: "acme", platform: "slack", customWorkDir: true },
    ],
  });
  // Channel-specific rules beat the bare root prefix.
  assert.equal(rewritePath("/old/root/channels/ops/meta.json", rules), "/new/root/channels/slack/ops/meta.json");
  assert.equal(rewritePath("/new/root/channels/eng", rules), "/new/root/channels/teams/eng");
  assert.equal(rewritePath("/old/root/logs/update.log", rules), "/new/root/logs/update.log");
  assert.equal(rewritePath("/old/ws/ops/NOTES.md", rules), "/new/ws/slack/ops/NOTES.md");
  // A channel with a custom workDir has no workspace rule, so a path under the old workspace that
  // was NOT moved stays exactly as it is.
  assert.equal(rewritePath("/old/ws/acme/PROJECT.md", rules), "/old/ws/acme/PROJECT.md");
  // Boundary: "ops-archive" is not "ops".
  assert.equal(rewritePath("/old/root/channels/ops-archive/x", rules), "/new/root/channels/ops-archive/x");
  // Non-absolute and non-string values pass through untouched.
  assert.equal(rewritePath("relative/path", rules), "relative/path");
  assert.equal(rewritePath(42, rules), 42);
});

// ── Extended repath: every store that can hold an absolute path ──────────────────────────────

// Claude Code's own encoding, verified against the shipped CLI (v2.1.246) and against this
// project's production install: 11 channel project directories and the engine home all matched.
test("the Claude project directory encoder matches Claude Code's own rule", () => {
  assert.equal(claudeProjectDirName("/home/management/Slack Agent/int-sales"), "-home-management-Slack-Agent-int-sales");
  // A dot is not alphanumeric either, which is where the double dash comes from.
  assert.equal(
    claudeProjectDirName("/home/management/.claude-gateway/engine-state/claude/home"),
    "-home-management--claude-gateway-engine-state-claude-home",
  );
  assert.equal(claudeProjectDirName("/home/management/ChannelGate/slack/int-sales"), "-home-management-ChannelGate-slack-int-sales");
  assert.equal(claudeProjectDirName("/a_b/c.d/e f"), "-a-b-c-d-e-f");
  // Over 200 characters it truncates and appends a base-36 hash OF THE FULL PATH, so two long
  // siblings cannot collapse onto one name.
  const long = `/x/${"a".repeat(400)}`;
  const encoded = claudeProjectDirName(long);
  assert.ok(encoded.length > CLAUDE_PROJECT_NAME_MAX && encoded.length < CLAUDE_PROJECT_NAME_MAX + 20);
  assert.match(encoded, /^-x-a{197}-[0-9a-z]+$/);
  assert.notEqual(claudeProjectDirName(`${long}b`), encoded);
});

test("text rewriting is boundary-aware and never touches a URL", () => {
  const rules = [["/home/me/Slack Agent/ops", "/home/me/ChannelGate/slack/ops"], ["/home/me/.claude-gateway", "/home/me/.channelgate"]];
  const { text, count } = rewriteTextOccurrences(
    [
      "cwd = /home/me/Slack Agent/ops",
      "log = /home/me/.claude-gateway/logs/x.log",
      "sibling = /home/me/Slack Agent/ops-archive/keep",
      "sibling2 = /home/me/Slack Agent/ops.bak/keep",
      "prose = the project root is /home/me/Slack Agent/ops.",
      "url = https://example.com/home/me/.claude-gateway/docs",
      'toml = [projects."/home/me/Slack Agent/ops"]',
    ].join("\n"),
    rules,
  );
  assert.equal(count, 4);
  assert.match(text, /cwd = \/home\/me\/ChannelGate\/slack\/ops$/m);
  assert.match(text, /log = \/home\/me\/\.channelgate\/logs\/x\.log$/m);
  // A directory whose name merely STARTS with a moved one did not move — including the awkward
  // case where the next character is a dot, which can begin a real extension.
  assert.match(text, /sibling = \/home\/me\/Slack Agent\/ops-archive\/keep$/m);
  assert.match(text, /sibling2 = \/home\/me\/Slack Agent\/ops\.bak\/keep$/m);
  // A dot that ENDS a sentence is a boundary, so prose is repathed too.
  assert.match(text, /prose = the project root is \/home\/me\/ChannelGate\/slack\/ops\.$/m);
  // A link is not a local path.
  assert.match(text, /url = https:\/\/example\.com\/home\/me\/\.claude-gateway\/docs$/m);
  assert.match(text, /toml = \[projects\."\/home\/me\/ChannelGate\/slack\/ops"\]$/m);
});

// Build the Claude/Codex/service/work-folder stores on top of the standard fixture.
async function seedEngineStores(fx) {
  const claudeHome = path.join(fx.legacyRoot, "engine-state", "claude", "home");
  const projects = path.join(claudeHome, ".claude", "projects");
  // Three project dirs: a channel that moved, the engine home itself, and an unrelated repo.
  const opsCwd = path.join(fx.legacyWorkspace, "ops");
  const opsDir = path.join(projects, claudeProjectDirName(opsCwd));
  await mkdir(path.join(opsDir, "sess-1", "subagents"), { recursive: true });
  await writeFile(
    path.join(opsDir, "sess-1.jsonl"),
    [
      JSON.stringify({ type: "ai-title", aiTitle: "no cwd here", sessionId: "sess-1" }),
      JSON.stringify({ type: "user", cwd: opsCwd, uuid: "u1" }),
      JSON.stringify({ type: "assistant", cwd: opsCwd, uuid: "u2" }),
      "",
    ].join("\n"),
  );
  await writeFile(path.join(opsDir, "sess-1", "subagents", "agent-a.jsonl"), `${JSON.stringify({ type: "user", cwd: opsCwd })}\n`);

  const homeDir = path.join(projects, claudeProjectDirName(claudeHome));
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(homeDir, "sess-h.jsonl"), `${JSON.stringify({ type: "user", cwd: claudeHome })}\n`);

  const outsideCwd = "/home/someone/Code/other-project";
  const outsideDir = path.join(projects, claudeProjectDirName(outsideCwd));
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "sess-o.jsonl"), `${JSON.stringify({ type: "user", cwd: outsideCwd })}\n`);

  await writeFile(path.join(claudeHome, ".claude", ".claude.json"), JSON.stringify({ projects: { [opsCwd]: { allowed: true } } }, null, 2));

  // Codex: a threads index, a rollout with a cwd header, and a config.toml keyed by project path.
  const codexHome = path.join(fx.legacyRoot, "engine-state", "codex", "home", ".codex");
  await mkdir(path.join(codexHome, "sessions", "2026"), { recursive: true });
  await mkdir(path.join(codexHome, "shell_snapshots"), { recursive: true });
  const rollout = path.join(codexHome, "sessions", "2026", "rollout-1.jsonl");
  await writeFile(
    rollout,
    [JSON.stringify({ type: "session_meta", payload: { cwd: opsCwd, id: "t1" } }), JSON.stringify({ type: "event", text: "hello" }), ""].join("\n"),
  );
  await writeFile(path.join(codexHome, "config.toml"), `[projects."${opsCwd}"]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(codexHome, "shell_snapshots", "snap.sh"), `cd "${opsCwd}"\n`);
  const { DatabaseSync } = await import("node:sqlite");
  const idx = new DatabaseSync(path.join(codexHome, "state.sqlite"));
  idx.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  idx.prepare("INSERT INTO threads(id, rollout_path) VALUES(?, ?)").run("t1", rollout);
  idx.close();

  return { projects, opsCwd, opsDir, homeDir, outsideDir, claudeHome, codexHome, rollout };
}

test("Claude project directories are renamed from the NEW cwd and their transcripts repathed", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const seeded = await seedEngineStores(fx);

  const summary = await migrateChannelGate(runOptions(fx));

  const projects = path.join(fx.newRoot, "engine-state", "claude", "home", ".claude", "projects");
  const newOpsCwd = path.join(fx.newWorkspace, "slack", "ops");
  const newHome = path.join(fx.newRoot, "engine-state", "claude", "home");
  // Renamed to the encoding of the NEW cwd — never by string-replacing the old directory name.
  assert.ok(await exists(path.join(projects, claudeProjectDirName(newOpsCwd))), "the channel's project dir must follow its cwd");
  assert.ok(await exists(path.join(projects, claudeProjectDirName(newHome))), "the engine home's own project dir must follow the runtime root");
  assert.equal(await exists(path.join(projects, claudeProjectDirName(seeded.opsCwd))), false);
  // A project that did not move is left completely alone.
  assert.ok(await exists(path.join(projects, claudeProjectDirName("/home/someone/Code/other-project"))));

  // Transcripts: every cwd follows, including the per-session subagent trees.
  const moved = path.join(projects, claudeProjectDirName(newOpsCwd));
  const lines = (await readFile(path.join(moved, "sess-1.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(JSON.parse(lines[1]).cwd, newOpsCwd);
  assert.equal(JSON.parse(lines[2]).cwd, newOpsCwd);
  // A line that mentions no moved path is kept BYTE for byte — a migration must not reformat a
  // multi-megabyte transcript it had no reason to touch.
  assert.equal(lines[0], JSON.stringify({ type: "ai-title", aiTitle: "no cwd here", sessionId: "sess-1" }));
  assert.equal(JSON.parse(await readFile(path.join(moved, "sess-1", "subagents", "agent-a.jsonl"), "utf8")).cwd, newOpsCwd);
  assert.ok(summary.claude.renamed >= 2, JSON.stringify(summary.claude));

  // The engine home's own config keys a projects map by absolute cwd.
  const claudeJson = JSON.parse(await readFile(path.join(newHome, ".claude", ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(claudeJson.projects), [newOpsCwd]);
});

test("a transcript line that mentions a moved path but does not parse aborts that file only", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-jsonl-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const rules = [["/old/ws/ops", "/new/ws/slack/ops"]];
  const broken = path.join(temp, "broken.jsonl");
  const raw = `${JSON.stringify({ cwd: "/old/ws/ops" })}\n{"cwd": "/old/ws/ops"  <-- truncated\n`;
  await writeFile(broken, raw);
  const result = await rewriteJsonlFile(broken, rules);
  assert.equal(result.count, 0);
  assert.match(result.error, /line 2 does not parse/);
  assert.equal(await readFile(broken, "utf8"), raw, "a half-rewritten transcript is worse than an un-migrated one");
});

test("Codex index rows, rollout headers, config.toml and shell snapshots all follow the move", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const seeded = await seedEngineStores(fx);

  const summary = await migrateChannelGate(runOptions(fx));

  const codexHome = path.join(fx.newRoot, "engine-state", "codex", "home", ".codex");
  const newOpsCwd = path.join(fx.newWorkspace, "slack", "ops");
  const newRollout = path.join(codexHome, "sessions", "2026", "rollout-1.jsonl");
  const header = JSON.parse((await readFile(newRollout, "utf8")).split("\n")[0]);
  assert.equal(header.payload.cwd, newOpsCwd);
  assert.match(await readFile(path.join(codexHome, "config.toml"), "utf8"), new RegExp(`\\[projects\\."${newOpsCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]`));
  assert.match(await readFile(path.join(codexHome, "shell_snapshots", "snap.sh"), "utf8"), new RegExp(newOpsCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const { DatabaseSync } = await import("node:sqlite");
  const idx = new DatabaseSync(path.join(codexHome, "state.sqlite"), { readOnly: true });
  const row = idx.prepare("SELECT rollout_path FROM threads WHERE id = 't1'").get();
  idx.close();
  assert.equal(row.rollout_path, newRollout, "a resumed Codex thread resolves its rollout through this column");
  assert.equal(summary.codex.indexRows, 1);
  assert.ok(summary.codex.occurrences >= 3, JSON.stringify(summary.codex));
  void seeded;
});

test("typed database columns holding a bare path are rewritten; the events log is not", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const { getDb } = await import("../src/db/index.js");
  const db = getDb();
  const backup = path.join(fx.legacyRoot, "update-backups", "tx1", "gateway.db");
  db.prepare("INSERT INTO usage_repair_batches(id, created_ts, cutoff_usage_id, status, backup_path, data) VALUES(?,?,?,?,?,?)")
    .run("batch-1", "2026-08-01", 0, "applied", backup, "{}");
  db.prepare("INSERT INTO events(ts, event, channel, author, slug, data) VALUES(?,?,?,?,?,?)")
    .run("2026-08-01", "bg_start", "C-ops", "U1", "ops", JSON.stringify({ cwd: path.join(fx.legacyWorkspace, "ops") }));

  const summary = await migrateChannelGate(runOptions(fx));

  assert.equal(
    db.prepare("SELECT backup_path AS p FROM usage_repair_batches WHERE id = 'batch-1'").get().p,
    path.join(fx.newRoot, "update-backups", "tx1", "gateway.db"),
  );
  assert.ok(summary.typedColumns.includes("usage_repair_batches.backup_path"), JSON.stringify(summary.typedColumns));
  // The audit log is a record of what happened; rewriting it would make it say something else.
  const event = JSON.parse(db.prepare("SELECT data AS d FROM events WHERE event = 'bg_start'").get().d);
  assert.equal(event.cwd, path.join(fx.legacyWorkspace, "ops"));
});

test("mcp-catalog, legacy channel JSON and work-folder prose are repathed; run caches are dropped", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const opsCwd = path.join(fx.legacyWorkspace, "ops");
  // A local MCP server whose command names an absolute path under the old workspace.
  await writeFile(
    path.join(fx.legacyRoot, "config", "mcp-catalog.json"),
    JSON.stringify({ servers: [{ name: "local", command: "node", args: [path.join(opsCwd, "tools", "server.mjs")] }] }, null, 2),
  );
  // The agent's own memory, quoting a path it was told to use.
  await mkdir(path.join(opsCwd, "memory"), { recursive: true });
  await writeFile(path.join(opsCwd, "MEMORY.md"), `# Memory\n\n- Reports go in ${opsCwd}/reports\n`);
  await writeFile(path.join(opsCwd, "memory", "deploys.md"), `Deploy log: ${opsCwd}/deploy.log\n`);
  await writeFile(path.join(opsCwd, "CLAUDE.md"), `Project root is ${opsCwd}.\n`);
  // A content-addressed per-run cache: its NAME is the digest of its contents.
  const cache = path.join(fx.legacyRoot, "channels", "ops", "runtime", "claude-settings");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "deadbeef.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: [opsCwd] } } }));

  const summary = await migrateChannelGate(runOptions(fx));

  const newOpsCwd = path.join(fx.newWorkspace, "slack", "ops");
  const catalog = JSON.parse(await readFile(path.join(fx.newRoot, "config", "mcp-catalog.json"), "utf8"));
  assert.equal(catalog.servers[0].args[0], path.join(newOpsCwd, "tools", "server.mjs"));
  assert.match(await readFile(path.join(newOpsCwd, "MEMORY.md"), "utf8"), new RegExp(`${newOpsCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/reports`));
  assert.match(await readFile(path.join(newOpsCwd, "memory", "deploys.md"), "utf8"), /ChannelGate\/slack\/ops\/deploy\.log/);
  assert.match(await readFile(path.join(newOpsCwd, "CLAUDE.md"), "utf8"), /ChannelGate\/slack\/ops\./);
  assert.ok(summary.workFolders.files >= 3, JSON.stringify(summary.workFolders));
  // Rewriting a content-addressed cache would leave a file whose name no longer describes it.
  assert.equal(await exists(path.join(fx.newRoot, "channels", "slack", "ops", "runtime", "claude-settings")), false);
  assert.ok(summary.purgedCaches.length >= 1, JSON.stringify(summary.purgedCaches));
  // The legacy pre-SQLite backups keep working after a restore.
  assert.doesNotMatch(await readFile(path.join(fx.newRoot, "channels", "slack", "ops", "meta.json"), "utf8"), /Slack Agent/);
});

test("service definitions are rewritten and a reload marker is left for the updater", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const fakeHome = path.join(fx.temp, "fake-home");
  const unit = path.join(fakeHome, ".config", "systemd", "user", "claude-gateway.service");
  const plist = path.join(fakeHome, "Library", "LaunchAgents", "com.makeitfuture.channelgate.plist");
  await mkdir(path.dirname(unit), { recursive: true });
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(
    unit,
    `[Service]\nWorkingDirectory=/home/me/Code/channelgate\nStandardOutput=append:${fx.legacyRoot}/logs/systemd.log\nStandardError=append:${fx.legacyRoot}/logs/systemd.err\n`,
  );
  await writeFile(plist, `<key>StandardOutPath</key><string>${fx.legacyRoot}/logs/launchd.out.log</string>\n`);

  const summary = await migrateChannelGate(runOptions(fx, { home: fakeHome }));

  const unitText = await readFile(unit, "utf8");
  assert.match(unitText, new RegExp(`append:${fx.newRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/logs/systemd\\.log`));
  assert.match(unitText, new RegExp(`append:${fx.newRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/logs/systemd\\.err`));
  // The unrelated WorkingDirectory (the repo checkout) is not ours to move.
  assert.match(unitText, /WorkingDirectory=\/home\/me\/Code\/channelgate/);
  assert.match(await readFile(plist, "utf8"), new RegExp(fx.newRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(summary.services.files.length, 2);
  assert.ok(summary.services.reloads.includes("systemctl --user daemon-reload"));
  assert.ok(summary.services.reloads.some((r) => r.includes("launchctl bootout")));

  // Both managers cache the definition, so the migration leaves a marker the updater consumes.
  const marker = JSON.parse(await readFile(path.join(fx.newRoot, "service-reload-required.json"), "utf8"));
  assert.deepEqual(marker.files.sort(), [plist, unit].sort());
});

test("the updater reloads a changed service definition before restarting, once", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-reload-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { applyPendingServiceReload, serviceReloadMarkerFile } = await import("../scripts/update-runner.mjs");
  await writeFile(serviceReloadMarkerFile(temp), JSON.stringify({ files: [path.join(temp, "channelgate.service")], reloads: ["systemctl --user daemon-reload"] }));

  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  const systemd = await applyPendingServiceReload({ root: temp, service: { kind: "systemd", scope: "user", unit: "channelgate.service" }, run, log: () => {} });
  assert.equal(systemd.reloaded, true);
  // daemon-reload alone: the SIGUSR2 restart that follows is what re-execs onto the new unit.
  assert.equal(systemd.restarted, false);
  assert.deepEqual(calls, ["systemctl --user daemon-reload"]);
  // The marker is consumed, so an ordinary later restart does no extra work.
  const again = await applyPendingServiceReload({ root: temp, service: { kind: "systemd", scope: "user" }, run, log: () => {} });
  assert.equal(again.reloaded, false);

  // launchd re-runs the OLD plist on `kickstart -k`; only bootout + bootstrap picks up an edit,
  // and that IS the restart, so the caller must not kickstart afterwards.
  const plist = path.join(temp, "com.makeitfuture.channelgate.plist");
  await writeFile(serviceReloadMarkerFile(temp), JSON.stringify({ files: [plist], reloads: [] }));
  calls.length = 0;
  const launchd = await applyPendingServiceReload({ root: temp, service: { kind: "launchd", label: "com.makeitfuture.channelgate" }, run, log: () => {} });
  assert.equal(launchd.restarted, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^launchctl bootout gui\/\d+\/com\.makeitfuture\.channelgate$/);
  assert.match(calls[1], new RegExp(`^launchctl bootstrap gui/\\d+ ${plist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("--verify reports every store before the migration and nothing after it", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await seedEngineStores(fx);
  const opsCwd = path.join(fx.legacyWorkspace, "ops");
  await writeFile(path.join(opsCwd, "MEMORY.md"), `Reports: ${opsCwd}/reports\n`);
  await writeFile(path.join(fx.legacyRoot, "config", "mcp-catalog.json"), JSON.stringify({ servers: [{ args: [path.join(opsCwd, "s.mjs")] }] }));
  const auditOptions = { legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace };

  const before = await auditLegacyPaths(auditOptions);
  assert.ok(before.total > 0, "the fixture must have something to find");
  const stores = before.groups.map((g) => g.store);
  for (const store of ["Claude project directories (stale names)", "Claude transcripts (cwd fields)", "Codex state", "work folder text", "config + runtime JSON"]) {
    assert.ok(stores.includes(store), `${store} missing from ${JSON.stringify(stores)}`);
  }
  // The printed form names the roots it scanned and totals the finding.
  const printed = formatAudit(before, { title: "verify" }).join("\n");
  assert.match(printed, /verify: scanning/);
  assert.match(printed, /occurrence\(s\) the migration is responsible for/);

  await migrateChannelGate(runOptions(fx));

  const after = await auditLegacyPaths(auditOptions);
  assert.equal(after.total, 0, `still stale: ${JSON.stringify(after.groups, null, 2)}`);
  assert.match(formatAudit(after).join("\n"), /nothing found — every store is on the new paths/);
});

test("a dry run ends with the audit and changes none of the new stores", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  const seeded = await seedEngineStores(fx);
  const before = await readFile(path.join(seeded.opsDir, "sess-1.jsonl"), "utf8");

  const lines = [];
  const summary = await migrateChannelGate(runOptions(fx, { dryRun: true, log: (l) => lines.push(l) }));

  assert.ok(await exists(seeded.opsDir), "a dry run must not rename a project directory");
  assert.equal(await readFile(path.join(seeded.opsDir, "sess-1.jsonl"), "utf8"), before);
  assert.ok(await exists(path.join(seeded.codexHome, "state.sqlite")));
  assert.match(await readFile(path.join(seeded.codexHome, "config.toml"), "utf8"), /Slack Agent/);
  // ...and it still reports what it WOULD do, ending with the audit.
  assert.ok(summary.audit.total > 0);
  const plan = lines.join("\n");
  assert.match(plan, /audit \(pre-migration\)/);
  assert.match(plan, /dry run would leave \d+ occurrence\(s\) behind/);
});

// ── Precision: what `--verify` counts ────────────────────────────────────────────────────────

test("a pre-rename path quoted in message text is history, not state: verify stays 0", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await seedEngineStores(fx);
  await migrateChannelGate(runOptions(fx));

  const oldOpsCwd = path.join(fx.legacyWorkspace, "ops");
  const newOpsCwd = path.join(fx.newWorkspace, "slack", "ops");
  const projects = path.join(fx.newRoot, "engine-state", "claude", "home", ".claude", "projects");
  const dir = path.join(projects, claudeProjectDirName(newOpsCwd));
  // The transcript of a turn that TALKED about the old path: the assistant quoted it, a Bash tool
  // call ran there, and its stdout printed it. Every one of those is a record of what happened.
  await writeFile(
    path.join(dir, "sess-history.jsonl"),
    [
      JSON.stringify({ type: "user", cwd: newOpsCwd, message: { content: [{ type: "text", text: `please read ${oldOpsCwd}/NOTES.md` }] } }),
      JSON.stringify({ type: "assistant", cwd: newOpsCwd, message: { content: [{ type: "tool_use", input: { command: `ls ${oldOpsCwd}` } }] } }),
      JSON.stringify({ type: "user", cwd: newOpsCwd, toolUseResult: { stdout: `${oldOpsCwd}/NOTES.md\n`, filePath: `${oldOpsCwd}/NOTES.md` } }),
      "",
    ].join("\n"),
  );
  const auditOptions = { legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace };

  const audit = await auditLegacyPaths(auditOptions);

  assert.equal(audit.total, 0, `content must never be billed: ${JSON.stringify(audit.groups, null, 2)}`);
  const content = audit.groups.filter((g) => g.kind === "content").reduce((n, g) => n + g.count, 0);
  assert.equal(content, audit.historical);
  assert.ok(content >= 4, `the quoted paths must still be REPORTED: ${JSON.stringify(audit.groups, null, 2)}`);
  assert.match(formatAudit(audit, { title: "verify" }).join("\n"), /historical content — a record of what was said and done/);

  // ...and a repath leaves every one of those bytes alone.
  const before = await readFile(path.join(dir, "sess-history.jsonl"), "utf8");
  await repathChannelGate(runOptions(fx));
  assert.equal(await readFile(path.join(dir, "sess-history.jsonl"), "utf8"), before, "history is never rewritten");
});

test("a custom workDir that happens to sit under the old default root is not a stale project dir", async (t) => {
  const fx = await buildLegacyFixture(t);
  // A channel whose CUSTOM working folder really is ~/Slack Agent/<slug>: the migration leaves it
  // exactly where it is, so the Claude project directory encoding that cwd is correct — the name
  // spells a pre-rename path because the path is still the truth.
  const stayCwd = path.join(fx.legacyWorkspace, "kept-in-place");
  await mkdir(stayCwd, { recursive: true });
  fx.channels.push({ channelId: "C-kept", slug: "kept-in-place", platform: "slack", workDir: stayCwd });
  await registerChannels(fx);
  await seedEngineStores(fx);
  const projects = path.join(fx.legacyRoot, "engine-state", "claude", "home", ".claude", "projects");
  const keptDir = path.join(projects, claudeProjectDirName(stayCwd));
  await mkdir(keptDir, { recursive: true });
  await writeFile(path.join(keptDir, "sess-k.jsonl"), `${JSON.stringify({ type: "user", cwd: stayCwd })}\n`);

  await migrateChannelGate(runOptions(fx));

  // The folder and its project directory both stayed put.
  assert.ok(await exists(stayCwd));
  assert.ok(await exists(path.join(fx.newRoot, "engine-state", "claude", "home", ".claude", "projects", claudeProjectDirName(stayCwd))));

  const audit = await auditLegacyPaths({ legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace });
  assert.equal(audit.total, 0, JSON.stringify(audit.groups, null, 2));
  assert.equal(audit.groups.some((g) => g.store.startsWith("Claude project directories")), false);
  // It is reported, though — the reason the number is zero has to be visible.
  const resolvedGroup = audit.groups.find((g) => g.kind === "resolved");
  assert.ok(resolvedGroup, JSON.stringify(audit.groups, null, 2));
  assert.ok(resolvedGroup.detail.some((d) => d.startsWith(`${stayCwd}:`)), JSON.stringify(resolvedGroup));

  // ...and it becomes a finding the moment the directory really is gone.
  await rm(stayCwd, { recursive: true, force: true });
  const after = await auditLegacyPaths({ legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace });
  assert.ok(after.total > 0);
  assert.ok(after.groups.some((g) => g.store.startsWith("Claude project directories")), JSON.stringify(after.groups, null, 2));
});

test("--repath fixes what a hand migration left behind, and a second run changes nothing", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await seedEngineStores(fx);
  await migrateChannelGate(runOptions(fx));

  const oldOpsCwd = path.join(fx.legacyWorkspace, "ops");
  const newOpsCwd = path.join(fx.newWorkspace, "slack", "ops");
  const projects = path.join(fx.newRoot, "engine-state", "claude", "home", ".claude", "projects");
  const opsDir = path.join(projects, claudeProjectDirName(newOpsCwd));
  const transcript = path.join(opsDir, "sess-1.jsonl");
  // Three stores a hand migration typically misses: a transcript line whose cwd was never
  // repathed, the MCP catalog, and the channel's own memory.
  await writeFile(transcript, `${await readFile(transcript, "utf8")}${JSON.stringify({ type: "user", cwd: oldOpsCwd, uuid: "left-behind" })}\n`);
  await writeFile(path.join(fx.newRoot, "config", "mcp-catalog.json"), JSON.stringify({ servers: [{ args: [path.join(oldOpsCwd, "s.mjs")] }] }));
  await writeFile(path.join(newOpsCwd, "MEMORY.md"), `Reports live in ${oldOpsCwd}/reports\n`);
  // Two content-addressed run caches: one written before the move, one already correct. A repath
  // drops the first — rewriting a file whose NAME is a digest of its contents would be a lie — and
  // must leave the second alone, or every run of it would cold-start a healthy install.
  const staleCache = path.join(fx.newRoot, "channels", "slack", "ops", "runtime", "claude-settings");
  const freshCache = path.join(fx.newRoot, "channels", "slack", "design", "runtime", "claude-settings");
  await mkdir(staleCache, { recursive: true });
  await mkdir(freshCache, { recursive: true });
  await writeFile(path.join(staleCache, "deadbeef.json"), JSON.stringify({ sandbox: { allowWrite: [oldOpsCwd] } }));
  await writeFile(path.join(freshCache, "cafe.json"), JSON.stringify({ sandbox: { allowWrite: [path.join(fx.newWorkspace, "slack", "design")] } }));
  const auditOptions = { legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace };
  assert.ok((await auditLegacyPaths(auditOptions)).total >= 3, "the fixture must have something to repair");

  // A dry run previews and writes nothing.
  const beforeBytes = await readFile(transcript, "utf8");
  const preview = [];
  const dry = await repathChannelGate(runOptions(fx, { dryRun: true, log: (l) => preview.push(l) }));
  assert.equal(dry.rootMode, "repath");
  assert.equal(await readFile(transcript, "utf8"), beforeBytes);
  assert.match(preview.join("\n"), /repath — re-applying every path rewrite against the CURRENT roots; nothing is moved/);
  assert.match(preview.join("\n"), /audit \(repath preview\)/);
  assert.ok((await auditLegacyPaths(auditOptions)).total >= 3, "a dry run repairs nothing");

  // The real thing.
  const first = await repathChannelGate(runOptions(fx));
  assert.equal(first.failed, undefined);
  assert.equal(first.repath, true);
  // Nothing moved: the roots and every channel folder are exactly where they were.
  assert.ok(await exists(path.join(fx.newRoot, "channels", "slack", "ops", "meta.json")));
  assert.ok(await exists(path.join(newOpsCwd, "NOTES.md")));
  assert.equal(await exists(fx.legacyRoot), true, "the breadcrumb directory is not touched either");

  const lines = (await readFile(transcript, "utf8")).split("\n").filter(Boolean);
  assert.equal(JSON.parse(lines[lines.length - 1]).cwd, newOpsCwd);
  assert.equal(JSON.parse(await readFile(path.join(fx.newRoot, "config", "mcp-catalog.json"), "utf8")).servers[0].args[0], path.join(newOpsCwd, "s.mjs"));
  assert.match(await readFile(path.join(newOpsCwd, "MEMORY.md"), "utf8"), new RegExp(`${newOpsCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/reports`));
  assert.deepEqual(first.purgedCaches, [staleCache]);
  assert.ok(await exists(path.join(freshCache, "cafe.json")), "a cache that is already correct is not churned");
  assert.equal((await auditLegacyPaths(auditOptions)).total, 0, "a repath is the fix for exactly what --verify counts");

  // Idempotent: the second run finds nothing left to do and rewrites no byte.
  const settled = await readFile(transcript, "utf8");
  const second = await repathChannelGate(runOptions(fx));
  assert.equal(second.rewrittenRows, 0);
  assert.equal(second.rewrittenFiles, 0);
  assert.equal(second.claude.occurrences, 0);
  assert.equal(second.claude.renamed, 0);
  assert.equal(second.codex.occurrences, 0);
  assert.equal(second.workFolders.occurrences, 0);
  assert.deepEqual(second.purgedCaches, []);
  assert.equal(await readFile(transcript, "utf8"), settled);
  assert.equal(second.audit.total, 0);
});

test("--repath refuses while the daemon is running, unless it is a dry run", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await migrateChannelGate(runOptions(fx));
  await writeFile(path.join(fx.newRoot, "gateway.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));

  const refused = await repathChannelGate(runOptions(fx));
  assert.equal(refused.ran, false);
  assert.match(refused.refused, /daemon is running/);

  const dry = await repathChannelGate(runOptions(fx, { dryRun: true }));
  assert.equal(dry.ran, true, "a dry run reports the blocker and previews anyway");
  assert.match(dry.busy, /daemon is running/);
});

test("the state key allowlist decides per JSON key path, for both engines", () => {
  const rules = [["/home/me/Slack Agent/ops", "/home/me/ChannelGate/slack/ops"]];
  const old = "/home/me/Slack Agent/ops";

  // Claude: the line's own cwd is state; everything the turn said or did is not — including an
  // object KEY that is a path (rewriteDeep walks values, so a key is never rewritten anyway).
  const claude = classifyJsonPaths(
    {
      cwd: old,
      message: { content: [{ type: "text", text: `see ${old}/NOTES.md` }] },
      toolUseResult: { stdout: old, filePath: `${old}/a.md` },
      snapshot: { trackedFileBackups: { [`${old}/a.md`]: { realParentDir: "/elsewhere" } } },
    },
    rules,
    CLAUDE_STATE_KEYPATHS,
  );
  assert.deepEqual(claude.state, [old]);
  assert.equal(claude.content.length, 4);

  // Codex: the session header and the turn context are state. `world_state` is a per-turn snapshot
  // of what the model was SHOWN, re-derived from those two on resume — so it is content.
  const meta = classifyJsonPaths({ type: "session_meta", payload: { cwd: old, id: "t1" } }, rules, CODEX_STATE_KEYPATHS);
  assert.deepEqual(meta.state, [old]);
  const turn = classifyJsonPaths({ type: "turn_context", payload: { cwd: old, workspace_roots: [old] } }, rules, CODEX_STATE_KEYPATHS);
  assert.deepEqual(turn.state, [old, old]);
  const world = classifyJsonPaths(
    {
      type: "world_state",
      payload: {
        full: true,
        state: {
          agents_md: { directory: old, text: `root is ${old}` },
          environments: { environments: { local: { cwd: old } }, filesystem: `<filesystem><workspace_roots><root>${old}</root></workspace_roots></filesystem>` },
        },
      },
    },
    rules,
    CODEX_STATE_KEYPATHS,
  );
  assert.deepEqual(world.state, []);
  assert.equal(world.content.length, 4);

  // The matched token is the WHOLE path, because the audit has to ask whether it still exists.
  assert.deepEqual(findTextOccurrences(`cwd=${old}/reports/a.md`, rules), [`${old}/reports/a.md`]);
});

// ── Operator-supplied path rules (`--repath --from <old> --to <new>`) ────────────────────────
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("--repath --from/--to repaths a custom workDir the operator moved by hand, in every store", async (t) => {
  const fx = await buildLegacyFixture(t);
  await registerChannels(fx);
  await seedEngineStores(fx);
  await migrateChannelGate(runOptions(fx));

  // The operator moves the acme channel's project folder by hand. No rename rule knows about it,
  // so every store still names the old folder — the exact situation a checkout rename leaves.
  const oldCustom = fx.custom;
  const newCustom = path.join(fx.temp, "projects", "acme-platform");
  await rename(oldCustom, newCustom);
  const engineHome = path.join(fx.newRoot, "engine-state", "claude", "home");
  const projects = path.join(engineHome, ".claude", "projects");
  const oldDir = path.join(projects, claudeProjectDirName(oldCustom));
  const newDir = path.join(projects, claudeProjectDirName(newCustom));
  await mkdir(oldDir, { recursive: true });
  await writeFile(path.join(oldDir, "sess-c.jsonl"), `${JSON.stringify({ type: "user", cwd: oldCustom, uuid: "c1" })}\n`);
  const claudeJson = path.join(engineHome, ".claude", ".claude.json");
  await writeFile(claudeJson, JSON.stringify({ projects: { [oldCustom]: { allowed: true } } }, null, 2));
  const codexConfig = path.join(fx.newRoot, "engine-state", "codex", "home", ".codex", "config.toml");
  await writeFile(codexConfig, `[projects."${oldCustom}"]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(newCustom, "MEMORY.md"), `Specs live in ${oldCustom}/specs\n`);
  const staleCache = path.join(fx.newRoot, "channels", "slack", "acme", "runtime", "claude-settings");
  await mkdir(staleCache, { recursive: true });
  await writeFile(path.join(staleCache, "feed.json"), JSON.stringify({ sandbox: { allowWrite: [oldCustom] } }));
  assert.equal((await getChannelMeta("acme")).workDir, oldCustom);

  const auditOptions = { legacyRoot: fx.legacyRoot, newRoot: fx.newRoot, legacyWorkspace: fx.legacyWorkspace, newWorkspace: fx.newWorkspace };
  const extraRules = [[oldCustom, newCustom]];
  // Without the pair the audit has nothing to say: the pre-rename roots are clean, and a folder
  // it was never told about is not its business.
  assert.equal((await auditLegacyPaths(auditOptions)).total, 0);
  const before = await auditLegacyPaths({ ...auditOptions, extraRules });
  assert.ok(before.total >= 4, `the pair must surface the stale stores (found ${before.total})`);
  assert.deepEqual(before.extraFroms, [oldCustom]);
  assert.match(formatAudit(before)[0], new RegExp(` or ${reEscape(oldCustom)}$`));

  // A dry run previews the rule and writes nothing.
  const preview = [];
  const dry = await repathChannelGate(runOptions(fx, { dryRun: true, extraRules, log: (l) => preview.push(l) }));
  assert.deepEqual(dry.extraRules, extraRules);
  assert.match(preview.join("\n"), new RegExp(`path rule\\s+${reEscape(oldCustom)} → ${reEscape(newCustom)} \\(operator-supplied`));
  assert.equal((await getChannelMeta("acme")).workDir, oldCustom);
  assert.equal(await exists(oldDir), true);

  const first = await repathChannelGate(runOptions(fx, { extraRules }));
  assert.equal(first.failed, undefined);
  assert.equal((await getChannelMeta("acme")).workDir, newCustom, "the channel record follows the folder");
  assert.equal(await exists(newDir), true, "the Claude project directory is renamed to the new cwd's encoding");
  assert.equal(await exists(oldDir), false);
  assert.equal(JSON.parse((await readFile(path.join(newDir, "sess-c.jsonl"), "utf8")).trim()).cwd, newCustom);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(claudeJson, "utf8")).projects), [newCustom]);
  assert.match(await readFile(codexConfig, "utf8"), new RegExp(`\\[projects\\."${reEscape(newCustom)}"\\]`));
  assert.equal(await readFile(path.join(newCustom, "MEMORY.md"), "utf8"), `Specs live in ${newCustom}/specs\n`);
  assert.deepEqual(first.purgedCaches, [staleCache]);
  const settings = await readFile(path.join(fx.newRoot, "channels", "slack", "acme", ".claude", "settings.json"), "utf8");
  assert.ok(settings.includes(newCustom) && !settings.includes(oldCustom), "the regenerated sandbox names the new folder");
  assert.equal(first.audit.total, 0, "the post-repath audit counts the pair too");
  assert.equal((await auditLegacyPaths({ ...auditOptions, extraRules })).total, 0);

  // Idempotent with the same pair: nothing left to do, no byte rewritten.
  const second = await repathChannelGate(runOptions(fx, { extraRules }));
  assert.equal(second.rewrittenRows, 0);
  assert.equal(second.rewrittenFiles, 0);
  assert.equal(second.claude.renamed, 0);
  assert.equal(second.claude.occurrences, 0);
  assert.equal(second.codex.occurrences, 0);
  assert.equal(second.workFolders.occurrences, 0);
  assert.deepEqual(second.purgedCaches, []);
  assert.equal(second.audit.total, 0);
});

test("--from/--to pairs are parsed and validated before anything is touched", () => {
  assert.deepEqual(
    parsePathPairs(["--repath", "--from", "/old/a", "--to", "/new/a", "--from", "/old/b", "--to", "/new/b"]),
    [["/old/a", "/new/a"], ["/old/b", "/new/b"]],
  );
  assert.deepEqual(parsePathPairs(["--verify"]), []);
  assert.throws(() => parsePathPairs(["--from", "/old/a"]), /matching --to/);
  assert.throws(() => parsePathPairs(["--from", "/old/a", "--to"]), /needs a path/);
  assert.throws(() => parsePathPairs(["--to", "/new/a"]), /no preceding --from/);
  assert.throws(() => parsePathPairs(["--from", "old/a", "--to", "/new/a"]), /absolute/);
  assert.throws(() => parsePathPairs(["--from", "/same", "--to", "/same"]), /same path/);
  assert.throws(() => parsePathPairs(["--from", "/a", "--to", "/a/b"]), /never settle/);
  assert.throws(() => parsePathPairs(["--from", "/", "--to", "/x"]), /filesystem root/);
  // The most specific rule wins whatever its origin, and a boundary is still a boundary.
  const merged = mergeRules([["/r", "/R"]], [["/r/deep", "/elsewhere"]]);
  assert.deepEqual(merged.map(([from]) => from), ["/r/deep", "/r"]);
  assert.equal(rewritePath("/r/deep/x", merged), "/elsewhere/x");
  assert.equal(rewritePath("/r/deeper/x", merged), "/R/deeper/x");
});

test("the CLI refuses a malformed or misplaced --from/--to with usage, before touching anything", () => {
  const script = new URL("../scripts/migrate-channelgate.mjs", import.meta.url).pathname;
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const missing = run(["--repath", "--from", "/old/only"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /matching --to/);
  assert.match(missing.stderr, /Usage: node scripts\/migrate-channelgate\.mjs/);
  const misplaced = run(["--from", "/old", "--to", "/new"]);
  assert.equal(misplaced.status, 2);
  assert.match(misplaced.stderr, /use them with --repath/);
});
