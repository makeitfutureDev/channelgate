// What an API run REPORTS it cost (QA API-001). Codex reports no dollar amount, so `GET
// /api/runs/:id`, the `api_run_done` event and the completion webhook all published
// `costUSD: null` — "free" — while the usage ledger was independently storing a priced estimate
// for the very same run. The engine's own figure still wins; the ledger is the fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { settleRunCost } = await import("../src/gateway/api-runs.js");
const { recordUsage } = await import("../src/gateway/usage.js");
const { getDb } = await import("../src/db/index.js");

const CHANNEL = "C_API_COST";

function clearLedger() {
  getDb().prepare("DELETE FROM usage WHERE channel_id = ?").run(CHANNEL);
}

test("an engine-reported cost is used as-is and never marked estimated", () => {
  assert.deepEqual(settleRunCost({ costUSD: 0.42 }, null), { costUSD: 0.42, estimated: false });
  // Even against a ledger figure: a real amount beats an estimate of the same run.
  assert.deepEqual(settleRunCost({ costUSD: 0.42 }, { costUSD: 0.7, costEstimated: true }), { costUSD: 0.42, estimated: false });
  // A free run is a KNOWN zero, not "unknown" — it must not fall through to the ledger.
  assert.deepEqual(settleRunCost({ costUSD: 0 }, { costUSD: 0.7, costEstimated: true }), { costUSD: 0, estimated: false });
});

test("with no engine cost the ledger's estimate is published, flagged as estimated", () => {
  assert.deepEqual(settleRunCost({ engine: "codex" }, { costUSD: 0.0123, costEstimated: true }), { costUSD: 0.0123, estimated: true });
  assert.deepEqual(settleRunCost({ engine: "codex" }, { costUSD: 0.0123, costEstimated: false }), { costUSD: 0.0123, estimated: false });
});

test("null survives only when nothing anywhere knows a cost", () => {
  assert.deepEqual(settleRunCost({ engine: "claude" }, null), { costUSD: null, estimated: false });
  assert.deepEqual(settleRunCost({}, { costUSD: null, costEstimated: false }), { costUSD: null, estimated: false });
  assert.deepEqual(settleRunCost(), { costUSD: null, estimated: false });
});

test("recordUsage hands back the figure it stored, so the API cannot diverge from the ledger", async () => {
  clearLedger();
  const result = {
    engine: "codex",
    model: "gpt-5.6-sol",
    usage: { input_tokens: 120_000, cached_input_tokens: 20_000, output_tokens: 4_000 },
    durationMs: 8_421,
  };
  const ledger = await recordUsage({ channelId: CHANNEL, slug: "api", authorId: "api", engine: "codex", taskKind: "api", result });
  assert.ok(ledger, "recordUsage must report what it settled on");
  assert.ok(ledger.costUSD > 0, `expected a priced estimate, got ${ledger.costUSD}`);
  assert.equal(ledger.costEstimated, true);

  const stored = getDb().prepare("SELECT cost_usd, cost_estimated FROM usage WHERE channel_id = ?").get(CHANNEL);
  assert.equal(stored.cost_usd, ledger.costUSD, "the returned figure must be the stored one");
  assert.equal(stored.cost_estimated, 1);

  // The end of the chain: a Codex run publishes the ledger's number instead of "free".
  const published = settleRunCost(result, ledger);
  assert.equal(published.costUSD, ledger.costUSD);
  assert.equal(published.estimated, true);
  clearLedger();
});

test("a run with per-component accounting reports the CANONICAL cost the Audit view shows", async () => {
  clearLedger();
  const requests = [{ model: "gpt-5.6-sol", usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 20 } }];
  const ledger = await recordUsage({
    channelId: CHANNEL,
    slug: "api",
    authorId: "api",
    engine: "codex",
    taskKind: "api",
    result: {
      engine: "codex",
      model: "gpt-5.6-sol",
      // Cumulative turn totals over-count; the components are the corrected accounting.
      usage: { input_tokens: 90_000, cached_input_tokens: 40_000, output_tokens: 2_000 },
      usageAccounting: {
        root: { sourceId: "codex-turn:root", sessionId: "root", model: "gpt-5.6-sol", usage: requests[0].usage, requests },
        children: [],
      },
    },
  });
  const canonical = getDb()
    .prepare("SELECT SUM(cost_usd) AS cost FROM usage_components WHERE usage_id = (SELECT id FROM usage WHERE channel_id = ?)")
    .get(CHANNEL);
  assert.ok(canonical.cost > 0);
  assert.equal(ledger.costUSD, canonical.cost, "the API must quote the same cost the Audit view rolls up");
  assert.equal(ledger.costEstimated, true);
  clearLedger();
});

test("a Claude run keeps its real cost and is never repriced with Codex rates", async () => {
  clearLedger();
  const result = { engine: "claude", model: "claude-opus-4-8", costUSD: 0.31, usage: { input_tokens: 36_800, output_tokens: 192 } };
  const ledger = await recordUsage({ channelId: CHANNEL, slug: "api", authorId: "api", engine: "claude", taskKind: "api", result });
  assert.equal(ledger.costUSD, 0.31);
  assert.equal(ledger.costEstimated, false);
  assert.deepEqual(settleRunCost(result, ledger), { costUSD: 0.31, estimated: false });
  clearLedger();
});
