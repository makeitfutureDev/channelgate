import { getContextWindow } from "../config/settings.js";
import { adapterFor, engineLabel } from "../engines/registry.js";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberField(value, ...keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const n = Number(value[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function modelUsageEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(([key]) => typeof key === "string" && key.trim());
}

function dominantModelUsageKey(value) {
  const entries = modelUsageEntries(value);
  let bestKey = "";
  let bestScore = -1;
  for (const [key, usage] of entries) {
    const outputTokens = numberField(usage, "outputTokens", "output_tokens", "completion_tokens") ?? 0;
    if (outputTokens > bestScore) {
      bestKey = key;
      bestScore = outputTokens;
    }
  }
  return bestKey || entries[0]?.[0] || "";
}

function modelUsageContextWindow(raw, model) {
  if (!raw || typeof raw !== "object" || !model) return null;
  for (const usageMap of [raw.modelUsage, raw.model_usage]) {
    const match = modelUsageEntries(usageMap).find(([key]) => key === model);
    const contextWindow = numberField(match?.[1], "contextWindow", "context_window");
    if (contextWindow && contextWindow > 0) return contextWindow;
  }
  return null;
}

function modelFromRaw(raw) {
  if (!raw || typeof raw !== "object") return "";
  return firstNonEmpty(
    raw.model,
    raw.model_id,
    raw.modelId,
    raw.current_model,
    raw.currentModel,
    raw.turn?.model,
    raw.turn?.model_id,
    raw.turn?.modelId,
    raw.response?.model,
    raw.response?.model_id,
    raw.message?.model,
    raw.message?.model_id,
    raw.item?.model,
    raw.item?.model_id,
    dominantModelUsageKey(raw.modelUsage),
    dominantModelUsageKey(raw.model_usage)
  );
}

// Resolve the model that actually answered the last turn. Runtime metadata wins; configured
// overrides are only a fallback for CLIs that do not report their selected default model.
// This is the RUNTIME truth — context-window math and Codex cost rates key on it. The label
// shown to the user is modelLabel below, which prefers the CONFIGURED model instead.
export function resolveCurrentModel(result = {}) {
  return firstNonEmpty(modelFromRaw(result.raw), result.runtimeModel, result.model);
}

// Short human label for the model shown on a reply. Prefers the CONFIGURED runtime the run
// resolved (thread override → channel/DM model → gateway default — run.js stamps it on
// result.model), so the footer reflects the pick that governed the turn; the CLI-reported
// model fills in only when nothing is configured anywhere. "claude-opus-4-8" -> "Opus 4.8",
// "opus[1m]" -> "Opus 1M"; unknown ids pass through as-is.
export function modelLabel(result = {}) {
  const raw = firstNonEmpty(result.model, resolveCurrentModel(result));
  if (!raw) return engineLabel(result.engine) || "Claude";
  const suffix = /\[1m\]/i.test(raw) ? " 1M" : "";
  const m = raw.replace(/^claude-/, "").replace(/\[.*?\]/g, "").match(/^(opus|sonnet|haiku|fable)[-.]?([\d.-]*)$/i);
  if (!m) return raw;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const ver = (m[2] || "").replace(/-/g, ".");
  return (ver ? `${name} ${ver}` : name) + suffix;
}

// Context window for the model a run actually used, not the global settings constant.
export function contextWindowFor(result = {}) {
  const raw = resolveCurrentModel(result);
  // The [1m] suffix names a CONFIGURED variant the CLI does not echo back (an `opus[1m]` run
  // reports plain `claude-opus-5`), so it is checked against the configured model as well as the
  // runtime one, and BEFORE the runtime windows below — those report the family's standard 200k
  // for a 1M run and would otherwise understate the window fivefold.
  if (/\[1m\]/i.test(raw) || /\[1m\]/i.test(String(result.model || ""))) return 1_000_000;
  const runtimeWindow = modelUsageContextWindow(result.raw, raw);
  if (runtimeWindow) return runtimeWindow;
  const requestWindow = Array.isArray(result.usageRequests)
    ? Number(result.usageRequests.findLast((request) => Number(request?.contextWindow) > 0)?.contextWindow)
    : 0;
  if (requestWindow > 0) return requestWindow;
  if (/opus|sonnet|haiku|fable|claude/i.test(raw)) return 200_000;
  // Fall back to the engine's own declared window rather than assuming Claude's.
  if (/gpt-|codex/i.test(raw)) return 272_000;
  const declared = adapterFor(result.engine)?.contextWindow;
  if (declared) return declared;
  return getContextWindow();
}
