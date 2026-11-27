// Standalone, built-ins-only: copied into each prepared SSH session, never the runtime image.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Untrusted paths, branch names and display names must never emit terminal control sequences.
const clean = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const tokens = (value) => value >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(Math.round(value));
export function gitBranch(cwd) {
  if (!cwd) return "";
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: 150, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

export function renderClaudeStatusline(data = {}, { env = process.env, branch = "" } = {}) {
  if (!data || typeof data !== "object") data = {};
  const color = (code, text) => env.NO_COLOR != null || env.TERM === "dumb" ? text : `\x1b[${code}m${text}\x1b[0m`;
  const context = data.context_window || {};
  // Use the CLI's current context snapshot, never cumulative session token counters.
  const usage = context.current_usage;
  const size = context.context_window_size;
  const counters = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens];
  const used = counters.some(number) ? counters.reduce((total, value) => total + (number(value) ? value : 0), 0) : null;
  let percent = context.used_percentage;
  if (!number(percent) && number(used) && number(size) && size > 0) percent = 100 * used / size;
  if (number(percent)) percent = Math.max(0, Math.min(100, percent));
  const contextText = number(percent)
    ? `ctx ${Math.round(percent)}%${number(size) && size > 0 ? ` / ${tokens(size)}` : ""}` : "ctx --%";
  const effort = clean(data.effort?.level || "--");
  const parts = [color("35", clean(data.model?.display_name || data.model?.id || "Claude")),
    `effort ${effort}`, color(number(percent) && percent >= 90 ? "31" : number(percent) && percent >= 70 ? "33" : "32", contextText)];
  if (data.fast_mode) parts.push(color("33", "fast"));
  const cwd = data.workspace?.current_dir || data.cwd;
  if (cwd) parts.push(color("36", clean(path.basename(cwd) || cwd)));
  if (branch) parts.push(color("36", clean(branch)));
  if (number(data.cost?.total_cost_usd)) parts.push(`$${data.cost.total_cost_usd.toFixed(2)}`);
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
    const pct = data.rate_limits?.[key]?.used_percentage;
    if (number(pct)) parts.push(`${label} ${Math.round(pct)}% used`);
  }
  return parts.join(" · ");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const data = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(`${renderClaudeStatusline(data, { branch: gitBranch(data?.workspace?.current_dir || data?.cwd) })}\n`);
  } catch { process.stdout.write("Claude · effort -- · ctx --%\n"); }
}
