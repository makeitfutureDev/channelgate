// The container CLI seam: which binary, what it can do, and the ONE place a child process is
// started from. Everything else in this package composes argv and hands it here, so a unit test
// injects a fake `exec` and asserts the exact command line instead of needing a container daemon.
//
// Podman and Docker share an argv surface, so there is no `if (bin === "podman")` in the backend:
// every difference is a CAPABILITY this probe reports (uid strategy, --init, --env-file, whether
// cgroup limits are actually delegated), exactly as src/platforms declares chat-surface
// differences and src/engines declares harness differences.
import { spawn } from "node:child_process";
import path from "node:path";

export const CLI_CANDIDATES = Object.freeze(["podman", "docker"]);
export const PROBE_TTL_MS = 60_000;

// The env the CLI CLIENT runs with — the daemon's, never the run's. A container CLI needs its
// socket/config discovery vars and nothing else; the engine's environment (which carries channel
// secrets) reaches the container through the 0600 --env-file, never through the client.
const CLI_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
  "CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINERS_CONF", "CONTAINERS_STORAGE_CONF", "CONTAINERS_REGISTRIES_CONF",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

export function cliEnv(source = process.env) {
  const env = {};
  for (const key of CLI_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

// The default exec: argv[0] is the binary. Never throws — a missing binary comes back as
// { code: 127, stderr } so discovery can move to the next candidate.
export function defaultExec(argv, { timeoutMs = 60_000, env = null, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env: env || cliEnv(), cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error?.message || error), argv });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code == null ? (signal ? 143 : 1) : code, stdout, stderr, argv, signal: signal || null });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      stderr += `\n[timed out after ${timeoutMs}ms]`;
      finish(124, null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (error) => {
      stderr += String(error?.message || error);
      finish(127, null);
    });
    child.on("close", finish);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// `docker` may be a podman shim (podman-docker) and a user may point `containerCli` at either
// name, so the KIND comes from what `info` actually returned, with the binary name as the tiebreak.
function detectKind(bin, info) {
  if (info?.host?.buildahVersion || info?.host?.cgroupManager || info?.store?.graphDriverName) return "podman";
  if (info?.ServerVersion !== undefined || info?.DockerRootDir !== undefined) return "docker";
  return path.basename(String(bin)).includes("podman") ? "podman" : "docker";
}

function detectRootless(kind, info) {
  if (kind === "podman") return info?.host?.security?.rootless === true;
  const options = Array.isArray(info?.SecurityOptions) ? info.SecurityOptions : [];
  return options.some((entry) => /rootless/i.test(String(entry)));
}

function detectVersion(kind, info) {
  if (kind === "podman") return String(info?.version?.Version || "");
  return String(info?.ServerVersion || "");
}

// Where named volumes live on the HOST. podman reports it outright; docker's is derived from its
// root dir. Used only to hand run.js a readable path into a channel's HOME volume — never mounted.
function detectVolumeRoot(kind, info) {
  if (kind === "podman") {
    const explicit = String(info?.store?.volumePath || "").trim();
    if (explicit) return explicit;
    const graph = String(info?.store?.graphRoot || "").trim();
    return graph ? `${graph}/volumes` : "";
  }
  const root = String(info?.DockerRootDir || "").trim();
  return root ? `${root}/volumes` : "";
}

// One line an operator can act on. The two states this host actually shows — "docker is installed
// but this account cannot reach its socket" and "no CLI at all" — must both be legible in
// /api/health and the boot log (brief §14, "live host").
function candidateReason(bin, result) {
  const stderr = String(result?.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";
  if (result?.code === 127) return `${bin}: not installed`;
  if (/permission denied/i.test(stderr)) return `${bin}: ${stderr} — add this account to the \`docker\` group or install podman`;
  return `${bin}: ${stderr || `\`${bin} info\` exited ${result?.code}`}`;
}

export function createContainerCli({ exec = defaultExec, now = () => Date.now(), log = () => {} } = {}) {
  let cache = null; // { key, at, caps }

  function candidatesFor(settings) {
    const choice = String(settings?.cli || "auto");
    return choice === "auto" || !CLI_CANDIDATES.includes(choice) ? [...CLI_CANDIDATES] : [choice];
  }

  function cacheKey(settings, image) {
    return `${String(settings?.cli || "auto")}|${String(image || "")}`;
  }

  function unavailable(reason) {
    return Object.freeze({
      bin: "", kind: "", rootless: false, uidStrategy: "user", supportsInit: false,
      supportsEnvFile: false, cgroupLimits: false, volumeRoot: "", version: "", ok: false, reason,
    });
  }

  async function helpFlags(bin, subcommand) {
    const result = await exec([bin, subcommand, "--help"], { timeoutMs: 15_000 });
    return String(result.stdout || "") + String(result.stderr || "");
  }

  async function probeOnce(settings, image) {
    const failures = [];
    for (const bin of candidatesFor(settings)) {
      const info = await exec([bin, "info", "--format", "json"], { timeoutMs: 30_000 });
      if (info.code !== 0) {
        failures.push(candidateReason(bin, info));
        continue;
      }
      const parsed = parseJson(info.stdout);
      const kind = detectKind(bin, parsed);
      const rootless = detectRootless(kind, parsed);
      const version = detectVersion(kind, parsed);
      if (kind === "docker" && !version) {
        // The docker CLI answers `info` with client-only JSON and exit 0 in some setups even when
        // the daemon is unreachable; an empty ServerVersion is the tell.
        failures.push(`${bin}: the CLI is installed but its daemon did not answer`);
        continue;
      }
      const runHelp = await helpFlags(bin, "run");
      const execHelp = await helpFlags(bin, "exec");
      const caps = {
        bin,
        kind,
        rootless,
        // Rootless podman maps the daemon user onto the SAME uid inside, so files the agent writes
        // in the bind-mounted workdir stay owned by the daemon user with no chown pass. Everywhere
        // else we pin the uid explicitly instead.
        uidStrategy: kind === "podman" && rootless ? "keep-id" : "user",
        supportsInit: /(^|\s)--init(\s|$|\[)/m.test(runHelp),
        supportsEnvFile: /--env-file/m.test(execHelp),
        cgroupLimits: false,
        volumeRoot: detectVolumeRoot(kind, parsed),
        version,
        ok: true,
        reason: "",
      };
      if (image) {
        // Hermes' lesson (plan §10): where cgroup controllers are not delegated, EVERY spawn would
        // fail on --memory/--cpus. One throwaway container answers it once per probe window; we
        // degrade to no limits with a warning instead of failing every run.
        const trial = await exec([bin, "run", "--rm", "--cpus", "1", "--memory", "128m", image, "true"], { timeoutMs: 60_000 });
        caps.cgroupLimits = trial.code === 0;
        if (!caps.cgroupLimits) {
          caps.reason = "cgroup cpu/memory limits are not delegated on this host — containers run without them";
          log(`[container] ${caps.reason}`);
        }
      }
      return Object.freeze(caps);
    }
    return unavailable(
      failures.length
        ? `no usable container CLI — ${failures.join("; ")}`
        : `no container CLI found (looked for ${candidatesFor(settings).join(", ")})`,
    );
  }

  return {
    // Cached for PROBE_TTL_MS. `invalidate()` is what a hard runtime failure calls so the next
    // turn re-discovers instead of trusting a stale "ok".
    async probe(settings, { image = "", force = false } = {}) {
      const key = cacheKey(settings, image);
      if (!force && cache && cache.key === key && now() - cache.at < PROBE_TTL_MS) return cache.caps;
      const caps = await probeOnce(settings, image);
      cache = { key, at: now(), caps };
      return caps;
    },

    invalidate() {
      cache = null;
    },

    // The last probe result without re-probing — for the synchronous paths (spawn, resumeCommand).
    peek() {
      return cache?.caps || null;
    },

    // A best-effort binary name for a SYNCHRONOUS caller that has not probed (a /resume line
    // rendered before the first run of the process). Never used to execute anything.
    binHint(settings) {
      const peeked = this.peek();
      if (peeked?.ok) return peeked.bin;
      const choice = String(settings?.cli || "auto");
      return CLI_CANDIDATES.includes(choice) ? choice : CLI_CANDIDATES[0];
    },

    // Run a CLI subcommand and return its result. Callers decide what a non-zero code means.
    async run(settings, argv, opts = {}) {
      const caps = await this.probe(settings, { image: opts.image || "" });
      if (!caps.ok) throw new Error(caps.reason);
      return exec([caps.bin, ...argv], opts);
    },

    // Same, but for a caller that already holds the caps (the lifecycle loop, which probes once).
    async runWith(caps, argv, opts = {}) {
      if (!caps?.ok) throw new Error(caps?.reason || "container CLI is unavailable");
      return exec([caps.bin, ...argv], opts);
    },

    exec,
  };
}
