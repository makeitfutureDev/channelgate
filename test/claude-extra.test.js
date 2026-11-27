import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();

const extra = await import("../src/engines/bedrock.js");
const { adapterFor } = await import("../src/engines/registry.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");
const { refreshDaemonClaudeToken } = await import("../src/gateway/claude-token-relay.js");
const grants = await import("../src/gateway/egress/grants.js");
const { CLAUDE_EXTRA_RELAY_SECRET_NAME, relayRuleFor } = await import("../src/gateway/egress/catalog-rules.js");
const { corePlaceholder } = await import("../src/gateway/egress/placeholders.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");
const TOKEN = "sk-ant-oat01-extra-only-fixture";

function login(configDir = tempDir("cg-extra-"), patch = {}) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: TOKEN, refreshToken: "extra-refresh-must-stay-on-host",
    expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: Date.now() + 86_400_000, ...patch,
  } }));
  return configDir;
}

function settings(configDir, value) {
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(value));
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}

test("extra Claude accepts its own subscription with missing or theme-only settings", async () => {
  const configDir = login();
  for (const value of [undefined, { theme: "dark", hooks: { Stop: "ignored" } }]) {
    if (value) settings(configDir, value);
    const provider = extra.resolveExtraClaudeProvider({ configDir });
    assert.equal(provider.kind, "subscription");
    assert.equal(provider.configured, true);
    assert.equal(provider.login.file, path.join(configDir, ".credentials.json"));
    const state = extra.extraClaudeCredentialState({ configDir });
    assert.equal(state.authenticated, true);
    assert.equal(state.method, "claude-subscription");
    assert.ok(!JSON.stringify(state).includes(TOKEN));
    const relay = await extra.resolveExtraClaudeToken({ configDir });
    assert.equal(relay.token, TOKEN);
    assert.equal(relay.source, "extra");
    assert.ok(!JSON.stringify(relay).includes("extra-refresh-must-stay-on-host"));
  }
});

test("missing, malformed, symlinked or hard-expired extra login never uses supplied default credentials", async () => {
  for (const mode of ["missing", "malformed", "expired", "symlink"]) {
    const configDir = tempDir("cg-extra-invalid-");
    if (mode === "expired") login(configDir, { refreshTokenExpiresAt: Date.now() - 1 });
    if (mode === "malformed") writeFileSync(path.join(configDir, ".credentials.json"), "not json");
    if (mode === "symlink") symlinkSync(path.join(login(), ".credentials.json"), path.join(configDir, ".credentials.json"));
    const result = await extra.resolveExtraClaudeToken({
      configDir, configured: () => "wrong-default-token", env: { ANTHROPIC_API_KEY: "wrong-default-key" },
      resolveLogin: () => { throw new Error("must not resolve default login"); },
    });
    assert.equal(result.token, "", mode);
    assert.match(result.error, /isolated terminal command/, mode);
  }
});

test("existing OAuth cannot hide malformed settings, unsupported routing or partial AWS setup", () => {
  const configDir = login();
  for (const value of [null, false, 0, "", [], { env: null }, { env: [] }]) {
    settings(configDir, value);
    assert.equal(extra.resolveExtraClaudeProvider({ configDir }).configured, false, JSON.stringify(value));
  }
  writeFileSync(path.join(configDir, "settings.json"), "bad json");
  assert.equal(extra.resolveExtraClaudeProvider({ configDir }).configured, false);
  const cases = [
    [{ AWS_REGION: "eu-central-1" }, /API key/],
    [{ AWS_PROFILE: "sso" }, /AWS_REGION/],
    [{ CLAUDE_CODE_USE_BEDROCK: "1" }, /AWS_REGION/],
    [{ ANTHROPIC_BASE_URL: "https://wrong.example" }, /conflicting provider/],
    [{ CLAUDE_CODE_USE_VERTEX: "1" }, /conflicting provider/],
  ];
  for (const [env, expected] of cases) {
    settings(configDir, { env });
    const provider = extra.resolveExtraClaudeProvider({ configDir });
    assert.equal(provider.configured, false);
    assert.match(provider.error, expected);
  }
  settings(configDir, { env: { AWS_REGION: "eu-central-1", AWS_BEARER_TOKEN_BEDROCK: "aws-test-only" } });
  assert.equal(extra.resolveExtraClaudeProvider({ configDir }).kind, "bedrock");
  assert.equal(extra.resolveExtraClaudeProvider({ configDir }).configured, true);
});

test("extra token renewal uses only its original login and never returns an expired token", async () => {
  const configDir = login(undefined, { expiresAt: Date.now() - 1 });
  let refreshes = 0;
  const result = await extra.resolveExtraClaudeToken({ configDir, refresh: async ({ source }) => {
    refreshes++;
    assert.equal(source.configDir, configDir);
    assert.equal(source.isolatedProvider, true);
    login(configDir, { accessToken: "renewed-extra-token" });
  } });
  assert.equal(refreshes, 1);
  assert.equal(result.token, "renewed-extra-token");
  login(configDir, { expiresAt: Date.now() - 1 });
  const failed = await extra.resolveExtraClaudeToken({ configDir, refresh: async () => {} });
  assert.equal(failed.token, "");
  assert.match(failed.error, /expired/);
});

test("extra host refresh ignores daemon provider credentials and terminal settings/tools", async () => {
  const configDir = login();
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "daemon-key-must-not-reach-extra";
  try {
    await refreshDaemonClaudeToken({
      source: { home: "/extra-home", configDir, isolatedProvider: true },
      spawnImpl(_command, args, options) {
        assert.equal(options.env.CLAUDE_CONFIG_DIR, configDir);
        assert.equal(options.env.HOME, "/extra-home");
        assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(args[args.indexOf("--setting-sources") + 1], "");
        assert.equal(args[args.indexOf("--tools") + 1], "");
        assert.ok(args.includes("--no-session-persistence"));
        const child = fakeChild(); queueMicrotask(() => child.emit("close", 0)); return child;
      },
    });
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original;
  }
});

test("extra subscription provider env atomically removes conflicting API keys and AWS routes", () => {
  const env = buildClaudeEnv({
    extraEnv: { AWS_PROFILE: "wrong", AWS_REGION: "wrong", AWS_ENDPOINT_URL: "https://wrong.example" },
    providerEnv: { CLAUDE_CONFIG_DIR: "/extra", CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  }, { HOME: "/normal", ANTHROPIC_API_KEY: "wrong", ANTHROPIC_AUTH_TOKEN: "wrong", ANTHROPIC_BASE_URL: "https://wrong.example" });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/extra");
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_PROFILE", "AWS_REGION", "AWS_ENDPOINT_URL"]) assert.equal(env[name], undefined, name);
});

test("default and extra OAuth use distinct grants; removal, rotation and AWS switch invalidate warm extra cache", async (t) => {
  const configDir = extra.bedrockLoginHome();
  rmSync(configDir, { recursive: true, force: true }); login(configDir);
  t.after(() => { rmSync(configDir, { recursive: true, force: true }); grants.__resetGrantCaches(); });
  const target = { backend: "container", meta: { channelId: "C_EXTRA" }, container: { egress: { active: true, mode: "proxy" } } };
  const defaultToken = grants.containerClaudeCredential({ target, relay: { token: "default-token" } });
  const extraToken = grants.containerExtraClaudeCredential({ target, relay: await extra.resolveExtraClaudeToken() });
  assert.notEqual(extraToken.token, defaultToken.token);
  const row = grants.lookupGrant(corePlaceholder(extraToken.token));
  assert.equal(row.secretName, CLAUDE_EXTRA_RELAY_SECRET_NAME);
  assert.deepEqual(relayRuleFor(row.secretName).hosts, ["api.anthropic.com"]);
  assert.equal(await grants.resolveGrantValue(row), TOKEN);
  assert.equal(await grants.resolveGrantValue(grants.lookupGrant(corePlaceholder(defaultToken.token)), { relayToken: async () => ({ token: "default-token" }) }), "default-token");
  login(configDir, { accessToken: "rotated-extra-token" });
  assert.equal(await grants.resolveGrantValue(row), "rotated-extra-token");
  rmSync(path.join(configDir, ".credentials.json"));
  assert.equal(await grants.resolveGrantValue(row), "");
  login(configDir);
  settings(configDir, { env: { AWS_REGION: "eu-central-1", AWS_BEARER_TOKEN_BEDROCK: "aws-only" } });
  assert.equal(await grants.resolveGrantValue(row), "");
  assert.equal(grants.containerExtraClaudeCredential({ target: { backend: "container" }, relay: { token: TOKEN } }).token, "");
});

test("subscription main runs keep isolated transcripts, proxy-only credentials and gateway lockdown", async (t) => {
  const configDir = extra.bedrockLoginHome();
  rmSync(configDir, { recursive: true, force: true }); login(configDir);
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const adapter = extra.makeBedrockAdapter(adapterFor("claude"));
  assert.equal((await adapter.selectionReadiness()).ready, true);
  assert.equal(adapter.label, "Claude Extra");
  assert.ok(adapter.modelBelongs("claude-opus-5-5"));
  const captures = [];
  for (const isolated of [false, true]) {
    const target = {
      backend: isolated ? "container" : "host", meta: { channelId: "C_MAIN_EXTRA" },
      container: { home: "/home/agent", claudeBedrockConfigDir: "/home/agent/.claude-bedrock", egress: { active: true, mode: "proxy" } },
      runtime: { capabilities: { isolated }, spawn(spawnTarget, spec) {
        captures.push({ ...spec, finalEnv: isolated ? containerRunEnv(spawnTarget, spec.env) : spec.env });
        const child = fakeChild();
        queueMicrotask(() => { child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "EXTRA_OK", usage: { input_tokens: 2, output_tokens: 2 } }) + "\n"); child.emit("close", 0); });
        return child;
      } },
    };
    const result = await adapter.run({
      cwd: "/tmp", prompt: "test", session: { id: "extra-session", fresh: true }, target,
      runtime: { pluginRuntime: null, settingsFile: "/lockdown", mcpConfigFile: "/mcp", strictMcp: true, model: "claude-opus-5-5" },
    });
    assert.equal(result.content, "EXTRA_OK");
    const spec = captures.at(-1);
    assert.equal(spec.finalEnv.CLAUDE_CONFIG_DIR, isolated ? "/home/agent/.claude-bedrock" : configDir);
    assert.equal(spec.env.AWS_REGION, undefined);
    assert.equal(spec.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(spec.args[spec.args.indexOf("--settings") + 1], "/lockdown");
    assert.equal(spec.args[spec.args.indexOf("--setting-sources") + 1], "");
    if (isolated) {
      assert.equal(spec.cmd, "/usr/local/bin/claude");
      assert.notEqual(spec.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
      assert.equal(grants.lookupGrant(corePlaceholder(spec.env.CLAUDE_CODE_OAUTH_TOKEN)).secretName, CLAUDE_EXTRA_RELAY_SECRET_NAME);
    } else assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  }
  assert.ok(!readFileSync(path.join(configDir, ".credentials.json"), "utf8").includes("default-token"));
  await assert.rejects(() => adapter.run({ cwd: "/tmp", prompt: "bad model", session: { id: "s", fresh: true }, runtime: { pluginRuntime: null, model: "eu.anthropic.claude-sonnet-4-6" } }), /does not belong/);
});
