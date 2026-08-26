// Tracks live one-shot engine children so controlled daemon shutdown can terminate their detached
// process groups before launchd/systemd relaunches the gateway. Warm Claude sessions are handled by
// session-pool.js; this covers cold Claude and Codex `exec` runs.
import { killTree } from "../util/proc.js";

const children = new Map(); // pid -> { child, engine, kind, startedAt }

export function trackEngineChild(child, meta = {}) {
  if (!child || child.pid == null) return child;
  const rec = {
    child,
    engine: meta.engine || "engine",
    kind: meta.kind || "cold",
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
  for (const { child } of live) killTree(child, "SIGTERM");
  if (live.length) {
    const t = setTimeout(() => {
      for (const { child } of live) killTree(child, "SIGKILL");
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
  for (const { child } of live) killTree(child, "SIGKILL");
  return live.length;
}

export function engineProcessStats() {
  return [...children.values()].map(({ child, engine, kind, startedAt }) => ({
    pid: child.pid,
    engine,
    kind,
    startedAt,
  }));
}
