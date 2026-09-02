// The target the backend prepares, how a containerized engine gets a login, and the small surfaces
// the daemon calls: helperCommand, spawn/probe/signal, boot and health.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeCli, inspectLine } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const credentials = await import("../src/runtimes/container/credentials.js");
const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
const { containerBackend, __setContainerRuntime, __resetContainerRuntime, credentialError } = await import("../src/runtimes/container/index.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { validateRuntimeBackend, newRunId } = await import("../src/runtimes/contract.js");
const { codexEngineHome } = await import("../src/config/paths.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");

const BASE = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: false,
};
const NO_CODEX_ENV = { CODEX_HOME: path.join(os.tmpdir(), "cg-no-such-codex-home") };

function target(slug, settings = BASE, meta = {}) {
  return resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container", ...meta }, { settings });
}

function writeClaudeCredentials(contents = '{"claudeAiOauth":{"accessToken":"host"}}') {
  const file = credentials.claudeCredentialsFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

// The login the gateway normally uses: the host user's own ~/.claude (test/helpers.js pins
// CLAUDE_CONFIG_DIR into the scratch dir so this never touches a developer's real credentials).
function writeOperatorCredentials(contents = '{"claudeAiOauth":{"accessToken":"operator"}}') {
  const file = path.join(operatorClaudeConfigDir(), ".credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

test("the backend satisfies the runtime contract", () => {
  assert.doesNotThrow(() => validateRuntimeBackend(containerBackend));
  assert.deepEqual(containerBackend.capabilities, { isolated: true, processGroups: true, detachedSurvivesDaemon: true, persistentHome: true });
});

test("prepareTarget is pure: same inputs, same target, no container touched", () => {
  const settings = { ...BASE, hasClaudeOauthToken: true, memory: "2g", cpus: "4" };
  const a = target("pure-chan", settings);
  const b = target("pure-chan", settings);
  assert.deepEqual(a.container, b.container);
  assert.equal(a.container.name, `cg-${currentInstallId()}-slack-pure-chan`);
  assert.equal(a.container.homeVolume, `${a.container.name}-home`);
  assert.equal(a.container.image, "channelgate/runtime:latest");
  assert.equal(a.container.network, "bridge");
  assert.equal(a.container.uid, process.getuid());
  assert.equal(a.container.gid, process.getgid());
  assert.deepEqual(a.container.limits, { pidsLimit: 1024, memory: "2g", cpus: "4" });
  assert.deepEqual(a.container.credentialMode, { claude: "token", codex: "shared-file" });
  assert.equal(a.container.imageId, "", "the image id is resolved by ensureUp, not by prepareTarget");
  assert.equal(a.container.appliedLimits, null);
  assert.ok(Array.isArray(a.container.mounts) && a.container.mounts.length >= 5);
  assert.equal(a.container.labels.channelgate, "1");
  assert.equal(a.container.labels["cg.install"], currentInstallId());
  assert.equal(a.container.labels["cg.channel"], "pure-chan");
  assert.equal(a.runtime, containerBackend);
  assert.equal(a.backend, "container");
  assert.match(a.artifactDir, /[\\/]\.runtime[\\/]slack[\\/]pure-chan$/);
});

test("Claude: token, else a RELAY of the resolved login — the login file is NEVER copied into a container", () => {
  const credFile = credentials.claudeCredentialsFile();
  const operatorFile = path.join(operatorClaudeConfigDir(), ".credentials.json");
  rmSync(credFile, { force: true });
  rmSync(operatorFile, { force: true });

  const withToken = credentials.settleCredentialModes({ ...BASE, hasClaudeOauthToken: true }, NO_CODEX_ENV);
  assert.equal(withToken.modes.claude, "token");
  assert.equal(withToken.claudeSource, "", "a configured token means nothing is copied or mounted");

  const noLogin = credentials.settleCredentialModes(BASE, NO_CODEX_ENV);
  assert.equal(noLogin.modes.claude, "missing");

  // The OPERATOR's own login is the normal case now that nothing plants a copy in the engine home:
  // a container settles to "relay" purely because the host user is signed in.
  writeOperatorCredentials();
  const viaOperator = credentials.settleCredentialModes(BASE, NO_CODEX_ENV);
  assert.equal(viaOperator.modes.claude, "relay");
  assert.equal(viaOperator.claudeSource, operatorFile);
  assert.equal(credentials.credentialError({ container: { credentialMode: viaOperator.modes } }, "claude", NO_CODEX_ENV), null);
  rmSync(operatorFile, { force: true });

  // A login somebody signed the gateway's own engine home in with is RELAYED the same way (its
  // current access token rides the exec env), never copied: a copy forks the refresh chain and a
  // refresh in the container rotates the gateway itself out (live incident, 2026-09-02).
  writeClaudeCredentials();
  const relayed = credentials.settleCredentialModes(BASE, NO_CODEX_ENV);
  assert.equal(relayed.modes.claude, "relay");
  assert.equal(relayed.claudeSource, credFile);
  assert.equal(typeof credentials.stageClaudeSeed, "undefined", "no seed-staging code path may exist");
  assert.match(credentials.CLAUDE_MISSING_MESSAGE, /setup-token/);
  assert.match(credentials.CLAUDE_MISSING_MESSAGE, /Sign in with `claude` on the gateway host/);
});

test("Codex: the resolved auth FILE is shared read-write; no file at all is a refusal", () => {
  const engineAuth = path.join(codexEngineHome(), "auth.json");
  rmSync(engineAuth, { force: true });

  const missing = credentials.settleCredentialModes(BASE, NO_CODEX_ENV);
  assert.equal(missing.modes.codex, "missing");
  assert.equal(missing.codexAuthFile, "");

  mkdirSync(codexEngineHome(), { recursive: true });
  writeFileSync(engineAuth, '{"tokens":{"refresh_token":"r"}}', { mode: 0o600 });
  const shared = credentials.settleCredentialModes(BASE, NO_CODEX_ENV);
  assert.equal(shared.modes.codex, "shared-file");
  assert.equal(shared.codexAuthFile, engineAuth);
  // The engine home is preferred over the host CODEX_HOME, in the same order the runner resolves it.
  assert.deepEqual(credentials.codexAuthCandidates(NO_CODEX_ENV), [engineAuth, path.join(NO_CODEX_ENV.CODEX_HOME, "auth.json")]);
  rmSync(engineAuth, { force: true });
});

test("credentialError names the remedy per engine and stays silent when the engine can run", () => {
  const ok = target("cred-ok");
  ok.container.credentialMode = { claude: "token", codex: "shared-file" };
  assert.equal(credentialError(ok, "claude"), null);
  assert.equal(credentialError(ok, "codex"), null);

  const bad = target("cred-bad");
  bad.container.credentialMode = { claude: "missing", codex: "missing" };
  assert.match(credentialError(bad, "claude").message, /no Claude login to relay.*claude setup-token.*Settings → Container runtime/s);
  assert.match(credentialError(bad, "codex").message, /Codex is not signed in — run `codex login` on the gateway host/);

  const tokenMode = target("cred-token");
  tokenMode.container.credentialMode = { claude: "token", codex: "shared-file" };
  tokenMode.container.codexAuthFile = writeClaudeCredentials();
  assert.equal(credentialError(tokenMode, "claude"), null);
  assert.equal(credentialError(tokenMode, "codex"), null);
  const noToken = target("cred-none");
  noToken.container.credentialMode = { claude: "missing", codex: "shared-file" };
  assert.match(String(credentialError(noToken, "claude")?.message), /setup-token/, "no login at all = fail closed, never a copy");
  const relayMode = target("cred-relay");
  relayMode.container.credentialMode = { claude: "relay", codex: "shared-file" };
  writeClaudeCredentials();
  assert.equal(credentialError(relayMode, "claude"), null, "a readable gateway login can be relayed");
  rmSync(credentials.claudeCredentialsFile(), { force: true });
  assert.match(String(credentialError(relayMode, "claude")?.message), /no Claude login to relay/);

  // The gate must be right even when it is called BEFORE ensureUp has settled the target, where
  // the modes are still the pure "intent" prepareTarget produced.
  const unsettled = target("cred-unsettled");
  assert.deepEqual(unsettled.container.credentialMode, { claude: "relay", codex: "shared-file" });
  rmSync(credentials.claudeCredentialsFile(), { force: true });
  assert.match(credentialError(unsettled, "claude").message, /no Claude login to relay/);
  assert.match(credentialError(unsettled, "codex", NO_CODEX_ENV).message, /Codex is not signed in/);
  const notes = credentials.credentialNotes(tokenMode);
  assert.ok(!notes.some((n) => /copy of the gateway's Claude login/.test(n)), "no copy-mode note may exist");
  assert.ok(notes.some((n) => /sign-in file is shared/.test(n)));
});

test("the container environment always points HOME and both engine state dirs into the HOME volume", () => {
  const t = target("env-chan");
  assert.deepEqual(credentials.containerEnvDefaults(t), {
    HOME: "/home/agent",
    CLAUDE_CONFIG_DIR: "/home/agent/.claude",
    CODEX_HOME: "/home/agent/.codex",
    CG_RUNTIME: "container",
    CG_CHANNEL: "env-chan",
    CG_PLATFORM: "slack",
  });
});

test("helperCommand answers with the image bundle, never a checkout path", () => {
  const t = target("helper-chan");
  // Every engine-facing helper is `node <script inside the image>`: Codex reaches them through
  // secret-env-bridge, which re-execs process.execPath with a script path, so a bare shell shim
  // would fail there.
  assert.deepEqual(containerBackend.helperCommand(t, "gateway-mcp"), { command: "node", args: ["/opt/channelgate/bin/cg-mcp-bridge.mjs"] });
  assert.deepEqual(containerBackend.helperCommand(t, "secret-env-bridge"), { command: "node", args: ["/opt/channelgate/mcp/secret-env-bridge.js"] });
  // Composio SDK mode is a second service on the same daemon socket — the same bridge, not a
  // separate process (which is why composio-sdk-bridge.js is not in the image at all).
  assert.deepEqual(containerBackend.helperCommand(t, "composio-sdk-bridge"), { command: "node", args: ["/opt/channelgate/bin/cg-mcp-bridge.mjs"] });
  assert.deepEqual(containerBackend.helperCommand(t, "stop-subagents-hook"), { command: "node", args: ["/opt/channelgate/gateway/hooks/stop-subagents.mjs"] });
  // Not the raw binary: the broker reads the 0600 secret bundle, then execs the pinned mcp-remote.
  assert.deepEqual(containerBackend.helperCommand(t, "mcp-remote"), { command: "node", args: ["/opt/channelgate/mcp/remote-secret-bridge.js"] });
  assert.throws(() => containerBackend.helperCommand(t, "warp-drive"), /unknown runtime helper/);
  for (const name of ["gateway-mcp", "secret-env-bridge", "composio-sdk-bridge", "stop-subagents-hook", "mcp-remote"]) {
    const helper = containerBackend.helperCommand(t, name);
    assert.equal(helper.command, "node");
    for (const arg of helper.args) assert.ok(arg.startsWith("/opt/channelgate/"), `${name} must resolve inside the image`);
  }
  // The mutable copy a caller gets must not be able to corrupt the table.
  const grabbed = containerBackend.helperCommand(t, "gateway-mcp");
  grabbed.args.push("--oops");
  assert.deepEqual(containerBackend.helperCommand(t, "gateway-mcp").args, ["/opt/channelgate/bin/cg-mcp-bridge.mjs"]);
});

test("the target carries the image's own paths so a runner never keeps a second copy of them", () => {
  const t = target("imgpaths-chan");
  assert.equal(t.container.home, "/home/agent");
  assert.equal(t.container.path, "/home/agent/.npm-global/bin:/home/agent/.local/bin:/home/agent/bin:/opt/channelgate/bin:/usr/local/bin:/usr/bin:/bin:/home/agent/.cargo/bin:/home/agent/.bun/bin:/home/agent/.deno/bin:/home/agent/go/bin");
  assert.equal(t.container.tmpDir, "/tmp");
  assert.equal(t.container.claudeConfigDir, "/home/agent/.claude");
  assert.equal(t.container.codexHome, "/home/agent/.codex");
  assert.equal(t.container.socketDir, "/run/channelgate");
  // The Containerfile must bake in exactly the PATH the constants module declares.
  const containerfile = readFileSync(new URL("../containers/Containerfile", import.meta.url), "utf8");
  assert.ok(containerfile.includes(`PATH=${t.container.path}`), "containers/Containerfile PATH has drifted from src/runtimes/container/image-paths.js");
  assert.ok(containerfile.includes(`NPM_CONFIG_PREFIX=${t.container.npmPrefix}`));
});

test("homeVolumeHostPath names the HOME volume's data dir once the CLI has been probed", async () => {
  const t0 = target("volpath-chan");
  assert.equal(t0.container.homeVolumeHostPath, "", "unprobed: no host path is claimed");
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "info", result: { code: 0, stdout: JSON.stringify({ host: { buildahVersion: "1.42.1", security: { rootless: true } }, version: { Version: "5.7.0" }, store: { volumePath: "/home/me/.local/share/containers/storage/volumes" } }) } },
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "inspect", result: { code: 125, stderr: "no such container" } },
    ],
  });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    const t = target("volpath-chan");
    await containerBackend.ensureUp(t, {});
    assert.equal(t.container.homeVolumeHostPath, `/home/me/.local/share/containers/storage/volumes/${t.container.homeVolume}/_data`);
  } finally {
    __resetContainerRuntime();
  }
});

test("ensureUp settles the credential modes onto the target and drops the Codex mount when there is none", async () => {
  rmSync(path.join(codexEngineHome(), "auth.json"), { force: true });
  writeClaudeCredentials();
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:settled|1.0.0" } },
      { match: (a) => a[1] === "inspect", result: { code: 125, stderr: "no such container" } },
    ],
  });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    const t = target("settle-chan");
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = NO_CODEX_ENV.CODEX_HOME;
    try {
      await containerBackend.ensureUp(t, {});
    } finally {
      process.env.CODEX_HOME = saved;
    }
    assert.equal(t.container.imageId, "sha256:settled");
    assert.equal(t.container.imageVersion, "1.0.0");
    assert.equal(t.container.uidStrategy, "keep-id");
    // A gateway login on disk is relayed as an access token at spawn (never copied — credentials.js).
    assert.deepEqual(t.container.credentialMode, { claude: "relay", codex: "missing" });
    assert.ok(!t.container.mounts.some((m) => m.kind === "codex-auth"), "no Codex login means no Codex mount");
    const run = fake.last("run");
    assert.ok(!run.some((arg) => typeof arg === "string" && arg.includes("/.codex/auth.json")));
    assert.ok(run.includes(`CG_ARTIFACT_DIR=${t.artifactDir}`));
    // Nothing credential-shaped is ever staged on the host side of a mount.
    assert.ok(!existsSync(path.join(t.artifactDir, "seed")), "no Claude credential seed may be staged");

    // A Codex login that appears between two ensureUp passes must come BACK as a mount: the
    // out-of-band retry re-runs ensureUp on the same target object.
    mkdirSync(codexEngineHome(), { recursive: true });
    writeFileSync(path.join(codexEngineHome(), "auth.json"), '{"tokens":{"refresh_token":"r"}}', { mode: 0o600 });
    await containerBackend.ensureUp(t, {});
    const codexMount = t.container.mounts.find((m) => m.kind === "codex-auth");
    assert.ok(codexMount, "the Codex mount must reappear once the gateway is signed in");
    assert.equal(codexMount.source, path.join(codexEngineHome(), "auth.json"));
    assert.equal(codexMount.resolved, true);
    assert.equal(t.container.credentialMode.codex, "shared-file");
    assert.equal(t.container.mounts.filter((m) => m.kind === "codex-auth").length, 1, "settling must not duplicate mounts");
    rmSync(path.join(codexEngineHome(), "auth.json"), { force: true });
  } finally {
    __resetContainerRuntime();
  }
});

test("spawn before ensureUp emits an error on the child instead of throwing", async () => {
  __setContainerRuntime({ exec: createFakeCli({ kind: "podman" }).exec, log: () => {} });
  try {
    const t = target("unprepared-chan");
    const child = containerBackend.spawn(t, { cmd: "claude", args: [], env: {}, runId: newRunId("run"), kind: "turn" });
    assert.equal(child.runtime.backend, "container");
    const error = await new Promise((resolve) => child.once("error", resolve));
    assert.match(error.message, /ensureUp\(\) must be awaited before spawn\(\)/);
  } finally {
    __resetContainerRuntime();
  }
});

test("probe and signal address the run by id inside the container, and an unreachable CLI never reads as death", async () => {
  const answers = { probe: { code: 0, stdout: "" } };
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "exec" && a.includes("cg-probe"), result: () => answers.probe },
      { match: (a) => a[1] === "exec" && a.includes("cg-signal"), result: { code: 0 } },
    ],
  });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    const t = target("probe-chan");
    const child = { runtime: { backend: "container", runId: "run-77", target: t, kind: "turn" } };

    assert.equal(await containerBackend.probe(child), true);
    assert.deepEqual(fake.last("exec"), ["podman", "exec", t.container.name, "cg-probe", "run-77"]);

    answers.probe = { code: 1, stdout: "0\n" };
    assert.equal(await containerBackend.probe(child), false, "cg-probe exit 1 is a definite death");

    answers.probe = { code: 125, stderr: 'Error: no container with name or ID "x" found: no such container' };
    assert.equal(await containerBackend.probe(child), false, "a vanished container took the run with it");

    answers.probe = { code: 124, stderr: "[timed out after 20000ms]" };
    assert.equal(await containerBackend.probe(child), true, "an inconclusive probe must keep the turn waiting, not end it");

    assert.equal(await containerBackend.signal(child, "SIGTERM"), true);
    assert.deepEqual(fake.last("exec"), ["podman", "exec", t.container.name, "cg-signal", "run-77", "TERM"]);
    await containerBackend.signal(child, "SIGKILL");
    assert.equal(fake.last("exec").at(-1), "KILL");
  } finally {
    __resetContainerRuntime();
  }
});

test("a detached spawn uses exec -d and learns its real exit code from the recorded status", async () => {
  let alive = true;
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "exec" && a.includes("cg-probe"), result: () => (alive ? { code: 0 } : { code: 1, stdout: "42\n" }) },
      { match: (a) => a[1] === "exec" && a[2] === "-d", result: { code: 0, stdout: "sessionid\n" } },
    ],
  });
  __setContainerRuntime({ exec: fake.exec, log: () => {}, pollMs: 5 });
  try {
    const t = target("detached-chan");
    await t.runtime.ensureUp(t, {}).catch(() => {}); // populates the CLI probe cache
    const child = containerBackend.spawn(t, {
      cmd: "npm", args: ["test"], env: { A: "1" }, runId: "job-7", kind: "job",
      background: true, cwd: t.cwd, logFile: path.join(t.artifactDir, "jobs", "job-7.log"),
    });
    await child.started;
    const detachedArgv = fake.calls.map((c) => c.argv).find((argv) => argv[1] === "exec" && argv[2] === "-d");
    assert.ok(detachedArgv, "a detached spec must use `exec -d`");
    assert.ok(detachedArgv.includes("cg-exec") && detachedArgv.includes("job-7"));
    assert.ok(detachedArgv.includes(path.join(t.artifactDir, "jobs", "job-7.log")));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    alive = false;
    // The poll interval is deliberately unref'd (a background job must never hold the daemon
    // open), so the test holds the loop while it waits.
    const keepAlive = setInterval(() => {}, 5);
    const code = await exited;
    clearInterval(keepAlive);
    assert.equal(code, 42, "the exit status recorded inside the container comes back to the daemon");
  } finally {
    __resetContainerRuntime();
  }
});

test("boot and health: an unusable CLI is legible, a usable one lists our containers only", async () => {
  const broken = createFakeCli({ kind: "docker", available: [], routes: [] });
  __setContainerRuntime({ exec: broken.exec, log: () => {} });
  try {
    const { bootContainerRuntime, containerRuntimeStatus, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
    const logs = [];
    const status = await bootContainerRuntime({ settings: { ...BASE, enabled: true }, log: (m) => logs.push(m) });
    assert.equal(status.cli.ok, false);
    assert.ok(logs.some((m) => /enabled but unusable/.test(m)));
    const health = await containerRuntimeStatus({ ...BASE, enabled: true });
    assert.equal(health.cli.ok, false);
    assert.equal(health.running, 0);
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }

  const ours = inspectLine({ name: "cg-mine", status: "running", install: currentInstallId(), channel: "mine" });
  const working = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: "id1\n" } },
      { match: (a) => a[1] === "inspect", result: { code: 0, stdout: ours } },
      { match: (a) => a[1] === "exec", result: { code: 0, stdout: "" } },
    ],
  });
  __setContainerRuntime({ exec: working.exec, log: () => {} });
  try {
    const { bootContainerRuntime, containerRuntimeStatus, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
    const logs = [];
    const status = await bootContainerRuntime({ settings: { ...BASE, enabled: true }, log: (m) => logs.push(m) });
    assert.equal(status.cli.ok, true);
    assert.equal(status.image.present, true);
    assert.deepEqual(status.reconciled.running, ["cg-mine"]);
    assert.ok(logs.some((m) => /podman 5\.7\.0 \(rootless\)/.test(m)));
    const health = await containerRuntimeStatus({ ...BASE, enabled: true });
    assert.equal(health.enabled, true);
    assert.equal(health.cli.kind, "podman");
    assert.equal(health.image.id, "sha256:img");
    assert.equal(health.running, 1);
    assert.equal(health.containers[0].name, "cg-mine");
    assert.equal(health.containers[0].slug, "mine");
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }
});

test("describe reports state, credential modes and the shared-Codex caveat", async () => {
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "inspect", result: { code: 0, stdout: inspectLine({ name: "cg-desc", status: "running", install: currentInstallId(), fingerprint: "c1-live", imageId: "sha256:img" }) } },
      { match: (a) => a[1] === "exec" && a.includes("stat"), result: { code: 0, stdout: "12345:37\n" } },
    ],
  });
  __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    const t = target("desc-chan");
    t.container.credentialMode = { claude: "copy", codex: "shared-file" };
    t.container.fingerprint = "c1-live";
    t.container.codexAuthFile = credentials.claudeCredentialsFile(); // any real file, for the stat comparison
    writeClaudeCredentials();
    const described = await containerBackend.describe(t);
    assert.equal(described.backend, "container");
    assert.equal(described.state, "running");
    assert.equal(described.warm, true);
    assert.equal(described.containerName, t.container.name);
    assert.equal(described.fingerprintMatch, true);
    assert.deepEqual(described.credentialMode, { claude: "copy", codex: "shared-file" });
    assert.ok(described.notes.some((n) => /sign-in file is shared/.test(n)));
    assert.equal(described.codexAuth.shared, true);
    assert.equal(described.codexAuth.current, false, "a different inode inside means the container holds an older login");
  } finally {
    __resetContainerRuntime();
  }
});
