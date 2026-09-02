import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";

import {
  claimUpdate,
  finishUpdate,
  isTerminalUpdate,
  isUpdateActive,
  publicUpdateState,
  readUpdateState,
  releaseUpdate,
  reserveUpdate,
  updateUpdateState,
} from "../src/gateway/update-state.js";

function tempRoot() {
  return tempDir("cg-update-state-");
}

function ids() {
  const values = ["tx-1", "owner-1", "tx-2", "owner-2"];
  return () => values.shift();
}

test("first caller reserves one transaction and a second caller sees the active owner", () => {
  const root = tempRoot();
  try {
    const makeId = ids();
    const first = reserveUpdate({ root, source: "slack", now: 1_000, makeId, pidAlive: () => false });
    const second = reserveUpdate({ root, source: "admin-ui", now: 1_001, makeId, pidAlive: () => false });

    assert.equal(first.ok, true);
    assert.equal(first.transaction.id, "tx-1");
    assert.equal(first.owner.token, "owner-1");
    assert.equal(second.ok, false);
    assert.equal(second.transaction.id, first.transaction.id);
    assert.equal(second.owner, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live owner is never stolen and a dead owner is reclaimed", () => {
  const root = tempRoot();
  try {
    const lockFile = path.join(root, "update.lock");
    writeFileSync(lockFile, JSON.stringify({ transactionId: "live", token: "secret", pid: 4321, source: "cli", at: 100 }));
    writeFileSync(path.join(root, "update-state.json"), JSON.stringify({ id: "live", status: "installing", phase: "installing" }));

    assert.equal(isUpdateActive({ root, now: 5_000, pidAlive: (pid) => pid === 4321 }), true);
    assert.equal(isUpdateActive({ root, now: 5_000, pidAlive: () => false }), false);

    const blocked = reserveUpdate({ root, source: "slack", now: 5_000, makeId: ids(), pidAlive: (pid) => pid === 4321 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.transaction.id, "live");

    const reclaimed = reserveUpdate({ root, source: "slack", now: 5_001, makeId: ids(), pidAlive: () => false });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.transaction.id, "tx-1");
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).transactionId, "tx-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh pid-zero reservation gets a spawn grace window but an abandoned one expires", () => {
  const root = tempRoot();
  try {
    const makeId = ids();
    const first = reserveUpdate({ root, source: "mcp", now: 10_000, makeId, pidAlive: () => false, reservationGraceMs: 500 });
    assert.equal(first.ok, true);

    const blocked = reserveUpdate({ root, source: "ui", now: 10_499, makeId, pidAlive: () => false, reservationGraceMs: 500 });
    assert.equal(blocked.ok, false);

    const reclaimed = reserveUpdate({ root, source: "ui", now: 10_501, makeId, pidAlive: () => false, reservationGraceMs: 500 });
    assert.equal(reclaimed.ok, true);
    assert.notEqual(reclaimed.transaction.id, first.transaction.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claim, phase updates, terminal result, and release preserve transaction ownership", () => {
  const root = tempRoot();
  try {
    const reserved = reserveUpdate({ root, source: "slack", now: 100, makeId: ids(), pidAlive: () => false });
    assert.equal(claimUpdate({ root, owner: reserved.owner, pid: 987, now: 110 }), true);

    const installing = updateUpdateState({
      root,
      owner: reserved.owner,
      patch: { phase: "installing", oldRevision: "old", targetRevision: "new", backupPath: "/secret/backup" },
      now: 120,
    });
    assert.equal(installing.phase, "installing");
    assert.equal(installing.status, "running");
    assert.equal(installing.oldRevision, "old");

    const terminal = finishUpdate({
      root,
      owner: reserved.owner,
      result: "updated",
      patch: { phase: "complete", changed: true },
      now: 130,
    });
    assert.equal(isTerminalUpdate(terminal), true);
    assert.equal(terminal.result, "updated");
    assert.equal(terminal.finishedAt, 130);

    assert.equal(releaseUpdate({ root, owner: { ...reserved.owner, token: "wrong" } }), false);
    assert.equal(existsSync(path.join(root, "update.lock")), true);
    assert.equal(releaseUpdate({ root, owner: reserved.owner }), true);
    assert.equal(existsSync(path.join(root, "update.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public state is a strict non-secret projection", () => {
  const projected = publicUpdateState({
    id: "tx",
    source: "slack",
    status: "terminal",
    phase: "complete",
    result: "rolled_back",
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 3,
    oldRevision: "abc",
    targetRevision: "def",
    runningRevision: "abc",
    changed: true,
    reason: "candidate smoke failed",
    candidateError: "safe summary",
    rollbackError: "",
    advisories: { moderate: 2, high: 0, critical: 0 },
    requiredDiskBytes: 4_294_967_296,
    availableDiskBytes: 17_179_869_184,
    optionalDownloadBytes: 1_621_356_544,
    token: "never",
    backupPath: "/private/path",
    stderr: "secret output",
    prompt: "secret prompt",
  });

  assert.deepEqual(projected, {
    id: "tx",
    source: "slack",
    status: "terminal",
    phase: "complete",
    result: "rolled_back",
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 3,
    oldRevision: "abc",
    targetRevision: "def",
    runningRevision: "abc",
    changed: true,
    reason: "candidate smoke failed",
    candidateError: "safe summary",
    rollbackError: "",
    advisories: { moderate: 2, high: 0, critical: 0 },
    requiredDiskBytes: 4_294_967_296,
    availableDiskBytes: 17_179_869_184,
    optionalDownloadBytes: 1_621_356_544,
  });
  assert.equal("backupPath" in projected, false);
  assert.equal("token" in projected, false);
});

test("corrupt state reads as null and terminal finish is idempotent", () => {
  const root = tempRoot();
  try {
    writeFileSync(path.join(root, "update-state.json"), "{not json");
    assert.equal(readUpdateState({ root }), null);

    const reserved = reserveUpdate({ root, source: "cli", now: 1, makeId: ids(), pidAlive: () => false });
    const first = finishUpdate({ root, owner: reserved.owner, result: "refused", patch: { reason: "dirty tree" }, now: 2 });
    const second = finishUpdate({ root, owner: reserved.owner, result: "failed", patch: { reason: "must not replace" }, now: 3 });
    assert.equal(second.result, first.result);
    assert.equal(second.reason, first.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
