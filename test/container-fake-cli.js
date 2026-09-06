// A scripted stand-in for `podman` / `docker`, shared by the container-backend tests. Every
// process execution in src/runtimes/container/ goes through one injectable `exec(argv, opts)`, so
// this records the exact command lines and returns canned results — no test ever touches a real
// container binary.
export function podmanInfo({ rootless = true, version = "5.7.0" } = {}) {
  return JSON.stringify({
    host: { buildahVersion: "1.42.1", cgroupManager: "systemd", cgroupVersion: "v2", security: { rootless } },
    version: { Version: version },
  });
}

export function dockerInfo({ rootless = false, version = "29.6.1" } = {}) {
  return JSON.stringify({
    ServerVersion: version,
    DockerRootDir: "/var/lib/docker",
    SecurityOptions: rootless ? ["name=rootless"] : ["name=seccomp,profile=builtin"],
  });
}

const RUN_HELP = "      --env-file stringArray   Read in a file of environment variables\n      --init                   Run an init binary\n";
const EXEC_HELP = "  -d, --detach\n      --env-file stringArray   Read in a file of environment variables\n  -i, --interactive\n";

/**
 * @param {object} opts
 *  - kind:        "podman" | "docker" (which binary answers `info`)
 *  - rootless:    reported by `info`
 *  - cgroupLimits: whether the throwaway `run --rm --cpus …` trial succeeds
 *  - available:   binaries that exist at all; anything else answers exit 127
 *  - routes:      [{ match(argv) => bool, result | result(argv), once? }] consulted before defaults
 */
export function createFakeCli({
  kind = "podman",
  rootless = true,
  cgroupLimits = true,
  available = null,
  routes = [],
} = {}) {
  const calls = [];
  const live = [...routes];
  const exists = available || [kind];

  function defaults(argv) {
    const [bin, ...rest] = argv;
    if (!exists.includes(bin)) return { code: 127, stdout: "", stderr: `spawn ${bin} ENOENT` };
    if (rest[0] === "info") {
      return { code: 0, stdout: bin === "podman" || kind === "podman" ? podmanInfo({ rootless }) : dockerInfo({ rootless }), stderr: "" };
    }
    if (rest[0] === "run" && rest[1] === "--help") return { code: 0, stdout: RUN_HELP, stderr: "" };
    if (rest[0] === "exec" && rest[1] === "--help") return { code: 0, stdout: EXEC_HELP, stderr: "" };
    if (rest[0] === "run" && rest.includes("--rm") && rest.includes("--cpus")) {
      return cgroupLimits ? { code: 0, stdout: "", stderr: "" } : { code: 125, stdout: "", stderr: "cgroup controllers not delegated" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async function exec(argv, opts = {}) {
    calls.push({ argv: [...argv], opts });
    for (let i = 0; i < live.length; i += 1) {
      const route = live[i];
      if (!route.match(argv)) continue;
      if (route.once) live.splice(i, 1);
      const value = typeof route.result === "function" ? route.result(argv) : route.result;
      return { code: 0, stdout: "", stderr: "", argv, ...value };
    }
    return { ...defaults(argv), argv };
  }

  return {
    exec,
    calls,
    addRoute(route) {
      live.unshift(route);
    },
    // Every recorded command line whose first CLI verb matches, newest last.
    find(verb) {
      return calls.filter((call) => call.argv[1] === verb).map((call) => call.argv);
    },
    last(verb) {
      const all = this.find(verb);
      return all[all.length - 1] || null;
    },
    reset() {
      calls.length = 0;
    },
  };
}

// The `inspect --format` line the lifecycle parses, in the exact 10-field shape INSPECT_FORMAT
// produces (podman prints an empty string for a missing label; docker prints "<no value>"). The
// last field is `cg.mounts` — empty for a container created before that label existed, which the
// lifecycle reads as "unknown mounts" and treats as changed.
export function inspectLine({
  name = "cg-test",
  status = "running",
  startedAt = "2026-09-02T01:51:32.139Z",
  imageId = "sha256:abc",
  fingerprint = "",
  install = "",
  image = "channelgate/runtime:latest",
  channel = "chan",
  platform = "slack",
  mountFingerprint = "",
} = {}) {
  return [name, status, startedAt, imageId, fingerprint, install, image, channel, platform, mountFingerprint].join("|");
}
