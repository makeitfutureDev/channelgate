import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers.js";
import { claimUpdate, readUpdateState, readUpdateStatus, reserveUpdate, releaseUpdate, updateUpdateState } from "../src/gateway/update-state.js";

test("dead updater becomes an interrupted projection preserving durable evidence", () => {
  const root = tempDir("update-interrupted-");
  const { owner } = reserveUpdate({ root, now: 1000 });
  claimUpdate({ root, owner, pid: 999, now: 1000 });
  updateUpdateState({ root, owner, patch: { phase: "rolling_back", changed: true, candidateError: "missing dependency" }, now: 2000 });
  const state = readUpdateStatus({ root, now: 40000, pidAlive: () => false });
  assert.equal(state.status, "terminal");
  assert.equal(state.interrupted, true);
  assert.equal(state.candidateError, "missing dependency");
  assert.match(state.reason, /rolling_back/);
  assert.equal(readUpdateState({ root }).status, "running", "projection does not mutate evidence or owner state");
});

test("live owner never times out; queued reservation has startup grace", () => {
  const root = tempDir("update-live-");
  const { owner } = reserveUpdate({ root, now: 1000 });
  assert.equal(readUpdateStatus({ root, now: 2000, pidAlive: () => false }).status, "running");
  claimUpdate({ root, owner, pid: 999, now: 1000 });
  assert.equal(readUpdateStatus({ root, now: 999999999, pidAlive: () => true }).status, "running");
  releaseUpdate({ root, owner });
  assert.equal(readUpdateStatus({ root, now: 999999999 }).interrupted, true);
});
