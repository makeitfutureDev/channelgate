#!/usr/bin/env node
// Remove stale test scratch directories from the system temp dir. Runs as `pretest`, so every
// suite run starts on a clean /tmp.
//
// Why this exists: `node --test` gives each test file its own process and each one creates a
// scratch gateway root plus a sibling TMPDIR (test/helpers.js), so one `npm test` makes roughly
// three hundred directories. Nothing used to remove them. On a host whose /tmp is a tmpfs with a
// fixed inode budget, forty thousand leftovers exhausted the inodes and unrelated work started
// failing with "unable to open database file". helpers.js now removes its own on process exit;
// this sweeper is the backstop for the exits that run no handler — a SIGKILL, a crashed runner, an
// interrupted CI job.
//
// Cheap by construction: one readdir of the temp root and one stat per matching entry — never a
// recursive walk. Five thousand entries stay well under a second.
//
// Not a failure path: a subtree this account cannot remove (another user's run under a sticky
// /tmp, a tree a rootless container created under a sub-uid) is counted and skipped. The sweeper
// always exits 0 — it must never be the reason a test run does not start.
import { readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The prefixes the suite creates directly under os.tmpdir(): the per-process scratch root, its
// TMPDIR sibling, and the workspace roots the container tests pin before ensureTestEnv() runs.
// Everything else a test makes is created AFTER TMPDIR is repointed, so it lives inside a
// `cg-tmp-*` and is removed with it.
export const SCRATCH_PREFIXES = Object.freeze(["cg-test-", "cg-tmp-", "cg-ws-"]);

// Old enough that no live run can own it. Directory mtime moves whenever a direct child is added
// or removed, so an active scratch root keeps refreshing itself well inside this window.
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function isScratchName(name) {
  return SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function sweepScratchDirs({ root = os.tmpdir(), now = Date.now(), maxAgeMs = MAX_AGE_MS, keep = [] } = {}) {
  const result = { root, removed: 0, recent: 0, skipped: 0 };
  // Never touch a directory this very process was pointed at.
  const protectedDirs = new Set(keep.filter(Boolean).map((dir) => path.resolve(dir)));
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result; // no temp dir to sweep is not a problem worth reporting
  }
  const cutoff = now - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isScratchName(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (protectedDirs.has(path.resolve(abs))) continue;
    const stats = statSync(abs, { throwIfNoEntry: false });
    if (!stats) continue; // vanished between readdir and stat
    if (stats.mtimeMs >= cutoff) {
      result.recent += 1;
      continue;
    }
    try {
      rmSync(abs, { recursive: true, force: true, maxRetries: 1 });
      result.removed += 1;
    } catch {
      result.skipped += 1; // not ours to remove, or busy — try again next run
    }
  }
  return result;
}

function main() {
  const swept = sweepScratchDirs({ keep: [process.env.TMPDIR, process.env.CG_TEST_SCRATCH] });
  const parts = [`removed ${swept.removed}`];
  if (swept.recent) parts.push(`kept ${swept.recent} recent`);
  if (swept.skipped) parts.push(`skipped ${swept.skipped} not removable`);
  console.log(`[test-scratch-sweep] ${parts.join(", ")} in ${swept.root}`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main();
