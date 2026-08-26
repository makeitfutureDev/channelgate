#!/usr/bin/env node
// Idempotently provision the gateway-owned whisper.cpp runtime and multilingual model.
// Linux uses signed-release assets; macOS builds the pinned source so Apple Metal stays enabled.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gatewayRoot, WHISPER_CPP_VERSION, WHISPER_MODEL_NAME } from "../src/config/paths.js";
import { processFailureMessage } from "../src/util/process-outcome.js";

const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}`;
const SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_CPP_VERSION}.tar.gz`;
const SOURCE_SHA256 = "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447";
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${WHISPER_MODEL_NAME}`;
const MODEL_SHA256 = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";
const MODEL_BYTES = 1_624_555_275;

const LINUX_ASSETS = {
  x64: {
    name: "whisper-bin-ubuntu-x64.tar.gz",
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
  },
  arm64: {
    name: "whisper-bin-ubuntu-arm64.tar.gz",
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
  },
};

export function platformArtifact({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin") {
    if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}`);
    return null;
  }
  if (platform === "linux") {
    const asset = LINUX_ASSETS[arch];
    if (!asset) throw new Error(`Unsupported Linux architecture: ${arch}`);
    return { ...asset };
  }
  throw new Error(`Unsupported operating system for local Whisper: ${platform}`);
}

export function safeArchiveEntries(entries) {
  for (const raw of entries || []) {
    const name = String(raw || "").trim();
    const parts = name.replace(/\\/g, "/").split("/");
    if (!name || name.startsWith("/") || name.includes("\\") || parts.includes("..")) {
      throw new Error(`Unsafe archive entry: ${name || "(empty)"}`);
    }
  }
  return true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) throw new Error(processFailureMessage(command, { spawnError: result.error }));
  if (result.status !== 0 || result.signal) {
    throw new Error(processFailureMessage(command, { code: result.status, signal: result.signal }));
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, ...options });
  if (result.error || result.status !== 0) return "";
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function commandWorks(command, args = ["--version"]) {
  return Boolean(capture(command, args));
}

function requireHomebrew() {
  if (!commandWorks("brew", ["--version"])) {
    throw new Error("Homebrew is required to provision Whisper dependencies on macOS. Install it from https://brew.sh and re-run npm run whisper:install.");
  }
}

function ensureMacDependency(command, brewFormula, versionArgs = ["--version"]) {
  if (commandWorks(command, versionArgs)) return;
  requireHomebrew();
  console.log(`→ Installing ${brewFormula} with Homebrew…`);
  run("brew", ["install", brewFormula]);
  if (!commandWorks(command, versionArgs)) throw new Error(`${command} is still unavailable after Homebrew installation.`);
}

function linuxPrivilegePrefix() {
  if (typeof process.getuid === "function" && process.getuid() === 0) return [];
  const sudo = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  if (!sudo.error && sudo.status === 0) return ["sudo", "-n"];
  return null;
}

function ensureLinuxFfmpeg() {
  if (commandWorks("ffmpeg", ["-version"])) return;
  const prefix = linuxPrivilegePrefix();
  const managers = [
    ["apt-get", ["install", "-y", "ffmpeg"]],
    ["dnf", ["install", "-y", "ffmpeg"]],
    ["yum", ["install", "-y", "ffmpeg"]],
    ["zypper", ["--non-interactive", "install", "ffmpeg"]],
    ["pacman", ["-S", "--noconfirm", "ffmpeg"]],
  ];
  const found = managers.find(([command]) => commandWorks(command, ["--version"]));
  if (!found || !prefix) {
    throw new Error("FFmpeg is required for Slack voice clips. Install it with your Linux package manager, then re-run npm run whisper:install.");
  }
  const [manager, args] = found;
  console.log(`→ Installing FFmpeg with ${manager}…`);
  if (prefix.length) run(prefix[0], [...prefix.slice(1), manager, ...args]);
  else run(manager, args);
  if (!commandWorks("ffmpeg", ["-version"])) throw new Error("ffmpeg is still unavailable after package installation.");
}

function ensureDependencies(platform) {
  if (!commandWorks("tar", ["--version"])) throw new Error("The portable tar utility is required to install whisper.cpp.");
  if (platform === "darwin") {
    ensureMacDependency("ffmpeg", "ffmpeg", ["-version"]);
    ensureMacDependency("cmake", "cmake");
  } else {
    ensureLinuxFfmpeg();
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(file, sha256) {
  return existsSync(file) && (await sha256File(file)) === sha256;
}

async function downloadVerified(url, destination, sha256, { expectedBytes = 0, label = path.basename(destination) } = {}) {
  if (await verified(destination, sha256)) {
    console.log(`→ ${label} already present and verified.`);
    return false;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const part = `${destination}.part-${process.pid}-${Date.now()}`;
  console.log(`→ Downloading ${label}${expectedBytes ? ` (${(expectedBytes / 1024 / 1024 / 1024).toFixed(1)} GiB)` : ""}…`);
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status})`);
    const output = createWriteStream(part, { flags: "wx", mode: 0o600 });
    const hash = createHash("sha256");
    let received = 0;
    let nextReport = 10;
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      if (expectedBytes) {
        const percent = Math.floor((received * 100) / expectedBytes);
        if (percent >= nextReport) {
          console.log(`  ${Math.min(100, percent)}%`);
          nextReport += 10;
        }
      }
    }
    await new Promise((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
    if (expectedBytes && received !== expectedBytes) throw new Error(`${label} size mismatch: expected ${expectedBytes}, received ${received}`);
    const actual = hash.digest("hex");
    if (actual !== sha256) throw new Error(`${label} checksum mismatch: expected ${sha256}, received ${actual}`);
    await chmod(part, 0o644);
    await rename(part, destination);
    console.log(`→ ${label} downloaded and verified.`);
    return true;
  } finally {
    await rm(part, { force: true }).catch(() => {});
  }
}

function listArchive(archive) {
  const result = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect ${path.basename(archive)}: ${String(result.stderr || "").trim()}`);
  const entries = String(result.stdout || "").split("\n").filter(Boolean);
  safeArchiveEntries(entries);
  return entries;
}

function runtimeEnv(toolsDir) {
  const bin = path.join(toolsDir, "bin");
  const lib = path.join(toolsDir, "lib");
  return {
    ...process.env,
    LD_LIBRARY_PATH: [bin, lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
    DYLD_LIBRARY_PATH: [bin, lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
  };
}

function validRuntime(toolsDir) {
  const cli = path.join(toolsDir, "bin", "whisper-cli");
  if (!existsSync(cli)) return false;
  return capture(cli, ["--version"], { cwd: path.dirname(cli), env: runtimeEnv(toolsDir) }).includes(WHISPER_CPP_VERSION.slice(1));
}

async function promoteStage(stage, toolsDir) {
  // A valid pinned runtime is never replaced. An invalid/incomplete directory is generated state
  // under a version-specific path and safe to remove before the atomic same-filesystem rename.
  await rm(toolsDir, { recursive: true, force: true });
  await rename(stage, toolsDir);
}

async function installLinuxRuntime({ toolsDir, artifact }) {
  const parent = path.dirname(toolsDir);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, `.install-${WHISPER_CPP_VERSION}-`));
  try {
    const archive = path.join(scratch, artifact.name);
    await downloadVerified(`${RELEASE_BASE}/${artifact.name}`, archive, artifact.sha256, { label: artifact.name });
    const entries = listArchive(archive);
    const rootName = entries[0]?.split("/")[0];
    if (!rootName) throw new Error("Whisper release archive has no root directory.");
    const extracted = path.join(scratch, "extracted");
    const stage = path.join(scratch, "stage");
    await mkdir(extracted, { recursive: true });
    await mkdir(stage, { recursive: true });
    run("tar", ["-xzf", archive, "-C", extracted]);
    await rename(path.join(extracted, rootName), path.join(stage, "bin"));
    await chmod(path.join(stage, "bin", "whisper-cli"), 0o755);
    await promoteStage(stage, toolsDir);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function installMacRuntime({ toolsDir }) {
  const parent = path.dirname(toolsDir);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, `.build-${WHISPER_CPP_VERSION}-`));
  try {
    const archive = path.join(scratch, `whisper.cpp-${WHISPER_CPP_VERSION}.tar.gz`);
    await downloadVerified(SOURCE_URL, archive, SOURCE_SHA256, { label: `whisper.cpp ${WHISPER_CPP_VERSION} source` });
    listArchive(archive);
    const source = path.join(scratch, "source");
    const build = path.join(scratch, "build");
    const stage = path.join(scratch, "stage");
    await mkdir(source, { recursive: true });
    run("tar", ["-xzf", archive, "-C", source, "--strip-components", "1"]);
    run("cmake", [
      "-S", source,
      "-B", build,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_EXAMPLES=ON",
    ]);
    run("cmake", ["--build", build, "--config", "Release", "--target", "whisper-cli", "-j", String(Math.max(1, os.availableParallelism?.() || os.cpus().length || 1))]);
    // The upstream install manifest includes optional Parakeet artifacts even when only the
    // whisper-cli target is built. Promote the complete build/bin directory instead: it contains
    // the CLI and every adjacent dylib it links, without unused headers/targets.
    await mkdir(stage, { recursive: true });
    await rename(path.join(build, "bin"), path.join(stage, "bin"));
    if (!existsSync(path.join(stage, "bin", "whisper-cli"))) {
      throw new Error("whisper-cli was not produced by the pinned macOS build.");
    }
    await promoteStage(stage, toolsDir);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function provisionWhisper({
  platform = process.platform,
  arch = process.arch,
  root = gatewayRoot(),
  skipDependencies = false,
} = {}) {
  const artifact = platformArtifact({ platform, arch });
  if (!skipDependencies) ensureDependencies(platform);
  const toolsDir = path.join(root, "tools", "whisper", WHISPER_CPP_VERSION);
  const cliPath = path.join(toolsDir, "bin", "whisper-cli");
  const modelPath = path.join(root, "models", "whisper", WHISPER_MODEL_NAME);
  let changed = false;
  if (!validRuntime(toolsDir)) {
    console.log(`→ Provisioning whisper.cpp ${WHISPER_CPP_VERSION} for ${platform}/${arch}…`);
    if (platform === "darwin") await installMacRuntime({ toolsDir });
    else await installLinuxRuntime({ toolsDir, artifact });
    changed = true;
  } else {
    console.log(`→ whisper.cpp ${WHISPER_CPP_VERSION} already installed.`);
  }
  changed = (await downloadVerified(MODEL_URL, modelPath, MODEL_SHA256, {
    expectedBytes: MODEL_BYTES,
    label: "Whisper large-v3-turbo model",
  })) || changed;
  if (!validRuntime(toolsDir)) throw new Error(`Whisper smoke check failed at ${cliPath}.`);
  console.log(`✅ Local Whisper ready: ${cliPath}`);
  console.log(`   model: ${modelPath}`);
  return { cliPath, modelPath, changed };
}

async function main() {
  console.log("\nChannelGate — local Whisper setup");
  await provisionWhisper();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(`❌ Local Whisper setup failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
