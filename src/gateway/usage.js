// Usage ledger — one normalized row per run, in the `usage` table (see ../db). This is the
// spend/visibility layer: every interactive, scheduled, and background-continuation run records
// who ran what, on which engine/model, and how many tokens / how much it cost. Typed, indexed
// columns (ts, channel_id, author_id) make the per-day/week/month/channel/user rollups the Audit
// view and future dashboards need cheap. Daemon-side only (never inside a channel cwd).
//
// No cap is enforced — this is for understanding + the Audit view, per the product decision.
import { getDb } from "../db/index.js";
import { getSettings, getCodexModelRates } from "../config/settings.js";
import { countDrop } from "../util/drops.js";
import { resolveCurrentModel } from "./model-info.js";
import { engineSupports } from "../engines/registry.js";
import { normalizeCodexTokenUsage } from "../engines/codex-usage.js";

// Codex reports no dollar cost — derive an ESTIMATE from the per-model $/1M rates in Settings
// (input / cached-input / output; OpenAI's cached_input_tokens is a SUBSET of input_tokens, so
// it's priced at the cached rate and subtracted from the full-price portion). Model lookup:
// exact key → official dated-snapshot prefix. Empty/`codex` is a CLI sentinel, not an official API
// model id, so it stays unpriced until the runtime model is resolved. The legacy blended rate is
// retained only as an explicit admin fallback for an unknown non-empty runtime model.
const LONG_CONTEXT_RATE_KEYS = new Set(["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]);
function codexRateKey(rates, model) {
  const m = String(model || "").toLowerCase();
  if (!m || m === "codex") return "";
  if (rates[m]) return m;
  return Object.keys(rates)
    .filter((key) => m.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function priceCodexRequest(rawUsage, model, rates, { allowLongContext = true } = {}) {
  const key = codexRateKey(rates, model);
  const r = key ? rates[key] : null;
  if (!r || !(r.input > 0 || r.output > 0)) return null;
  const u = normalizeCodexTokenUsage(rawUsage);
  const cached = Math.min(u.cached_input_tokens, u.input_tokens);
  const cacheWrite = Math.min(u.cache_write_input_tokens, Math.max(0, u.input_tokens - cached));
  const uncached = Math.max(0, u.input_tokens - cached - cacheWrite);
  const long = allowLongContext && LONG_CONTEXT_RATE_KEYS.has(key) && u.input_tokens > 272_000;
  const inputMultiplier = long ? 2 : 1;
  const outputMultiplier = long ? 1.5 : 1;
  return (
    uncached * r.input * inputMultiplier +
    cached * r.cachedInput * inputMultiplier +
    cacheWrite * r.input * 1.25 * inputMultiplier +
    u.output_tokens * r.output * outputMultiplier
  ) / 1_000_000;
}

export function estimateCodexCost(u = {}, model = "", requests = []) {
  const rates = getCodexModelRates();
  const detailed = Array.isArray(requests) ? requests.filter((request) => request?.usage) : [];
  if (detailed.length) {
    let cost = 0;
    for (const request of detailed) {
      const priced = priceCodexRequest(request.usage, request.model || model, rates);
      if (priced == null) return { costUSD: null, estimated: false };
      cost += priced;
    }
    return { costUSD: Number(cost.toFixed(6)), estimated: true };
  }
  // A turn aggregate can contain many short requests; the >272K uplift is defined per request.
  // Without request detail, short-context pricing is the only non-invented estimate.
  const priced = priceCodexRequest(u, model, rates, { allowLongContext: false });
  if (priced != null) {
    return { costUSD: Number(priced.toFixed(6)), estimated: true };
  }
  const rate = Number(getSettings().codexRatePer1MTokens);
  if (!Number.isFinite(rate) || rate <= 0) return { costUSD: null, estimated: false };
  const aggregate = normalizeCodexTokenUsage(u);
  return { costUSD: Number((((aggregate.input_tokens + aggregate.output_tokens) / 1_000_000) * rate).toFixed(6)), estimated: true };
}

// Normalize a run result's usage across the Claude (input_tokens/…) and Codex (prompt_tokens/…)
// shapes — same logic footerText uses — into { inTok, outTok, costUSD, estimated }. The estimate
// applies only to CODEX results: a Claude result missing total_cost_usd must stay null, not get
// priced with OpenAI rates.
export function normalizeUsage(result = {}) {
  const u = result.usage || {};
  const isCodex = result.engine === "codex";
  const codexUsage = isCodex ? normalizeCodexTokenUsage(u) : null;
  const inTok = isCodex
    ? codexUsage.input_tokens
    : (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = isCodex ? codexUsage.output_tokens : (u.output_tokens ?? u.completion_tokens ?? 0);
  const cachedTok = isCodex ? codexUsage.cached_input_tokens : (u.cache_read_input_tokens || 0);
  const cacheWriteTok = isCodex ? codexUsage.cache_write_input_tokens : (u.cache_creation_input_tokens || 0);
  if (result.costUSD != null) return { inTok, outTok, cachedTok, cacheWriteTok, costUSD: result.costUSD, estimated: false };
  // Engines that report a real dollar cost use it as-is; only estimate for those that do not.
  // A `!== "codex"` test here would have handed a third engine Claude's cost semantics silently.
  if (engineSupports(result.engine, "realCost")) return { inTok, outTok, cachedTok, cacheWriteTok, costUSD: null, estimated: false };
  const est = estimateCodexCost(u, resolveCurrentModel(result), result.usageRequests);
  return { inTok, outTok, cachedTok, cacheWriteTok, costUSD: est.costUSD, estimated: est.estimated };
}

// Row → the shape callers/UI expect (matches the pre-SQLite JSONL record).
function rowToRecord(r) {
  const canonical = Number(r.component_count) > 0;
  return {
    ts: r.ts,
    channelId: r.channel_id,
    slug: r.slug,
    authorId: r.author_id,
    engine: r.engine,
    model: r.model,
    taskKind: r.task_kind,
    tokensIn: canonical ? r.canonical_tokens_in : r.tokens_in,
    tokensOut: canonical ? r.canonical_tokens_out : r.tokens_out,
    costUSD: canonical ? r.canonical_cost_usd : r.cost_usd,
    costEstimated: Boolean(canonical ? r.canonical_cost_estimated : r.cost_estimated),
    durationMs: r.duration_ms,
    runtimeModel: r.runtime_model || r.model,
    accountingStatus: r.accounting_status || "legacy-unverified",
  };
}

export function componentRow(accounting, { sourceKind = "root", parentSourceId = "", fallbackModel = "", durationMs = null } = {}) {
  const usage = normalizeCodexTokenUsage(accounting?.usage || {});
  const model = String(accounting?.model || fallbackModel || "");
  const requests = Array.isArray(accounting?.requests) ? accounting.requests : [];
  const estimate = estimateCodexCost(usage, model, requests);
  return {
    sourceKey: String(accounting?.sourceId || ""),
    sourceKind,
    providerSessionId: String(accounting?.sessionId || (sourceKind === "root" ? accounting?.sourceId?.split(":")?.[1] : "") || ""),
    parentProviderSessionId: String(accounting?.parentSessionId || parentSourceId || ""),
    providerTurnId: String(accounting?.sourceId || ""),
    startedTs: String(accounting?.startedAt || ""),
    endedTs: String(accounting?.endedAt || ""),
    model,
    usage,
    requests,
    costUSD: estimate.costUSD,
    costEstimated: estimate.estimated,
    pricingBasis: estimate.estimated ? "openai-standard-2026-08-16" : "unpriced",
    provenance: accounting?.provenance || (sourceKind === "root" ? "codex-rollout-root-delta" : "codex-rollout-fork-delta"),
    confidence: accounting?.exactRequests === false ? "verified-total" : "verified-requests",
    durationMs: accounting?.durationMs ?? durationMs,
  };
}

export function insertComponent(db, usageId, component) {
  if (!component.sourceKey) return;
  db.prepare(
    `INSERT INTO usage_components(
       usage_id, source_key, source_kind, provider_session_id, parent_provider_session_id,
       provider_turn_id, started_ts, ended_ts, model, tokens_in, tokens_cached,
       tokens_cache_write, tokens_out, reasoning_tokens, cost_usd, cost_estimated,
       pricing_basis, provenance, confidence, duration_ms
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       usage_id=excluded.usage_id, source_kind=excluded.source_kind,
       provider_session_id=excluded.provider_session_id,
       parent_provider_session_id=excluded.parent_provider_session_id,
       provider_turn_id=excluded.provider_turn_id, started_ts=excluded.started_ts,
       ended_ts=excluded.ended_ts, model=excluded.model, tokens_in=excluded.tokens_in,
       tokens_cached=excluded.tokens_cached, tokens_cache_write=excluded.tokens_cache_write,
       tokens_out=excluded.tokens_out, reasoning_tokens=excluded.reasoning_tokens,
       cost_usd=excluded.cost_usd, cost_estimated=excluded.cost_estimated,
       pricing_basis=excluded.pricing_basis, provenance=excluded.provenance,
       confidence=excluded.confidence, duration_ms=excluded.duration_ms`
  ).run(
    usageId, component.sourceKey, component.sourceKind, component.providerSessionId,
    component.parentProviderSessionId, component.providerTurnId, component.startedTs,
    component.endedTs, component.model, component.usage.input_tokens,
    component.usage.cached_input_tokens, component.usage.cache_write_input_tokens,
    component.usage.output_tokens, component.usage.reasoning_output_tokens,
    component.costUSD, component.costEstimated ? 1 : 0, component.pricingBasis,
    component.provenance, component.confidence, component.durationMs,
  );
  const componentId = Number(db.prepare("SELECT id FROM usage_components WHERE source_key = ?").get(component.sourceKey).id);
  db.prepare("DELETE FROM usage_requests WHERE component_id = ?").run(componentId);
  const insertRequest = db.prepare(
    `INSERT INTO usage_requests(component_id, request_index, model, tokens_in, tokens_cached,
       tokens_cache_write, tokens_out, reasoning_tokens, context_window, long_context, cost_usd)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  component.requests.forEach((request, index) => {
    const requestUsage = normalizeCodexTokenUsage(request.usage || {});
    const requestModel = String(request.model || component.model || "");
    const requestCost = estimateCodexCost(requestUsage, requestModel, [{ usage: requestUsage, model: requestModel }]).costUSD;
    insertRequest.run(
      componentId, index, requestModel, requestUsage.input_tokens,
      requestUsage.cached_input_tokens, requestUsage.cache_write_input_tokens,
      requestUsage.output_tokens, requestUsage.reasoning_output_tokens,
      Number(request.contextWindow) || 0,
      LONG_CONTEXT_RATE_KEYS.has(codexRateKey(getCodexModelRates(), requestModel)) && requestUsage.input_tokens > 272_000 ? 1 : 0,
      requestCost,
    );
  });
}

// Append one normalized record. Best-effort: a logging failure must never break a run.
// taskKind: "interactive" | "scheduled" | "background" — where the run originated.
export async function recordUsage({ channelId, slug, authorId, engine, model, taskKind = "interactive", result = {} } = {}) {
  try {
    const normalizedResult = { ...result, engine: engine || result.engine || "", model: result.model || model || "" };
    const { inTok, outTok, costUSD, estimated } = normalizeUsage(normalizedResult);
    const currentModel = resolveCurrentModel(normalizedResult);
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const info = db.prepare(
        `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out,
           cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status)
         VALUES(@ts, @channel_id, @slug, @author_id, @engine, @model, @task_kind, @tokens_in, @tokens_out,
           @cost_usd, @cost_estimated, @duration_ms, @runtime_model, @accounting_status)`
      ).run({
        ts: new Date().toISOString(),
        channel_id: channelId || "",
        slug: slug || "",
        author_id: authorId || "",
        engine: engine || result.engine || "",
        model: currentModel,
        task_kind: taskKind,
        tokens_in: inTok,
        tokens_out: outTok,
        cost_usd: costUSD,
        cost_estimated: estimated ? 1 : 0,
        duration_ms: result.durationMs ?? null,
        runtime_model: currentModel,
        accounting_status: normalizedResult.usageAccounting?.root ? "verified" : (engineSupports(engine || result.engine, "realCost") ? "provider-reported" : "unverified"),
      });
      const usageId = Number(info.lastInsertRowid);
      if (normalizedResult.usageAccounting?.root) {
        const root = componentRow(normalizedResult.usageAccounting.root, { fallbackModel: currentModel, durationMs: result.durationMs ?? null });
        insertComponent(db, usageId, root);
        for (const child of normalizedResult.usageAccounting.children || []) {
          insertComponent(db, usageId, componentRow(child, {
            sourceKind: "subagent",
            parentSourceId: root.providerSessionId,
            fallbackModel: currentModel,
          }));
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
      throw error;
    }
  } catch (err) {
    countDrop("usage", err); // ledger is best-effort, but a silent drop diverges the spend numbers
  }
}

// One-shot usage banking for a single run. The engine has already SPENT these tokens the moment
// the run resolves, so every caller records BEFORE the user-visible delivery: a Slack failure (or
// a redelivery on the next boot) must never erase the spend from the ledger. A run settles through
// several branches (delivered, steered, stopped, failed), so the banker is idempotent — the first
// call wins and the rest are no-ops, which is what keeps "record earlier" from becoming "record
// twice". Never throws: accounting is best-effort and must not break a finished answer.
export function createUsageBank(recorder = recordUsage) {
  let banked = false;
  return async (payload) => {
    if (banked) return false;
    banked = true;
    try {
      await recorder(payload);
    } catch {
      /* accounting is best-effort */
    }
    return true;
  };
}

const CANONICAL_CTE = `WITH component_rollup AS (
  SELECT usage_id, COUNT(*) AS component_count,
         SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) ELSE NULL END AS cost_usd,
         MAX(cost_estimated) AS cost_estimated
    FROM usage_components GROUP BY usage_id
), canonical_usage AS (
  SELECT u.*,
         COALESCE(c.component_count, 0) AS component_count,
         CASE WHEN c.component_count > 0 THEN c.tokens_in ELSE u.tokens_in END AS canonical_tokens_in,
         CASE WHEN c.component_count > 0 THEN c.tokens_out ELSE u.tokens_out END AS canonical_tokens_out,
         CASE WHEN c.component_count > 0 THEN c.cost_usd ELSE u.cost_usd END AS canonical_cost_usd,
         CASE WHEN c.component_count > 0 THEN c.cost_estimated ELSE u.cost_estimated END AS canonical_cost_estimated
    FROM usage u LEFT JOIN component_rollup c ON c.usage_id = u.id
)`;

// Read ledger records (newest-first), optionally filtered. `month` is "YYYY-MM" (default: all).
// Used by the Audit view. Caps at `limit` records.
export async function readUsage({ month = "", channelId = "", authorId = "", limit = 500 } = {}) {
  const where = [];
  const params = {};
  if (month) {
    where.push("substr(ts, 1, 7) = @month");
    params.month = month;
  }
  if (channelId) {
    where.push("channel_id = @channelId");
    params.channelId = channelId;
  }
  if (authorId) {
    where.push("author_id = @authorId");
    params.authorId = authorId;
  }
  params.limit = Math.max(0, Number(limit) || 0);
  const sql =
    `${CANONICAL_CTE} SELECT * FROM canonical_usage` +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ts DESC, id DESC LIMIT @limit";
  try {
    return getDb().prepare(sql).all(params).map(rowToRecord);
  } catch {
    return [];
  }
}

// Aggregate rollups over the ledger (per channel + per author) for a month. Powers the Audit
// summary table.
export async function usageSummary({ month = "" } = {}) {
  const recs = await readUsage({ month, limit: 100_000 });
  const byChannel = new Map();
  const byAuthor = new Map();
  let totalCost = 0;
  let totalRuns = 0;
  let totalTokens = 0;
  const bump = (map, key, r) => {
    const cur = map.get(key) || { key, runs: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, slug: r.slug };
    cur.runs += 1;
    cur.tokensIn += r.tokensIn || 0;
    cur.tokensOut += r.tokensOut || 0;
    cur.costUSD += r.costUSD || 0;
    map.set(key, cur);
  };
  for (const r of recs) {
    bump(byChannel, r.channelId || r.slug || "?", r);
    bump(byAuthor, r.authorId || "?", r);
    totalCost += r.costUSD || 0;
    totalRuns += 1;
    totalTokens += (r.tokensIn || 0) + (r.tokensOut || 0);
  }
  const sortDesc = (m) => [...m.values()].sort((a, b) => b.costUSD - a.costUSD || b.runs - a.runs);
  return { totalRuns, totalTokens, totalCostUSD: Number(totalCost.toFixed(4)), byChannel: sortDesc(byChannel), byAuthor: sortDesc(byAuthor) };
}

// Named dashboard ranges. All boundaries are UTC (stored `ts` is UTC ISO, and we bucket via
// substr(ts, …)), so the window, the series, and the breakdowns always agree. Each resolves to a
// half-open [start, end) window plus a bucket unit chosen to keep the chart readable: hour for a
// single day, day for weeks/months, month for years.
export const DASHBOARD_RANGES = ["today", "last7", "last30", "month", "lastmonth", "year", "lastyear"];
const utcDayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const utcMonthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const utcYearStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

function resolveRange(range, now) {
  const day0 = utcDayStart(now);
  switch (range) {
    case "today":     return { start: day0, end: now, unit: "hour" };
    case "last7":     return { start: addDays(day0, -6), end: now, unit: "day" };
    case "month":     return { start: utcMonthStart(now), end: now, unit: "day" };
    case "lastmonth": return { start: addMonths(utcMonthStart(now), -1), end: utcMonthStart(now), unit: "day" };
    case "year":      return { start: utcYearStart(now), end: now, unit: "month" };
    case "lastyear":  return { start: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)), end: utcYearStart(now), unit: "month" };
    case "last30":
    default:          return { start: addDays(day0, -29), end: now, unit: "day" };
  }
}

// Bucket key length for substr(ts, 1, N): "YYYY-MM-DDTHH" (hour) / "YYYY-MM-DD" (day) / "YYYY-MM".
const bucketLen = { hour: 13, day: 10, month: 7 };
const bucketKey = (d, unit) => d.toISOString().slice(0, bucketLen[unit]);
const stepBucket = (d, unit) => (unit === "hour" ? new Date(d.getTime() + 3600000) : unit === "month" ? addMonths(d, 1) : addDays(d, 1));

// Rollups for the Dashboard view over a named `range`. All aggregation is in SQL (cheap even with a
// large ledger). `series` is gap-filled to one point per bucket (zero on quiet buckets) so the
// charts stay stable; KPI totals + per-user/per-channel breakdowns use the same [start, end) window.
export function usageDashboard({ range = "last30" } = {}) {
  const r = DASHBOARD_RANGES.includes(range) ? range : "last30";
  const now = new Date();
  const { start, end, unit } = resolveRange(r, now);
  const params = { start: start.toISOString(), end: end.toISOString() };
  const win = "ts >= @start AND ts < @end";
  const db = getDb();
  const totals = db
    .prepare(
      `${CANONICAL_CTE}
       SELECT COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_tokens_in), 0) AS tokens_in,
              COALESCE(SUM(canonical_tokens_out), 0) AS tokens_out,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost,
              SUM(CASE WHEN canonical_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs,
              COUNT(DISTINCT author_id) AS users,
              COUNT(DISTINCT channel_id) AS channels
         FROM canonical_usage WHERE ${win}`
    )
    .get(params);
  const bucketRows = db
    .prepare(
      `${CANONICAL_CTE}
       SELECT substr(ts, 1, ${bucketLen[unit]}) AS bucket,
              COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost
         FROM canonical_usage WHERE ${win}
        GROUP BY bucket`
    )
    .all(params);
  const byBucket = new Map(bucketRows.map((row) => [row.bucket, row]));
  const series = [];
  for (let d = start; d < end; d = stepBucket(d, unit)) {
    const key = bucketKey(d, unit);
    const row = byBucket.get(key);
    series.push({ key, runs: row?.runs || 0, tokens: row?.tokens || 0, cost: Number((row?.cost || 0).toFixed(4)) });
  }
  const byUser = db
    .prepare(
      `${CANONICAL_CTE}
       SELECT author_id AS userId,
              COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost
         FROM canonical_usage WHERE ${win} AND author_id <> ''
        GROUP BY author_id ORDER BY runs DESC, cost DESC`
    )
    .all(params)
    .map((row) => ({ ...row, cost: Number((row.cost || 0).toFixed(4)) }));
  const byChannel = db
    .prepare(
      `${CANONICAL_CTE}
       SELECT channel_id AS channelId, slug,
              COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost
         FROM canonical_usage WHERE ${win} AND channel_id <> ''
        GROUP BY channel_id ORDER BY runs DESC, cost DESC`
    )
    .all(params)
    .map((row) => ({ ...row, cost: Number((row.cost || 0).toFixed(4)) }));
  return {
    range: r,
    unit,
    start: params.start,
    end: params.end,
    totals: {
      runs: totals?.runs || 0,
      tokens: totals?.tokens || 0,
      tokensIn: totals?.tokens_in || 0,
      tokensOut: totals?.tokens_out || 0,
      cost: Number((totals?.cost || 0).toFixed(4)),
      unpricedRuns: totals?.unpriced_runs || 0,
      users: totals?.users || 0,
      channels: totals?.channels || 0,
    },
    series,
    byUser,
    byChannel,
  };
}
