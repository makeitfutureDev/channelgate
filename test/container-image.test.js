// The image CONTRACT: the paths the backend hands the engines must be paths the build actually
// puts in the image, and the pins the Containerfile bakes in must be the pins the repo declares.
// These are the assertions that catch "helperCommand points at a file that is not in the image" —
// a class of bug that otherwise only shows up as an MCP server silently failing to start.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const { IMAGE_HELPERS, CONTAINER_BIN_DIR, CONTAINER_BUNDLE_ROOT, CONTAINER_PATH, CONTAINER_HOME, CONTAINER_SOCKET_DIR } =
  await import("../src/runtimes/container/image-paths.js");

const buildScript = read("scripts/build-image.mjs");
const containerfile = read("containers/Containerfile");
const versions = JSON.parse(read("containers/versions.json"));
const pkg = JSON.parse(read("package.json"));

// The build script's declared inputs, read out of the source so the test tracks the real list.
function declaredList(name) {
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(buildScript);
  assert.ok(block, `${name} not found in scripts/build-image.mjs`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function importClosure(entries) {
  const patterns = [
    /(?:^|[\n;])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const files = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    files.add(rel);
    const source = read(rel);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const spec = match[1];
        if (spec.startsWith("node:") || !spec.startsWith(".")) continue;
        queue.push(path.relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, rel)), spec)));
      }
    }
  }
  return [...files];
}

test("every helper the backend hands an engine is a path the build actually stages", () => {
  const entries = declaredList("BUNDLE_ENTRIES");
  const closure = importClosure(entries);
  const bridgeSource = /const SOCKET_BRIDGE_SOURCE = "([^"]+)"/.exec(buildScript)[1];
  const bridgeDest = /const SOCKET_BRIDGE_DEST = "([^"]+)"/.exec(buildScript)[1];
  assert.ok(existsSync(path.join(repoRoot, bridgeSource)), `${bridgeSource} must exist to be staged`);

  // bundle/ mirrors src/ with the prefix stripped; bin/ is containers/bin plus the staged bridge.
  const staged = new Set([
    ...closure.map((rel) => `${CONTAINER_BUNDLE_ROOT}/${rel.replace(/^src\//, "")}`),
    `${CONTAINER_BUNDLE_ROOT}/${bridgeDest}`,
  ]);
  for (const name of readdirSyncSafe(path.join(repoRoot, "containers", "bin"))) {
    staged.add(`${CONTAINER_BIN_DIR}/${name}`);
  }
  for (const [name, helper] of Object.entries(IMAGE_HELPERS)) {
    for (const arg of helper.args) {
      assert.ok(staged.has(arg), `helperCommand("${name}") points at ${arg}, which the image build does not stage`);
    }
  }
});

test("the image bundle stays minimal: no settings, no database, no engine registry inside a container", () => {
  const closure = importClosure(declaredList("BUNDLE_ENTRIES"));
  for (const forbidden of ["src/config/settings.js", "src/db/index.js", "src/engines/registry.js", "src/gateway/run.js"]) {
    assert.ok(!closure.includes(forbidden), `${forbidden} must not ship in the channel image — it reads state a container cannot see`);
  }
  assert.ok(closure.length <= 12, `the image bundle grew to ${closure.length} modules: ${closure.join(", ")}`);
});

test("pins: the image installs the same mcp-remote the daemon depends on, and every ARG is declared", () => {
  assert.equal(versions.npm["mcp-remote"], pkg.dependencies["mcp-remote"], "the image's mcp-remote pin has drifted from package.json");
  for (const [name, pin] of Object.entries(versions.npm)) {
    assert.match(pin, /^\d+\.\d+\.\d+/, `${name} must be pinned to an exact version, got "${pin}"`);
  }
  assert.match(String(versions.imageSpecVersion), /^\d+\.\d+\.\d+$/);
  for (const arg of ["UID", "GID", "CLAUDE_VERSION", "CODEX_VERSION", "MCP_REMOTE_VERSION", "VERCEL_VERSION", "SUPABASE_VERSION", "IMAGE_SPEC_VERSION"]) {
    assert.ok(new RegExp(`ARG ${arg}\\b`).test(containerfile), `containers/Containerfile is missing ARG ${arg}`);
    assert.ok(buildScript.includes(`${arg}=`), `scripts/build-image.mjs never passes --build-arg ${arg}`);
  }
});

test("the Containerfile bakes in exactly the paths the backend declares", () => {
  assert.ok(containerfile.includes(`PATH=${CONTAINER_PATH}`), "PATH drifted from src/runtimes/container/image-paths.js");
  assert.ok(containerfile.includes(`HOME=${CONTAINER_HOME}`));
  assert.ok(containerfile.includes(`${CONTAINER_BIN_DIR}/`), "the helper bin dir is not created in the image");
  // The HOME subdirectories MUST exist in the image: a brand-new named volume is seeded from it,
  // and the Codex auth FILE mount would otherwise make the runtime create /home/agent/.codex
  // root-owned — which silently breaks Codex's session writes (verified on podman 5.7).
  assert.match(containerfile, /install -d -o agent -g agent[^\n]*\/home\/agent\/\.codex/);
  assert.match(containerfile, /install -d -o agent -g agent[^\n]*\/home\/agent\/\.claude/);
  assert.ok(containerfile.includes("cg-init"), "cg-init must be the container's command so it runs on every start");
  assert.ok(containerfile.includes("tini"), "tini reaps the orphans a long-lived agent container produces");
  assert.equal(CONTAINER_SOCKET_DIR, "/run/channelgate");
});

test("the container-side helper scripts are present, executable and POSIX-sh clean", async () => {
  const { spawnSync } = await import("node:child_process");
  const binDir = path.join(repoRoot, "containers", "bin");
  const expected = ["cg-exec", "cg-probe", "cg-signal", "cg-sweep", "cg-init", "cg-mcp-bridge"];
  for (const name of expected) {
    const file = path.join(binDir, name);
    assert.ok(existsSync(file), `containers/bin/${name} is missing`);
    assert.ok(statSync(file).mode & 0o111, `containers/bin/${name} is not executable`);
    const source = readFileSync(file, "utf8");
    assert.ok(source.startsWith("#!/bin/sh"), `containers/bin/${name} must be POSIX sh`);
    const parsed = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `containers/bin/${name}: ${parsed.stderr}`);
  }
  // The run wrapper is what makes probe/signal reach a whole process tree from a separate exec.
  const cgExec = readFileSync(path.join(binDir, "cg-exec"), "utf8");
  assert.match(cgExec, /setsid -w/, "cg-exec must keep the run in the foreground so exit codes and stdio stay the engine's");
  assert.match(cgExec, /\/run\/cg\/\$0\.pid/, "cg-exec must record the group leader's pid for cg-probe/cg-signal");
  assert.match(readFileSync(path.join(binDir, "cg-signal"), "utf8"), /-\$pid/, "cg-signal must address the whole process group");
  const init = readFileSync(path.join(binDir, "cg-init"), "utf8");
  assert.doesNotMatch(init, /cp .*\.credentials\.json/, "cg-init must never copy a Claude login into the container (2026-09-02 incident)");
  assert.match(init, /setup-token/, "cg-init documents the token-only rule");
});

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── When an update has to rebuild the image ───────────────────────────────────────────────────
// The channel image is the toolchain a container channel actually runs, and nothing rebuilt it on
// update: `containers/` could change or the spec could be bumped and every container channel kept
// running the old image until an operator read the boot warning. scripts/update-runner.mjs asks
// this decision; it is pure so the three conditions are testable without a CLI or a build.
const { needsImageBuild, isImageSourcePath, CONTAINER_DEFAULT_IMAGE, IMAGE_SOURCE_PREFIX } =
  await import("../src/runtimes/container/image.js");

test("needsImageBuild builds when the image spec moved, the sources changed, or nothing is built", () => {
  const current = { containerRuntimeEnabled: true, changedPaths: ["src/gateway/run.js"], builtSpecVersion: "1.1.1", expectedSpecVersion: "1.1.1" };

  assert.equal(needsImageBuild(current), false, "an update that touches neither the image sources nor the spec builds nothing");
  assert.equal(needsImageBuild({ ...current, expectedSpecVersion: "1.2.0" }), true, "a bumped spec version must rebuild");
  assert.equal(needsImageBuild({ ...current, builtSpecVersion: "1.0.0" }), true, "an image older than this checkout must rebuild");
  assert.equal(needsImageBuild({ ...current, builtSpecVersion: "" }), true, "no image built at all must build one");
  assert.equal(
    needsImageBuild({ ...current, changedPaths: ["src/gateway/run.js", "containers/Containerfile"] }),
    true,
    "a change under containers/ must rebuild even at the same spec version",
  );
  assert.equal(needsImageBuild({ ...current, changedPaths: ["containers/versions.json"] }), true, "a pin bump must rebuild");

  // The switch is the gate: a host-only install must never pay for a build it cannot use, however
  // stale the image on disk is.
  assert.equal(needsImageBuild({ ...current, containerRuntimeEnabled: false, builtSpecVersion: "" }), false);
  assert.equal(needsImageBuild({}), false, "no inputs at all is not a reason to build");
  // A candidate whose versions.json could not be read must not trigger a build on every update.
  assert.equal(needsImageBuild({ ...current, expectedSpecVersion: "" }), false);

  assert.equal(isImageSourcePath("containers/bin/cg-exec"), true);
  assert.equal(isImageSourcePath("containers\\bin\\cg-exec"), true, "git diff paths are compared forward-slashed");
  assert.equal(isImageSourcePath("src/runtimes/container/index.js"), false);
  assert.equal(IMAGE_SOURCE_PREFIX, "containers/");
  // The build's default tag and the settings default must name the same image, or an update would
  // rebuild one ref and inspect another.
  assert.ok(buildScript.includes(`tag: "${CONTAINER_DEFAULT_IMAGE.split(":")[0]}"`), "build:image must default to the configured image repo");
  assert.equal(CONTAINER_DEFAULT_IMAGE.endsWith(":latest"), true);
});
