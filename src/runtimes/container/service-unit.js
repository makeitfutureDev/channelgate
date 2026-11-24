// Does stopping THIS daemon's systemd unit also end the channel containers?
//
// A container's processes (conmon, its init, every exec) live in SOME cgroup. Under Podman's
// systemd cgroup manager each container gets a scope of its own, outside the daemon's unit, and a
// gateway restart never touches it. Under `cgroupfs` — what the system-service install uses so
// that `podman exec` stays inside the unit's delegated subtree — they sit in the daemon's OWN unit
// cgroup. systemd's `KillMode=control-group` and `KillMode=mixed` SIGKILL everything left there
// on every stop and restart, conmon included, so nothing records the exit: Podman goes on listing
// the containers as running and every later exec fails. Only `KillMode=process` leaves them alone
// (the daemon sweeps its own engine children on the way out, so nothing else depends on the
// control-group kill).
//
// Changing a system unit takes root, which the daemon does not have. This module only ANSWERS the
// question — from the kernel's cgroup files and systemd's own view of the unit — so the boot log
// and the admin UI can name the one host command that fixes it (scripts/repair-service-unit.sh).
// Every unknown answers "no advice": an unreadable cgroup or a silent systemctl is never a warning.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export const SAFE_KILL_MODES = Object.freeze(["process", "none"]);
export const SERVICE_UNIT_REPAIR = "sudo bash scripts/repair-service-unit.sh";

// The cgroup path of a /proc/<pid>/cgroup file: the unified `0::` line on cgroup v2, systemd's
// own named hierarchy on v1. "" when neither is there.
export function parseCgroupPath(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const unified = lines.find((line) => line.startsWith("0::"));
  if (unified) return unified.slice(3);
  const named = lines.find((line) => /^\d+:name=systemd:/.test(line));
  return named ? named.replace(/^\d+:name=systemd:/, "") : "";
}

// The service unit a cgroup path belongs to → { unit, scope: "system" | "user", root } | null.
// `root` is the unit's own cgroup, which is what systemd kills. A process that merely runs under
// a user manager with no unit of its own (a terminal session) has none.
export function unitOfCgroup(path) {
  const segments = String(path || "").split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment.endsWith(".service")) continue;
    if (/^user@\d+\.service$/.test(segment)) return null;
    const scope = segments.slice(0, index).some((part) => /^user@\d+\.service$/.test(part)) ? "user" : "system";
    return { unit: segment, scope, root: `/${segments.slice(0, index + 1).join("/")}` };
  }
  return null;
}

export function cgroupInside(candidate, root) {
  const path = String(candidate || "");
  return Boolean(root) && (path === root || path.startsWith(`${root}/`));
}

function systemctl(args, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    execFile("systemctl", args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "" : String(stdout || ""));
    });
  });
}

function adviceFor({ unit, scope, killMode }) {
  const fix = scope === "user"
    ? `set KillMode=process under [Service] in ${unit} and run \`systemctl --user daemon-reload\``
    : `run \`${SERVICE_UNIT_REPAIR}\` on the gateway host once`;
  return `Every stop or restart of ${unit} also ends this gateway's channel containers and whatever is running inside them `
    + `(the unit uses KillMode=${killMode} and the containers share its control group). To keep them, ${fix} — no restart is needed.`;
}

/**
 * inspect({ cgroupManager, containerPids }) → {
 *   managed,          // this process is a systemd service unit of its own
 *   unit, scope,      // "channelgate.service", "system" | "user"
 *   killMode,         // systemd's effective value, "" when it could not be read
 *   shared,           // containers live in the unit's cgroup: true | false | null (unknown)
 *   killsContainers,  // a stop of the unit ends them
 *   advice,           // "" or the operator-facing sentence with the remedy
 * }
 * `containerPids` are host init pids of running containers: where one is known its real cgroup
 * decides; with none running the cgroup manager does (cgroupfs keeps them in the caller's cgroup).
 */
export function createServiceUnitInspector({
  env = process.env,
  readText = (file) => readFile(file, "utf8"),
  run = systemctl,
  now = () => Date.now(),
  ttlMs = 60_000,
} = {}) {
  let cachedKillMode = { key: "", value: "", at: 0 };

  async function cgroupOf(pid) {
    try { return parseCgroupPath(await readText(`/proc/${pid}/cgroup`)); } catch { return ""; }
  }

  async function killModeOf(own) {
    const key = `${own.scope}:${own.unit}`;
    if (cachedKillMode.key === key && now() - cachedKillMode.at < ttlMs) return cachedKillMode.value;
    const args = [...(own.scope === "user" ? ["--user"] : []), "show", "--property=KillMode", "--value", own.unit];
    let value = "";
    try { value = String(await run(args) || "").trim().toLowerCase(); } catch { value = ""; }
    if (!/^[a-z-]+$/.test(value)) value = "";
    cachedKillMode = { key, value, at: now() };
    return value;
  }

  async function inspect({ cgroupManager = "", containerPids = [] } = {}) {
    const none = { managed: false, unit: "", scope: "", killMode: "", shared: null, killsContainers: false, advice: "" };
    // systemd stamps every service process; a terminal run has neither and has no unit to stop.
    if (!env.INVOCATION_ID && !env.JOURNAL_STREAM) return none;
    const own = unitOfCgroup(await cgroupOf("self"));
    if (!own) return none;

    let shared = null;
    const paths = (await Promise.all(containerPids.filter((pid) => pid > 1).map((pid) => cgroupOf(pid)))).filter(Boolean);
    if (paths.length) shared = paths.some((path) => cgroupInside(path, own.root));
    else if (cgroupManager) shared = String(cgroupManager).toLowerCase() === "cgroupfs";

    const killMode = await killModeOf(own);
    const killsContainers = shared === true && Boolean(killMode) && !SAFE_KILL_MODES.includes(killMode);
    return {
      managed: true, unit: own.unit, scope: own.scope, killMode, shared, killsContainers,
      advice: killsContainers ? adviceFor({ ...own, killMode }) : "",
    };
  }

  return { inspect, forget: () => { cachedKillMode = { key: "", value: "", at: 0 }; } };
}
