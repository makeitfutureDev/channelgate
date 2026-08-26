import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectCodexChildAccounting,
  normalizeCodexTokenUsage,
  readCodexRootAccounting,
  snapshotCodexUsage,
} from "../src/engines/codex-usage.js";

const line = (event) => JSON.stringify(event) + "\n";
const meta = (id, timestamp, extra = {}) => ({ timestamp, type: "session_meta", payload: { id, session_id: id, timestamp, source: "exec", ...extra } });
const context = (timestamp, model = "gpt-5.6-sol") => ({ timestamp, type: "turn_context", payload: { model } });
const task = (timestamp, type, turnId, second) => ({ timestamp, type: "event_msg", payload: { type, turn_id: turnId, ...(type === "task_started" ? { started_at: second } : { completed_at: second }) } });
const tokens = (timestamp, input, cached, output, lastInput, lastCached, lastOutput) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    last_token_usage: { input_tokens: lastInput, cached_input_tokens: lastCached, output_tokens: lastOutput },
    model_context_window: 258400,
  } },
});

test("root accounting records the serialized turn delta and its request detail", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
  const sessions = path.join(state, "sessions", "2026", "08", "16");
  await mkdir(sessions, { recursive: true });
  const id = "root-session";
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  await writeFile(file, [
    meta(id, "2026-08-16T00:00:00.100Z"),
    context("2026-08-16T00:00:00.200Z"),
    task("2026-08-16T00:00:00.300Z", "task_started", "turn-1", 1786838400),
    tokens("2026-08-16T00:00:01.000Z", 100, 40, 5, 100, 40, 5),
    tokens("2026-08-16T00:00:02.000Z", 250, 140, 12, 150, 100, 7),
    task("2026-08-16T00:00:03.000Z", "task_complete", "turn-1", 1786838403),
  ].map(line).join(""));
  const accounting = await readCodexRootAccounting({
    stateDir: state,
    sessionId: id,
    snapshot: { file: "", total: {} },
    terminalUsage: { input_tokens: 250, cached_input_tokens: 140, output_tokens: 12 },
    startedAtMs: 1786838400_000,
  });
  assert.equal(accounting.usage.input_tokens, 250);
  assert.equal(accounting.usage.output_tokens, 12);
  assert.equal(accounting.requests.length, 2);
  assert.equal(accounting.exactRequests, true);
  assert.equal(accounting.model, "gpt-5.6-sol");

  const beforeResume = await snapshotCodexUsage(state, id);
  await appendFile(file, [
    task("2026-08-16T00:01:00.000Z", "task_started", "turn-2", 1786838460),
    context("2026-08-16T00:01:00.100Z"),
    tokens("2026-08-16T00:01:01.000Z", 400, 240, 20, 150, 100, 8),
    task("2026-08-16T00:01:02.000Z", "task_complete", "turn-2", 1786838462),
  ].map(line).join(""));
  const resumed = await readCodexRootAccounting({
    stateDir: state,
    sessionId: id,
    snapshot: beforeResume,
    terminalUsage: { input_tokens: 400, cached_input_tokens: 240, output_tokens: 20 },
    startedAtMs: 1786838460_000,
  });
  assert.deepEqual(
    { input: resumed.usage.input_tokens, cached: resumed.usage.cached_input_tokens, output: resumed.usage.output_tokens },
    { input: 150, cached: 100, output: 8 },
  );
});

test("child accounting excludes the copied fork prefix at second precision", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "codex-child-"));
  const sessions = path.join(state, "sessions", "2026", "08", "16");
  await mkdir(sessions, { recursive: true });
  const childId = "child-session";
  const childFile = path.join(sessions, `rollout-${childId}.jsonl`);
  await writeFile(childFile, [
    meta(childId, "2026-08-16T00:02:00.723Z", {
      parent_thread_id: "root-session",
      source: { subagent: { thread_spawn: { parent_thread_id: "root-session" } } },
    }),
    context("2026-08-16T00:02:00.723Z"),
    tokens("2026-08-16T00:01:59.000Z", 250, 140, 12, 150, 100, 7),
    task("2026-08-16T00:02:00.724Z", "task_started", "child-turn", 1786838520),
    tokens("2026-08-16T00:02:01.000Z", 370, 230, 22, 120, 90, 10),
    task("2026-08-16T00:02:02.000Z", "task_complete", "child-turn", 1786838522),
  ].map(line).join(""));
  const children = await collectCodexChildAccounting({
    stateDir: state,
    rootSessionId: "root-session",
    startedAtMs: 1786838400_000,
    endedAtMs: 1786838600_000,
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].usage.input_tokens, 120);
  assert.equal(children[0].usage.output_tokens, 10);
  assert.equal(children[0].requests.length, 1);
});

test("normalization supports official nested cache details", () => {
  assert.deepEqual(normalizeCodexTokenUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
    output_tokens: 4,
  }), {
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_input_tokens: 20,
    output_tokens: 4,
    reasoning_output_tokens: 0,
    total_tokens: 104,
  });
});

