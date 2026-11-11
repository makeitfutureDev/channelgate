// Shared compact run statistics for chat replies. Surface-specific controls stay in their adapters.
import { getShowMessageCost } from "../config/settings.js";
import { normalizeUsage } from "./usage.js";
import { contextUsageFor, modelLabel } from "./model-info.js";

// Compact token counts for the footer: 214 → "214", 34799 → "34.8k", 1959778 → "1.96M".
function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// "ctx: 167.1k / 475k, 35%" — the LATEST top-level request's input against the window the harness
// reported (contextUsageFor). An unreported window prints "?" rather than a guessed percentage, and
// an over-limit context reads above 100%. Empty when the run made no model request.
export function contextText(result) {
  const { tokens, window, percent } = contextUsageFor(result);
  if (!tokens) return "";
  return window ? `ctx: ${fmtTok(tokens)} / ${fmtTok(window)}, ${percent}%` : `ctx: ${fmtTok(tokens)} / ?`;
}

// Run stats, as SHORT as possible (width-conscious by user request; no icons — user preference):
// "gpt-6.1-sol · high · ctx: 167.1k / 475k, 35%" — model · configured effort (when known) · cost
// (only when the admin enabled it; 2 decimals, no ~/est. markers) · context. No duration and no
// run token totals: the summed input re-counts the history once per model call and says nothing
// about how full the context is. The resume command never rides here as text — it lives in
// Channel Settings → Resume Session and `/resume`.
export function footerText(result) {
  // Claude reports a real dollar cost; Codex doesn't — the per-model rate estimate from Settings
  // is shown bare (same figure the usage ledger records).
  const est = result.costUSD == null ? normalizeUsage(result) : null;
  const usd = result.costUSD ?? est?.costUSD;
  const parts = [modelLabel(result)];
  if (result.effort) parts.push(result.effort);
  if (getShowMessageCost() && usd != null) parts.push(`$${usd.toFixed(2)}`);
  const ctx = contextText(result);
  if (ctx) parts.push(ctx);
  return parts.join(" · ");
}
