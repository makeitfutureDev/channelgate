// The container state machine, the mount contract, and the boot reconcile.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeCli, inspectLine } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { createContainerCli } = await import("../src/runtimes/container/cli.js");
const { createContainerImage } = await import("../src/runtimes/container/image.js");
const { createContainerLifecycle, containerFingerprint, isContainerGoneError, parseStartedAt, parseInspectLine, SOCKET_MOUNT_TARGET } = await import("../src/runtimes/container/lifecycle.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { configDir, gatewayRoot, runtimeSocketDir, cleanWorkspaceFolder, codexEngineHome } = await import("../src/config/paths.js");
const { CODEX_CONTAINER_AUTH_FILE } = await import("../src/runtimes/container/credentials.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};

function target(slug, overrides = {}) {
  return resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container", ...overrides }, { settings: SETTINGS });
}

// A fake CLI that always resolves the image and answers `inspect` from a mutable state object.
function harness({ state = { exists: false }, kind = "podman", extraRoutes = [] } = {}) {
  const fake = createFakeCli({
    kind,
    routes: [
      ...extraRoutes,
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      {
        match: (a) => a[1] === "inspect",
        result: () => (state.exists
          ? { code: 0, stdout: inspectLine({ ...state, install: state.install ?? currentInstallId() }) }
          : { code: 125, stderr: "Error: no such container" }),
      },
    ],
  });
  const logs = [];
  const cli = createContainerCli({ exec: fake.exec, log: (m) => logs.push(m) });
  const image = createContainerImage({ cli });
  const reaper = createContainerReaper({ log: (m) => logs.push(m) });
  const lifecycle = createContainerLifecycle({ cli, image, reaper, log: (m) => logs.push(m) });
  return { fake, cli, image, reaper, lifecycle, logs, state };
}

test("mounts: nothing under the gateway root but the clean workspace, the MCP socket dir and the Codex auth file — and nothing under config/", () => {
  const t = target("mounts-chan");
  const allowedUnderRoot = new Set([cleanWorkspaceFolder("mounts-chan", "slack"), runtimeSocketDir()]);
  const kinds = t.container.mounts.map((m) => m.kind);
  assert.deepEqual(kinds, ["workdir", "clean", "artifacts", "tmp", "var-tmp", "home", "socket", "codex-auth"]);

  for (const mount of t.container.mounts) {
    if (mount.type === "volume") continue;
    assert.ok(path.isAbsolute(mount.source), `${mount.kind} mount source must be absolute`);
    assert.ok(!mount.source.startsWith(`${configDir()}${path.sep}`) && mount.source !== configDir(), `${mount.kind} must never mount config/`);
    const underRoot = mount.source === gatewayRoot() || mount.source.startsWith(`${gatewayRoot()}${path.sep}`);
    if (!underRoot) continue;
    assert.ok(
      allowedUnderRoot.has(mount.source) || mount.kind === "codex-auth",
      `${mount.kind} (${mount.source}) is under the gateway root and is not one of the three allowances`,
    );
  }
  // Never the gateway root itself, the database, the metadata folder or the daemon checkout.
  const sources = t.container.mounts.map((m) => m.source);
  assert.ok(!sources.includes(gatewayRoot()));
  assert.ok(!sources.some((s) => s.endsWith("gateway.db")));
  assert.ok(!sources.some((s) => s.includes(`${path.sep}channels${path.sep}`)));
  // The socket dir is read-only; the Codex credential is the single FILE mount.
  const socket = t.container.mounts.find((m) => m.kind === "socket");
  assert.equal(socket.mode, "ro");
  assert.equal(socket.target, SOCKET_MOUNT_TARGET);
  const codex = t.container.mounts.find((m) => m.kind === "codex-auth");
  assert.equal(codex.type, "bind-file");
  assert.equal(codex.target, CODEX_CONTAINER_AUTH_FILE);
  assert.equal(codex.source, path.join(codexEngineHome(), "auth.json"));
  // Identical absolute paths on both sides is load-bearing.
  for (const kind of ["workdir", "clean", "artifacts"]) {
    const mount = t.container.mounts.find((m) => m.kind === kind);
    assert.equal(mount.source, mount.target);
  }
});

test("fingerprint: create-time config only — the image id moves it, a per-exec change does not", () => {
  const a = target("fp-chan");
  a.container.imageId = "sha256:one";
  const first = containerFingerprint(a);
  assert.match(first, /^c1-[0-9a-f]{32}$/);
  assert.equal(containerFingerprint(a), first);

  const b = target("fp-chan");
  b.container.imageId = "sha256:two";
  assert.notEqual(containerFingerprint(b), first, "a new image id must retire the container");

  const c = target("fp-chan");
  c.container.imageId = "sha256:one";
  c.meta = { ...c.meta, someRuntimeThing: "changed" };
  assert.equal(containerFingerprint(c), first, "per-exec inputs are not part of the fingerprint");

  const off = target("fp-chan", { networkMode: "off" });
  off.container.imageId = "sha256:one";
  assert.notEqual(containerFingerprint(off), first, "network posture is create-time-immutable");
});

test("state machine: missing → create+start, and the artifact dir is prepared 0700 first", async () => {
  const h = harness();
  const t = target("sm-missing");
  const result = await h.lifecycle.ensureUp(t, {});
  assert.deepEqual({ created: result.created, started: result.started }, { created: true, started: true });
  const run = h.fake.last("run");
  assert.ok(run, "a missing container must be created");
  assert.equal(run[2], "-d");
  assert.ok(run.includes(t.container.name));
  assert.ok(run.includes(`cg.fingerprint=${t.container.fingerprint}`));
  assert.ok(existsSync(t.artifactDir), "the artifact dir is created before the mount");
  assert.equal(h.reaper.snapshot()[0].running, true);
});

test("state machine: exited → start (no recreate), and a lost lease is announced", async () => {
  const h = harness({ state: { exists: true, status: "exited", name: "x" } });
  const t = target("sm-exited");
  // Fingerprint has to match or the exited container would be recreated instead of started.
  h.state.fingerprint = "";
  await h.lifecycle.ensureUp(t, {});
  h.state.fingerprint = t.container.fingerprint;
  h.fake.reset();

  const announced = [];
  const lease = h.reaper.acquireLease(t, { kind: "job", id: "j1" });
  const result = await h.lifecycle.ensureUp(t, { announce: (m) => announced.push(m) });
  lease.release();
  assert.deepEqual({ created: result.created, started: result.started }, { created: false, started: true });
  assert.deepEqual(h.fake.last("start"), ["podman", "start", t.container.name]);
  assert.equal(h.fake.last("run"), null, "an exited container is started, never recreated");
  assert.ok(announced.some((m) => /background processes from the previous session were lost/i.test(m)));
});

test("state machine: running with a matching fingerprint is reused as-is", async () => {
  const h = harness({ state: { exists: true, status: "running" } });
  const t = target("sm-running");
  h.state.fingerprint = "";
  await h.lifecycle.ensureUp(t, {});
  h.state.fingerprint = t.container.fingerprint;
  h.fake.reset();
  const result = await h.lifecycle.ensureUp(t, {});
  assert.deepEqual({ created: result.created, started: result.started }, { created: false, started: false });
  assert.equal(h.fake.last("run"), null);
  assert.equal(h.fake.last("start"), null);
  assert.equal(h.fake.last("rm"), null);
});

test("state machine: running with a stale fingerprint recreates when unleased, defers while leased", async () => {
  const h = harness({ state: { exists: true, status: "running", fingerprint: "c1-stale" } });
  const t = target("sm-stale");
  await h.lifecycle.ensureUp(t, {});
  assert.deepEqual(h.fake.last("rm"), ["podman", "rm", "-f", t.container.name]);
  assert.ok(h.fake.last("run"), "an unleased stale container is replaced");

  const leased = harness({ state: { exists: true, status: "running", fingerprint: "c1-stale" } });
  const t2 = target("sm-stale-leased");
  const lease = leased.reaper.acquireLease(t2, { kind: "job", id: "j" });
  await leased.lifecycle.ensureUp(t2, {});
  lease.release();
  assert.equal(leased.fake.last("rm"), null, "a leased container is never torn down mid-job");
  assert.equal(t2.container.recreatePending, true);
  assert.ok(leased.logs.some((m) => /recreating when it next goes idle/.test(m)));
});

test("state machine: a foreign container with our name is never touched, and a paused one fails closed", async () => {
  const foreign = harness({ state: { exists: true, status: "running", install: "beefcafe" } });
  await assert.rejects(foreign.lifecycle.ensureUp(target("sm-foreign"), {}), /does not belong to this ChannelGate install/);
  assert.equal(foreign.fake.last("rm"), null);

  const paused = harness({ state: { exists: true, status: "paused" } });
  await assert.rejects(paused.lifecycle.ensureUp(target("sm-paused"), {}), /is paused — the gateway will not use it/);
});

test("state machine: no CLI and no image both fail closed with the remedy", async () => {
  const noCli = harness({ extraRoutes: [{ match: (a) => a[1] === "info", result: { code: 127, stderr: "not found" } }] });
  await assert.rejects(noCli.lifecycle.ensureUp(target("sm-nocli"), {}), /no usable container CLI/);

  const noImage = harness({ extraRoutes: [{ match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 125, stderr: "image not known" } }] });
  await assert.rejects(noImage.lifecycle.ensureUp(target("sm-noimage"), {}), /is not built — run `npm run build:image`/);
});

test("out-of-band removal: an exec that finds no container re-runs ensureUp once and retries once", async () => {
  const state = { exists: true, status: "running" };
  const h = harness({ state });
  const t = target("oob-chan");
  state.fingerprint = "";
  await h.lifecycle.ensureUp(t, {});
  state.fingerprint = t.container.fingerprint;

  const { createContainerExec } = await import("../src/runtimes/container/exec.js");
  let attempt = 0;
  h.fake.addRoute({
    match: (a) => a[1] === "exec" && a.includes("cg-probe"),
    result: () => {
      attempt += 1;
      return attempt === 1
        ? { code: 125, stderr: 'Error: no container with name or ID "x" found: no such container' }
        : { code: 0, stdout: "" };
    },
  });
  const runner = createContainerExec({ cli: h.cli, lifecycle: h.lifecycle, reaper: h.reaper, log: (m) => h.logs.push(m) });
  const result = await runner.runExec(t, [t.container.name, "cg-probe", "run-1"], { timeoutMs: 1_000 });
  assert.equal(attempt, 2, "the exec is retried exactly once");
  assert.equal(result.code, 0);
  assert.ok(h.logs.some((m) => /vanished mid-run — recreating and retrying once/.test(m)));
});

test("boot reconcile: running containers of THIS install are swept for run/warm groups and registered idle", async () => {
  const ids = ["aaa", "bbb", "ccc"];
  const byId = {
    aaa: inspectLine({ name: "cg-a", status: "running", install: currentInstallId(), channel: "a" }),
    bbb: inspectLine({ name: "cg-b", status: "exited", install: currentInstallId(), channel: "b" }),
    ccc: inspectLine({ name: "cg-foreign", status: "running", install: "otherinst", channel: "c" }),
  };
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: `${ids.join("\n")}\n` } },
      { match: (a) => a[1] === "inspect" && a.length > 5, result: (a) => ({ code: 0, stdout: a.slice(5).map((id) => byId[id]).filter(Boolean).join("\n") }) },
      { match: (a) => a[1] === "exec" && a.includes("cg-sweep"), result: { code: 0, stdout: "run-1\nwarm-2\n" } },
    ],
  });
  const logs = [];
  const cli = createContainerCli({ exec: fake.exec });
  const reaper = createContainerReaper({ log: (m) => logs.push(m) });
  const lifecycle = createContainerLifecycle({ cli, image: createContainerImage({ cli }), reaper, log: (m) => logs.push(m) });
  const result = await lifecycle.bootReconcile(SETTINGS);
  assert.deepEqual(result.running, ["cg-a"], "a foreign install's container is never touched");
  const ps = fake.last("ps");
  assert.ok(ps.includes(`label=cg.install=${currentInstallId()}`));
  const sweep = fake.last("exec");
  assert.deepEqual(sweep.slice(2), ["cg-a", "cg-sweep", "run", "warm"]);
  assert.deepEqual(result.swept, [{ name: "cg-a", ids: ["run-1", "warm-2"] }]);
  assert.equal(reaper.snapshot().find((e) => e.name === "cg-a").running, true);
});

test("parsers: podman and docker inspect shapes, and the gone-error matcher", () => {
  assert.equal(parseStartedAt("2026-09-02 01:51:32.1391321 +0300 EEST").slice(0, 4), "2026");
  assert.equal(parseStartedAt("2026-09-02T01:51:32.139Z"), "2026-09-02T01:51:32.139Z");
  assert.equal(parseStartedAt("0001-01-01T00:00:00Z"), "");
  const docker = parseInspectLine(["/cg-x", "running", "2026-09-02T01:51:32.139Z", "sha256:i", "c1-f", "inst", "ref", "chan", "slack"].join("|"));
  assert.equal(docker.name, "cg-x", "docker's leading slash is stripped");
  const podman = parseInspectLine(["cg-y", "configured", "0001-01-01T00:00:00Z", "sha256:i", "<no value>", "inst", "ref", "chan", "slack"].join("|"));
  assert.equal(podman.status, "created", "podman's `configured` is docker's `created`");
  assert.equal(podman.fingerprint, "", "<no value> is an empty label, not a literal");
  for (const text of [
    'Error: no container with name or ID "x" found: no such container',
    "Error: can only create exec sessions on running containers: container state improper",
    "Error response from daemon: Container abc is not running",
    "Error: No such container: abc",
  ]) assert.equal(isContainerGoneError(text), true, text);
  assert.equal(isContainerGoneError("Error: permission denied"), false);
});

test("destroy: rm always, the HOME volume only when explicitly asked", async () => {
  const h = harness({ state: { exists: true, status: "running" } });
  const t = target("destroy-chan");
  await h.lifecycle.destroy(t, { reason: "rollback" });
  assert.deepEqual(h.fake.last("rm"), ["podman", "rm", "-f", t.container.name]);
  assert.equal(h.fake.last("volume"), null, "a rollback must never delete the channel's HOME volume");
  await h.lifecycle.destroy(t, { volumes: true, reason: "channel deleted" });
  assert.deepEqual(h.fake.last("volume"), ["podman", "volume", "rm", t.container.homeVolume]);
});

test("names: install-scoped, clamped, and a foreign install label is not ours", async () => {
  const { containerName, homeVolumeName, isOurContainer, LABEL_INSTALL } = await import("../src/runtimes/container/names.js");
  const t = target("names-chan");
  assert.equal(t.container.name, `cg-${currentInstallId()}-slack-names-chan`);
  assert.equal(t.container.homeVolume, `${t.container.name}-home`);
  const long = containerName({ slug: "x".repeat(120), platform: "slack" });
  assert.ok(long.length <= 58, `clamped name too long: ${long.length}`);
  assert.ok(homeVolumeName({ slug: "x".repeat(120), platform: "slack" }).length <= 63);
  assert.notEqual(containerName({ slug: `${"x".repeat(120)}a`, platform: "slack" }), long, "clamping must stay collision-proof");
  assert.equal(isOurContainer({ [LABEL_INSTALL]: currentInstallId() }), true);
  assert.equal(isOurContainer({ [LABEL_INSTALL]: "deadbeef" }), false);
  assert.equal(isOurContainer({}), false);
});

test("stale env files are swept when a new one is written", async () => {
  const { createContainerExec, envFileDir } = await import("../src/runtimes/container/exec.js");
  const h = harness();
  const t = target("stale-env");
  await h.cli.probe(SETTINGS, { image: SETTINGS.image });
  const dir = envFileDir(t);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stale = path.join(dir, "run-old.env");
  writeFileSync(stale, "OLD=1\n", { mode: 0o600 });
  const old = Date.now() - 7 * 60 * 60 * 1000;
  const { utimesSync } = await import("node:fs");
  utimesSync(stale, old / 1000, old / 1000);
  const runner = createContainerExec({ cli: h.cli, lifecycle: h.lifecycle, reaper: h.reaper });
  const fresh = runner.writeEnvFile(t, "run-new", { A: "1" });
  assert.equal(existsSync(stale), false, "an env file left by a crashed daemon must not linger with its secrets");
  assert.equal(existsSync(fresh), true);
  runner.discardEnvFile(fresh);
});
