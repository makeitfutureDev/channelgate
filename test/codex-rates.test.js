// Unit tests for the per-model Codex cost estimate: default rates, cached-input pricing,
// model prefix matching, request-level long-context pricing, and the engine gate in normalizeUsage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv(); // scratch gateway dir — getSettings() reads no real config

const { estimateCodexCost, normalizeUsage } = await import("../src/gateway/usage.js");
const { DEFAULT_CODEX_RATES, getCodexModelRates, saveSettings } = await import("../src/config/settings.js");

test("default rates cover exactly the fixed model list", () => {
  const rates = getCodexModelRates();
  assert.deepEqual(Object.keys(rates).sort(), Object.keys(DEFAULT_CODEX_RATES).sort());
  assert.equal(rates["gpt-5.6-sol"].input, 5);
  assert.equal(rates["gpt-5.6-terra"].output, 12);
  assert.equal(rates["gpt-5.6-luna"].cachedInput, 0.02);
  assert.equal(rates["gpt-5.5"].input, 5);
  assert.equal(rates["gpt-5.4"].output, 15);
});

test("prices cached input at the cached rate, the rest at full input", () => {
  // gpt-5.4: $2.50 in / $0.25 cached / $15 out. 1M input (400k cached) + 10k out:
  // 600k×2.5 + 400k×0.25 + 10k×15 = 1.5 + 0.1 + 0.15 = $1.75
  const { costUSD, estimated } = estimateCodexCost({ input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 10_000 }, "gpt-5.4");
  assert.equal(estimated, true);
  assert.equal(costUSD, 1.75);
});

test("matches official model variants by boundary and leaves an unresolved CLI sentinel unpriced", () => {
  const exact = estimateCodexCost({ input_tokens: 1_000_000, output_tokens: 0 }, "gpt-5.4");
  const variant = estimateCodexCost({ input_tokens: 1_000_000, output_tokens: 0 }, "gpt-5.4-mini-2026-05");
  assert.equal(exact.costUSD, 2.5);
  assert.equal(variant.costUSD, 0.75); // longest prefix wins: gpt-5.4-mini, not gpt-5.4
  const terra = estimateCodexCost({ input_tokens: 1_000_000, output_tokens: 0 }, "gpt-5.6-terra");
  assert.equal(terra.costUSD, 2); // longest prefix wins: gpt-5.6-terra, not gpt-5.6
  const cliDefault = estimateCodexCost({ input_tokens: 1_000_000, output_tokens: 0 }, "");
  assert.equal(cliDefault.costUSD, null); // runtime model must be observed; never guess the CLI default
  assert.equal(estimateCodexCost({ input_tokens: 1_000_000 }, "gpt-5.40").costUSD, null);
});

test("applies long-context rates per request, never to a turn aggregate", () => {
  const aggregate = { input_tokens: 400_000, cached_input_tokens: 200_000, output_tokens: 10_000 };
  assert.equal(estimateCodexCost(aggregate, "gpt-5.6-sol").costUSD, 1.4);
  assert.equal(estimateCodexCost(aggregate, "gpt-5.6-sol", [{ usage: aggregate }]).costUSD, 2.65);
  const atThreshold = { input_tokens: 272_000, output_tokens: 0 };
  const overThreshold = { input_tokens: 272_001, output_tokens: 0 };
  assert.equal(estimateCodexCost(atThreshold, "gpt-5.6-sol", [{ usage: atThreshold }]).costUSD, 1.36);
  assert.equal(estimateCodexCost(overThreshold, "gpt-5.6-sol", [{ usage: overThreshold }]).costUSD, 2.72001);
});

test("supports nested cached/cache-write details and clamps malformed subsets", () => {
  const usage = {
    input_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 100_000 },
    output_tokens: 0,
  };
  // 500k full × $5 + 400k cached × $.50 + 100k write × $6.25 = $3.325.
  assert.equal(estimateCodexCost(usage, "gpt-5.6-sol").costUSD, 3.325);
  const malformed = { input_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 20 } };
  assert.equal(estimateCodexCost(malformed, "gpt-5.6-sol").costUSD, 0.000005);
});

test("normalizeUsage estimates only for codex; claude without cost stays null", () => {
  const usage = { input_tokens: 100_000, output_tokens: 1_000 };
  const codex = normalizeUsage({ engine: "codex", model: "gpt-5.4", usage });
  assert.equal(codex.estimated, true);
  assert.ok(codex.costUSD > 0);
  const claude = normalizeUsage({ engine: "claude", usage });
  assert.equal(claude.costUSD, null);
  assert.equal(claude.estimated, false);
  const real = normalizeUsage({ engine: "claude", costUSD: 0.5, usage });
  assert.equal(real.costUSD, 0.5);
  assert.equal(real.estimated, false);
});

test("retired full-table defaults migrate while genuine admin overrides survive", () => {
  saveSettings({ codexModelRates: {
    "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15 },
    "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6 },
  } });
  assert.deepEqual(getCodexModelRates()["gpt-5.6-terra"], { input: 2, cachedInput: 0.2, output: 12 });
  assert.deepEqual(getCodexModelRates()["gpt-5.6-luna"], { input: 0.2, cachedInput: 0.02, output: 1.2 });
  saveSettings({ codexModelRates: {
    "gpt-5.6-terra": { input: 3, cachedInput: 0.3, output: 18 },
  } });
  assert.deepEqual(getCodexModelRates()["gpt-5.6-terra"], { input: 3, cachedInput: 0.3, output: 18 });
});
