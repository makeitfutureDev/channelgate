import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const settings = await import("../src/config/settings.js");
const { footerText } = await import("../src/slack/app.js");

const result = {
  engine: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  durationMs: 14_400,
  usage: { input_tokens: 36_800, output_tokens: 192 },
  contextTokens: 36_800,
  raw: { modelUsage: { "claude-opus-4-8": { contextWindow: 200_000 } } },
  costUSD: 0.31,
};

test("message cost visibility defaults on and round-trips through the Admin API shape", () => {
  assert.equal(settings.getShowMessageCost(), true);
  assert.equal(settings.settingsForApi().showMessageCost, true);

  settings.saveSettings({ showMessageCost: false });

  assert.equal(settings.getShowMessageCost(), false);
  assert.equal(settings.settingsForApi().showMessageCost, false);
});

test("the global setting hides only cost from the shared Slack footer", () => {
  settings.saveSettings({ showMessageCost: true });
  assert.match(footerText(result), /\$0\.31/);

  settings.saveSettings({ showMessageCost: false });
  const hidden = footerText(result);

  assert.doesNotMatch(hidden, /\$/);
  assert.match(hidden, /Opus 4\.8/);
  assert.equal(hidden, "Opus 4.8 · high · ctx: 37k / 200k, 18%");
});


test("the shared footer always puts effort after the model, including the CLI default", () => {
  settings.saveSettings({ showMessageCost: false });
  const codex = { engine: "codex", model: "gpt-6.1-terra", durationMs: 26_000,
    usage: { input_tokens: 314_900, output_tokens: 562 }, contextTokens: 120_000, contextWindow: 475_000 };
  assert.equal(footerText({ ...codex, effort: "low" }), "gpt-6.1-terra · low · ctx: 120k / 475k, 25%");
  assert.match(footerText({ ...codex, effort: "none" }), /terra · none · ctx:/);
  assert.match(footerText({ ...result, effort: "" }), /Opus 4\.8 · default effort · ctx:/);
  settings.saveSettings({ showMessageCost: true });
  assert.match(footerText({ ...result, effort: "" }), /Opus 4\.8 · default effort · \$0\.31 · ctx:/);
  settings.saveSettings({ showMessageCost: false });
  for (const effort of [undefined, null, "", "  "]) {
    assert.equal(footerText({ ...codex, effort }), "gpt-6.1-terra · default effort · ctx: 120k / 475k, 25%");
  }
});

test("the footer drops duration and run token totals and shows the latest context", () => {
  settings.saveSettings({ showMessageCost: false });
  // The audited run: 3.7M input summed over 30 requests used to read as "3.7M/16.4k · 100%".
  const audited = footerText({
    engine: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    durationMs: 482_000,
    usage: { input_tokens: 3_704_256, cached_input_tokens: 3_542_272, output_tokens: 16_400 },
    contextTokens: 167_149,
    contextWindow: 475_000,
  });
  assert.equal(audited, "gpt-6.1-sol · high · ctx: 167k / 475k, 35%");
  assert.doesNotMatch(audited, /482s|3\.7M|16\.4k|100%/);
  // Over the window reads above 100%; an unreported window is "?", never a guess.
  assert.equal(footerText({ engine: "claude", model: "claude-opus-4-6", primaryModel: "claude-opus-4-6", contextTokens: 230_000,
    raw: { modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } } } }), "Opus 4.6 · default effort · ctx: 230k / 200k, 115%");
  assert.equal(footerText({ engine: "claude", model: "claude-opus-5-5", contextTokens: 21_965 }), "Opus 5.5 · default effort · ctx: 22k / ?");
  // Whole thousands, no decimals; millions keep a decimal only when it is not zero.
  const ctxOf = (contextTokens, contextWindow) => footerText({ engine: "codex", model: "m", effort: "low", contextTokens, contextWindow });
  assert.equal(ctxOf(150_400, 167_600), "m · low · ctx: 150k / 168k, 90%");
  assert.equal(ctxOf(999_600, 1_000_000), "m · low · ctx: 1M / 1M, 100%");
  assert.equal(ctxOf(1_100_000, 1_000_000), "m · low · ctx: 1.1M / 1M, 110%");
  assert.equal(ctxOf(640, 200_000), "m · low · ctx: 640 / 200k, 0%");
  // No model request (a run that failed first): no ctx segment at all.
  assert.equal(footerText({ engine: "codex", model: "gpt-6.1-sol", usage: {} }), "gpt-6.1-sol · default effort");
});

test("a resumed footer keeps the provider-reported current-message cost", () => {
  settings.saveSettings({ showMessageCost: true });
  const resumed = footerText({
    engine: "claude",
    model: "claude-opus-4-8",
    durationMs: 12_000,
    usage: { input_tokens: 2_000, cache_read_input_tokens: 30_000, output_tokens: 400 },
    costUSD: 0.42,
  });
  assert.equal(resumed, "Opus 4.8 · default effort · $0.42");
});

test("Admin settings accept message-cost visibility only as a boolean", () => {
  const route = readFileSync(new URL("../src/web/routes/settings.js", import.meta.url), "utf8");
  assert.match(route, /typeof body\.showMessageCost === "boolean"/);
});

test("Admin UI exposes, loads, and saves the global message-cost checkbox", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="set-show-message-cost"/);
  assert.match(client, /set-show-message-cost"\)\.checked = s\.showMessageCost !== false/);
  assert.match(client, /showMessageCost: document\.getElementById\("set-show-message-cost"\)\.checked/);
});
