// How full is a container's process limit? Answered from the HOST, never from inside.
//
// A container at its `--pids-limit` cannot start one more process OR thread: Claude Code aborts
// (SIGABRT) the moment it cannot start a thread, a shell cannot fork `cat`, and `node -e` — which
// is what the in-container resource probe is — dies the same way. So the only place the question
// can still be answered is outside: the container's init pid is a host pid, `/proc/<pid>/cgroup`
// names its cgroup, and the kernel's own counters (`pids.current`, `pids.max`, `pids.events`) are
// world-readable files there. Two file reads, no exec, no process started in a container that has
// no room for one.
//
// Every failure answers `null` ("unknown"): another cgroup layout, a hidden ancestor, a docker
// daemon whose cgroups this user cannot read. Unknown is never treated as pressure.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The default `--pids-limit`. It was 1,024 until 2026-11, which one working pattern exhausts on its
// own: a headless Chromium is about 250 processes+threads, so four browser sessions side by side
// leave nothing for the engine. 4,096 keeps the cap a fork-bomb guard without making ordinary
// parallel browser work the thing that trips it.
export const CONTAINER_DEFAULT_PIDS_LIMIT = 4096;
export const CONTAINER_LEGACY_PIDS_LIMIT = 1024;

// A container is "out of room" well before the last slot: a turn needs the engine (≈40 threads),
// its MCP bridges and whatever the first tool starts. Below 15% free the next turn is far more
// likely to die mid-work than to finish.
export const PIDS_PRESSURE_RATIO = 0.85;

async function readText(file) {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

function count(text) {
  const value = String(text || "").trim();
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/**
 * The kernel's process counters for the cgroup of host pid `pid`.
 * → { current, max, deniedTotal } | null. `max` is null when the cgroup has no limit; `deniedTotal`
 * is how many process/thread starts the limit has refused since the cgroup was created.
 */
export async function readPidsCounters({ pid, procDir = "/proc", cgroupDir = "/sys/fs/cgroup" } = {}) {
  const id = Number(pid);
  if (!Number.isSafeInteger(id) || id <= 1) return null;
  const memberships = (await readText(join(procDir, String(id), "cgroup"))).split("\n");
  // cgroup v1 names the controller; v2 has the single unified `0::` line.
  const membership = memberships.find((line) => /^\d+:[^:]*\bpids\b[^:]*:/.test(line)) || memberships.find((line) => line.startsWith("0::"));
  if (!membership) return null;
  const [, controllers, ...rest] = membership.split(":");
  const location = rest.join(":");
  // A relative or escaping path means this reader sits in a cgroup namespace that hides the
  // container's ancestors: whatever it resolved to would not be this container's cap.
  if (!location.startsWith("/") || location === "/" || location.split("/").includes("..")) return null;
  const dir = join(cgroupDir, controllers ? "pids" : "", location);
  const current = count(await readText(join(dir, "pids.current")));
  if (current == null) return null;
  const maxText = (await readText(join(dir, "pids.max"))).trim();
  const denied = /^max\s+(\d{1,15})$/m.exec(await readText(join(dir, "pids.events")));
  return { current, max: maxText === "max" ? null : count(maxText), deniedTotal: denied ? Number(denied[1]) : 0 };
}

/**
 * Judge a reading. → { current, max, free, exhausted }. No limit (or no reading) is never
 * exhausted.
 */
export function pidsPressure(counters, { ratio = PIDS_PRESSURE_RATIO } = {}) {
  if (!counters || !Number.isFinite(counters.current)) return { current: null, max: null, free: null, exhausted: false };
  const { current, max } = counters;
  if (!Number.isFinite(max) || max <= 0) return { current, max: null, free: null, exhausted: false };
  return { current, max, free: Math.max(0, max - current), exhausted: current >= Math.floor(max * ratio) };
}

// "1,023 of 1,024" — the one spelling every notice, error and preamble uses.
export function describePidsUse({ current, max } = {}) {
  const n = (value) => Number(value).toLocaleString("en-US");
  return Number.isFinite(max) && max > 0 ? `${n(current)} of ${n(max)}` : `${n(current)}`;
}
