import { engineLabel } from "../engines/registry.js";

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

const variantless = (name) => String(name || "").trim().replace(/\[[^\]]*\]$/, "").toLowerCase();

// The window Claude Code itself reported for the session's main model. The terminal modelUsage is
// keyed by the CONFIGURED name (`claude-opus-4-6[1m]`) while provider messages drop the variant
// suffix (`claude-opus-4-6`), so an exact key wins and the variant-free name is the fallback.
// Helper and subagent models in the same map are never consulted.
function modelUsageContextWindow(raw, ...models) {
  if (!raw || typeof raw !== "object") return null;
  const entries = [raw.modelUsage, raw.model_usage].flatMap((usageMap) => modelUsageEntries(usageMap));
  const windowOf = (entry) => numberField(entry?.[1], "contextWindow", "context_window");
  const names = models.map((model) => String(model || "").trim()).filter(Boolean);
  for (const name of names) {
    const window = windowOf(entries.find(([key]) => key === name));
    if (window && window > 0) return window;
  }
  for (const name of names) {
    const window = windowOf(entries.find(([key]) => variantless(key) === variantless(name)));
    if (window && window > 0) return window;
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
  // A runner's primary provider message is authoritative over a terminal aggregate that can
  // include larger auxiliary-model calls. Older CLIs without that message keep their fallback.
  return firstNonEmpty(result.primaryModel, modelFromRaw(result.raw), result.runtimeModel, result.model);
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

// A model id as a chart legend should print it. Unlike modelLabel above (which answers "what
// governed this reply" for a footer, from a whole run result), this takes a bare id out of the
// usage ledger and has to survive every shape the ledger holds: an API id (`claude-opus-5`), a
// dated snapshot (`claude-haiku-4-5-20251001`), a configured variant (`opus[1m]`), an OpenAI id
// (`gpt-5.6-sol`), a pseudo-model a component carries (`codex-auto-review`), and "" for the rows
// written before the runtime model was resolved. An unrecognized id passes through verbatim rather
// than being forced into a family — a wrong label on a spend chart is worse than an ugly one.
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

export function modelDisplayLabel(model, engine = "") {
  const raw = String(model || "").trim();
  if (!raw) return engineLabel(engine) ? `${engineLabel(engine)} (model unknown)` : "Unknown model";
  const suffix = /\[1m\]/i.test(raw) ? " 1M" : "";
  // Strip the configured-variant suffix and any dated snapshot: both name the same priced model.
  const id = raw.replace(/\[[^\]]*\]/g, "").toLowerCase().replace(/-(\d{8}|\d{4}(?:-\d{2}){2})$/, "");
  const claude = id.replace(/^claude-/, "");
  const family = MODEL_FAMILIES.find((name) => claude === name || claude.startsWith(`${name}-`) || claude.startsWith(`${name}.`));
  if (family) {
    const version = claude.slice(family.length).replace(/^[-.]/, "").replace(/-/g, ".");
    const name = family[0].toUpperCase() + family.slice(1);
    return (version ? `${name} ${version}` : name) + suffix;
  }
  const gpt = id.match(/^gpt-([\d.]+)(?:-(.+))?$/);
  if (gpt) {
    const variant = (gpt[2] || "").split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
    return `GPT-${gpt[1]}${variant ? ` ${variant}` : ""}${suffix}`;
  }
  return raw;
}

// The context window the HARNESS reported for this run, or null when it reported none. There is
// deliberately no per-model table and no settings fallback: whether Opus runs at 200k or 1M depends
// on the variant selected, the plan and CLAUDE_CODE_DISABLE_1M_CONTEXT, and only the CLI knows.
// A guessed window would print a confident but wrong percentage.
export function contextWindowFor(result = {}) {
  const reported = Number(result.contextWindow);
  if (reported > 0) return reported;
  const claudeWindow = modelUsageContextWindow(result.raw, result.sessionModel, resolveCurrentModel(result), result.model);
  if (claudeWindow) return claudeWindow;
  const requestWindow = Array.isArray(result.usageRequests)
    ? Number(result.usageRequests.findLast((request) => Number(request?.contextWindow) > 0)?.contextWindow)
    : 0;
  return requestWindow > 0 ? requestWindow : null;
}

// How full the context is: the LATEST top-level request's input (what the model held at once)
// against the harness-reported window. Never the run's summed input, which counts the same
// history once per model call. `percent` is uncapped so an over-limit context reads above 100.
export function contextUsageFor(result = {}) {
  let tokens = Number(result.contextTokens) > 0 ? Number(result.contextTokens) : 0;
  if (!tokens && Array.isArray(result.usageRequests)) {
    const last = result.usageRequests.findLast((request) => Number(request?.usage?.input_tokens) > 0);
    tokens = Number(last?.usage?.input_tokens) || 0;
  }
  const window = contextWindowFor(result);
  return {
    tokens: tokens || null,
    window,
    percent: tokens && window ? Math.round((100 * tokens) / window) : null,
  };
}
