// Where a runner's engine process actually runs. The runners used to call child_process.spawn,
// process.kill(pid, 0) and killTree() directly; all three assume the engine's pid is a pid in THIS
// namespace, which stops being true the moment a channel runs inside a container. This module is
// the runners' one door to the runtime backend (src/runtimes/):
//
//   spawn   → target.runtime.spawn(target, spec)     (host: today's child_process.spawn)
//   probe   → child.runtime.target.runtime.probe(child)
//   signal  → child.runtime.target.runtime.signal(child, sig)
//
// Import-graph rule (brief §14): runners never import src/runtimes/registry.js or resolve.js —
// those reach settings.js, and settings.js → engines/registry.js → adapters → the runners would be
// a cycle. Only `contract.js` (pure) and `local.js` (util/proc + watchdog only) are importable, and
// local.js is here solely to build the DEFAULT target for the daemon's OWN turns that pass none:
// the update smoke probe and direct-runner tests. Every channel turn resolves a container target
// once per turn in run.js and hands it down as ctx.target.
import { localRuntime } from "../runtimes/local.js";
import { isRuntimeChild, runtimeSupports } from "../runtimes/contract.js";
import { killTree } from "../util/proc.js";
import { pidAlive } from "./watchdog.js";

// The image's fixed locations (containers/Containerfile). They are facts about where the engine
// CLIs and their state live INSIDE a channel container, not host paths, so nothing here may be
// derived from process.env or from the daemon's own layout. A backend may override any of them on
// `target.container` — the runners read them through containerPaths() and never inline a literal.
export const CONTAINER_HOME = "/home/agent";
// Kept in step with containers/Containerfile's ENV PATH — /opt/channelgate/bin carries the run
// helpers (cg-exec, cg-signal, cg-mcp-bridge) an in-container command may invoke by name, and the
// three HOME bin dirs in front of it are where a channel's OWN installs land (npm -g, pip --user /
// pipx / uv, and anything dropped in ~/bin). This is only the fallback for a target that declares
// no `container.path`; the container backend always sets one from
// src/runtimes/container/image-paths.js, and test/container-durability.test.js pins the two
// declarations to the same string so they cannot drift again.
export const CONTAINER_PATH = "/home/agent/.npm-global/bin:/home/agent/.local/bin:/home/agent/bin:/opt/channelgate/bin:/usr/local/bin:/usr/bin:/bin:/home/agent/.cargo/bin:/home/agent/.bun/bin:/home/agent/.deno/bin:/home/agent/go/bin";
export const CONTAINER_TMPDIR = "/tmp";
export const CONTAINER_CLAUDE_CONFIG_DIR = `${CONTAINER_HOME}/.claude`;
export const CONTAINER_CODEX_HOME = `${CONTAINER_HOME}/.codex`;

// Inherited variables that name a location on the DAEMON's filesystem. They are correct for a host
// child and wrong for one running inside the image, whose filesystem is not the host's: a macOS
// `/var/folders/...` TMPDIR, an XDG_RUNTIME_DIR under /run/user, an ssh-agent socket that was never
// bind-mounted, a CA bundle at a path that does not exist there. child-env.js's allowlist still
// decides what may cross the spawn boundary at all; this narrower filter runs only for an isolated
// target, which then sets the image's own values in their place.
export const HOST_LOCATION_ENV_NAMES = Object.freeze([
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "NODE_EXTRA_CA_CERTS",
]);

export function dropHostLocationEnv(env = {}) {
  const out = { ...env };
  for (const name of HOST_LOCATION_ENV_NAMES) delete out[name];
  return out;
}

export function containerPaths(target) {
  const c = target?.container || {};
  const home = c.home || CONTAINER_HOME;
  return {
    home,
    path: c.path || CONTAINER_PATH,
    tmpDir: c.tmpDir || CONTAINER_TMPDIR,
    claudeConfigDir: c.claudeConfigDir || (c.home ? `${home}/.claude` : CONTAINER_CLAUDE_CONFIG_DIR),
    codexHome: c.codexHome || (c.home ? `${home}/.codex` : CONTAINER_CODEX_HOME),
  };
}

// A daemon-local target for a caller that supplied none: a plain child_process.spawn on the
// daemon's own host, with no container around it. Only the daemon's own probes use it.
export function localRuntimeTarget(cwd = process.cwd()) {
  return {
    backend: "local",
    runtime: localRuntime,
    reason: "default",
    cwd,
    workDir: cwd,
    cleanWorkDir: "",
    artifactDir: null,
    container: null,
    settings: {},
  };
}

export function runtimeTargetOr(target, cwd) {
  return target && target.runtime && typeof target.runtime.spawn === "function" ? target : localRuntimeTarget(cwd);
}

// The engine's OWN sandbox is switched off inside an isolated runtime — the OS boundary the daemon
// owns is the confinement (plan §6), and a second sandbox inside it only breaks the toolchain.
export function isIsolatedTarget(target) {
  return runtimeSupports(target, "isolated");
}

export function spawnEngineChild(target, spec) {
  return target.runtime.spawn(target, spec);
}

// Liveness for the stall watchdog. Async on purpose (the container backend execs a probe); a child
// that never crossed the seam is answered exactly as before.
export function probeEngineChild(child) {
  if (!isRuntimeChild(child)) return pidAlive(child?.pid);
  const backend = child.runtime.target?.runtime;
  if (typeof backend?.probe !== "function") return pidAlive(child?.pid);
  return backend.probe(child);
}

// Deliver a signal to the run's WHOLE process group. Deliberately NOT awaited by callers: the
// daemon's shutdown sweep runs against an absolute deadline and must stay synchronous in shape, so
// a container exec is fired and left to finish on its own. A rejected promise is swallowed here —
// an unhandled rejection during shutdown would be a crash, and there is nothing to retry.
export function signalEngineChild(child, signal = "SIGTERM") {
  if (!isRuntimeChild(child)) return killTree(child, signal);
  const backend = child.runtime.target?.runtime;
  if (typeof backend?.signal !== "function") return killTree(child, signal);
  try {
    const result = backend.signal(child, signal);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return result;
  } catch {
    return false;
  }
}
