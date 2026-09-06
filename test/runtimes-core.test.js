// The runtime layer's core facts (src/runtimes/): the fail-closed backend contract, the registry
// that holds exactly one channel runtime — the container — and the resolver that hands every
// channel turn to it. The daemon's OWN process spawner (src/runtimes/local.js) is covered here too,
// precisely because it is NOT a channel runtime: it exists for the update smoke probe and the
// direct-runner tests, and nothing a channel does can resolve to it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { validateRuntimeBackend, runtimeSupports, runtimeCanCarry, newRunId, runIdKind, isRuntimeChild, RUNTIME_BACKEND_IDS, DEFAULT_RUNTIME_BACKEND } = await import("../src/runtimes/contract.js");
const { localRuntime } = await import("../src/runtimes/local.js");
const { runtimeBackend, runtimeBackendOr, runtimeBackendIds, isRuntimeBackendId } = await import("../src/runtimes/registry.js");
const { decideRuntimeBackend, resolveRuntime } = await import("../src/runtimes/resolve.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { credentialError: containerCredentialError } = await import("../src/runtimes/container/credentials.js");
const { installId, channelArtifactDir, runtimeSocketFile } = await import("../src/config/paths.js");
const { getContainerRuntime } = await import("../src/config/settings.js");

const container = runtimeBackend("container");

test("contract: a backend missing a method or capability fails closed", () => {
  assert.doesNotThrow(() => validateRuntimeBackend(container));
  const partial = { ...container, capabilities: { isolated: true } };
  assert.throws(() => validateRuntimeBackend(partial), /must declare capability/);
  const noSpawn = { ...container, spawn: undefined };
  assert.throws(() => validateRuntimeBackend(noSpawn), /missing spawn/);
  const extraCap = { ...container, capabilities: { ...container.capabilities, superpowers: true } };
  assert.throws(() => validateRuntimeBackend(extraCap), /unknown capability/);
  assert.throws(() => validateRuntimeBackend({ ...container, id: "vm" }), /unknown id/);
  // The host OS-sandbox backend is gone: a module that still calls itself "host" cannot load.
  assert.throws(() => validateRuntimeBackend({ ...container, id: "host" }), /unknown id/);
});

test("contract: an OPTIONAL method may be absent but may never be the wrong thing", () => {
  // Absent is fine — a backend may declare no credential gate at all.
  assert.doesNotThrow(() => validateRuntimeBackend({ ...container, credentialError: undefined }));
  // Present but not callable is exactly the silent no-op these are declared to prevent.
  assert.throws(() => validateRuntimeBackend({ ...container, copyIn: true }), /declares copyIn but it is not a function/);
  assert.throws(() => validateRuntimeBackend({ ...container, credentialError: "nope" }), /declares credentialError but it is not a function/);
});

test("contract: the container backend and the local spawner can both carry engine state, both halves or neither", () => {
  assert.equal(runtimeCanCarry(container), true);
  // The daemon's own spawner carries too: a thread whose history is still on the daemon's
  // filesystem (a host-era session row) is copied INTO its channel container from here.
  assert.equal(runtimeCanCarry(localRuntime), true);
  assert.equal(runtimeCanCarry({ runtime: container }), true, "a target answers like its backend");
  // A backend that could only be written to would strand every session it ever received.
  assert.equal(runtimeCanCarry({ ...container, copyOut: undefined }), false);
  assert.equal(runtimeCanCarry({}), false);
});

test("contract: runtimeSupports reads declared capabilities and throws on unknown keys", () => {
  assert.equal(runtimeSupports(container, "isolated"), true);
  assert.equal(runtimeSupports(localRuntime, "isolated"), false, "a local child has no container boundary around it");
  assert.equal(runtimeSupports({ runtime: localRuntime }, "processGroups"), true);
  assert.equal(runtimeSupports({ runtime: container }, "persistentHome"), true);
  assert.throws(() => runtimeSupports(container, "teleport"), /unknown runtime capability/);
});

test("registry: the container backend is the only channel runtime, and every stored id resolves to it", () => {
  assert.deepEqual([...RUNTIME_BACKEND_IDS], ["container"]);
  assert.equal(DEFAULT_RUNTIME_BACKEND, "container");
  assert.deepEqual(runtimeBackendIds(), ["container"]);
  assert.equal(runtimeBackend("container").id, "container");
  assert.throws(() => runtimeBackend("host"), /unknown runtime backend/);
  assert.throws(() => runtimeBackend("docker"), /unknown runtime backend/);
  // Rows written before v0.8 name no backend; rows written while the host backend existed name
  // "host". Both resolve to the one backend there is.
  assert.equal(runtimeBackendOr("").id, "container");
  assert.equal(runtimeBackendOr("host").id, "container");
  assert.equal(runtimeBackendOr("bogus").id, "container");
  assert.equal(isRuntimeBackendId("container"), true);
  assert.equal(isRuntimeBackendId("host"), false);
  assert.equal(isRuntimeBackendId("local"), false, "the daemon's own spawner is deliberately not registered");
});

test("resolve: every channel runs in the container — no kill switch, no pin, no admin-mode exception", () => {
  for (const meta of [{}, { runtime: "host" }, { runtime: "container" }, { adminMode: true }, { cleanMode: true }, { runtime: "vm" }]) {
    assert.deepEqual(decideRuntimeBackend(meta), { backend: "container", reason: "only-runtime" }, JSON.stringify(meta));
  }
  // The pre-2026-09 signature (meta, settings) is tolerated and ignored: the answer never changes.
  assert.deepEqual(decideRuntimeBackend({ runtime: "host" }, { enabled: false, defaultBackend: "host" }), { backend: "container", reason: "only-runtime" });
  assert.deepEqual(decideRuntimeBackend(), { backend: "container", reason: "only-runtime" });
});

test("resolve: the target carries cwd, durable workDir, clean workspace, the artifact dir and the backend object", () => {
  const meta = { platform: "slack", channelId: "C1", name: "#rt" };
  const target = resolveRuntime("rt-core", meta);
  assert.equal(target.backend, "container");
  assert.equal(target.reason, "only-runtime");
  assert.equal(target.runtime, container);
  assert.equal(target.cwd, target.workDir);
  assert.match(target.cleanWorkDir, /clean-workspaces[\\/]slack[\\/]rt-core$/);
  // Every target has a mounted artifact dir now: there is no "today's host locations" fallback.
  assert.equal(target.artifactDir, channelArtifactDir("rt-core", "slack"));
  assert.match(target.artifactDir, /[\\/]\.runtime[\\/]slack[\\/]rt-core$/);
  assert.ok(target.container?.name, "the backend's prepareTarget filled in the container facts");
  assert.equal(target.fingerprint, undefined, "the fingerprint is asked of the backend, never stored on the target");

  const clean = resolveRuntime("rt-core", { ...meta, cleanMode: true });
  assert.equal(clean.backend, "container", "clean mode keeps the same backend");
  assert.equal(clean.cwd, clean.cleanWorkDir);
  assert.notEqual(clean.workDir, clean.cwd);
  assert.equal(clean.artifactDir, target.artifactDir);

  const admin = resolveRuntime("rt-core", { ...meta, adminMode: true });
  assert.equal(admin.backend, "container", "admin mode runs in a container like every other channel");
  assert.equal(admin.cwd, target.cwd, "the same channel, the same working directory");
});

test("local spawner: spawn tags the child, probe follows the pid, signal takes the group — and it is no channel runtime", async () => {
  const cwd = tempDir("cg-local-spawner-");
  mkdirSync(cwd, { recursive: true });
  const target = localRuntimeTarget(cwd);
  assert.equal(target.backend, "local");
  assert.equal(target.runtime, localRuntime);
  assert.equal(target.artifactDir, null, "nothing is mounted: a local child sees the daemon's filesystem as it is");
  const child = localRuntime.spawn(target, {
    cmd: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: { PATH: process.env.PATH },
    runId: newRunId("run"),
    kind: "turn",
  });
  assert.equal(isRuntimeChild(child), true);
  assert.equal(child.runtime.backend, "local");
  assert.equal(runIdKind(child.runtime.runId), "run");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await localRuntime.probe(child), true);
  const exited = new Promise((r) => child.once("exit", r));
  assert.equal(await localRuntime.signal(child, "SIGTERM"), true);
  await exited;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await localRuntime.probe(child), false);
  assert.equal(localRuntime.fingerprint(target), "local");
  assert.equal(localRuntime.resumeCommand(target, { baseCommand: "claude --resume abc" }), "claude --resume abc");
  assert.deepEqual(await localRuntime.describe(target), { backend: "local", state: "local" });
  assert.deepEqual(await localRuntime.ensureUp(target), { created: false, started: false, warmupMs: 0 });
  // The engine-side helpers (the gateway MCP bridge, the secret bridges, the Stop hook) are the
  // image's baked bundle: a local child has none, and asking is a programming error, not a fallback.
  assert.throws(() => localRuntime.helperCommand(target, "gateway-mcp"), /only available inside a channel container/);
  assert.throws(() => localRuntime.helperCommand(target, "warp-drive"), /only available inside a channel container/);
  // It can never be registered as a channel runtime: the contract does not know its id.
  assert.throws(() => validateRuntimeBackend(localRuntime), /unknown id "local"/);
});

test("paths + settings: install id is stable, socket file sits under the runtime root, defaults are sane", () => {
  assert.match(installId(), /^[0-9a-f]{8}$/);
  assert.equal(installId(), installId());
  assert.match(runtimeSocketFile(), /[\\/]run[\\/]mcp\.sock$/);
  const s = getContainerRuntime();
  assert.equal(s.cli, "auto");
  assert.equal(s.idleMinutes, 10);
  assert.equal(s.maxRunning, 8);
  assert.equal(s.pidsLimit, 1024);
  assert.equal(s.hasClaudeOauthToken, false);
  // No kill switch and no default-backend pick: the container is the only runtime there is.
  assert.equal("enabled" in s, false);
  assert.equal("defaultBackend" in s, false);
});

test("container backend exposes the pre-spawn credential gate on the backend object, per engine", () => {
  assert.equal(typeof container.credentialError, "function", "credentialError must be callable through target.runtime");
  const target = resolveRuntime("rt-cred", { platform: "slack", channelId: "C3" });
  // ensureTestEnv() seeds a stub OPERATOR login (the relay source) and a stub Codex auth.json
  // under CODEX_HOME (the shared-file mount), so both gates are open — the point is that the
  // gate is CALLABLE and answers, per engine.
  assert.equal(container.credentialError(target, "claude"), null);
  assert.equal(container.credentialError(target, "codex"), null);

  // Codex, signed out: no auth.json in the engine home or in the host's CODEX_HOME.
  const codex = containerCredentialError(target, "codex", { CODEX_HOME: tempDir("cg-no-codex-home-") });
  assert.equal(codex, null, "Codex checks its independent container-owned login");

  // Claude, with nothing to relay: the seeded operator login is moved away for the duration, and
  // the empty env carries no API key either. Fail closed, with the remedy in the sentence.
  const seeded = path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  renameSync(seeded, `${seeded}.away`);
  try {
    const claude = containerCredentialError(target, "claude", {});
    assert.match(String(claude?.message || ""), /ANTHROPIC_API_KEY/i);
    assert.match(String(claude?.message || ""), /setup-token/);
  } finally {
    renameSync(`${seeded}.away`, seeded);
  }
});

test("run ids: kinds are closed and parseable", () => {
  assert.throws(() => newRunId("turn"), /unknown run id kind/);
  assert.equal(runIdKind(newRunId("job")), "job");
  assert.equal(runIdKind("nope"), "");
});
