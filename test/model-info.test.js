import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { resolveCurrentModel, modelLabel, contextWindowFor, contextUsageFor } = await import("../src/gateway/model-info.js");
const { normalizeUsage } = await import("../src/gateway/usage.js");

test("context/cost key on runtime modelUsage; the label shows the governing model", () => {
  // result.model is the governing pick run.js stamps (thread → channel/DM → gateway default).
  const result = {
    engine: "claude",
    model: "claude-haiku-4-5",
    raw: { modelUsage: { "claude-opus-4-8": { input_tokens: 24000, output_tokens: 40 } } },
  };

  // Context-window math still keys on the CLI-reported runtime model...
  assert.equal(resolveCurrentModel(result), "claude-opus-4-8");
  // The harness reported no window for it, so none is invented.
  assert.equal(contextWindowFor(result), null);
  // ...but the footer label reflects the governing model the run resolved.
  assert.equal(modelLabel(result), "Haiku 4.5");
});

test("Claude modelUsage resolves the answering model by dominant output tokens", () => {
  const result = {
    engine: "claude",
    model: "claude-opus-4-8",
    raw: {
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 1200, outputTokens: 3, costUSD: 0.001, contextWindow: 200000 },
        "claude-opus-4-8": { inputTokens: 4072, outputTokens: 1400, costUSD: 0.03, contextWindow: 1000000 },
      },
    },
  };

  assert.equal(resolveCurrentModel(result), "claude-opus-4-8");
  assert.equal(modelLabel(result), "Opus 4.8");
  assert.equal(contextWindowFor(result), 1_000_000);
});

test("a Claude [1m] variant reads its window from the variant-keyed modelUsage", () => {
  // Claude Code keys the terminal modelUsage by the configured variant while provider messages
  // drop the suffix: the session model finds the exact key, the plain id falls back to it.
  const raw = { modelUsage: { "claude-opus-4-6[1m]": { contextWindow: 1_000_000 } } };
  const primaryModel = "claude-opus-4-6";
  assert.equal(contextWindowFor({ engine: "claude", primaryModel, sessionModel: "claude-opus-4-6[1m]", raw }), 1_000_000);
  assert.equal(contextWindowFor({ engine: "claude", primaryModel, raw }), 1_000_000);
});

test("modelLabel renders the 1M suffix from the governing model", () => {
  const result = { engine: "claude", model: "claude-opus-4-8[1m]", raw: {} };
  assert.equal(modelLabel(result), "Opus 4.8 1M");
});

test("the Claude window is exactly what the harness reported, with no model overrides", () => {
  // Opus 5.5 is 1M by default, but CLAUDE_CODE_DISABLE_1M_CONTEXT=1 makes the CLI run and report
  // 200k; a hardcoded 1M would understate the percentage fivefold.
  const disabled = { engine: "claude", model: "claude-opus-5-5", primaryModel: "claude-opus-5-5",
    raw: { modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 } } } };
  assert.equal(contextWindowFor(disabled), 200_000);
  // Opus 4.6 without the [1m] variant is reported at 200k; a configured `opus[1m]` label never
  // overrides what the runtime says.
  assert.equal(contextWindowFor({ engine: "claude", model: "opus[1m]", primaryModel: "claude-opus-4-6",
    raw: { modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } } } }), 200_000);
  // Nothing reported: unknown, never a family default or the settings constant.
  for (const model of ["claude-opus-5-5", "claude-haiku-4-5", "opus[1m]"]) {
    assert.equal(contextWindowFor({ engine: "claude", model, raw: { model } }), null);
  }
  assert.equal(contextWindowFor({ engine: "codex", model: "gpt-6.1-sol" }), null);
});

test("context usage is the latest request against the reported window, uncapped", () => {
  // The audited Codex run: 3.7M summed input over 30 requests, 167,149 in the last one.
  const codex = {
    engine: "codex",
    usage: { input_tokens: 3_704_256, output_tokens: 16_400 },
    contextTokens: 167_149,
    contextWindow: 475_000,
  };
  assert.deepEqual(contextUsageFor(codex), { tokens: 167_149, window: 475_000, percent: 35 });
  // Over the limit reads above 100%.
  assert.equal(contextUsageFor({ ...codex, contextTokens: 522_500 }).percent, 110);
  // Rollout requests supply both numbers when the runner fields are absent.
  assert.deepEqual(contextUsageFor({ engine: "codex", usageRequests: [
    { usage: { input_tokens: 90_000 }, contextWindow: 475_000 },
    { usage: { input_tokens: 120_000 }, contextWindow: 475_000 },
  ] }), { tokens: 120_000, window: 475_000, percent: 25 });
  // A known size with no reported window has no percentage; the run total is never used.
  assert.deepEqual(contextUsageFor({ engine: "claude", contextTokens: 21_965, usage: { input_tokens: 900_000 } }),
    { tokens: 21_965, window: null, percent: null });
  assert.deepEqual(contextUsageFor({ engine: "claude", usage: { input_tokens: 900_000 } }), { tokens: null, window: null, percent: null });
});

test("Codex turn.completed model drives cost estimates; the label shows the governing model", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  const result = {
    engine: "codex",
    model: "gpt-5.4",
    raw: { type: "turn.completed", turn: { model: "gpt-5.4-mini-2026-05" } },
    usage,
  };

  // Cost rates still key on the CLI-reported runtime model (mini rate → $0.75)...
  assert.equal(resolveCurrentModel(result), "gpt-5.4-mini-2026-05");
  assert.equal(normalizeUsage(result).costUSD, 0.75);
  // ...while the footer label shows the governing model the run resolved.
  assert.equal(modelLabel(result), "gpt-5.4");
});

test("Codex context uses the runtime-reported usable window from rollout requests", () => {
  const result = {
    engine: "codex",
    runtimeModel: "gpt-5.6-sol",
    usageRequests: [{ contextWindow: 258_400 }],
  };
  assert.equal(contextWindowFor(result), 258_400);
});
