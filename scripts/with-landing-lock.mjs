#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The lock lives in the shared Git repository as a ref. Renamed with the product (the checkout
// was `claude-gateway`); a lock is never held across a deploy, so no old-name fallback is needed.
const LOCK_REF = "refs/channelgate/landing-lock";
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function pidAlive(pid) {
  const target = positiveInteger(pid);
  if (!target) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupAlive(processGroupId) {
  const target = positiveInteger(processGroupId);
  if (!target || process.platform === "win32") return false;
  try {
    process.kill(-target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd, args, options = {}) {
  try {
    return { ok: true, output: git(cwd, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function resolveLandingLock(cwd = process.cwd()) {
  const repository = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!repository) throw new Error("Git did not return a common directory.");
  return {
    cwd: path.resolve(cwd),
    ref: LOCK_REF,
    repository: path.resolve(cwd, repository),
  };
}

function readRef(lockContext) {
  const result = tryGit(lockContext.cwd, ["rev-parse", "--verify", "--quiet", lockContext.ref]);
  return result.ok && result.output ? result.output : null;
}

function readOwner(lockContext, oid = readRef(lockContext)) {
  if (!oid) return null;
  const result = tryGit(lockContext.cwd, ["cat-file", "blob", oid]);
  if (!result.ok) return null;
  try {
    const value = JSON.parse(result.output);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function writeOwner(lockContext, owner) {
  return git(lockContext.cwd, ["hash-object", "-w", "--stdin"], {
    input: `${JSON.stringify(owner, null, 2)}\n`,
  });
}

function compareAndSwapRef(lockContext, newOid, expectedOid) {
  const expected = expectedOid || "0".repeat(newOid.length);
  return tryGit(lockContext.cwd, ["update-ref", lockContext.ref, newOid, expected]).ok;
}

function deleteRef(lockContext, expectedOid) {
  return tryGit(lockContext.cwd, ["update-ref", "-d", lockContext.ref, expectedOid]).ok;
}

export class LandingLockBusyError extends Error {
  constructor(lockContext, owner) {
    const identity = owner?.owner || owner?.pid
      ? `${owner?.owner || "unknown owner"}${owner?.pid ? ` (pid ${owner.pid})` : ""}`
      : "another landing process";
    super(`Repository landing lock is held by ${identity}.`);
    this.name = "LandingLockBusyError";
    this.lockContext = lockContext;
    this.owner = owner || null;
  }
}

export async function acquireLandingLock({
  cwd = process.cwd(),
  lockContext = resolveLandingLock(cwd),
  owner = process.env.CG_LANDING_OWNER || `${os.userInfo().username}@${os.hostname()}`,
  hostname = os.hostname(),
  pid = process.pid,
  now = Date.now,
  isPidAlive = pidAlive,
  isProcessGroupAlive = processGroupAlive,
  beforeCompareAndSwap,
} = {}) {
  const record = {
    token: randomUUID(),
    owner: String(owner).slice(0, 160),
    pid,
    hostname,
    acquiredAt: new Date(now()).toISOString(),
  };
  const oid = writeOwner(lockContext, record);

  for (let attempt = 0; attempt < 5; attempt++) {
    const existingOid = readRef(lockContext);
    const existing = readOwner(lockContext, existingOid);
    const localOwner = existing?.hostname === hostname;
    const ownerIsDead = localOwner && !isPidAlive(existing?.pid);
    const ownerGroupIsDead = !existing?.processGroupId
      || !isProcessGroupAlive(existing.processGroupId);
    const mayAcquire = !existingOid || (ownerIsDead && ownerGroupIsDead);

    if (!mayAcquire) throw new LandingLockBusyError(lockContext, existing);
    if (beforeCompareAndSwap) {
      await beforeCompareAndSwap({ existingOid, existing });
    }
    if (compareAndSwapRef(lockContext, oid, existingOid)) {
      return { lockContext, oid, token: record.token, owner: record };
    }
  }

  throw new LandingLockBusyError(lockContext, readOwner(lockContext));
}

async function updateLandingLock(lock, patch) {
  if (!lock?.lockContext || !lock?.oid || !lock?.token) {
    throw new Error("Cannot update an invalid repository landing lock.");
  }
  const existingOid = readRef(lock.lockContext);
  const existing = readOwner(lock.lockContext, existingOid);
  if (existingOid !== lock.oid || existing?.token !== lock.token) {
    throw new Error("Repository landing lock ownership changed unexpectedly.");
  }
  const nextOwner = { ...existing, ...patch, token: lock.token };
  const nextOid = writeOwner(lock.lockContext, nextOwner);
  if (!compareAndSwapRef(lock.lockContext, nextOid, existingOid)) {
    throw new Error("Repository landing lock ownership changed while updating it.");
  }
  lock.oid = nextOid;
  lock.owner = nextOwner;
  return lock;
}

export async function releaseLandingLock(lock) {
  if (!lock?.lockContext || !lock?.oid || !lock?.token) return false;
  const existing = readOwner(lock.lockContext, lock.oid);
  if (!existing || existing.token !== lock.token) return false;
  return deleteRef(lock.lockContext, lock.oid);
}

function signalProcessGroup(processGroupId, signal) {
  if (!positiveInteger(processGroupId) || process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForProcessGroupExit(processGroupId, timeoutMs, pollMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function drainProcessGroup(processGroupId, {
  graceMs = Number(process.env.CG_LANDING_GROUP_GRACE_MS || 500),
  termMs = Number(process.env.CG_LANDING_GROUP_TERM_MS || 3_000),
  killMs = Number(process.env.CG_LANDING_GROUP_KILL_MS || 3_000),
} = {}) {
  if (!processGroupAlive(processGroupId)) return true;
  if (await waitForProcessGroupExit(processGroupId, graceMs)) return true;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, termMs)) return true;
  signalProcessGroup(processGroupId, "SIGKILL");
  return waitForProcessGroupExit(processGroupId, killMs);
}

async function superviseCommand() {
  let payload;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    console.error(`[landing-lock] Invalid supervisor command: ${error.message}`);
    return 64;
  }
  if (!payload?.command || !Array.isArray(payload.args)) return 64;

  const child = spawn(payload.command, payload.args, {
    cwd: process.cwd(),
    stdio: [3, "inherit", "inherit"],
    shell: false,
  });
  return new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(`[landing-lock] ${error.message}`);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      resolve(code ?? SIGNAL_EXIT_CODES[signal] ?? 1);
    });
  });
}

export async function runWithLandingLock({
  command,
  args = [],
  cwd = process.cwd(),
  lockContext,
} = {}) {
  if (!command) throw new Error("A command is required.");
  if (process.platform === "win32") {
    throw new Error("The landing-lock command wrapper supports macOS and Linux.");
  }

  const lock = await acquireLandingLock({ cwd, lockContext });
  let supervisor = null;
  let processGroupId = null;
  let interruptedSignal = null;
  let groupDrained = true;
  let outcomeCode = 1;
  let primaryError = null;

  const forwardSignal = (signal) => {
    interruptedSignal ||= signal;
    if (processGroupId) signalProcessGroup(processGroupId, signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    supervisor = spawn(process.execPath, [fileURLToPath(import.meta.url), "--supervise"], {
      cwd,
      detached: true,
      stdio: ["pipe", "inherit", "inherit", process.stdin],
      shell: false,
    });
    const outcome = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => {
        resolve(code ?? SIGNAL_EXIT_CODES[signal] ?? 1);
      });
    });
    if (!positiveInteger(supervisor.pid)) throw new Error("Could not start landing supervisor.");

    processGroupId = supervisor.pid;
    groupDrained = false;
    await updateLandingLock(lock, { processGroupId });
    if (interruptedSignal) {
      supervisor.stdin.end();
      signalProcessGroup(processGroupId, interruptedSignal);
    } else {
      supervisor.stdin.end(JSON.stringify({ command, args }));
    }
    outcomeCode = await outcome;
  } catch (error) {
    primaryError = error;
    supervisor?.stdin?.end();
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (processGroupId) groupDrained = await drainProcessGroup(processGroupId);
  }

  if (!groupDrained) {
    throw new Error(
      "Landing descendants survived SIGKILL; the lock was retained to prevent concurrent mutation.",
      { cause: primaryError || undefined },
    );
  }
  const released = await releaseLandingLock(lock);
  if (!released) {
    throw new Error("Repository landing lock ownership changed before release.", {
      cause: primaryError || undefined,
    });
  }
  if (primaryError) throw primaryError;
  return interruptedSignal ? SIGNAL_EXIT_CODES[interruptedSignal] : outcomeCode;
}

async function main(argv) {
  if (argv[0] === "--supervise") return superviseCommand();
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (!args.length) {
    console.error("Usage: node scripts/with-landing-lock.mjs -- <command> [args...]");
    return 64;
  }
  try {
    return await runWithLandingLock({ command: args[0], args: args.slice(1) });
  } catch (error) {
    console.error(`[landing-lock] ${error.message}`);
    return error instanceof LandingLockBusyError ? 75 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
