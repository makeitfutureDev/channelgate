// Tracks live one-shot engine children so controlled daemon shutdown can terminate their detached
// process groups before launchd/systemd relaunches the gateway. Warm Claude sessions are handled by
// session-pool.js; this covers cold Claude and Codex `exec` runs.
//
// Signals go through the child's runtime backend (src/runtimes/): a container child's `.pid` is the
// host-side CLI client, so killing that pid would leave the engine — and its MCP grandchildren —
// running inside the container. Both sweeps stay SYNCHRONOUS in shape: the backend's signal is
// fired and deliberately not awaited, because these run against the daemon's absolute shutdown
// deadline and must never block on a container exec.
import { signalEngineChild } from "./runtime-target.js";

const children = new Map(); // pid -> { child, engine, kind, backend, startedAt }

export function trackEngineChild(child, meta = {}) {
  if (!child || child.pid == null) return child;
  const rec = {
    child,
    engine: meta.engine || "engine",
    kind: meta.kind || "cold",
    // Which runtime the process lives in, so /status and the admin rail can say "host" or
    // "container" without re-resolving the channel's target.
    backend: child.runtime?.backend || meta.backend || "host",
    runId: child.runtime?.runId || "",
    startedAt: Date.now(),
  };
  children.set(child.pid, rec);
  const untrack = () => children.delete(child.pid);
  child.once?.("close", untrack);
  child.once?.("exit", untrack);
  child.once?.("error", untrack);
  return child;
}

export function shutdownEngineChildren({ killAfterMs = 800 } = {}) {
  const live = [...children.values()];
  for (const { child } of live) signalEngineChild(child, "SIGTERM");
  if (live.length) {
    const t = setTimeout(() => {
      for (const { child } of live) signalEngineChild(child, "SIGKILL");
    }, killAfterMs);
    t.unref?.();
  }
  return live.length;
}

// Synchronous last-resort sweep for the daemon's absolute shutdown deadline. The normal path sends
// SIGTERM first and gives groups a grace window; this path exists so process.exit can never run
// while detached engine/MCP descendants are merely waiting on an unref'ed escalation timer.
export function forceKillEngineChildren() {
  const live = [...children.values()];
  for (const { child } of live) signalEngineChild(child, "SIGKILL");
  return live.length;
}

export function engineProcessStats() {
  return [...children.values()].map(({ child, engine, kind, backend, runId, startedAt }) => ({
    pid: child.pid,
    engine,
    kind,
    backend,
    ...(runId ? { runId } : {}),
    startedAt,
  }));
}
