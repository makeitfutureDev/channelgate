// Does a stop of the daemon's own systemd unit also end the channel containers? The inspector
// answers from the kernel's cgroup files and systemd's view of the unit; the boot log, the health
// endpoint and scripts/repair-service-unit.sh act on the answer. Nothing here touches systemd.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeCli, inspectLine } from "./container-fake-cli.js";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { createServiceUnitInspector, parseCgroupPath, unitOfCgroup, cgroupInside, SAFE_KILL_MODES, SERVICE_UNIT_REPAIR } = await import("../src/runtimes/container/service-unit.js");
const { createContainerCli } = await import("../src/runtimes/container/cli.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_CGROUP = "0::/system.slice/channelgate.service\n";
const USER_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/channelgate.service\n";

// A host as the inspector sees it: /proc/<pid>/cgroup texts and systemd's answer for the unit.
function host({ self = SYSTEM_CGROUP, pids = {}, killMode = "mixed", env = { INVOCATION_ID: "abc" } } = {}) {
  const calls = [];
  const state = { killMode, clock: 0 };
  const inspector = createServiceUnitInspector({
    env,
    readText: async (file) => {
      const pid = file.split("/")[2];
      const text = pid === "self" ? self : pids[pid];
      if (text === undefined || text === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    run: async (args) => { calls.push(args); if (state.killMode instanceof Error) throw state.killMode; return `${state.killMode}\n`; },
    now: () => state.clock,
  });
  return { inspector, calls, state };
}

test("cgroup paths: the unified line, systemd's v1 hierarchy, and the unit a path belongs to", () => {
  assert.equal(parseCgroupPath("0::/system.slice/channelgate.service\n"), "/system.slice/channelgate.service");
  assert.equal(parseCgroupPath("12:pids:/x\n1:name=systemd:/system.slice/channelgate.service\n"), "/system.slice/channelgate.service");
  assert.equal(parseCgroupPath("12:pids:/x\n"), "");
  assert.equal(parseCgroupPath(""), "");

  assert.deepEqual(unitOfCgroup("/system.slice/channelgate.service"), { unit: "channelgate.service", scope: "system", root: "/system.slice/channelgate.service" });
  // A delegated unit may move its own processes into a sub-cgroup; the unit is still the root.
  assert.deepEqual(unitOfCgroup("/system.slice/channelgate.service/supervisor"), { unit: "channelgate.service", scope: "system", root: "/system.slice/channelgate.service" });
  assert.deepEqual(unitOfCgroup("/user.slice/user-1000.slice/user@1000.service/app.slice/channelgate.service"), {
    unit: "channelgate.service", scope: "user", root: "/user.slice/user-1000.slice/user@1000.service/app.slice/channelgate.service",
  });
  // A terminal session, a container scope, the user manager itself: no service unit to stop.
  assert.equal(unitOfCgroup("/user.slice/user-1000.slice/session-3.scope"), null);
  assert.equal(unitOfCgroup("/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-abc.scope/container"), null);
  assert.equal(unitOfCgroup("/user.slice/user-1000.slice/user@1000.service"), null);
  assert.equal(unitOfCgroup("/"), null);

  assert.equal(cgroupInside("/system.slice/channelgate.service", "/system.slice/channelgate.service"), true);
  assert.equal(cgroupInside("/system.slice/channelgate.service/x", "/system.slice/channelgate.service"), true);
  assert.equal(cgroupInside("/system.slice/channelgate.service2", "/system.slice/channelgate.service"), false);
  assert.equal(cgroupInside("/anything", ""), false);
  assert.deepEqual([...SAFE_KILL_MODES], ["process", "none"]);
});

test("a system unit whose containers share its cgroup under KillMode=mixed is named, with the one-command remedy", async () => {
  const h = host({ pids: { 4001: SYSTEM_CGROUP } });
  const facts = await h.inspector.inspect({ cgroupManager: "cgroupfs", containerPids: [4001] });
  assert.deepEqual({ ...facts, advice: "" }, {
    managed: true, unit: "channelgate.service", scope: "system", killMode: "mixed", shared: true, killsContainers: true, advice: "",
  });
  assert.match(facts.advice, /Every stop or restart of channelgate\.service also ends this gateway's channel containers/);
  assert.match(facts.advice, /KillMode=mixed/);
  assert.ok(facts.advice.includes(SERVICE_UNIT_REPAIR));
  assert.match(facts.advice, /no restart is needed/);
  assert.deepEqual(h.calls, [["show", "--property=KillMode", "--value", "channelgate.service"]]);

  // systemd's default reaches the whole group too.
  h.state.killMode = "control-group";
  h.inspector.forget();
  assert.equal((await h.inspector.inspect({ cgroupManager: "cgroupfs" })).killsContainers, true);
});

test("KillMode=process or none, or containers in scopes of their own, need no advice", async () => {
  for (const killMode of ["process", "none"]) {
    const safe = host({ pids: { 4001: SYSTEM_CGROUP }, killMode });
    const facts = await safe.inspector.inspect({ cgroupManager: "cgroupfs", containerPids: [4001] });
    assert.equal(facts.killsContainers, false, killMode);
    assert.equal(facts.advice, "");
    assert.equal(facts.shared, true);
  }
  // The user-service shape: the systemd cgroup manager gives every container its own scope.
  const scoped = host({
    self: USER_CGROUP,
    pids: { 4001: "0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-abc.scope/container\n" },
  });
  const facts = await scoped.inspector.inspect({ cgroupManager: "systemd", containerPids: [4001] });
  assert.equal(facts.scope, "user");
  assert.equal(facts.shared, false);
  assert.equal(facts.advice, "");
  assert.deepEqual(scoped.calls[0], ["--user", "show", "--property=KillMode", "--value", "channelgate.service"]);
});

test("a running container's real cgroup decides; the cgroup manager only answers when none is running", async () => {
  // cgroupfs in the probe, but the one running container sits outside the unit: not shared.
  const outside = host({ pids: { 4001: "0::/user.slice/other.scope\n" } });
  assert.equal((await outside.inspector.inspect({ cgroupManager: "cgroupfs", containerPids: [4001] })).shared, false);
  // The systemd manager in the probe, but a container measurably inside the unit: shared.
  const inside = host({ pids: { 4001: "0::/system.slice/channelgate.service\n" } });
  assert.equal((await inside.inspector.inspect({ cgroupManager: "systemd", containerPids: [4001] })).killsContainers, true);
  // Nothing running (every pid unreadable or 0): the manager answers.
  const idle = host();
  assert.equal((await idle.inspector.inspect({ cgroupManager: "cgroupfs", containerPids: [0, 4009] })).killsContainers, true);
  assert.equal((await idle.inspector.inspect({ cgroupManager: "systemd", containerPids: [] })).killsContainers, false);
  // A user unit names the manual edit: the repair script only knows system units.
  const user = host({ self: USER_CGROUP });
  const advice = (await user.inspector.inspect({ cgroupManager: "cgroupfs" })).advice;
  assert.match(advice, /systemctl --user daemon-reload/);
  assert.ok(!advice.includes(SERVICE_UNIT_REPAIR));
});

test("every unknown answers no advice: no systemd, no unit, no cgroup manager, a silent systemctl", async () => {
  const terminal = host({ env: {} });
  assert.deepEqual(await terminal.inspector.inspect({ cgroupManager: "cgroupfs", containerPids: [] }), {
    managed: false, unit: "", scope: "", killMode: "", shared: null, killsContainers: false, advice: "",
  });
  assert.equal(terminal.calls.length, 0, "systemctl is never asked outside a service");

  const session = host({ self: "0::/user.slice/user-1000.slice/session-3.scope\n", env: { JOURNAL_STREAM: "8:1" } });
  assert.equal((await session.inspector.inspect({ cgroupManager: "cgroupfs" })).managed, false);
  const unreadable = host({ self: null });
  assert.equal((await unreadable.inspector.inspect({ cgroupManager: "cgroupfs" })).managed, false);

  const noManager = host();
  const unknown = await noManager.inspector.inspect({ cgroupManager: "", containerPids: [] });
  assert.equal(unknown.shared, null);
  assert.equal(unknown.advice, "");

  for (const answer of ["", "Failed to connect to bus: No such file or directory", new Error("spawn systemctl ENOENT")]) {
    const silent = host({ killMode: answer });
    const facts = await silent.inspector.inspect({ cgroupManager: "cgroupfs" });
    assert.equal(facts.killMode, "");
    assert.equal(facts.killsContainers, false);
    assert.equal(facts.advice, "");
  }
});

test("systemd is asked at most once a minute, and a repaired unit clears the advice on the next read", async () => {
  const h = host();
  assert.equal((await h.inspector.inspect({ cgroupManager: "cgroupfs" })).killsContainers, true);
  h.state.killMode = "process"; // the operator ran the repair script
  h.state.clock = 30_000;
  assert.equal((await h.inspector.inspect({ cgroupManager: "cgroupfs" })).killsContainers, true, "still the cached answer");
  assert.equal(h.calls.length, 1);
  h.state.clock = 61_000;
  const facts = await h.inspector.inspect({ cgroupManager: "cgroupfs" });
  assert.equal(facts.killMode, "process");
  assert.equal(facts.advice, "");
  assert.equal(h.calls.length, 2);
});

test("the probe reports Podman's cgroup manager and never a docker daemon's driver", async () => {
  const podman = createFakeCli({
    kind: "podman",
    routes: [{ match: (a) => a[1] === "info", result: { code: 0, stdout: JSON.stringify({ host: { cgroupManager: "cgroupfs", cgroupVersion: "v2", security: { rootless: true } }, version: { Version: "4.9.3" } }) } }],
  });
  assert.equal((await createContainerCli({ exec: podman.exec }).probe({ cli: "auto" }, {})).cgroupManager, "cgroupfs");
  assert.equal((await createContainerCli({ exec: createFakeCli({ kind: "podman" }).exec }).probe({ cli: "auto" }, {})).cgroupManager, "systemd");
  const docker = createFakeCli({
    kind: "docker", rootless: true,
    routes: [{ match: (a) => a[1] === "info", result: { code: 0, stdout: JSON.stringify({ ServerVersion: "29.6.1", CgroupDriver: "cgroupfs", SecurityOptions: ["name=rootless"] }) } }],
  });
  assert.equal((await createContainerCli({ exec: docker.exec }).probe({ cli: "auto" }, {})).cgroupManager, "");
  assert.equal((await createContainerCli({ exec: createFakeCli({ available: [] }).exec }).probe({ cli: "auto" }, {})).cgroupManager, "");
});

test("boot logs the advice once and the health status carries it; a safe unit says nothing", async () => {
  const { __setContainerRuntime, __resetContainerRuntime, bootContainerRuntime, containerRuntimeStatus, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
  const settings = { enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest", idleMinutes: 10, maxRunning: 8 };
  const fake = () => createFakeCli({
    kind: "podman",
    routes: [
      { match: (a) => a[1] === "image" && a[2] === "inspect", result: { code: 0, stdout: "sha256:img|1.0.0" } },
      { match: (a) => a[1] === "ps", result: { code: 0, stdout: "id1\n" } },
      { match: (a) => a[1] === "inspect", result: { code: 0, stdout: inspectLine({ name: "cg-mine", status: "running", install: currentInstallId(), channel: "mine", imageId: "sha256:img" }) } },
    ],
  });
  const seen = [];
  const unsafe = host();
  __setContainerRuntime({ exec: fake().exec, log: () => {}, serviceUnit: { inspect: async (input) => { seen.push(input); return unsafe.inspector.inspect({ ...input, cgroupManager: "cgroupfs" }); } } });
  try {
    const logs = [];
    const status = await bootContainerRuntime({ settings, log: (m) => logs.push(m) });
    assert.equal(status.service.killsContainers, true);
    assert.deepEqual(Object.keys(status.service).sort(), ["advice", "killMode", "killsContainers", "scope", "unit"]);
    assert.equal(logs.filter((m) => /^\[container\] WARNING: Every stop or restart of channelgate\.service/.test(m)).length, 1);
    assert.equal(seen[0].cgroupManager, "systemd", "the probe's cgroup manager reaches the inspector");
    const health = await containerRuntimeStatus(settings);
    assert.equal(health.service.unit, "channelgate.service");
    assert.ok(health.service.advice.includes(SERVICE_UNIT_REPAIR));
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }

  __setContainerRuntime({ exec: fake().exec, log: () => {}, serviceUnit: host({ killMode: "process" }).inspector });
  try {
    const logs = [];
    const status = await bootContainerRuntime({ settings, log: (m) => logs.push(m) });
    assert.equal(status.service.advice, "");
    assert.ok(!logs.some((m) => /WARNING: Every stop or restart/.test(m)));
    // An inspector that throws never fails a boot or a health read.
    __setContainerRuntime({ exec: fake().exec, log: () => {}, serviceUnit: { inspect: async () => { throw new Error("boom"); } } });
    assert.deepEqual((await containerRuntimeStatus(settings)).service, { unit: "", scope: "", killMode: "", killsContainers: false, advice: "" });
    stopContainerRuntime();
  } finally {
    __resetContainerRuntime();
  }
});

test("the admin UI prints the advice in the container runtime status line", () => {
  const ui = readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.match(ui, /if \(state\.service\?\.advice\) bits\.push\(state\.service\.advice\);/);
});

// ── scripts/repair-service-unit.sh ────────────────────────────────────────────────────────────
// Run for real against a scratch unit directory, with a stub `systemctl` first on PATH that
// records its calls and answers `show` from a file.
function repairFixture({ unit = null, effective = "process", name = "channelgate.service" } = {}) {
  const dir = tempDir("cg-unit-");
  const systemDir = path.join(dir, "system");
  const bin = path.join(dir, "bin");
  mkdirSync(systemDir);
  mkdirSync(bin);
  const callsFile = path.join(dir, "systemctl.calls");
  writeFileSync(callsFile, "");
  writeFileSync(path.join(dir, "effective"), effective);
  writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${callsFile}"\ncase "$1" in show) cat "${path.join(dir, "effective")}" ;; esac\nexit 0\n`);
  chmodSync(path.join(bin, "systemctl"), 0o755);
  const file = path.join(systemDir, name);
  if (unit !== null) { writeFileSync(file, unit); chmodSync(file, 0o644); }
  const run = (args = []) => new Promise((resolve) => {
    execFile("bash", [path.join(root, "scripts/repair-service-unit.sh"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, CG_SYSTEMD_SYSTEM_DIR: systemDir }, encoding: "utf8",
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  return { file, run, calls: () => readFileSync(callsFile, "utf8").split("\n").filter(Boolean) };
}

const OLD_UNIT = "[Unit]\nDescription=ChannelGate\n\n[Service]\nType=simple\nUser=channelgate\n# SIGTERM only the daemon\nKillMode=mixed\nTimeoutStopSec=45\nDelegate=yes\n\n[Install]\nWantedBy=multi-user.target\n";

test("repair-service-unit.sh rewrites KillMode in place, reloads systemd, restarts nothing, and is idempotent", async () => {
  const fx = repairFixture({ unit: OLD_UNIT });
  const first = await fx.run();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /KillMode=process written/);
  assert.match(first.out, /No restart is needed/);
  const text = readFileSync(fx.file, "utf8");
  assert.deepEqual(text.match(/^KillMode=.*$/gm), ["KillMode=process"]);
  assert.equal(text.replace("KillMode=process\n", ""), OLD_UNIT.replace("KillMode=mixed\n", ""), "nothing else in the unit changes");
  assert.equal(statSync(fx.file).mode & 0o777, 0o644);
  assert.deepEqual(fx.calls(), ["daemon-reload", "show --property=KillMode --value channelgate.service"]);
  assert.ok(!fx.calls().some((call) => /restart|stop|start/.test(call)));

  const second = await fx.run();
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /already keeps its containers/);
  assert.equal(readFileSync(fx.file, "utf8"), text);
  assert.equal(fx.calls().filter((call) => call === "daemon-reload").length, 1, "an unchanged unit is not reloaded");
});

test("repair-service-unit.sh adds the line to a unit that has none, and repairs the pre-rename unit", async () => {
  const fx = repairFixture({ unit: "[Unit]\nDescription=x\n\n[Service]\nExecStart=/usr/bin/node src/start.js\n", name: "claude-gateway.service" });
  const result = await fx.run();
  assert.equal(result.code, 0, result.out);
  assert.equal(readFileSync(fx.file, "utf8"), "[Unit]\nDescription=x\n\n[Service]\nKillMode=process\nExecStart=/usr/bin/node src/start.js\n");
  assert.ok(fx.calls().includes("show --property=KillMode --value claude-gateway.service"));
});

test("repair-service-unit.sh fails loudly: no unit, no [Service] section, a drop-in that still overrides, stray arguments", async () => {
  const none = await repairFixture().run();
  assert.equal(none.code, 1);
  assert.match(none.out, /No system unit found/);
  assert.match(none.out, /systemctl --user daemon-reload/);

  const broken = repairFixture({ unit: "[Unit]\nDescription=x\n" });
  const brokenResult = await broken.run();
  assert.equal(brokenResult.code, 1);
  assert.match(brokenResult.out, /no \[Service\] section/);
  assert.equal(readFileSync(broken.file, "utf8"), "[Unit]\nDescription=x\n");

  const overridden = repairFixture({ unit: OLD_UNIT, effective: "control-group" });
  const overriddenResult = await overridden.run();
  assert.equal(overriddenResult.code, 1);
  assert.match(overriddenResult.out, /still reports KillMode=control-group/);
  assert.match(overriddenResult.out, /drop-in/);

  const args = await repairFixture({ unit: OLD_UNIT }).run(["--restart"]);
  assert.equal(args.code, 2);
});
