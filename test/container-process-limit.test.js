// The container process limit: reading it from the host, reclaiming a full container before a
// turn is exec'd into it, naming it in the failure it caused, and the default that made four
// browser sessions enough to hit it.
//
// The incident these pin (2026-11-18): a turn left four headless browsers running in its channel
// container — 1,000 of 1,024 process slots. Claude Code could not start a thread and aborted; the
// automatic resume was exec'd into the same full container and aborted within seconds; every
// manual retry did the same, and the agent could not run `kill` to help itself.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeCli, inspectLine } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { readPidsCounters, pidsPressure, describePidsUse, CONTAINER_DEFAULT_PIDS_LIMIT, PIDS_PRESSURE_RATIO } = await import("../src/runtimes/container/pids-pressure.js");
const { createContainerCli } = await import("../src/runtimes/container/cli.js");
const { createContainerImage } = await import("../src/runtimes/container/image.js");
const { createContainerLifecycle, parseInspectLine, INSPECT_FORMAT } = await import("../src/runtimes/container/lifecycle.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { annotateProcessLimit, containerProcessNotice, containerProcessNoticeKind } = await import("../src/gateway/process-limit.js");
const { processLimitNote, runtimeAccessPreamble } = await import("../src/gateway/runtime-access.js");
const { runFailureDiagnostics } = await import("../src/util/process-outcome.js");
const { raiseLegacyPidsLimitDefault, getContainerRuntime } = await import("../src/config/settings.js");
const { OPTIONAL_METHODS } = await import("../src/runtimes/contract.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};

function target(slug) {
  return resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container" }, { isAdminAuthor: true, settings: SETTINGS });
}

// A fake /proc + /sys/fs/cgroup pair holding one container's counters.
function cgroupFixture({ pid = 4242, membership = "0::/user.slice/libpod-abc.scope", dir = "user.slice/libpod-abc.scope", current = "10", max = "1024", events = "max 0\n" } = {}) {
  const root = tempDir("cg-pids-");
  const procDir = path.join(root, "proc");
  const cgroupDir = path.join(root, "cgroup");
  mkdirSync(path.join(procDir, String(pid)), { recursive: true });
  writeFileSync(path.join(procDir, String(pid), "cgroup"), `${membership}\n`);
  const leaf = path.join(cgroupDir, dir);
  mkdirSync(leaf, { recursive: true });
  if (current != null) writeFileSync(path.join(leaf, "pids.current"), `${current}\n`);
  if (max != null) writeFileSync(path.join(leaf, "pids.max"), `${max}\n`);
  if (events != null) writeFileSync(path.join(leaf, "pids.events"), events);
  return { pid, procDir, cgroupDir };
}

// ── The host-side reader ────────────────────────────────────────────────────────────────────────

test("readPidsCounters: reads the kernel's counters for the container's cgroup, v2 and v1", async () => {
  const v2 = cgroupFixture({ current: "1023", max: "1024", events: "max 1434\n" });
  assert.deepEqual(await readPidsCounters(v2), { current: 1023, max: 1024, deniedTotal: 1434 });

  const v1 = cgroupFixture({
    membership: "12:memory:/docker/abc\n7:cpu,pids:/docker/abc\n1:name=systemd:/docker/abc",
    dir: "pids/docker/abc", current: "37", max: "512", events: null,
  });
  assert.deepEqual(await readPidsCounters(v1), { current: 37, max: 512, deniedTotal: 0 });
});

test("readPidsCounters: no cap is a reading with max null; anything unreadable is unknown", async () => {
  assert.deepEqual(await readPidsCounters(cgroupFixture({ max: "max" })), { current: 10, max: null, deniedTotal: 0 });
  // A pid that is not a container init, a missing process, counters that are not there.
  assert.equal(await readPidsCounters({ ...cgroupFixture(), pid: 0 }), null);
  assert.equal(await readPidsCounters({ ...cgroupFixture(), pid: 1 }), null);
  assert.equal(await readPidsCounters({ ...cgroupFixture(), pid: 999_999 }), null);
  assert.equal(await readPidsCounters(cgroupFixture({ current: null })), null);
  // A cgroup namespace that hides the ancestors: whatever it resolved to is not this container's cap.
  assert.equal(await readPidsCounters(cgroupFixture({ membership: "0::/../../libpod-abc.scope" })), null);
  assert.equal(await readPidsCounters(cgroupFixture({ membership: "0::/" })), null);
});

test("pidsPressure: exhausted from 85% of the limit, never without a limit or a reading", () => {
  assert.equal(PIDS_PRESSURE_RATIO, 0.85);
  assert.deepEqual(pidsPressure({ current: 1000, max: 1024 }), { current: 1000, max: 1024, free: 24, exhausted: true });
  assert.equal(pidsPressure({ current: 870, max: 1024 }).exhausted, true);
  assert.equal(pidsPressure({ current: 869, max: 1024 }).exhausted, false);
  assert.equal(pidsPressure({ current: 3000, max: 4096 }).exhausted, false);
  assert.equal(pidsPressure({ current: 5000, max: null }).exhausted, false);
  assert.equal(pidsPressure(null).exhausted, false);
  assert.equal(describePidsUse({ current: 1023, max: 1024 }), "1,023 of 1,024");
});

test("the inspect format carries the init pid, and an older 10-field line still parses", () => {
  assert.ok(INSPECT_FORMAT.endsWith("|{{.State.Pid}}"));
  assert.equal(parseInspectLine(inspectLine({ pid: 4242 })).pid, 4242);
  assert.equal(parseInspectLine(inspectLine({ pid: 0 })).pid, 0);
  assert.equal(parseInspectLine(inspectLine().split("|").slice(0, 10).join("|")).pid, 0);
});

// ── ensureUp ────────────────────────────────────────────────────────────────────────────────────

function harness({ counters = null, alive = () => true } = {}) {
  const state = { exists: false };
  const reads = [];
  const box = { counters };
  const fake = createFakeCli({
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      {
        match: (a) => a[1] === "inspect",
        result: () => (state.exists
          ? { code: 0, stdout: inspectLine({ ...state, install: currentInstallId() }) }
          : { code: 125, stderr: "Error: no such container" }),
      },
      // A stop really stops: the next inspect must not report a live init.
      { match: (a) => a[1] === "stop", result: () => { state.status = "exited"; state.pid = 0; return { code: 0 }; } },
      { match: (a) => a[1] === "start", result: () => { state.status = "running"; state.pid = (state.nextPid ||= 5000) + 1; state.nextPid += 1; return { code: 0 }; } },
    ],
  });
  const logs = [];
  const cli = createContainerCli({ exec: fake.exec, log: (m) => logs.push(m) });
  const image = createContainerImage({ cli });
  const reaper = createContainerReaper({ log: (m) => logs.push(m) });
  const lifecycle = createContainerLifecycle({
    cli, image, reaper, log: (m) => logs.push(m),
    readPids: async ({ pid }) => { reads.push(pid); return typeof box.counters === "function" ? box.counters(pid) : box.counters; },
    pidAlive: (pid) => alive(pid),
  });
  return { fake, reaper, lifecycle, logs, state, reads, box };
}

// Bring the container up once, then make `inspect` report it running with the stamped fingerprints.
async function running(h, t, { pid = 4242 } = {}) {
  await h.lifecycle.ensureUp(t, {});
  Object.assign(h.state, { exists: true, status: "running", pid, fingerprint: t.container.fingerprint, mountFingerprint: t.container.mountFingerprint });
  h.fake.reset();
  h.reads.length = 0;
}

test("ensureUp: a full container with nobody else inside is restarted before the turn is exec'd into it", async () => {
  const h = harness();
  const t = target("pids-reclaim");
  await running(h, t);
  h.box.counters = { current: 1000, max: 1024, deniedTotal: 50 };
  // The turn's own lease, taken before ensureUp exactly as run.js does: it is not "someone else".
  const lease = h.reaper.acquireLease(t, { kind: "run", id: "r1" });
  const result = await h.lifecycle.ensureUp(t, { lease, reclaimProcesses: true });

  assert.deepEqual(h.reads, [4242]);
  assert.deepEqual(h.fake.find("stop").map((a) => a.slice(1)), [["stop", "-t", "10", t.container.name]]);
  assert.equal(h.fake.find("start").length, 1);
  assert.equal(h.fake.find("rm").length, 0, "a restart, never a recreate: nothing about the container's configuration changed");
  // Stop comes before start.
  const verbs = h.fake.calls.map((c) => c.argv[1]).filter((v) => v === "stop" || v === "start");
  assert.deepEqual(verbs, ["stop", "start"]);
  assert.deepEqual(result.reclaimed, { current: 1000, max: 1024 });
  assert.equal(result.started, true);
  assert.equal(result.processPressure, null);
  assert.ok(h.logs.some((line) => /out of process slots \(1,000 of 1,024\).*restarting/.test(line)));
  lease.release();
});

test("ensureUp: a full container with other work inside is left alone and reported", async () => {
  const h = harness();
  const t = target("pids-shared");
  await running(h, t);
  h.box.counters = { current: 1010, max: 1024, deniedTotal: 3 };
  const job = h.reaper.acquireLease(t, { kind: "job", id: "j1" });
  const lease = h.reaper.acquireLease(t, { kind: "run", id: "r1" });
  const result = await h.lifecycle.ensureUp(t, { lease, reclaimProcesses: true });

  assert.equal(h.fake.find("stop").length, 0);
  assert.equal(h.fake.find("start").length, 0);
  assert.equal(result.reclaimed, null);
  assert.deepEqual(result.processPressure, { current: 1010, max: 1024, others: 1 });
  job.release();
  lease.release();
});

test("ensureUp: room to work, no cap, or an unreadable cgroup never restarts anything", async () => {
  for (const counters of [{ current: 400, max: 1024, deniedTotal: 0 }, { current: 9000, max: null, deniedTotal: 0 }, null]) {
    const h = harness();
    const t = target(`pids-quiet-${counters ? (counters.max ?? "nocap") : "unknown"}`);
    await running(h, t);
    h.box.counters = counters;
    const result = await h.lifecycle.ensureUp(t, { reclaimProcesses: true });
    assert.equal(h.fake.find("stop").length, 0);
    assert.equal(result.reclaimed, null);
    assert.equal(result.processPressure, null);
    assert.equal(result.started, false);
  }
  // A reader that throws is "unknown", not a failed run.
  const h = harness();
  const t = target("pids-throws");
  await running(h, t);
  h.box.counters = () => { throw new Error("EACCES"); };
  assert.equal((await h.lifecycle.ensureUp(t, { reclaimProcesses: true })).reclaimed, null);
});

test("ensureUp: only a caller that can announce it restarts a full container", async () => {
  // The memory reviewer, an SSH session, `/resume` inspection and a carry all call ensureUp without
  // the flag: a silent restart would end processes the next turn was counting on.
  const h = harness();
  const t = target("pids-optin");
  await running(h, t);
  h.box.counters = { current: 1000, max: 1024, deniedTotal: 50 };
  const result = await h.lifecycle.ensureUp(t, {});
  assert.equal(h.fake.find("stop").length, 0);
  assert.equal(result.reclaimed, null);
  assert.deepEqual(result.processPressure, { current: 1000, max: 1024, others: 0 });
});

test("ensureUp: a restart that fails leaves the container as it was and the turn is still attempted", async () => {
  const h = harness();
  const t = target("pids-stopfail");
  await running(h, t);
  h.box.counters = { current: 1000, max: 1024, deniedTotal: 50 };
  h.fake.addRoute({ match: (a) => a[1] === "stop", result: { code: 125, stderr: "Error: timed out waiting for the container to stop" } });
  const result = await h.lifecycle.ensureUp(t, { reclaimProcesses: true });
  assert.equal(h.fake.find("start").length, 0);
  assert.equal(result.reclaimed, null);
  assert.equal(result.started, false);
  assert.deepEqual(result.processPressure, { current: 1000, max: 1024, others: 0 });
  assert.ok(h.logs.some((line) => /could not restart .* to clear its processes/.test(line)));
});

test("ensureUp: a stopped container is started as before, with no pressure read", async () => {
  const h = harness();
  const t = target("pids-stopped");
  await running(h, t);
  Object.assign(h.state, { status: "exited", pid: 0 });
  h.box.counters = { current: 1024, max: 1024, deniedTotal: 9 };
  const result = await h.lifecycle.ensureUp(t, { reclaimProcesses: true });
  assert.deepEqual(h.reads, []);
  assert.equal(result.reclaimed, null);
  assert.equal(result.started, true);
});

// ── The post-mortem ─────────────────────────────────────────────────────────────────────────────

test("processLimitStatus: counts only the starts refused since this turn's ensureUp", async () => {
  const h = harness();
  const t = target("pids-postmortem");
  await running(h, t);
  h.box.counters = { current: 300, max: 1024, deniedTotal: 40 };
  await h.lifecycle.ensureUp(t, {});
  // The turn ran, hit the limit 50 times and died with the container still full.
  h.box.counters = { current: 1023, max: 1024, deniedTotal: 90 };
  assert.deepEqual(await h.lifecycle.processLimitStatus(t), { current: 1023, max: 1024, exhausted: true, full: false, denied: 50 });
  h.box.counters = { current: 1024, max: 1024, deniedTotal: 90 };
  assert.equal((await h.lifecycle.processLimitStatus(t)).full, true);
  // The tree died and freed its slots: the refusals are still the evidence.
  h.box.counters = { current: 12, max: 1024, deniedTotal: 90 };
  assert.deepEqual(await h.lifecycle.processLimitStatus(t), { current: 12, max: 1024, exhausted: false, full: false, denied: 50 });
  // A restarted container (new init pid) counts from zero, not from the old baseline.
  h.state.pid = 7777;
  h.box.counters = { current: 20, max: 1024, deniedTotal: 2 };
  assert.equal((await h.lifecycle.processLimitStatus(t)).denied, 2);
  // No cap, no reading, no running container: unknown.
  h.box.counters = { current: 20, max: null, deniedTotal: 0 };
  assert.equal(await h.lifecycle.processLimitStatus(t), null);
  h.box.counters = null;
  assert.equal(await h.lifecycle.processLimitStatus(t), null);
  h.state.status = "exited";
  h.box.counters = { current: 1, max: 1024, deniedTotal: 1 };
  assert.equal(await h.lifecycle.processLimitStatus(t), null);
});

test("annotateProcessLimit: a death the limit caused says so, with the kernel's numbers", async () => {
  const died = () => Object.assign(new Error("Claude crashed after aborting itself: Aborted (core dumped)"), {
    details: { engine: "claude", exitCode: 134, processEnded: true },
  });
  const runtimeWith = (status) => ({ runtime: { inspectProcessLimit: async () => status } });

  const full = await annotateProcessLimit(died(), runtimeWith({ current: 1023, max: 1024, exhausted: true, full: false, denied: 50 }));
  assert.equal(full.message, "Claude crashed after aborting itself: Aborted (core dumped) — this channel's container ran out of process slots (1,023 of 1,024 in use; the limit refused 50 new processes during this turn).");
  // The appended sentence must never trip the session-recovery classifiers, which match these
  // words on one line of an engine's own message.
  assert.doesNotMatch(full.message.split(" — ")[1], /thread|fork|session/i);
  assert.deepEqual(full.details.processLimit, { current: 1023, max: 1024, denied: 50 });
  assert.equal(full.details.exitCode, 134, "the original facts stay");

  const freed = await annotateProcessLimit(died(), runtimeWith({ current: 12, max: 1024, exhausted: false, full: false, denied: 1 }));
  assert.match(freed.message, /12 of 1,024 in use; the limit refused 1 new process during this turn\)\.$/);

  const stillFull = await annotateProcessLimit(died(), runtimeWith({ current: 1024, max: 1024, exhausted: true, full: true, denied: 0 }));
  assert.match(stillFull.message, /\(1,024 of 1,024 in use\)\.$/);
});

test("annotateProcessLimit: no evidence, no probe, a stop or a provider error leave the failure untouched", async () => {
  const original = "Claude crashed after aborting itself: Aborted (core dumped)";
  const make = (details = {}, name = "Error") => Object.assign(new Error(original), { name, details: { processEnded: true, ...details } });
  const evidence = { runtime: { inspectProcessLimit: async () => ({ current: 1023, max: 1024, exhausted: true, full: false, denied: 9 }) } };

  for (const [error, tgt] of [
    [make(), { runtime: { inspectProcessLimit: async () => ({ current: 30, max: 1024, exhausted: false, full: false, denied: 0 }) } }],
    // Nearly full is not evidence: an engine that stalled in a busy container did not die of the limit.
    [make(), { runtime: { inspectProcessLimit: async () => ({ current: 3500, max: 4096, exhausted: true, full: false, denied: 0 }) } }],
    [make(), { runtime: { inspectProcessLimit: async () => null } }],
    [make(), { runtime: { inspectProcessLimit: async () => { throw new Error("podman is gone"); } } }],
    [make(), { runtime: {} }],
    [make(), undefined],
    [make({ explicitStop: true }), evidence],
    [make({ providerError: true }), evidence],
    [make({}, "AbortError"), evidence],
  ]) {
    const out = await annotateProcessLimit(error, tgt);
    assert.equal(out, error);
    assert.equal(out.message, original);
    assert.equal(out.details.processLimit, undefined);
  }
  // A probe that never answers does not hold the failure hostage.
  const startedAt = Date.now();
  const hung = await annotateProcessLimit(make(), { runtime: { inspectProcessLimit: () => new Promise(() => {}) } }, { timeoutMs: 30 });
  assert.equal(hung.message, original);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("the event log keeps the process-limit numbers and nothing else", () => {
  const error = Object.assign(new Error("x"), { details: { engine: "claude", processEnded: true, processLimit: { current: 1023, max: 1024, denied: 50, note: "<@U1> secret" } } });
  assert.deepEqual(runFailureDiagnostics(error).processLimit, { current: 1023, max: 1024, denied: 50 });
  assert.equal("processLimit" in runFailureDiagnostics(new Error("y")), false);
});

// ── What the reader and the engine are told ─────────────────────────────────────────────────────

test("the answer note says what was done about a full container, and nothing otherwise", () => {
  assert.equal(containerProcessNotice({ created: false, started: false }), "");
  assert.equal(containerProcessNotice(null), "");
  const restarted = containerProcessNotice({ reclaimed: { current: 1000, max: 1024 } });
  assert.match(restarted, /^⚠️ _This channel's container had run out of process slots \(1,000 of 1,024 in use/);
  assert.match(restarted, /restarted before this turn\. Browser sessions, dev servers and anything else left running in it are gone\._\n\n$/);
  const shared = containerProcessNotice({ processPressure: { current: 1010, max: 1024, others: 1 } });
  assert.match(shared, /nearly out of process slots \(1,010 of 1,024 in use\) and other work is still running in it, so it could not be cleared\./);
  // Nobody else inside, but it could not be restarted either: no claim about other work.
  const stuck = containerProcessNotice({ processPressure: { current: 1000, max: 1024, others: 0 } });
  assert.match(stuck, /\(1,000 of 1,024 in use\) and could not be cleared\./);
  assert.doesNotMatch(stuck, /other work is still running/);
  assert.deepEqual([{ reclaimed: {} }, { processPressure: {} }, {}, null].map(containerProcessNoticeKind), ["reclaimed", "pressure", "", ""]);
});

test("every container attempt is told its process budget; a reclaim is told once it happened", () => {
  const t = target("pids-preamble");
  // Before ensureUp settles the applied limits there is no number to state.
  assert.equal(processLimitNote(t), "");
  t.container.appliedLimits = { pidsLimit: 4096, memory: "", cpus: "" };
  const standing = processLimitNote(t);
  assert.match(standing, /^Process limit for this container: \*\*4,096\*\* processes and threads in total, shared by every thread and job in this channel\./);
  assert.match(standing, /A headless browser session takes roughly 250/);
  assert.match(standing, /`agent-browser --session <name> close`/);
  assert.doesNotMatch(standing, /restarted this container/);
  assert.ok(runtimeAccessPreamble(t, { clean: true, allowNetwork: false }).includes(standing), "clean mode keeps the runtime facts");

  t.container.processReclaim = { current: 1000, max: 1024 };
  assert.match(processLimitNote(t), /The gateway restarted this container just before this attempt because it had run out of process slots \(1,000 of 1,024 in use\)/);
  t.container.processReclaim = null;
  t.container.processPressure = { current: 1010, max: 1024, others: 1 };
  assert.match(processLimitNote(t), /nearly out of process slots right now \(1,010 of 1,024 in use\) while other work is running in it/);

  // A runtime that applies no cap, and a host run, say nothing.
  const uncapped = target("pids-preamble-uncapped");
  uncapped.container.appliedLimits = null;
  assert.equal(processLimitNote(uncapped), "");
  assert.equal(processLimitNote({ backend: "host" }), "");
  assert.equal(processLimitNote(undefined), "");
});

// ── The default ─────────────────────────────────────────────────────────────────────────────────

test("the default process limit is 4,096, and the backend may declare the post-mortem probe", () => {
  assert.equal(CONTAINER_DEFAULT_PIDS_LIMIT, 4096);
  assert.equal(getContainerRuntime().pidsLimit, 4096);
  assert.ok(OPTIONAL_METHODS.includes("inspectProcessLimit"));
});

test("a stored old default is raised once at boot; a deliberate value, and a later 1,024, are kept", () => {
  const boot = (stored) => {
    const saves = [];
    const out = raiseLegacyPidsLimitDefault({ read: () => stored, save: (patch) => { saves.push(patch); Object.assign(stored, patch); } });
    return { out, saves };
  };
  // The Settings page stored 1024 with every other container field: nobody chose it.
  const legacy = { containerPidsLimit: 1024 };
  assert.deepEqual(boot(legacy), { out: 4096, saves: [{ containerPidsLimit: 4096, containerPidsLimitRev: 2 }] });
  // An operator who then sets 1,024 on purpose keeps it across every later boot.
  legacy.containerPidsLimit = 1024;
  assert.deepEqual(boot(legacy), { out: null, saves: [] });
  assert.equal(legacy.containerPidsLimit, 1024);
  // Any other stored value was a choice; a fresh install has nothing stored and gets the default.
  for (const stored of [{ containerPidsLimit: 512 }, { containerPidsLimit: 2048 }, {}]) {
    const before = stored.containerPidsLimit;
    assert.deepEqual(boot(stored), { out: null, saves: [{ containerPidsLimitRev: 2 }] });
    assert.equal(stored.containerPidsLimit, before);
  }
});

test("ensureUp: a container Podman lists as running whose process is gone is removed and recreated", async () => {
  let dead = false;
  const h = harness({ alive: () => !dead });
  const t = target("dead-running");
  await running(h, t);
  dead = true;
  await h.lifecycle.ensureUp(t, {});
  assert.ok(h.fake.calls.some((c) => c.argv[1] === "rm"), "the dead container is removed");
  assert.ok(h.fake.calls.some((c) => c.argv[1] === "create" || c.argv[1] === "run"), "and created again");
  assert.ok(h.logs.some((m) => /listed as running but its process 4242 is gone/.test(m)));
});
