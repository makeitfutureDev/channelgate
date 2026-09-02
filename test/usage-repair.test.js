import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/index.js";
import { autoRepairCodexUsageHistory, buildCodexHistoryRepair, pendingCodexRepair } from "../src/gateway/usage-repair.js";

const event = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload }) + "\n";
const token = (timestamp, input, output, lastInput, lastOutput) => event(timestamp, "event_msg", {
  type: "token_count",
  info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output },
    last_token_usage: { input_tokens: lastInput, cached_input_tokens: 0, output_tokens: lastOutput },
    model_context_window: 258400,
  },
});

// A two-turn root session (cumulative totals 100/5 then 250/12) plus one fork-spawned child that
// consumed 40/1 of its own after copying the parent prefix.
async function writeRolloutFixture() {
  const state = await mkdtemp(path.join(os.tmpdir(), "usage-repair-"));
  const dir = path.join(state, "sessions", "2026", "08", "16");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "rollout-root-history.jsonl"), [
    event("2026-08-16T00:00:00.100Z", "session_meta", { id: "root-history", session_id: "root-history", timestamp: "2026-08-16T00:00:00.100Z", source: "exec" }),
    event("2026-08-16T00:00:00.200Z", "turn_context", { model: "gpt-5.6-sol" }),
    event("2026-08-16T00:00:00.300Z", "event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1786838400 }),
    token("2026-08-16T00:00:01.000Z", 100, 5, 100, 5),
    event("2026-08-16T00:00:03.000Z", "event_msg", { type: "task_complete", turn_id: "turn-1", completed_at: 1786838403 }),
    event("2026-08-16T00:01:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-2", started_at: 1786838460 }),
    token("2026-08-16T00:01:03.000Z", 250, 12, 150, 7),
    event("2026-08-16T00:01:04.000Z", "event_msg", { type: "task_complete", turn_id: "turn-2", completed_at: 1786838464 }),
  ].join(""));
  await writeFile(path.join(dir, "rollout-child-history.jsonl"), [
    event("2026-08-16T00:01:01.723Z", "session_meta", {
      id: "child-history",
      session_id: "root-history",
      timestamp: "2026-08-16T00:01:01.723Z",
      parent_thread_id: "root-history",
      source: { subagent: { thread_spawn: { parent_thread_id: "root-history" } } },
    }),
    event("2026-08-16T00:01:01.724Z", "turn_context", { model: "gpt-5.6-sol" }),
    token("2026-08-16T00:01:01.725Z", 100, 5, 100, 5),
    event("2026-08-16T00:01:01.726Z", "event_msg", { type: "task_started", turn_id: "child-turn", started_at: 1786838461 }),
    token("2026-08-16T00:01:02.000Z", 140, 6, 40, 1),
    event("2026-08-16T00:01:03.000Z", "event_msg", { type: "task_complete", turn_id: "child-turn", completed_at: 1786838463 }),
  ].join(""));
  return state;
}

test("history repair maps cumulative root rows to per-turn deltas and attaches fork-owned child usage", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY, ts TEXT, channel_id TEXT, slug TEXT, author_id TEXT,
      engine TEXT, model TEXT, task_kind TEXT, tokens_in INTEGER, tokens_out INTEGER,
      cost_usd REAL, cost_estimated INTEGER, duration_ms INTEGER
    );
    CREATE TABLE sessions (slug TEXT, thread_key TEXT, session_id TEXT, engine TEXT);
  `);
  db.prepare("INSERT INTO sessions VALUES('test-channel', 'thread', 'root-history', 'codex')").run();
  db.prepare("INSERT INTO usage VALUES(1, '2026-08-16T00:00:03.100Z', 'C', 'test-channel', 'U', 'codex', 'gpt-5.6-sol', 'interactive', 100, 5, NULL, 1, 3000)").run();
  db.prepare("INSERT INTO usage VALUES(2, '2026-08-16T00:01:04.100Z', 'C', 'test-channel', 'U', 'codex', 'gpt-5.6-sol', 'interactive', 250, 12, NULL, 1, 4000)").run();

  const state = await writeRolloutFixture();
  const plan = await buildCodexHistoryRepair({ db, stateDir: state, cutoffUsageId: 2 });
  assert.equal(plan.matched.length, 2);
  assert.deepEqual(plan.matched.map((item) => item.root.usage.input_tokens), [100, 150]);
  assert.equal(plan.matched[1].children.length, 1);
  assert.equal(plan.matched[1].children[0].usage.input_tokens, 40);
  assert.deepEqual(plan.unmatchedRows, []);
  assert.deepEqual(plan.unmatchedChildren, []);
  db.close();
});

test("auto-repair applies once at boot, converges, and never rescans settled history", async () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO sessions(slug, thread_key, session_id, engine) VALUES('test-channel', 'thread', 'root-history', 'codex')").run();
  const insertRow = db.prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out,
       cost_usd, cost_estimated, duration_ms, accounting_status)
     VALUES(?, 'C', 'test-channel', 'U', 'codex', 'gpt-5.6-sol', 'interactive', ?, ?, NULL, 1, 3000, 'legacy-unverified')`
  );
  insertRow.run("2026-08-16T00:00:03.100Z", 100, 5);
  insertRow.run("2026-08-16T00:01:04.100Z", 250, 12);

  const state = await writeRolloutFixture();
  const quiet = { log: () => {} };
  const first = await autoRepairCodexUsageHistory({ db, stateDir: state, makeBackup: async () => "test-backup", log: quiet });
  assert.equal(first.applied, true);
  assert.equal(first.matchedRows, 2);
  assert.equal(first.childRolloutsAttached, 1);
  assert.equal(first.backupPath, "test-backup");
  const statuses = db.prepare("SELECT id, accounting_status FROM usage ORDER BY id").all();
  assert.deepEqual(statuses.map((r) => r.accounting_status), ["repaired-verified", "repaired-verified"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_components WHERE source_kind = 'subagent'").get().n, 1);
  assert.equal(db.prepare("SELECT cutoff_usage_id FROM usage_repair_batches").get().cutoff_usage_id, 2);

  // Nothing pending afterwards: the next boot is a no-op.
  assert.deepEqual(await autoRepairCodexUsageHistory({ db, stateDir: state, makeBackup: async () => "x", log: quiet }), { applied: false, pendingRows: 0 });

  // A later legacy row with NO surviving rollout gets scanned exactly once: the batch advances the
  // cutoff past it, the row stays visibly legacy, and subsequent boots do not rescan.
  insertRow.run("2026-08-17T09:00:00.000Z", 999, 99);
  const second = await autoRepairCodexUsageHistory({ db, stateDir: state, makeBackup: async () => "y", log: quiet });
  assert.equal(second.applied, true);
  assert.equal(second.matchedRows, 2); // rows 1–2 re-upsert to identical components (idempotent)
  assert.equal(second.unmatchedRows, 1);
  assert.equal(db.prepare("SELECT accounting_status FROM usage WHERE id = 3").get().accounting_status, "legacy-unverified");
  assert.equal(pendingCodexRepair(db).pendingRows, 0);
  assert.deepEqual(await autoRepairCodexUsageHistory({ db, stateDir: state, makeBackup: async () => "z", log: quiet }), { applied: false, pendingRows: 0 });
  db.close();
});
