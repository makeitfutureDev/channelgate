// The container state machine: create, reuse, restart, recreate, destroy — plus the boot
// reconcile. One channel, one container, one in-process mutex keyed by its name, because two turns
// in the same channel (a foreground reply and a scheduled run) race here by design.
//
// Reuse is decided by a FINGERPRINT of the create-time-immutable configuration (§7), carried in
// the `cg.fingerprint` label. Everything per-exec — env, channel secrets, prompt, mode, model — is
// deliberately NOT in it: rotating a channel secret retires the warm engine process through the
// pool's own fingerprint, and must not tear down a container that background jobs are using.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireKeyedLock } from "../../util/keyed-lock.js";
import { channelArtifactDir } from "../../config/paths.js";
import { containerLabels, installFilterArgs, isOurContainer, labelArgs, LABEL_CHANNEL, LABEL_FINGERPRINT, LABEL_IMAGE, LABEL_INSTALL, LABEL_MOUNTS, LABEL_PLATFORM } from "./names.js";
import { CODEX_CONTAINER_AUTH_FILE, containerEnvDefaults, settleCredentialModes } from "./credentials.js";
import { CONTAINER_SOCKET_DIR } from "./image-paths.js";

// Hardening flags adopted near-verbatim from the Hermes review (plan §10). They are part of the
// fingerprint, so changing any of them recreates every container on the next run.
//
// `/run` is the ONLY tmpfs left. It holds the run helpers' pid files and the read-only socket
// mount, both of which must be empty at every start, and it is the one place that must not be
// executable. `/tmp` and `/var/tmp` used to be tmpfs too — and that made the idle reaper's
// ten-minute `stop` DELETE whatever an agent had parked there, a regression against the host
// backend where /tmp survives between turns (Claude Code keeps its per-session scratchpad under
// /tmp/claude-<uid>/…). They are persistent bind mounts now; see PERSISTENT_TMP_DIRS.
export const TMPFS_SPECS = Object.freeze(["/run:rw,noexec,size=64m"]);

// The two temp trees a channel keeps ACROSS stops, starts and recreates: host directories under
// the channel's own artifact dir (~/ChannelGate/.runtime/<platform>/<slug>/), bind-mounted in.
//
// Under the artifact dir on purpose: it is per channel, it is never mounted into any OTHER
// container, the daemon never deletes it, and it is visible on the host — an operator can see what
// an agent parked in /tmp instead of guessing. The trade is that the tmpfs size cap is gone: these
// grow against the disk, exactly like the channel's work directory.
//
// `<artifactDir>/tmp` is also where an isolated Codex run puts its per-run scratch (see
// src/engines/codex.js) — the same directory, seen at two paths inside the container. That is not
// a new exposure: the whole artifact dir has always been mounted rw at its identical path.
export const PERSISTENT_TMP_DIRS = Object.freeze([
  Object.freeze({ kind: "tmp", dir: "tmp", target: "/tmp" }),
  Object.freeze({ kind: "var-tmp", dir: "var-tmp", target: "/var/tmp" }),
]);
export const CAP_DROP = Object.freeze(["ALL"]);
export const CAP_ADD = Object.freeze(["DAC_OVERRIDE", "CHOWN", "FOWNER"]);
export const SECURITY_OPTS = Object.freeze(["no-new-privileges"]);
export const CONTAINER_COMMAND = Object.freeze(["cg-init", "sleep", "infinity"]);
export const SOCKET_MOUNT_TARGET = CONTAINER_SOCKET_DIR;

// Full-access channels (adminMode) can be given the gateway user's WHOLE home directory
// (Settings → Container runtime → "Full-access channels see the gateway home"): every agent's work
// folder and memory, every repo, the gateway root with its logs and metadata — read-write, at the
// identical path. That is the operator's explicit choice to trust those channels with everything
// the daemon account can reach, credential stores included. The one thing masked out is the
// container engine's own storage: a write into the overlay layers of a running container corrupts
// it, and nothing an agent needs lives there. Relative to the home directory.
export const OPERATOR_HOME_MASKS = Object.freeze([path.join(".local", "share", "containers")]);
// The tmpfs options a mask is created with (see mountArgs for why `notmpcopyup`).
export const MASK_TMPFS_OPTIONS = "rw,noexec,nosuid,size=1m,notmpcopyup";

const GONE_PATTERN = /no such container|no container with name|is not running|only create exec sessions on running containers|container state improper|removing container/i;

export function isContainerGoneError(text) {
  return GONE_PATTERN.test(String(text || ""));
}

// Both CLIs lay named volumes out as <volume root>/<name>/_data (verified on podman 5.7 rootless
// and matching docker's <DockerRootDir>/volumes layout). Empty until the CLI has been probed.
export function volumeHostPath(caps, volumeName) {
  if (!caps?.volumeRoot || !volumeName) return "";
  return `${caps.volumeRoot}/${volumeName}/_data`;
}

function statusOf(raw) {
  const status = String(raw || "").trim().toLowerCase();
  // podman reports "configured" for a container that has never started; docker reports "created".
  if (status === "configured") return "created";
  return status;
}

// podman prints a Go time.Time ("2026-09-02 01:51:32.139 +0300 EEST"), docker prints RFC3339.
// Neither is worth a dependency: try as-is, then a normalized form, else keep the raw string.
export function parseStartedAt(raw) {
  const text = String(raw || "").trim();
  if (!text || text.startsWith("0001-01-01")) return "";
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const normalized = text.replace(/\.(\d{3})\d+/, ".$1").replace(/\s+[A-Z]{2,5}$/, "").replace(" ", "T").replace(/\s+/, "");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

const INSPECT_FIELDS = [
  "{{.Name}}", "{{.State.Status}}", "{{.State.StartedAt}}", "{{.Image}}",
  `{{index .Config.Labels "${LABEL_FINGERPRINT}"}}`,
  `{{index .Config.Labels "${LABEL_INSTALL}"}}`,
  `{{index .Config.Labels "${LABEL_IMAGE}"}}`,
  `{{index .Config.Labels "${LABEL_CHANNEL}"}}`,
  `{{index .Config.Labels "${LABEL_PLATFORM}"}}`,
  `{{index .Config.Labels "${LABEL_MOUNTS}"}}`,
];
export const INSPECT_FORMAT = INSPECT_FIELDS.join("|");

function field(value) {
  const text = String(value ?? "").trim();
  return text === "<no value>" ? "" : text;
}

// Tolerant of a 9-field line on purpose: `cg.mounts` was added after containers were already in
// service, and a container created before it reports nothing for that field. An empty mount
// fingerprint means "unknown", which ensureUp treats as mount-affecting rather than benign.
export function parseInspectLine(line) {
  const parts = String(line || "").split("|");
  if (parts.length < 9) return null;
  return {
    exists: true,
    name: field(parts[0]).replace(/^\//, ""),
    status: statusOf(parts[1]),
    startedAt: parseStartedAt(parts[2]),
    imageId: field(parts[3]),
    fingerprint: field(parts[4]),
    mountFingerprint: field(parts[9]),
    labels: {
      [LABEL_INSTALL]: field(parts[5]),
      [LABEL_IMAGE]: field(parts[6]),
      [LABEL_CHANNEL]: field(parts[7]),
      [LABEL_PLATFORM]: field(parts[8]),
      [LABEL_FINGERPRINT]: field(parts[4]),
      [LABEL_MOUNTS]: field(parts[9]),
    },
  };
}

// ── Mounts ────────────────────────────────────────────────────────────────────────────────────
// Identical absolute paths on both sides are LOAD-BEARING: session transcripts, /resume, git
// worktrees and every absolute path the model prints have to stay valid in the daemon too.
//
// What is never mounted: the gateway root, config/, gateway.db, the per-channel metadata folder,
// the daemon checkout, and the operator's ~/.claude or ~/.codex directories. The only sources under
// the gateway root are the clean workspace (a bare workdir, mounted so clean mode works in a
// container) and the MCP socket directory (read-only). The Codex auth FILE is the one credential
// mount, and it is the resolved real file — see credentials.js for why it is a file and not a dir.
// The single, deliberate exception is the operator-home grant (operatorHomeMounts below): a
// Full-access channel, while the gateway-wide switch is on, gets the daemon user's whole home.
//
// `/tmp` and `/var/tmp` are mounts rather than tmpfs so a stop cannot empty them
// (PERSISTENT_TMP_DIRS). Together with the HOME volume that means NOTHING a channel accumulates —
// logins, installed CLIs, caches, scratch files — is lost to a stop, a restart or a recreate.
// Container processes can replace children of a mounted artifact tree. A symlink there must
// never be resolved by Podman as a new host mount. Reject every symlink component, including
// ancestors, and fail closed instead of logging and letting the CLI create/follow it itself.
export function assertSafeBindSource(source) {
  const absolute = path.resolve(source);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe container bind source: ${current} must be a real directory`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export function buildMounts(base) {
  const mounts = [
    { kind: "workdir", type: "bind", source: base.workDir, target: base.workDir, mode: "rw" },
    { kind: "clean", type: "bind", source: base.cleanWorkDir, target: base.cleanWorkDir, mode: "rw" },
    { kind: "artifacts", type: "bind", source: base.artifactDir, target: base.artifactDir, mode: "rw" },
    // Persistent /tmp and /var/tmp. Nothing an agent leaves in them is lost to a stop or a
    // recreate, which is the difference between a container channel and the host backend.
    ...PERSISTENT_TMP_DIRS.map(({ kind, dir, target }) => ({
      kind,
      type: "bind",
      source: base.artifactDir ? path.join(base.artifactDir, dir) : "",
      target,
      mode: "rw",
    })),
    { kind: "home", type: "volume", source: base.container?.homeVolume || "", target: "/home/agent", mode: "rw" },
    { kind: "socket", type: "bind", source: base.socketDir, target: SOCKET_MOUNT_TARGET, mode: "ro" },
    { kind: "codex-auth", type: "bind-file", source: base.codexAuthFile || "", target: CODEX_CONTAINER_AUTH_FILE, mode: "rw", resolved: false },
    ...operatorHomeMounts(base),
  ];
  return mounts.filter((mount) => mount.type === "tmpfs" || mount.source);
}

// The operator-home grant: ONLY for a channel in Full access (adminMode) and ONLY while the
// gateway-wide switch is on. It is a create-time input like every other mount, so flipping either
// side recreates the container at the channel's next turn (the HOME volume survives). The mount is
// per CHANNEL, not per author — a container is shared by every turn of its channel — so every
// author the channel admits can READ the home through the engine's file tools; only an admin
// author's live turn gets the write-capable bypass tools on top.
export function operatorHomeGranted(base) {
  return Boolean(base?.meta?.adminMode) && base?.settings?.fullAccessHome === true;
}

export function operatorHomeDir() {
  return os.homedir();
}

export function operatorHomeMounts(base) {
  if (!operatorHomeGranted(base)) return [];
  const home = operatorHomeDir();
  return [
    { kind: "operator-home", type: "bind", source: home, target: home, mode: "rw" },
    // Masks apply deepest-last, so they sit on top of the home bind inside the container.
    ...OPERATOR_HOME_MASKS.map((rel) => ({ kind: "mask", type: "tmpfs", source: "", target: path.join(home, rel), mode: "rw" })),
  ];
}

function mountArgs(mounts) {
  const args = [];
  for (const mount of mounts) {
    // Destinations are applied deepest-last by both CLIs, so the Codex auth file lands inside the
    // HOME volume correctly (verified on podman 5.7 rootless) — and a tmpfs mask lands on top of
    // the operator-home bind it hides a subtree of.
    if (mount.type === "tmpfs") {
      // `notmpcopyup` is load-bearing: podman's --tmpfs default copies the destination's existing
      // contents INTO the tmpfs, and the destination here is the multi-gigabyte container store —
      // the create fails with "no space left on device" before the mask is ever applied (proven
      // live on podman 5.7). The mask must be empty; nothing is copied.
      args.push("--tmpfs", `${mount.target}:${MASK_TMPFS_OPTIONS}`);
      continue;
    }
    args.push("-v", `${mount.source}:${mount.target}${mount.mode === "ro" ? ":ro" : ""}`);
  }
  return args;
}

// ── Fingerprint ───────────────────────────────────────────────────────────────────────────────
// The create-time inputs that decide WHAT THE CONTAINER CAN SEE, hashed on their own.
//
// A stale full fingerprint is not one thing. "The image was rebuilt" is a container that still sees
// exactly the right directories — it can finish the jobs inside it and be replaced when it next
// goes idle. "The workspace moved" is a container bound to paths that may not exist any more: a
// channel whose `workDir` was pointed at a subfolder and then back again kept a warm container
// whose workspace bind still named the (by then deleted) subfolder, and three turns exec'd into it
// died on `Append system prompt file not found: …/CLAUDE.md`. So the mount half is compared
// separately and never deferred — see ensureUp.
//
// Deliberately NOT in here: the image, the network mode, cgroup limits, caps and the security opts.
// They change how the container BEHAVES, not which host directories it is looking at, and the
// existing deferral is the right answer for them.
export function containerMountFingerprint(target) {
  const c = target?.container || {};
  const canonical = JSON.stringify({
    v: 1,
    workDir: target?.workDir || "",
    cleanWorkDir: target?.cleanWorkDir || "",
    artifactDir: target?.artifactDir || "",
    homeVolume: c.homeVolume || "",
    mounts: (c.mounts || []).map((m) => `${m.kind}:${m.type}:${m.source}:${m.target}:${m.mode}`).sort(),
  });
  return `m1-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function containerFingerprint(target) {
  const c = target?.container || {};
  const canonical = JSON.stringify({
    v: 1,
    imageId: c.imageId || "",
    imageRef: c.image || "",
    imageVersion: c.imageVersion || "",
    workDir: target?.workDir || "",
    cleanWorkDir: target?.cleanWorkDir || "",
    artifactDir: target?.artifactDir || "",
    homeVolume: c.homeVolume || "",
    uidStrategy: c.uidStrategy || "",
    uid: c.uid ?? null,
    gid: c.gid ?? null,
    network: c.network || "",
    tmpfs: [...TMPFS_SPECS],
    capDrop: [...CAP_DROP],
    capAdd: [...CAP_ADD],
    securityOpts: [...SECURITY_OPTS],
    limits: c.appliedLimits || null,
    credentialMode: c.credentialMode || {},
    mounts: (c.mounts || []).map((m) => `${m.kind}:${m.type}:${m.source}:${m.target}:${m.mode}`).sort(),
    packages: [], // reserved: the declared-packages list (P3)
  });
  return `c1-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

// ── Create argv ───────────────────────────────────────────────────────────────────────────────
export function buildCreateArgs(target, caps, { fingerprint = "", mountFingerprint = containerMountFingerprint(target), created = new Date().toISOString() } = {}) {
  const c = target.container;
  const args = ["run", "-d", "--name", c.name];
  args.push(...labelArgs(containerLabels(target, { fingerprint, mountFingerprint, image: c.image, created })));
  if (caps.uidStrategy === "keep-id") args.push("--userns=keep-id");
  else if (c.uid != null && c.gid != null) args.push("--user", `${c.uid}:${c.gid}`);
  if (caps.supportsInit) args.push("--init");
  args.push(...mountArgs(c.mounts));
  for (const spec of TMPFS_SPECS) args.push("--tmpfs", spec);
  for (const cap of CAP_DROP) args.push("--cap-drop", cap);
  for (const cap of CAP_ADD) args.push("--cap-add", cap);
  for (const opt of SECURITY_OPTS) args.push("--security-opt", opt);
  const limits = c.appliedLimits;
  if (limits?.pidsLimit) args.push("--pids-limit", String(limits.pidsLimit));
  if (limits?.memory) args.push("--memory", limits.memory);
  if (limits?.cpus) args.push("--cpus", limits.cpus);
  args.push("--network", c.network);
  args.push("-w", target.workDir);
  const env = { ...containerEnvDefaults(target), CG_ARTIFACT_DIR: target.artifactDir || "" };
  for (const [key, value] of Object.entries(env)) {
    if (value === "" || value == null) continue;
    args.push("-e", `${key}=${value}`);
  }
  args.push(c.image, ...CONTAINER_COMMAND);
  return args;
}

// ── The lifecycle object ──────────────────────────────────────────────────────────────────────
// How long a turn will wait for the runs already inside a container to finish when the container
// has to be REBUILT before it can be used (its mounts changed). Bounded on purpose: past the bound
// the turn fails with the reason instead of waiting silently or, worse, running against the wrong
// directories.
export const DEFAULT_RECREATE_WAIT_MS = 60_000;
export const DEFAULT_RECREATE_POLL_MS = 1_000;

export function createContainerLifecycle({
  cli, image, reaper, log = () => {}, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  recreateWaitMs = DEFAULT_RECREATE_WAIT_MS,
  recreatePollMs = DEFAULT_RECREATE_POLL_MS,
} = {}) {
  async function inspectByRef(caps, ref) {
    const result = await cli.runWith(caps, ["inspect", "--type", "container", "--format", INSPECT_FORMAT, ref], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      if (isContainerGoneError(result.stderr)) return { exists: false, status: "missing" };
      throw new Error(`could not inspect container ${ref}: ${String(result.stderr || "").trim() || `exit ${result.code}`}`);
    }
    const line = String(result.stdout || "").trim().split("\n").filter(Boolean)[0];
    const parsed = line ? parseInspectLine(line) : null;
    return parsed || { exists: false, status: "missing" };
  }

  // Every container this INSTALL owns, running or not. Discovery is by label, never by a stored id.
  async function listOurContainers(caps) {
    const listed = await cli.runWith(caps, ["ps", "-a", ...installFilterArgs(), "-q"], { timeoutMs: 30_000 });
    if (listed.code !== 0) throw new Error(`could not list containers: ${String(listed.stderr || "").trim()}`);
    const ids = String(listed.stdout || "").trim().split("\n").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return [];
    const inspected = await cli.runWith(caps, ["inspect", "--type", "container", "--format", INSPECT_FORMAT, ...ids], { timeoutMs: 60_000 });
    return String(inspected.stdout || "")
      .split("\n")
      .map((line) => parseInspectLine(line.trim()))
      .filter((entry) => entry && isOurContainer(entry.labels));
  }

  // Settle the parts of the target that need I/O to know: the resolved image, whether cgroup
  // limits are actually usable, the real credential modes and the credential mount. Called inside
  // ensureUp's mutex, BEFORE the fingerprint is computed, so what we compare is what we created.
  function settleTarget(target, { caps, img, env = process.env }) {
    const c = target.container;
    c.imageId = img.id;
    c.imageVersion = img.version;
    c.cgroupLimits = caps.cgroupLimits;
    c.uidStrategy = caps.uidStrategy;
    // Host-side path of the HOME volume's data dir. With keep-id the files inside are owned by the
    // daemon user, so host-side accounting (Codex rollout/token reading) can read them directly.
    c.homeVolumeHostPath = volumeHostPath(caps, c.homeVolume);
    c.appliedLimits = caps.cgroupLimits
      ? { pidsLimit: c.limits.pidsLimit, memory: c.limits.memory, cpus: c.limits.cpus }
      : null;
    if (!caps.cgroupLimits && (c.limits.memory || c.limits.cpus || c.limits.pidsLimit)) {
      log(`[container] cgroup limits are not delegated — ${c.name} runs without pids/memory/cpu caps`);
    }
    const settled = settleCredentialModes(target.settings, env);
    c.credentialMode = settled.modes;
    c.codexAuthFile = settled.codexAuthFile;
    // Rebuild rather than patch: ensureUp can run more than once on one target (the out-of-band
    // retry), and a credential that appeared since the last pass has to come BACK as a mount.
    target.codexAuthFile = settled.codexAuthFile;
    c.mounts = buildMounts(target).map((mount) => (mount.kind === "codex-auth" ? { ...mount, resolved: true } : mount));
    return c;
  }

  // Host-side preparation that must exist before the container is created: the artifact dir
  // (0700, bind-mounted at its identical path), the workdir and the clean workspace. Nothing
  // credential-shaped is ever staged here (see credentials.js).
  function prepareHostSide(target) {
    if (target.artifactDir) mkdirSync(target.artifactDir, { recursive: true, mode: 0o700 });
    for (const dir of [target.workDir, target.cleanWorkDir]) {
      if (dir) mkdirSync(dir, { recursive: true });
    }
    // Also before a START, not just a create: the persistent /tmp and /var/tmp sources are host
    // directories an operator can delete between two turns, and a missing bind source is a create
    // failure on one CLI and a silently root-owned auto-created directory on the other.
    ensureBindSources(target);
  }

  // Every bind-mount SOURCE must exist before `run`, or the CLI fails the create with a bare
  // "statfs … no such file or directory". The daemon normally creates them all at boot or before
  // the turn (socket dir, clean workspace, artifact dir), but the backend must not depend on that
  // ordering — a host where the socket server could not bind still has a socket DIR to mount.
  function ensureBindSources(target) {
    for (const mount of target.container?.mounts || []) {
      if (mount.type !== "bind" || !mount.source) continue;
      assertSafeBindSource(mount.source);
      mkdirSync(mount.source, { recursive: true, mode: 0o700 });
      assertSafeBindSource(mount.source);
    }
  }

  async function createContainer(caps, target, fingerprint, mountFingerprint) {
    ensureBindSources(target);
    const args = buildCreateArgs(target, caps, { fingerprint, mountFingerprint });
    const result = await cli.runWith(caps, args, { timeoutMs: 120_000 });
    if (result.code === 0) return;
    const stderr = String(result.stderr || "").trim();
    // A concurrent creator (the other gateway process, or a retry after a lost answer) can win the
    // name; adopt whatever is there rather than failing the turn.
    if (/already in use|already exists/i.test(stderr)) {
      log(`[container] ${target.container.name} already exists — adopting it`);
      return;
    }
    throw new Error(`could not create container ${target.container.name}: ${stderr || `exit ${result.code}`}`);
  }

  async function startContainer(caps, name) {
    const result = await cli.runWith(caps, ["start", name], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`could not start container ${name}: ${String(result.stderr || "").trim() || `exit ${result.code}`}`);
  }

  async function stopContainer(name, { caps = null, settings = null, reason = "" } = {}) {
    const resolved = caps || (await cli.probe(settings || {}, { image: settings?.image }));
    const result = await cli.runWith(resolved, ["stop", "-t", "10", name], { timeoutMs: 120_000 });
    if (result.code !== 0 && !isContainerGoneError(result.stderr)) {
      throw new Error(`could not stop container ${name}: ${String(result.stderr || "").trim()}`);
    }
    reaper.markStopped(name);
    if (reason) log(`[container] ${name} stopped (${reason})`);
  }

  async function removeContainer(caps, name, { volumes = "", strictVolumes = false } = {}) {
    const result = await cli.runWith(caps, ["rm", "-f", name], { timeoutMs: 120_000 });
    if (result.code !== 0 && !isContainerGoneError(result.stderr)) {
      throw new Error(`could not remove container ${name}: ${String(result.stderr || "").trim()}`);
    }
    reaper.forget(name);
    if (volumes) {
      const removed = await cli.runWith(caps, ["volume", "rm", volumes], { timeoutMs: 60_000 });
      if (removed.code !== 0 && !/no such volume|not found/i.test(String(removed.stderr || ""))) {
        if (strictVolumes) throw new Error(`could not remove smoke HOME volume ${volumes}`);
        log(`[container] could not remove volume ${volumes}: ${String(removed.stderr || "").trim()}`);
      }
    }
  }

  // `lease` is the CALLER's own lease on this container, when it took one before asking (run.js and
  // the memory reviewer both do — the idle reaper must not stop an environment a turn is about to
  // spawn into). It is excluded from "is anyone else inside?", because a turn is not a reason to
  // refuse to rebuild the container that turn is waiting for.
  async function ensureUp(target, { announce = null, lease = null, forceImage = false } = {}) {
    const name = target?.container?.name;
    if (!name) throw new Error("container target is missing its name");
    const ownLeaseId = typeof lease === "string" ? lease : (lease?.id || "");
    const othersInside = () => reaper.leaseCount(name, { exclude: ownLeaseId });
    const startedAt = now();
    const release = await acquireKeyedLock("cg-container", name);
    let slowTimer = null;
    try {
      const caps = await cli.probe(target.settings, { image: target.settings?.image });
      if (!caps.ok) throw new Error(caps.reason);
      const img = await image.inspect(caps, target.settings, { force: forceImage });
      if (!img.present) throw new Error(img.reason);
      settleTarget(target, { caps, img });
      const fingerprint = containerFingerprint(target);
      const mountFingerprint = containerMountFingerprint(target);
      target.container.fingerprint = fingerprint;
      target.container.mountFingerprint = mountFingerprint;

      let info = await inspectByRef(caps, name);
      if (info.exists && !isOurContainer(info.labels)) {
        throw new Error(
          `a container named ${name} already exists but does not belong to this ChannelGate install `
          + `(cg.install=${info.labels[LABEL_INSTALL] || "none"}). Remove or rename it by hand — the gateway will not touch it.`,
        );
      }
      if (info.exists && !["running", "exited", "created", "stopped"].includes(info.status)) {
        throw new Error(`container ${name} is ${info.status} — the gateway will not use it. Inspect it by hand.`);
      }

      let recreate = false;
      if (info.exists && info.fingerprint !== fingerprint) {
        // What KIND of stale? A container whose mounts still match can keep running the jobs inside
        // it (the image is newer, nothing it can see moved). A container whose mounts do NOT match
        // is looking at the wrong host directories — possibly deleted ones — and no turn may be
        // exec'd into it. An unknown stored value (a container created before the `cg.mounts` label)
        // counts as changed: fail closed.
        const mountsChanged = info.mountFingerprint !== mountFingerprint;
        if (info.status !== "running" || othersInside() === 0) {
          log(`[container] ${name} configuration changed — recreating (background state in it is lost)`);
          recreate = true;
        } else if (mountsChanged) {
          // Busy AND mount-affecting: wait, bounded, for the runs inside to finish — then rebuild.
          // Never "use it now": that is the path that ran three turns against a workspace bind
          // pointing at a directory the channel had already deleted.
          target.container.recreatePending = true;
          log(`[container] ${name} workspace mounts changed and ${othersInside()} run(s) are active — waiting up to ${Math.round(recreateWaitMs / 1000)}s to rebuild it`);
          announceOnce(announce, "This channel's workspace changed, so its container has to be rebuilt — waiting for the runs still inside it to finish.");
          const deadline = now() + recreateWaitMs;
          while (othersInside() > 0 && now() < deadline) await sleep(recreatePollMs);
          if (othersInside() > 0) {
            throw new Error(
              `this channel's container must be rebuilt before it can run again — its workspace mounts changed `
              + `(the work folder, clean workspace or artifact directory moved), so the container is bound to the OLD paths. `
              + `${othersInside()} run(s) are still active inside it, so the rebuild could not happen within `
              + `${Math.round(recreateWaitMs / 1000)}s. It rebuilds by itself as soon as they finish — send the message again then, `
              + `or stop the running job.`,
            );
          }
          log(`[container] ${name} is idle now — rebuilding it for the changed workspace mounts`);
          recreate = true;
        } else {
          // Busy, but nothing it can SEE changed (a rebuilt image, a limit, the network mode). Use
          // it for this turn and recreate at the next idle moment, as before.
          target.container.recreatePending = true;
          log(`[container] ${name} configuration changed but runs are active — recreating when it next goes idle`);
        }
      }
      if (recreate) {
        await removeContainer(caps, name);
        info = { exists: false, status: "missing" };
        target.container.recreatePending = false;
      }

      let created = false;
      let started = false;
      if (!info.exists || info.status === "missing") {
        await reaper.reserveSlot(name, { maxRunning: target.settings?.maxRunning ?? 8, announce });
        prepareHostSide(target);
        slowTimer = announceAfter(announce, "Warming up this channel's container — the first run takes a few seconds.");
        await createContainer(caps, target, fingerprint, mountFingerprint);
        created = true;
        started = true;
      } else if (info.status !== "running") {
        await reaper.reserveSlot(name, { maxRunning: target.settings?.maxRunning ?? 8, announce });
        prepareHostSide(target);
        const hadLeases = othersInside() > 0;
        slowTimer = announceAfter(announce, "Restarting this channel's container…");
        await startContainer(caps, name);
        started = true;
        if (hadLeases) {
          announceOnce(announce, "The channel container had stopped — background processes from the previous session were lost.");
        }
      }

      reaper.markRunning(name, target);
      return { created, started, warmupMs: now() - startedAt };
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
      release();
    }
  }

  async function destroy(target, { volumes = false, strictVolumes = false, reason = "" } = {}) {
    const name = target?.container?.name;
    if (!name) return;
    const caps = await cli.probe(target.settings, { image: target.settings?.image });
    if (!caps.ok) throw new Error(caps.reason);
    await removeContainer(caps, name, { volumes: volumes ? target.container.homeVolume : "", strictVolumes });
    log(`[container] removed ${name}${volumes ? " and its HOME volume" : ""}${reason ? ` (${reason})` : ""}`);
  }

  // Boot reconcile: every engine process inside a RUNNING container belonged to the previous
  // daemon, which can no longer read their stdout — restart recovery replays those turns. Sweep the
  // foreground and warm groups only; a detached background job is meant to survive a restart.
  async function bootReconcile(settings, { sweepKinds = ["run", "warm"] } = {}) {
    const caps = await cli.probe(settings, { image: settings?.image });
    if (!caps.ok) return { ok: false, reason: caps.reason, running: [], swept: [] };
    const containers = await listOurContainers(caps);
    const running = containers.filter((entry) => entry.status === "running");
    const swept = [];
    for (const entry of running) {
      const result = await cli.runWith(caps, ["exec", entry.name, "cg-sweep", ...sweepKinds], { timeoutMs: 60_000 });
      if (result.code === 0) swept.push({ name: entry.name, ids: String(result.stdout || "").trim().split("\n").filter(Boolean) });
      else log(`[container] boot sweep of ${entry.name} failed: ${String(result.stderr || "").trim()}`);
      // External editor leases survive a daemon restart. Reconstruct the narrow target facts the
      // reaper needs from our authenticated container labels so it can still validate their signed
      // markers rather than treating the attached editor as idle after boot.
      const slug = entry.labels[LABEL_CHANNEL] || "";
      const platform = entry.labels[LABEL_PLATFORM] || "";
      const leaseTarget = slug ? {
        slug, platform, artifactDir: channelArtifactDir(slug, platform), container: { name: entry.name },
      } : null;
      reaper.markRunning(entry.name, leaseTarget, { lastActivity: now() });
    }
    if (running.length) log(`[container] boot reconcile: ${running.length} running container(s) swept and registered idle`);
    return { ok: true, reason: "", running: running.map((entry) => entry.name), swept, containers };
  }

  return {
    ensureUp, destroy, stopContainer, removeContainer, listOurContainers, bootReconcile,
    inspect: inspectByRef, settleTarget, prepareHostSide,
  };
}

// A slow create/start must SAY it is slow — silence that looks like death is the bug the gateway's
// heartbeat rules exist to prevent. Returns a timer the caller clears when the work finishes.
function announceAfter(announce, text, ms = 2_000) {
  if (typeof announce !== "function") return null;
  const timer = setTimeout(() => announceOnce(announce, text), ms);
  timer.unref?.();
  return timer;
}

function announceOnce(announce, text) {
  if (typeof announce !== "function") return;
  try {
    announce(text);
  } catch {
    /* announcing must never fail a run */
  }
}
