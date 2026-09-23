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

test("with no model configured anywhere, a Qwen run asks for a Qwen model, never the CLI default", async () => {
  // The CLI's own default is an Anthropic id; QwenCloud answers it with 400 "Model not exist".
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cg-qwen-model-"));
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env node
const i = process.argv.indexOf("--model");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s",
  result: "model=" + (i >= 0 ? process.argv[i + 1] : "<none>"), usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`);
  chmodSync(join(dir, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    reset();
    saveSettings({ qwenApiKey: "sk-sp-TEST" });
    const result = await adapterFor("qwen").run({
      cwd: dir, prompt: "hi", session: { id: "s", fresh: true },
      policy: { network: { mode: "on" } }, runtime: { pluginRuntime: null, model: "" },
    });
    assert.equal(result.text ?? result.content ?? result.result, `model=${qwen.QWEN_DEFAULT_MODEL}`);
    assert.ok(modelBelongsToEngine(qwen.QWEN_DEFAULT_MODEL, "qwen"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
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
  const card = snapshot.qwenProviders.find((p) => p.id === "qwen");
  assert.equal(card.hasApiKey, true);
  assert.equal(card.apiKeyLast4, "1234");
  assert.equal(card.apiKey, undefined, "a listing response must never carry the value");
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

// ── The provider TABLE ────────────────────────────────────────────────────────────────────────
// A second entry (Model Studio's EU region) is the reason the single-provider module became a
// table. These guard the properties that would let one provider quietly answer for another.

const euReset = () => saveSettings({ qwenEuApiKey: "", qwenEuBaseUrl: "", defaultQwenEuModel: "" });

test("every table entry generates its own harness, with its own credential and its own catalog", () => {
  assert.deepEqual(qwen.QWEN_PROVIDER_IDS, ["qwen", "qwen-eu"]);
  const keys = new Set();
  for (const entry of qwen.QWEN_PROVIDERS) {
    const adapter = adapterFor(entry.id);
    assert.ok(adapter, `${entry.id} must be registered`);
    assert.equal(adapter.label, entry.label);
    assert.equal(adapter.defaultModelKey, entry.defaultModelKey);
    assert.equal(adapter.models[0].value, entry.models[0].value, "the shipped catalog is the entry's own");
    assert.equal(adapter.optIn, true, "no provider harness is ever on by default");
    assert.equal(adapter.supports.realCost, false, "no provider harness books the CLI's Anthropic pricing");
    // Every settings key is unique across the table: a shared one would let saving one provider's
    // credential silently re-point another's turns.
    for (const key of [entry.settings.apiKey, entry.settings.baseUrl, entry.defaultModelKey]) {
      assert.equal(keys.has(key), false, `${key} is used by more than one provider`);
      keys.add(key);
    }
  }
});

test("one provider's key never configures another's harness", async () => {
  reset();
  euReset();
  saveSettings({ qwenApiKey: "sk-sp-TOKEN-PLAN", qwenBaseUrl: "https://token-plan.example/apps/anthropic" });
  const first = await qwen.resolveQwenProvider("qwen");
  const second = await qwen.resolveQwenProvider("qwen-eu");
  assert.equal(first.configured, true);
  assert.equal(second.configured, false, "the EU harness is not configured by the other account's key");
  assert.equal(second.apiKey, "");
  // …and the run fails closed naming ITS provider, rather than answering on the configured one.
  const err = await adapterFor("qwen-eu").run({
    cwd: "/tmp", prompt: "hi", session: { id: "s", fresh: true },
    runtime: { pluginRuntime: { engine: "qwen-eu" } },
  }).then(() => null, (error) => error);
  assert.match(err.message, /Qwen EU harness is selected/);
  assert.equal(err.details.runtimeCredential, true);
  reset();
});

test("a provider with no shipped endpoint stays unconfigured until the operator saves one", async () => {
  euReset();
  const blank = await qwen.resolveQwenProvider("qwen-eu");
  assert.equal(blank.configured, false);
  // Both missing halves in ONE message: reporting them a save apart makes the second look like a
  // new failure.
  assert.match(blank.error, /no API key or endpoint is configured/);
  assert.match(blank.error, /Settings → Qwen EU/);

  saveSettings({ qwenEuApiKey: "sk-ws-EU" });
  assert.match((await qwen.resolveQwenProvider("qwen-eu")).error, /no endpoint is configured/);

  saveSettings({ qwenEuBaseUrl: "https://ws-test.eu-central-1.example/apps/anthropic/" });
  const ready = await qwen.resolveQwenProvider("qwen-eu");
  assert.equal(ready.configured, true);
  assert.equal(ready.baseUrl, "https://ws-test.eu-central-1.example/apps/anthropic", "a trailing slash never reaches the CLI");
  // The other provider ships one, so a blank box there means "keep the documented endpoint".
  assert.equal((await qwen.resolveQwenProvider("qwen")).baseUrl, qwen.QWEN_DEFAULT_BASE_URL);
  euReset();
});

test("each provider redirects the CLI at ITS OWN endpoint, and the fingerprints never collide", async () => {
  euReset();
  saveSettings({ qwenEuApiKey: "sk-ws-EU", qwenEuBaseUrl: "https://ws-test.eu-central-1.example/apps/anthropic" });
  const eu = await qwen.resolveQwenProvider("qwen-eu");
  const env = buildClaudeEnv({
    home: "/home/agent",
    oauthToken: "sk-ant-oat-RELAYED-OPERATOR-TOKEN",
    providerEnv: qwen.qwenProviderEnv(eu),
  }, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api-DAEMON-KEY" });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://ws-test.eu-central-1.example/apps/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-ws-EU");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the operator's login never reaches a provider, whichever one it is");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);

  // The same key pasted into both boxes must still produce two distinct fingerprints: the warm
  // pool and the auth-failure cooldown compare them to decide "is this the credential that failed".
  const a = qwen.qwenProviderFingerprint({ id: "qwen", apiKey: "same", baseUrl: "https://x.example" });
  const b = qwen.qwenProviderFingerprint({ id: "qwen-eu", apiKey: "same", baseUrl: "https://x.example" });
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.equal(qwen.qwenProviderFingerprint({ id: "qwen-eu", apiKey: "", baseUrl: "https://x.example" }), "", "no key, nothing to compare");
  euReset();
});

test("the model list URL follows the workspace endpoint, not a hardcoded host", () => {
  assert.equal(
    qwen.qwenModelsUrl("https://ws-abc.eu-central-1.maas.aliyuncs.com/apps/anthropic"),
    "https://ws-abc.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models",
  );
  assert.equal(qwen.qwenModelsUrl(""), "", "an unconfigured endpoint yields no URL to guess at");
});

test("single-purpose models are filtered out of a provider catalog", () => {
  // Live ids from the EU account: translation and OCR models answer, but cannot run an agent turn.
  for (const id of ["qwen-mt-plus", "qwen-mt-turbo", "qwen-vl-ocr", "qwen-image-3.0"]) {
    assert.equal(qwen.isQwenTextModel(id), false, `${id} must not be selectable`);
  }
  for (const id of ["qwen3-coder-plus", "qwen3-max", "kimi-k2.7-code", "glm-5.2", "qwen3-vl-plus"]) {
    assert.equal(qwen.isQwenTextModel(id), true, `${id} is a usable conversational model`);
  }
});

test("both provider keys are write-only, revealable only through the audited endpoint", async () => {
  const { revealableFields } = await import("../src/web/secrets.js");
  const { settingsForApi } = await import("../src/config/settings.js");
  reset();
  euReset();
  for (const entry of qwen.QWEN_PROVIDERS) {
    assert.ok(revealableFields("settings").includes(entry.settings.apiKey), `${entry.settings.apiKey} must be revealable`);
  }
  saveSettings({ qwenEuApiKey: "sk-ws-EU-SECRET-9876", qwenEuBaseUrl: "https://ws-test.eu-central-1.example/apps/anthropic" });
  const snapshot = settingsForApi();
  const card = snapshot.qwenProviders.find((p) => p.id === "qwen-eu");
  assert.equal(card.hasApiKey, true);
  assert.equal(card.apiKeyLast4, "9876");
  assert.equal(card.baseUrl, "https://ws-test.eu-central-1.example/apps/anthropic", "the endpoint is not a secret — the UI has to show it");
  assert.ok(!JSON.stringify(snapshot).includes("sk-ws-EU-SECRET-9876"));
  // The UI renders its card from these; a missing field silently disables saving that provider.
  for (const field of ["label", "apiKeyField", "baseUrlField", "defaultModelField", "endpointHint"]) {
    assert.ok(card[field], `the settings card needs ${field}`);
  }
  euReset();
});
