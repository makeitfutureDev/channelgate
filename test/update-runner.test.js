import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readUpdateState, reserveUpdate } from "../src/gateway/update-state.js";
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
  return mkdtempSync(path.join(os.tmpdir(), "cg-update-runner-"));
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
  const basic = requiredDiskBytes({ whisperEnabled: false, modelExists: false, platform: "linux" });
  const linuxWhisper = requiredDiskBytes({ whisperEnabled: true, modelExists: false, platform: "linux" });
  const macWhisper = requiredDiskBytes({ whisperEnabled: true, modelExists: false, platform: "darwin" });
  const existing = requiredDiskBytes({ whisperEnabled: true, modelExists: true, platform: "darwin" });
  assert.equal(basic, 1024 ** 3);
  assert.ok(linuxWhisper >= 3 * 1024 ** 3);
  assert.ok(macWhisper > linuxWhisper);
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
            service: { kind: "launchd" },
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
          service: { kind: "launchd" },
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

test("service detection probes only the managers the platform actually has", () => {
  // macOS has launchd and no systemctl; Linux is the reverse. Probing the absent one only buys a
  // guaranteed ENOENT and a refusal message naming a service manager that cannot exist here.
  assert.deepEqual(serviceProbes("darwin").map((p) => p.kind), ["launchd"]);
  assert.deepEqual(serviceProbes("linux").map((p) => p.kind), ["systemd", "systemd"]);
  assert.match(noServiceRefusal("darwin"), /launchd/);
  assert.doesNotMatch(noServiceRefusal("darwin"), /systemd/);
  assert.match(noServiceRefusal("linux"), /systemd/);
  assert.doesNotMatch(noServiceRefusal("linux"), /launchd/);
  // An unknown platform stays permissive rather than refusing outright.
  assert.deepEqual(serviceProbes("freebsd").map((p) => p.kind), ["systemd", "systemd", "launchd"]);
});

test("Linux systemd detection covers the user scope, not just the system unit", () => {
  // The documented install is a hardened system unit, but plenty of single-user boxes run
  // ~/.config/systemd/user/channelgate.service, which system-scope `is-active` reports as
  // inactive (exit 4). Those boxes were told no gateway service existed at all.
  const probes = serviceProbes("linux");
  assert.deepEqual(probes.map((p) => p.scope), ["system", "user"]);
  assert.deepEqual(probes.map((p) => p.args), [[], ["--user"]]);
});
