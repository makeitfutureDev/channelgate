// The update's workspace migration (scripts/migrate-workspace.mjs) moves a channel's legacy WORK
// content out of the hidden metadata folder into the visible work folder — the folder a container
// mounts. The daemon's own entries must stay hidden: until 2026-11 the script did not know the
// `runtime` scratch folder, whose `env/` holds a run's environment (and so its secrets) while the
// run starts, and moved it into the work folder on the first update after a channel was created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { CHANNEL_FOLDER_DAEMON_ENTRIES, channelFolder, workspaceFolder } = await import("../src/config/paths.js");
const { envFileDir } = await import("../src/runtimes/container/exec.js");
const { migrateWorkspace } = await import("../scripts/migrate-workspace.mjs");

let count = 0;
async function channel(meta = {}) {
  const channelId = `C_MIGRATE_WS_${++count}`;
  const entry = await upsertChannelEntry(channelId, { name: `migrate-ws-${count}`, type: "channel", platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId, ...meta });
  const hidden = channelFolder(entry.slug, "slack");
  const work = workspaceFolder(entry.slug, "slack");
  mkdirSync(hidden, { recursive: true });
  return { slug: entry.slug, hidden, work };
}
const run = async () => {
  const lines = [];
  const summary = await migrateWorkspace({ log: (line) => lines.push(String(line)) });
  return { summary, lines, text: lines.join("\n") };
};

test("every folder the daemon writes under a channel's metadata folder is on the keep list", () => {
  const target = { slug: "keep-list-probe", platform: "slack" };
  const top = path.relative(channelFolder(target.slug, target.platform), envFileDir(target)).split(path.sep)[0];
  assert.equal(top, "runtime");
  assert.ok(CHANNEL_FOLDER_DAEMON_ENTRIES.includes(top), "the env-file folder must never be migrated into a work folder");
  for (const name of ["meta.json", "sessions.json", ".claude"]) assert.ok(CHANNEL_FOLDER_DAEMON_ENTRIES.includes(name));
});

test("legacy work content moves to the work folder; the daemon's entries and a live env file stay hidden", async () => {
  const c = await channel();
  mkdirSync(path.join(c.hidden, ".claude"), { recursive: true });
  writeFileSync(path.join(c.hidden, ".claude", "settings.json"), "{}");
  writeFileSync(path.join(c.hidden, "sessions.json"), "{}");
  writeFileSync(path.join(c.hidden, "thread-models.json"), "{}");
  mkdirSync(path.join(c.hidden, "runtime", "env"), { recursive: true });
  writeFileSync(path.join(c.hidden, "runtime", "env", "run-1.env"), "FIXTURE_SECRET=not-for-the-container\n", { mode: 0o600 });
  writeFileSync(path.join(c.hidden, "notes.md"), "legacy work\n");
  mkdirSync(path.join(c.hidden, "uploads"));
  writeFileSync(path.join(c.hidden, "uploads", "a.txt"), "upload\n");

  const first = await run();
  assert.equal(readFileSync(path.join(c.work, "notes.md"), "utf8"), "legacy work\n");
  assert.equal(readFileSync(path.join(c.work, "uploads", "a.txt"), "utf8"), "upload\n");
  assert.equal(existsSync(path.join(c.work, "runtime")), false, "runtime scratch never enters the folder a container mounts");
  assert.equal(readFileSync(path.join(c.hidden, "runtime", "env", "run-1.env"), "utf8"), "FIXTURE_SECRET=not-for-the-container\n");
  assert.deepEqual(readdirSync(c.hidden).sort(), [".claude", "runtime", "sessions.json", "thread-models.json"]);
  assert.match(first.text, new RegExp(`${c.slug}: moved 2 item\\(s\\)`));
  assert.doesNotMatch(first.text, /FIXTURE_SECRET|not-for-the-container/);

  // Idempotent: a second update moves nothing and touches nothing.
  const second = await run();
  assert.doesNotMatch(second.text, new RegExp(c.slug));
  assert.equal(existsSync(path.join(c.work, "runtime")), false);
  assert.equal(existsSync(path.join(c.hidden, "runtime", "env", "run-1.env")), true);
});

test("an empty runtime folder an earlier update left in a work folder is removed; anything with content is kept and reported", async () => {
  const empty = await channel();
  mkdirSync(path.join(empty.work, "runtime", "env"), { recursive: true });
  writeFileSync(path.join(empty.work, "keep.txt"), "work\n");
  const bare = await channel();
  mkdirSync(path.join(bare.work, "runtime"), { recursive: true });
  const leaked = await channel();
  mkdirSync(path.join(leaked.work, "runtime", "env"), { recursive: true });
  writeFileSync(path.join(leaked.work, "runtime", "env", "run-9.env"), "FIXTURE_SECRET=leaked-value\n");
  const project = await channel();
  mkdirSync(path.join(project.work, "runtime", "env"), { recursive: true });
  writeFileSync(path.join(project.work, "runtime", "server.js"), "// the project's own runtime folder\n");
  const scratch = await channel();
  mkdirSync(path.join(scratch.work, "runtime", "env"), { recursive: true });
  mkdirSync(path.join(scratch.work, "runtime", "claude-settings"));
  const linked = await channel();
  const elsewhere = tempDir("cg-migrate-ws-link-");
  mkdirSync(linked.work, { recursive: true });
  symlinkSync(elsewhere, path.join(linked.work, "runtime"));
  const file = await channel();
  mkdirSync(file.work, { recursive: true });
  writeFileSync(path.join(file.work, "runtime"), "a file named runtime\n");

  const { summary, text } = await run();
  assert.equal(existsSync(path.join(empty.work, "runtime")), false);
  assert.equal(readFileSync(path.join(empty.work, "keep.txt"), "utf8"), "work\n");
  assert.equal(existsSync(path.join(bare.work, "runtime")), false);
  assert.equal(summary.tidied, 2);
  assert.match(text, /2 stray runtime folder\(s\) removed from work folders/);

  assert.equal(readFileSync(path.join(leaked.work, "runtime", "env", "run-9.env"), "utf8"), "FIXTURE_SECRET=leaked-value\n", "never deleted on a guess");
  assert.match(text, new RegExp(`${leaked.work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/runtime/env holds 1 environment file`));
  assert.doesNotMatch(text, /leaked-value/);
  assert.equal(existsSync(path.join(project.work, "runtime", "server.js")), true);
  assert.equal(existsSync(path.join(project.work, "runtime", "env")), true, "a folder with content is left whole");
  assert.equal(existsSync(path.join(scratch.work, "runtime", "claude-settings")), true);
  assert.match(text, new RegExp(`${scratch.slug}/runtime was moved here by an earlier update and is not empty`));
  assert.equal(existsSync(elsewhere), true);
  assert.equal(existsSync(path.join(linked.work, "runtime")), true, "a symlink is never followed or removed");
  assert.equal(readFileSync(path.join(file.work, "runtime"), "utf8"), "a file named runtime\n");
});

test("a conversation with a custom work folder is left alone entirely", async () => {
  const root = tempDir("cg-migrate-ws-custom-");
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  try {
    const workDir = path.join(root, "project");
    mkdirSync(path.join(workDir, "runtime", "env"), { recursive: true });
    const c = await channel({ workDir });
    writeFileSync(path.join(c.hidden, "notes.md"), "stays\n");
    mkdirSync(path.join(c.work, "runtime", "env"), { recursive: true });
    const { text } = await run();
    assert.equal(existsSync(path.join(c.hidden, "notes.md")), true);
    assert.equal(existsSync(path.join(workDir, "runtime", "env")), true);
    assert.equal(existsSync(path.join(c.work, "runtime", "env")), true);
    assert.doesNotMatch(text, new RegExp(c.slug));
  } finally {
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});
