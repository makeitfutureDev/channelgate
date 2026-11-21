#!/usr/bin/env node
// Build the ChannelGate channel image (containers/Containerfile).
//
//   npm run build:image [-- --cli podman|docker] [--tag channelgate/runtime] [--no-cache]
//
// Two things this script exists to get right:
//
//  1. **uid/gid parity.** The image's `agent` user is created at the DAEMON user's real uid/gid, so
//     files written inside a container are owned by the daemon user on the host with no chown pass
//     (rootless podman maps them 1:1 through --userns=keep-id; docker gets --user <uid>:<gid>).
//     Building as a different user than the one that runs the daemon produces an image whose
//     channels cannot write their own workdir — so the uid is baked in, not guessed at runtime.
//
//  2. **A minimal in-container bundle.** The engines spawn three daemon-side helpers during a run
//     (the Codex secret-env bridge, the Composio SDK bridge, the Claude Stop hook). Inside a
//     container those cannot come from the checkout — the checkout is never mounted — so their
//     IMPORT CLOSURE is resolved (src/runtimes/container/image-bundle.js) and only those files are
//     staged into /opt/channelgate.
import { expectedImageBuild } from "../src/runtimes/container/image.js";
import { BUNDLE_ENTRIES, VERBATIM_HELPERS, resolveBundleClosure } from "../src/runtimes/container/image-bundle.js";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const containersDir = path.join(repoRoot, "containers");

// What gets staged besides containers/ — the engine-spawned helpers whose import closure is
// bundled, and the verbatim bridges copied into bin/ — is declared once in
// src/runtimes/container/image-bundle.js, which the daemon also digests into the `cg.image.bundle`
// label it compares, so a staged file can never move without the image reading as stale.

// Packages the bundle needs that no `import` statement names. Empty since container-secrets P4
// retired remote-secret-bridge (the only helper that resolved mcp-remote with createRequire):
// header-bearing remote MCPs are relayed by the daemon, so no bundled helper bridges one. The image
// still installs the pinned mcp-remote globally (containers/Containerfile) as a tool.
const BUNDLE_EXTRA_PACKAGES = [];

function parseArgs(argv) {
  const out = { cli: process.env.CG_CONTAINER_CLI || "auto", tag: "channelgate/runtime", noCache: false, keepContext: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cli") out.cli = argv[++i];
    else if (arg === "--tag") out.tag = argv[++i];
    else if (arg === "--no-cache") out.noCache = true;
    else if (arg === "--keep-context") out.keepContext = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

function installedVersion(name) {
  const manifest = path.join(repoRoot, "node_modules", name, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`${name} is not installed in this checkout — run \`npm install\` before building the image`);
  }
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

// The build context: the Containerfile, the container-side helper scripts, and the staged bundle.
// Staging into a temp dir rather than building from the repo root keeps the checkout out of the
// image entirely — a `COPY . .` mistake becomes impossible rather than merely discouraged.
function stageContext({ closure }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cg-image-"));
  cpSync(path.join(containersDir, "Containerfile"), path.join(dir, "Containerfile"));
  cpSync(path.join(containersDir, "bin"), path.join(dir, "bin"), { recursive: true });
  for (const helper of VERBATIM_HELPERS) {
    const source = path.join(repoRoot, helper.source);
    if (!existsSync(source)) throw new Error(`${helper.source} is missing — ${helper.role} cannot be staged`);
    cpSync(source, path.join(dir, helper.dest));
  }
  const bundleDir = path.join(dir, "bundle");
  for (const rel of closure.files) {
    // Strip the leading `src/` so /opt/channelgate mirrors src/ — every relative import inside the
    // closure keeps resolving unchanged.
    const dest = path.join(bundleDir, rel.replace(/^src\//, ""));
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(repoRoot, rel), dest);
  }
  const dependencies = {};
  for (const name of [...closure.packages, ...BUNDLE_EXTRA_PACKAGES]) dependencies[name] = installedVersion(name);
  writeFileSync(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify({
      name: "channelgate-container-bundle",
      private: true,
      // Required: the bundle's .js files are ES modules, and Node decides that from the nearest
      // package.json. Without this every helper would fail with "Cannot use import outside a module".
      type: "module",
      version: "0.0.0",
      dependencies,
      // Carry reviewed transitive security pins into the independently installed helper bundle.
      overrides: JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).overrides || {},
    }, null, 2)}\n`,
  );
  return { dir, bundleDir, dependencies };
}

function resolveCliBin(choice) {
  const candidates = choice === "auto" ? ["podman", "docker"] : [choice];
  const failures = [];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["info", "--format", "json"], { encoding: "utf8" });
    if (probe.status === 0) return bin;
    failures.push(`${bin}: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().split("\n").pop()}`);
  }
  throw new Error(`no usable container CLI — ${failures.join("; ")}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run build:image [-- --cli podman|docker] [--tag <repo>] [--no-cache] [--keep-context]");
    return;
  }
  const versions = JSON.parse(readFileSync(path.join(containersDir, "versions.json"), "utf8"));
  const specVersion = String(versions.imageSpecVersion || "0.0.0");
  const npmPins = versions.npm || {};
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  if (uid === 0) {
    throw new Error("refusing to build the channel image as root — build it as the user the gateway daemon runs as, so the image's agent uid matches");
  }

  const closure = resolveBundleClosure(repoRoot, BUNDLE_ENTRIES);
  const staged = stageContext({ closure });
  // Computed by the SAME function the daemon calls, over the same checkout, so the labels are
  // exactly what an up-to-date daemon expects.
  const desired = expectedImageBuild(repoRoot);
  const bin = resolveCliBin(options.cli);

  const args = [
    "build",
    "-f", path.join(staged.dir, "Containerfile"),
    "-t", `${options.tag}:${specVersion}`,
    "-t", `${options.tag}:latest`,
    "--build-arg", `UID=${uid}`,
    "--build-arg", `GID=${gid}`,
    "--build-arg", `CLAUDE_VERSION=${npmPins["@anthropic-ai/claude-code"]}`,
    "--build-arg", `CODEX_VERSION=${npmPins["@openai/codex"]}`,
    "--build-arg", `MCP_REMOTE_VERSION=${npmPins["mcp-remote"]}`,
    "--build-arg", `MAKE_CLI_VERSION=${npmPins["@makehq/cli"]}`,
    "--build-arg", `VERCEL_VERSION=${npmPins.vercel}`,
    "--build-arg", `SUPABASE_VERSION=${npmPins.supabase}`,
    "--build-arg", `PLAYWRIGHT_VERSION=${npmPins.playwright}`,
    "--build-arg", `AGENT_BROWSER_VERSION=${npmPins["agent-browser"]}`,
    // commit:serverSha256:cliSha256 per shared VS Code server; the Containerfile verifies each download.
    "--build-arg", `VSCODE_SERVERS=${(versions.vscodeServers || []).map((v) => `${v.commit}:${v.serverSha256}:${v.cliSha256}`).join(" ")}`,
    "--build-arg", `OPENCV_VERSION=${versions.python?.["opencv-python-headless"]}`,
    "--build-arg", `FASTER_WHISPER_VERSION=${versions.python?.["faster-whisper"]}`,
    "--build-arg", `PERPLEXITY_VERSION=${versions.python?.["perplexity-web-mcp-cli"]}`,
    "--build-arg", `WHISPER_MODEL=${versions.whisperModel}`,
    "--build-arg", `IMAGE_SPEC_VERSION=${specVersion}`,
    "--build-arg", `IMAGE_BUILD_DIGEST=${desired.digest}`,
    "--build-arg", `IMAGE_BUNDLE_DIGEST=${desired.bundleDigest}`,
    "--build-arg", `IMAGE_TOOLCHAIN=${JSON.stringify(npmPins)}`,
  ];
  if (options.noCache) args.push("--no-cache");
  args.push(staged.dir);

  console.log(`[build:image] ${bin} building ${options.tag}:${specVersion} (uid ${uid}:${gid})`);
  console.log(`[build:image] bundle: ${closure.files.length} module(s), deps ${Object.entries(staged.dependencies).map(([n, v]) => `${n}@${v}`).join(", ") || "none"}`);
  const build = spawnSync(bin, args, { stdio: "inherit" });
  if (!options.keepContext) rmSync(staged.dir, { recursive: true, force: true });
  else console.log(`[build:image] context kept at ${staged.dir}`);
  if (build.status !== 0) process.exit(build.status || 1);

  const id = execFileSync(bin, ["image", "inspect", "--format", "{{.Id}}", `${options.tag}:${specVersion}`], { encoding: "utf8" }).trim();
  console.log(`[build:image] built ${options.tag}:${specVersion} (also tagged :latest) → ${id}`);
}

try {
  main();
} catch (error) {
  console.error(`[build:image] ${error?.message || error}`);
  process.exit(1);
}
