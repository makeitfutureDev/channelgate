import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { runMigrations } = await import("../src/db/index.js");
const {
  CODEX_PRICING_HISTORY_SINCE,
  CODEX_SOL_PRICE_CUTOVER,
  CODEX_TERRA_LUNA_PRICE_CUTOVER,
  CODEX_61_SOL_LAUNCH,
  applyCodexPricingRefresh,
  autoRefreshCodexPricing,
  buildCodexPricingRefresh,
  pendingCodexPricingRefresh,
} = await import("../src/gateway/usage-pricing.js");
const { CODEX_PRICING_BASIS, estimateCodexCost } = await import("../src/gateway/usage.js");
const { getSettings, saveSettings } = await import("../src/config/settings.js");

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

test("after manual approval boot refresh catches stale rows, backs up once, then skips", async () => {
  const db = fixture();
  db.prepare("INSERT INTO _meta(key, value) VALUES('codex_usage_pricing_basis', ?)").run(CODEX_PRICING_BASIS);
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

test("boot defers the new basis without writes or backups until explicit manual apply", async () => {
  for (const appliedBasis of ["", "openai-standard-effective-dates-2026-09-14"]) {
    const db = fixture();
    if (appliedBasis) db.prepare("INSERT INTO _meta(key, value) VALUES('codex_usage_pricing_basis', ?)").run(appliedBasis);
    const snapshot = () => ["usage", "usage_components", "usage_requests", "_meta"]
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    assert.deepEqual(await autoRefreshCodexPricing({ db,
      makeBackup: async () => assert.fail("deferred refresh must not back up"), log: { log() {} },
    }), { applied: false, deferred: true, basis: CODEX_PRICING_BASIS });
    assert.deepEqual(snapshot(), before);
    assert.equal(pendingCodexPricingRefresh(db).pending, true);
    applyCodexPricingRefresh(db, buildCodexPricingRefresh({ db }));
    assert.equal(buildCodexPricingRefresh({ db }).delta, 0);
    assert.deepEqual(await autoRefreshCodexPricing({ db }), { applied: false, basis: CODEX_PRICING_BASIS });
    db.close();
  }
});

function addPricingEvidence(db, ts, model, { input = 100_000, cached = 20_000, write = 10_000, output = 1_000 } = {}) {
  const usage = db.prepare(`INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind,
    tokens_in, tokens_out, duration_ms) VALUES(?, 'C', 'pricing', 'U', 'codex', ?, 'interactive', ?, ?, 1)`)
    .run(ts, model, input, output);
  const component = db.prepare(`INSERT INTO usage_components(usage_id, source_key, source_kind, model,
    tokens_in, tokens_cached, tokens_cache_write, tokens_out, pricing_basis)
    VALUES(?, ?, 'root', ?, ?, ?, ?, ?, 'unpriced')`)
    .run(Number(usage.lastInsertRowid), `added-${usage.lastInsertRowid}`, model, input, cached, write, output);
  db.prepare(`INSERT INTO usage_requests(component_id, request_index, model, tokens_in, tokens_cached,
    tokens_cache_write, tokens_out) VALUES(?, 0, ?, ?, ?, ?, ?)`)
    .run(Number(component.lastInsertRowid), model, input, cached, write, output);
  return Number(component.lastInsertRowid);
}

test("Terra and Luna retain pre-July30 rates and use reduced rates from the exact boundary", () => {
  const db = fixture();
  const cases = [
    ["gpt-5.6-terra", 0.22625, 0.181],
    ["gpt-5.6-luna", 0.0905, 0.0181],
  ];
  const expected = new Map();
  for (const [model, oldCost, newCost] of cases) {
    expected.set(addPricingEvidence(db, "2026-07-29T23:59:59.999Z", model), oldCost);
    expected.set(addPricingEvidence(db, CODEX_TERRA_LUNA_PRICE_CUTOVER, model), newCost);
    expected.set(addPricingEvidence(db, "2026-07-31T00:00:00.000Z", `${model}-2026-07-09`), newCost);
  }
  const plan = buildCodexPricingRefresh({ db });
  for (const [id, cost] of expected) {
    const component = plan.componentUpdates.find((row) => row.id === id);
    assert.equal(component.costUSD, cost);
    assert.equal(component.requestUpdates[0].costUSD, cost);
  }
  applyCodexPricingRefresh(db, plan);
  assert.equal(buildCodexPricingRefresh({ db }).delta, 0);
  assert.equal(pendingCodexPricingRefresh(db).pending, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM usage u WHERE u.engine = 'codex'
    AND u.ts >= ? AND ABS(u.cost_usd - (SELECT SUM(c.cost_usd) FROM usage_components c WHERE c.usage_id = u.id)) > 0.000001`)
    .get(CODEX_PRICING_HISTORY_SINCE).n, 0);
  db.close();
});

test("GPT-6.1 Sol launch and long-context boundary use request evidence, including cache writes", () => {
  const db = fixture();
  const before = addPricingEvidence(db, "2026-09-28T23:59:59.999Z", "gpt-6.1-sol");
  const launch = addPricingEvidence(db, CODEX_61_SOL_LAUNCH, "gpt-6.1-sol");
  const plan = buildCodexPricingRefresh({ db });
  assert.equal(plan.componentUpdates.find((row) => row.id === before).costUSD, null);
  assert.equal(plan.componentUpdates.find((row) => row.id === launch).costUSD, 0.177);
  const usage = { input_tokens: 272_000, cached_input_tokens: 20_000, cache_write_input_tokens: 10_000, output_tokens: 1_000 };
  assert.equal(estimateCodexCost(usage, "gpt-6.1-sol", [{ usage }]).costUSD, 0.521);
  const longUsage = { ...usage, input_tokens: 272_001 };
  assert.equal(estimateCodexCost(longUsage, "gpt-6.1-sol", [{ usage: longUsage }]).costUSD, 1.037004);
  assert.equal(estimateCodexCost(longUsage, "gpt-6.1-sol-2026-09-29", [{ usage: longUsage }]).costUSD, 1.037004);
  assert.equal(estimateCodexCost(longUsage, "gpt-6.1-sol").costUSD, 0.521002, "aggregate alone never implies long context");
  const long = addPricingEvidence(db, CODEX_61_SOL_LAUNCH, "gpt-6.1-sol", { input: 272_001, cached: 20_000, write: 10_000, output: 1_000 });
  assert.equal(buildCodexPricingRefresh({ db }).componentUpdates.find((row) => row.id === long).costUSD, 1.037004);
  applyCodexPricingRefresh(db, buildCodexPricingRefresh({ db }));
  assert.equal(buildCodexPricingRefresh({ db }).delta, 0);
  db.close();
});

test("dated rates preserve genuine admin overrides and retire old saved defaults", () => {
  const previous = getSettings().codexModelRates || {};
  const db = fixture();
  try {
    const ids = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol"].map((model) =>
      addPricingEvidence(db, "2026-07-29T23:59:59.999Z", model));
    saveSettings({ codexModelRates: Object.fromEntries(["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol"]
      .map((model) => [model, { input: 3, cachedInput: 0.3, output: 9 }])) });
    const plan = buildCodexPricingRefresh({ db });
    for (const id of ids) assert.equal(plan.componentUpdates.find((row) => row.id === id).costUSD, 0.2625);
    saveSettings({ codexModelRates: {
      "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15 },
      "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6 },
    } });
    const forward = { input_tokens: 100_000, cached_input_tokens: 20_000, cache_write_input_tokens: 10_000, output_tokens: 1_000 };
    assert.equal(estimateCodexCost(forward, "gpt-5.6-terra").costUSD, 0.181);
    assert.equal(estimateCodexCost(forward, "gpt-5.6-luna").costUSD, 0.0181);
    const historical = buildCodexPricingRefresh({ db });
    assert.equal(historical.componentUpdates.find((row) => row.id === ids[0]).costUSD, 0.22625);
    assert.equal(historical.componentUpdates.find((row) => row.id === ids[1]).costUSD, 0.0905);
  } finally {
    saveSettings({ codexModelRates: previous });
    db.close();
  }
});
