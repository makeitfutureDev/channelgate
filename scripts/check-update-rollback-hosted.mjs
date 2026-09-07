#!/usr/bin/env node
// Real CLI updater + Git + systemd rollback in the lifecycle VM. Engine smoke and npm test
// commands are controlled in LOCAL fixture commits; this is not authenticated engine acceptance.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = "/var/lib/channelgate-lifecycle";
assert.equal(repo, "/opt/channelgate-lifecycle", "only the disposable lifecycle checkout is permitted");
assert.equal(process.env.CHANNELGATE_DIR, root);
assert.equal(process.env.CG_DISPOSABLE_LIFECYCLE, "1");
assert.notEqual(process.getuid(), 0);
assert.equal(statSync(root).uid, process.getuid());
assert.equal(JSON.parse(readFileSync(`${root}/config/lifecycle-proof.json`)).value, "before-backup");
const run = (command, args) => execFileSync(command, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args) => run("git", args);
const original = git("rev-parse", "HEAD");
const upstream = `${root}/update-fixture.git`;
assert.equal(existsSync(upstream), false);
git("config", "user.name", "Lifecycle Fixture");
git("config", "user.email", "fixture@example.invalid");
const appFile = `${repo}/src/web/app.js`;
const packageFile = `${repo}/package.json`;
const settingsFile = `${root}/config/settings.json`;
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile)) : {};
writeFileSync(settingsFile, `${JSON.stringify({ ...settings, whisperEnabled: false, driveSyncEnabled: false }, null, 2)}\n`);
const appSource = readFileSync(appFile, "utf8");
assert.equal(appSource.split("updateSmoke = runUpdateSmoke,").length, 2);
writeFileSync(appFile, appSource.replace("updateSmoke = runUpdateSmoke,",
  'updateSmoke = async () => ({ ok: true, engines: [{ engine: "fixture-only", ok: true }] }),'));
const manifest = JSON.parse(readFileSync(packageFile));
manifest.scripts.test = 'node -e "console.log(\'controlled fixture suite passed\')"';
delete manifest.scripts.pretest;
writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
git("switch", "-c", "lifecycle-update-fixture");
git("add", "src/web/app.js", "package.json");
git("commit", "-m", "fixture: deterministic unauthenticated smoke for updater operations");
const baseline = git("rev-parse", "HEAD");
git("clone", "--bare", repo, upstream);
git("remote", "set-url", "origin", upstream);
git("fetch", "origin");
git("branch", "--set-upstream-to=origin/lifecycle-update-fixture");

async function health(expectedRevision, previous = "") {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const auth = JSON.parse(readFileSync(`${root}/config/internal-auth.json`));
      const response = await fetch(`http://127.0.0.1:${auth.port}/api/health`, {
        headers: { "x-cg-secret": auth.secret }, signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.ok, true);
      assert.equal(value.revision, expectedRevision);
      assert.ok(value.instanceId && value.instanceId !== previous);
      return value;
    } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  throw new Error(`Expected a new healthy instance on ${expectedRevision}`);
}
function restart() {
  const pid = Number(run("systemctl", ["show", "--property", "MainPID", "--value", "channelgate.service"]));
  assert.ok(Number.isInteger(pid) && pid > 1);
  process.kill(pid, "SIGUSR2");
}

restart();
let before = await health(baseline);
for (const failure of ["test", "readiness"]) {
  if (failure === "test") {
    const candidateManifest = { ...manifest, scripts: { ...manifest.scripts, test: 'node -e "process.exit(42)"' } };
    writeFileSync(packageFile, `${JSON.stringify(candidateManifest, null, 2)}\n`);
    git("add", "package.json");
  } else {
    const source = readFileSync(appFile, "utf8");
    assert.equal(source.split("revision: runningRevision,").length, 2);
    writeFileSync(appFile, source.replace("revision: runningRevision,", 'revision: "lifecycle-intentionally-unready",'));
    git("add", "src/web/app.js");
  }
  git("commit", "-m", `fixture: intentional ${failure} failure`);
  const candidate = git("rev-parse", "HEAD");
  // Only a new local fixture bare repository is written; no public remote is ever pushed.
  git("push", "--force", "origin", "HEAD:lifecycle-update-fixture");
  git("reset", "--hard", baseline);
  const result = spawnSync(process.execPath, ["scripts/update-runner.mjs"], {
    cwd: repo, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 12 * 60_000, maxBuffer: 4_000_000,
  });
  const state = JSON.parse(readFileSync(`${root}/update-state.json`));
  // Only the fixed fixture/status fields are evidence; full authenticated health and runtime
  // snapshots remain private inside the disposable VM.
  console.log(JSON.stringify({ failure, updaterExit: result.status, result: state.result,
    phase: state.phase, oldRevision: state.oldRevision, targetRevision: state.targetRevision,
    runningRevision: state.runningRevision, candidateError: state.candidateError, rollbackError: state.rollbackError }));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(state.result, "rolled_back");
  assert.equal(state.oldRevision, baseline);
  assert.equal(state.targetRevision, candidate);
  assert.equal(state.runningRevision, baseline);
  assert.equal(git("rev-parse", "HEAD"), baseline);
  if (failure === "test") assert.match(state.candidateError, /npm test.*42/);
  else assert.ok(state.candidateError.includes(
    `gateway is running revision lifecycle-intentionally-unready instead of ${candidate}`),
  "readiness failure must prove the candidate actually answered with the intended wrong revision");
  assert.equal(existsSync(`${root}/update-backups/${state.id}/gateway.db`), true);
  assert.equal(JSON.parse(readFileSync(`${root}/update-backups/${state.id}/config/lifecycle-proof.json`)).value, "before-backup");
  const snapshot = new DatabaseSync(`${root}/update-backups/${state.id}/gateway.db`, { readOnly: true });
  assert.equal(snapshot.prepare("SELECT value FROM lifecycle_proof").get().value, "before-backup");
  assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  snapshot.close();
  assert.equal(existsSync(`${root}/update.lock`), false);
  const db = new DatabaseSync(`${root}/gateway.db`, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM lifecycle_proof").get().value, "before-backup");
  db.close();
  before = await health(baseline, before.instanceId);
  console.log(`PASS real ${failure} failure rolls back Git and restarts systemd; engine smoke is a controlled fixture`);
}
git("checkout", "--detach", original);
restart();
await health(original, before.instanceId);
console.log("PASS original candidate restored after isolated updater fixture checks");
