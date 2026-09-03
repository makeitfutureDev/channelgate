// The provisioning half of the container runtime: what a channel folder and a run's engine-facing
// artifacts look like now that every turn runs behind an OS boundary the daemon owns.
//
// Two rules are under test, and both cut both ways:
//   1. the settings file carries POLICY only — no sandbox block, no host-path carve-outs and no host
//      plumbing — because the boundary is the confinement, and every path a sandbox block would
//      name is on a host that does not exist on the other side of it;
//   2. everything the engine has to open lives under the channel's artifact dir, which the backend
//      bind-mounts at the identical absolute path. A caller that cannot name one is refused rather
//      than served files from a tree the container never sees.
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR ||= path.join(scratch, "workspace");

const { buildSettings, ensureChannelFolder, subagentStopHooks, STOP_SUBAGENTS_HOOK } = await import("../src/gateway/folders.js");
const { createRunGrantArtifacts, engineHomesFor, CONTAINER_AGENT_HOME } = await import("../src/gateway/run-grant-artifacts.js");
const { channelFolder, gatewayRoot } = await import("../src/config/paths.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { IMAGE_HELPERS } = await import("../src/runtimes/container/image-paths.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

const backend = createFakeRuntimeBackend();

test("a channel's settings carry policy but no sandbox — the container is the confinement", async () => {
  const meta = { _slug: "rt-folders", allowedMcps: [], allowBash: true, allowNetwork: true, platform: "slack" };
  const settings = await buildSettings(meta);
  const target = fakeTarget(backend, "rt-folders", meta);

  // The whole block is absent — not disabled, not emptied. An `enabled:false` sandbox would still
  // ship a filesystem section full of host paths for the CLI to interpret.
  assert.equal("sandbox" in settings, false, "no sandbox block at all");

  // Policy is what decides what the model may DO, and all of it is here.
  assert.ok(settings.permissions.allow.includes("Bash"), "Allow Bash unlocks the shell tool");
  assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.autoDreamEnabled, false);
  assert.ok(Array.isArray(settings.allowedMcpServers));

  // Nothing in the file names the daemon's filesystem: not the mounted work dir, not the gateway
  // root, not the operator's home. A path into any of them is a file the engine cannot open.
  const rendered = JSON.stringify(settings);
  for (const host of [target.cwd, target.artifactDir, gatewayRoot(), os.homedir()]) {
    assert.equal(rendered.includes(host), false, `settings name a host path: ${host}`);
  }
});

test("the Stop hook names the copy baked into the image, never this checkout's script", async () => {
  const meta = { _slug: "rt-hook", allowedMcps: [], platform: "slack" };
  const settings = await buildSettings(meta);

  // The hook runs inside the container, so the command is the image's fixed location
  // (src/runtimes/container/image-paths.js) — the one string every settings digest (and every warm
  // fingerprint derived from it) is built on.
  const { command, args } = IMAGE_HELPERS["stop-subagents-hook"];
  assert.equal(settings.hooks.Stop[0].hooks[0].command, [command, ...args].join(" "));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /^node \/opt\/channelgate\//);
  assert.deepEqual(subagentStopHooks(), settings.hooks);
  // The checkout copy is the SOURCE of that script, not something a run ever invokes.
  assert.equal(settings.hooks.Stop[0].hooks[0].command.includes(STOP_SUBAGENTS_HOOK), false);
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

test("a run's engine-facing artifacts all live under the mounted artifact dir", async () => {
  const meta = { platform: "slack", allowedMcps: [], allowBash: true };
  const target = fakeTarget(backend, "rt-artifacts", meta);
  await ensureChannelFolder("rt-artifacts", meta, { target });

  const artifacts = await createRunGrantArtifacts({ slug: "rt-artifacts", meta, needsClaudeSettings: true, target });
  try {
    // Nothing under the gateway root may ever be handed to a containerized engine: that tree is
    // never mounted, so a path into it is a file the engine cannot open.
    assert.ok(artifacts.settingsFile.startsWith(`${target.artifactDir}${path.sep}`), artifacts.settingsFile);
    assert.doesNotMatch(artifacts.settingsFile, new RegExp(channelFolder("rt-artifacts", "slack").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(artifacts.artifactRoot, target.artifactDir);
    for (const dir of artifacts.claudePluginDirs) assert.ok(dir.startsWith(`${target.artifactDir}${path.sep}`), dir);

    // The engine homes are the IMAGE's, not the daemon's: mounting the daemon's synthetic Claude
    // home would expose every transcript on the box (its projects/sessions are symlinks into the
    // operator's own ~/.claude).
    assert.equal(artifacts.claudeHome, CONTAINER_AGENT_HOME);
    assert.equal(artifacts.claudeConfigDir, `${CONTAINER_AGENT_HOME}/.claude`);
    assert.equal(artifacts.codexHome, `${CONTAINER_AGENT_HOME}/.codex`);
    assert.equal(artifacts.codexUserHome, CONTAINER_AGENT_HOME);

    // Host-only plumbing is not merely unused, it is not built — the keys are gone, not empty:
    // launcher dirs shimmed the host's own toolchain, and credential symlinks pointed at the
    // operator's home. The Codex skill overlay has no host-side delivery path either.
    for (const key of ["toolchainBinDir", "codexToolchainBinDir", "codexCredentialPaths"]) {
      assert.equal(key in artifacts, false, `${key} is host plumbing`);
    }
    assert.equal(artifacts.codexSkillSupportDir, "");
  } finally {
    await artifacts.cleanup();
  }
});

test("a caller with no artifact dir is refused instead of being served files from the gateway root", async () => {
  const meta = { platform: "slack", allowedMcps: [] };
  await ensureChannelFolder("rt-no-artifacts", meta);
  // No target at all, and the daemon's own local target (which mounts nothing and so names no
  // artifact dir): a containerized engine would silently find neither settings nor MCP config.
  for (const target of [undefined, null, localRuntimeTarget(process.cwd())]) {
    await assert.rejects(
      createRunGrantArtifacts({ slug: "rt-no-artifacts", meta, needsClaudeSettings: true, target }),
      /runtime target must carry an artifactDir/,
    );
  }
});

test("engineHomesFor answers null for no target, and prefers what the backend declares", () => {
  assert.equal(engineHomesFor(null), null);
  assert.equal(engineHomesFor(undefined), null);

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
