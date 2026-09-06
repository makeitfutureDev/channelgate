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
  for (const [name, pin] of Object.entries(versions.python)) {
    assert.match(pin, /^\d+(?:\.\d+){2,3}$/, `${name} must be pinned to an exact version, got "${pin}"`);
  }
  assert.equal(versions.whisperModel, "small");
  assert.match(String(versions.imageSpecVersion), /^\d+\.\d+\.\d+$/);
  for (const arg of ["UID", "GID", "CLAUDE_VERSION", "CODEX_VERSION", "MCP_REMOTE_VERSION", "VERCEL_VERSION", "SUPABASE_VERSION", "OPENCV_VERSION", "FASTER_WHISPER_VERSION", "WHISPER_MODEL", "IMAGE_SPEC_VERSION"]) {
    assert.ok(new RegExp(`ARG ${arg}\\b`).test(containerfile), `containers/Containerfile is missing ARG ${arg}`);
    assert.ok(buildScript.includes(`${arg}=`), `scripts/build-image.mjs never passes --build-arg ${arg}`);
  }
});

test("npm run setup builds the channel image as part of the install, and can be told not to", () => {
  const install = readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
  assert.match(install, /node scripts\/build-image\.mjs/, "install.sh must build the channel image");
  assert.match(install, /--skip-image/, "install.sh must accept --skip-image for a deferred build");
  assert.match(install, /CG_BUILD_IMAGE/, "install.sh must honor CG_BUILD_IMAGE for unattended installs");
  assert.match(install, /npm run build:image/, "a skipped or failed build must name the manual remedy");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.setup, "bash scripts/install.sh");
  assert.equal(pkg.scripts["build:image"], "node scripts/build-image.mjs");
});

test("the image ships the complete local video-understanding toolchain", () => {
  assert.match(containerfile, /\bffmpeg\b/, "ffmpeg/ffprobe must be installed from the distro");
  assert.match(containerfile, /opencv-python-headless==\$\{OPENCV_VERSION\}/);
  assert.match(containerfile, /faster-whisper==\$\{FASTER_WHISPER_VERSION\}/);
  assert.match(containerfile, /WhisperModel\('\$\{WHISPER_MODEL\}'/);
  assert.match(containerfile, /HF_HOME=\/opt\/channelgate\/models\/huggingface/);
  assert.match(containerfile, /chmod -R a\+rX \/opt\/channelgate\/models/);
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
  assert.match(cgExec, /\$d\/\$0\.pid/, "cg-exec must record the group leader's pid for cg-probe/cg-signal");
  const cgSignal = readFileSync(path.join(binDir, "cg-signal"), "utf8");
  assert.match(cgSignal, /-\$pid/, "cg-signal must address the whole process group");
  assert.match(cgSignal, /\/proc\/\[0-9\]\*/, "cg-signal must walk /proc to find what escaped the run's group");
  // A sweep must reach exactly what a stop reaches, so it goes through cg-signal rather than
  // repeating the walk — two copies of this would drift.
  assert.match(readFileSync(path.join(binDir, "cg-sweep"), "utf8"), /cg-signal/, "cg-sweep must sweep through cg-signal");
  for (const name of ["cg-exec", "cg-probe", "cg-signal", "cg-sweep"]) {
    assert.match(readFileSync(path.join(binDir, name), "utf8"), /CG_RUN_DIR:-\/run\/cg/, `containers/bin/${name} must read the pidfile dir from CG_RUN_DIR, defaulting to /run/cg`);
  }
  const init = readFileSync(path.join(binDir, "cg-init"), "utf8");
  assert.doesNotMatch(init, /cp .*\.credentials\.json/, "cg-init must never copy a Claude login into the container (2026-09-02 incident)");
  assert.match(init, /setup-token/, "cg-init documents the token-only rule");
});

// ── The stop path, executed for real ──────────────────────────────────────────────────────────
// A run's process GROUP is not the whole run: Claude Code's Bash tool puts its shell in a new
// session AND a new process group, so `kill -- -<leader>` reported success while the tool's shell
// kept going and its command ran to completion minutes after the turn was reported stopped (live,
// CTR-11). Reading the scripts cannot catch that, so this runs the real `cg-exec` and `cg-signal`
// against the kernel's own /proc, with the pidfile directory pointed at a temp dir so no root and
// no container are needed. `setsid <cmd> &` from the run's shell reproduces the escape exactly:
// same parent, new session, new process group.
test(
  "cg-signal stops a child that escaped the run's process group and session",
  { skip: process.platform === "linux" ? false : "the container-side helpers are Linux-only" },
  async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { tempDir } = await import("./helpers.js");

    const stat = (pid) => {
      let raw;
      try {
        raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return null;
      }
      // `comm` is unquoted and may hold spaces and parentheses: the fields start after the LAST ")".
      const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
      return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]) };
    };
    const alive = (pid) => {
      const s = stat(pid);
      return Boolean(s) && s.state !== "Z";
    };
    const readPid = (file) => {
      try {
        const value = Number(readFileSync(file, "utf8").trim());
        return Number.isInteger(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    };
    const waitFor = async (fn, ms = 5000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    const runDir = tempDir("cg-run-");
    const runId = `run-escape-${process.pid}`;
    const escapedFile = path.join(runDir, "escaped.pid");
    const env = { ...process.env, CG_RUN_DIR: runDir };
    const bin = (name) => path.join(repoRoot, "containers", "bin", name);

    const client = spawn(
      bin("cg-exec"),
      [runId, "/bin/sh", "-c", 'setsid sleep 300 & echo $! > "$1"; wait', "cg-test", escapedFile],
      { env, stdio: "ignore" },
    );
    let leader = null;
    let escaped = null;
    try {
      leader = await waitFor(() => readPid(path.join(runDir, `${runId}.pid`)));
      assert.ok(leader, "cg-exec never recorded the run leader's pid");
      escaped = await waitFor(() => readPid(escapedFile));
      assert.ok(escaped, "the run never started the escaping child");
      const escapedStat = await waitFor(() => stat(escaped));
      const leaderStat = stat(leader);
      assert.ok(leaderStat && escapedStat, "both processes must be running before the stop");
      assert.equal(leaderStat.session, leader, "cg-exec must make the run leader a session leader");
      assert.equal(escapedStat.ppid, leader, "the escapee must still be the leader's child when the stop arrives");
      assert.notEqual(escapedStat.pgrp, leaderStat.pgrp, "the child must have left the run's process group, or this proves nothing");
      assert.notEqual(escapedStat.session, leaderStat.session, "the child must have left the run's session, or this proves nothing");

      const signalled = spawnSync(bin("cg-signal"), [runId, "TERM"], { env, encoding: "utf8" });
      assert.equal(signalled.status, 0, `cg-signal must report delivery: ${signalled.stderr}`);
      assert.equal(signalled.stderr, "", "cg-signal must stay quiet on stderr");

      const stopped = await waitFor(() => (!alive(leader) && !alive(escaped) ? true : null));
      assert.ok(stopped, `a stop must leave nothing behind (leader alive=${alive(leader)}, escapee alive=${alive(escaped)})`);
    } finally {
      for (const pid of [escaped, leader]) {
        if (!pid || !alive(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      client.kill("SIGKILL");
    }
  },
);

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
  const current = { changedPaths: ["src/gateway/run.js"], builtSpecVersion: "1.1.1", expectedSpecVersion: "1.1.1" };

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

  // Every install runs containers, so there is no switch that could excuse a missing image: no
  // inputs at all reads as "nothing built" and builds.
  assert.equal(needsImageBuild({}), true, "no inputs at all means no image, which must be built");
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

test("image diagnostics expose built and desired toolchains and detect legacy unlabeled images", async () => {
  const { createContainerImage, expectedImageBuild, IMAGE_INSPECT_FORMAT } = await import("../src/runtimes/container/image.js");
  const desired = expectedImageBuild(repoRoot);
  let stdout = `sha256:old|${desired.version}`;
  const image = createContainerImage({ cli: { async runWith(_caps, args) {
    assert.equal(args[3], IMAGE_INSPECT_FORMAT);
    return { code: 0, stdout };
  } } });
  const settings = { image: CONTAINER_DEFAULT_IMAGE };
  const old = await image.inspect({}, settings);
  assert.equal(old.needsRebuild, true);
  assert.equal(old.managed, true);
  assert.deepEqual(old.desiredToolchain, desired.toolchain);
  stdout = `sha256:new|${desired.version}|${desired.digest}|${JSON.stringify(desired.toolchain)}`;
  const current = await image.inspect({}, settings, { force: true });
  assert.equal(current.needsRebuild, false);
  assert.equal(current.digest, desired.digest);
  assert.deepEqual(current.toolchain, desired.toolchain);
  const custom = await image.inspect({}, { image: "private.example/runtime:custom" }, { force: true });
  assert.equal(custom.managed, false);
});
