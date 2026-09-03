#!/usr/bin/env node
// Deterministic test discovery for `npm test` / `npm run test:coverage`.
//
// Why not a glob in package.json: `node --test "test/*.test.js"` depends on version-specific glob
// handling (Node 20 treated the quoted pattern as a literal path; a bare `test/` directory argument
// stopped working in later Node versions). Enumerating the files with fs behaves identically on
// every supported Node version and OS, with no shell expansion involved.
//
// Usage: node scripts/run-tests.mjs [--coverage] [extra node flags...]
// `--coverage` expands to the coverage flags with the enforced floors below; any other flags are
// passed to the spawned `node` in front of `--test`.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Enforced coverage floors. Baseline measured 2026-08-04: lines 69.13 / branches 68.98 /
// functions 68.61 — floors sit 1-2 points under so real regressions fail CI without flaking on
// small refactors. Ratchet these upward as coverage improves; never lower them to make CI pass.
const COVERAGE_FLOORS = { lines: 67, branches: 67, functions: 66 };

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(repoRoot, "test");

// The branch-threshold flag was renamed between Node versions (`--test-coverage-branch` on 22.x,
// `--test-coverage-branches` on newer lines), so detect the spelling this binary supports.
function coverageFlags() {
  const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" }).stdout || "";
  const branchFlag = help.includes("--test-coverage-branches")
    ? "--test-coverage-branches"
    : "--test-coverage-branch";
  return [
    "--experimental-test-coverage",
    `--test-coverage-lines=${COVERAGE_FLOORS.lines}`,
    `${branchFlag}=${COVERAGE_FLOORS.branches}`,
    `--test-coverage-functions=${COVERAGE_FLOORS.functions}`,
  ];
}

const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("test", name));

if (files.length === 0) {
  console.error(`No test files found in ${testDir}`);
  process.exit(1);
}

const nodeFlags = process.argv
  .slice(2)
  .flatMap((flag) => (flag === "--coverage" ? coverageFlags() : [flag]));

// ── Real-home leak guard ──────────────────────────────────────────────────────────────────────
// Tests must run entirely in temp directories, pinned through CHANNELGATE_DIR / CHANNELGATE_DB /
// CG_WORKSPACE_DIR (see test/helpers.js). A file that forgets to call ensureTestEnv() silently
// falls back to the DEFAULTS and provisions folders in the operator's real home — which on this
// project is a machine running the daemon in production. That is invisible in a green run, so the
// runner snapshots the four root names (current and pre-rename) plus one level beneath each,
// before and after, and fails the run on anything new. It is a diff, so directories that leaked in
// an earlier run do not fail every run forever — only a NEW entry does.
const HOME_ROOTS = [".channelgate", "ChannelGate", ".claude-gateway", "Slack Agent"];

function homeSnapshot() {
  const home = os.homedir();
  const seen = new Set();
  for (const name of HOME_ROOTS) {
    const root = path.join(home, name);
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // absent — nothing to record, and we must never create it
    }
    seen.add(name);
    for (const entry of entries) seen.add(`${name}/${entry.name}`);
  }
  return seen;
}

const before = homeSnapshot();
const result = spawnSync(process.execPath, [...nodeFlags, "--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});
const leaked = [...homeSnapshot()].filter((entry) => !before.has(entry)).sort();

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (leaked.length) {
  console.error(`\n✖ Tests wrote into the real home directory (${os.homedir()}):`);
  for (const entry of leaked) console.error(`    ${path.join(os.homedir(), entry)}`);
  console.error("  Every test must run in a temp directory. Call ensureTestEnv() from test/helpers.js");
  console.error("  before anything resolves a path, or pin CHANNELGATE_DIR / CG_WORKSPACE_DIR yourself.");
  process.exit(1);
}
process.exit(result.status ?? 1);
