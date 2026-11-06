// Claude Code reports SESSION totals, not turn totals. Since CLI 2.1.277 the terminal `result`
// line's `total_cost_usd` and `modelUsage` are cumulative for the whole provider session — a run
// resumed with `-r` restores the earlier turns' spend before adding its own — while `usage` stays
// the main loop's own tokens and EXCLUDES every subagent. The ledger records one row per gateway
// run, so recording those cumulative figures verbatim charged a resumed thread its whole history
// on every message (the development ledger's longest thread of the day reported $1.67, $2.44,
// $2.81 … $5.28 for eight turns whose tokens shrank the whole time) and hid a Sonnet subagent's
// spend inside the Opus row that spawned it.
//
// This module is the one place that turns the cumulative report into THIS run's delta: the
// previous row of the same provider session is the baseline, every model's counters and cost are
// differenced against it, and the raw cumulative figures are retained beside the row so the next
// run can difference against them and a historical repair stays lossless. It depends on nothing
// in the gateway (the schema migration repairs history through it before the gateway modules
// exist), so it lives beside the migrations rather than under src/gateway.
//
// The baseline is the last RECORDED cumulative, not the last turn's: a run whose ledger write was
// dropped is absorbed by the next delta, so a session's recorded total never drifts from what the
// CLI reports as its total.

const EPSILON = 1e-9;

const n = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

// One `modelUsage` entry (`{ inputTokens, outputTokens, cacheReadInputTokens,
// cacheCreationInputTokens, costUSD, contextWindow }`; snake_case accepted) → fixed counters.
// The ledger stores the result of this function verbatim, so the normalized shape itself is
// accepted too: a stored baseline must parse back to the counters it was written from.
export function normalizeClaudeModelUsage(entry = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  const cost = Number(e.costUSD ?? e.cost_usd ?? e.costUsd);
  return {
    input: n(e.inputTokens ?? e.input_tokens ?? e.input),
    cacheRead: n(e.cacheReadInputTokens ?? e.cache_read_input_tokens ?? e.cacheRead),
    cacheWrite: n(e.cacheCreationInputTokens ?? e.cache_creation_input_tokens ?? e.cacheWrite),
    output: n(e.outputTokens ?? e.output_tokens ?? e.output),
    costUSD: Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

function modelUsageEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key]) => typeof key === "string" && key.trim() && key !== "<synthetic>")
    .map(([key, entry]) => [key.trim(), normalizeClaudeModelUsage(entry)]);
}

// The cumulative figures a Claude terminal result carries, in the shape the ledger retains beside
// the row. Null when the result carries no session total at all (an older CLI, a failed turn with
// no terminal line, or another engine) — the caller then records what it was given, as before.
export function claudeCumulativeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cost = Number(raw.total_cost_usd ?? raw.totalCostUSD);
  const models = modelUsageEntries(raw.modelUsage ?? raw.model_usage);
  if (!Number.isFinite(cost) && !models.length) return null;
  return {
    costUSD: Number.isFinite(cost) && cost >= 0 ? cost : null,
    models: Object.fromEntries(models),
  };
}

export function parseClaudeSnapshot(costCumulative, modelUsageJson) {
  const cost = Number(costCumulative);
  let models = {};
  if (modelUsageJson) {
    try { models = Object.fromEntries(modelUsageEntries(JSON.parse(String(modelUsageJson)))); } catch { models = {}; }
  }
  if (!Number.isFinite(cost) && !Object.keys(models).length) return null;
  return { costUSD: Number.isFinite(cost) && cost >= 0 ? cost : null, models };
}

// What THIS run spent: `current` minus `previous` (the last recorded cumulative of the same
// session). With no baseline the session is new and the cumulative IS the delta. A cumulative that
// went DOWN means the CLI restarted its totals (a pre-2.1.277 CLI reporting per call, or a session
// re-minted under the same id) — the report is taken at face value, flagged `reset`, so the row
// never records a negative or a silently dropped figure.
export function claudeSessionDelta(current, previous = null) {
  if (!current) return null;
  const prev = previous && typeof previous === "object" ? previous : null;
  const curCost = current.costUSD;
  const prevCost = prev?.costUSD ?? null;
  const reset = prev !== null && curCost !== null && prevCost !== null && curCost + EPSILON < prevCost;
  const base = reset ? null : prev;
  const costUSD = curCost === null ? null : base?.costUSD != null ? Math.max(0, curCost - base.costUSD) : curCost;
  const models = [];
  let consistent = true;
  for (const [model, cur] of Object.entries(current.models || {})) {
    const before = base?.models?.[model] || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUSD: 0 };
    const delta = {
      input: cur.input - before.input,
      cacheRead: cur.cacheRead - before.cacheRead,
      cacheWrite: cur.cacheWrite - before.cacheWrite,
      output: cur.output - before.output,
      costUSD: cur.costUSD === null ? null : cur.costUSD - (before.costUSD ?? 0),
    };
    if ([delta.input, delta.cacheRead, delta.cacheWrite, delta.output].some((v) => v < 0) || (delta.costUSD !== null && delta.costUSD < -EPSILON)) consistent = false;
    if (delta.costUSD !== null && delta.costUSD < 0) delta.costUSD = 0;
    // A model the session used earlier but not in this run contributes nothing — no empty slice.
    if (delta.input + delta.cacheRead + delta.cacheWrite + delta.output === 0 && !(delta.costUSD > 0)) continue;
    models.push({ model, ...delta });
  }
  // Per-model slices are only trustworthy when they add up to the run: every counter moved
  // forward, and every model is priced when the session total is. A partially priced split would
  // make the per-model chart disagree with the headline, so it is dropped as a whole.
  const priced = models.every((m) => m.costUSD !== null);
  const modelTotal = models.reduce((sum, m) => sum + (m.costUSD || 0), 0);
  const reconciles = costUSD === null || !priced || Math.abs(modelTotal - costUSD) <= Math.max(1e-6, costUSD * 1e-6);
  return {
    costUSD,
    models: consistent && (costUSD === null || priced) && reconciles ? models : [],
    reset,
    tokensIn: models.reduce((sum, m) => sum + m.input + m.cacheRead + m.cacheWrite, 0),
    tokensOut: models.reduce((sum, m) => sum + m.output, 0),
    cumulative: current,
  };
}

// The last recorded cumulative of a provider session, read from the ledger. `beforeId` keeps a
// re-record (the repair) from reading its own row.
export function latestClaudeSnapshot(db, sessionId, { beforeId = null } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const row = db.prepare(
    `SELECT provider_cost_cumulative, provider_model_usage FROM usage
      WHERE engine = 'claude' AND session_id = ? AND provider_cost_cumulative IS NOT NULL
        ${beforeId ? "AND id < ?" : ""}
      ORDER BY id DESC LIMIT 1`
  ).get(...(beforeId ? [id, beforeId] : [id]));
  return row ? parseClaudeSnapshot(row.provider_cost_cumulative, row.provider_model_usage) : null;
}

// Historical rows recorded the cumulative figure as the run's own. Re-difference every Claude
// session's rows in order, keeping the original cumulative beside each row so the operation is
// lossless and idempotent (a row that already carries its cumulative is a baseline, not a target).
// Only rows from `since` on are touched: before the image pinned Claude Code ≥ 2.1.277 the CLI
// reported per-call figures and those rows are already deltas.
export function repairClaudeCumulativeCost(db, { since = "" } = {}) {
  const rows = db.prepare(
    `SELECT id, session_id, cost_usd, provider_cost_cumulative FROM usage
      WHERE engine = 'claude' AND session_id <> '' AND cost_usd IS NOT NULL ${since ? "AND ts >= ?" : ""}
      ORDER BY session_id, id`
  ).all(...(since ? [since] : []));
  const update = db.prepare("UPDATE usage SET cost_usd = ?, provider_cost_cumulative = ? WHERE id = ?");
  let changed = 0;
  let previous = { session: "", cost: null };
  for (const row of rows) {
    if (row.session_id !== previous.session) previous = { session: row.session_id, cost: null };
    if (row.provider_cost_cumulative !== null) { previous.cost = Number(row.provider_cost_cumulative); continue; }
    const cumulative = Number(row.cost_usd);
    const delta = previous.cost !== null && cumulative + EPSILON >= previous.cost ? cumulative - previous.cost : cumulative;
    update.run(delta, cumulative, row.id);
    if (Math.abs(delta - cumulative) > EPSILON) changed += 1;
    previous.cost = cumulative;
  }
  return { scanned: rows.length, changed };
}
