// The suite must not leak its own scratch directories. `node --test` gives each test FILE its own
// process, and each one creates a scratch gateway root plus a sibling TMPDIR — roughly three
// hundred directories per `npm test`. Nothing removed them until helpers.js grew an exit handler,
// and on a tmpfs /tmp with a fixed inode budget the accumulation eventually exhausted the inodes
// and failed unrelated work with "unable to open database file".
//
// Two halves, one pinned per test: the exit handler (complete for a process that exits normally)
// and the `pretest` sweeper (the backstop for the exits that run no handler).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { sweepScratchDirs, isScratchName } = await import("../scripts/test-scratch-sweep.mjs");

const HELPERS_URL = pathToFileURL(fileURLToPath(new URL("./helpers.js", import.meta.url))).href;
// The scratch environment is inherited through the environment, so a child that is meant to build
// its OWN must start without it — otherwise ensureTestEnv() short-circuits and creates nothing.
const INHERITED = ["CG_TEST_SCRATCH", "CHANNELGATE_DIR", "CHANNELGATE_DB", "CG_WORKSPACE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];

test("a test process removes every scratch directory the helper created for it", () => {
  // The child gets a TMPDIR of its own, so its scratch root and the TMPDIR sibling both land
  // inside a directory THIS process owns: a broken exit handler fails the assertion below and the
  // leak still goes away with the parent instead of staying in /tmp.
  const sandbox = tempDir("cg-exit-probe-");
  const env = { ...process.env, TMPDIR: sandbox };
  for (const key of INHERITED) delete env[key];

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { ensureTestEnv, trackedTempDirs } from ${JSON.stringify(HELPERS_URL)};
       ensureTestEnv();
       process.stdout.write(JSON.stringify(trackedTempDirs()));`,
    ],
    { encoding: "utf8", env },
  );

  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const created = JSON.parse(child.stdout);
  assert.ok(created.length >= 2, `expected a scratch root and its TMPDIR sibling, got ${child.stdout}`);
  for (const dir of created) {
    assert.equal(path.dirname(dir), sandbox, `${dir} must have been created inside the probe sandbox`);
    assert.equal(existsSync(dir), false, `${dir} survived the process that created it`);
  }
  assert.deepEqual(readdirSync(sandbox), [], "the child left nothing behind in its temp dir");
});

test("the sweeper removes stale scratch roots, keeps live ones, and never touches anything else", () => {
  const root = tempDir("cg-sweep-probe-");
  const old = Date.now() / 1000 - 6 * 60 * 60;
  const make = (name, { stale = false, withChild = false } = {}) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    if (withChild) writeFileSync(path.join(dir, "gateway.db"), "x");
    if (stale) utimesSync(dir, old, old);
    return dir;
  };

  const staleRoot = make("cg-test-aaaa", { stale: true, withChild: true });
  const staleTmp = make("cg-tmp-cg-test-aaaa", { stale: true });
  const staleWorkspace = make("cg-ws-bbbb", { stale: true });
  const liveRoot = make("cg-test-cccc");
  const foreign = make("some-other-tool-dddd", { stale: true });

  assert.equal(isScratchName("cg-test-aaaa"), true);
  assert.equal(isScratchName("some-other-tool-dddd"), false);

  const swept = sweepScratchDirs({ root });
  assert.equal(swept.removed, 3, "the three stale scratch roots are removed");
  assert.equal(swept.recent, 1, "a scratch root touched inside the window is left alone");
  for (const dir of [staleRoot, staleTmp, staleWorkspace]) assert.equal(existsSync(dir), false, `${dir} should be gone`);
  assert.equal(existsSync(liveRoot), true, "a live run's scratch root must survive");
  assert.equal(existsSync(foreign), true, "a directory that is not the suite's must never be removed");

  // Explicitly protected paths survive even when they are stale.
  utimesSync(liveRoot, old, old);
  assert.equal(sweepScratchDirs({ root, keep: [liveRoot] }).removed, 0);
  assert.equal(existsSync(liveRoot), true);
});
