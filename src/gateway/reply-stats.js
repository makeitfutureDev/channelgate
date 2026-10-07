// Shared compact run statistics for chat replies. Surface-specific controls stay in their adapters.
import { getShowMessageCost } from "../config/settings.js";
import { normalizeUsage } from "./usage.js";
import { contextWindowFor, modelLabel } from "./model-info.js";

// Compact token counts for the footer: 214 → "214", 34799 → "34.8k", 1959778 → "1.96M".
function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// Run stats, as SHORT as possible (width-conscious by user request; no icons — user preference):
// "Opus 4.8 1M · 14.4s · 36.8k/192 · $0.31 · 18%" — model · duration · tokens in/out ·
// cost (2 decimals, no ~/est. markers) · context% against the MODEL's own window
// (contextWindowFor). The resume command never rides here as text — it lives in Channel Settings
// → Resume Session and `/resume`.
export function footerText(result) {
  const u = result.usage || {};
  // Tolerate both Claude (input_tokens/…) and Codex (prompt_tokens/…) usage shapes.
  const inT = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outT = u.output_tokens ?? u.completion_tokens ?? 0;
  // Claude reports a real dollar cost; Codex doesn't — the per-model rate estimate from Settings
  // is shown bare (same figure the usage ledger records).
  const est = result.costUSD == null ? normalizeUsage(result) : null;
  const usd = result.costUSD ?? est?.costUSD;
  const parts = [modelLabel(result)];
  if (result.durationMs != null) {
    const s = result.durationMs / 1000;
    parts.push(s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`);
  }
  parts.push(`${fmtTok(inT)}/${fmtTok(outT)}`);
  if (getShowMessageCost() && usd != null) parts.push(`$${usd.toFixed(2)}`);
  // Context window used: this turn's input/cached tokens vs the model's own window.
  if (inT > 0) parts.push(`${Math.min(100, Math.round((100 * inT) / contextWindowFor(result)))}%`);
  // Which image answered, when the turn ran behind an OS boundary. It is the one runtime fact that
  // changes an answer's meaning after the fact (a rebuilt image is a different toolchain), and a
  // host turn has no image, so the footer stays exactly as short as it always was there.
  if (result.runtime?.image) parts.push(result.runtime.image);
  return parts.join(" · ");
}
