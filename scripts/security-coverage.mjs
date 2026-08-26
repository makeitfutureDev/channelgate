#!/usr/bin/env node
// Dedicated coverage floors for the four security-sensitive areas. Each area runs independently,
// so excellent coverage in ordinary UI code cannot hide a regression in an authorization boundary.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" }).stdout || "";
const branchFlag = help.includes("--test-coverage-branches") ? "--test-coverage-branches" : "--test-coverage-branch";
const areas = [
  { name: "authorization", floor: [95, 95, 95], include: ["src/gateway/modes.js"], tests: ["test/authorization.test.js", "test/modes.test.js"] },
  {
    name: "access-grants",
    floor: [95, 75, 70],
    include: [
      "src/gateway/access-grants.js",
      "src/gateway/mcp-capability.js",
      "src/gateway/run-engine-mcp.js",
      "src/gateway/run-grant-artifacts.js",
    ],
    tests: [
      "test/access-grants.test.js",
      "test/mcp-capability.test.js",
      "test/run-engine-mcp.test.js",
      "test/run-grant-isolation.test.js",
    ],
  },
  { name: "sandbox", floor: [90, 90, 80], include: ["src/gateway/modes.js", "src/engines/child-env.js"], tests: ["test/modes.test.js", "test/folders-settings.test.js", "test/sandbox-escape-paths.test.js", "test/child-env.test.js"] },
  // folders.js GENERATES the per-channel lockdown (.claude/settings.json + SENSITIVE_HOME).
  // Ratchet floors set just under measured reality (80/67/82 on 2026-08-26).
  //
  // The previous floors (50/85/35) came from a 2026-08-08 measurement of 55/93/40, taken when
  // 59% of this file's functions were never called by these tests at all. `23ce670` added tests
  // that DID call them: lines 55->80, functions 41->83. Branch % fell 93->66 in the same step,
  // because V8 barely counts branches inside a function it never entered — calling those
  // functions pulls all of their branches into the denominator at once. Coverage improved; the
  // branch RATIO dropped. Read this area's three numbers together: a branch % that falls while
  // lines and functions climb is new code being reached, not a regression. Raise as tests appear.
  //
  // toolchain-paths.js belongs here for the same reason: it COMPUTES sandbox read grants, so a
  // bug in it is a confinement bug, not a convenience one.
  { name: "sandbox-generator", floor: [75, 65, 80], include: ["src/gateway/folders.js", "src/gateway/toolchain-paths.js"], tests: ["test/folders-settings.test.js", "test/sandbox-escape-paths.test.js", "test/sandbox-toolchain.test.js"] },
  { name: "secrets", floor: [90, 80, 65], include: ["src/web/secrets.js", "src/engines/child-env.js"], tests: ["test/secret-reveal.test.js", "test/child-env.test.js"] },
  { name: "web-boundary", floor: [80, 80, 75], include: ["src/web/security.js"], tests: ["test/web-security.test.js", "test/ssrf.test.js", "test/host-guard.test.js"] },
  // The old include named src/gateway/update-runner.js, which no longer exists — this area had
  // been passing vacuously (exactly the failure the existence check below now refuses). Floors
  // re-based on measured reality for scripts/update-runner.mjs (58/74/57 on 2026-08-08); the
  // transactional heavy paths are live-update-exercised, not unit-covered. Raise as tests grow.
  { name: "updates", floor: [55, 70, 52], include: ["src/gateway/update-state.js", "scripts/update-runner.mjs"], tests: ["test/update-state.test.js", "test/update-runner.test.js", "test/update-smoke.test.js", "test/update-entrypoints.test.js", "test/update-marker.test.js", "test/update-script.test.js"] },
];

// A floor over a file that no longer exists passes VACUOUSLY (empty report = 100%), so a rename
// silently deletes the gate. Every include and test path is a literal — require each to exist.
const missing = areas.flatMap((area) => [...area.include, ...area.tests].filter((file) => !existsSync(path.join(root, file))));
if (missing.length) {
  console.error(`Security coverage: missing files (update scripts/security-coverage.mjs):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

for (const area of areas) {
  const [lines, branches, functions] = area.floor;
  const args = [
    "--experimental-test-coverage",
    `--test-coverage-lines=${lines}`,
    `${branchFlag}=${branches}`,
    `--test-coverage-functions=${functions}`,
    ...area.include.flatMap((file) => ["--test-coverage-include", file]),
    "--test",
    ...area.tests,
  ];
  console.log(`\nSecurity coverage: ${area.name} (lines ${lines}, branches ${branches}, functions ${functions})`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
