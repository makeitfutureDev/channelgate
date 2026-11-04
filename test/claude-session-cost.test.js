// Claude Code's terminal `result` reports the provider SESSION's cumulative `total_cost_usd` and
// `modelUsage` (CLI ≥ 2.1.277 restores a resumed session's earlier spend) while `usage` is the
// main loop alone, without subagents. The ledger must record THIS run's delta — whole tree, one
// priced slice per model — and never charge a resumed thread its history again.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { recordUsage, readUsage, usageSummary } = await import("../src/gateway/usage.js");
const { getDb, runMigrations } = await import("../src/db/index.js");
const { migrations } = await import("../src/db/migrations.js");
const { claudeSessionDelta, claudeCumulativeSnapshot, repairClaudeCumulativeCost } = await import("../src/db/claude-session-usage.js");

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

// A terminal line the way the CLI writes it after the Nth turn of one session: cumulative.
function terminal({ cost, opus, sonnet = null, usage }) {
  return {
    type: "result", subtype: "success", session_id: "sess-claude", usage, total_cost_usd: cost,
    modelUsage: {
      [OPUS]: { inputTokens: opus.in, outputTokens: opus.out, cacheReadInputTokens: opus.read, cacheCreationInputTokens: opus.write, costUSD: opus.cost, contextWindow: 200000 },
      ...(sonnet ? { [SONNET]: { inputTokens: sonnet.in, outputTokens: sonnet.out, cacheReadInputTokens: sonnet.read, cacheCreationInputTokens: sonnet.write, costUSD: sonnet.cost, contextWindow: 200000 } } : {}),
    },
  };
}

async function record(channelId, raw, extra = {}) {
  return recordUsage({
    channelId, slug: channelId, authorId: "U1", engine: "claude",
    result: { engine: "claude", model: "opus", primaryModel: OPUS, sessionId: raw.session_id, usage: raw.usage, costUSD: raw.total_cost_usd, durationMs: 1500, raw, ...extra },
  });
}

test("a resumed Claude session records each turn's delta, with one priced component per model", async () => {
  const channelId = "C_CLAUDE_DELTA";
  // Turn 1: Opus main loop + a Sonnet subagent. `usage` carries only the main loop.
  const first = await record(channelId, terminal({
    cost: 0.38,
    opus: { in: 4, out: 1386, read: 39777, write: 16734, cost: 0.16 },
    sonnet: { in: 14, out: 1985, read: 247092, write: 60476, cost: 0.22 },
    usage: { input_tokens: 4, output_tokens: 1386, cache_read_input_tokens: 39777, cache_creation_input_tokens: 16734 },
  }));
  assert.equal(first.costUSD, 0.38);
  assert.equal(first.tokensIn, 4 + 39777 + 16734 + 14 + 247092 + 60476, "the whole tree's input, subagent included");
  assert.equal(first.tokensOut, 1386 + 1985);

  // Turn 2 of the SAME session: the CLI reports the session total, not the turn.
  const second = await record(channelId, terminal({
    cost: 0.43,
    opus: { in: 8, out: 1595, read: 69250, write: 21786, cost: 0.21 },
    sonnet: { in: 14, out: 1985, read: 247092, write: 60476, cost: 0.22 },
    usage: { input_tokens: 4, output_tokens: 209, cache_read_input_tokens: 29473, cache_creation_input_tokens: 5052 },
  }));
  assert.ok(Math.abs(second.costUSD - 0.05) < 1e-9, `turn 2 is charged its own $0.05, got ${second.costUSD}`);
  assert.equal(second.tokensIn, 4 + 29473 + 5052, "turn 2 touched Opus only");
  assert.equal(second.tokensOut, 209);

  const rows = await readUsage({ channelId });
  assert.equal(rows.length, 2);
  const summary = await usageSummary();
  const channel = summary.byChannel.find((row) => row.key === channelId);
  assert.ok(Math.abs(channel.costUSD - 0.43) < 1e-9, "the channel total equals the session's cumulative, not the sum of cumulatives");

  const db = getDb();
  const ids = db.prepare("SELECT id, provider_cost_cumulative, accounting_status FROM usage WHERE channel_id = ? ORDER BY id").all(channelId);
  assert.deepEqual(ids.map((r) => r.provider_cost_cumulative), [0.38, 0.43], "the raw cumulative survives beside each row");
  assert.deepEqual(ids.map((r) => r.accounting_status), ["verified", "verified"]);
  const components = db.prepare("SELECT usage_id, source_kind, model, tokens_in, tokens_out, cost_usd, provenance FROM usage_components WHERE usage_id IN (?, ?) ORDER BY usage_id, model").all(ids[0].id, ids[1].id);
  assert.deepEqual(components.map((c) => [c.source_kind, c.model, c.tokens_in, c.tokens_out, Number(c.cost_usd.toFixed(9)), c.provenance]), [
    ["root", OPUS, 4 + 39777 + 16734, 1386, 0.16, "claude-model-usage-delta"],
    ["auxiliary", SONNET, 14 + 247092 + 60476, 1985, 0.22, "claude-model-usage-delta"],
    ["root", OPUS, 4 + 29473 + 5052, 209, 0.05, "claude-model-usage-delta"],
  ], "the Sonnet subagent's spend is its own priced slice under its own model");
});

test("a cumulative that goes down is a restarted session: taken at face value, never negative", () => {
  const previous = claudeCumulativeSnapshot(terminal({ cost: 0.9, opus: { in: 10, out: 10, read: 0, write: 0, cost: 0.9 }, usage: {} }));
  const current = claudeCumulativeSnapshot(terminal({ cost: 0.2, opus: { in: 2, out: 2, read: 0, write: 0, cost: 0.2 }, usage: {} }));
  const delta = claudeSessionDelta(current, previous);
  assert.equal(delta.reset, true);
  assert.equal(delta.costUSD, 0.2);
  assert.deepEqual(delta.models.map((m) => [m.model, m.input, m.output, m.costUSD]), [[OPUS, 2, 2, 0.2]]);
});

test("per-model slices that do not add up to the run are dropped as a whole, the cost delta kept", () => {
  const previous = claudeCumulativeSnapshot(terminal({ cost: 0.1, opus: { in: 10, out: 10, read: 0, write: 0, cost: 0.1 }, usage: {} }));
  // Total rose, but one model's counter went backwards: inconsistent evidence.
  const current = claudeCumulativeSnapshot(terminal({ cost: 0.3, opus: { in: 5, out: 20, read: 0, write: 0, cost: 0.3 }, usage: {} }));
  const delta = claudeSessionDelta(current, previous);
  assert.equal(delta.reset, false);
  assert.ok(Math.abs(delta.costUSD - 0.2) < 1e-9);
  assert.deepEqual(delta.models, []);
});

test("a result without session totals records what it was given, as before", async () => {
  const channelId = "C_CLAUDE_LEGACY";
  const settled = await recordUsage({
    channelId, slug: channelId, authorId: "U1", engine: "claude",
    result: { engine: "claude", model: "opus", sessionId: "sess-old", usage: { input_tokens: 100, output_tokens: 5 }, costUSD: 0.07 },
  });
  assert.equal(settled.costUSD, 0.07);
  const row = getDb().prepare("SELECT provider_cost_cumulative, provider_model_usage, accounting_status FROM usage WHERE channel_id = ?").get(channelId);
  assert.equal(row.provider_cost_cumulative, null);
  assert.equal(row.provider_model_usage, "");
  assert.equal(row.accounting_status, "provider-reported");
});

test("migration 41 re-differences historical Claude rows losslessly and only once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  // Bring the schema to v40 by hand, insert the legacy cumulative rows, then apply the rest.
  for (const migration of migrations.filter((m) => m.version <= 40)) migration.up(db);
  db.exec("PRAGMA user_version = 40");
  const insert = db.prepare("INSERT INTO usage(ts, channel_id, engine, model, task_kind, tokens_in, tokens_out, cost_usd, cost_estimated, session_id) VALUES (?, 'C', 'claude', 'claude-opus-5-5', 'interactive', 10, 1, ?, 0, ?)");
  insert.run("2026-11-04T21:25:42.000Z", 1.6717, "s-long");
  insert.run("2026-11-04T21:32:26.000Z", 2.4439, "s-long");
  insert.run("2026-11-04T21:44:27.000Z", 2.8121, "s-long");
  insert.run("2026-11-04T21:50:00.000Z", 0.5, "s-long"); // the CLI restarted its totals
  insert.run("2026-11-04T21:33:06.000Z", 0.3823, "s-two");
  insert.run("2026-11-04T21:33:53.000Z", 0.4328, "s-two");
  insert.run("2026-09-01T10:00:00.000Z", 0.2, "s-old"); // before the cumulative-reporting pin: untouched
  insert.run("2026-09-01T10:05:00.000Z", 0.3, "s-old");
  insert.run("2026-11-04T22:00:00.000Z", 0.9, ""); // no session id: untouched
  runMigrations(db);
  const rows = db.prepare("SELECT session_id, cost_usd, provider_cost_cumulative FROM usage ORDER BY session_id, id").all();
  const by = (sid) => rows.filter((r) => r.session_id === sid).map((r) => [Number(r.cost_usd.toFixed(6)), r.provider_cost_cumulative]);
  assert.deepEqual(by("s-long"), [[1.6717, 1.6717], [0.7722, 2.4439], [0.3682, 2.8121], [0.5, 0.5]]);
  assert.deepEqual(by("s-two"), [[0.3823, 0.3823], [0.0505, 0.4328]]);
  assert.deepEqual(by("s-old"), [[0.2, null], [0.3, null]]);
  assert.deepEqual(by(""), [[0.9, null]]);
  // Idempotent: rows that carry their cumulative are baselines, not targets.
  assert.deepEqual(repairClaudeCumulativeCost(db, { since: "2026-09-24T00:00:00.000Z" }), { scanned: 6, changed: 0 });
  assert.deepEqual(by("s-long"), [[1.6717, 1.6717], [0.7722, 2.4439], [0.3682, 2.8121], [0.5, 0.5]]);
  db.close();
});
