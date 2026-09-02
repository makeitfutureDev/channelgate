// The provisioning half of the container runtime (v0.8 P1): what a channel folder and a run's
// engine-facing artifacts look like once the turn runs behind an OS boundary the daemon owns.
//
// Two rules are under test, and both cut both ways:
//   1. an ISOLATED target gets no sandbox block, no host-path carve-outs and no host plumbing —
//      the boundary is the confinement, and every path in that block names a host that does not
//      exist on the other side of it;
//   2. a HOST target is byte-identical to what it was before any of this existed. Everything here
//      is opt-in through a target; passing none must change nothing.
import path from "node:path";
import { stat } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR ||= path.join(scratch, "workspace");

const { buildSettings, ensureChannelFolder, subagentStopHooks, STOP_SUBAGENTS_HOOK } = await import("../src/gateway/folders.js");
const { createRunGrantArtifacts, engineHomesFor, CONTAINER_AGENT_HOME } = await import("../src/gateway/run-grant-artifacts.js");
const { channelFolder, runTmpDir } = await import("../src/config/paths.js");
const { createFakeRuntimeBackend, fakeTarget, hostTarget } = await import("./runtime-fake.js");

const backend = createFakeRuntimeBackend();

test("an isolated target's settings carry policy but no sandbox, and the host's are unchanged", async () => {
  const meta = { _slug: "rt-folders", allowedMcps: [], allowBash: true, allowNetwork: true, platform: "slack" };
  const host = await buildSettings(meta);
  const isolated = await buildSettings(meta, { target: fakeTarget(backend, "rt-folders", meta) });

  // The whole block is gone — not disabled, not emptied. An `enabled:false` sandbox would still
  // ship a filesystem section full of host paths for the CLI to interpret.
  assert.ok(host.sandbox, "a host run still gets the OS sandbox");
  assert.equal("sandbox" in isolated, false, "an isolated run gets no sandbox block at all");

  // Policy is not confinement: everything that decides what the model may DO is identical.
  assert.deepEqual(isolated.permissions.allow, host.permissions.allow);
  assert.equal(isolated.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(isolated.autoMemoryEnabled, false);
  assert.equal(isolated.autoDreamEnabled, false);
  assert.deepEqual(isolated.allowedMcpServers, host.allowedMcpServers);
});

test("the Stop hook comes from the backend for an isolated target and stays verbatim on the host", async () => {
  const meta = { _slug: "rt-hook", allowedMcps: [], platform: "slack" };
  const host = await buildSettings(meta);
  const isolated = await buildSettings(meta, { target: fakeTarget(backend, "rt-hook", meta) });

  // Host: the exact string it has always written. The settings digest (and every warm-process
  // fingerprint derived from it) must not move because containers exist.
  assert.equal(host.hooks.Stop[0].hooks[0].command, `node "${STOP_SUBAGENTS_HOOK}"`);
  assert.deepEqual(subagentStopHooks(), host.hooks);

  // Isolated: the script lives in the image, at a path only the backend knows.
  assert.equal(isolated.hooks.Stop[0].hooks[0].command, "/opt/channelgate/bin/cg-stop-subagents");
  assert.doesNotMatch(isolated.hooks.Stop[0].hooks[0].command, /stop-subagents\.mjs/);
});

test("ensureChannelFolder creates the two directories the backend has to bind-mount", async () => {
  const meta = { platform: "slack", allowedMcps: [], name: "rt-mounts" };
  const target = fakeTarget(backend, "rt-mounts", meta);
  await ensureChannelFolder("rt-mounts", meta, { target });

  for (const dir of [target.artifactDir, target.cleanWorkDir]) {
    const info = await stat(dir);
    assert.ok(info.isDirectory(), `${dir} exists as a directory`);
    // A bind mount whose source is missing is either an error or a root-owned directory the
    // container daemon conjures; either way the run loses the files it was supposed to read.
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700);
  }
});

test("an isolated run's engine-facing artifacts all live under the mounted artifact dir", async () => {
  const meta = { platform: "slack", allowedMcps: [], allowBash: true };
  const target = fakeTarget(backend, "rt-artifacts", meta);
  await ensureChannelFolder("rt-artifacts", meta, { target });

  const artifacts = await createRunGrantArtifacts({ slug: "rt-artifacts", meta, needsClaudeSettings: true, target });
  try {
    // Nothing under the gateway root may ever be handed to a containerized engine: that tree is
    // never mounted, so a path into it is a file the engine cannot open.
    assert.ok(artifacts.settingsFile.startsWith(`${target.artifactDir}${path.sep}`), artifacts.settingsFile);
    assert.doesNotMatch(artifacts.settingsFile, new RegExp(channelFolder("rt-artifacts", "slack").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const dir of artifacts.claudePluginDirs) assert.ok(dir.startsWith(`${target.artifactDir}${path.sep}`), dir);

    // The engine homes are the IMAGE's, not the daemon's: mounting the daemon's synthetic Claude
    // home would expose every transcript on the box (its projects/sessions are symlinks into the
    // operator's own ~/.claude).
    assert.equal(artifacts.claudeHome, CONTAINER_AGENT_HOME);
    assert.equal(artifacts.claudeConfigDir, `${CONTAINER_AGENT_HOME}/.claude`);
    assert.equal(artifacts.codexHome, `${CONTAINER_AGENT_HOME}/.codex`);
    assert.equal(artifacts.codexUserHome, CONTAINER_AGENT_HOME);

    // Host-only plumbing is not merely unused, it is not built: launcher dirs shim the host's own
    // toolchain, and credential symlinks point at the operator's home.
    assert.equal(artifacts.toolchainBinDir, "");
    assert.equal(artifacts.codexToolchainBinDir, "");
    assert.deepEqual(artifacts.codexCredentialPaths, []);
    assert.equal(artifacts.codexSkillSupportDir, "");
  } finally {
    await artifacts.cleanup();
  }
});

test("a host run's artifacts stay exactly where they always were", async () => {
  const meta = { platform: "slack", allowedMcps: [] };
  await ensureChannelFolder("rt-host-artifacts", meta);
  const artifacts = await createRunGrantArtifacts({ slug: "rt-host-artifacts", meta, needsClaudeSettings: true, target: hostTarget("rt-host-artifacts", meta) });
  try {
    const runtimeRoot = path.join(channelFolder("rt-host-artifacts", "slack"), "runtime");
    assert.ok(artifacts.settingsFile.startsWith(`${runtimeRoot}${path.sep}claude-settings${path.sep}`), artifacts.settingsFile);
    assert.equal(artifacts.artifactRoot, runTmpDir());
    assert.notEqual(artifacts.claudeHome, CONTAINER_AGENT_HOME);
    assert.ok(artifacts.codexUserHome.startsWith(runTmpDir()), artifacts.codexUserHome);
    assert.ok(artifacts.codexSkillSupportDir.endsWith(path.join(".agents", "skills")), artifacts.codexSkillSupportDir);
  } finally {
    await artifacts.cleanup();
  }
});

test("engineHomesFor answers only for an isolated target, and prefers what the backend declares", () => {
  assert.equal(engineHomesFor(null), null);
  assert.equal(engineHomesFor(hostTarget("rt-homes", {})), null);

  const target = fakeTarget(backend, "rt-homes", { platform: "slack" });
  assert.deepEqual(engineHomesFor(target), {
    claudeHome: "/home/agent",
    claudeConfigDir: "/home/agent/.claude",
    claudeStateDir: "",
    codexUserHome: "/home/agent",
    codexHome: "/home/agent/.codex",
    // Read from the HOST side (usage accounting), so it is empty until the backend can name where
    // the channel's home volume lives on this filesystem — never the operator's own ~/.codex.
    codexStateDir: "",
  });
  const withVolume = { ...target, container: { ...target.container, homeVolumeHostPath: "/var/lib/cg/vol" } };
  assert.equal(engineHomesFor(withVolume).codexStateDir, path.join("/var/lib/cg/vol", ".codex"));

  // The image layout is the backend's fact, so a backend that publishes a different HOME wins over
  // the documented default rather than being silently overridden by it. A backend that names the
  // state dirs outright (which the real one does — containerImagePaths()) wins over the derivation.
  const homeOnly = { ...target, container: { ...target.container, home: "/srv/agent", claudeConfigDir: "", codexHome: "" } };
  assert.deepEqual(engineHomesFor(homeOnly).claudeConfigDir, "/srv/agent/.claude");
  assert.deepEqual(engineHomesFor(homeOnly).codexHome, "/srv/agent/.codex");
  const declared = { ...target, container: { ...target.container, home: "/srv/agent", claudeConfigDir: "/opt/state/.claude", codexHome: "/opt/state/.codex" } };
  assert.deepEqual(engineHomesFor(declared).claudeConfigDir, "/opt/state/.claude");
  assert.deepEqual(engineHomesFor(declared).codexHome, "/opt/state/.codex");
});
