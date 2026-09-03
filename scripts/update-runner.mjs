#!/usr/bin/env node
// Transactional gateway self-updater. Uses Node built-ins only so the already-running updater
// survives candidate `npm ci`, daemon restarts, and a checkout rollback without depending on the
// candidate's node_modules. All shell/UI/MCP/Slack entry points converge here.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  claimUpdate,
  finishUpdate,
  releaseUpdate,
  reserveUpdate,
  updateUpdateState,
} from "../src/gateway/update-state.js";
import { gatewayRoot, whisperModelPath } from "../src/config/paths.js";
import { CONTAINER_DEFAULT_IMAGE, needsImageBuild } from "../src/runtimes/container/image.js";
import { processFailureMessage } from "../src/util/process-outcome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
// Service identities, current first. The pre-rename unit stays in the probe list for one major so
// self-update still finds (and restarts) a machine that has not re-run the installer.
const DEFAULT_SYSTEMD_UNIT = "channelgate.service";
const LEGACY_SYSTEMD_UNIT = "claude-gateway.service";
const GIB = 1024 ** 3;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 3 * 60_000;
// A cold channel-image build compiles nothing but installs a Debian toolchain and five pinned npm
// CLIs; 45 minutes is a runaway backstop, not an expectation.
const IMAGE_BUILD_TIMEOUT_MS = 45 * 60_000;
const MAX_OUTPUT = 2_000_000;
const CONTAINER_CLI_CANDIDATES = Object.freeze(["podman", "docker"]);

export function requiredDiskBytes({ whisperEnabled = false, modelExists = false } = {}) {
  let bytes = GIB; // npm staging, logs, and the local recovery snapshot.
  if (whisperEnabled && !modelExists) bytes += 2 * GIB; // 1.51 GiB model plus its verified temporary download.
  return bytes;
}

export function evaluateAudit(report) {
  const values = report?.metadata?.vulnerabilities;
  if (!values || typeof values !== "object") throw new Error("npm audit output is missing vulnerability metadata");
  const advisories = {
    moderate: Number(values.moderate) || 0,
    high: Number(values.high) || 0,
    critical: Number(values.critical) || 0,
  };
  return { ok: advisories.high === 0 && advisories.critical === 0, advisories };
}

export function readinessFailure(health, {
  previousInstanceId = "",
  expectedRevision = "",
  requireSlack = false,
} = {}) {
  if (!health || health.ok !== true) return "gateway health endpoint is not ready";
  if (!health.instanceId) return "gateway health response has no instance id";
  if (previousInstanceId && health.instanceId === previousInstanceId) return "gateway instance has not restarted";
  if (expectedRevision && health.revision !== expectedRevision) return `gateway is running revision ${health.revision || "(unknown)"} instead of ${expectedRevision}`;
  if (health.claude?.available !== true) return "Claude CLI is unavailable after restart";
  if (requireSlack && health.slack?.connected !== true) return "Slack did not reconnect after restart";
  return "";
}

export function baselineFailure(health, { expectedRevision = "" } = {}) {
  if (!health || health.ok !== true) return "gateway health endpoint is not ready";
  if (!health.instanceId) return "gateway health response has no instance id";
  if (expectedRevision && health.revision !== expectedRevision) {
    return `serving daemon revision ${health.revision || "(unknown)"} does not match checkout ${expectedRevision}`;
  }
  if (health.claude?.available !== true) return "Claude CLI is unavailable before update";
  return "";
}

export function validSystemdPid(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : 0;
}

function safeMessage(error) {
  return String(error?.message || error || "unknown update error").split(/\r?\n/, 1)[0].trim().slice(0, 300);
}

function refusal(message) {
  const error = new Error(message);
  error.code = "EUPDATE_REFUSED";
  return error;
}

function logStep(message) {
  process.stdout.write(`${message}\n`);
}

export async function runCommand(command, args, {
  cwd = REPO_ROOT,
  env = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
  allowFailure = false,
  quiet = false,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      if (allowFailure) return resolve({ code: 127, stdout: "", stderr: safeMessage(error) });
      return reject(new Error(processFailureMessage(`Update command ${command}`, { spawnError: error })));
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_OUTPUT);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      if (allowFailure) resolve({ code: 127, stdout, stderr: append(stderr, safeMessage(error)) });
      else reject(new Error(processFailureMessage(`Update command ${command}`, { spawnError: error })));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error(`${command} timed out`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else if ((code !== 0 || signal) && !allowFailure) {
        const error = new Error(processFailureMessage(`Update command ${command} ${args.join(" ")}`.trim(), {
          code,
          signal,
          diagnostic: stderr || stdout,
          maxDiagnosticChars: 1_000,
        }));
        error.exitCode = code;
        error.signal = signal || null;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function internalAuth(root) {
  const value = readJson(path.join(root, "config", "internal-auth.json"));
  const port = Number(value.port);
  const secret = String(value.secret || "");
  if (!Number.isInteger(port) || port <= 0 || !secret) throw refusal("gateway internal health credentials are unavailable");
  return { port, secret };
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// /api/health only volunteers revision/claude/slack to a caller it can identify, and the detached
// updater has no browser session — so it authenticates the same way smokeAt does, with the
// same-machine internal secret. Without the header the readiness predicates would see a bare
// {ok,instanceId} and could never clear (see baselineFailure/readinessFailure above).
export async function healthAt(auth) {
  return fetchJson(
    `http://127.0.0.1:${auth.port}/api/health`,
    { headers: { "x-cg-secret": auth.secret } },
    10_000,
  );
}

async function smokeAt(root) {
  const auth = internalAuth(root); // refreshed after every restart; the secret rotates per process.
  return fetchJson(
    `http://127.0.0.1:${auth.port}/internal/update-smoke`,
    { method: "POST", headers: { "content-type": "application/json", "x-cg-secret": auth.secret }, body: "{}" },
    100_000,
  );
}

// Which probes to run, and in what order. systemd is the only service manager ChannelGate runs
// under (Linux only), and BOTH scopes count: the documented install (scripts/install-systemd.sh)
// is a hardened system unit, but a plain single-user box commonly runs
// `~/.config/systemd/user/channelgate.service`, which system-scope `systemctl is-active` reports
// as inactive (exit 4) — that box used to be told no service existed at all.
export function serviceProbes() {
  return [
    { kind: "systemd", scope: "system", args: [] },
    { kind: "systemd", scope: "user", args: ["--user"] },
  ];
}

export function noServiceRefusal(platform = process.platform) {
  const managers = serviceProbes().map((probe) => probe.kind);
  const names = [...new Set(managers)].join(" or ");
  return `no active ${names} gateway service was detected on ${platform}`;
}

// The unit names to probe, in order. An explicit override wins outright; otherwise the current
// name is tried before the pre-rename one. CHANNELGATE_SYSTEMD_UNIT is the current env name and
// CLAUDE_GATEWAY_SYSTEMD_UNIT is still honoured.
export function systemdUnitCandidates(env = process.env) {
  const override = env.CHANNELGATE_SYSTEMD_UNIT || env.CLAUDE_GATEWAY_SYSTEMD_UNIT;
  if (override) return [override];
  return [DEFAULT_SYSTEMD_UNIT, LEGACY_SYSTEMD_UNIT];
}

async function detectService(platform = process.platform) {
  for (const probe of serviceProbes()) {
    for (const unit of systemdUnitCandidates()) {
      const result = await runCommand("systemctl", [...probe.args, "is-active", "--quiet", unit], { allowFailure: true, quiet: true, timeoutMs: 10_000 });
      if (result.code === 0) return { kind: "systemd", scope: probe.scope, unit };
    }
  }
  throw refusal(noServiceRefusal(platform));
}

function freeBytes(folder) {
  const stats = statfsSync(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function defaultPreflight({ root, repoRoot }) {
  logStep("→ Preflight: Git, runtime, configuration, service, disk, and Claude smoke…");
  await runCommand("git", ["--version"], { cwd: repoRoot, quiet: true });
  await runCommand("npm", ["--version"], { cwd: repoRoot, quiet: true });
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
    throw refusal(`Node.js >=22.13 is required (found ${process.version})`); // matches package.json engines.node / src/start.js
  }
  if (!existsSync(path.join(repoRoot, "package-lock.json"))) throw refusal("package-lock.json is required for an exact update");

  const branch = (await runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoRoot, quiet: true })).stdout.trim();
  if (!branch) throw refusal("the gateway checkout is detached; attach it to its deployment branch before updating");
  const dirty = (await runCommand("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, quiet: true })).stdout.trim();
  if (dirty) throw refusal("tracked worktree is dirty; commit or revert tracked changes before updating");
  const upstream = (await runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repoRoot, quiet: true })).stdout.trim();
  if (!upstream) throw refusal(`branch ${branch} has no upstream`);
  const remote = upstream.includes("/") ? upstream.split("/", 1)[0] : "origin";
  await runCommand("git", ["fetch", "--quiet", remote], { cwd: repoRoot, quiet: true, timeoutMs: 60_000 });
  const oldRevision = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot, quiet: true })).stdout.trim();
  const targetRevision = (await runCommand("git", ["rev-parse", upstream], { cwd: repoRoot, quiet: true })).stdout.trim();
  const ancestor = await runCommand("git", ["merge-base", "--is-ancestor", oldRevision, targetRevision], { cwd: repoRoot, allowFailure: true, quiet: true });
  if (ancestor.code !== 0) throw refusal(`local ${branch} has diverged from ${upstream}; automatic fast-forward is unsafe`);
  const targetLock = await runCommand("git", ["cat-file", "-e", `${targetRevision}:package-lock.json`], { cwd: repoRoot, allowFailure: true, quiet: true });
  if (targetLock.code !== 0) throw refusal("candidate revision has no package-lock.json");

  const settingsFile = path.join(root, "config", "settings.json");
  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = readJson(settingsFile);
    } catch {
      throw refusal("gateway settings.json is not valid JSON");
    }
  }
  const service = await detectService();
  const auth = internalAuth(root);
  const baselineHealth = await healthAt(auth).catch((error) => {
    throw refusal(`gateway health preflight failed: ${safeMessage(error)}`);
  });
  const baselineProblem = baselineFailure(baselineHealth, { expectedRevision: oldRevision });
  if (baselineProblem) throw refusal(baselineProblem);
  const whisperDownloadRequired = settings.whisperEnabled !== false && !existsSync(whisperModelPath());
  const needBytes = requiredDiskBytes({
    whisperEnabled: settings.whisperEnabled !== false,
    modelExists: !whisperDownloadRequired,
  });
  const availableBytes = freeBytes(repoRoot);
  if (availableBytes < needBytes) {
    throw refusal(`insufficient disk space: need ${(needBytes / GIB).toFixed(1)} GiB, have ${(availableBytes / GIB).toFixed(1)} GiB`);
  }
  const smoke = await smokeAt(root).catch((error) => ({ ok: false, error: safeMessage(error) }));
  if (!smoke.ok) throw refusal(`pre-update Claude smoke failed: ${smoke.error || "unknown error"}`);

  return {
    branch,
    upstream,
    oldRevision,
    targetRevision,
    previousInstanceId: baselineHealth.instanceId || "",
    requireSlack: baselineHealth.slack?.connected === true,
    baselineHealth,
    service,
    needBytes,
    availableBytes,
    optionalDownloadBytes: whisperDownloadRequired ? Math.ceil(1.51 * GIB) : 0,
  };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function defaultSnapshot({ root, repoRoot, context, owner }) {
  const backup = path.join(root, "update-backups", owner.transactionId);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  chmodSync(backup, 0o700);
  const manifest = {
    transactionId: owner.transactionId,
    createdAt: new Date().toISOString(),
    oldRevision: context.oldRevision,
    targetRevision: context.targetRevision,
    note: "Operator recovery snapshot. Transactional Git rollback does not auto-restore runtime data.",
  };
  writeFileSync(path.join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  copyFileSync(path.join(repoRoot, "package-lock.json"), path.join(backup, "package-lock.json"));
  chmodSync(path.join(backup, "package-lock.json"), 0o600);
  const envFile = path.join(repoRoot, ".env");
  if (existsSync(envFile)) {
    copyFileSync(envFile, path.join(backup, ".env"));
    chmodSync(path.join(backup, ".env"), 0o600);
  }
  const config = path.join(root, "config");
  if (existsSync(config)) cpSync(config, path.join(backup, "config"), { recursive: true, preserveTimestamps: true });
  const dbFile = process.env.CHANNELGATE_DB || process.env.CLAUDE_GATEWAY_DB || path.join(root, "gateway.db");
  if (existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`VACUUM INTO ${sqlString(path.join(backup, "gateway.db"))}`);
      chmodSync(path.join(backup, "gateway.db"), 0o600);
    } finally {
      db.close();
    }
  }
  return backup;
}

// The rename migration edits the installed service definition (its log paths name the runtime
// root), but it runs INSIDE the service and cannot tear that service down, so it leaves a marker.
// systemd caches the definition: it needs `daemon-reload` before the next start reads the new
// paths. Consuming the marker here is what makes `update_gateway` / `restart_gateway` after a
// migration come back on the definition that is actually on disk.
export function serviceReloadMarkerFile(root) {
  return path.join(root, "service-reload-required.json");
}

export async function applyPendingServiceReload({ root, service, run = runCommand, log = logStep } = {}) {
  const marker = serviceReloadMarkerFile(root);
  if (!existsSync(marker)) return { reloaded: false };
  let pending;
  try {
    pending = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    rmSync(marker, { force: true });
    return { reloaded: false };
  }
  log(`→ Service definition changed by the ChannelGate migration (${(pending.files || []).join(", ")}) — reloading before restart…`);
  if (service?.kind === "systemd") {
    // daemon-reload alone: the restart signal that follows is what re-execs onto the new unit.
    const scope = service.scope === "user" ? ["--user"] : [];
    await run("systemctl", [...scope, "daemon-reload"], { allowFailure: true, quiet: true, timeoutMs: 30_000 });
  }
  rmSync(marker, { force: true });
  return { reloaded: true };
}

// ── Channel image ─────────────────────────────────────────────────────────────────────────────
// A container channel runs the image, not the checkout, so an update that pulls a new
// `containers/` or bumps the image spec leaves every container channel on yesterday's toolchain
// until an operator happens to read the boot warning and runs `npm run build:image`. This makes
// that part of the update — and, because a build failure must never strand the DAEMON on an old
// revision, it is the one step in the transaction that reports and continues.

// The container-runtime settings the update needs, read straight from the JSON the daemon manages.
// Not through src/config/settings.js: that pulls in the database layer, and the updater must stay
// on built-ins (it has to survive the candidate's `npm ci`).
export function containerSettings(root) {
  let settings = {};
  try {
    settings = readJson(path.join(root, "config", "settings.json"));
  } catch {
    settings = {}; // no settings file, or unreadable — treat the runtime as off (preflight already refused a malformed one)
  }
  const image = typeof settings.containerImage === "string" && settings.containerImage.trim() ? settings.containerImage.trim() : CONTAINER_DEFAULT_IMAGE;
  const cli = settings.containerCli === "podman" || settings.containerCli === "docker" ? settings.containerCli : "auto";
  return { enabled: settings.containerRuntimeEnabled === true, image, cli };
}

// The spec version of the image the daemon would actually run, from the image's own
// `cg.image.version` label (src/runtimes/container/image.js). "" means no image, no readable label,
// or no usable CLI — all of which needsImageBuild() treats as "build it".
export async function builtImageSpecVersion({ cli = "auto", image = "", run = runCommand } = {}) {
  if (!image) return "";
  const candidates = cli === "auto" ? CONTAINER_CLI_CANDIDATES : [cli];
  for (const bin of candidates) {
    const result = await run(bin, ["image", "inspect", "--format", '{{index .Config.Labels "cg.image.version"}}', image], {
      allowFailure: true,
      quiet: true,
      timeoutMs: 30_000,
    });
    if (result.code !== 0) continue; // missing binary, unreachable socket, or no such image
    const version = String(result.stdout || "").trim();
    return version === "<no value>" ? "" : version;
  }
  return "";
}

// The spec version the CANDIDATE expects, read from disk rather than from the IMAGE_SPEC_VERSION
// this process imported at start: the runner is launched by the OLD checkout and its imports were
// resolved before `git merge --ff-only` moved the tree, so the in-memory constant is the old value.
// containers/versions.json is what the build itself reads, and a test pins the two together.
export function expectedImageSpecVersion(repoRoot) {
  try {
    return String(readJson(path.join(repoRoot, "containers", "versions.json")).imageSpecVersion || "").trim();
  } catch {
    return "";
  }
}

export async function defaultImageBuild({
  root = gatewayRoot(),
  repoRoot = REPO_ROOT,
  context = {},
  owner = null,
  run = runCommand,
  log = logStep,
} = {}) {
  const settings = containerSettings(root);
  if (!settings.enabled) return { built: false, needed: false, reason: "the container runtime is off" };

  const changedPaths = (await run("git", ["diff", "--name-only", `${context.oldRevision}..${context.targetRevision}`], {
    cwd: repoRoot,
    allowFailure: true,
    quiet: true,
    timeoutMs: 60_000,
  })).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const builtSpecVersion = await builtImageSpecVersion({ cli: settings.cli, image: settings.image, run });
  const expectedSpecVersion = expectedImageSpecVersion(repoRoot);
  if (!needsImageBuild({ containerRuntimeEnabled: true, changedPaths, builtSpecVersion, expectedSpecVersion })) {
    log(`→ Channel image ${settings.image} is current (spec ${builtSpecVersion || "unknown"}) — no rebuild needed.`);
    return { built: false, needed: false, reason: "the built image already matches this revision" };
  }

  // Only now does the phase change: an update that skips the build must not tell the dashboard it
  // is building one.
  if (owner) updateUpdateState({ root, owner, patch: { phase: "image" } });
  log(`→ Rebuilding the channel image ${settings.image} (spec ${builtSpecVersion || "none built"} → ${expectedSpecVersion || "unknown"}). This takes several minutes; the restart waits for it…`);
  try {
    await run(process.execPath, [path.join(repoRoot, "scripts", "build-image.mjs")], { cwd: repoRoot, timeoutMs: IMAGE_BUILD_TIMEOUT_MS });
  } catch (error) {
    // Never blocking. The previously built image still runs every container channel, so the worst
    // case is the toolchain an operator was going to get late — far better than a daemon left on
    // the old revision because a container build failed.
    const reason = safeMessage(error);
    log(`⚠ channel image build failed — run \`npm run build:image\` (${reason}). Continuing with the update; container channels keep running the image they have.`);
    return { built: false, needed: true, failed: true, reason };
  }
  const imageId = (await run(
    settings.cli === "auto" ? CONTAINER_CLI_CANDIDATES[0] : settings.cli,
    ["image", "inspect", "--format", "{{.Id}}", settings.image],
    { allowFailure: true, quiet: true, timeoutMs: 30_000 },
  )).stdout.trim();
  log(`→ Channel image rebuilt: ${settings.image}${imageId ? ` → ${imageId}` : ""}. Each channel picks it up on its next turn.`);
  return { built: true, needed: true, imageId };
}

async function defaultRestart({ service, root = gatewayRoot() }) {
  // Never restart onto a stale cached definition.
  await applyPendingServiceReload({ root, service });
  if (service.kind === "systemd") {
    // Ask the SAME scope detectService found the unit in — a user unit is invisible to system-scope
    // `systemctl show`, which answers MainPID=0 and would fail the restart on a healthy box.
    const scope = service.scope === "user" ? ["--user"] : [];
    const result = await runCommand("systemctl", [...scope, "show", "--property", "MainPID", "--value", service.unit], { quiet: true, timeoutMs: 10_000 });
    const pid = validSystemdPid(result.stdout);
    if (!pid) throw new Error(`could not resolve a safe MainPID for ${service.unit}`);
    logStep(`→ Restarting systemd service ${service.unit} (${service.scope || "system"} scope, pid ${pid})…`);
    process.kill(pid, "SIGUSR2");
    return;
  }
  throw new Error(`unsupported service manager: ${service.kind || "unknown"}`);
}

async function defaultVerify({ root, context, expectedRevision }) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastReason = "gateway did not answer";
  while (Date.now() < deadline) {
    try {
      const auth = internalAuth(root);
      const health = await healthAt(auth);
      lastReason = readinessFailure(health, {
        previousInstanceId: context.previousInstanceId,
        expectedRevision,
        requireSlack: context.requireSlack,
      });
      if (!lastReason) {
        const smoke = await smokeAt(root).catch((error) => ({ ok: false, error: safeMessage(error) }));
        if (!smoke.ok) throw new Error(`post-restart Claude smoke failed: ${smoke.error || "unknown error"}`);
        return health;
      }
    } catch (error) {
      lastReason = safeMessage(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`replacement readiness timed out: ${lastReason}`);
}

function defaultOps({ root, repoRoot }) {
  return {
    claim: async ({ owner }) => {
      if (!claimUpdate({ root, owner, pid: process.pid })) throw new Error("could not claim reserved update transaction");
    },
    preflight: () => defaultPreflight({ root, repoRoot }),
    snapshot: ({ context, owner }) => defaultSnapshot({ root, repoRoot, context, owner }),
    checkout: ({ context }) => runCommand("git", ["merge", "--ff-only", context.targetRevision], { cwd: repoRoot, quiet: true, timeoutMs: 60_000 }),
    install: () => runCommand("npm", ["ci"], { cwd: repoRoot }),
    audit: async () => {
      const result = await runCommand("npm", ["audit", "--omit=dev", "--json"], { cwd: repoRoot, allowFailure: true, quiet: true, timeoutMs: 120_000 });
      const evaluated = evaluateAudit(JSON.parse(result.stdout || "{}"));
      if (!evaluated.ok) throw new Error(`npm audit blocks candidate: ${evaluated.advisories.high} high, ${evaluated.advisories.critical} critical`);
      return evaluated.advisories;
    },
    test: async () => {
      // The same verification set CI runs, not just the unit suite: static analysis catches a
      // candidate whose tests pass but whose source violates the repo's structural invariants.
      await runCommand("npm", ["run", "check:static"], { cwd: repoRoot });
      await runCommand("npm", ["test"], { cwd: repoRoot });
    },
    provision: () => runCommand("bash", [path.join(repoRoot, "scripts", "update-provision.sh")], { cwd: repoRoot, timeoutMs: 90 * 60_000 }),
    image: ({ context, owner }) => defaultImageBuild({ root, repoRoot, context, owner }),
    restart: ({ context }) => defaultRestart({ service: context.service, root }),
    verify: ({ context, expectedRevision }) => defaultVerify({ root, context, expectedRevision }),
    restore: ({ context }) => runCommand("git", ["reset", "--hard", context.oldRevision], { cwd: repoRoot, quiet: true, timeoutMs: 60_000 }),
  };
}

function phase(root, owner, name, patch = {}) {
  logStep(`→ ${name.replaceAll("_", " ")}…`);
  return updateUpdateState({ root, owner, patch: { phase: name, ...patch } });
}

export async function executeUpdateTransaction({
  root = gatewayRoot(),
  repoRoot = REPO_ROOT,
  owner,
  ops = defaultOps({ root, repoRoot }),
} = {}) {
  if (!owner?.transactionId || !owner?.token) throw new Error("update owner is required");
  let context = null;
  let changed = false;
  let candidateError = "";
  try {
    await ops.claim?.({ owner });
    phase(root, owner, "preflight");
    context = await ops.preflight({ owner });
    updateUpdateState({
      root,
      owner,
      patch: {
        phase: "preflight",
        oldRevision: context.oldRevision,
        targetRevision: context.targetRevision,
        runningRevision: context.oldRevision,
        requiredDiskBytes: Number(context.needBytes) || 0,
        availableDiskBytes: Number(context.availableBytes) || 0,
        optionalDownloadBytes: Number(context.optionalDownloadBytes) || 0,
      },
    });
    if (context.oldRevision === context.targetRevision) {
      return finishUpdate({
        root,
        owner,
        result: "updated",
        patch: { phase: "complete", changed: false, runningRevision: context.oldRevision, reason: "Already up to date." },
      });
    }

    phase(root, owner, "snapshotting");
    const backupPath = await ops.snapshot({ context, owner });
    phase(root, owner, "checkout", { backupPath: backupPath || "" });
    await ops.checkout({ context, owner });
    changed = true;
    updateUpdateState({ root, owner, patch: { phase: "installing", changed: true } });
    await ops.install({ context, owner, rollback: false });
    phase(root, owner, "auditing");
    const audit = await ops.audit({ context, owner });
    const advisories = audit?.advisories || audit || { moderate: 0, high: 0, critical: 0 };
    if ((Number(advisories.high) || 0) > 0 || (Number(advisories.critical) || 0) > 0) {
      throw new Error(`npm audit blocks candidate: ${advisories.high || 0} high, ${advisories.critical || 0} critical`);
    }
    updateUpdateState({ root, owner, patch: { phase: "testing", advisories } });
    await ops.test({ context, owner });
    phase(root, owner, "provisioning");
    await ops.provision({ context, owner });
    // The channel image, after dependencies and BEFORE the restart, so a container channel's next
    // turn already runs this revision's toolchain. Optional and non-blocking on purpose: a build
    // that fails must not leave the daemon on the old revision — the previously built image still
    // runs every container channel, and the operator is told exactly which command to re-run. The
    // step reports its own phase only when it actually builds.
    try {
      await ops.image?.({ context, owner });
    } catch (error) {
      logStep(`⚠ channel image build failed — run \`npm run build:image\` (${safeMessage(error)}). Continuing with the update.`);
    }
    phase(root, owner, "restarting");
    await ops.restart({ context, owner });
    phase(root, owner, "verifying");
    const health = await ops.verify({ context, owner, expectedRevision: context.targetRevision });
    return finishUpdate({
      root,
      owner,
      result: "updated",
      patch: {
        phase: "complete",
        changed: true,
        runningRevision: health?.revision || context.targetRevision,
        reason: "Candidate passed daemon, Slack, and Claude smoke checks.",
      },
    });
  } catch (error) {
    candidateError = safeMessage(error);
    if (!changed) {
      return finishUpdate({
        root,
        owner,
        result: error?.code === "EUPDATE_REFUSED" ? "refused" : "failed",
        patch: { phase: error?.code === "EUPDATE_REFUSED" ? "refused" : "failed", reason: candidateError, candidateError },
      });
    }
    try {
      phase(root, owner, "rolling_back", { candidateError, reason: "Candidate failed; restoring previous revision." });
      await ops.restore({ context, owner });
      await ops.install({ context, owner, rollback: true });
      await ops.restart({ context, owner, rollback: true });
      const health = await ops.verify({ context, owner, expectedRevision: context.oldRevision, rollback: true });
      return finishUpdate({
        root,
        owner,
        result: "rolled_back",
        patch: {
          phase: "complete",
          changed: true,
          runningRevision: health?.revision || context.oldRevision,
          reason: "Candidate failed and the previous revision was restored.",
          candidateError,
        },
      });
    } catch (rollbackError) {
      return finishUpdate({
        root,
        owner,
        result: "failed",
        patch: {
          phase: "failed",
          changed: true,
          runningRevision: "",
          reason: "Candidate and automatic rollback both failed.",
          candidateError,
          rollbackError: safeMessage(rollbackError),
        },
      });
    }
  } finally {
    releaseUpdate({ root, owner });
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

async function main() {
  const root = gatewayRoot();
  const transactionId = argValue("--transaction");
  let owner;
  if (transactionId) {
    const token = String(process.env.CG_UPDATE_OWNER_TOKEN || "");
    if (!token) throw new Error("reserved update transaction is missing its owner token");
    owner = { transactionId, token };
  } else {
    const reserved = reserveUpdate({ root, source: "cli" });
    if (!reserved.ok) {
      logStep(`Update already running: ${reserved.transaction?.id || "unknown transaction"}`);
      process.exitCode = 2;
      return;
    }
    owner = reserved.owner;
  }
  const result = await executeUpdateTransaction({ root, owner });
  logStep(`→ Update result: ${result.result}${result.reason ? ` — ${result.reason}` : ""}`);
  if (result.result !== "updated") process.exitCode = 2;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(`❌ Update runner failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
