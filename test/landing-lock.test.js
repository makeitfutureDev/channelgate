import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LandingLockBusyError,
  acquireLandingLock,
  releaseLandingLock,
  runWithLandingLock,
} from "../scripts/with-landing-lock.mjs";

const scriptPath = new URL("../scripts/with-landing-lock.mjs", import.meta.url).pathname;

async function scratchRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-landing-lock-"));
  execFileSync("git", ["init", "-q", root]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("one owner holds the repository landing lock and only its ref value releases it", async (t) => {
  const cwd = await scratchRepository(t);
  const first = await acquireLandingLock({ cwd, owner: "release-a", hostname: "test-host" });

  await assert.rejects(
    acquireLandingLock({ cwd, owner: "release-b", hostname: "test-host" }),
    (error) => error instanceof LandingLockBusyError && error.owner.owner === "release-a",
  );
  assert.equal(await releaseLandingLock({ ...first, oid: "0".repeat(first.oid.length) }), false);
  assert.equal(await releaseLandingLock(first), true);
});

test("concurrent stale-owner recovery is a compare-and-swap and admits one contender", async (t) => {
  const cwd = await scratchRepository(t);
  const stalePid = 99_999_999;
  const stale = await acquireLandingLock({
    cwd,
    owner: "old-release",
    hostname: "test-host",
    pid: stalePid,
  });
  let waiting = 0;
  let openBarrier;
  const barrier = new Promise((resolve) => { openBarrier = resolve; });
  const beforeCompareAndSwap = async () => {
    waiting += 1;
    if (waiting === 2) openBarrier();
    await barrier;
  };
  const attempt = (owner) => acquireLandingLock({
    cwd,
    owner,
    hostname: "test-host",
    pid: process.pid,
    isPidAlive: (pid) => pid !== stalePid,
    beforeCompareAndSwap,
  });

  const results = await Promise.allSettled([attempt("release-a"), attempt("release-b")]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof LandingLockBusyError);
  assert.equal(await releaseLandingLock(stale), false);
  assert.equal(await releaseLandingLock(winners[0].value), true);
});

test("a live descendant prevents recovery after the wrapper owner disappears", async (t) => {
  const cwd = await scratchRepository(t);
  const lock = await acquireLandingLock({
    cwd,
    owner: "release-with-descendant",
    hostname: "test-host",
    pid: 99_999_999,
  });
  lock.owner.processGroupId = process.pid;
  const ownerText = JSON.stringify(lock.owner);
  const nextOid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    encoding: "utf8",
    input: ownerText,
  }).trim();
  execFileSync("git", ["update-ref", lock.lockContext.ref, nextOid, lock.oid], { cwd });
  lock.oid = nextOid;

  await assert.rejects(
    acquireLandingLock({
      cwd,
      owner: "unsafe-recovery",
      hostname: "test-host",
      isPidAlive: () => false,
      isProcessGroupAlive: () => true,
    }),
    LandingLockBusyError,
  );
  assert.equal(await releaseLandingLock(lock), true);
});

test("the command wrapper releases its lock after a successful process group", async (t) => {
  const cwd = await scratchRepository(t);
  const code = await runWithLandingLock({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd,
  });
  assert.equal(code, 0);
  const next = await acquireLandingLock({ cwd, owner: "next" });
  assert.equal(await releaseLandingLock(next), true);
});

test("SIGTERM drains surviving grandchildren before the landing lock is released", async (t) => {
  const cwd = await scratchRepository(t);
  const marker = path.join(cwd, "grandchild.pid");
  const grandchildCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const commandCode = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const helper = spawn(process.execPath, [scriptPath, "--", process.execPath, "-e", commandCode], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CG_LANDING_GROUP_GRACE_MS: "25",
      CG_LANDING_GROUP_TERM_MS: "75",
      CG_LANDING_GROUP_KILL_MS: "1000",
    },
  });
  t.after(() => {
    if (helper.exitCode === null) helper.kill("SIGKILL");
  });

  assert.equal(await waitFor(async () => {
    try {
      return Boolean((await readFile(marker, "utf8")).trim());
    } catch {
      return false;
    }
  }), true);
  const grandchildPid = Number(await readFile(marker, "utf8"));
  assert.equal(alive(grandchildPid), true);
  helper.kill("SIGTERM");
  const exit = await new Promise((resolve) => helper.once("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 143, signal: null });
  assert.equal(await waitFor(() => !alive(grandchildPid)), true);

  const next = await acquireLandingLock({ cwd, owner: "after-signal" });
  assert.equal(await releaseLandingLock(next), true);
  await writeFile(marker, "drained\n");
});
