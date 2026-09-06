// Durable self-update transaction state. Every entry point reserves the same exclusive lock
// before spawning the detached runner, so Slack, MCP, Admin UI, and CLI updates cannot overlap.
// The public status projection is deliberately non-secret because /api/health exposes it while
// browser sessions are reset across the daemon restart.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";

const RESERVATION_GRACE_MS = 30_000;
const TERMINAL_RESULTS = new Set(["updated", "rolled_back", "refused", "failed"]);
const PUBLIC_FIELDS = [
  "id",
  "source",
  "status",
  "phase",
  "result",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "oldRevision",
  "targetRevision",
  "runningRevision",
  "changed",
  "reason",
  "imageWarning",
  "candidateError",
  "rollbackError",
  "advisories",
  "requiredDiskBytes",
  "availableDiskBytes",
  "optionalDownloadBytes",
];

const stateFile = (root) => path.join(root, "update-state.json");
const lockFile = (root) => path.join(root, "update.lock");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sameOwner(lock, owner) {
  return Boolean(
    lock &&
      owner &&
      String(lock.transactionId || "") === String(owner.transactionId || "") &&
      String(lock.token || "") === String(owner.token || ""),
  );
}

function activeLock(lock, { now, pidAlive, reservationGraceMs }) {
  if (!lock) return false;
  const pid = Number(lock.pid) || 0;
  if (pid > 0) return pidAlive(pid);
  return Number.isFinite(Number(lock.at)) && now - Number(lock.at) < reservationGraceMs;
}

export function isUpdateActive({
  root = gatewayRoot(),
  now = Date.now(),
  pidAlive = defaultPidAlive,
  reservationGraceMs = RESERVATION_GRACE_MS,
} = {}) {
  return activeLock(readJson(lockFile(root)), { now, pidAlive, reservationGraceMs });
}

function transactionFromLock(lock) {
  return {
    id: String(lock?.transactionId || ""),
    source: String(lock?.source || ""),
    status: "running",
    phase: "queued",
    startedAt: Number(lock?.at) || 0,
    updatedAt: Number(lock?.at) || 0,
  };
}

export function isTerminalUpdate(state) {
  return Boolean(state && state.status === "terminal" && TERMINAL_RESULTS.has(state.result));
}

export function readUpdateState({ root = gatewayRoot() } = {}) {
  const state = readJson(stateFile(root));
  return state && typeof state === "object" && !Array.isArray(state) ? state : null;
}

export function publicUpdateState(state = readUpdateState()) {
  if (!state || typeof state !== "object") return null;
  const projected = {};
  for (const field of PUBLIC_FIELDS) {
    if (Object.hasOwn(state, field)) projected[field] = state[field];
  }
  if (projected.advisories && typeof projected.advisories === "object") {
    projected.advisories = {
      moderate: Number(projected.advisories.moderate) || 0,
      high: Number(projected.advisories.high) || 0,
      critical: Number(projected.advisories.critical) || 0,
    };
  }
  return projected;
}

export function reserveUpdate({
  root = gatewayRoot(),
  source = "unknown",
  now = Date.now(),
  makeId = randomUUID,
  pidAlive = defaultPidAlive,
  reservationGraceMs = RESERVATION_GRACE_MS,
} = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = lockFile(root);

  for (;;) {
    let fd;
    try {
      fd = openSync(file, "wx", 0o600);
      const transactionId = String(makeId());
      const token = String(makeId());
      const lock = { transactionId, token, pid: 0, source: String(source || "unknown"), at: now };
      writeFileSync(fd, `${JSON.stringify(lock)}\n`);
      closeSync(fd);
      fd = undefined;

      const transaction = {
        id: transactionId,
        source: lock.source,
        status: "running",
        phase: "queued",
        result: "",
        startedAt: now,
        updatedAt: now,
        finishedAt: 0,
        oldRevision: "",
        targetRevision: "",
        runningRevision: "",
        changed: false,
        reason: "",
        candidateError: "",
        rollbackError: "",
        advisories: { moderate: 0, high: 0, critical: 0 },
        requiredDiskBytes: 0,
        availableDiskBytes: 0,
        optionalDownloadBytes: 0,
      };
      try {
        writeJsonAtomic(stateFile(root), transaction);
      } catch (error) {
        try {
          unlinkSync(file);
        } catch {
          // Best effort; the pid-zero grace will expire if cleanup loses a race.
        }
        throw error;
      }
      return { ok: true, owner: { transactionId, token }, transaction: publicUpdateState(transaction) };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort.
        }
      }
      if (error?.code !== "EEXIST") throw error;
      const current = readJson(file);
      if (activeLock(current, { now, pidAlive, reservationGraceMs })) {
        const state = readUpdateState({ root });
        return { ok: false, transaction: publicUpdateState(state) || publicUpdateState(transactionFromLock(current)) };
      }
      try {
        unlinkSync(file);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
}

export function claimUpdate({ root = gatewayRoot(), owner, pid = process.pid, now = Date.now() } = {}) {
  const file = lockFile(root);
  const lock = readJson(file);
  if (!sameOwner(lock, owner)) return false;
  writeJsonAtomic(file, { ...lock, pid: Number(pid) || process.pid, claimedAt: now });
  return true;
}

function requireOwner(root, owner) {
  const lock = readJson(lockFile(root));
  if (!sameOwner(lock, owner)) {
    const error = new Error("update transaction ownership was lost");
    error.code = "EUPDATEOWNER";
    throw error;
  }
}

export function updateUpdateState({ root = gatewayRoot(), owner, patch = {}, now = Date.now() } = {}) {
  requireOwner(root, owner);
  const current = readUpdateState({ root });
  if (!current) throw new Error("update transaction state is missing");
  if (isTerminalUpdate(current)) return current;
  const next = {
    ...current,
    ...patch,
    id: current.id,
    source: current.source,
    status: "running",
    result: "",
    updatedAt: now,
  };
  writeJsonAtomic(stateFile(root), next);
  return next;
}

export function finishUpdate({
  root = gatewayRoot(),
  owner,
  result,
  patch = {},
  now = Date.now(),
} = {}) {
  requireOwner(root, owner);
  const current = readUpdateState({ root });
  if (!current) throw new Error("update transaction state is missing");
  if (isTerminalUpdate(current)) return current;
  if (!TERMINAL_RESULTS.has(result)) throw new Error(`invalid terminal update result: ${result}`);
  const next = {
    ...current,
    ...patch,
    id: current.id,
    source: current.source,
    status: "terminal",
    result,
    updatedAt: now,
    finishedAt: now,
  };
  writeJsonAtomic(stateFile(root), next);
  return next;
}

export function releaseUpdate({ root = gatewayRoot(), owner } = {}) {
  const file = lockFile(root);
  const lock = readJson(file);
  if (!sameOwner(lock, owner)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}
