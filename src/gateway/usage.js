// Usage ledger — one normalized row per run, in the `usage` table (see ../db). This is the
// spend/visibility layer: every interactive, scheduled, and background-continuation run records
// who ran what, on which engine/model, and how many tokens / how much it cost. Typed, indexed
// columns (ts, channel_id, author_id) make the per-day/week/month/channel/user rollups the Audit
// view and future dashboards need cheap. Daemon-side only (never inside a channel cwd).
//
// No cap is enforced — this is for understanding + the Audit view, per the product decision.
import { getDb } from "../db/index.js";
import { getSettings, getCodexModelRates, getAssumedModels } from "../config/settings.js";
import { countDrop } from "../util/drops.js";
import { resolveCurrentModel, modelDisplayLabel } from "./model-info.js";
import { engineSupports, engineCostRateKey } from "../engines/registry.js";
import { normalizeCodexTokenUsage } from "../engines/codex-usage.js";

// Codex reports no dollar cost — derive an ESTIMATE from the per-model $/1M rates in Settings
// (input / cached-input / output; OpenAI's cached_input_tokens is a SUBSET of input_tokens, so
// it's priced at the cached rate and subtracted from the full-price portion). Model lookup:
// exact key → official dated-snapshot prefix. Empty/`codex` is a CLI sentinel, not an official API
// model id, so it stays unpriced until the runtime model is resolved. The legacy blended rate is
// retained only as an explicit admin fallback for an unknown non-empty runtime model.
export const CODEX_PRICING_BASIS = "openai-standard-effective-dates-2026-09-14";
const LONG_CONTEXT_RATE_KEYS = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]);
function codexRateKey(rates, model) {
  const m = String(model || "").toLowerCase();
  if (!m || m === "codex") return "";
  if (rates[m]) return m;
  return Object.keys(rates)
    // Only inherit a base rate for an official dated snapshot. A named sibling such as
    // gpt-5.3-codex-spark is a different model and stays unpriced until OpenAI publishes its rate.
    .filter((key) => m.startsWith(`${key}-`) && /^\d{4}(?:-\d{2}){1,2}$/.test(m.slice(key.length + 1)))
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

export function estimateCodexCost(u = {}, model = "", requests = [], { rates = getCodexModelRates() } = {}) {
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
  // Neither a real cost NOR a configured rate of its own (the Qwen harness, whose adapter drops
  // the Anthropic-priced figure its CLI reports): record the tokens and no dollar figure. Falling
  // through to the Codex estimator here would price QwenCloud usage with OpenAI's rate table.
  if (!engineCostRateKey(result.engine)) return { inTok, outTok, cachedTok, cacheWriteTok, costUSD: null, estimated: false };
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
    pricingBasis: estimate.estimated ? CODEX_PRICING_BASIS : "unpriced",
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
//
// Returns what the LEDGER settled on for this run — { costUSD, costEstimated, tokensIn, tokensOut }
// — so a caller that has to publish a cost (the run API's status endpoint, its `api_run_done`
// event and its webhook) reports the same figure the ledger stores instead of a bare `null`
// whenever the engine reports no dollar amount of its own (Codex never does — QA API-001). Null on
// a failure, because a caller must not invent a number the ledger does not have.
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
           cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status, session_id)
         VALUES(@ts, @channel_id, @slug, @author_id, @engine, @model, @task_kind, @tokens_in, @tokens_out,
           @cost_usd, @cost_estimated, @duration_ms, @runtime_model, @accounting_status, @session_id)`
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
        // The ENGINE session this run spent tokens in. Recorded so external-usage.js can tell a
        // transcript the gateway wrote from one a person drove by hand: without it, the two are
        // indistinguishable on disk and outside spend can only be guessed at.
        session_id: String(result.sessionId || ""),
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
      // What the ledger SETTLED on, read back the way every other surface reads it: when the run
      // reported per-component accounting, the CANONICAL cost is the component rollup, not the
      // row's cumulative-token estimate. Reading it here is what stops an API caller and the Audit
      // view from quoting two different costs for the same run.
      try {
        const settled = db.prepare(
          `${CANONICAL_CTE} SELECT canonical_cost_usd AS cost_usd, canonical_cost_estimated AS cost_estimated,
             canonical_tokens_in AS tokens_in, canonical_tokens_out AS tokens_out
             FROM canonical_usage WHERE id = @id`
        ).get({ id: usageId });
        if (settled) {
          return {
            costUSD: settled.cost_usd ?? null,
            costEstimated: Boolean(settled.cost_estimated),
            tokensIn: settled.tokens_in ?? inTok,
            tokensOut: settled.tokens_out ?? outTok,
          };
        }
      } catch {
        /* the read-back is a nicety; the row we just wrote is answer enough */
      }
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
      throw error;
    }
    return { costUSD, costEstimated: estimated, tokensIn: inTok, tokensOut: outTok };
  } catch (err) {
    countDrop("usage", err); // ledger is best-effort, but a silent drop diverges the spend numbers
    return null;
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

// Per-MODEL attribution over the same ledger. A run is one row with one `model`, but a Codex run
// with component accounting can have spent on SEVERAL models (a gpt-5.6-sol turn whose subagent ran
// gpt-6-astra, or an auto-review pass), and the canonical rollup above deliberately collapses that
// back to one figure per run. Splitting a chart by model therefore cannot reuse it: this CTE
// explodes a run into one row per model that actually answered — its components when it has them,
// otherwise the run itself — so `SUM(cost)` over the whole window still equals the canonical total
// while `GROUP BY model` is now truthful.
//
// `run_share` is 1 only on the row that owns the run, so COUNT-style "runs per model" stays a count
// of runs rather than of components. `is_root` marks the model a run is headlined by, which is what
// the per-run model tables key on.
// One model, one key. The ledger stores whatever the CLI reported — including a dated snapshot
// (`claude-haiku-4-5-20251001`) — while the transcript scanners fold those onto the family id the
// model is billed under. Merging the two sides without agreeing on a key produced TWO "Haiku 4.5"
// rows on the Models card, one per source, which reads as a bug and breaks the stacked bars (a
// segment looks up its model by key). A CONTEXT variant is deliberately kept distinct: `opus[1m]`
// is the same price but a different configuration, and seeing it separately is the point.
export function mergeModelKey(model) {
  const raw = String(model || "").trim();
  const variant = raw.match(/\[[^\]]*\]$/)?.[0] || "";
  const base = variant ? raw.slice(0, -variant.length) : raw;
  return base.toLowerCase().replace(/-(\d{8}|\d{4}(?:-\d{2}){2})$/, "") + variant.toLowerCase();
}

// The same fallback for the external side, where a scanned bucket can in principle carry no model
// (a Codex rollout whose `turn_context` never named one). Kept as one expression so the ledger and
// the scan cannot drift on what "unknown" resolves to.
const EXTERNAL_MODEL_EXPR = `COALESCE(NULLIF(model, ''), CASE engine WHEN 'claude' THEN @assumedClaude WHEN 'codex' THEN @assumedCodex END, '')`;

// `@assumedClaude` / `@assumedCodex` fill in the model for a run that recorded none. The gateway
// only began resolving the runtime model partway through its life, so older rows carry no model at
// all — on the development deployment 387 runs, $990 and 443M tokens, which would otherwise be one
// undifferentiated "model unknown" band. They are ATTRIBUTION values (see getAssumedModels): they
// decide which band an already-recorded figure sits in and never price anything, and `assumed`
// travels with each row so a caller can say how much of a band was filled in rather than measured.
const MODEL_ATTRIBUTION_CTE = `WITH component_priced AS (
  SELECT usage_id, COUNT(cost_usd) AS priced, COUNT(*) AS total, MIN(id) AS first_id
    FROM usage_components GROUP BY usage_id
), model_usage AS (
  SELECT u.id, u.ts, u.channel_id, u.slug, u.author_id, u.engine, u.task_kind,
         COALESCE(
           NULLIF(c.model, ''), NULLIF(u.runtime_model, ''), NULLIF(u.model, ''),
           CASE u.engine WHEN 'claude' THEN @assumedClaude WHEN 'codex' THEN @assumedCodex END,
           ''
         ) AS model,
         CASE WHEN COALESCE(NULLIF(c.model, ''), NULLIF(u.runtime_model, ''), NULLIF(u.model, ''), '') = '' THEN 1 ELSE 0 END AS assumed,
         c.tokens_in AS tokens_in, c.tokens_out AS tokens_out,
         -- Mirror CANONICAL_CTE exactly: a run whose components are not ALL priced contributes no
         -- dollar figure at all. Summing only the priced ones here instead would make the per-model
         -- chart add up to more than the headline total it sits next to.
         CASE WHEN p.priced = p.total THEN c.cost_usd ELSE NULL END AS cost_usd,
         c.cost_estimated AS cost_estimated,
         CASE WHEN c.source_kind = 'root' THEN 1 ELSE 0 END AS is_root,
         CASE WHEN c.id = p.first_id THEN 1 ELSE 0 END AS run_share
    FROM usage u
    JOIN usage_components c ON c.usage_id = u.id
    JOIN component_priced p ON p.usage_id = u.id
  UNION ALL
  SELECT u.id, u.ts, u.channel_id, u.slug, u.author_id, u.engine, u.task_kind,
         COALESCE(
           NULLIF(u.runtime_model, ''), NULLIF(u.model, ''),
           CASE u.engine WHEN 'claude' THEN @assumedClaude WHEN 'codex' THEN @assumedCodex END,
           ''
         ) AS model,
         CASE WHEN COALESCE(NULLIF(u.runtime_model, ''), NULLIF(u.model, ''), '') = '' THEN 1 ELSE 0 END AS assumed,
         u.tokens_in, u.tokens_out, u.cost_usd, u.cost_estimated, 1 AS is_root, 1 AS run_share
    FROM usage u
   WHERE NOT EXISTS (SELECT 1 FROM usage_components c WHERE c.usage_id = u.id)
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

// Bucket keys for the `external_usage` table, whose rows are always UTC-hour granular. The window
// is half-open like the ledger's: a range that ends on an exact hour (last month, last year)
// excludes that hour, while one that ends at "now" includes the hour in progress.
function bucketWindow(start, end) {
  const startBucket = start.toISOString().slice(0, 13);
  const endHour = new Date(Math.ceil(end.getTime() / 3600000) * 3600000);
  return { bucketStart: startBucket, bucketEnd: endHour.toISOString().slice(0, 13) };
}

const round4 = (n) => Number((Number(n) || 0).toFixed(4));

// Where usage that did NOT come through chat was driven from. Ordered most-to-least expected so the
// dashboard's breakdown reads the same way every time.
export const USAGE_ORIGINS = ["gateway", "terminal", "vscode", "desktop", "ssh", "headless", "other"];

// Rollups for the Dashboard view over a named `range`. All aggregation is in SQL (cheap even with a
// large ledger). `series` is gap-filled to one point per bucket (zero on quiet buckets) so the
// charts stay stable; KPI totals + per-user/per-channel breakdowns use the same [start, end) window.
//
// Three dimensions scope it:
//   `harness`  all | claude | codex   — which engine's rows count.
//   `source`   all | gateway | external — chat-driven runs, usage the gateway never launched
//              (../gateway/external-usage.js), or both.
//   `range`    the named window.
//
// Every point also carries `models`, a per-model split of that bucket's cost/tokens/runs, which is
// what lets the charts stack by model instead of drawing one undifferentiated line. It is built
// from MODEL_ATTRIBUTION_CTE (so a Codex run's subagent model is its own slice) unioned with the
// external scan's own per-model rows.
export function usageDashboard({ range = "last30", harness = "all", source = "all" } = {}) {
  const r = DASHBOARD_RANGES.includes(range) ? range : "last30";
  const selectedHarness = ["claude", "codex"].includes(harness) ? harness : "all";
  const selectedSource = ["gateway", "external"].includes(source) ? source : "all";
  const withGateway = selectedSource !== "external";
  const withExternal = selectedSource !== "gateway";
  const now = new Date();
  const { start, end, unit } = resolveRange(r, now);
  const { bucketStart, bucketEnd } = bucketWindow(start, end);
  // node:sqlite rejects a named parameter the statement does not use, so the two halves carry their
  // own bindings: the ledger filters on the ISO timestamp, `external_usage` on its hour-bucket key.
  const harnessBinding = selectedHarness === "all" ? {} : { harness: selectedHarness };
  const params = { start: start.toISOString(), end: end.toISOString(), ...harnessBinding };
  // Only the MODEL queries bind these (node:sqlite rejects a parameter a statement does not use).
  const assumed = getAssumedModels();
  const assumedBinding = { assumedClaude: assumed.claude || "", assumedCodex: assumed.codex || "" };
  const modelParams = { ...params, ...assumedBinding };
  const extParams = { bucketStart, bucketEnd, ...harnessBinding };
  const extModelParams = { ...extParams, ...assumedBinding };
  const win = "ts >= @start AND ts < @end" + (selectedHarness === "all" ? "" : " AND engine = @harness");
  const modelWin = win;
  const extWin = "bucket >= @bucketStart AND bucket < @bucketEnd" + (selectedHarness === "all" ? "" : " AND engine = @harness");
  const db = getDb();
  const one = (sql) => (withGateway ? db.prepare(sql).get(params) : null);
  const many = (sql, enabled) => (enabled ? db.prepare(sql).all(params) : []);
  const manyModel = (sql) => (withGateway ? db.prepare(sql).all(modelParams) : []);
  const manyExt = (sql) => (withExternal ? db.prepare(sql).all(extParams) : []);
  const manyExtModel = (sql) => (withExternal ? db.prepare(sql).all(extModelParams) : []);

  const totals = one(
    `${CANONICAL_CTE}
       SELECT COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_tokens_in), 0) AS tokens_in,
              COALESCE(SUM(canonical_tokens_out), 0) AS tokens_out,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost,
              COALESCE(SUM(CASE WHEN engine = 'claude' THEN canonical_cost_usd ELSE 0 END), 0) AS claude_cost,
              COALESCE(SUM(CASE WHEN engine = 'codex' THEN canonical_cost_usd ELSE 0 END), 0) AS codex_cost,
              SUM(CASE WHEN canonical_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs,
              COUNT(DISTINCT author_id) AS users,
              COUNT(DISTINCT channel_id) AS channels
         FROM canonical_usage WHERE ${win}`
  );
  const extTotals = withExternal
    ? db.prepare(
        `SELECT COALESCE(SUM(turns), 0) AS runs,
                COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
                COALESCE(SUM(tokens_in), 0) AS tokens_in,
                COALESCE(SUM(tokens_out), 0) AS tokens_out,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(CASE WHEN engine = 'claude' THEN cost_usd ELSE 0 END), 0) AS claude_cost,
                COALESCE(SUM(CASE WHEN engine = 'codex' THEN cost_usd ELSE 0 END), 0) AS codex_cost,
                SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_rows,
                COUNT(DISTINCT session_id) AS sessions
           FROM external_usage WHERE ${extWin}`
      ).get(extParams)
    : null;

  // ── series, gap-filled, with the per-model split each bucket is stacked by ────────────────────
  const gatewayBuckets = many(
    `${CANONICAL_CTE}
       SELECT substr(ts, 1, ${bucketLen[unit]}) AS bucket,
              COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost
         FROM canonical_usage WHERE ${win}
        GROUP BY bucket`,
    withGateway
  );
  const externalBuckets = manyExt(
    `SELECT substr(bucket, 1, ${bucketLen[unit]}) AS bucket,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM external_usage WHERE ${extWin}
      GROUP BY 1`
  );
  const gatewayModelBuckets = manyModel(
    `${MODEL_ATTRIBUTION_CTE}
       SELECT substr(ts, 1, ${bucketLen[unit]}) AS bucket, model,
              COALESCE(SUM(run_share), 0) AS runs,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
         FROM model_usage WHERE ${modelWin}
        GROUP BY bucket, model`
  );
  const externalModelBuckets = manyExtModel(
    `SELECT substr(bucket, 1, ${bucketLen[unit]}) AS bucket, ${EXTERNAL_MODEL_EXPR} AS model,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM external_usage WHERE ${extWin}
      GROUP BY 1, 2`
  );

  const totalsByBucket = new Map();
  const addBucket = (row) => {
    const cur = totalsByBucket.get(row.bucket) || { runs: 0, tokens: 0, cost: 0 };
    cur.runs += Number(row.runs) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    totalsByBucket.set(row.bucket, cur);
  };
  gatewayBuckets.forEach(addBucket);
  externalBuckets.forEach(addBucket);

  const modelsByBucket = new Map();
  const addModelBucket = (row) => {
    const model = mergeModelKey(row.model);
    const forBucket = modelsByBucket.get(row.bucket) || new Map();
    const cur = forBucket.get(model) || { runs: 0, tokens: 0, cost: 0 };
    cur.runs += Number(row.runs) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    forBucket.set(model, cur);
    modelsByBucket.set(row.bucket, forBucket);
  };
  gatewayModelBuckets.forEach(addModelBucket);
  externalModelBuckets.forEach(addModelBucket);

  const series = [];
  for (let d = start; d < end; d = stepBucket(d, unit)) {
    const key = bucketKey(d, unit);
    const row = totalsByBucket.get(key);
    const models = {};
    for (const [model, value] of modelsByBucket.get(key) || []) {
      models[model] = { runs: value.runs, tokens: value.tokens, cost: round4(value.cost) };
    }
    series.push({ key, runs: row?.runs || 0, tokens: row?.tokens || 0, cost: round4(row?.cost || 0), models });
  }

  // ── per-model totals for the window: the dedicated "which models are we using" chart ─────────
  const byModel = new Map();
  const addModelTotal = (row, sourceKind) => {
    const model = mergeModelKey(row.model);
    const cur = byModel.get(model) || { model, engine: "", runs: 0, tokens: 0, cost: 0, gatewayRuns: 0, externalRuns: 0, unpriced: 0, assumedRuns: 0 };
    cur.runs += Number(row.runs) || 0;
    // How much of this band was FILLED IN rather than measured (see MODEL_ATTRIBUTION_CTE).
    cur.assumedRuns += Number(row.assumed) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    cur.unpriced += Number(row.unpriced) || 0;
    cur[sourceKind === "external" ? "externalRuns" : "gatewayRuns"] += Number(row.runs) || 0;
    // One model can only belong to one engine; a mixed answer means the ledger disagrees with
    // itself, so the first engine seen wins rather than the last.
    if (!cur.engine && row.engine) cur.engine = String(row.engine);
    byModel.set(model, cur);
  };
  manyModel(
    `${MODEL_ATTRIBUTION_CTE}
       SELECT model, engine,
              COALESCE(SUM(CASE WHEN assumed = 1 THEN run_share ELSE 0 END), 0) AS assumed,
              COALESCE(SUM(run_share), 0) AS runs,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM model_usage WHERE ${modelWin}
        GROUP BY model, engine`
  ).forEach((row) => addModelTotal(row, "gateway"));
  manyExtModel(
    `SELECT ${EXTERNAL_MODEL_EXPR} AS model, engine,
            COALESCE(SUM(CASE WHEN model = '' THEN turns ELSE 0 END), 0) AS assumed,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost,
            SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM external_usage WHERE ${extWin}
      GROUP BY 1, engine`
  ).forEach((row) => addModelTotal(row, "external"));
  const models = [...byModel.values()]
    // A bucket whose only content was a turn count carries no model; it must not become a slice.
    .filter((m) => m.model || m.tokens > 0 || m.cost > 0)
    .map((m) => ({ ...m, label: modelDisplayLabel(m.model, m.engine), cost: round4(m.cost) }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label));

  // Every breakdown below carries the SAME per-model split the charts stack by, so one colour means
  // one model everywhere on the page — a bar for a user, a channel or an origin reads as "who spent
  // it" AND "on what" at once, instead of needing a second chart to answer the second question.
  const foldModels = (target, row, metric = null) => {
    const model = mergeModelKey(row.model);
    const models = target.models || (target.models = {});
    const cur = models[model] || (models[model] = { runs: 0, tokens: 0, cost: 0 });
    cur.runs += Number(row.runs) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    return cur;
  };
  const roundModels = (entry) => {
    for (const value of Object.values(entry.models || {})) value.cost = round4(value.cost);
    return entry;
  };

  // ── where it came from: the chat gateway itself, or each way someone drove an engine directly ─
  const byOrigin = new Map();
  const addOrigin = (origin, row) => {
    const cur = byOrigin.get(origin) || { origin, runs: 0, tokens: 0, cost: 0 };
    cur.runs += Number(row.runs) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    byOrigin.set(origin, cur);
  };
  if (withGateway && totals) addOrigin("gateway", totals);
  // The chat gateway's own bar splits by the models its runs used.
  manyModel(
    `${MODEL_ATTRIBUTION_CTE}
       SELECT model,
              COALESCE(SUM(run_share), 0) AS runs,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
         FROM model_usage WHERE ${modelWin}
        GROUP BY model`
  ).forEach((row) => { const o = byOrigin.get("gateway"); if (o) foldModels(o, row); });
  manyExtModel(
    `SELECT origin, ${EXTERNAL_MODEL_EXPR} AS model,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM external_usage WHERE ${extWin}
      GROUP BY origin, 2`
  ).forEach((row) => {
    const origin = String(row.origin || "other");
    addOrigin(origin, row);
    foldModels(byOrigin.get(origin), row);
  });
  const origins = [...byOrigin.values()]
    .map((o) => roundModels({ ...o, cost: round4(o.cost) }))
    .sort((a, b) => USAGE_ORIGINS.indexOf(a.origin) - USAGE_ORIGINS.indexOf(b.origin) || b.cost - a.cost);

  const userTotals = new Map(
    many(
      `${CANONICAL_CTE}
         SELECT author_id AS userId,
                COUNT(*) AS runs,
                COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
                COALESCE(SUM(canonical_cost_usd), 0) AS cost
           FROM canonical_usage WHERE ${win} AND author_id <> ''
          GROUP BY author_id ORDER BY runs DESC, cost DESC`,
      withGateway
    ).map((row) => [row.userId, { ...row, cost: round4(row.cost), models: {} }])
  );
  // Outside usage has no author — nobody signed in to a terminal through the gateway — so this
  // table stays chat-driven runs only, and its bars split by the models those runs used.
  manyModel(
    `${MODEL_ATTRIBUTION_CTE}
       SELECT author_id AS userId, model,
              COALESCE(SUM(run_share), 0) AS runs,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
         FROM model_usage WHERE ${modelWin} AND author_id <> ''
        GROUP BY author_id, model`
  ).forEach((row) => { const u = userTotals.get(row.userId); if (u) foldModels(u, row); });
  const byUser = [...userTotals.values()].map(roundModels);

  // External rows join the per-channel table only when the scan could resolve their working
  // directory to a channel folder; unattributable outside work stays in the totals and the origin
  // breakdown, where it is honest, instead of being charged to a conversation that never ran it.
  const channelTotals = new Map();
  const addChannel = (row) => {
    const id = String(row.channelId || "");
    const cur = channelTotals.get(id) || { channelId: id, slug: row.slug || "", runs: 0, tokens: 0, cost: 0, externalCost: 0 };
    cur.runs += Number(row.runs) || 0;
    cur.tokens += Number(row.tokens) || 0;
    cur.cost += Number(row.cost) || 0;
    if (!cur.slug && row.slug) cur.slug = row.slug;
    channelTotals.set(id, cur);
  };
  many(
    `${CANONICAL_CTE}
       SELECT channel_id AS channelId, slug,
              COUNT(*) AS runs,
              COALESCE(SUM(canonical_tokens_in + canonical_tokens_out), 0) AS tokens,
              COALESCE(SUM(canonical_cost_usd), 0) AS cost
         FROM canonical_usage WHERE ${win} AND channel_id <> ''
        GROUP BY channel_id`,
    withGateway
  ).forEach(addChannel);
  manyExt(
    `SELECT channel_id AS channelId, slug,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM external_usage WHERE ${extWin} AND channel_id <> ''
      GROUP BY channel_id`
  ).forEach((row) => {
    addChannel(row);
    const cur = channelTotals.get(String(row.channelId || ""));
    if (cur) cur.externalCost = round4(cur.externalCost + (Number(row.cost) || 0));
  });
  manyModel(
    `${MODEL_ATTRIBUTION_CTE}
       SELECT channel_id AS channelId, model,
              COALESCE(SUM(run_share), 0) AS runs,
              COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
         FROM model_usage WHERE ${modelWin} AND channel_id <> ''
        GROUP BY channel_id, model`
  ).forEach((row) => { const c = channelTotals.get(String(row.channelId || "")); if (c) foldModels(c, row); });
  manyExtModel(
    `SELECT channel_id AS channelId, ${EXTERNAL_MODEL_EXPR} AS model,
            COALESCE(SUM(turns), 0) AS runs,
            COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM external_usage WHERE ${extWin} AND channel_id <> ''
      GROUP BY channel_id, 2`
  ).forEach((row) => { const c = channelTotals.get(String(row.channelId || "")); if (c) foldModels(c, row); });
  const byChannel = [...channelTotals.values()]
    .map((c) => roundModels({ ...c, cost: round4(c.cost) }))
    .sort((a, b) => b.runs - a.runs || b.cost - a.cost);

  const gatewayCost = Number(totals?.cost || 0);
  const externalCost = Number(extTotals?.cost || 0);
  return {
    range: r,
    harness: selectedHarness,
    source: selectedSource,
    unit,
    start: params.start,
    end: params.end,
    totals: {
      runs: (totals?.runs || 0) + (extTotals?.runs || 0),
      tokens: (totals?.tokens || 0) + (extTotals?.tokens || 0),
      tokensIn: (totals?.tokens_in || 0) + (extTotals?.tokens_in || 0),
      tokensOut: (totals?.tokens_out || 0) + (extTotals?.tokens_out || 0),
      cost: round4(gatewayCost + externalCost),
      claudeCost: round4(Number(totals?.claude_cost || 0) + Number(extTotals?.claude_cost || 0)),
      codexCost: round4(Number(totals?.codex_cost || 0) + Number(extTotals?.codex_cost || 0)),
      unpricedRuns: (totals?.unpriced_runs || 0) + (extTotals?.unpriced_rows || 0),
      // Runs charted under an assumed model because none was recorded. Reported so the Models card
      // can say which part of a band was filled in rather than measured.
      assumedRuns: models.reduce((sum, m) => sum + (m.assumedRuns || 0), 0),
      users: totals?.users || 0,
      channels: totals?.channels || 0,
      gatewayRuns: totals?.runs || 0,
      gatewayCost: round4(gatewayCost),
      externalRuns: extTotals?.runs || 0,
      externalRequests: extTotals?.requests || 0,
      externalSessions: extTotals?.sessions || 0,
      externalCost: round4(externalCost),
      models: models.length,
    },
    series,
    models,
    origins,
    byUser,
    byChannel,
  };
}
