import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { runMigrations } = await import("../src/db/index.js");
const {
  CODEX_PRICING_HISTORY_SINCE,
  CODEX_SOL_PRICE_CUTOVER,
  applyCodexPricingRefresh,
  autoRefreshCodexPricing,
  buildCodexPricingRefresh,
  pendingCodexPricingRefresh,
} = await import("../src/gateway/usage-pricing.js");
const { CODEX_PRICING_BASIS } = await import("../src/gateway/usage.js");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
  runMigrations(db);
  const usage = db.prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind,
       tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status)
     VALUES(?, 'C', 'pricing', 'U', 'codex', ?, 'interactive', ?, ?, ?, 1, 1, ?, 'verified')`
  );
  const component = db.prepare(
    `INSERT INTO usage_components(usage_id, source_key, source_kind, model, tokens_in,
       tokens_cached, tokens_cache_write, tokens_out, cost_usd, cost_estimated, pricing_basis)
     VALUES(?, ?, 'root', ?, ?, ?, ?, ?, ?, 1, 'openai-standard-2026-08-16')`
  );
  const request = db.prepare(
    `INSERT INTO usage_requests(component_id, request_index, model, tokens_in, tokens_cached,
       tokens_cache_write, tokens_out, reasoning_tokens, context_window, long_context, cost_usd)
     VALUES(?, 0, ?, ?, ?, 0, ?, 0, 1050000, ?, ?)`
  );

  const sol = usage.run(CODEX_SOL_PRICE_CUTOVER, "gpt-5.6-sol", 300_000, 1_000, 2.145, "gpt-5.6-sol");
  const solComponent = component.run(Number(sol.lastInsertRowid), "sol", "gpt-5.6-sol", 300_000, 100_000, 0, 1_000, 2.145);
  request.run(Number(solComponent.lastInsertRowid), "gpt-5.6-sol", 300_000, 100_000, 1_000, 1, 2.145);
  component.run(Number(sol.lastInsertRowid), "review", "codex-auto-review", 1_000, 0, 0, 10, null);

  const solBefore = usage.run("2026-08-20T23:59:59.999Z", "gpt-5.6-sol", 300_000, 1_000, 2.145, "gpt-5.6-sol");
  const solBeforeComponent = component.run(Number(solBefore.lastInsertRowid), "sol-before", "gpt-5.6-sol", 300_000, 100_000, 0, 1_000, 2.145);
  request.run(Number(solBeforeComponent.lastInsertRowid), "gpt-5.6-sol", 300_000, 100_000, 1_000, 1, 2.145);

  const astra = usage.run("2026-09-10T00:00:00.000Z", "gpt-6-astra", 1_000_000, 10_000, null, "gpt-6-astra");
  component.run(Number(astra.lastInsertRowid), "astra", "gpt-6-astra", 1_000_000, 500_000, 0, 10_000, null);

  const old = usage.run("2026-07-12T23:59:59.000Z", "gpt-5.6-sol", 100, 1, 9.99, "gpt-5.6-sol");
  component.run(Number(old.lastInsertRowid), "before-window", "gpt-5.6-sol", 100, 0, 0, 1, 9.99);

  const claude = db.prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind,
       tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status)
     VALUES('2026-09-11T00:00:00.000Z', 'C', 'pricing', 'U', 'claude', 'claude-opus-4-1',
       'interactive', 100, 10, 8.88, 0, 1, 'claude-opus-4-1', 'verified')`
  ).run();
  component.run(Number(claude.lastInsertRowid), "claude", "claude-opus-4-1", 100, 0, 0, 10, 8.88);
  return db;
}

test("pricing refresh reprices the two-month evidence window and records an idempotent basis", () => {
  const db = fixture();
  assert.deepEqual(pendingCodexPricingRefresh(db), { pending: true, appliedBasis: "", basis: CODEX_PRICING_BASIS });
  const plan = buildCodexPricingRefresh({ db });
  assert.equal(plan.since, CODEX_PRICING_HISTORY_SINCE);
  assert.equal(plan.usageRows, 3);
  assert.equal(plan.components, 4);
  assert.equal(plan.requests, 2);
  assert.equal(plan.unpricedComponents, 1);
  assert.equal(plan.models["gpt-5.6-sol"].repricedValue, 3.855);
  assert.equal(plan.models["gpt-6-astra"].repricedValue, 6);
  assert.equal(plan.models["codex-auto-review"].unpricedComponents, 1);

  applyCodexPricingRefresh(db, plan);
  assert.deepEqual(pendingCodexPricingRefresh(db), { pending: false, appliedBasis: CODEX_PRICING_BASIS, basis: CODEX_PRICING_BASIS });
  assert.deepEqual(db.prepare("SELECT source_key, cost_usd, cost_estimated, pricing_basis FROM usage_components ORDER BY id").all().map((row) => ({ ...row })), [
    { source_key: "sol", cost_usd: 1.71, cost_estimated: 1, pricing_basis: CODEX_PRICING_BASIS },
    { source_key: "review", cost_usd: null, cost_estimated: 0, pricing_basis: "unpriced" },
    { source_key: "sol-before", cost_usd: 2.145, cost_estimated: 1, pricing_basis: CODEX_PRICING_BASIS },
    { source_key: "astra", cost_usd: 6, cost_estimated: 1, pricing_basis: CODEX_PRICING_BASIS },
    { source_key: "before-window", cost_usd: 9.99, cost_estimated: 1, pricing_basis: "openai-standard-2026-08-16" },
    { source_key: "claude", cost_usd: 8.88, cost_estimated: 1, pricing_basis: "openai-standard-2026-08-16" },
  ]);
  assert.deepEqual(db.prepare("SELECT model, cost_usd FROM usage ORDER BY id").all().map((row) => ({ ...row })), [
    { model: "gpt-5.6-sol", cost_usd: 1.71 },
    { model: "gpt-5.6-sol", cost_usd: 2.145 },
    { model: "gpt-6-astra", cost_usd: 6 },
    { model: "gpt-5.6-sol", cost_usd: 9.99 },
    { model: "claude-opus-4-1", cost_usd: 8.88 },
  ]);
  assert.deepEqual(db.prepare("SELECT cost_usd FROM usage_requests ORDER BY id").all().map((row) => row.cost_usd), [1.71, 2.145]);

  db.prepare("UPDATE usage_components SET pricing_basis = 'unpriced' WHERE source_key = 'astra'").run();
  assert.deepEqual(pendingCodexPricingRefresh(db), {
    pending: true,
    appliedBasis: CODEX_PRICING_BASIS,
    basis: CODEX_PRICING_BASIS,
  });
  db.close();
});

test("boot pricing refresh backs up once and then skips the applied basis", async () => {
  const db = fixture();
  let backups = 0;
  const first = await autoRefreshCodexPricing({
    db,
    makeBackup: async () => { backups += 1; return "pricing-backup"; },
    log: { log: () => {} },
  });
  assert.equal(first.applied, true);
  assert.equal(first.backupPath, "pricing-backup");
  assert.equal(backups, 1);
  assert.deepEqual(await autoRefreshCodexPricing({ db, makeBackup: async () => { backups += 1; } }), {
    applied: false,
    basis: CODEX_PRICING_BASIS,
  });
  assert.equal(backups, 1);
  db.close();
});
