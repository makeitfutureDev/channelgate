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
//     IMPORT CLOSURE is resolved here and only those files are staged into /opt/channelgate.
import { expectedImageBuild } from "../src/runtimes/container/image.js";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const containersDir = path.join(repoRoot, "containers");

// The engine-spawned helpers that must exist inside the image. Anything they import comes along.
const BUNDLE_ENTRIES = [
  "src/mcp/secret-env-bridge.js", // Codex: bundle → env → exec the real MCP command
  "src/mcp/remote-secret-bridge.js", // header-bearing remote MCPs: reads the 0600 bundle, execs mcp-remote
  "src/gateway/hooks/stop-subagents.mjs", // the Claude Stop hook
];

// The container-side half of the gateway control MCP, copied VERBATIM from the daemon-side
// reference implementation so the two halves of the socket protocol can never drift. It is staged
// as bin/cg-mcp-bridge.mjs: the engines are handed `node <that path>` (Codex reaches it through
// secret-env-bridge, which re-execs process.execPath), and .mjs makes it load as an ES module
// wherever it sits, independent of any package.json. Composio SDK mode is a second service on the
// same socket, so this one file serves both.
const SOCKET_BRIDGE_SOURCE = "src/mcp/socket-bridge.js";
const SOCKET_BRIDGE_DEST = "bin/cg-mcp-bridge.mjs";

// Packages the bundle needs that no `import` statement names: remote-secret-bridge resolves
// mcp-remote's proxy with createRequire, so it has to be resolvable from /opt/channelgate.
const BUNDLE_EXTRA_PACKAGES = ["mcp-remote"];

const IMPORT_PATTERNS = [
  /(?:^|[\n;])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
  /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

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

// Resolve the transitive closure of relative imports, and collect the bare package names so the
// bundle's package.json declares exactly what it needs and nothing else.
function resolveClosure(entries) {
  const files = new Set();
  const packages = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) throw new Error(`bundle entry ${rel} does not exist`);
    files.add(rel);
    const source = readFileSync(abs, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const spec = match[1];
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) {
          packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
          continue;
        }
        const next = path.relative(repoRoot, path.resolve(path.dirname(abs), spec));
        if (!existsSync(path.join(repoRoot, next))) {
          throw new Error(`${rel} imports "${spec}", which does not resolve to a file — the bundler only follows explicit relative paths`);
        }
        queue.push(next);
      }
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
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
  const bridge = path.join(repoRoot, SOCKET_BRIDGE_SOURCE);
  if (!existsSync(bridge)) throw new Error(`${SOCKET_BRIDGE_SOURCE} is missing — the container half of the gateway MCP cannot be staged`);
  cpSync(bridge, path.join(dir, SOCKET_BRIDGE_DEST));
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

  const closure = resolveClosure(BUNDLE_ENTRIES);
  const staged = stageContext({ closure });
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
    "--build-arg", `VERCEL_VERSION=${npmPins.vercel}`,
    "--build-arg", `SUPABASE_VERSION=${npmPins.supabase}`,
    "--build-arg", `PLAYWRIGHT_VERSION=${npmPins.playwright}`,
    "--build-arg", `AGENT_BROWSER_VERSION=${npmPins["agent-browser"]}`,
    "--build-arg", `OPENCV_VERSION=${versions.python?.["opencv-python-headless"]}`,
    "--build-arg", `FASTER_WHISPER_VERSION=${versions.python?.["faster-whisper"]}`,
    "--build-arg", `WHISPER_MODEL=${versions.whisperModel}`,
    "--build-arg", `IMAGE_SPEC_VERSION=${specVersion}`,
    "--build-arg", `IMAGE_BUILD_DIGEST=${expectedImageBuild(repoRoot).digest}`,
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
