import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readUpdateState, reserveUpdate } from "../src/gateway/update-state.js";
import { tempDir } from "./helpers.js";
import {
  baselineFailure,
  evaluateAudit,
  executeUpdateTransaction,
  noServiceRefusal,
  readinessFailure,
  requiredDiskBytes,
  runCommand,
  serviceProbes,
  validSystemdPid,
  builtImageSpecVersion,
  containerSettings,
  defaultImageBuild,
  expectedImageSpecVersion,
} from "../scripts/update-runner.mjs";

test("update command failures are plain-language while the raw status stays structured", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(1)"], { quiet: true, timeoutMs: 1_000 }),
    (error) => {
      assert.match(error.message, /failed because it reported a general error/i);
      assert.equal(error.exitCode, 1);
      assert.doesNotMatch(error.message, /exit code|exited 1|code 1/i);
      return true;
    },
  );
});

function tempRoot() {
  return tempDir("cg-update-runner-");
}

function reserve(root) {
  return reserveUpdate({
    root,
    source: "test",
    makeId: (() => {
      const ids = ["tx-test", "owner-test"];
      return () => ids.shift();
    })(),
    pidAlive: () => false,
  });
}

test("disk requirement includes temporary optional Whisper space", () => {
  const basic = requiredDiskBytes({ whisperEnabled: false, modelExists: false });
  const whisper = requiredDiskBytes({ whisperEnabled: true, modelExists: false });
  const existing = requiredDiskBytes({ whisperEnabled: true, modelExists: true });
  assert.equal(basic, 1024 ** 3);
  assert.equal(whisper, 3 * 1024 ** 3); // Linux only: the release asset needs no build staging
  assert.equal(existing, basic);
});

test("high or critical npm advisories fail while moderate advisories are reported", () => {
  assert.deepEqual(evaluateAudit({ metadata: { vulnerabilities: { moderate: 2, high: 0, critical: 0 } } }), {
    ok: true,
    advisories: { moderate: 2, high: 0, critical: 0 },
  });
  assert.equal(evaluateAudit({ metadata: { vulnerabilities: { moderate: 0, high: 1, critical: 0 } } }).ok, false);
  assert.equal(evaluateAudit({ metadata: { vulnerabilities: { moderate: 0, high: 0, critical: 1 } } }).ok, false);
  assert.throws(() => evaluateAudit({ malformed: true }), /audit output/i);
});

test("readiness requires a replacement instance on the expected revision with Claude and prior Slack connectivity", () => {
  const base = {
    ok: true,
    instanceId: "new-instance",
    revision: "target",
    claude: { available: true },
    slack: { connected: true },
  };
  assert.equal(readinessFailure(base, { previousInstanceId: "old-instance", expectedRevision: "target", requireSlack: true }), "");
  assert.match(readinessFailure({ ...base, instanceId: "old-instance" }, { previousInstanceId: "old-instance", expectedRevision: "target" }), /instance/i);
  assert.match(readinessFailure({ ...base, revision: "wrong" }, { previousInstanceId: "old-instance", expectedRevision: "target" }), /revision/i);
  assert.match(readinessFailure({ ...base, claude: { available: false } }, { previousInstanceId: "old-instance", expectedRevision: "target" }), /Claude/i);
  assert.match(
    readinessFailure({ ...base, slack: { connected: false } }, { previousInstanceId: "old-instance", expectedRevision: "target", requireSlack: true }),
    /Slack/i,
  );
  assert.equal(
    readinessFailure({ ...base, slack: { connected: false } }, { previousInstanceId: "old-instance", expectedRevision: "target", requireSlack: false }),
    "",
  );
});

test("preflight health must be the healthy daemon actually serving the checkout revision", () => {
  const base = {
    ok: true,
    instanceId: "current-instance",
    revision: "old",
    claude: { available: true },
  };
  assert.equal(baselineFailure(base, { expectedRevision: "old" }), "");
  assert.match(baselineFailure({ ...base, ok: false }, { expectedRevision: "old" }), /health/i);
  assert.match(baselineFailure({ ...base, instanceId: "" }, { expectedRevision: "old" }), /instance/i);
  assert.match(baselineFailure({ ...base, revision: "other" }, { expectedRevision: "old" }), /revision/i);
  assert.match(baselineFailure({ ...base, claude: { available: false } }, { expectedRevision: "old" }), /Claude/i);
});

test("systemd restart accepts only a safe positive MainPID", () => {
  assert.equal(validSystemdPid("123"), 123);
  assert.equal(validSystemdPid("1"), 0);
  assert.equal(validSystemdPid("0"), 0);
  assert.equal(validSystemdPid("12x"), 0);
  assert.equal(validSystemdPid(""), 0);
});

test("candidate success follows the transaction phases and releases the lock", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const reserved = reserve(root);
    const state = await executeUpdateTransaction({
      root,
      owner: reserved.owner,
      ops: {
        claim: async () => calls.push("claim"),
        preflight: async () => {
          calls.push("preflight");
          return {
            oldRevision: "old",
            targetRevision: "new",
            previousInstanceId: "instance-old",
            requireSlack: true,
            service: { kind: "systemd", scope: "system", unit: "channelgate.service" },
            needBytes: 4 * 1024 ** 3,
            availableBytes: 16 * 1024 ** 3,
            optionalDownloadBytes: 1_621_356_544,
          };
        },
        snapshot: async () => calls.push("snapshot"),
        checkout: async () => calls.push("checkout"),
        install: async ({ rollback }) => calls.push(rollback ? "install-old" : "install-new"),
        audit: async () => {
          calls.push("audit");
          return { moderate: 1, high: 0, critical: 0 };
        },
        test: async () => calls.push("test"),
        provision: async () => calls.push("provision"),
        restart: async () => calls.push("restart"),
        verify: async ({ expectedRevision }) => {
          calls.push(`verify-${expectedRevision}`);
          return { instanceId: "instance-new", revision: expectedRevision };
        },
        restore: async () => calls.push("restore"),
      },
    });

    assert.equal(state.result, "updated");
    assert.equal(state.runningRevision, "new");
    assert.equal(state.changed, true);
    assert.equal(state.requiredDiskBytes, 4 * 1024 ** 3);
    assert.equal(state.availableDiskBytes, 16 * 1024 ** 3);
    assert.equal(state.optionalDownloadBytes, 1_621_356_544);
    assert.deepEqual(calls, [
      "claim",
      "preflight",
      "snapshot",
      "checkout",
      "install-new",
      "audit",
      "test",
      "provision",
      "restart",
      "verify-new",
    ]);
    assert.equal(readUpdateState({ root }).result, "updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate failure after checkout restores dependencies, restarts, verifies old revision, and reports rollback", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const reserved = reserve(root);
    const state = await executeUpdateTransaction({
      root,
      owner: reserved.owner,
      ops: {
        claim: async () => calls.push("claim"),
        preflight: async () => ({
          oldRevision: "old",
          targetRevision: "new",
          previousInstanceId: "instance-old",
          requireSlack: true,
          service: { kind: "systemd" },
        }),
        snapshot: async () => calls.push("snapshot"),
        checkout: async () => calls.push("checkout"),
        install: async ({ rollback }) => calls.push(rollback ? "install-old" : "install-new"),
        audit: async () => ({ moderate: 0, high: 0, critical: 0 }),
        test: async () => calls.push("test"),
        provision: async () => {
          calls.push("provision");
          throw new Error("candidate provisioning exploded\nsecret detail");
        },
        restart: async () => calls.push("restart"),
        verify: async ({ expectedRevision }) => {
          calls.push(`verify-${expectedRevision}`);
          return { instanceId: `instance-${expectedRevision}`, revision: expectedRevision };
        },
        restore: async () => calls.push("restore"),
      },
    });

    assert.equal(state.result, "rolled_back");
    assert.equal(state.runningRevision, "old");
    assert.equal(state.candidateError, "candidate provisioning exploded");
    assert.deepEqual(calls, [
      "claim",
      "snapshot",
      "checkout",
      "install-new",
      "test",
      "provision",
      "restore",
      "install-old",
      "restart",
      "verify-old",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight refusal does not mutate Git or attempt rollback", async () => {
  const root = tempRoot();
  const calls = [];
  try {
    const reserved = reserve(root);
    const error = new Error("tracked worktree is dirty");
    error.code = "EUPDATE_REFUSED";
    const state = await executeUpdateTransaction({
      root,
      owner: reserved.owner,
      ops: {
        claim: async () => calls.push("claim"),
        preflight: async () => {
          calls.push("preflight");
          throw error;
        },
        snapshot: async () => calls.push("snapshot"),
        checkout: async () => calls.push("checkout"),
        restore: async () => calls.push("restore"),
      },
    });
    assert.equal(state.result, "refused");
    assert.equal(state.reason, "tracked worktree is dirty");
    assert.deepEqual(calls, ["claim", "preflight"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback failure reports both candidate and rollback errors", async () => {
  const root = tempRoot();
  try {
    const reserved = reserve(root);
    const state = await executeUpdateTransaction({
      root,
      owner: reserved.owner,
      ops: {
        claim: async () => {},
        preflight: async () => ({
          oldRevision: "old",
          targetRevision: "new",
          previousInstanceId: "instance-old",
          requireSlack: false,
          service: { kind: "systemd", scope: "user", unit: "channelgate.service" },
        }),
        snapshot: async () => {},
        checkout: async () => {},
        install: async ({ rollback }) => {
          if (!rollback) throw new Error("candidate install failed");
        },
        audit: async () => ({ moderate: 0, high: 0, critical: 0 }),
        test: async () => {},
        provision: async () => {},
        restart: async () => {},
        verify: async () => ({}),
        restore: async () => {
          throw new Error("git restore failed");
        },
      },
    });
    assert.equal(state.result, "failed");
    assert.equal(state.candidateError, "candidate install failed");
    assert.equal(state.rollbackError, "git restore failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service detection probes systemd only, both scopes, system first", () => {
  // Linux only: systemd is the one service manager, so the probe list has no platform-derived
  // variant left and the refusal never names a manager that cannot exist here. The system scope
  // goes first because the documented install is the hardened system unit.
  assert.deepEqual(serviceProbes(), [
    { kind: "systemd", scope: "system", args: [] },
    { kind: "systemd", scope: "user", args: ["--user"] },
  ]);
  assert.deepEqual(serviceProbes("darwin"), serviceProbes()); // whatever the caller passes
  assert.match(noServiceRefusal("linux"), /^no active systemd gateway service was detected on linux$/);
  assert.doesNotMatch(noServiceRefusal("linux"), /launchd/);
});

test("Linux systemd detection covers the user scope, not just the system unit", () => {
  // The documented install is a hardened system unit, but plenty of single-user boxes run
  // ~/.config/systemd/user/channelgate.service, which system-scope `is-active` reports as
  // inactive (exit 4). Those boxes were told no gateway service existed at all.
  const probes = serviceProbes();
  assert.deepEqual(probes.map((p) => p.scope), ["system", "user"]);
  assert.deepEqual(probes.map((p) => p.args), [[], ["--user"]]);
});

// ── The channel image is rebuilt as part of the update ────────────────────────────────────────
// A container channel runs the IMAGE, not the checkout. Before this, an update that pulled a new
// `containers/` or bumped the image spec left every container channel on the old toolchain until
// an operator happened to read the boot warning and run `npm run build:image` by hand.

function containerRoot({ image = "channelgate/runtime:latest" } = {}) {
  const root = tempDir("cg-update-image-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "settings.json"), JSON.stringify({ containerImage: image, containerCli: "podman" }));
  return root;
}

// A repoRoot whose containers/versions.json declares `spec`.
function candidateCheckout(spec) {
  const repoRoot = tempDir("cg-update-checkout-");
  mkdirSync(path.join(repoRoot, "containers"), { recursive: true });
  writeFileSync(path.join(repoRoot, "containers", "versions.json"), JSON.stringify({ imageSpecVersion: spec }));
  return repoRoot;
}

// A `run` stand-in: answers `git diff` and the image-label inspect, records the build invocation.
function fakeRun({ changed = [], builtVersion = "1.1.1", buildFails = false } = {}) {
  const calls = [];
  const run = async (command, args = []) => {
    calls.push([command, ...args].join(" "));
    if (command === "git") return { code: 0, stdout: `${changed.join("\n")}\n`, stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") {
      const format = String(args[3] || "");
      if (format.includes("cg.image.version")) return { code: builtVersion === null ? 1 : 0, stdout: builtVersion === null ? "" : `${builtVersion}\n`, stderr: "" };
      return { code: 0, stdout: "sha256:deadbeef\n", stderr: "" };
    }
    if (String(args[0] || "").endsWith("build-image.mjs")) {
      if (buildFails) throw new Error("podman build exploded");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, built: () => calls.some((c) => c.includes("build-image.mjs")) };
}

test("the update rebuilds the channel image when this revision's image spec moved", async () => {
  const root = containerRoot();
  const repoRoot = candidateCheckout("1.2.0");
  const logs = [];
  const fake = fakeRun({ builtVersion: "1.1.1", changed: ["src/gateway/run.js"] });

  const result = await defaultImageBuild({
    root, repoRoot, context: { oldRevision: "old", targetRevision: "new" }, run: fake.run, log: (m) => logs.push(m),
  });

  assert.equal(result.built, true);
  assert.equal(result.imageId, "sha256:deadbeef");
  assert.equal(fake.built(), true, "scripts/build-image.mjs must run");
  // The operator is warned it takes minutes BEFORE it starts, and told the resulting image id.
  assert.match(logs.join("\n"), /takes several minutes/i);
  assert.match(logs.join("\n"), /sha256:deadbeef/);
  // The decision is made from the CANDIDATE checkout's versions.json, never the constant this
  // process imported before `git merge` moved the tree underneath it.
  assert.equal(expectedImageSpecVersion(repoRoot), "1.2.0");
});

test("a change under containers/ rebuilds and an unrelated change does not", async () => {
  const root = containerRoot();
  const repoRoot = candidateCheckout("1.1.1");
  const context = { oldRevision: "old", targetRevision: "new" };

  const unrelated = fakeRun({ changed: ["src/gateway/run.js", "docs/OPERATIONS.md"] });
  const skipped = await defaultImageBuild({ root, repoRoot, context, run: unrelated.run, log: () => {} });
  assert.equal(skipped.needed, false);
  assert.equal(unrelated.built(), false, "an update that cannot have changed the image must not spend minutes rebuilding it");

  const sources = fakeRun({ changed: ["containers/Containerfile"] });
  assert.equal((await defaultImageBuild({ root, repoRoot, context, run: sources.run, log: () => {} })).built, true);
});

test("a failed image build reports the remedy and never blocks the update", async () => {
  const root = containerRoot();
  const repoRoot = candidateCheckout("1.2.0");
  const logs = [];
  const fake = fakeRun({ builtVersion: "1.1.1", buildFails: true });

  const result = await defaultImageBuild({
    root, repoRoot, context: { oldRevision: "old", targetRevision: "new" }, run: fake.run, log: (m) => logs.push(m),
  });

  assert.equal(result.failed, true);
  assert.equal(result.built, false);
  assert.match(logs.join("\n"), /npm run build:image/);
  assert.match(logs.join("\n"), /Continuing with the update/i);
});

test("the image step runs after provisioning and before the restart, and a throwing one still restarts", async () => {
  for (const failing of [false, true]) {
    const root = tempDir("cg-update-image-tx-");
    const calls = [];
    const reserved = reserveUpdate({ root, source: "test", makeId: (() => { const ids = ["tx-img", "owner-img"]; return () => ids.shift(); })(), pidAlive: () => false });
    const state = await executeUpdateTransaction({
      root,
      owner: reserved.owner,
      ops: {
        preflight: async () => ({ oldRevision: "old", targetRevision: "new", previousInstanceId: "instance-old", service: { kind: "systemd" } }),
        snapshot: async () => {},
        checkout: async () => {},
        install: async () => {},
        audit: async () => ({ moderate: 0, high: 0, critical: 0 }),
        test: async () => {},
        provision: async () => calls.push("provision"),
        image: async () => {
          calls.push("image");
          if (failing) throw new Error("podman build exploded");
        },
        restart: async () => calls.push("restart"),
        verify: async ({ expectedRevision }) => {
          calls.push(`verify-${expectedRevision}`);
          return { instanceId: "instance-new", revision: expectedRevision };
        },
        restore: async () => calls.push("restore"),
      },
    });

    assert.deepEqual(calls, ["provision", "image", "restart", "verify-new"], failing ? "a failed build must not stop the restart" : "the build sits between provisioning and the restart");
    assert.equal(state.result, "updated", "a container image build must never roll the daemon back");
    assert.equal(state.runningRevision, "new");
  }
});

test("container settings and the built image label come from the running install, not the checkout", async () => {
  const root = containerRoot({ image: "registry.example/cg:pinned" });
  assert.deepEqual(containerSettings(root), { image: "registry.example/cg:pinned", cli: "podman" });
  // No settings file at all (a first install) is the defaults, not a crash — and every install
  // runs containers, so there is no "off" reading of a missing file.
  assert.deepEqual(containerSettings(tempDir("cg-no-settings-")), { image: "channelgate/runtime:latest", cli: "auto" });

  const labelled = fakeRun({ builtVersion: "1.1.0" });
  assert.equal(await builtImageSpecVersion({ cli: "podman", image: "cg:1", run: labelled.run }), "1.1.0");
  // No image, no label, or no usable CLI all read as "nothing built" — which needsImageBuild()
  // turns into a build rather than a silent skip.
  const absent = fakeRun({ builtVersion: null });
  assert.equal(await builtImageSpecVersion({ cli: "podman", image: "cg:1", run: absent.run }), "");
  assert.equal(await builtImageSpecVersion({ cli: "auto", image: "", run: absent.run }), "");
  // `auto` tries podman before docker, exactly like the daemon's own probe.
  const autoRun = fakeRun({ builtVersion: null });
  await builtImageSpecVersion({ cli: "auto", image: "cg:1", run: autoRun.run });
  assert.deepEqual(autoRun.calls.map((c) => c.split(" ")[0]), ["podman", "docker"]);
});
