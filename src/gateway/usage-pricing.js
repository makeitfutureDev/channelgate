// One-time Codex pricing refreshes. The usage ledger stores token evidence and an estimated
// Standard API-equivalent dollar value; when OpenAI changes a published rate, updating only the
// forward estimator leaves the dashboard's existing period internally inconsistent. This module
// reprices the requested historical window from the stored component/request evidence, backs up
// the database first, and records a basis marker so every upgraded gateway applies it once.
import { CODEX_PRICING_BASIS, estimateCodexCost } from "./usage.js";
import { backupGatewayDb } from "./usage-repair.js";

export const CODEX_PRICING_HISTORY_SINCE = "2026-07-13T00:00:00.000Z";
export const CODEX_PRICING_META_KEY = "codex_usage_pricing_basis";

const tokenUsage = (row = {}) => ({
  input_tokens: Number(row.tokens_in) || 0,
  cached_input_tokens: Number(row.tokens_cached) || 0,
  cache_write_input_tokens: Number(row.tokens_cache_write) || 0,
  output_tokens: Number(row.tokens_out) || 0,
  reasoning_output_tokens: Number(row.reasoning_tokens) || 0,
});

const fixed = (value) => Number(Number(value || 0).toFixed(6));

export function pendingCodexPricingRefresh(db, { basis = CODEX_PRICING_BASIS } = {}) {
  const appliedBasis = String(db.prepare("SELECT value FROM _meta WHERE key = ?").get(CODEX_PRICING_META_KEY)?.value || "");
  if (appliedBasis !== basis) return { pending: true, appliedBasis, basis };
  // A manual refresh can race an older daemon that is still recording turns. Once the marker is
  // current, cheaply inspect only components written with another basis and refresh again if one
  // of their models is now priceable. Permanently-unpriced internal pseudo-models stay ignored.
  const stale = db.prepare(
    `SELECT c.model, c.tokens_in, c.tokens_cached, c.tokens_cache_write, c.tokens_out, c.reasoning_tokens
       FROM usage_components c
       JOIN usage u ON u.id = c.usage_id
      WHERE u.engine = 'codex' AND u.ts >= ? AND c.pricing_basis != ?`
  ).all(CODEX_PRICING_HISTORY_SINCE, basis);
  const rateableStaleComponent = stale.some((component) => (
    estimateCodexCost(tokenUsage(component), component.model).costUSD != null
  ));
  return { pending: rateableStaleComponent, appliedBasis, basis };
}

export function buildCodexPricingRefresh({
  db,
  since = CODEX_PRICING_HISTORY_SINCE,
  basis = CODEX_PRICING_BASIS,
} = {}) {
  const components = db.prepare(
    `SELECT c.*
       FROM usage_components c
       JOIN usage u ON u.id = c.usage_id
      WHERE u.engine = 'codex' AND u.ts >= ?
      ORDER BY c.id`
  ).all(since);
  const requests = db.prepare(
    `SELECT r.*
       FROM usage_requests r
       JOIN usage_components c ON c.id = r.component_id
       JOIN usage u ON u.id = c.usage_id
      WHERE u.engine = 'codex' AND u.ts >= ?
      ORDER BY r.component_id, r.request_index`
  ).all(since);
  const requestsByComponent = new Map();
  for (const request of requests) {
    const list = requestsByComponent.get(Number(request.component_id)) || [];
    list.push(request);
    requestsByComponent.set(Number(request.component_id), list);
  }

  const componentUpdates = [];
  const usageCosts = new Map();
  const models = new Map();
  let storedEstimatedValue = 0;
  let repricedEstimatedValue = 0;
  let unpricedComponents = 0;
  for (const component of components) {
    const detail = requestsByComponent.get(Number(component.id)) || [];
    const requestEvidence = detail.map((request) => ({
      model: request.model || component.model,
      usage: tokenUsage(request),
    }));
    const estimate = estimateCodexCost(tokenUsage(component), component.model, requestEvidence);
    const requestUpdates = detail.map((request) => ({
      id: Number(request.id),
      costUSD: estimateCodexCost(tokenUsage(request), request.model || component.model, [{
        model: request.model || component.model,
        usage: tokenUsage(request),
      }]).costUSD,
    }));
    const update = {
      id: Number(component.id),
      usageId: Number(component.usage_id),
      model: String(component.model || ""),
      costUSD: estimate.costUSD,
      costEstimated: estimate.estimated,
      pricingBasis: estimate.estimated ? basis : "unpriced",
      requestUpdates,
    };
    componentUpdates.push(update);

    const usage = usageCosts.get(update.usageId) || { costUSD: 0, pricedComponents: 0 };
    if (update.costUSD != null) {
      usage.costUSD += update.costUSD;
      usage.pricedComponents += 1;
      repricedEstimatedValue += update.costUSD;
    } else {
      unpricedComponents += 1;
    }
    usageCosts.set(update.usageId, usage);

    const model = models.get(update.model) || { components: 0, storedValue: 0, repricedValue: 0, unpricedComponents: 0 };
    model.components += 1;
    if (component.cost_usd != null) {
      const old = Number(component.cost_usd) || 0;
      storedEstimatedValue += old;
      model.storedValue += old;
    }
    if (update.costUSD == null) model.unpricedComponents += 1;
    else model.repricedValue += update.costUSD;
    models.set(update.model, model);
  }

  const usageUpdates = [...usageCosts].map(([id, value]) => ({
    id,
    costUSD: value.pricedComponents ? fixed(value.costUSD) : null,
    costEstimated: value.pricedComponents > 0,
  }));
  const modelSummary = Object.fromEntries([...models].map(([model, value]) => [model, {
    components: value.components,
    storedValue: fixed(value.storedValue),
    repricedValue: fixed(value.repricedValue),
    delta: fixed(value.repricedValue - value.storedValue),
    unpricedComponents: value.unpricedComponents,
  }]));

  return {
    basis,
    since,
    usageRows: usageUpdates.length,
    components: componentUpdates.length,
    requests: requests.length,
    unpricedComponents,
    storedEstimatedValue: fixed(storedEstimatedValue),
    repricedEstimatedValue: fixed(repricedEstimatedValue),
    delta: fixed(repricedEstimatedValue - storedEstimatedValue),
    models: modelSummary,
    componentUpdates,
    usageUpdates,
  };
}

export function summarizeCodexPricingRefresh(plan = {}) {
  const {
    basis = CODEX_PRICING_BASIS,
    since = CODEX_PRICING_HISTORY_SINCE,
    usageRows = 0,
    components = 0,
    requests = 0,
    unpricedComponents = 0,
    storedEstimatedValue = 0,
    repricedEstimatedValue = 0,
    delta = 0,
    models = {},
  } = plan;
  return { basis, since, usageRows, components, requests, unpricedComponents, storedEstimatedValue, repricedEstimatedValue, delta, models };
}

export function applyCodexPricingRefresh(db, plan) {
  const updateRequest = db.prepare("UPDATE usage_requests SET cost_usd = ? WHERE id = ?");
  const updateComponent = db.prepare(
    "UPDATE usage_components SET cost_usd = ?, cost_estimated = ?, pricing_basis = ? WHERE id = ?"
  );
  const updateUsage = db.prepare("UPDATE usage SET cost_usd = ?, cost_estimated = ? WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const component of plan.componentUpdates || []) {
      for (const request of component.requestUpdates || []) updateRequest.run(request.costUSD, request.id);
      updateComponent.run(component.costUSD, component.costEstimated ? 1 : 0, component.pricingBasis, component.id);
    }
    for (const usage of plan.usageUpdates || []) updateUsage.run(usage.costUSD, usage.costEstimated ? 1 : 0, usage.id);
    db.prepare(
      "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(CODEX_PRICING_META_KEY, plan.basis || CODEX_PRICING_BASIS);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
  return summarizeCodexPricingRefresh(plan);
}

export async function autoRefreshCodexPricing({ db, makeBackup, log = console } = {}) {
  const handle = db || (await import("../db/index.js")).getDb();
  const state = pendingCodexPricingRefresh(handle);
  if (!state.pending) return { applied: false, basis: state.basis };
  const plan = buildCodexPricingRefresh({ db: handle });
  const backupPath = plan.usageRows ? await (makeBackup || backupGatewayDb)() : "";
  const summary = applyCodexPricingRefresh(handle, plan);
  log.log?.(`[usage] Codex pricing refresh ${summary.basis}: ${summary.usageRows} run(s), ${summary.components} component(s), ${summary.requests} request(s); value ${summary.storedEstimatedValue} → ${summary.repricedEstimatedValue}${backupPath ? `; backup ${backupPath}` : ""}`);
  return { applied: true, backupPath, ...summary };
}
