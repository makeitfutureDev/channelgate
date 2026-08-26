import { setTimeout as delay } from "node:timers/promises";
import { shutdownPool, poolStats } from "../engines/session-pool.js";
import { shutdownEngineChildren, forceKillEngineChildren, engineProcessStats } from "../engines/process-registry.js";
import { runQueue } from "../slack/message-lifecycle.js";

// Deferred import: src/ee/ is the proprietary licensing layer and shutdown.js is on the boot path
// for every command-line entry point, including ones that never open the database.
async function reportLicenseUsage() {
  const { reportUsage } = await import("../ee/limits.js");
  return reportUsage();
}

const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_KILL_AFTER_MS = 800;
const DEFAULT_DISCONNECT_MS = 1_000;

let shuttingDown = false;
let forceStopping = false;
let shutdownPromise = null;

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function configuredDrainMs() {
  return positiveMs(process.env.CG_SHUTDOWN_DRAIN_MS, DEFAULT_DRAIN_MS);
}

export function isShuttingDown() {
  return shuttingDown;
}

// True only in the final exit phase. Completed turns clear their durable active-run rows during
// the drain; anything interrupted after this flips keeps its row for boot recovery.
export function isForceStopping() {
  return forceStopping;
}

export function runtimeActivity() {
  const warm = poolStats();
  const queued = runQueue.keys().reduce((count, key) => count + runQueue.count(key), 0);
  const cold = engineProcessStats().length;
  const warmPending = warm.pending || 0;
  return {
    queued,
    cold,
    warmPending,
    warmProcesses: warm.warm || 0,
    // These views overlap (one Slack turn can own both a queue slot and an engine process), but
    // shutdown only needs a conservative zero/non-zero predicate and a useful operator warning.
    total: queued + cold + warmPending,
  };
}

export async function waitForRuntimeDrain({
  timeoutMs = DEFAULT_DRAIN_MS,
  pollMs = DEFAULT_POLL_MS,
  getActivity = runtimeActivity,
  sleep = delay,
  now = Date.now,
} = {}) {
  const startedAt = now();
  let activity = getActivity();
  while (activity.total > 0) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) return { drained: false, waitedMs: elapsed, activity };
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)));
    activity = getActivity();
  }
  return { drained: true, waitedMs: now() - startedAt, activity };
}

function waitBounded(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Exported orchestration makes the bounded drain/force ordering executable without exiting the
// test process. requestShutdown supplies the production process/sweep dependencies below.
export async function performShutdown({
  slack = null,
  code = 0,
  reason = "shutdown",
  drainTimeoutMs = configuredDrainMs(),
  pollMs = DEFAULT_POLL_MS,
  killAfterMs = DEFAULT_KILL_AFTER_MS,
  disconnectTimeoutMs = DEFAULT_DISCONNECT_MS,
  getActivity = runtimeActivity,
  sweepWarm = shutdownPool,
  sweepCold = shutdownEngineChildren,
  sweepWarmFinal = shutdownPool,
  sweepColdFinal = forceKillEngineChildren,
  markForce = () => { forceStopping = true; },
  exit = (exitCode) => process.exit(exitCode),
  logger = console,
  sleep = delay,
} = {}) {
  // Stop accepting new Socket Mode envelopes first. The Web API client remains usable by turns
  // already finishing, so their progress/final delivery can complete during the drain window.
  const disconnecting = Promise.resolve(slack?.disconnect?.()).catch((error) => {
    logger.warn(`[gateway] Slack disconnect during shutdown failed: ${error?.message || error}`);
  });

  const initial = getActivity();
  if (initial.total > 0) {
    logger.log(`[gateway] ${reason} — draining active runs for up to ${drainTimeoutMs}ms (${initial.queued} queued/active Slack turn(s), ${initial.cold} cold child process(es), ${initial.warmPending} warm turn(s))…`);
  }

  // Last usage report of this process's life, started while the drain runs so it costs the
  // shutdown nothing (src/ee/limits.js: counts only, hashed conversation ids). Bounded by its own
  // timeout and never awaited past the drain — a dead platform must not delay an exit.
  reportLicenseUsage().catch(() => { /* fire-and-forget by contract */ });

  const drained = await waitForRuntimeDrain({ timeoutMs: drainTimeoutMs, pollMs, getActivity, sleep });
  if (!drained.drained) {
    logger.warn(`[gateway] ${reason} — graceful drain expired after ${drained.waitedMs}ms; interrupting ${drained.activity.queued} queued/active Slack turn(s), ${drained.activity.cold} cold child process(es), and ${drained.activity.warmPending} warm turn(s). Interrupted turns remain recoverable after restart.`);
  }

  // Freeze queue promotion before the final sweep. On a clean drain this is merely a short exit
  // phase; after a timeout it also tells interrupted turns to preserve their durable recovery row.
  markForce();

  // Sweep even after a clean drain: idle persistent sessions still own detached Claude/MCP process
  // groups and must never be re-parented to PID 1 when the daemon exits.
  const cold = sweepCold({ killAfterMs });
  const warm = sweepWarm();
  if (cold > 0 && killAfterMs > 0) await sleep(killAfterMs + 5);
  await waitBounded(disconnecting, disconnectTimeoutMs);
  // Re-snapshot synchronously at the last possible moment. A caller that was already awaiting a
  // semaphore, filesystem write, or warm fingerprint drain may have resumed after the first
  // snapshot. No await occurs between this force sweep and process.exit, so nothing can spawn in
  // the gap and escape re-parented to PID 1.
  const lateCold = sweepColdFinal();
  const lateWarm = sweepWarmFinal();
  logger.log(`[gateway] ${reason} — swept ${warm + lateWarm} warm session group(s) and ${cold + lateCold} cold engine group(s); exiting.`);
  exit(code);
  return { drained: drained.drained, warm: warm + lateWarm, cold: cold + lateCold, activity: drained.activity };
}

// Which service manager relaunches us after exit, so restart-style shutdowns can pick an exit
// code that actually produces a relaunch:
//   - launchd (macOS LaunchAgent): KeepAlive=true relaunches on ANY exit — a clean 0 is correct.
//   - systemd (scripts/install-systemd.sh unit): Restart=on-failure, so a clean 0 STOPS the
//     service. A restart must therefore exit nonzero (the same "die abnormally" contract the
//     self-updater uses via SIGUSR2 to the MainPID).
// systemd sets INVOCATION_ID (and JOURNAL_STREAM when wired to the journal) on every service
// process; neither appears in a plain terminal, so their absence means "not systemd-managed".
export function detectServiceManager({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") return "launchd";
  if (platform === "linux" && (env.INVOCATION_ID || env.JOURNAL_STREAM)) return "systemd";
  return "none";
}

// Exit code for an admin-requested RESTART (not a stop): nonzero under systemd's
// Restart=on-failure, clean 0 everywhere else (launchd KeepAlive, or an unmanaged terminal run).
export function restartExitCode({ platform, env } = {}) {
  return detectServiceManager({ platform, env }) === "systemd" ? 1 : 0;
}

export function requestShutdown({ slack = null, code = 0, reason = "shutdown" } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const drainTimeoutMs = configuredDrainMs();

  // Absolute fallback covers a stuck drain dependency. It performs synchronous SIGKILL sweeps
  // before exiting, so detached children cannot survive merely because an escalation timer was
  // unref'ed when process.exit ran.
  const hardDeadlineMs = drainTimeoutMs + DEFAULT_KILL_AFTER_MS + DEFAULT_DISCONNECT_MS + 2_000;
  const hardExit = setTimeout(() => {
    forceStopping = true;
    const cold = forceKillEngineChildren();
    const warm = shutdownPool();
    console.warn(`[gateway] ${reason} — absolute shutdown deadline reached; force-swept ${warm} warm and ${cold} cold engine group(s).`);
    process.exit(code);
  }, hardDeadlineMs);
  hardExit.unref?.();

  shutdownPromise = performShutdown({ slack, code, reason, drainTimeoutMs })
    .catch((error) => {
      forceStopping = true;
      forceKillEngineChildren();
      shutdownPool();
      console.error(`[gateway] ${reason} failed during graceful shutdown:`, error?.message || error);
      process.exit(code || 1);
    })
    .finally(() => clearTimeout(hardExit));
  return shutdownPromise;
}
