// Durability: nothing a channel accumulates inside its container is ever thrown away by the
// gateway. The question this file answers, permanently, is the operator's: "if I install a CLI, or
// leave a file in /tmp, is it still there tomorrow?"
//
// Four things have to hold at once, and each has its own failure mode:
//   1. /tmp and /var/tmp are HOST directories, not tmpfs — a tmpfs made the idle reaper's routine
//      ten-minute `stop` silently delete an agent's scratch (the regression this file pins closed).
//   2. The idle sweep only ever STOPS. A stop keeps the writable layer, the volume and the binds.
//   3. A recreate (image bump, config change) removes the CONTAINER and reuses the SAME HOME
//      volume — never `volume rm`, which is what would take the logins and the installed CLIs.
//   4. The image PATH reaches the places an agent can actually install into, all of which live in
//      that volume.
//
// Everything here runs against the fake CLI (test/container-fake-cli.js) and reads the Containerfile
// as text — no container binary is involved. The opt-in live proof is
// test/container-durability.live.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeCli, inspectLine } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const { createContainerCli } = await import("../src/runtimes/container/cli.js");
const { createContainerImage } = await import("../src/runtimes/container/image.js");
const { buildCreateArgs, buildMounts, createContainerLifecycle, PERSISTENT_TMP_DIRS, TMPFS_SPECS } = await import("../src/runtimes/container/lifecycle.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");
const { containerEnvDefaults } = await import("../src/runtimes/container/credentials.js");
const { CONTAINER_PATH, IMAGE_SPEC_VERSION } = await import("../src/runtimes/container/image-paths.js");
const { CONTAINER_PATH: ENGINE_FALLBACK_PATH } = await import("../src/engines/runtime-target.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};

function target(slug, overrides = {}) {
  return resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container", ...overrides }, { settings: SETTINGS });
}

// The lifecycle wired the way index.js wires it in production — the reaper stops through the
// lifecycle, so a sweep's real command lines land in the fake CLI's recording.
function harness({ state = { exists: false }, kind = "podman", clock = null } = {}) {
  const fake = createFakeCli({
    kind,
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: `sha256:img|${IMAGE_SPEC_VERSION}` } },
      {
        match: (a) => a[1] === "inspect",
        result: () => (state.exists
          ? { code: 0, stdout: inspectLine({ ...state, install: state.install ?? currentInstallId() }) }
          : { code: 125, stderr: "Error: no such container" }),
      },
    ],
  });
  const logs = [];
  const holder = {};
  const cli = createContainerCli({ exec: fake.exec, log: (m) => logs.push(m) });
  const image = createContainerImage({ cli });
  const reaper = createContainerReaper({
    now: clock?.now,
    log: (m) => logs.push(m),
    stopContainer: (name, opts) => holder.lifecycle.stopContainer(name, { ...opts, settings: opts?.target?.settings || SETTINGS }),
  });
  holder.lifecycle = createContainerLifecycle({ cli, image, reaper, log: (m) => logs.push(m) });
  return { fake, cli, image, reaper, lifecycle: holder.lifecycle, logs, state };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Every verb the fake CLI was asked to run, flattened, so "did anything destructive happen?" is a
// question about the whole recording rather than about the call a test happened to look at.
function verbs(fake) {
  return fake.calls.map((call) => call.argv.slice(1).join(" "));
}

function assertNothingDestroyed(fake, why) {
  for (const line of verbs(fake)) {
    assert.ok(!/^volume (rm|prune)\b/.test(line), `${why}: "${line}" would delete a channel's HOME volume`);
    assert.ok(!/^system prune\b/.test(line), `${why}: "${line}" would prune the whole store`);
  }
}

test("durability: /tmp and /var/tmp are persistent binds under the artifact dir, and /run is the only tmpfs", () => {
  const t = target("dur-mounts");
  // A tmpfs is emptied by the very stop the idle reaper performs every ten minutes. Only /run,
  // which holds the run helpers' pid files and the read-only socket mount, may be one.
  assert.deepEqual([...TMPFS_SPECS], ["/run:rw,noexec,size=64m"]);

  const mounts = buildMounts(t);
  for (const { kind, dir, target: dest } of PERSISTENT_TMP_DIRS) {
    const mount = mounts.find((m) => m.kind === kind);
    assert.ok(mount, `no ${kind} mount`);
    assert.equal(mount.type, "bind");
    assert.equal(mount.mode, "rw");
    assert.equal(mount.target, dest);
    assert.equal(mount.source, path.join(t.artifactDir, dir));
    // The artifact dir is per channel, on the host, and the daemon never deletes it — which is
    // what makes this survive a stop AND makes it visible to an operator.
    assert.ok(mount.source.startsWith(`${t.artifactDir}${path.sep}`));
  }
  assert.deepEqual(PERSISTENT_TMP_DIRS.map((d) => d.target), ["/tmp", "/var/tmp"]);
  // The mount list is part of the fingerprint, so this change recreates every existing container
  // exactly once — with its volume.
  assert.deepEqual(
    t.container.mounts.map((m) => m.kind),
    ["workdir", "clean", "artifacts", "tmp", "var-tmp", "home", "socket", "codex-auth"],
  );
  // A target with no artifact dir (never a container target, but buildMounts is exported) must not
  // emit a mount whose source is the empty string.
  assert.ok(!buildMounts({ ...t, artifactDir: "" }).some((m) => m.kind === "tmp" || m.kind === "var-tmp"));
});

test("durability: the create argv mounts both temp trees and pins the uid on both CLI kinds", async () => {
  const t = target("dur-argv");
  t.container.imageId = "sha256:deadbeef";

  const podmanCaps = await createContainerCli({ exec: createFakeCli({ kind: "podman" }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const podman = buildCreateArgs(t, podmanCaps, { fingerprint: "c1-dur" });
  assert.ok(podman.includes(`${path.join(t.artifactDir, "tmp")}:/tmp`));
  assert.ok(podman.includes(`${path.join(t.artifactDir, "var-tmp")}:/var/tmp`));
  assert.deepEqual(podman.filter((a, i) => podman[i - 1] === "--tmpfs"), ["/run:rw,noexec,size=64m"]);
  // Rootless podman maps the daemon user 1:1, so files written in the volume AND in the two binds
  // are owned by the daemon user on both sides — without that, "persistent" would mean "there but
  // unreadable" the next time the daemon looked.
  assert.ok(podman.includes("--userns=keep-id"));
  assert.ok(!podman.includes("--user"));

  const dockerCaps = await createContainerCli({ exec: createFakeCli({ kind: "docker", available: ["docker"] }).exec }).probe(SETTINGS, { image: SETTINGS.image });
  const docker = buildCreateArgs(t, dockerCaps, { fingerprint: "c1-dur" });
  assert.ok(!docker.includes("--userns=keep-id"));
  assert.equal(docker[docker.indexOf("--user") + 1], `${t.container.uid}:${t.container.gid}`);
  assert.ok(docker.includes(`${path.join(t.artifactDir, "tmp")}:/tmp`));
});

test("durability: the idle sweep only ever stops — never rm, never a volume command", async () => {
  const clock = fakeClock();
  const h = harness({ clock });
  const t = target("dur-idle");
  await h.lifecycle.ensureUp(t, {});
  h.fake.reset();

  clock.advance(11 * 60_000);
  assert.deepEqual(await h.reaper.tick(), [t.container.name], "an unleased container past its window is swept");
  assert.deepEqual(h.fake.last("stop"), ["podman", "stop", "-t", "10", t.container.name]);
  for (const line of verbs(h.fake)) {
    assert.ok(!/^rm\b/.test(line), `the idle sweep ran "${line}" — a stop must never remove the container`);
    assert.ok(!/^volume\b/.test(line), `the idle sweep ran "${line}"`);
  }
  assertNothingDestroyed(h.fake, "idle sweep");

  // And the max-running cap takes the same route: it makes room by STOPPING the LRU idle one.
  const cap = harness({ clock });
  const a = target("dur-cap-a");
  const b = target("dur-cap-b");
  await cap.lifecycle.ensureUp(a, {});
  clock.advance(1_000);
  await cap.lifecycle.ensureUp(b, {});
  cap.fake.reset();
  const room = await cap.reaper.reserveSlot("cg-third", { maxRunning: 2 });
  assert.deepEqual(room.stopped, [a.container.name], "the least-recently-used IDLE container makes room");
  assert.ok(cap.fake.last("stop"));
  assert.equal(cap.fake.last("rm"), null);
  assertNothingDestroyed(cap.fake, "max-running cap");
});

test("durability: a fingerprint mismatch recreates the container onto the SAME HOME volume", async () => {
  const h = harness({ state: { exists: true, status: "running", fingerprint: "c1-stale" } });
  const t = target("dur-recreate");
  await h.lifecycle.ensureUp(t, {});

  assert.deepEqual(h.fake.last("rm"), ["podman", "rm", "-f", t.container.name]);
  const run = h.fake.last("run");
  assert.ok(run, "a stale container is replaced");
  const volumes = run.filter((arg, i) => run[i - 1] === "-v");
  assert.ok(
    volumes.includes(`${t.container.homeVolume}:/home/agent`),
    `the recreated container must reuse the channel's HOME volume, got ${volumes.join(" ")}`,
  );
  // The two temp trees come back at the same host paths, so an image bump does not empty them.
  assert.ok(volumes.includes(`${path.join(t.artifactDir, "tmp")}:/tmp`));
  assert.ok(volumes.includes(`${path.join(t.artifactDir, "var-tmp")}:/var/tmp`));
  // The whole point: a recreate is `rm -f` + `run`, and never a volume removal.
  assertNothingDestroyed(h.fake, "recreate");
  assert.ok(h.logs.some((m) => /configuration changed — recreating/.test(m)));
});

test("durability: destroy() removes the HOME volume only when a caller explicitly asks — and no production caller does", async () => {
  const h = harness({ state: { exists: true, status: "running" } });
  const t = target("dur-destroy");
  await h.lifecycle.destroy(t, { reason: "rollback" });
  assert.deepEqual(h.fake.last("rm"), ["podman", "rm", "-f", t.container.name]);
  assert.equal(h.fake.last("volume"), null, "a rollback must never delete a channel's logins");
  assertNothingDestroyed(h.fake, "default destroy");

  await h.lifecycle.destroy(t, { volumes: true, reason: "channel deleted" });
  assert.deepEqual(h.fake.last("volume"), ["podman", "volume", "rm", t.container.homeVolume]);

  // Architecture tripwire, in the style of test/run-escalation.test.js: `{ volumes: true }` is the
  // one switch that can delete everything a channel ever installed, and today NOTHING in src/
  // flips it. A future caller has to change this test on purpose.
  const offenders = [];
  const walk = (rel) => {
    for (const item of readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = path.join(rel, item.name);
      if (item.isDirectory()) walk(child);
      else if (/\.(?:js|mjs)$/.test(item.name)) {
        const source = readFileSync(path.join(repoRoot, child), "utf8");
        for (const [index, line] of source.split("\n").entries()) {
          const text = line.trim();
          // Comments DESCRIBE the switch (contract.js documents it); only code may flip it.
          if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) continue;
          if (/volumes\s*:\s*true/.test(text)) offenders.push(`${child}:${index + 1}: ${text}`);
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(
    offenders,
    [],
    `a production caller now asks destroy() to delete a HOME volume:\n${offenders.join("\n")}\n`
    + "Deleting a volume deletes the channel's CLI logins, npm/pip installs and engine history. "
    + "If that is genuinely intended (channel deletion), update this test with the reason.",
  );
});

test("durability: the boot reconcile sweeps processes INSIDE containers and touches no container", async () => {
  const ids = ["aaa", "bbb"];
  const byId = {
    aaa: inspectLine({ name: "cg-dur-a", status: "running", install: currentInstallId(), channel: "a" }),
    bbb: inspectLine({ name: "cg-dur-b", status: "exited", install: currentInstallId(), channel: "b" }),
  };
  const fake = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: `${ids.join("\n")}\n` } },
      { match: (a) => a[1] === "inspect" && a.length > 5, result: (a) => ({ code: 0, stdout: a.slice(5).map((id) => byId[id]).filter(Boolean).join("\n") }) },
      { match: (a) => a[1] === "exec" && a.includes("cg-sweep"), result: { code: 0, stdout: "run-1\n" } },
    ],
  });
  const cli = createContainerCli({ exec: fake.exec });
  const reaper = createContainerReaper({ stopContainer: async () => { throw new Error("the boot reconcile must not stop anything"); } });
  const lifecycle = createContainerLifecycle({ cli, image: createContainerImage({ cli }), reaper, log: () => {} });
  const result = await lifecycle.bootReconcile(SETTINGS);
  assert.deepEqual(result.running, ["cg-dur-a"]);
  for (const line of verbs(fake)) {
    assert.ok(!/^rm\b/.test(line), `the boot reconcile ran "${line}"`);
    assert.ok(!/^stop\b/.test(line), `the boot reconcile ran "${line}" — a restart must not stop a channel's container`);
    assert.ok(!/^volume\b/.test(line), `the boot reconcile ran "${line}"`);
  }
  assertNothingDestroyed(fake, "boot reconcile");
});

test("durability: the container env never lets a host value displace the image's own locations", () => {
  const t = target("dur-env");
  // HOST_ONLY_ENV / CONTAINER_OWNED_ENV, from the durability angle: a host PATH would hide
  // ~/.local/bin and ~/.npm-global/bin (so an installed CLI would look uninstalled), a host HOME
  // would move every future install OUT of the persistent volume, and a host TMPDIR would point at
  // a directory that does not exist in the image.
  const written = containerRunEnv(t, {
    PATH: "/home/daemon/.claude-launcher:/usr/local/bin",
    HOME: "/home/daemon",
    TMPDIR: "/var/folders/host",
    NPM_CONFIG_PREFIX: "/home/daemon/.npm",
    CLAUDE_CONFIG_DIR: "/home/daemon/.claude",
    CODEX_HOME: "/home/daemon/.codex",
    XDG_DATA_HOME: "/home/daemon/.local/share",
    ANTHROPIC_MODEL: "opus",
  });
  for (const key of ["PATH", "TMPDIR", "NPM_CONFIG_PREFIX", "XDG_DATA_HOME"]) {
    assert.equal(key in written, false, `${key} must not survive into the container`);
  }
  assert.equal(written.HOME, "/home/agent");
  assert.equal(written.CLAUDE_CONFIG_DIR, "/home/agent/.claude");
  assert.equal(written.CODEX_HOME, "/home/agent/.codex");
  assert.equal(written.ANTHROPIC_MODEL, "opus");
  // The defaults themselves never name a host path.
  const defaults = containerEnvDefaults(t);
  assert.equal(defaults.PATH, undefined, "the image owns PATH; the backend must not restate it");
  for (const value of Object.values(defaults)) {
    assert.ok(!String(value).startsWith(os.homedir()), `a container default leaked the daemon's home: ${value}`);
  }
});

test("durability: the image PATH reaches every place a channel can install into, and both declarations agree", () => {
  const containerfile = read("containers/Containerfile");
  assert.ok(containerfile.includes(`PATH=${CONTAINER_PATH}`), "containers/Containerfile PATH has drifted from image-paths.js");
  // Codex executes commands through `bash -lc`, and Debian's /etc/profile RESETS PATH before
  // ~/.profile runs — the image has to re-assert its PATH from /etc/profile.d or a Codex shell
  // never sees ~/.npm-global/bin or /opt/channelgate/bin (observed live on 2026-09-02).
  assert.ok(containerfile.includes('> /etc/profile.d/channelgate-path.sh'), "containers/Containerfile must re-assert PATH for login shells via /etc/profile.d");
  assert.ok(/printf 'export PATH="%s"\\n' "\$PATH" > \/etc\/profile\.d\/channelgate-path\.sh/.test(containerfile), "the profile.d snippet must export the SAME PATH the ENV line declares");
  // One string, two modules: src/engines/runtime-target.js keeps a fallback for targets that
  // declare no container.path, and it drifted from the image once already.
  assert.equal(ENGINE_FALLBACK_PATH, CONTAINER_PATH, "src/engines/runtime-target.js CONTAINER_PATH has drifted from the image's");

  const entries = CONTAINER_PATH.split(":");
  // Order is the contract: what the CHANNEL installed wins over the image's pinned toolchain, and
  // the image's toolchain wins over the distro's.
  assert.ok(entries.indexOf("/home/agent/.npm-global/bin") < entries.indexOf("/opt/channelgate/bin"));
  assert.ok(entries.indexOf("/home/agent/.local/bin") < entries.indexOf("/usr/bin"));
  for (const dir of ["/home/agent/.local/bin", "/home/agent/bin", "/home/agent/.cargo/bin", "/home/agent/.bun/bin", "/home/agent/.deno/bin", "/home/agent/go/bin"]) {
    assert.ok(entries.includes(dir), `${dir} is not on the image PATH — an install there would be invisible`);
    assert.ok(dir.startsWith("/home/agent/"), "every writable PATH entry must be inside the per-channel HOME volume");
  }
});

test("durability: the image bakes in the packaging toolchain and pre-creates the bin dirs it puts on PATH", () => {
  const containerfile = read("containers/Containerfile");
  const versions = JSON.parse(read("containers/versions.json"));

  // Python packaging: without these, `pip install <cli>` fails on Debian's PEP 668 marker and the
  // agent concludes the container cannot install anything.
  for (const pkg of ["python3-pip", "python3-venv", "pipx"]) {
    assert.ok(new RegExp(`\\b${pkg}\\b`).test(containerfile), `containers/Containerfile does not install ${pkg}`);
  }
  assert.ok(containerfile.includes("PIP_USER=1"), "a pip install must default to ~/.local, which is in the HOME volume");
  assert.ok(containerfile.includes("PIP_BREAK_SYSTEM_PACKAGES=1"), "Debian's externally-managed marker would otherwise refuse every pip install");
  assert.ok(containerfile.includes("PIPX_BIN_DIR=/home/agent/.local/bin"), "pipx shims must land on the image PATH");
  assert.ok(containerfile.includes("PIPX_HOME=/home/agent/.local/pipx"));
  assert.ok(containerfile.includes("NPM_CONFIG_PREFIX=/home/agent/.npm-global"));

  // A brand-new named volume is seeded from the image, so the bin dirs on PATH must exist there
  // owned by agent — and cg-init recreates them on every start for a volume made before they did.
  const installLines = containerfile.split("\n").filter((line) => line.includes("install -d -o agent -g agent")).join("\n");
  assert.ok(installLines, "the image no longer pre-creates /home/agent's subdirectories");
  for (const dir of ["/home/agent/.local/bin", "/home/agent/bin", "/home/agent/.claude", "/home/agent/.codex", "/home/agent/.npm-global"]) {
    assert.ok(installLines.includes(dir), `the image does not create ${dir} owned by agent`);
  }
  const init = read("containers/bin/cg-init");
  for (const dir of ["/home/agent/.local/bin", "/home/agent/bin"]) {
    assert.ok(init.includes(dir), `containers/bin/cg-init does not create ${dir} on every start`);
  }

  // The spec version the daemon expects is the one the build tags and bakes into the label.
  assert.equal(versions.imageSpecVersion, IMAGE_SPEC_VERSION, "containers/versions.json and image-paths.js disagree on the image spec version");
  assert.match(IMAGE_SPEC_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(read("scripts/build-image.mjs").includes("IMAGE_SPEC_VERSION=${specVersion}"), "the build must bake the spec version into the image label");
});

test("durability: boot says so when the built image is older than the spec this checkout expects", async () => {
  const { __setContainerRuntime, __resetContainerRuntime } = await import("../src/runtimes/container/index.js");
  const stale = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: "" } },
    ],
  });
  __setContainerRuntime({ exec: stale.exec, log: () => {} });
  try {
    const { bootContainerRuntime, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
    const logs = [];
    await bootContainerRuntime({ settings: { ...SETTINGS, enabled: true }, log: (m) => logs.push(m) });
    assert.ok(
      logs.some((m) => m.includes("1.0.0") && m.includes(IMAGE_SPEC_VERSION) && /npm run build:image/.test(m)),
      `no rebuild hint in:\n${logs.join("\n")}`,
    );
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }

  const current = createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: `sha256:img|${IMAGE_SPEC_VERSION}` } },
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: "" } },
    ],
  });
  __setContainerRuntime({ exec: current.exec, log: () => {} });
  try {
    const { bootContainerRuntime, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
    const logs = [];
    await bootContainerRuntime({ settings: { ...SETTINGS, enabled: true }, log: (m) => logs.push(m) });
    assert.ok(!logs.some((m) => /npm run build:image/.test(m)), "a current image must not nag");
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }
});
