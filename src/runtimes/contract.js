// The RuntimeBackend contract — the one home for WHERE an engine process runs, exactly as
// `src/engines/contract.js` is the one home for WHICH engine runs and `src/platforms/contract.js`
// for which chat surface answers. Two backends: `host` (today's direct spawn) and `container` (one
// long-lived Linux container per channel, engine processes exec'd inside it). A backend is added by
// adding a module here plus a registry entry — never by adding an `if (backend === "container")`
// branch in run.js or in a runner.
//
// The seam every runner already crosses is a Node ChildProcess: spawn it, read stdout/stderr, ask
// whether it is still alive, signal its whole process group. The contract keeps that shape —
// `spawn()` still returns a ChildProcess-like object — and moves the two things a pid namespace
// breaks (liveness, signals) behind the backend. A container child's `.pid` is the host-side CLI
// client, not the engine, so callers ask `backend.probe(child)` / `backend.signal(child, sig)` and
// never touch the pid themselves once a child carries a `runtime` tag.
//
// Fail-closed is the rule, as in the other two contracts: a backend that omits a method or a
// capability key does not load, and readers must never assume a capability that is not declared.
import { randomBytes } from "node:crypto";

export const RUNTIME_BACKEND_IDS = Object.freeze(["container"]);
export const DEFAULT_RUNTIME_BACKEND = "container";

// Capability keys every backend MUST declare. The default is the least capable value.
export const RUNTIME_CAPABILITY_SPEC = Object.freeze({
  // The engine runs behind an OS boundary the daemon owns, with its own sandbox switched off
  // inside it (plan §6). The container backend is the only registered backend; the daemon-internal
  // local runtime (update smoke, direct probes) declares false and never runs a channel turn.
  isolated: { default: false },
  // signal() reaches the run's whole process tree, not just the direct child.
  processGroups: { default: false },
  // A `detached` spawn (background job) can outlive the daemon and be re-found by its runId.
  detachedSurvivesDaemon: { default: false },
  // The channel's HOME (CLI logins, npm prefix, engine state) persists per channel across runs.
  persistentHome: { default: false },
});

export const REQUIRED_METHODS = Object.freeze([
  "prepareTarget",
  "ensureUp",
  "spawn",
  "probe",
  "signal",
  "acquireLease",
  "destroy",
  "fingerprint",
  "describe",
  "resumeCommand",
  "helperCommand",
]);

// Methods a backend MAY declare. Declared as optional rather than left undocumented so the
// fail-closed validation still applies: a backend that spells one of these wrong, or hangs a
// non-function on the name, does not load — the failure mode these guard against is a silent
// no-op (the credential gate that quietly stopped gating is exactly how this list started).
// A caller must always check for presence before calling one; see runtimeCanCarry().
export const OPTIONAL_METHODS = Object.freeze([
  // credentialError(target, engineId) → string|Error|null — the pre-spawn "can this engine
  // authenticate in this runtime?" gate. The local runtime has none: the daemon's own logins are
  // right there.
  "credentialError",
  // copyIn(target, entries) / copyOut(target, entries) → Promise<{ copied: number }> — move
  // ENGINE STATE between the daemon's filesystem and this runtime's. `copyIn` writes into the
  // runtime, `copyOut` reads out of it; both take CarryEntry[] (src/runtimes/copy.js) whose
  // `from`/`to` are absolute on their own side and share the relative tail `rel`. They exist so a
  // thread's engine-native history follows it when its channel changes runtime backend — see
  // src/gateway/session-carry.js. A backend that declares neither simply cannot carry, and the
  // orchestrator skips the carry instead of failing the turn.
  "copyIn",
  "copyOut",
  // inspectState(target, { globs, maxLines, maxBytes }) → Promise<[{ path, mtimeMs, head }]> — READ
  // engine state where it lies, without moving it. The read-only twin of the carry pair, and the
  // only way to answer "does this session exist in this channel, and where was it started?" for a
  // runtime whose persistent HOME the daemon cannot open: rootless Podman maps a named volume
  // behind a user namespace, so `<volume>/_data` is unreachable from the daemon even though the
  // files inside belong to it. See src/gateway/session-adopt.js.
  "inspectState",
]);

// Whether a backend can move engine state in and out of itself. Both halves or neither: a backend
// that could only be written to would strand every session it ever received.
export function runtimeCanCarry(backendOrTarget) {
  const backend = backendOrTarget?.runtime || backendOrTarget;
  return typeof backend?.copyIn === "function" && typeof backend?.copyOut === "function";
}

// Whether a backend can be ASKED about the engine state it holds. A backend that cannot simply
// contributes no candidate store, and the caller falls back to the dirs it can read itself.
export function runtimeCanInspectState(backendOrTarget) {
  const backend = backendOrTarget?.runtime || backendOrTarget;
  return typeof backend?.inspectState === "function";
}

// The daemon-side helpers an ENGINE spawns during a run (not the daemon): the gateway control MCP
// server, the Codex secret-env bridge, the Composio SDK bridge, the Stop hook. Inside a container they are
// the baked runtime bundle in the image; the local runtime has none (daemon-internal turns spawn
// no helpers). Callers ask the backend for the command instead of composing a repo path.
export const HELPER_COMMANDS = Object.freeze([
  "gateway-mcp", // the gateway control MCP server (stdio)
  "secret-env-bridge", // src/mcp/secret-env-bridge.js — Codex: bundle → env → exec target
  "composio-sdk-bridge", // src/mcp/composio-sdk-bridge.js — Composio SDK-mode stdio server
  "stop-subagents-hook", // src/gateway/hooks/stop-subagents.mjs — the Claude Stop hook
  "mcp-remote", // the pinned mcp-remote bridge for header-bearing remote MCPs
]);

/**
 * A RuntimeTarget is resolved ONCE per run by `resolveRuntime()` (src/runtimes/resolve.js) and
 * handed to every backend call. Runners, the warm pool, folders.js, mcp.js, background jobs and
 * memory review all receive it — none of them imports this package's registry.
 *
 * @typedef {object} RuntimeTarget
 * @property {"host"|"container"} backend   id, for logs / DB rows / status
 * @property {object} runtime               the backend object (call runtime.spawn(target, spec) …)
 * @property {string} reason                why this backend: "disabled" | "admin-mode" | "channel" | "default"
 * @property {string} slug
 * @property {string} platform
 * @property {object} meta                  the effective channel meta
 * @property {string} cwd                   the directory the run executes in (effectiveWorkDir incl. clean mode)
 * @property {string} workDir               the durable channel workdir — the bind-mount source; = cwd unless clean mode
 * @property {string} cleanWorkDir          cleanWorkspaceFolder(slug, platform); mounted too so clean mode works in-container
 * @property {string|null} artifactDir      where per-run ENGINE-FACING files go for this target: null = today's host
 *                                          locations (runTmpDir(), the metadata runtime/ dir); a container target gets
 *                                          channelArtifactDir(), bind-mounted at the identical absolute path
 * @property {object} settings              getContainerRuntime() snapshot (backends read this, never settings.js)
 * @property {object|null} container        filled by the container backend's prepareTarget(): { name, homeVolume,
 *                                          image, network, uid, gid, credentialMode, limits, … }
 */

/**
 * @typedef {object} SpawnSpec
 * @property {string} cmd            engine/helper binary on the BACKEND's PATH (the host's, or the image's)
 * @property {string[]} args
 * @property {string} [cwd]          defaults to target.cwd
 * @property {object} env            the FINAL env — already through buildClaudeEnv/buildCodexEnv → safeSpawnEnv
 * @property {Array|string} [stdio]  defaults to ["ignore", "pipe", "pipe"]
 * @property {boolean} [detached]    defaults to true — the HOST process-group flag (child_process.spawn's `detached`),
 *                                   so a group kill takes MCP grandchildren; the container backend ignores it (every
 *                                   in-container run already owns a session via cg-exec). NOT "run without stdio".
 * @property {boolean} [background]  a BACKGROUND JOB: no client stdio, the process outlives the daemon and is found
 *                                   again by runId (host: today's detached bash; container: `exec -d`). Runners never
 *                                   set it; background.js does. The two flags are independent.
 * @property {string} runId          unique per spawn — newRunId("run"|"job"|"review"|"warm"); the container boot
 *                                   sweep kills `run-*` and `warm-*` groups only, so jobs survive a daemon restart
 * @property {string} [kind]         "turn" | "warm" | "job" | "review" | "probe" — for status and labels
 */

/**
 * What `spawn()` returns: a real ChildProcess (host) or a ChildProcess-shaped object (container —
 * the `<cli> exec -i …` client, whose stdio IS the engine's stdio). Either way it carries:
 *   pid, stdin, stdout, stderr, kill(sig), on("exit"|"close"|"error"), exitCode, signalCode, killed,
 *   runtime: { backend: id, runId, kind, target }
 * Callers must keep the stdin "error" listener persistent-session.js already installs (EPIPE).
 * @typedef {import("node:child_process").ChildProcess & { runtime: { backend: string, runId: string, kind: string, target: RuntimeTarget } }} RuntimeChild
 */

/**
 * The backend surface. Every method is documented against the host semantics it must preserve.
 *
 * prepareTarget(base)            → RuntimeTarget  (sync) — enrich the base target with backend-specific
 *                                  facts (container names, volume, image, credential mode). Pure; no I/O
 *                                  beyond reading `base.settings`. Host returns `base` with artifactDir=null.
 * ensureUp(target, opts)         → Promise<{ created, started, warmupMs }> — make the run environment ready
 *                                  (create/start the container). Host: no-op. Callers await it once per turn
 *                                  BEFORE spawn; `opts.announce(text)` lets a slow start tell the user, and
 *                                  `opts.lease` is the caller's OWN lease handle (when it took one first) so
 *                                  the backend can tell "someone else is inside" from "I am".
 * spawn(target, spec)            → RuntimeChild (sync, like child_process.spawn). Never throws for a missing
 *                                  binary — the child emits "error" exactly like spawn does.
 * probe(child)                   → Promise<boolean> — is the run's process (group) still alive? Host:
 *                                  kill(pid, 0). Container: an exec'd probe of the recorded pgid. Async on
 *                                  purpose; the watchdog awaits it.
 * signal(child, signal)          → Promise<boolean> — deliver `signal` to the run's WHOLE process group.
 *                                  Host: killTree (negative-pid group kill, single-pid fallback).
 * acquireLease(target, lease)    → { id, release() } — declare activity that must keep the run environment
 *                                  up: { kind: "run"|"job"|"review"|"dev", id }. Host: no-op. The container
 *                                  reaper stops nothing that holds a lease and counts release() as activity.
 * destroy(target, opts)          → Promise<void> — tear the run environment down. { volumes:false, reason }.
 *                                  Host: no-op. Container: stop + rm; the HOME volume only with volumes:true
 *                                  (channel deletion) — never on rollback or reconfiguration.
 * fingerprint(target)            → string — digest of CREATE-TIME config (image id, mounts, network, uid
 *                                  strategy, limits, credential mode). Host: "host". Warm-pool keys include it
 *                                  so a recreated container retires warm processes; per-exec inputs (env,
 *                                  secrets, prompt, model) are NOT part of it.
 * describe(target)               → Promise<{ backend, state, containerName?, image?, imageVersion?, upSince?,
 *                                  warm?, reason? }> — for /status, the heartbeat row, the admin UI.
 * resumeCommand(target, opts)    → string — wrap `opts.baseCommand` (the engine's own resume command from
 *                                  src/engines/registry.js) in the backend's form; host returns it verbatim,
 *                                  container returns `<cli> exec -it -w <cwd> <name> <baseCommand>`.
 * helperCommand(target, name)    → { command, args } — how the ENGINE launches one of HELPER_COMMANDS in this
 *                                  runtime (host: process.execPath + the checkout script; container: the
 *                                  image's /opt/channelgate bundle). Unknown names throw.
 *
 * OPTIONAL (see OPTIONAL_METHODS):
 * copyIn(target, entries)        → Promise<{ copied }> — write engine state from the DAEMON's filesystem
 *                                  into this runtime. Host: a plain node:fs copy. Container: stage under the
 *                                  bind-mounted artifact dir, then one exec inside that copies each entry
 *                                  into place; the staging dir is removed either way.
 * copyOut(target, entries)       → Promise<{ copied }> — the same in reverse. Overwrite, never delete, and a
 *                                  missing source is 0 copied rather than an error.
 * inspectState(target, request)  → Promise<[{ path, mtimeMs, head }]> — the files inside this runtime that
 *                                  match `request.globs` (carry-style: `*` inside a segment, never across
 *                                  one), each with its mtime and the first `maxLines` lines / `maxBytes`
 *                                  bytes of it. Reads only; moves nothing. Container: one `sh -c` inside,
 *                                  because a rootless HOME volume is unreadable from the daemon.
 */
export function validateRuntimeBackend(backend) {
  if (!backend || typeof backend !== "object") throw new TypeError("RuntimeBackend must be an object");
  if (!RUNTIME_BACKEND_IDS.includes(backend.id)) throw new TypeError(`RuntimeBackend has unknown id "${backend.id}"`);
  if (!backend.capabilities || typeof backend.capabilities !== "object") {
    throw new TypeError(`RuntimeBackend ${backend.id} must declare capabilities`);
  }
  for (const key of Object.keys(RUNTIME_CAPABILITY_SPEC)) {
    if (typeof backend.capabilities[key] !== "boolean") {
      throw new TypeError(`RuntimeBackend ${backend.id} must declare capability ${key} as a boolean`);
    }
  }
  for (const key of Object.keys(backend.capabilities)) {
    if (!(key in RUNTIME_CAPABILITY_SPEC)) throw new TypeError(`RuntimeBackend ${backend.id} declares unknown capability "${key}"`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof backend[method] !== "function") throw new TypeError(`RuntimeBackend ${backend.id} missing ${method}()`);
  }
  for (const method of OPTIONAL_METHODS) {
    if (backend[method] !== undefined && typeof backend[method] !== "function") {
      throw new TypeError(`RuntimeBackend ${backend.id} declares ${method} but it is not a function`);
    }
  }
  return backend;
}

// Read a capability with the fail-closed default; an unknown key throws (a typo must never read as
// "unsupported and therefore skipped").
export function runtimeSupports(backendOrTarget, key) {
  const spec = RUNTIME_CAPABILITY_SPEC[key];
  if (!spec) throw new TypeError(`unknown runtime capability "${key}"`);
  const backend = backendOrTarget?.runtime || backendOrTarget;
  const v = backend?.capabilities?.[key];
  return typeof v === "boolean" ? v : spec.default;
}

// Tag a child so probe/signal callers can tell a runtime child from a bare ChildProcess.
export function attachRuntime(child, { backend, runId, target, kind = "turn" }) {
  child.runtime = Object.freeze({ backend: backend.id, runId: String(runId || ""), kind, target });
  return child;
}

export function isRuntimeChild(child) {
  return Boolean(child && child.runtime && typeof child.runtime.backend === "string");
}

// Run ids double as the container-side process-group handle (/run/cg/<runId>.pid), so they must be
// a single safe path component. `kind` is the prefix the boot sweep filters on.
export const RUN_ID_KINDS = Object.freeze(["run", "warm", "job", "review", "probe"]);
export function newRunId(kind = "run") {
  if (!RUN_ID_KINDS.includes(kind)) throw new TypeError(`unknown run id kind "${kind}"`);
  return `${kind}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}
export function runIdKind(runId) {
  const m = /^([a-z]+)-/.exec(String(runId || ""));
  return m && RUN_ID_KINDS.includes(m[1]) ? m[1] : "";
}
