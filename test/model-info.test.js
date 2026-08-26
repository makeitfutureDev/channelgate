import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { resolveCurrentModel, modelLabel, contextWindowFor } = await import("../src/gateway/model-info.js");
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
  assert.equal(contextWindowFor(result), 200_000);
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

test("Claude 1M context window is resolved from the actual runtime model", () => {
  const result = {
    engine: "claude",
    model: "claude-haiku-4-5",
    raw: { model_usage: { "claude-opus-4-8[1m]": {} } },
  };

  // The [1m] runtime model drives the 1M context window even when the governing pick differs.
  assert.equal(resolveCurrentModel(result), "claude-opus-4-8[1m]");
  assert.equal(contextWindowFor(result), 1_000_000);
  assert.equal(modelLabel(result), "Haiku 4.5");
});

test("modelLabel renders the 1M suffix from the governing model", () => {
  const result = { engine: "claude", model: "claude-opus-4-8[1m]", raw: {} };
  assert.equal(modelLabel(result), "Opus 4.8 1M");
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
