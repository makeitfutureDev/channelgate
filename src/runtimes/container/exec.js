// Spawning INTO a channel container, and the two things a pid namespace breaks: liveness and
// signals.
//
// The host-side child is the `<cli> exec` CLIENT. Its stdio IS the engine's stdio, so every runner
// keeps working unchanged, but its pid names the client and never the engine — so `probe()` and
// `signal()` ask the container instead, addressing the run by its runId through the process-group
// leader `cg-exec` recorded inside. Callers must never `process.kill(child.pid …)` a runtime child.
//
// Environment goes in through a 0600 `--env-file` under the channel's METADATA folder (host side,
// never mounted), never as `-e K=V`: argv is world-readable in `ps`, and a run's env carries the
// channel's own provider logins. The file is deleted when the child closes.
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attachRuntime } from "../contract.js";
import { channelFolder } from "../../config/paths.js";
import { cliEnv } from "./cli.js";
import { containerEnvDefaults } from "./credentials.js";
import { isContainerGoneError } from "./lifecycle.js";

const BACKEND_TAG = Object.freeze({ id: "container" });
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STALE_ENV_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_DETACHED_POLL_MS = 5_000;

// The env files live beside the other per-channel runtime scratch, under the metadata folder — the
// one place a container can never see.
export function envFileDir(target) {
  return path.join(channelFolder(target.slug, target.platform), "runtime", "env");
}

export function normalizeSignal(signal) {
  const name = String(signal || "SIGTERM").toUpperCase();
  return name.startsWith("SIG") ? name.slice(3) : name;
}

// Keys the CONTAINER owns. The runners compute a HOST environment (a synthetic Claude HOME under
// the gateway root, a host CODEX_HOME); inside a container those paths do not exist, so the
// backend's values win. This is the one place the caller's env is overridden rather than extended.
export const CONTAINER_OWNED_ENV = Object.freeze(["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CG_RUNTIME"]);

// Keys whose host value would send the run looking for binaries, modules and directories that only
// exist on the daemon's filesystem. `--env-file` is applied to the exec'd process and overrides the
// image's own environment, so a host PATH here means `cg-exec`, `claude` and `node` are suddenly
// not found. They are dropped so the image's values stand.
export const HOST_ONLY_ENV = Object.freeze([
  "PATH", "NODE_PATH", "NPM_CONFIG_PREFIX", "TMPDIR", "TMP", "TEMP", "SHELL", "USER", "LOGNAME",
  "PWD", "OLDPWD", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
]);

// The env a container exec actually receives: the run's env, minus what only makes sense on the
// host, plus the container-fixed identity. The Claude OAuth token is NOT added here — the runner
// passes it in `spec.env` (settings.js is out of this package's import graph on purpose), and
// `credentialError()` is what refuses the run before spawn when there is none.
export function containerRunEnv(target, env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (HOST_ONLY_ENV.includes(key)) continue;
    out[key] = value;
  }
  const owned = containerEnvDefaults(target);
  for (const key of CONTAINER_OWNED_ENV) {
    if (owned[key]) out[key] = owned[key];
  }
  if (!out.CG_CHANNEL) out.CG_CHANNEL = owned.CG_CHANNEL;
  if (!out.CG_PLATFORM) out.CG_PLATFORM = owned.CG_PLATFORM;
  return out;
}

// `--env-file` is line-oriented on both CLIs: KEY=VALUE, no quoting, no continuation. A value with
// a newline cannot be represented, so it is DROPPED and its NAME logged — silently truncating a
// credential would be worse than the engine reporting it missing.
export function renderEnvFile(env = {}) {
  const lines = [];
  const skipped = [];
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (!ENV_KEY.test(key)) {
      skipped.push(key);
      continue;
    }
    if (value.includes("\n") || value.includes("\0")) {
      skipped.push(key);
      continue;
    }
    lines.push(`${key}=${value}`);
  }
  return { body: lines.length ? `${lines.join("\n")}\n` : "", skipped };
}

// `background` (a job: no client stdio, `exec -d`, found again by runId) is NOT `detached`: the
// runners pass `detached: true` for the HOST's process-group semantics on every engine spawn, and
// reading that as "no stdio" handed the Claude warm process a null stdin (found live, CTR-01).
export function buildExecArgs(target, caps, { runId, cmd, args = [], cwd, envFile, background = false, logFile = "", stdinPiped = false }) {
  const name = target.container.name;
  // `-i` attaches the client's stdin. Only a spawn that actually pipes stdin (the warm Claude
  // session) wants it: attaching an "ignore"d stdin hands the engine a closed pipe, and Codex then
  // logs "Reading additional input from stdin…" — noise that was misread as the run's error when
  // a daemon restart interrupted the turn (live, CTR-20).
  const argv = ["exec"];
  if (background) argv.push("-d");
  else if (stdinPiped) argv.push("-i");
  if (envFile) argv.push("--env-file", envFile);
  argv.push("-w", cwd || target.cwd);
  // Rootless podman maps the daemon user through `--userns=keep-id` at CREATE time, so an exec
  // needs no user flag; everywhere else the uid is pinned per exec as well as per container.
  if (caps.uidStrategy !== "keep-id" && target.container.uid != null) {
    argv.push("--user", `${target.container.uid}:${target.container.gid}`);
  }
  argv.push(name, "cg-exec", runId);
  if (logFile) {
    // Detached runs have no client stdio, so their output goes to a file inside the artifact dir,
    // which is bind-mounted at the identical path — the daemon tails the very same file. The log
    // path travels as a positional, never interpolated into the script, so nothing needs quoting.
    argv.push("/bin/sh", "-c", 'log="$1"; shift; exec >>"$log" 2>&1; exec "$@"', "cg-log", logFile, cmd, ...args);
  } else {
    argv.push(cmd, ...args);
  }
  return argv;
}

function errorChild(target, spec, error) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: undefined, stdin: null, stdout: null, stderr: null,
    exitCode: null, signalCode: null, killed: false,
    kill() {
      return false;
    },
  });
  attachRuntime(child, { backend: BACKEND_TAG, runId: spec.runId, target, kind: spec.kind });
  queueMicrotask(() => child.emit("error", error));
  return child;
}

export function createContainerExec({ cli, lifecycle, reaper, log = () => {}, pollMs = DEFAULT_DETACHED_POLL_MS } = {}) {
  const timers = new Set();

  function sweepStaleEnvFiles(dir) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_ENV_MS;
    for (const name of names) {
      if (!name.endsWith(".env")) continue;
      const file = path.join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        /* raced with another cleanup */
      }
    }
  }

  function writeEnvFile(target, runId, env) {
    const dir = envFileDir(target);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepStaleEnvFiles(dir);
    const { body, skipped } = renderEnvFile(containerRunEnv(target, env));
    if (skipped.length) log(`[container] dropped ${skipped.length} environment value(s) a container env-file cannot carry: ${skipped.join(", ")}`);
    const file = path.join(dir, `${runId}.env`);
    writeFileSync(file, body, { mode: 0o600 });
    return file;
  }

  function discardEnvFile(file) {
    if (!file) return;
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  // Every asynchronous exec goes through here so the out-of-band-removal self-heal (Hermes rule,
  // plan §10) lives in ONE place: an exec that fails because the container vanished re-runs
  // ensureUp once and retries once.
  async function runExec(target, args, { retry = true, ...opts } = {}) {
    const caps = await cli.probe(target.settings, { image: target.settings?.image });
    if (!caps.ok) throw new Error(caps.reason);
    let result = await cli.runWith(caps, ["exec", ...args], opts);
    if (result.code !== 0 && retry && isContainerGoneError(result.stderr)) {
      log(`[container] ${target.container?.name} vanished mid-run — recreating and retrying once`);
      await lifecycle.ensureUp(target, {});
      result = await cli.runWith(caps, ["exec", ...args], opts);
    }
    return result;
  }

  function trackTimer(timer) {
    timer.unref?.();
    timers.add(timer);
    return timer;
  }

  // A detached exec has no client to wait on, so exit is discovered by polling cg-probe, which
  // reports the recorded exit status once the run's group leader is gone.
  function detachedChild(target, spec, envFile) {
    const child = new EventEmitter();
    let settled = false;
    let poll = null;
    const finish = (code, signal = null) => {
      if (settled) return;
      settled = true;
      if (poll) {
        clearInterval(poll);
        timers.delete(poll);
      }
      discardEnvFile(envFile);
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    };
    Object.assign(child, {
      pid: undefined, stdin: null, stdout: null, stderr: null,
      exitCode: null, signalCode: null, killed: false,
      kill(signal = "SIGTERM") {
        this.killed = true;
        // Fire and forget: shutdown paths must stay synchronous for the absolute deadline.
        runExec(target, [target.container.name, "cg-signal", spec.runId, normalizeSignal(signal)], { retry: false, timeoutMs: 20_000 })
          .catch(() => {});
        return true;
      },
    });
    attachRuntime(child, { backend: BACKEND_TAG, runId: spec.runId, target, kind: spec.kind });
    child.started = runExec(target, buildExecArgs(target, cli.peek(), { ...spec, envFile }).slice(1), { timeoutMs: 60_000 })
      .then((result) => {
        if (result.code !== 0) {
          discardEnvFile(envFile);
          child.emit("error", new Error(`could not start a detached run in ${target.container.name}: ${String(result.stderr || "").trim() || `exit ${result.code}`}`));
          return;
        }
        reaper.touch(target.container.name);
        poll = trackTimer(setInterval(() => {
          runExec(target, [target.container.name, "cg-probe", spec.runId], { retry: false, timeoutMs: 20_000 })
            .then((probe) => {
              if (probe.code === 0) return;
              const recorded = Number.parseInt(String(probe.stdout || "").trim(), 10);
              if (isContainerGoneError(probe.stderr)) finish(Number.isFinite(recorded) ? recorded : 137);
              else finish(Number.isFinite(recorded) ? recorded : 0);
            })
            .catch(() => {
              /* an unreachable CLI is not evidence the job died — keep polling */
            });
        }, pollMs));
      })
      .catch((error) => {
        discardEnvFile(envFile);
        child.emit("error", error);
      });
    return child;
  }

  return {
    // Synchronous, like child_process.spawn: it never throws for a missing binary or an unprepared
    // runtime — the child emits "error" instead, exactly as spawn does.
    spawn(target, spec) {
      const caps = cli.peek();
      if (!caps?.ok) {
        return errorChild(target, spec, new Error(
          "the container runtime was not prepared for this run — ensureUp() must be awaited before spawn()",
        ));
      }
      let envFile = "";
      try {
        envFile = writeEnvFile(target, spec.runId, spec.env || {});
      } catch (error) {
        return errorChild(target, spec, new Error(`could not write the container environment file: ${error?.message || error}`));
      }
      if (spec.background) return detachedChild(target, spec, envFile);

      const argv = buildExecArgs(target, caps, { ...spec, envFile, stdinPiped: Array.isArray(spec.stdio) && spec.stdio[0] === "pipe" });
      let child;
      try {
        child = spawnProcess(caps.bin, argv, {
          stdio: spec.stdio || ["ignore", "pipe", "pipe"],
          env: cliEnv(),
          // The CLIENT stays in the daemon's process group: it is a pipe, not the run. The run's
          // own group lives inside the container and is addressed through cg-signal.
          detached: false,
        });
      } catch (error) {
        discardEnvFile(envFile);
        return errorChild(target, spec, error);
      }
      attachRuntime(child, { backend: BACKEND_TAG, runId: spec.runId, target, kind: spec.kind });
      child.runtimeEnvFile = envFile;
      reaper.touch(target.container.name);
      child.once("close", () => {
        discardEnvFile(envFile);
        reaper.touch(target.container.name);
      });
      child.once("error", () => discardEnvFile(envFile));
      return child;
    },

    // TRUE means alive, FALSE means definitely gone. Anything we cannot answer (an unreachable CLI,
    // a timed-out probe) reports ALIVE on purpose: the stall watchdog ends a turn only on a
    // definite `false`, and a container-daemon hiccup must not look like a dead engine.
    async probe(child) {
      const target = child?.runtime?.target;
      const name = target?.container?.name;
      if (!name) return false;
      let result;
      try {
        // No self-heal here: a container that vanished took the run with it. Recreating it and
        // answering "alive" would be a lie about a process that no longer exists.
        result = await runExec(target, [name, "cg-probe", child.runtime.runId], { retry: false, timeoutMs: 20_000 });
      } catch (error) {
        log(`[container] liveness probe for ${name} could not run: ${error?.message || error}`);
        return true;
      }
      if (result.code === 0) {
        reaper.touch(name);
        return true;
      }
      if (result.code === 1 || isContainerGoneError(result.stderr)) return false;
      log(`[container] liveness probe for ${name} was inconclusive (exit ${result.code})`);
      return true;
    },

    async signal(child, signal = "SIGTERM") {
      const target = child?.runtime?.target;
      const name = target?.container?.name;
      if (!name) return false;
      try {
        const result = await runExec(target, [name, "cg-signal", child.runtime.runId, normalizeSignal(signal)], { retry: false, timeoutMs: 20_000 });
        return result.code === 0;
      } catch (error) {
        log(`[container] could not signal ${name}: ${error?.message || error}`);
        return false;
      }
    },

    runExec,
    writeEnvFile,
    discardEnvFile,
    clearTimers() {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },
  };
}
