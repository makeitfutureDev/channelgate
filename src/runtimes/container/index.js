// The `container` runtime backend: one long-lived Linux container per channel, engine processes
// exec'd into it. Everything a caller needs is on the RuntimeTarget; everything this package needs
// to talk to a container CLI is behind one injectable exec, so the whole backend is unit-testable
// without a container daemon.
//
// Fail-closed is the rule (CLAUDE.md): no CLI, no image, no engine login ⇒ the run ends with a
// message naming the remedy. It NEVER silently falls back to the host backend — only the explicit
// gateway kill switch does that, in resolve.js.
import { channelArtifactDir, runtimeSocketDir } from "../../config/paths.js";
import { containerLabels, containerName, homeVolumeName } from "./names.js";
import { createContainerCli } from "./cli.js";
import { createContainerImage } from "./image.js";
import { createContainerLifecycle, buildMounts, containerFingerprint, volumeHostPath } from "./lifecycle.js";
import { createContainerExec } from "./exec.js";
import { createContainerCarry, shellQuote } from "./carry.js";
import { createContainerReaper } from "./reaper.js";
import { codexAuthCandidates, codexAuthIdentity, credentialError, credentialNotes, intendedCredentialModes } from "./credentials.js";
import { containerImagePaths, IMAGE_HELPERS, IMAGE_SPEC_VERSION } from "./image-paths.js";

export { credentialError, credentialNotes } from "./credentials.js";
export { containerFingerprint } from "./lifecycle.js";
export * from "./image-paths.js";

let logFn = (message) => console.log(message);
const log = (message) => logFn(message);

let context = null;
let bootSettings = null;

function buildContext({ exec = undefined, now = undefined, pollMs = undefined, sweepMs = undefined } = {}) {
  const holder = {};
  holder.cli = createContainerCli({ exec, now, log });
  holder.image = createContainerImage({ cli: holder.cli, now });
  holder.reaper = createContainerReaper({
    now,
    log,
    sweepMs,
    // Late-bound: the reaper stops containers, the lifecycle owns how.
    stopContainer: (name, opts) => holder.lifecycle.stopContainer(name, { ...opts, settings: opts?.target?.settings || bootSettings }),
  });
  holder.lifecycle = createContainerLifecycle({ cli: holder.cli, image: holder.image, reaper: holder.reaper, log, now });
  holder.exec = createContainerExec({ cli: holder.cli, lifecycle: holder.lifecycle, reaper: holder.reaper, log, pollMs });
  holder.carry = createContainerCarry({ exec: holder.exec, lifecycle: holder.lifecycle, log });
  return holder;
}

function runtime() {
  if (!context) context = buildContext({});
  return context;
}

// Test seam: swap the process-execution primitive (and the clock) for a fake CLI. Never called by
// the daemon.
export function __setContainerRuntime(options = {}) {
  if (options.log) logFn = options.log;
  context = buildContext(options);
  return context;
}

export function __resetContainerRuntime() {
  context?.exec?.clearTimers?.();
  context?.reaper?.stopTimer?.();
  context = null;
  bootSettings = null;
  logFn = (message) => console.log(message);
}

export const containerBackend = Object.freeze({
  id: "container",

  // The pre-spawn credential gate the runners and run.js call (optional in the contract — the host
  // backend has none). Without it on the backend object the fail-closed check silently became a
  // no-op: a container with no Claude login or no Codex sign-in would reach the engine instead of
  // ending the turn with the remedy. Found by the docs review; guarded by test/runtimes-core.
  credentialError(target, engineId) {
    return credentialError(target, engineId);
  },

  capabilities: Object.freeze({
    isolated: true,
    processGroups: true,
    detachedSurvivesDaemon: true,
    persistentHome: true,
  }),

  // PURE. Everything here is derivable from the base target, its settings snapshot and the daemon's
  // own uid/gid. The three facts that need I/O — the resolved image id, whether cgroup limits are
  // actually delegated, and which engine credentials exist — are SETTLED by ensureUp() before the
  // fingerprint is computed and before anything is created.
  prepareTarget(base) {
    const settings = base.settings || {};
    const name = containerName(base);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const gid = typeof process.getgid === "function" ? process.getgid() : null;
    const container = {
      name,
      homeVolume: homeVolumeName(base),
      // The host-side path of that volume's data dir, so run.js can point host-side Codex
      // accounting at the channel's rollouts. "" until the CLI has been probed — ensureUp fills it.
      homeVolumeHostPath: volumeHostPath(runtime().cli.peek(), homeVolumeName(base)),
      image: String(settings.image || ""),
      network: base.meta?.networkMode === "off" ? "none" : "bridge",
      uid,
      gid,
      uidStrategy: "user", // settled from the CLI probe
      credentialMode: intendedCredentialModes(settings),
      limits: {
        pidsLimit: Number(settings.pidsLimit) || 1024,
        memory: String(settings.memory || ""),
        cpus: String(settings.cpus || ""),
      },
      appliedLimits: null,
      imageId: "",
      imageVersion: "",
      fingerprint: "",
      recreatePending: false,
      mounts: [],
      labels: {},
      // Image facts, from the one module that mirrors the Containerfile. Runners read these off
      // the target instead of keeping a second copy of the same strings.
      ...containerImagePaths(),
    };
    const target = {
      ...base,
      backend: "container",
      runtime: containerBackend,
      artifactDir: base.artifactDir || channelArtifactDir(base.slug, base.platform),
      socketDir: runtimeSocketDir(),
      // The declared credential source; ensureUp replaces it with the resolved real path, or drops
      // the mount when the gateway has no Codex login at all.
      codexAuthFile: codexAuthCandidates()[0],
      container,
    };
    container.mounts = buildMounts(target);
    container.labels = containerLabels(target, { fingerprint: "", image: container.image });
    return target;
  },

  async ensureUp(target, opts = {}) {
    return runtime().lifecycle.ensureUp(target, opts);
  },

  spawn(target, spec) {
    return runtime().exec.spawn(target, spec);
  },

  async probe(child) {
    return runtime().exec.probe(child);
  },

  async signal(child, signal = "SIGTERM") {
    return runtime().exec.signal(child, signal);
  },

  acquireLease(target, lease = {}) {
    return runtime().reaper.acquireLease(target, lease);
  },

  async destroy(target, opts = {}) {
    return runtime().lifecycle.destroy(target, opts);
  },

  fingerprint(target) {
    return containerFingerprint(target);
  },

  async describe(target) {
    const r = runtime();
    const c = target?.container || {};
    const base = {
      backend: "container",
      containerName: c.name || "",
      image: c.image || "",
      imageVersion: c.imageVersion || "",
      credentialMode: { ...(c.credentialMode || {}) },
      notes: credentialNotes(target),
      leases: c.name ? r.reaper.leaseCount(c.name) : 0,
    };
    if (!c.name) return { ...base, state: "unknown", reason: "target has no container" };
    let caps;
    try {
      caps = await r.cli.probe(target.settings, { image: target.settings?.image });
    } catch (error) {
      return { ...base, state: "unknown", reason: String(error?.message || error) };
    }
    if (!caps.ok) return { ...base, state: "unavailable", reason: caps.reason };
    let info;
    try {
      info = await r.lifecycle.inspect(caps, c.name);
    } catch (error) {
      return { ...base, state: "unknown", reason: String(error?.message || error) };
    }
    if (!info.exists) return { ...base, state: "missing", warm: false };
    const described = {
      ...base,
      state: info.status,
      upSince: info.startedAt,
      warm: info.status === "running",
      imageId: info.imageId,
      fingerprintMatch: c.fingerprint ? info.fingerprint === c.fingerprint : null,
      recreatePending: Boolean(c.recreatePending),
    };
    // Codex shares ONE auth file with the gateway and every other container channel. If the host
    // has since replaced that file (a fresh `codex login` writes a new inode), a running container
    // is still holding the old one — say so rather than let a stale login look healthy.
    if (info.status === "running" && c.credentialMode?.codex === "shared-file" && c.codexAuthFile) {
      const host = codexAuthIdentity(c.codexAuthFile);
      try {
        const seen = await r.exec.runExec(target, [c.name, "stat", "-c", "%i:%s", "/home/agent/.codex/auth.json"], { retry: false, timeoutMs: 10_000 });
        const [ino, size] = String(seen.stdout || "").trim().split(":");
        described.codexAuth = seen.code === 0 && host
          ? { shared: true, current: ino === host.ino, hostIno: host.ino, containerIno: ino || "", size: Number(size) || 0 }
          : { shared: true, current: null };
      } catch {
        described.codexAuth = { shared: true, current: null };
      }
    }
    return described;
  },

  // The copy-pasteable command an operator runs to take over this channel's session by hand.
  resumeCommand(target, { baseCommand } = {}) {
    const bin = runtime().cli.binHint(target?.settings);
    const name = target?.container?.name || "";
    return `${bin} exec -it -w ${shellQuote(target?.cwd || "")} ${name} ${baseCommand}`;
  },

  helperCommand(target, name) {
    const helper = IMAGE_HELPERS[name];
    if (!helper) throw new TypeError(`unknown runtime helper "${name}"`);
    return { command: helper.command, args: [...helper.args] };
  },

  // The carry pair (contract.js OPTIONAL_METHODS): a thread's engine-native history follows it
  // when its channel changes runtime backend. Both halves go through the bind-mounted artifact
  // dir — the daemon cannot touch the HOME volume itself. See ./carry.js.
  async copyIn(target, entries) {
    return runtime().carry.copyIn(target, entries);
  },

  async copyOut(target, entries) {
    return runtime().carry.copyOut(target, entries);
  },
});

// ── Daemon wiring (server.js calls these) ─────────────────────────────────────────────────────

// Probe the CLI once, check the image, reconcile whatever the previous daemon left running, and
// start the idle reaper. Never throws: a host with no container CLI must still boot, with the
// reason legible in the log and in /api/health.
export async function bootContainerRuntime({ settings, log: logger } = {}) {
  if (logger) logFn = logger;
  bootSettings = settings || null;
  const r = runtime();
  const status = { enabled: Boolean(settings?.enabled), cli: null, image: null, reconciled: null };
  try {
    status.cli = await r.cli.probe(settings || {}, { image: settings?.image, force: true });
  } catch (error) {
    status.cli = { ok: false, reason: String(error?.message || error) };
  }
  if (!status.cli.ok) {
    if (settings?.enabled) log(`[container] WARNING: the container runtime is enabled but unusable — ${status.cli.reason}`);
    else log(`[container] no container CLI available (${status.cli.reason}); the container backend is off anyway`);
    return status;
  }
  log(`[container] ${status.cli.kind} ${status.cli.version}${status.cli.rootless ? " (rootless)" : ""} via ${status.cli.bin}, uid strategy ${status.cli.uidStrategy}${status.cli.cgroupLimits ? "" : ", cgroup limits unavailable"}`);
  try {
    status.image = await r.image.inspect(status.cli, settings || {}, { force: true });
    if (!status.image.present) log(`[container] WARNING: ${status.image.reason}`);
    // A built image older than this checkout's spec still RUNS — the fingerprint follows the image
    // id, not the spec — but it is missing whatever the newer spec adds (a wider PATH, a packaging
    // toolchain). Say so once at boot instead of leaving an operator to discover it as "pip is not
    // installed" inside a channel.
    else if (status.image.version && status.image.version !== IMAGE_SPEC_VERSION) {
      log(`[container] the built image is spec ${status.image.version} but this checkout expects ${IMAGE_SPEC_VERSION} — run \`npm run build:image\` to pick up this build's channel toolchain`);
    }
  } catch (error) {
    status.image = { present: false, reason: String(error?.message || error) };
  }
  // The idle reaper starts even with the gateway switch OFF. A session carry-over may still bring
  // one channel's container up to read history out of its HOME volume — that is exactly what makes
  // the kill switch a safe lever rather than one that strands a thread's engine history — and with
  // no reaper nothing would ever stop it again. It only ever acts on containers THIS process
  // started (its entry map is populated by ensureUp), so with the runtime disabled it stays inert
  // until precisely that happens.
  if (!settings?.enabled) {
    r.reaper.startTimer();
    return status;
  }
  try {
    status.reconciled = await r.lifecycle.bootReconcile(settings);
  } catch (error) {
    log(`[container] boot reconcile failed: ${error?.message || error}`);
    status.reconciled = { ok: false, reason: String(error?.message || error) };
  }
  r.reaper.startTimer();
  return status;
}

export function stopContainerRuntime() {
  if (!context) return;
  context.reaper.stopTimer();
  context.exec.clearTimers();
}

// The /api/health payload. Cheap: the CLI probe is cached, and the container listing is one `ps`
// plus one `inspect`.
export async function containerRuntimeStatus(settings = bootSettings) {
  const r = runtime();
  const effective = settings || bootSettings || {};
  const out = {
    enabled: Boolean(effective?.enabled),
    cli: { bin: "", kind: "", rootless: false, version: "", ok: false, reason: "not probed" },
    image: { ref: String(effective?.image || ""), id: "", present: false, reason: "" },
    running: 0,
    containers: [],
  };
  let caps;
  try {
    caps = await r.cli.probe(effective, { image: effective?.image });
  } catch (error) {
    out.cli.reason = String(error?.message || error);
    return out;
  }
  out.cli = {
    bin: caps.bin, kind: caps.kind, rootless: caps.rootless, version: caps.version,
    uidStrategy: caps.uidStrategy, cgroupLimits: caps.cgroupLimits, ok: caps.ok, reason: caps.reason,
  };
  if (!caps.ok) return out;
  try {
    const img = await r.image.inspect(caps, effective);
    out.image = { ref: img.ref, id: img.id, present: img.present, reason: img.reason };
  } catch (error) {
    out.image.reason = String(error?.message || error);
  }
  try {
    const listed = await r.lifecycle.listOurContainers(caps);
    const leases = new Map(r.reaper.snapshot().map((entry) => [entry.name, entry]));
    out.containers = listed.map((entry) => ({
      name: entry.name,
      slug: entry.labels["cg.channel"] || "",
      platform: entry.labels["cg.platform"] || "",
      state: entry.status,
      upSince: entry.startedAt,
      image: entry.labels["cg.image"] || "",
      leases: leases.get(entry.name)?.leases ?? 0,
      idleMs: leases.get(entry.name)?.idleMs ?? null,
    }));
    out.running = out.containers.filter((entry) => entry.state === "running").length;
  } catch (error) {
    out.cli.reason = out.cli.reason || String(error?.message || error);
  }
  return out;
}
