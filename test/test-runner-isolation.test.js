import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tempDir } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function snapshot(root) {
  const entries = {};
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(prefix, entry.name);
      entries[name] = entry.isDirectory() ? "directory" : createHash("sha256").update(readFileSync(path.join(dir, entry.name))).digest("hex");
      if (entry.isDirectory()) visit(path.join(dir, entry.name), name);
    }
  }
  visit(root);
  return entries;
}

function runNode(args, { env, cwd = repoRoot, output }) {
  const fd = openSync(output, "w", 0o600);
  let result;
  // This subprocess owns a fresh test harness; inheriting node:test's child context can cause
  // --test to execute no fixtures while still returning zero.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    result = spawnSync(process.execPath, args, { env: childEnv, cwd, stdio: ["ignore", fd, fd], timeout: 60_000 });
  } finally { closeSync(fd); }
  assert.equal(result.status, 0, `${result.error?.message || "child failed"}\n${readFileSync(output, "utf8")}`);
}

test("operator-script tests leave an inherited canonical runtime and database untouched", () => {
  const fixture = tempDir("cg-operations-isolation-");
  const external = path.join(fixture, "external-runtime");
  for (const dir of ["config", "logs", "update-backups", "backups"]) mkdirSync(path.join(external, dir), { recursive: true });
  writeFileSync(path.join(external, "config", "settings.json"), '{"sentinel":"must-survive"}\n');
  writeFileSync(path.join(external, "logs", "daemon.out.log"), "sentinel-log".repeat(110_000));
  const backup = path.join(external, "update-backups", "old-sentinel");
  writeFileSync(backup, "must not be deleted by maintenance");
  utimesSync(backup, new Date(0), new Date(0));
  const externalDb = path.join(external, "operator.db");
  const db = new DatabaseSync(externalDb);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('untouched')");
  db.close();
  const before = snapshot(external);
  const env = {
    ...process.env, HOME: fixture,
    CHANNELGATE_DIR: external, CLAUDE_GATEWAY_DIR: external,
    CHANNELGATE_DB: externalDb, CLAUDE_GATEWAY_DB: externalDb,
    CG_WORKSPACE_DIR: path.join(external, "workspace"),
  };
  // Direct invocation bypasses run-tests.mjs deliberately: each destructive operator-script
  // fixture must be safe even when a contributor runs this one file from a daemon environment.
  runNode(["--test", "--test-name-pattern=encrypted backup|restore over an existing|backup and restore honor|log rotation", "test/operations-readiness.test.js"], {
    env, output: path.join(fixture, "operations.log"),
  });
  assert.match(readFileSync(path.join(fixture, "operations.log"), "utf8"), /# pass 4\b/, "all four destructive-script fixtures actually ran");
  assert.deepEqual(snapshot(external), before, "no backup, restore, rotation, retention, or DB write may reach the inherited runtime");
});

test("aggregate test runner removes serving-runtime selectors while preserving other environment and node flags", () => {
  const fixture = tempDir("cg-suite-env-isolation-");
  mkdirSync(path.join(fixture, "scripts"));
  mkdirSync(path.join(fixture, "test"));
  copyFileSync(path.join(repoRoot, "scripts", "run-tests.mjs"), path.join(fixture, "scripts", "run-tests.mjs"));
  writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
  const evidence = path.join(fixture, "evidence.json");
  writeFileSync(path.join(fixture, "test", "fixture.test.js"), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.FIXTURE_EVIDENCE, JSON.stringify({ env: Object.fromEntries(
      ['CHANNELGATE_DIR', 'CHANNELGATE_DB', 'CLAUDE_GATEWAY_DIR', 'CLAUDE_GATEWAY_DB', 'CG_WORKSPACE_DIR', 'CG_TEST_SCRATCH', 'FIXTURE_PRESERVED'].map(key => [key, process.env[key] ?? null])
    ), flags: process.execArgv }));
  `);
  const external = path.join(fixture, "external");
  mkdirSync(external);
  writeFileSync(path.join(external, "sentinel"), "unchanged");
  const env = {
    ...process.env, HOME: fixture, FIXTURE_EVIDENCE: evidence, FIXTURE_PRESERVED: "yes",
    CHANNELGATE_DIR: external, CLAUDE_GATEWAY_DIR: external,
    CHANNELGATE_DB: path.join(external, "canonical.db"), CLAUDE_GATEWAY_DB: path.join(external, "legacy.db"),
    CG_WORKSPACE_DIR: external, CG_TEST_SCRATCH: external,
  };
  const before = snapshot(external);
  runNode(["scripts/run-tests.mjs", "--no-warnings"], { env, cwd: fixture, output: path.join(fixture, "runner.log") });
  const observed = JSON.parse(readFileSync(evidence, "utf8"));
  assert.deepEqual(observed.env, {
    CHANNELGATE_DIR: null, CHANNELGATE_DB: null, CLAUDE_GATEWAY_DIR: null, CLAUDE_GATEWAY_DB: null,
    CG_WORKSPACE_DIR: null, CG_TEST_SCRATCH: null, FIXTURE_PRESERVED: "yes",
  });
  assert.ok(observed.flags.includes("--no-warnings"));
  assert.deepEqual(snapshot(external), before);
});
