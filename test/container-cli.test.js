// The container CLI seam: what `probe()` reports for each binary, and the exact command lines the
// backend builds. Everything runs against the fake CLI — no test may call a real container binary.
import test from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFakeCli } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

// Pin the workspace root OUTSIDE the scratch gateway root before ensureTestEnv() claims it, so the
// "nothing under gatewayRoot()" mount assertions mean what they say.
process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { createContainerCli } = await import("../src/runtimes/container/cli.js");
const { createContainerImage } = await import("../src/runtimes/container/image.js");
const { buildCreateArgs } = await import("../src/runtimes/container/lifecycle.js");
const { buildExecArgs, renderEnvFile, createContainerExec, envFileDir } = await import("../src/runtimes/container/exec.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { containerBackend } = await import("../src/runtimes/container/index.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "2g", cpus: "4", hasClaudeOauthToken: true,
};

function target(slug = "cli-chan", overrides = {}) {
  return resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container", ...overrides }, { settings: SETTINGS });
}

test("probe: rootless podman reports keep-id, docker reports an explicit uid", async () => {
  const podman = createFakeCli({ kind: "podman", rootless: true });
  const podmanCaps = await createContainerCli({ exec: podman.exec }).probe(SETTINGS, { image: SETTINGS.image });
  assert.equal(podmanCaps.ok, true);
  assert.equal(podmanCaps.bin, "podman");
  assert.equal(podmanCaps.kind, "podman");
  assert.equal(podmanCaps.rootless, true);
  assert.equal(podmanCaps.uidStrategy, "keep-id");
  assert.equal(podmanCaps.supportsInit, true);
  assert.equal(podmanCaps.supportsEnvFile, true);
  assert.equal(podmanCaps.cgroupLimits, true);
  assert.equal(podmanCaps.version, "5.7.0");

  const docker = createFakeCli({ kind: "docker", rootless: false, available: ["docker"] });
  const dockerCaps = await createContainerCli({ exec: docker.exec }).probe(SETTINGS, { image: SETTINGS.image });
  assert.equal(dockerCaps.kind, "docker");
  assert.equal(dockerCaps.uidStrategy, "user");
  assert.equal(dockerCaps.version, "29.6.1");
});

test("probe: `auto` prefers podman, falls through to docker, and names why a candidate failed", async () => {
  const both = createFakeCli({ kind: "podman", available: ["podman", "docker"] });
  assert.equal((await createContainerCli({ exec: both.exec }).probe(SETTINGS)).bin, "podman");
  assert.deepEqual(both.calls[0].argv, ["podman", "info", "--format", "json"]);

  // This host's real state: docker installed, its socket unreachable, podman absent.
  const noPodman = createFakeCli({
    kind: "docker",
    available: ["docker"],
    routes: [{
      match: (argv) => argv[0] === "docker" && argv[1] === "info",
      result: { code: 1, stdout: "", stderr: "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock" },
    }],
  });
  const caps = await createContainerCli({ exec: noPodman.exec }).probe(SETTINGS);
  assert.equal(caps.ok, false);
  assert.match(caps.reason, /podman: not installed/);
  assert.match(caps.reason, /permission denied/);
  assert.match(caps.reason, /docker` group or install podman/);
});

test("probe: a docker CLI whose daemon never answers is not usable, and the result is cached until invalidated", async () => {
  const halfDocker = createFakeCli({
    kind: "docker",
    available: ["docker"],
    routes: [{ match: (a) => a[1] === "info", result: { code: 0, stdout: JSON.stringify({ ServerVersion: "", ClientInfo: { Version: "29.6.1" } }) } }],
  });
  const cli = createContainerCli({ exec: halfDocker.exec });
  const caps = await cli.probe(SETTINGS);
  assert.equal(caps.ok, false);
  assert.match(caps.reason, /daemon did not answer/);

  const podman = createFakeCli({ kind: "podman" });
  const cached = createContainerCli({ exec: podman.exec });
  await cached.probe(SETTINGS, { image: SETTINGS.image });
  const before = podman.calls.length;
  await cached.probe(SETTINGS, { image: SETTINGS.image });
  assert.equal(podman.calls.length, before, "a second probe inside the TTL must not re-run the CLI");
  cached.invalidate();
  await cached.probe(SETTINGS, { image: SETTINGS.image });
  assert.ok(podman.calls.length > before, "invalidate() must force a fresh probe");
});

test("image: a missing image is an actionable refusal, never an auto-build", async () => {
  const fake = createFakeCli({
    kind: "podman",
    routes: [{ match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 125, stderr: "Error: channelgate/runtime:latest: image not known" } }],
  });
  const cli = createContainerCli({ exec: fake.exec });
  const caps = await cli.probe(SETTINGS);
  const info = await createContainerImage({ cli }).inspect(caps, SETTINGS);
  assert.equal(info.present, false);
  assert.match(info.reason, /is not built — run `npm run build:image`/);
  assert.ok(!fake.calls.some((c) => c.argv[1] === "build"), "a run must never trigger an image build");
});

test("image: a present image yields the id and the spec-version label", async () => {
  const fake = createFakeCli({
    kind: "podman",
    routes: [{ match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:deadbeef|1.0.0\n" } }],
  });
  const cli = createContainerCli({ exec: fake.exec });
  const info = await createContainerImage({ cli }).inspect(await cli.probe(SETTINGS), SETTINGS);
  assert.deepEqual(info, { ref: "channelgate/runtime:latest", id: "sha256:deadbeef", version: "1.0.0", present: true, reason: "" });
});

test("create argv: podman keep-id vs docker --user, with the hardening flags and no secret on the command line", async () => {
  const t = target("argv-chan");
  t.container.imageId = "sha256:deadbeef";
  t.container.appliedLimits = { pidsLimit: 1024, memory: "2g", cpus: "4" };

  const podmanCaps = await createContainerCli({ exec: createFakeCli({ kind: "podman" }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const podmanArgs = buildCreateArgs(t, podmanCaps, { fingerprint: "c1-abc", created: "2026-09-02T00:00:00.000Z" });
  assert.equal(podmanArgs[0], "run");
  assert.deepEqual(podmanArgs.slice(1, 4), ["-d", "--name", t.container.name]);
  assert.ok(podmanArgs.includes("--userns=keep-id"));
  assert.ok(!podmanArgs.includes("--user"));
  assert.ok(podmanArgs.includes("--init"));
  assert.ok(podmanArgs.includes("--security-opt") && podmanArgs.includes("no-new-privileges"));
  assert.ok(podmanArgs.includes("--cap-drop") && podmanArgs.includes("ALL"));
  for (const cap of ["DAC_OVERRIDE", "CHOWN", "FOWNER"]) assert.ok(podmanArgs.includes(cap), `missing --cap-add ${cap}`);
  // /run is the ONLY tmpfs: /tmp and /var/tmp are persistent bind mounts now, so the idle
  // reaper's stop cannot empty what an agent parked there (test/container-durability.test.js).
  assert.ok(podmanArgs.includes("/run:rw,noexec,size=64m"));
  assert.equal(podmanArgs.filter((a) => a === "--tmpfs").length, 1);
  assert.ok(!podmanArgs.some((a) => typeof a === "string" && a.startsWith("/tmp:")), "/tmp must not be a tmpfs");
  assert.ok(!podmanArgs.some((a) => typeof a === "string" && a.startsWith("/var/tmp:")), "/var/tmp must not be a tmpfs");
  assert.ok(podmanArgs.includes(`${path.join(t.artifactDir, "tmp")}:/tmp`), "/tmp is bind-mounted from the channel's artifact dir");
  assert.ok(podmanArgs.includes(`${path.join(t.artifactDir, "var-tmp")}:/var/tmp`));
  assert.deepEqual(podmanArgs.slice(-3), ["cg-init", "sleep", "infinity"]);
  assert.equal(podmanArgs[podmanArgs.length - 4], "channelgate/runtime:latest");
  assert.ok(podmanArgs.includes("cg.fingerprint=c1-abc"));
  assert.ok(podmanArgs.includes("cg.created=2026-09-02T00:00:00.000Z"), "the create timestamp is stamped here, not in the pure prepareTarget");
  assert.ok(podmanArgs.includes(`cg.install=${t.container.labels["cg.install"]}`));
  assert.ok(podmanArgs.includes(`cg.channel=${t.slug}`));
  assert.ok(podmanArgs.includes("--pids-limit") && podmanArgs.includes("1024"));
  assert.ok(podmanArgs.includes("--memory") && podmanArgs.includes("2g"));
  assert.ok(podmanArgs.includes("--cpus") && podmanArgs.includes("4"));
  assert.ok(podmanArgs.includes("--network") && podmanArgs.includes("bridge"));

  const dockerCaps = await createContainerCli({ exec: createFakeCli({ kind: "docker", available: ["docker"] }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const dockerArgs = buildCreateArgs(t, dockerCaps, { fingerprint: "c1-abc" });
  assert.ok(!dockerArgs.includes("--userns=keep-id"));
  assert.ok(dockerArgs.includes("--user"));
  assert.equal(dockerArgs[dockerArgs.indexOf("--user") + 1], `${t.container.uid}:${t.container.gid}`);
});

test("create argv: network off maps to --network none, and cgroup limits are dropped when the probe failed", async () => {
  const off = target("net-off", { networkMode: "off" });
  off.container.appliedLimits = null;
  const caps = await createContainerCli({ exec: createFakeCli({ kind: "podman", cgroupLimits: false }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  assert.equal(caps.cgroupLimits, false);
  assert.match(caps.reason, /cgroup cpu\/memory limits are not delegated/);
  const args = buildCreateArgs(off, caps, { fingerprint: "c1-x" });
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(!args.includes("--memory"));
  assert.ok(!args.includes("--cpus"));
  assert.ok(!args.includes("--pids-limit"));
});

test("exec argv: -i, the env file, the workdir, and the cg-exec run wrapper — never -e", async () => {
  const t = target("exec-chan");
  const podmanCaps = await createContainerCli({ exec: createFakeCli({ kind: "podman" }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const args = buildExecArgs(t, podmanCaps, { runId: "run-1", cmd: "claude", args: ["-p", "hi"], cwd: t.cwd, envFile: "/x/run-1.env" });
  // No stdin piped (the cold Claude/Codex spawns use stdio "ignore") → no `-i`: attaching a closed
  // stdin made Codex log "Reading additional input from stdin…", which then masqueraded as the
  // run's error when a restart interrupted the turn (live, CTR-20).
  assert.deepEqual(args, ["exec", "--env-file", "/x/run-1.env", "-w", t.cwd, t.container.name, "cg-exec", "run-1", "claude", "-p", "hi"]);
  assert.ok(!args.includes("-e"));
  const piped = buildExecArgs(t, podmanCaps, { runId: "warm-2", cmd: "claude", args: [], cwd: t.cwd, envFile: "/x/warm-2.env", stdinPiped: true });
  assert.equal(piped[1], "-i", "a spawn that pipes stdin (the warm Claude session) attaches it");

  const dockerCaps = await createContainerCli({ exec: createFakeCli({ kind: "docker", available: ["docker"] }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const dockerArgs = buildExecArgs(t, dockerCaps, { runId: "run-2", cmd: "codex", args: [], cwd: t.cwd, envFile: "/x/run-2.env" });
  assert.equal(dockerArgs[dockerArgs.indexOf("--user") + 1], `${t.container.uid}:${t.container.gid}`);
  assert.ok(dockerArgs.indexOf("--user") < dockerArgs.indexOf(t.container.name));

  const detached = buildExecArgs(t, podmanCaps, { runId: "job-9", cmd: "npm", args: ["test"], cwd: t.cwd, envFile: "/x/job-9.env", background: true, logFile: "/art/jobs/j9.log" });
  assert.equal(detached[1], "-d");
  // `detached: true` is the HOST process-group flag every engine spawn sets — an attached exec, never `-d`.
  const engine = buildExecArgs(t, podmanCaps, { runId: "warm-1", cmd: "claude", args: ["-p", "x"], cwd: t.cwd, envFile: "/x/warm-1.env", detached: true, stdinPiped: true });
  assert.equal(engine[1], "-i", "an engine spawn is attached even though it is detached on the host");
  assert.ok(!engine.includes("-d"));
  assert.ok(detached.includes("/bin/sh"));
  // The log path travels as a positional so nothing has to be shell-quoted.
  assert.ok(detached.includes("/art/jobs/j9.log"));
  assert.equal(detached[detached.length - 2], "npm");
});

test("env file: 0600 under the metadata folder, values never on argv, unrepresentable values dropped by name", async () => {
  const t = target("envfile-chan");
  const fake = createFakeCli({ kind: "podman" });
  const cli = createContainerCli({ exec: fake.exec });
  await cli.probe(SETTINGS, { image: SETTINGS.image });
  const logged = [];
  const runner = createContainerExec({ cli, lifecycle: { async ensureUp() {} }, reaper: createContainerReaper(), log: (m) => logged.push(m) });
  const file = runner.writeEnvFile(t, "run-envtest", { SUPABASE_TOKEN: "sbp_secret", WITH_SPACE: "a b c", "BAD-KEY": "x", MULTILINE: "a\nb" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(path.dirname(file), envFileDir(t));
  assert.match(file, /channels[\\/]slack[\\/]envfile-chan[\\/]runtime[\\/]env[\\/]run-envtest\.env$/);
  const body = readFileSync(file, "utf8");
  const lines = body.trim().split("\n");
  assert.ok(lines.includes("SUPABASE_TOKEN=sbp_secret"));
  assert.ok(lines.includes("WITH_SPACE=a b c"));
  assert.ok(logged.some((m) => /BAD-KEY/.test(m) && /MULTILINE/.test(m)));
  runner.discardEnvFile(file);

  const { skipped } = renderEnvFile({ OK: "1", "1BAD": "x" });
  assert.deepEqual(skipped, ["1BAD"]);
});

test("env file: the container owns HOME and the engine state dirs, and host-only paths are dropped", async () => {
  const t = target("envown-chan");
  const fake = createFakeCli({ kind: "podman" });
  const cli = createContainerCli({ exec: fake.exec });
  await cli.probe(SETTINGS, { image: SETTINGS.image });
  const runner = createContainerExec({ cli, lifecycle: { async ensureUp() {} }, reaper: createContainerReaper() });
  const hostEnv = {
    PATH: "/home/management/.claude-launcher:/usr/local/bin",
    NODE_PATH: "/home/management/node_modules",
    NPM_CONFIG_PREFIX: "/home/management/.npm",
    TMPDIR: "/var/folders/host",
    SHELL: "/bin/zsh",
    USER: "management",
    XDG_RUNTIME_DIR: "/run/user/1001",
    HOME: "/home/management/.channelgate/engine-state/claude/home",
    CLAUDE_CONFIG_DIR: "/home/management/.channelgate/engine-state/claude/home/.claude",
    CODEX_HOME: "/home/management/.codex",
    CG_RUNTIME: "host",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-example",
    ANTHROPIC_MODEL: "opus",
  };
  const file = runner.writeEnvFile(t, "run-own", hostEnv);
  const written = Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  // A host PATH in the env file would override the image's, and `cg-exec` would not be found.
  for (const key of ["PATH", "NODE_PATH", "NPM_CONFIG_PREFIX", "TMPDIR", "SHELL", "USER", "XDG_RUNTIME_DIR"]) {
    assert.equal(key in written, false, `${key} must not survive into the container`);
  }
  assert.equal(written.HOME, "/home/agent");
  assert.equal(written.CLAUDE_CONFIG_DIR, "/home/agent/.claude");
  assert.equal(written.CODEX_HOME, "/home/agent/.codex");
  assert.equal(written.CG_RUNTIME, "container", "a host CG_RUNTIME must never leak into a container run");
  assert.equal(written.CG_CHANNEL, "envown-chan");
  // What the runner computed for the ENGINE is carried through untouched.
  assert.equal(written.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-example");
  assert.equal(written.ANTHROPIC_MODEL, "opus");
  runner.discardEnvFile(file);
});

test("stop / rm / inspect argv, and resumeCommand wraps the engine's own command", async () => {
  const t = target("verbs-chan");
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "inspect", result: { code: 125, stderr: "Error: no such container" } },
    ],
  });
  const { __setContainerRuntime, __resetContainerRuntime } = await import("../src/runtimes/container/index.js");
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    await containerBackend.destroy(t, { volumes: true, reason: "channel deleted" });
    const rm = fake.last("rm");
    assert.deepEqual(rm, ["podman", "rm", "-f", t.container.name]);
    const volume = fake.last("volume");
    assert.deepEqual(volume, ["podman", "volume", "rm", t.container.homeVolume]);
    const described = await containerBackend.describe(t);
    assert.equal(described.state, "missing");
    const inspect = fake.last("inspect");
    assert.equal(inspect[2], "--type");
    assert.equal(inspect[3], "container");
    assert.equal(inspect[4], "--format");
    assert.equal(inspect[inspect.length - 1], t.container.name);
    assert.equal(
      containerBackend.resumeCommand(t, { baseCommand: "claude --resume abc123" }),
      `podman exec -it -w ${t.cwd} ${t.container.name} claude --resume abc123`,
    );
  } finally {
    __resetContainerRuntime();
  }
});
