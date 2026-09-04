// Bidirectional harness failover + the per-harness on/off switch.
//
// The bug this covers: a run whose PRIMARY engine was Codex died on "You've hit your usage limit …
// try again at Aug 20th" and nothing recovered it — the failover graph made Codex a terminal node,
// the Codex runner never classified a plan-limit rejection, and the orchestrator's replay check was
// hardcoded to Claude. Every turn in that channel then failed the same way for days.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { classifyCodexFailure, codexTurnError } = await import("../src/engines/codex.js");
const { fallbackTargets } = await import("../src/engines/registry.js");
const { replaySafeFallbackKind, isUsageLimited } = await import("../src/gateway/run.js");
const {
  saveSettings, getEngine, getEngineFallback, isEngineEnabled, getEnabledEngines,
  getEngineEnabledMap, settingsForApi,
} = await import("../src/config/settings.js");
const { engineSwitchHint } = await import("../src/slack/message-pipeline.js");

const LIVE_LIMIT_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 6:35 AM.";

// ── Codex failure classification ───────────────────────────────────────────────

test("the live Codex plan-limit message classifies as a usage limit", () => {
  assert.equal(classifyCodexFailure({ message: LIVE_LIMIT_MESSAGE, providerType: "usage_limit_reached" }), "usage_limit");
  assert.equal(classifyCodexFailure({ message: "Rate limit exceeded, retry later", status: 429 }), "usage_limit");
  assert.equal(classifyCodexFailure({ message: "You have run out of credits" }), "usage_limit");
});

test("authentication failures are classified apart from limits; server and connection errors are transient; the rest stays unclassified", () => {
  assert.equal(classifyCodexFailure({ message: "Not logged in. Run `codex login` to continue." }), "authentication");
  assert.equal(classifyCodexFailure({ message: "unauthorized", status: 401 }), "authentication");
  assert.equal(classifyCodexFailure({ message: "The server had an error while processing your request" }), "transient");
  assert.equal(classifyCodexFailure({ message: "connection reset by peer" }), "transient");
  assert.equal(classifyCodexFailure({ message: "stub failure detail" }), "", "an unexplained failure is still nobody's to retry");
  assert.equal(classifyCodexFailure({ message: "Something in the request is malformed", status: 400 }), "", "a 400 means the request was wrong, not that the provider was away");
});

test("a model rejection still wins over the limit/auth patterns", () => {
  assert.equal(
    classifyCodexFailure({ message: "The 'gpt-5.6' model is not supported for this account.", providerType: "invalid_request_error", status: 400 }),
    "model_rejected",
    "a pre-flight model rejection must keep routing to the same-engine model retry, not a cross-engine replay",
  );
});

test("codexTurnError attaches the classification to the thrown details", () => {
  const { message, details } = codexTurnError({
    type: "error",
    error: { type: "usage_limit_reached", message: LIVE_LIMIT_MESSAGE },
  });
  assert.equal(message, LIVE_LIMIT_MESSAGE);
  assert.equal(details.engine, "codex");
  assert.equal(details.providerError, true);
  assert.equal(details.providerKind, "usage_limit");
});

// ── Failover graph + replay safety ─────────────────────────────────────────────

test("either harness is the other's failover target", () => {
  assert.deepEqual(fallbackTargets("claude"), ["codex"]);
  assert.deepEqual(fallbackTargets("codex"), ["claude"]);
  assert.deepEqual(fallbackTargets("opencode"), [], "the read-only engine is not a failover source");
});

test("replay safety is judged against the engine that actually ran the turn", () => {
  const codexLimit = { details: { engine: "codex", providerError: true, providerKind: "usage_limit", replaySafe: true } };
  assert.equal(replaySafeFallbackKind(codexLimit, "codex"), "usage_limit");
  assert.equal(replaySafeFallbackKind(codexLimit, "claude"), "", "an error from another engine can never authorize this turn's replay");
  assert.equal(replaySafeFallbackKind(codexLimit, ""), "");
  assert.equal(
    replaySafeFallbackKind({ details: { engine: "codex", providerError: true, providerKind: "usage_limit", replaySafe: false } }, "codex"),
    "",
    "a turn that may have run a tool is never replayed",
  );
  assert.equal(
    replaySafeFallbackKind({ details: { engine: "codex", providerError: true, providerKind: "availability", replaySafe: true } }, "codex"),
    "",
    "availability/network failures stay ordinary errors",
  );
});

test("a zero-work Codex limit NOTICE (exit 0) is detected like Claude's", () => {
  assert.equal(isUsageLimited({ content: LIVE_LIMIT_MESSAGE, usage: { input_tokens: 0, output_tokens: 0 } }), true);
  assert.equal(
    isUsageLimited({ content: LIVE_LIMIT_MESSAGE, usage: { input_tokens: 120, output_tokens: 40 } }),
    false,
    "a real answer always does work — tokens are the guard against a false positive",
  );
});

// ── Per-harness enable/disable ─────────────────────────────────────────────────

test("engines are enabled by default and the map round-trips through settings", () => {
  saveSettings({ engineEnabled: undefined });
  assert.equal(isEngineEnabled("claude"), true);
  assert.equal(isEngineEnabled("codex"), true);
  assert.equal(isEngineEnabled("nope"), false, "an unknown id is never enabled");

  saveSettings({ engineEnabled: { claude: true, codex: false, opencode: false } });
  assert.equal(isEngineEnabled("codex"), false);
  assert.deepEqual(getEnabledEngines(), ["claude"]);
  assert.deepEqual(getEngineEnabledMap(), { claude: true, codex: false, opencode: false });
  assert.equal(settingsForApi().engineEnabled.codex, false);
});

test("a stored map that disables every harness fails open instead of bricking the gateway", () => {
  saveSettings({ engineEnabled: { claude: false, codex: false, opencode: false } });
  assert.deepEqual(getEnabledEngines(), ["claude", "codex", "opencode"]);
});

test("the gateway default engine resolves past a disabled harness", () => {
  saveSettings({ engine: "codex", engineEnabled: { claude: true, codex: false, opencode: false } });
  assert.equal(getEngine(), "claude", "a disabled harness must not stay the default just because it is the stored value");
  saveSettings({ engineEnabled: { claude: true, codex: true, opencode: true } });
  assert.equal(getEngine(), "codex");
});

test("the failover toggle honors the pre-rename settings key", () => {
  saveSettings({ engineFallback: undefined, codexFallback: undefined });
  assert.equal(getEngineFallback(), true, "failover is on unless an admin turned it off");
  saveSettings({ codexFallback: false });
  assert.equal(getEngineFallback(), false, "an existing install's stored choice survives the rename");
  saveSettings({ engineFallback: true });
  assert.equal(getEngineFallback(), true, "the canonical key wins once written");
  const api = settingsForApi();
  assert.equal(api.engineFallback, true);
  assert.equal(api.codexFallback, true, "the legacy key keeps reporting the same value");
  assert.equal(api.engineFallbackMode, "auto", "the mode is reported beside the toggle");
});

// ── The user-facing dead end ───────────────────────────────────────────────────

test("an uncovered limit failure tells the user how to switch harness by hand", () => {
  const hint = engineSwitchHint({ details: { engine: "codex", providerError: true, providerKind: "usage_limit" } }, { engines: ["claude", "codex"] });
  assert.match(hint, /say `claude`/);
  assert.equal(
    engineSwitchHint({ details: { engine: "codex", providerError: true, providerKind: "availability" } }, { engines: ["claude", "codex"] }),
    "",
    "only limit/auth failures get the switch hint",
  );
  assert.equal(engineSwitchHint({ message: "boom" }), "", "an ordinary crash stays unadorned");
});

test("a pinned thread's failure explains that nothing was switched on purpose", () => {
  const hint = engineSwitchHint(
    { details: { engine: "codex", providerError: true, providerKind: "usage_limit", runtimePinned: true, pinnedModel: "gpt-5.6-sol" } },
    { engines: ["claude", "codex"] },
  );
  assert.match(hint, /pinned to Codex/);
  assert.match(hint, /gpt-5\.6-sol/, "the pinned model is part of what the user chose");
  assert.match(hint, /say `claude`/, "the manual move is still offered");
  assert.doesNotMatch(hint, /unavailable right now/, "this is a respected choice, not an outage");
});
