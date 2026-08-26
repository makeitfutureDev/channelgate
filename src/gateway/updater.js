// Shared self-update entry point and restart-safe reporting helpers. Slack, MCP, Admin UI, and
// scripts/update.sh all converge on the same durable transaction/lock in update-state.js; only
// the built-in-only Node runner performs repository, dependency, service, or rollback mutations.
import { spawn, execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gatewayRoot } from "../config/paths.js";
import {
  claimUpdate,
  finishUpdate,
  isTerminalUpdate,
  publicUpdateState,
  readUpdateState,
  releaseUpdate,
  reserveUpdate,
} from "./update-state.js";

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "update.sh");
export const UPDATE_RUNNER = path.join(REPO_ROOT, "scripts", "update-runner.mjs");
const MARKER_MAX_AGE_MS = 6 * 60 * 60_000;

const git = async (...args) => (await execFileP("git", args, { cwd: REPO_ROOT, timeout: 20_000 })).stdout.trim();

function gitSync(args, fallback = "") {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return fallback;
  }
}

// Captured once at process boot. During an update the old daemon's checkout can move underneath
// it, so a live `git rev-parse` is not proof that the serving process runs that revision.
export const runningRevision = gitSync(["rev-parse", "HEAD"]);

const VERSION_FMT = ["log", "-1", "--date=short", "--format=%h · %cd"];
export async function currentVersion() {
  return git(...VERSION_FMT).catch(() => "");
}

function markerFile(root) {
  return path.join(root, "update-pending.json");
}

function safeMessage(error) {
  return String(error?.message || error || "unknown update error").split(/\r?\n/, 1)[0].trim().slice(0, 300);
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// Bind a Slack destination to exactly one transaction. UI/CLI updates have no thread and skip it.
export function writeUpdateMarker({
  transactionId,
  channelId,
  threadTs,
  userId,
  root = gatewayRoot(),
} = {}) {
  if (!transactionId || !channelId || !threadTs) return false;
  try {
    writeJsonAtomic(markerFile(root), {
      transactionId: String(transactionId),
      channelId: String(channelId),
      threadTs: String(threadTs),
      userId: String(userId || ""),
      fromVersion: runningRevision,
      at: Date.now(),
    });
    return true;
  } catch (error) {
    console.warn(`[update] couldn't record confirmation marker: ${safeMessage(error)}`);
    return false;
  }
}

export function readUpdateMarker({ root = gatewayRoot() } = {}) {
  try {
    const value = JSON.parse(readFileSync(markerFile(root), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// With a transaction id, never consume another update's destination by accident.
export function clearUpdateMarker(transactionId, { root = gatewayRoot() } = {}) {
  const marker = readUpdateMarker({ root });
  if (!marker) return true;
  if (transactionId && marker.transactionId !== transactionId) return false;
  try {
    rmSync(markerFile(root), { force: true });
    return true;
  } catch {
    return false;
  }
}

// Candidate and rollback boots both run the Slack watcher. Only the matching terminal transaction
// is reportable; the caller clears after Slack accepts a deterministic client_msg_id post.
export function readTerminalUpdateMarker({
  root = gatewayRoot(),
  now = Date.now(),
  maxAgeMs = MARKER_MAX_AGE_MS,
} = {}) {
  const marker = readUpdateMarker({ root });
  if (!marker) return null;
  if (!marker.transactionId || !marker.channelId || !marker.threadTs) {
    clearUpdateMarker(undefined, { root });
    return null;
  }
  if (marker.at && now - Number(marker.at) > maxAgeMs) {
    clearUpdateMarker(marker.transactionId, { root });
    return null;
  }
  const transaction = publicUpdateState(readUpdateState({ root }));
  if (!isTerminalUpdate(transaction) || transaction.id !== marker.transactionId) return null;
  return { marker, transaction };
}

export function formatUpdateResult(transaction = {}) {
  const revision = transaction.runningRevision ? ` \`${transaction.runningRevision}\`` : "";
  const reason = safeMessage(transaction.reason || transaction.candidateError || "");
  if (transaction.result === "updated" && transaction.changed === false) {
    return `✅ Gateway already up to date${revision}. Preflight and the isolated Claude smoke check passed.`;
  }
  if (transaction.result === "updated") {
    return `✅ Update complete — running${revision}. Extended health checks passed: daemon revision, Slack reconnect, and isolated Claude smoke.`;
  }
  if (transaction.result === "rolled_back") {
    const failure = safeMessage(transaction.candidateError || reason);
    return `⚠️ Update failed and was rolled back successfully — restored${revision}.${failure ? ` Candidate failure: ${failure}.` : ""}`;
  }
  if (transaction.result === "refused") {
    return `⛔ Update refused before changes${reason ? `: ${reason}` : "."}`;
  }
  if (transaction.result === "failed") {
    const candidate = safeMessage(transaction.candidateError || reason);
    const rollback = safeMessage(transaction.rollbackError || "");
    return `❌ Update failed and automatic rollback also failed.${candidate ? ` Candidate: ${candidate}.` : ""}${rollback ? ` Rollback: ${rollback}.` : ""} Check \`~/.channelgate/logs/update.log\`.`;
  }
  return `Update status: ${safeMessage(transaction.phase || transaction.status || "unknown")}.`;
}

// Current version + how many commits the upstream is ahead. `git fetch` touches the network
// (bounded by the exec timeout) — call this from dashboard load / an explicit check only.
export async function checkForUpdate() {
  const current = await git("log", "-1", "--date=short", "--format=%h · %cd").catch(() => "");
  try {
    await git("fetch", "--quiet", "origin");
    const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").catch(() => "origin/main");
    const behind = Number.parseInt(await git("rev-list", "--count", `HEAD..${upstream}`), 10) || 0;
    return { current, behind, checked: true };
  } catch {
    return { current, behind: 0, checked: false };
  }
}

function failReservedStart({ root, owner, error, context }) {
  const message = `could not start detached update runner: ${safeMessage(error)}`;
  let transaction;
  try {
    transaction = publicUpdateState(finishUpdate({
      root,
      owner,
      result: "failed",
      patch: { phase: "failed", reason: message, candidateError: message },
    }));
  } finally {
    releaseUpdate({ root, owner });
    if (context?.channelId && context?.threadTs) clearUpdateMarker(owner.transactionId, { root });
  }
  return { ok: false, conflict: false, transaction, error: message };
}

// Reserve synchronously before spawning so two callers can never overlap. The ownership token is
// inherited only through the child's environment, never argv or public state.
export function startUpdate(
  {
    source = "unknown",
    context = null,
    root = gatewayRoot(),
  } = {},
  {
    spawnImpl = spawn,
  } = {},
) {
  const reserved = reserveUpdate({ root, source });
  if (!reserved.ok) return { ok: false, conflict: true, transaction: reserved.transaction };

  if (context?.channelId && context?.threadTs) {
    const marked = writeUpdateMarker({
      transactionId: reserved.transaction.id,
      channelId: context.channelId,
      threadTs: context.threadTs,
      userId: context.userId,
      root,
    });
    if (!marked) {
      return failReservedStart({
        root,
        owner: reserved.owner,
        error: new Error("the Slack confirmation marker could not be persisted"),
        context,
      });
    }
  }

  const logsDir = path.join(root, "logs");
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(path.join(logsDir, "update.log"), "a", 0o600);
    const child = spawnImpl(process.execPath, [UPDATE_RUNNER, "--transaction", reserved.transaction.id], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, CHANNELGATE_DIR: root, CG_UPDATE_OWNER_TOKEN: reserved.owner.token },
    });
    if (Number.isInteger(child?.pid) && child.pid > 0) {
      claimUpdate({ root, owner: reserved.owner, pid: child.pid });
    }
    child?.once?.("error", (error) => {
      try {
        failReservedStart({ root, owner: reserved.owner, error, context });
      } catch (finishError) {
        console.error(`[update] detached runner failed and status could not be finalized: ${safeMessage(finishError)}`);
      }
    });
    child?.unref?.();
    return { ok: true, transaction: reserved.transaction };
  } catch (error) {
    return failReservedStart({ root, owner: reserved.owner, error, context });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The child already owns its duplicated descriptor.
      }
    }
  }
}
