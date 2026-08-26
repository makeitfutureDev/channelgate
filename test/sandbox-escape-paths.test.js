import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { buildSettings } = await import("../src/gateway/folders.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");

// Confinement is the product. When a channel's folder must be writable (allowBash/autoMode, or
// just the MEMORY.md grant) the blanket $HOME write-deny is swapped for an enumerated deny list —
// so anything missing from that list is writable. These are the paths whose contents the HOST
// later EXECUTES: writing one buys code execution outside the sandbox on the next shell, login,
// or daemon restart. A delayed escape is still an escape.

const home = os.homedir();
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function denyWriteFor(meta) {
  const settings = await buildSettings({ _slug: "sandbox-escape", allowedMcps: [], ...meta });
  return settings.sandbox.filesystem.denyWrite;
}

// A deny entry covers a path if it IS that path or an ancestor of it.
function covers(denyList, target) {
  return denyList.some((deny) => {
    const rel = path.relative(deny, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

test("a Bash channel cannot write the shell startup files that would run on the next shell", async () => {
  const denyWrite = await denyWriteFor({ allowBash: true });
  for (const rc of [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile"]) {
    assert.ok(covers(denyWrite, path.join(home, rc)), `~/${rc} must be write-denied`);
  }
});

test("a Bash channel cannot write the OS autostart locations", async () => {
  const denyWrite = await denyWriteFor({ allowBash: true });
  for (const p of ["Library/LaunchAgents", "Library/LaunchDaemons", ".config/systemd", ".config/autostart"]) {
    assert.ok(covers(denyWrite, path.join(home, p)), `~/${p} must be write-denied`);
  }
});

test("a Bash channel cannot shadow commands on PATH via ~/bin or ~/.local/bin", async () => {
  const denyWrite = await denyWriteFor({ allowBash: true });
  assert.ok(covers(denyWrite, path.join(home, "bin", "git")));
  assert.ok(covers(denyWrite, path.join(home, ".local", "bin", "node")));
});

test("a Bash channel cannot write the daemon's own checkout — it is executed on the next restart", async () => {
  const denyWrite = await denyWriteFor({ allowBash: true });
  assert.ok(covers(denyWrite, path.join(repoRoot, "src", "server.js")), "the served repo must be write-denied");
});

test("a channel deliberately pointed AT the checkout keeps writing it", async () => {
  // The gateway develops itself from Slack; a custom workdir on the repo must still work.
  const denyWrite = await denyWriteFor({ allowBash: true, workDir: repoRoot });
  assert.ok(!denyWrite.includes(repoRoot), "must not deny the folder it is working in");
});

test("credential stores stay denied alongside the new escape paths", async () => {
  const denyWrite = await denyWriteFor({ allowBash: true });
  for (const p of [".ssh", ".aws", ".gnupg", ".claude", ".npmrc", "Library/Keychains"]) {
    assert.ok(covers(denyWrite, path.join(home, p)), `~/${p} must stay write-denied`);
  }
});

test("another channel's CUSTOM work dir is write-denied, not just the default workspace folders", async () => {
  // The deny list used to be built by readdir'ing the ONE workspace root, which covers only the
  // channels that kept their default folder. A custom workDir is an arbitrary project path
  // elsewhere under the allowed root — precisely where enumeration is the only thing standing
  // between a writable channel and another channel's project, since the sandbox default-allows
  // writes across home. Any channel that knew the path could write it.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cg-workdirs-")));
  const theirs = path.join(root, "their-project");
  const mine = path.join(root, "my-project");
  mkdirSync(theirs);
  mkdirSync(mine);

  const entry = await upsertChannelEntry("C_SIBLING_WORKDIR", { name: "sibling-workdir", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: "C_SIBLING_WORKDIR", workDir: theirs, allowedMcps: [] });

  // Both projects live under the allowed fs root, which is what makes them reachable at all.
  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  try {
    const denyWrite = await denyWriteFor({ allowBash: true, workDir: mine });
    assert.ok(covers(denyWrite, path.join(theirs, "deploy.sh")), "another channel's custom project must be write-denied");
    assert.ok(!covers(denyWrite, path.join(mine, "src", "index.js")), "the run's own project must stay writable");
  } finally {
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("a channel sharing another channel's custom work dir is not denied its own folder", async () => {
  // Deny-wins in the sandbox write model, so an entry that IS (or contains) this run's own folder
  // would brick the run instead of protecting anyone — two channels pointed at one project, or one
  // nested inside another, must not silently lose all writes.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cg-shared-workdir-")));
  const shared = path.join(root, "shared-project");
  mkdirSync(shared);

  const entry = await upsertChannelEntry("C_SHARED_WORKDIR", { name: "shared-workdir", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: "C_SHARED_WORKDIR", workDir: shared, allowedMcps: [] });

  const previousRoot = process.env.CG_FS_ROOT;
  process.env.CG_FS_ROOT = root;
  try {
    const denyWrite = await denyWriteFor({ allowBash: true, workDir: shared });
    assert.ok(!covers(denyWrite, path.join(shared, "src", "index.js")), "the folder this run works in must stay writable");
  } finally {
    if (previousRoot === undefined) delete process.env.CG_FS_ROOT;
    else process.env.CG_FS_ROOT = previousRoot;
  }
});

test("a memory-only read-only channel gets the same deny list (it is writable too)", async () => {
  // memoryEnabled → folderWritable, which is exactly when the enumerated list replaces the
  // blanket home deny — the case most likely to be assumed safe because the label says read-only.
  const denyWrite = await denyWriteFor({ allowBash: false, autoMode: false });
  // Prove we're in the enumerated branch: a blanket $HOME deny would cover every path below and
  // make the assertions meaningless.
  assert.ok(!denyWrite.includes(home), "precondition — memory makes the folder writable, so home is not blanket-denied");
  assert.ok(covers(denyWrite, path.join(home, ".zshrc")));
  assert.ok(covers(denyWrite, path.join(home, "Library", "LaunchAgents")));
});
