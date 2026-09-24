// Per-model attribution on the dashboard: the stacked charts and the dedicated models chart.
//
// The invariant every assertion here defends is that the split ADDS UP. A per-model breakdown that
// disagrees with the headline total it sits beside is worse than no breakdown, and the two are
// computed by different SQL (MODEL_ATTRIBUTION_CTE vs CANONICAL_CTE) — so they can drift.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { usageDashboard, mergeModelKey } = await import("../src/gateway/usage.js");
const { modelDisplayLabel } = await import("../src/gateway/model-info.js");

const recent = () => new Date(Date.now() - 1_000).toISOString();

function addRun({ engine = "claude", model, runtimeModel = "", cost = null, tokensIn = 0, tokensOut = 0, channelId = "C1", slug = "room", authorId = "U1" }) {
  const info = getDb().prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out,
       cost_usd, cost_estimated, duration_ms, runtime_model, accounting_status, session_id)
     VALUES(?, ?, ?, ?, ?, ?, 'interactive', ?, ?, ?, 0, 1000, ?, 'provider-reported', '')`,
  ).run(recent(), channelId, slug, authorId, engine, model, tokensIn, tokensOut, cost, runtimeModel);
  return Number(info.lastInsertRowid);
}

function addComponent(usageId, { sourceKey, kind = "root", model, cost, tokensIn = 0, tokensOut = 0 }) {
  getDb().prepare(
    `INSERT INTO usage_components(usage_id, source_key, source_kind, provider_session_id,
       parent_provider_session_id, provider_turn_id, started_ts, ended_ts, model, tokens_in,
       tokens_cached, tokens_cache_write, tokens_out, reasoning_tokens, cost_usd, cost_estimated,
       pricing_basis, provenance, confidence, duration_ms)
     VALUES(?, ?, ?, '', '', '', '', '', ?, ?, 0, 0, ?, 0, ?, 1, 'test', 'test', 'verified-requests', 0)`,
  ).run(usageId, sourceKey, kind, model, tokensIn, tokensOut, cost);
}

test("a run's cost is attributed to the model that answered, and every component model gets its own slice", () => {
  // One plain Claude run, and one Codex run whose subagent used a different (pricier) model. The
  // Codex run is exactly the case the canonical rollup collapses into a single figure.
  addRun({ engine: "claude", model: "claude-opus-5", runtimeModel: "claude-opus-5", cost: 3, tokensIn: 100, tokensOut: 10 });
  const codex = addRun({ engine: "codex", model: "gpt-5.6-sol", runtimeModel: "gpt-5.6-sol", cost: null, tokensIn: 0, tokensOut: 0 });
  addComponent(codex, { sourceKey: "root-1", kind: "root", model: "gpt-5.6-sol", cost: 1, tokensIn: 200, tokensOut: 20 });
  addComponent(codex, { sourceKey: "child-1", kind: "subagent", model: "gpt-6-astra", cost: 4, tokensIn: 300, tokensOut: 30 });

  const d = usageDashboard({ range: "today" });
  const byModel = Object.fromEntries(d.models.map((m) => [m.model, m]));

  assert.deepEqual(Object.keys(byModel).sort(), ["claude-opus-5", "gpt-5.6-sol", "gpt-6-astra"]);
  assert.equal(byModel["gpt-6-astra"].cost, 4, "the subagent's model carries its own spend");
  assert.equal(byModel["gpt-5.6-sol"].cost, 1);
  assert.equal(byModel["claude-opus-5"].cost, 3);

  // The whole point: the slices reconstruct the headline.
  assert.equal(d.models.reduce((sum, m) => sum + m.cost, 0), d.totals.cost);
  assert.equal(d.totals.cost, 8);

  // …and a component is not a run. Two runs happened, so the run counts must still sum to two.
  assert.equal(d.models.reduce((sum, m) => sum + m.runs, 0), d.totals.runs);
  assert.equal(d.totals.runs, 2);
  assert.equal(byModel["gpt-6-astra"].runs, 0, "a subagent-only model heads no run of its own");

  // Every bucket carries the same split, which is what the charts stack by.
  const stacked = d.series.reduce((sum, point) => sum + Object.values(point.models || {}).reduce((s, m) => s + m.cost, 0), 0);
  assert.equal(Number(stacked.toFixed(4)), d.totals.cost);
});

test("a run whose components are only partly priced contributes no dollars to any model", () => {
  // CANONICAL_CTE drops such a run's cost entirely. If the model split summed the priced components
  // anyway, the breakdown would exceed the total it is drawn next to — the exact drift this guards.
  const partial = addRun({ engine: "codex", model: "gpt-5.6-sol", runtimeModel: "gpt-5.6-sol", cost: null });
  addComponent(partial, { sourceKey: "root-2", kind: "root", model: "gpt-5.6-sol", cost: 9, tokensIn: 10, tokensOut: 1 });
  addComponent(partial, { sourceKey: "child-2", kind: "subagent", model: "gpt-6-astra", cost: null, tokensIn: 10, tokensOut: 1 });

  const d = usageDashboard({ range: "today" });
  assert.equal(d.models.reduce((sum, m) => sum + m.cost, 0), d.totals.cost);
  // Tokens are still attributed — they were definitely spent, only their price is unknown.
  assert.ok(d.models.find((m) => m.model === "gpt-6-astra").tokens > 0);
});

test("a run that recorded no model is charted under its engine's fallback, and says so", () => {
  // The gateway only began resolving the runtime model partway through its life. On the
  // development deployment that left 387 runs — $990 and 443M tokens — in a single "model unknown"
  // band. Attributing them keeps the chart readable; `assumedRuns` keeps it honest.
  addRun({ engine: "claude", model: "", runtimeModel: "", cost: 7, tokensIn: 50, tokensOut: 5 });
  addRun({ engine: "codex", model: "", runtimeModel: "", cost: 11, tokensIn: 60, tokensOut: 6 });

  const d = usageDashboard({ range: "today" });
  assert.ok(!d.models.some((m) => !m.model), "no unknown band survives");

  const opus = d.models.find((m) => m.model === "claude-opus-5");
  const sol = d.models.find((m) => m.model === "gpt-5.6-sol");
  assert.ok(opus.assumedRuns >= 1, "the unmodelled Claude run is charted as Opus");
  assert.ok(sol.assumedRuns >= 1, "the unmodelled Codex run is charted as Sol");
  assert.equal(d.totals.assumedRuns, opus.assumedRuns + sol.assumedRuns);

  // The fallback moves a figure between bands; it must never change the total or invent a price.
  assert.equal(d.models.reduce((sum, m) => sum + m.cost, 0), d.totals.cost);
  assert.equal(d.models.reduce((sum, m) => sum + m.runs, 0), d.totals.runs);

  // A run that DID record a model is never marked assumed.
  const known = d.models.find((m) => m.model === "claude-fable-5-1");
  if (known) assert.equal(known.assumedRuns, 0);
});

test("the ledger and the transcript scan agree on one key per model", () => {
  // The ledger stores what the CLI reported — including a dated snapshot — while the scanners fold
  // those onto the family id the model is billed under. Without a shared key the Models card grew
  // TWO "Haiku 4.5" rows (one per source) and a stacked bar segment could not find its model.
  assert.equal(mergeModelKey("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(mergeModelKey("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(mergeModelKey("claude-opus-5-2026-01-02"), "claude-opus-5");
  // A CONTEXT variant is deliberately NOT merged: same price, different configuration, and seeing
  // the 1M runs separately is the point. A version is not a snapshot either.
  assert.equal(mergeModelKey("claude-opus-5[1m]"), "claude-opus-5[1m]");
  assert.equal(mergeModelKey("claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(mergeModelKey(""), "");

  addRun({ engine: "claude", model: "claude-haiku-4-5-20251001", runtimeModel: "claude-haiku-4-5-20251001", cost: 1, tokensIn: 10, tokensOut: 1 });
  addRun({ engine: "claude", model: "claude-haiku-4-5", runtimeModel: "claude-haiku-4-5", cost: 2, tokensIn: 20, tokensOut: 2 });
  const d = usageDashboard({ range: "today" });
  const labels = d.models.map((m) => m.label);
  assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [], "no two rows carry the same label");
  assert.equal(d.models.filter((m) => m.model === "claude-haiku-4-5").length, 1);
});

test("every breakdown carries the per-model split its bars are stacked by", () => {
  addRun({ engine: "claude", model: "claude-opus-5", runtimeModel: "claude-opus-5", cost: 5, tokensIn: 100, tokensOut: 10, channelId: "C9", slug: "stacked", authorId: "U9" });
  addRun({ engine: "codex", model: "gpt-5.6-sol", runtimeModel: "gpt-5.6-sol", cost: 3, tokensIn: 200, tokensOut: 20, channelId: "C9", slug: "stacked", authorId: "U9" });

  const d = usageDashboard({ range: "today" });
  const user = d.byUser.find((u) => u.userId === "U9");
  const channel = d.byChannel.find((c) => c.channelId === "C9");
  const gateway = d.origins.find((o) => o.origin === "gateway");

  for (const [what, entry] of [["user", user], ["channel", channel], ["origin", gateway]]) {
    assert.ok(entry, `${what} row exists`);
    assert.ok(entry.models && Object.keys(entry.models).length >= 2, `${what} carries a model split`);
    // A stacked bar divides the row's OWN total, so the segments have to sum back to it.
    const cost = Object.values(entry.models).reduce((sum, m) => sum + m.cost, 0);
    assert.equal(Number(cost.toFixed(4)), entry.cost, `${what} segments sum to its own cost`);
  }
  assert.equal(Number(Object.values(user.models).reduce((s, m) => s + m.runs, 0)), user.runs);
});

test("model labels survive every id shape the ledger holds", () => {
  assert.equal(modelDisplayLabel("claude-opus-5"), "Opus 5");
  assert.equal(modelDisplayLabel("claude-opus-5[1m]"), "Opus 5 1M");
  assert.equal(modelDisplayLabel("claude-haiku-4-5-20251001"), "Haiku 4.5", "a dated snapshot is the same model");
  assert.equal(modelDisplayLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelDisplayLabel("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(modelDisplayLabel("gpt-6-astra"), "GPT-6 Astra");
  assert.equal(modelDisplayLabel("codex-auto-review"), "codex-auto-review", "an unknown id passes through rather than being forced into a family");
  assert.equal(modelDisplayLabel("", "claude"), "Claude (model unknown)");
});

test("the Overview ships a stacked-by-model chart, a legend and a dedicated models chart", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // The validated categorical palette (scripts/validate_palette.js from the dataviz skill). If a
  // hue changes here, that validator has to be re-run — this assertion is the reminder.
  assert.match(app, /const MODEL_PALETTE = \["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#48a02b", "#9085e9", "#e66767"\];/);
  assert.match(app, /function stackedArea\(/);
  assert.match(app, /function modelLegend\(/, "identity is never carried by colour alone");
  assert.match(app, /function modelBars\(/);
  // The bar lists stack by the same model keys and colours the charts use, so one hue means one
  // model across the whole page rather than per card.
  assert.match(app, /function barTrack\(/);
  assert.match(app, /class="bar-track"><span class="bar-fill bar-stack"/);
  assert.match(app, /\{ keys, metric: "runs" \}/, "runs per user stacks by runs");
  assert.match(app, /\{ keys, metric: "cost" \}/, "where-usage-came-from stacks by cost");
  assert.match(app, /channelBars\(channels, keys\)/);
  // Colour follows the model, not its rank in the current window.
  assert.match(app, /function modelColorMap\(/);
  assert.ok(!/MODEL_PALETTE\[index % MODEL_PALETTE\.length\]/.test(app), "hues must not be cycled by position in a filtered list");
});
