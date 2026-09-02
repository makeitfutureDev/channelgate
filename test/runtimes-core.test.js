import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { validateRuntimeBackend, runtimeSupports, runtimeCanCarry, newRunId, runIdKind, isRuntimeChild } = await import("../src/runtimes/contract.js");
const { hostBackend } = await import("../src/runtimes/host.js");
const { runtimeBackend, runtimeBackendOr, isRuntimeBackendId } = await import("../src/runtimes/registry.js");
const { decideRuntimeBackend, resolveRuntime } = await import("../src/runtimes/resolve.js");
const { installId, channelArtifactDir, runtimeSocketFile } = await import("../src/config/paths.js");
const { getContainerRuntime } = await import("../src/config/settings.js");

const ON = { enabled: true, defaultBackend: "host" };
const ON_CONTAINER_DEFAULT = { enabled: true, defaultBackend: "container" };
const OFF = { enabled: false, defaultBackend: "container" };

test("contract: a backend missing a method or capability fails closed", () => {
  assert.doesNotThrow(() => validateRuntimeBackend(hostBackend));
  const partial = { ...hostBackend, capabilities: { isolated: false } };
  assert.throws(() => validateRuntimeBackend(partial), /must declare capability/);
  const noSpawn = { ...hostBackend, spawn: undefined };
  assert.throws(() => validateRuntimeBackend(noSpawn), /missing spawn/);
  const extraCap = { ...hostBackend, capabilities: { ...hostBackend.capabilities, superpowers: true } };
  assert.throws(() => validateRuntimeBackend(extraCap), /unknown capability/);
  assert.throws(() => validateRuntimeBackend({ ...hostBackend, id: "vm" }), /unknown id/);
});

test("contract: an OPTIONAL method may be absent but may never be the wrong thing", () => {
  // Absent is fine — the host backend declares no credential gate at all.
  assert.doesNotThrow(() => validateRuntimeBackend({ ...hostBackend, credentialError: undefined }));
  // Present but not callable is exactly the silent no-op these are declared to prevent.
  assert.throws(() => validateRuntimeBackend({ ...hostBackend, copyIn: true }), /declares copyIn but it is not a function/);
  assert.throws(() => validateRuntimeBackend({ ...hostBackend, credentialError: "nope" }), /declares credentialError but it is not a function/);
});

test("contract: both backends can carry engine state, and both halves or neither", () => {
  assert.equal(runtimeCanCarry(hostBackend), true);
  assert.equal(runtimeCanCarry(runtimeBackend("container")), true);
  assert.equal(runtimeCanCarry({ runtime: hostBackend }), true, "a target answers like its backend");
  // A backend that could only be written to would strand every session it ever received.
  assert.equal(runtimeCanCarry({ ...hostBackend, copyOut: undefined }), false);
  assert.equal(runtimeCanCarry({}), false);
});

test("contract: runtimeSupports reads declared capabilities and throws on unknown keys", () => {
  assert.equal(runtimeSupports(hostBackend, "isolated"), false);
  assert.equal(runtimeSupports(runtimeBackend("container"), "isolated"), true);
  assert.equal(runtimeSupports({ runtime: hostBackend }, "processGroups"), true);
  assert.throws(() => runtimeSupports(hostBackend, "teleport"), /unknown runtime capability/);
});

test("registry: both backends load and unknown ids resolve to host", () => {
  assert.equal(runtimeBackend("host").id, "host");
  assert.equal(runtimeBackend("container").id, "container");
  assert.equal(runtimeBackendOr("").id, "host");
  assert.equal(runtimeBackendOr("bogus").id, "host");
  assert.equal(isRuntimeBackendId("container"), true);
  assert.equal(isRuntimeBackendId("docker"), false);
  assert.throws(() => runtimeBackend("docker"), /unknown runtime backend/);
});

test("resolve: precedence — kill switch, admin mode, channel pin, gateway default", () => {
  assert.deepEqual(decideRuntimeBackend({ runtime: "container" }, OFF), { backend: "host", reason: "disabled" });
  assert.deepEqual(decideRuntimeBackend({ runtime: "container", adminMode: true }, ON), { backend: "host", reason: "admin-mode" });
  assert.deepEqual(decideRuntimeBackend({ runtime: "container" }, ON), { backend: "container", reason: "channel" });
  assert.deepEqual(decideRuntimeBackend({ runtime: "host" }, ON_CONTAINER_DEFAULT), { backend: "host", reason: "channel" });
  assert.deepEqual(decideRuntimeBackend({}, ON_CONTAINER_DEFAULT), { backend: "container", reason: "default" });
  assert.deepEqual(decideRuntimeBackend({}, ON), { backend: "host", reason: "default" });
  assert.deepEqual(decideRuntimeBackend({ runtime: "vm" }, ON_CONTAINER_DEFAULT), { backend: "container", reason: "default" });
});

test("resolve: an explicit backend override addresses a channel's OTHER environment", () => {
  const meta = { platform: "slack", channelId: "C9", name: "#rt-override", adminMode: true };
  // An admin-mode channel pins the host; the carry-over still has to reach the container its
  // history is sitting in, which is what the override — and ONLY the override — is for.
  const pinned = resolveRuntime("rt-override", meta, { settings: ON });
  assert.equal(pinned.backend, "host");
  assert.equal(pinned.reason, "admin-mode");
  const forced = resolveRuntime("rt-override", meta, { settings: ON, backend: "container" });
  assert.equal(forced.backend, "container");
  assert.equal(forced.reason, "override");
  assert.equal(forced.cwd, pinned.cwd, "the same channel, the same working directory");
  assert.ok(forced.container?.name);
  // An unknown id is not an override — the channel's own precedence stands.
  assert.equal(resolveRuntime("rt-override", meta, { settings: ON, backend: "vm" }).backend, "host");
  assert.equal(resolveRuntime("rt-override", meta, { settings: ON, backend: "" }).reason, "admin-mode");
});

test("resolve: the target carries cwd, durable workDir, clean workspace and the backend object", () => {
  const meta = { platform: "slack", channelId: "C1", name: "#rt" };
  const host = resolveRuntime("rt-core", meta, { settings: ON });
  assert.equal(host.backend, "host");
  assert.equal(host.runtime, hostBackend);
  assert.equal(host.artifactDir, null);
  assert.equal(host.container, null);
  assert.equal(host.cwd, host.workDir);
  assert.match(host.cleanWorkDir, /clean-workspaces[\\/]slack[\\/]rt-core$/);
  assert.equal(host.fingerprint, undefined);
  assert.equal(host.runtime.fingerprint(host), "host");

  const clean = resolveRuntime("rt-core", { ...meta, cleanMode: true }, { settings: ON });
  assert.equal(clean.cwd, clean.cleanWorkDir);
  assert.notEqual(clean.workDir, clean.cwd);

  const ctr = resolveRuntime("rt-core", { ...meta, runtime: "container" }, { settings: ON });
  assert.equal(ctr.backend, "container");
  assert.equal(ctr.artifactDir, channelArtifactDir("rt-core", "slack"));
  assert.match(ctr.artifactDir, /[\\/]\.runtime[\\/]slack[\\/]rt-core$/);
  assert.ok(ctr.container);
});

test("host backend: spawn tags the child, probe follows the pid, signal takes the group", async () => {
  const target = resolveRuntime("rt-host", { platform: "slack", channelId: "C2" }, { settings: ON });
  mkdirSync(target.cwd, { recursive: true });
  const child = hostBackend.spawn(target, {
    cmd: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: { PATH: process.env.PATH },
    runId: newRunId("run"),
    kind: "turn",
  });
  assert.equal(isRuntimeChild(child), true);
  assert.equal(child.runtime.backend, "host");
  assert.equal(runIdKind(child.runtime.runId), "run");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await hostBackend.probe(child), true);
  const exited = new Promise((r) => child.once("exit", r));
  assert.equal(await hostBackend.signal(child, "SIGTERM"), true);
  await exited;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await hostBackend.probe(child), false);
  assert.equal(hostBackend.resumeCommand(target, { baseCommand: "claude --resume abc" }), "claude --resume abc");
  assert.deepEqual(await hostBackend.describe(target), { backend: "host", state: "host" });
  const helper = hostBackend.helperCommand(target, "gateway-mcp");
  assert.equal(helper.command, process.execPath);
  assert.match(helper.args[0], /src[\/]mcp[\/]gateway-server\.js$/);
  assert.throws(() => hostBackend.helperCommand(target, "warp-drive"), /unknown runtime helper/);
});

test("paths + settings: install id is stable, socket file sits under the runtime root, defaults are sane", () => {
  assert.match(installId(), /^[0-9a-f]{8}$/);
  assert.equal(installId(), installId());
  assert.match(runtimeSocketFile(), /[\\/]run[\\/]mcp\.sock$/);
  const s = getContainerRuntime();
  assert.equal(s.enabled, false);
  assert.equal(s.defaultBackend, "host");
  assert.equal(s.cli, "auto");
  assert.equal(s.idleMinutes, 10);
  assert.equal(s.maxRunning, 8);
  assert.equal(s.pidsLimit, 1024);
  assert.equal(s.hasClaudeOauthToken, false);
});

test("container backend exposes the pre-spawn credential gate on the backend object", () => {
  const container = runtimeBackend("container");
  assert.equal(typeof container.credentialError, "function", "credentialError must be callable through target.runtime");
  // No target settled yet and no daemon credentials in the scratch root → both engines fail closed
  // with a remedy, never null.
  const target = resolveRuntime("rt-cred", { platform: "slack", channelId: "C3", runtime: "container" }, { settings: ON });
  const claude = container.credentialError(target, "claude");
  const codex = container.credentialError(target, "codex");
  assert.match(String(claude?.message || claude || ""), /setup-token|Claude/i);
  // ensureTestEnv() seeds a stub Codex auth.json under CODEX_HOME, so the shared-file mode resolves
  // and the gate stays open — the point is that the gate is CALLABLE and answers, per engine.
  assert.equal(codex, null);
});

test("run ids: kinds are closed and parseable", () => {
  assert.throws(() => newRunId("turn"), /unknown run id kind/);
  assert.equal(runIdKind(newRunId("job")), "job");
  assert.equal(runIdKind("nope"), "");
});
