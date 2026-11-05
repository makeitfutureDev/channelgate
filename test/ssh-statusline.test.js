import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderClaudeStatusline, gitBranch } from "../src/gateway/ssh-statusline.js";
const plain = { env: { NO_COLOR: "1" }, branch: "feature/demo" };

test("SSH Claude footer shows current model, effort, context, repo and optional usage", () => {
  const data = { model: { display_name: "Opus" }, effort: { level: "high" }, workspace: { current_dir: "/work/project" },
    context_window: { used_percentage: 42, context_window_size: 1000000, total_input_tokens: 9999999 },
    cost: { total_cost_usd: 1.234 }, rate_limits: { five_hour: { used_percentage: 20 } }, fast_mode: true };
  assert.equal(renderClaudeStatusline(data, plain), "Opus · effort high · ctx 42% / 1M · fast · project · feature/demo · $1.23 · 5h 20% used");
  data.model.display_name = "Sonnet";
  data.effort.level = "low";
  assert.match(renderClaudeStatusline(data, plain), /^Sonnet · effort low/);
});

test("fresh/compacted sessions keep unknown context honest and zero values visible", () => {
  assert.match(renderClaudeStatusline({ context_window: { used_percentage: null, current_usage: null, total_input_tokens: 99999 } }, plain), /ctx --%/);
  assert.match(renderClaudeStatusline({ context_window: { used_percentage: 0 }, cost: { total_cost_usd: 0 } }, plain), /ctx 0%.*\$0.00/);
  assert.match(renderClaudeStatusline(null, plain), /Claude · effort -- · ctx --%/);
  for (const current_usage of [{}, { input_tokens: null, cache_creation_input_tokens: null }]) {
    assert.match(renderClaudeStatusline({ context_window: { context_window_size: 200000, current_usage } }, plain), /ctx --%/);
  }
});

test("fallback context counts input and cache snapshot only, never session totals/output", () => {
  assert.match(renderClaudeStatusline({ context_window: { context_window_size: 100000, total_input_tokens: 900000,
    current_usage: { input_tokens: 10000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 10000, output_tokens: 50000 } } }, plain), /ctx 25% \/ 100k/);
});

test("context colours warn at 70/90 percent, NO_COLOR and terminal text are safe", () => {
  for (const [pct, code] of [[0, 32], [70, 33], [90, 31]]) {
    assert.ok(renderClaudeStatusline({ context_window: { used_percentage: pct } }, { env: {} }).includes(`\x1b[${code}mctx`));
  }
  const line = renderClaudeStatusline({ model: { display_name: "Opus\x1b[31m\n" }, effort: { level: "high\r" } }, { ...plain, branch: "main\x07" });
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
});

test("standalone staged script tolerates malformed input and missing git directories", () => {
  const script = fileURLToPath(new URL("../src/gateway/ssh-statusline.js", import.meta.url));
  assert.equal(execFileSync(process.execPath, [script], { input: "bad json", encoding: "utf8" }), "Claude · effort -- · ctx --%\n");
  assert.equal(gitBranch("/nonexistent/channelgate-statusline"), "");
});
