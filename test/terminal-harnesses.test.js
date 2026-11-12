import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { saveSettings, isEngineEnabled } = await import("../src/config/settings.js");
const { adapterFor, fallbackTargets } = await import("../src/engines/registry.js");
const { isValidModel } = await import("../src/slack/util.js");
const { normalizeUsage } = await import("../src/gateway/usage.js");

const app = express();
app.use(express.json());
app.use("/api", createSettingsRouter({}));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
test.after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}/api`;
async function put(body) {
  const res = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("optional harnesses activate before terminal login and retain independent defaults", async () => {
  saveSettings({ engine: "claude", engineEnabled: undefined });
  assert.equal(isEngineEnabled("codex-eu"), false);
  assert.equal(isEngineEnabled("claude-bedrock"), false);
  const res = await put({ engineEnabled: { "codex-eu": true, "claude-bedrock": true }, defaultCodexEuModel: "gpt-6-sol", defaultCodexEuEffort: "high", defaultBedrockModel: "eu.anthropic.claude-sonnet-4-6-v1:0", defaultBedrockEffort: "medium" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const id of ["codex-eu", "claude-bedrock"]) {
    assert.equal(res.body.engineEnabled[id], true);
    assert.deepEqual(fallbackTargets(id), []);
    assert.equal(adapterFor(id).supports.warmPool, false);
  }
  const reread = await (await fetch(`${base}/settings`)).json();
  assert.equal(reread.defaultCodexEuModel, "gpt-6-sol");
  assert.equal(reread.defaultCodexEuEffort, "high");
  assert.equal(reread.defaultBedrockModel, "eu.anthropic.claude-sonnet-4-6-v1:0");
  assert.equal(reread.defaultBedrockEffort, "medium");
  assert.equal((await put({ engine: "codex-eu" })).status, 400);
  assert.equal((await put({ engine: "claude-bedrock" })).status, 400);
  assert.equal((await put({ defaultCodexEuModel: "sonnet" })).status, 400);
  assert.equal((await put({ defaultBedrockModel: "gpt-6-sol" })).status, 400);
  saveSettings({ engineEnabled: undefined });
});

test("terminal setup metadata exposes only separate paths and explicit supported methods", async () => {
  const res = await (await fetch(`${base}/settings`)).json();
  const [eu, bedrock] = res.terminalHarnesses;
  assert.match(eu.command, /CODEX_HOME=.*codex.*cli_auth_credentials_store=.*file.*login --device-auth/);
  assert.match(eu.description, /does not enforce residency/);
  assert.match(bedrock.command, /CLAUDE_CONFIG_DIR=.*claude/);
  assert.match(bedrock.description, /\/setup-bedrock/);
  assert.match(bedrock.description, /API key.*SSO.*not supported/);
  assert.notEqual(eu.directory, bedrock.directory);
  assert.deepEqual(Object.keys(eu).sort(), ["id", "label", "modelField", "effortField", "directory", "command", "description"].sort());
});

test("Bedrock model IDs are validated before reaching the provider", () => {
  for (const model of ["eu.anthropic.claude-sonnet-4-6-v1:0", "arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123"]) {
    assert.equal(isValidModel(model), true);
    assert.equal(adapterFor("claude-bedrock").modelBelongs(model), true);
    assert.equal(adapterFor("claude").modelBelongs(model), false);
  }
  for (const model of ["arn:aws:iam::123456789012:role/Admin", "eu.anthropic.claude-x\n--flag", "--model=opus"]) assert.equal(isValidModel(model), false);
});

test("Codex EU preserves Codex cache accounting and Bedrock never borrows prices", () => {
  const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 };
  assert.deepEqual(normalizeUsage({ engine: "codex-eu", model: "gpt-6-sol", usage }), normalizeUsage({ engine: "codex", model: "gpt-6-sol", usage }));
  const bedrock = normalizeUsage({ engine: "claude-bedrock", usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 }, costUSD: null });
  assert.equal(bedrock.inTok, 14);
  assert.equal(bedrock.costUSD, null);
  assert.equal(bedrock.estimated, false);
});
