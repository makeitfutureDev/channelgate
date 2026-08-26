// Process-group kill helpers. Engine and background children are spawned with `detached: true`,
// which makes each one the leader of its own process group — so signalling the NEGATIVE pid takes
// down the whole tree (MCP stdio servers, `npx mcp-remote` bridges, backgrounded grandchildren).
// A plain child.kill() only hits the direct child and orphans those. Pure POSIX semantics — works
// on both deploy targets (macOS + Linux), no setsid or other platform binaries involved.
import { execFileSync } from "node:child_process";

// Signal a process group by its leader pid. Falls back to signalling the single process when the
// group signal fails (e.g. the leader already exited and the group is gone). Returns false only
// when nothing could be signalled (already fully gone).
export function killGroup(pid, signal = "SIGTERM") {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

// Convenience for a live ChildProcess handle.
export function killTree(child, signal = "SIGTERM") {
  if (!child || child.pid == null) return false;
  return killGroup(child.pid, signal);
}

// The process's kernel-recorded start time, as `ps` prints it (e.g. "Mon Aug 17 10:04:11 2026").
// Persisted next to a background job's pid so a boot-recovery signal can prove the pid still names
// OUR child: after a long outage the OS may have recycled the pid onto an unrelated process, and a
// bare kill(pid) would then SIGTERM a stranger's process group. `ps -p <pid> -o lstart=` is
// portable across both deploy targets (macOS + procps Linux). Graceful fallback: "" (unknown)
// when ps is unavailable or the process is gone — callers treat "" as "identity unverifiable".
export function processStartTime(pid) {
  if (!pid) return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return "";
  }
}
