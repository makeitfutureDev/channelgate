import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const registry = await import("../src/engines/registry.js");
const {
  ENGINE_IDS, isEngineId, adapterFor, adapterOr, engineSupports, engineLabel,
  resumeCommandFor, modelBelongsToEngine, effortBelongsToEngine, mintsOwnSessionId, usesMcpConfigFile,
} = registry;

// The registry exists to kill one specific bug class: binary `engine === "codex" ? x : y`
// fall-throughs, where a THIRD engine silently inherits Claude's answer — wrong cost, wrong label,
// wrong context window, wrong MCP transport — and produces a subtly incorrect run instead of a
// loud failure. These tests use an unregistered id as the stand-in for that future engine.

const UNKNOWN = "future-engine";

test("all shipped engines are registered with the facts callers depend on", () => {
  assert.deepEqual([...ENGINE_IDS], ["claude", "codex", "opencode"]);
  for (const id of ENGINE_IDS) {
    const a = adapterFor(id);
    assert.equal(a.id, id);
    for (const field of ["label", "cli", "defaultModelKey", "mcpMetaKey", "instructionFile", "skillsDir", "mcpTransport"]) {
      assert.ok(a[field], `${id} must declare ${field}`);
    }
    assert.equal(typeof a.contextWindow, "number");
    assert.ok(Array.isArray(a.efforts) && a.efforts.length);
  }
});

test("an unregistered engine is detectable rather than silently treated as Claude", () => {
  assert.equal(isEngineId(UNKNOWN), false);
  assert.equal(adapterFor(UNKNOWN), null, "the honest answer is 'I don't know this engine'");
  assert.equal(adapterFor(""), null);
  assert.equal(adapterFor(undefined), null);
});

test("capabilities are false for an unknown engine, so callers take the SAFE path", () => {
  // The failure mode being prevented: a new engine inheriting realCost:true and being billed as
  // though it reported real dollars, or inheriting permissionPrompt and being handed a flag its
  // CLI does not have.
  for (const cap of ["warmPool", "interruptSteer", "permissionPrompt", "compact", "realCost"]) {
    assert.equal(engineSupports(UNKNOWN, cap), false, `${cap} must not be assumed for an unknown engine`);
  }
});

test("the two engines genuinely differ on the capabilities callers branch on", () => {
  assert.equal(engineSupports("claude", "warmPool"), true);
  assert.equal(engineSupports("codex", "warmPool"), false);
  assert.equal(engineSupports("claude", "realCost"), true);
  assert.equal(engineSupports("codex", "realCost"), false, "Codex cost is estimated from rate tables");
  assert.equal(engineSupports("claude", "permissionPrompt"), true);
  assert.equal(engineSupports("codex", "permissionPrompt"), false);
  assert.equal(engineSupports("claude", "usageLimitFallback"), true);
  assert.equal(engineSupports("codex", "usageLimitFallback"), true, "either harness can hand a limited turn to the other");
  assert.equal(engineSupports("opencode", "readOnly"), true);
  assert.deepEqual(adapterFor("opencode").supports.networkModes, ["off"]);
  assert.equal(engineSupports("opencode", "mcp"), false);
});

test("session identity and MCP transport are per-engine facts, not Codex special cases", () => {
  assert.equal(mintsOwnSessionId("claude"), false, "the gateway mints Claude's id via --session-id");
  assert.equal(mintsOwnSessionId("codex"), true, "Codex returns its own thread id, which we persist");
  assert.equal(mintsOwnSessionId("opencode"), true);
  assert.equal(mintsOwnSessionId(UNKNOWN), false);

  assert.equal(usesMcpConfigFile("claude"), true);
  assert.equal(usesMcpConfigFile("codex"), false, "Codex takes -c overrides, never a config file");
  assert.equal(usesMcpConfigFile("opencode"), false);
});

test("resume commands come from one place, not three copies", () => {
  assert.equal(resumeCommandFor("claude", "abc"), "claude --resume abc");
  assert.equal(resumeCommandFor("codex", "abc"), "codex exec resume abc");
  assert.equal(resumeCommandFor("opencode", "abc"), "opencode run --session abc");
});

test("model ownership keeps a model off the wrong harness", () => {
  assert.ok(modelBelongsToEngine("claude-sonnet-5", "claude"));
  assert.ok(modelBelongsToEngine("opus[1m]", "claude"));
  assert.ok(!modelBelongsToEngine("gpt-5.4", "claude"), "a Codex model on Claude breaks every turn");

  assert.ok(modelBelongsToEngine("gpt-5.4", "codex"));
  assert.ok(modelBelongsToEngine("codex-mini", "codex"));
  assert.ok(!modelBelongsToEngine("claude-sonnet-5", "codex"));

  assert.ok(modelBelongsToEngine("anthropic/claude-sonnet-4-5", "opencode"));
  assert.ok(!modelBelongsToEngine("claude-sonnet-4-5", "opencode"));

  assert.ok(modelBelongsToEngine("", "claude"), "empty inherits the next default down the chain");
});

test("effort ownership follows each CLI's accepted set", () => {
  assert.ok(effortBelongsToEngine("xhigh", "claude"));
  assert.ok(!effortBelongsToEngine("max", "claude"), "max is Codex-only");
  assert.ok(effortBelongsToEngine("max", "codex"));
  assert.ok(effortBelongsToEngine("", "codex"));
});

test("labels never invent a name for an engine we don't know", () => {
  assert.equal(engineLabel("claude"), "Claude");
  assert.equal(engineLabel("codex"), "Codex");
  assert.equal(engineLabel("opencode"), "OpenCode (read-only)");
  assert.equal(engineLabel(UNKNOWN), UNKNOWN, "echo the id rather than claiming it is Claude");
});

test("adapterOr requires the caller to state its fallback explicitly", () => {
  assert.equal(adapterOr(UNKNOWN).id, "claude", "documented default");
  assert.equal(adapterOr(UNKNOWN, "codex").id, "codex", "callers can choose a different one");
  assert.equal(adapterOr("codex").id, "codex", "a known engine is never overridden");
});

test("the settings key for a default model is per engine", () => {
  assert.equal(adapterFor("claude").defaultModelKey, "defaultClaudeModel");
  assert.equal(adapterFor("codex").defaultModelKey, "defaultCodexModel");
  assert.notEqual(adapterFor("claude").mcpMetaKey, adapterFor("codex").mcpMetaKey);
  assert.notEqual(adapterFor("opencode").mcpMetaKey, adapterFor("codex").mcpMetaKey);
});
