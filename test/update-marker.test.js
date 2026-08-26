// Restart-safe update reporting. A marker binds one Slack thread to one durable transaction;
// intermediate candidate boots must not consume it, and only the matching terminal result may be
// reported. The detached start path is tested here too so every entry point shares the same lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
import { finishUpdate, releaseUpdate, reserveUpdate } from "../src/gateway/update-state.js";

const scratch = ensureTestEnv();
const markerPath = path.join(scratch, "update-pending.json");

const {
  clearUpdateMarker,
  formatUpdateResult,
  readTerminalUpdateMarker,
  readUpdateMarker,
  startUpdate,
  writeUpdateMarker,
} = await import("../src/gateway/updater.js");

test("no marker present → read returns null", () => {
  clearUpdateMarker();
  assert.equal(readUpdateMarker(), null);
});

test("write is skipped when there is no thread to confirm on (admin-UI button path)", () => {
  clearUpdateMarker();
  writeUpdateMarker({ channelId: "", threadTs: "" });
  assert.equal(existsSync(markerPath), false);
  writeUpdateMarker({ channelId: "C1", threadTs: "" }); // channel but no thread
  assert.equal(existsSync(markerPath), false);
  writeUpdateMarker({}); // nothing at all
  assert.equal(existsSync(markerPath), false);
});

test("write with thread context → roundtrips, binding the exact transaction", () => {
  clearUpdateMarker();
  writeUpdateMarker({ transactionId: "tx-123", channelId: "C123", threadTs: "1783.55", userId: "U9" });
  const m = readUpdateMarker();
  assert.equal(m.transactionId, "tx-123");
  assert.equal(m.channelId, "C123");
  assert.equal(m.threadTs, "1783.55");
  assert.equal(m.userId, "U9");
  assert.equal(typeof m.fromVersion, "string");
  assert.equal(typeof m.at, "number");
  assert.ok(m.at > 0);
});

test("clear consumes the marker so it can never re-fire on a later boot", () => {
  writeUpdateMarker({ transactionId: "tx-clear", channelId: "C123", threadTs: "1783.55", userId: "U9" });
  assert.notEqual(readUpdateMarker(), null);
  assert.equal(clearUpdateMarker("another-transaction"), false);
  assert.notEqual(readUpdateMarker(), null);
  assert.equal(clearUpdateMarker("tx-clear"), true);
  assert.equal(readUpdateMarker(), null);
  assert.equal(existsSync(markerPath), false);
});

test("an intermediate boot keeps the marker; the matching terminal result exposes it", () => {
  clearUpdateMarker();
  const reserved = reserveUpdate({ root: scratch, source: "slack" });
  writeUpdateMarker({
    transactionId: reserved.transaction.id,
    channelId: "C123",
    threadTs: "1783.55",
    userId: "U9",
  });

  assert.equal(readTerminalUpdateMarker({ root: scratch }), null);
  assert.notEqual(readUpdateMarker(), null);

  finishUpdate({
    root: scratch,
    owner: reserved.owner,
    result: "rolled_back",
    patch: {
      reason: "Candidate failed and the previous revision was restored.",
      candidateError: "post-restart Claude smoke failed",
      runningRevision: "abc123",
    },
  });
  releaseUpdate({ root: scratch, owner: reserved.owner });

  const ready = readTerminalUpdateMarker({ root: scratch });
  assert.equal(ready.marker.transactionId, reserved.transaction.id);
  assert.equal(ready.transaction.result, "rolled_back");
  assert.notEqual(readUpdateMarker(), null, "the caller clears only after Slack accepts the report");
  clearUpdateMarker(reserved.transaction.id);
});

test("startUpdate reserves once, binds the marker, and keeps its owner token out of argv", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cg-updater-start-"));
  try {
    const calls = [];
    const child = {
      pid: process.pid,
      once() {},
      unref() {},
    };
    const spawnImpl = (...args) => {
      calls.push(args);
      return child;
    };

    const first = startUpdate(
      {
        root,
        source: "slack",
        context: { channelId: "C1", threadTs: "1.2", userId: "U1" },
      },
      { spawnImpl },
    );
    const second = startUpdate({ root, source: "admin-ui" }, { spawnImpl });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.transaction.id, first.transaction.id);
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(-2), ["--transaction", first.transaction.id]);
    assert.equal(args.includes(options.env.CG_UPDATE_OWNER_TOKEN), false);
    assert.equal(readUpdateMarker({ root }).transactionId, first.transaction.id);
  } finally {
    clearUpdateMarker(undefined, { root });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synchronous spawn failure becomes a terminal failed transaction and releases the lock", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cg-updater-spawn-fail-"));
  try {
    const result = startUpdate(
      { root, source: "admin-ui" },
      {
        spawnImpl() {
          throw new Error("spawn exploded");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.transaction.result, "failed");
    assert.match(result.transaction.reason, /spawn exploded/);

    const retry = startUpdate(
      { root, source: "admin-ui" },
      { spawnImpl: () => ({ pid: process.pid, once() {}, unref() {} }) },
    );
    assert.equal(retry.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal update results have explicit operator-facing summaries", () => {
  assert.match(formatUpdateResult({ result: "updated", changed: true, runningRevision: "new" }), /Update complete.*new/i);
  assert.match(formatUpdateResult({ result: "updated", changed: false, runningRevision: "same" }), /already up to date/i);
  assert.match(formatUpdateResult({ result: "rolled_back", runningRevision: "old", candidateError: "smoke failed" }), /rolled back.*old/i);
  assert.match(formatUpdateResult({ result: "refused", reason: "dirty tree" }), /refused.*dirty tree/i);
  assert.match(formatUpdateResult({ result: "failed", candidateError: "candidate", rollbackError: "rollback" }), /automatic rollback also failed/i);
});
