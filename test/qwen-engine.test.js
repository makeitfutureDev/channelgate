// The Qwen harness: the Claude Code CLI pointed at QwenCloud's Anthropic-compatible endpoint.
//
// Everything here guards a way this engine could quietly become Claude (or quietly spend Claude's
// credential): the credential boundary, the opt-in switch, the model families, and the cost the
// CLI fabricates for a provider whose prices it does not know.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, isEngineEnabled, getEnabledEngines, getEngine, getQwenConfig, getDefaultModel } = await import("../src/config/settings.js");
const { adapterFor, fallbackTargets, modelBelongsToEngine, engineCostRateKey, ENGINE_IDS } = await import("../src/engines/registry.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");
const qwen = await import("../src/engines/qwen.js");
const { normalizeUsage } = await import("../src/gateway/usage.js");

const reset = () => saveSettings({ engineEnabled: undefined, engine: "claude", qwenApiKey: "", qwenBaseUrl: "", defaultQwenModel: "", codexRatePer1MTokens: 0 });

// ── The credential boundary ───────────────────────────────────────────────────────────────────

test("a provider run carries NO Anthropic credential, inherited or relayed", () => {
  const env = buildClaudeEnv({
    home: "/home/agent",
    oauthToken: "sk-ant-oat-RELAYED-OPERATOR-TOKEN",
    providerEnv: qwen.qwenProviderEnv({ apiKey: "sk-sp-QWEN", baseUrl: "https://example.invalid/apps/anthropic" }),
  }, {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-api-DAEMON-KEY",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-auth-DAEMON",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://example.invalid/apps/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-sp-QWEN");
  // The three ways the operator's own Anthropic access could have leaked to a third-party host.
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "an inherited daemon API key must not ride along");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the operator's relayed login must never reach another provider");
  assert.ok(!Object.values(env).includes("sk-ant-oat-RELAYED-OPERATOR-TOKEN"));
  assert.ok(!Object.values(env).includes("sk-ant-api-DAEMON-KEY"));
});

test("a Claude run is unchanged when no provider is supplied", () => {
  const env = buildClaudeEnv({ home: "/home/agent", oauthToken: "sk-ant-oat-RELAY" }, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api-DAEMON" });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-RELAY");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api-DAEMON");
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test("a channel secret cannot redirect a Qwen run at its own endpoint", () => {
  const env = buildClaudeEnv({
    home: "/home/agent",
    // safeSpawnEnv drops reserved names; the provider group is applied last regardless.
    extraEnv: { ANTHROPIC_BASE_URL: "https://attacker.invalid", ANTHROPIC_AUTH_TOKEN: "stolen", MY_TOKEN: "fine" },
    providerEnv: qwen.qwenProviderEnv({ apiKey: "sk-sp-QWEN", baseUrl: "https://token-plan.example/apps/anthropic" }),
  }, { PATH: "/usr/bin" });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://token-plan.example/apps/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-sp-QWEN");
  assert.equal(env.MY_TOKEN, "fine", "ordinary channel secrets still ride in");
});

test("the run fails closed, naming the remedy, when no key is configured", async () => {
  reset();
  const adapter = adapterFor("qwen");
  await assert.rejects(
    () => adapter.run({
      cwd: "/tmp", prompt: "hi", session: { id: "s", fresh: true },
      policy: { network: { mode: "on" } }, runtime: { pluginRuntime: null },
    }),
    (error) => {
      assert.match(error.message, /Qwen harness is selected/);
      assert.match(error.message, /API key/);
      assert.equal(error.details?.runtimeCredential, true);
      return true;
    },
  );
});

// ── Opt-in enablement ─────────────────────────────────────────────────────────────────────────

test("Qwen is off until an admin turns it on, and is never enabled by a fallback", () => {
  reset();
  assert.equal(adapterFor("qwen").optIn, true);
  assert.equal(isEngineEnabled("qwen"), false, "a gateway that merely pulled this release must not offer it");
  assert.ok(!getEnabledEngines().includes("qwen"));
  assert.ok(getEnabledEngines().includes("claude"));

  // The "never lock every harness out" rescue restores the DEFAULT harnesses only.
  saveSettings({ engineEnabled: { claude: false, codex: false, qwen: false, opencode: false } });
  assert.equal(isEngineEnabled("claude"), true);
  assert.equal(isEngineEnabled("qwen"), false, "the rescue must not switch the gateway onto a third-party provider");

  saveSettings({ engineEnabled: { claude: true, codex: true, qwen: true, opencode: false } });
  assert.equal(isEngineEnabled("qwen"), true);
  assert.ok(getEnabledEngines().includes("qwen"));

  // A deployment deliberately running ONLY Qwen keeps the others off.
  saveSettings({ engineEnabled: { claude: false, codex: false, qwen: true, opencode: false } });
  assert.equal(isEngineEnabled("qwen"), true);
  assert.equal(isEngineEnabled("claude"), false, "an explicit single-harness choice must survive");
  assert.equal(getEngine(), "qwen", "the default engine resolves to the one that is actually on");
  reset();
});

test("Qwen sits outside the failover graph in both directions", () => {
  assert.deepEqual([...fallbackTargets("qwen")], [], "a Qwen limit must not spend the Anthropic quota");
  assert.ok(!fallbackTargets("claude").includes("qwen"));
  assert.ok(!fallbackTargets("codex").includes("qwen"));
});

// ── Models ────────────────────────────────────────────────────────────────────────────────────

test("only text models are selectable — image/audio families answer 400 on /v1/messages", () => {
  for (const id of ["qwen3.8-max", "qwen3.6-flash", "glm-5.3", "deepseek-v4.1-flash", "auto"]) {
    assert.equal(qwen.isQwenTextModel(id), true, id);
    assert.equal(modelBelongsToEngine(id, "qwen"), true, id);
  }
  for (const id of ["wan2.7-image", "wan2.7-image-pro", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-realtime-plus"]) {
    assert.equal(qwen.isQwenTextModel(id), false, id);
    assert.equal(modelBelongsToEngine(id, "qwen"), false, id);
  }
  // Never another harness's ids, in either direction — the wrong answer here is a run on the
  // wrong provider rather than an error.
  for (const id of ["sonnet", "opus[1m]", "claude-opus-5", "gpt-5.6-sol", "codex"]) {
    assert.equal(modelBelongsToEngine(id, "qwen"), false, id);
  }
  assert.equal(modelBelongsToEngine("qwen3.8-max", "claude"), false);
  assert.equal(modelBelongsToEngine("qwen3.8-max", "codex"), false);
});

test("the model-list URL is derived from the configured Anthropic endpoint", () => {
  assert.equal(
    qwen.qwenModelsUrl("https://token-plan.maas.qwencloudapi.com/apps/anthropic"),
    "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/models",
  );
  assert.equal(
    qwen.qwenModelsUrl("https://maas.qwencloudapi.com/apps/anthropic/"),
    "https://maas.qwencloudapi.com/compatible-mode/v1/models",
  );
  // A proxy that does not follow the documented shape gets the sibling appended, never guessed at.
  assert.equal(qwen.qwenModelsUrl("https://proxy.example/qwen"), "https://proxy.example/qwen/compatible-mode/v1/models");
});

test("discovery reads the account's own list, filtered and labelled", async () => {
  reset();
  saveSettings({ qwenApiKey: "sk-sp-TEST", qwenBaseUrl: "https://token-plan.example/apps/anthropic" });
  let seenUrl = "";
  let seenAuth = "";
  const models = await qwen.discoverQwenModels({
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenAuth = options.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ data: [
          { id: "qwen3.8-max" }, { id: "wan2.7-image" }, { id: "glm-5.3" },
          { id: "qwen-audio-3.0-tts-plus" }, { id: "auto" }, { id: "" },
        ] }),
      };
    },
  });
  assert.equal(seenUrl, "https://token-plan.example/compatible-mode/v1/models");
  assert.equal(seenAuth, "Bearer sk-sp-TEST");
  assert.deepEqual(models.map((m) => m.value), ["auto", "glm-5.3", "qwen3.8-max"]);
  assert.equal(models.find((m) => m.value === "glm-5.3").label, "GLM 5.3");
  assert.equal(models.find((m) => m.value === "auto").label, "Auto (provider routing)");
  reset();
});

test("discovery refuses to guess when the account is not configured", async () => {
  reset();
  await assert.rejects(() => qwen.discoverQwenModels({ fetchImpl: async () => { throw new Error("must not be called"); } }), /API key/);
});

test("an HTTP failure is reported rather than silently blanking the picker", async () => {
  reset();
  saveSettings({ qwenApiKey: "sk-sp-TEST" });
  await assert.rejects(() => qwen.discoverQwenModels({ fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  reset();
});

test("a provider failure names the harness that failed, not the CLI it borrows", async () => {
  const { claudeProviderError } = await import("../src/engines/stream.js");
  const event = { error: { type: "authentication_error", message: "401 Invalid API-key provided" } };
  // Sending someone to check the wrong account is the bug this prevents.
  assert.match(claudeProviderError(event, "Qwen").message, /^Qwen authentication failed/);
  assert.match(claudeProviderError(event).message, /^Claude authentication failed/, "the default is unchanged");
  assert.equal(claudeProviderError(event, "Qwen").kind, "authentication");
});

// ── Cost ──────────────────────────────────────────────────────────────────────────────────────

test("a Qwen turn records tokens and no dollar figure", () => {
  reset();
  // An operator who priced Codex must not thereby price QwenCloud with OpenAI's rates.
  saveSettings({ codexRatePer1MTokens: 10 });
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 };
  const qwenRow = normalizeUsage({ engine: "qwen", usage, costUSD: null });
  assert.equal(qwenRow.costUSD, null, "no invoice will ever match an invented number");
  assert.equal(qwenRow.estimated, false);
  assert.equal(qwenRow.outTok, 500, "the tokens themselves are real and are kept");
  assert.equal(qwenRow.inTok, 1200);
  // Codex still gets its configured estimate; the guard is per-engine, not a blanket off-switch.
  const codexRow = normalizeUsage({ engine: "codex", usage: { prompt_tokens: 1000, completion_tokens: 500 }, costUSD: null });
  assert.equal(codexRow.estimated, true);
  assert.ok(codexRow.costUSD > 0);
  assert.equal(engineCostRateKey("qwen"), "");
  assert.equal(engineCostRateKey("codex"), "codexRatePer1MTokens");
  reset();
});

// ── Settings surface ──────────────────────────────────────────────────────────────────────────

test("the provider is gateway configuration, defaulting to the documented endpoint", () => {
  reset();
  assert.equal(getQwenConfig().apiKey, "");
  assert.equal(getQwenConfig().baseUrl, qwen.QWEN_DEFAULT_BASE_URL);
  saveSettings({ qwenApiKey: "  sk-sp-PADDED  ", qwenBaseUrl: " https://maas.qwencloudapi.com/apps/anthropic " });
  assert.equal(getQwenConfig().apiKey, "sk-sp-PADDED");
  assert.equal(getQwenConfig().baseUrl, "https://maas.qwencloudapi.com/apps/anthropic");
  saveSettings({ defaultQwenModel: "qwen3.8-max" });
  assert.equal(getDefaultModel("qwen"), "qwen3.8-max", "the per-engine default is keyed off the adapter, not a hardcoded pair");
  reset();
});

test("the key is revealable only through the audited one-at-a-time endpoint", async () => {
  const { revealableFields } = await import("../src/web/secrets.js");
  assert.ok(revealableFields("settings").includes("qwenApiKey"));
  const { settingsForApi } = await import("../src/config/settings.js");
  reset();
  saveSettings({ qwenApiKey: "sk-sp-SECRET-VALUE-1234" });
  const snapshot = settingsForApi();
  assert.equal(snapshot.hasQwenApiKey, true);
  assert.equal(snapshot.qwenApiKeyLast4, "1234");
  assert.equal(snapshot.qwenApiKey, undefined, "a listing response must never carry the value");
  assert.ok(!JSON.stringify(snapshot).includes("sk-sp-SECRET-VALUE-1234"));
  reset();
});

test("the harness reuses Claude's CLI, instruction file and skills dir, and its own everything else", () => {
  const q = adapterFor("qwen");
  const c = adapterFor("claude");
  assert.equal(q.cli, c.cli, "same binary");
  assert.equal(q.instructionFile, c.instructionFile);
  assert.equal(q.skillsDir, c.skillsDir);
  assert.equal(q.mcpTransport, c.mcpTransport);
  assert.equal(q.mcpMetaKey, c.mcpMetaKey, "one Cloud MCP selection serves both");
  assert.equal(q.sessionState.containerDirKey, c.sessionState.containerDirKey);
  // …and the provider-owned facts are its own.
  assert.notEqual(q.defaultModelKey, c.defaultModelKey);
  assert.equal(q.supports.realCost, false);
  assert.equal(q.supports.warmPool, false, "a warm process would outlive a provider-key rotation");
  assert.equal(q.supports.permissionPrompt, true, "the approval card is the CLI's, and it works");
  assert.ok(ENGINE_IDS.includes("qwen"));
});
