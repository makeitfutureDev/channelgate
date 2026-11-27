import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const bedrock = await import("../src/engines/bedrock.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");
const { adapterFor, fallbackTargets } = await import("../src/engines/registry.js");
const { lookupGrant } = await import("../src/gateway/egress/grants.js");
const { corePlaceholder } = await import("../src/gateway/egress/placeholders.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");

const KEY = "bedrock-test-bearer-never-a-real-key";
const validEnv = () => ({
  CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", AWS_BEARER_TOKEN_BEDROCK: KEY,
  ANTHROPIC_DEFAULT_SONNET_MODEL: "eu.anthropic.claude-sonnet-4-6",
});
function setup(env = validEnv(), extra = {}, configDir = tempDir("cg-bedrock-login-")) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ ...extra, env }), { mode: 0o600 });
  return configDir;
}

test("Bedrock reads its terminal wizard env without inheriting tools, hooks or arbitrary provider routing", () => {
  const configDir = setup({
    ...validEnv(), NODE_OPTIONS: "--require /bad.js", ANTHROPIC_AUTH_TOKEN: "wrong-provider",
    AWS_ACCESS_KEY_ID: "do-not-inject", AWS_SECRET_ACCESS_KEY: "do-not-inject",
  }, { permissions: { allow: ["Bash"] }, hooks: { Stop: [{ command: "must-not-run" }] }, awsCredentialExport: "must-not-run" });
  const provider = bedrock.resolveBedrockProvider({ configDir });
  assert.equal(provider.configured, true);
  assert.equal(provider.endpoint, "https://bedrock-runtime.eu-central-1.amazonaws.com");
  assert.equal(provider.bearerToken, KEY);
  assert.deepEqual(provider.env, {
    CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "eu.anthropic.claude-sonnet-4-6",
  });
  const state = bedrock.bedrockCredentialState({ configDir });
  assert.equal(state.authenticated, true);
  assert.equal(state.method, "bedrock-api-key");
  assert.ok(!JSON.stringify(state).includes(KEY));
  const previousFingerprint = state.fingerprint;
  setup({ ...validEnv(), AWS_BEARER_TOKEN_BEDROCK: "another-test-only-bearer" }, {}, configDir);
  assert.notEqual(bedrock.bedrockCredentialState({ configDir }).fingerprint, previousFingerprint);
});

test("Bedrock fails closed on missing/malformed login and unsupported AWS credential mechanisms", () => {
  const blank = tempDir("cg-bedrock-missing-");
  assert.match(bedrock.resolveBedrockProvider({ configDir: blank }).error, /setup-bedrock/);
  writeFileSync(path.join(blank, "settings.json"), "broken json with a fake secret");
  const invalid = bedrock.resolveBedrockProvider({ configDir: blank });
  assert.equal(invalid.configured, false);
  assert.ok(!invalid.error.includes("fake secret"));
  const cases = [
    [{ AWS_REGION: "eu-central-1", AWS_PROFILE: "sso-profile" }, /API key.*profiles, SSO and SigV4/],
    [{ ...validEnv(), AWS_REGION: "https://evil.example" }, /AWS_REGION/],
    [{ ...validEnv(), AWS_REGION: "cn-north-1" }, /AWS_REGION/],
    [{ ...validEnv(), ANTHROPIC_BEDROCK_BASE_URL: "https://evil.example" }, /custom Bedrock endpoints/],
    [{ ...validEnv(), AWS_ENDPOINT_URL: "https://evil.example" }, /custom Bedrock endpoints/],
    [{ ...validEnv(), ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-east-1" }, /configured AWS_REGION/],
    [{ ...validEnv(), ANTHROPIC_MODEL: "gpt-6-sol" }, /invalid ANTHROPIC_MODEL/],
    [{ ...validEnv(), ANTHROPIC_BEDROCK_REGION_PREFIX: "malicious" }, /invalid region prefix/],
    [{ ...validEnv(), AWS_BEARER_TOKEN_BEDROCK: "broken key" }, /invalid whitespace/],
  ];
  for (const [env, expected] of cases) {
    const provider = bedrock.resolveBedrockProvider({ configDir: setup(env) });
    assert.equal(provider.configured, false);
    assert.equal(provider.bearerToken, "", "an unusable setup must expose no credential to consumers");
    assert.match(provider.error, expected);
  }
});

test("Bedrock refuses symlink and oversized terminal settings", () => {
  const original = setup();
  const linked = tempDir("cg-bedrock-linked-");
  symlinkSync(path.join(original, "settings.json"), path.join(linked, "settings.json"));
  assert.equal(bedrock.resolveBedrockProvider({ configDir: linked }).configured, false);
  const oversized = tempDir("cg-bedrock-big-");
  writeFileSync(path.join(oversized, "settings.json"), " ".repeat(1024 * 1024 + 1));
  assert.match(bedrock.resolveBedrockProvider({ configDir: oversized }).error, /smaller than 1 MiB/);
});

test("Bedrock accepts native model IDs and inference profiles, and rejects another harness's models", () => {
  for (const id of ["opus", "sonnet[1m]", "eu.anthropic.claude-sonnet-4-6", "anthropic.claude-haiku-4-5-20251001-v1:0", "arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/example"]) {
    assert.equal(bedrock.isBedrockModel(id), true, id);
  }
  for (const id of ["gpt-6-sol", "qwen3.8-max", "claude-sonnet-4-6", "anthropic.claude-opus-5;bad", "arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/x bad"]) {
    assert.equal(bedrock.isBedrockModel(id), false, id);
  }
});

test("Bedrock provider env replaces every conflicting Anthropic/AWS route after channel credentials", () => {
  const env = buildClaudeEnv({
    oauthToken: "wrong-anthropic-oauth",
    extraEnv: { AWS_ACCESS_KEY_ID: "wrong-access-key", AWS_PROFILE: "wrong-profile", AWS_ENDPOINT_URL: "https://wrong.example", AWS_REGION: "us-east-1" },
    providerEnv: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", AWS_BEARER_TOKEN_BEDROCK: "relay-placeholder", CLAUDE_CONFIG_DIR: "/isolated-bedrock" },
  }, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "wrong-api-key", ANTHROPIC_BASE_URL: "https://wrong.example" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.AWS_ENDPOINT_URL, undefined);
  assert.equal(env.AWS_REGION, "eu-central-1");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/isolated-bedrock");
});

test("Bedrock adapter remains cold and opt-in, with an isolated transcript directory and no fallback", async () => {
  const adapter = bedrock.makeBedrockAdapter(adapterFor("claude"));
  assert.equal(adapter.id, "claude-bedrock");
  assert.equal(adapter.optIn, true);
  assert.equal(adapter.terminalSetup, true);
  assert.equal(adapter.supports.warmPool, false);
  assert.equal(adapter.supports.interruptSteer, false);
  assert.equal(adapter.supports.realCost, false);
  assert.equal(adapter.supports.usageLimitFallback, false);
  assert.equal(adapter.sessionState.containerDirKey, "claudeBedrockConfigDir");
  assert.equal(adapter.sessionState.channelHistory, false);
  assert.notEqual(adapter.sessionState.hostDir(), adapterFor("claude").sessionState.hostDir());
  assert.deepEqual([...fallbackTargets("claude-bedrock")], []);
  assert.equal(adapter.compileConfinement({ allowNetwork: false }).network.mode, "off");
  rmSync(bedrock.bedrockLoginHome(), { recursive: true, force: true });
  assert.equal((await adapter.selectionReadiness()).ready, false);
  await assert.rejects(() => adapter.run({ cwd: "/tmp", prompt: "hello", session: { id: "s", fresh: true }, runtime: { pluginRuntime: null } }), /setup-bedrock/);
});

test("Bedrock host terminal resume keeps its isolated login; unsupported container takeover fails explicitly", () => {
  const adapter = bedrock.makeBedrockAdapter(adapterFor("claude"));
  const host = { backend: "host", runtime: { capabilities: { isolated: false } } };
  const container = { backend: "container", runtime: { capabilities: { isolated: true } }, container: { home: "/home/agent", claudeBedrockConfigDir: "/home/agent/.claude-bedrock" } };
  assert.equal(adapter.resumeCommand("host-id", { target: host }), `env CLAUDE_CONFIG_DIR='${bedrock.bedrockLoginHome()}' claude --resume 'host-id'`);
  const command = adapter.resumeCommand("container-id", { target: container });
  assert.match(command, /^sh -c /);
  assert.match(command, /Bedrock terminal takeover is unavailable/);
  assert.match(command, /continue this session in chat/);
  assert.match(command, /exit 1/);
  assert.ok(!command.includes("claude --resume"));
  assert.ok(!command.includes(KEY));
  assert.ok(!command.includes(bedrock.bedrockLoginHome()));
  const refusal = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Bedrock terminal takeover is unavailable/);
  assert.equal(refusal.stdout, "");
  assert.equal(adapter.resumeCommand("quote'id", { target: host }), `env CLAUDE_CONFIG_DIR='${bedrock.bedrockLoginHome()}' claude --resume 'quote'\\''id'`);
});

test("direct-host Bedrock keeps its own login and scrubs the bearer from split streaming output and failures", async () => {
  setup(validEnv(), {}, bedrock.bedrockLoginHome());
  const adapter = bedrock.makeBedrockAdapter(adapterFor("claude"));
  const captures = [];
  let fail = false;
  const target = {
    backend: "host", runtime: {
      capabilities: { isolated: false },
      spawn(_target, spec) {
        captures.push(spec);
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(() => {
          const emit = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
          if (fail) {
            emit({ type: "assistant", error: "authentication_error", message: { content: [{ type: "text", text: `invalid ${KEY}` }] } });
            child.stderr.write(`bad credential ${KEY}`);
          } else {
            for (const text of ["answer ", KEY.slice(0, 9), KEY.slice(9), " end"]) {
              emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
            }
            emit({ type: "result", subtype: "success", result: `answer ${KEY} end`, session_id: "host-session", usage: { input_tokens: 1 } });
          }
          child.emit("close", fail ? 1 : 0);
        });
        return child;
      },
    },
  };
  try {
    const chunks = [];
    const ctx = { cwd: "/work", prompt: "hi", target, session: { id: "host-session", fresh: true }, runtime: { pluginRuntime: null, model: "sonnet", onDelta: (text) => chunks.push(text) } };
    const result = await adapter.run(ctx);
    assert.equal(result.content, "answer [REDACTED] end");
    assert.equal(chunks.join(""), result.content);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal(captures[0].env.AWS_BEARER_TOKEN_BEDROCK, KEY, "only the admin direct-host child receives the real key");
    assert.equal(captures[0].env.CLAUDE_CONFIG_DIR, bedrock.bedrockLoginHome());
    fail = true;
    await assert.rejects(() => adapter.run(ctx), (error) => {
      assert.match(error.message, /^Claude Extra authentication failed/);
      assert.ok(!JSON.stringify({ message: error.message, stack: error.stack, details: error.details }).includes(KEY));
      assert.equal(error.details.engine, "claude-bedrock");
      assert.equal(error.details.requestedModel, "sonnet");
      return true;
    });
  } finally {
    rmSync(bedrock.bedrockLoginHome(), { recursive: true, force: true });
  }
});

test("a proxy Bedrock run receives only its regional bearer placeholder, retains lockdown and drops fabricated cost", async () => {
  setup(validEnv(), {}, bedrock.bedrockLoginHome());
  const adapter = bedrock.makeBedrockAdapter(adapterFor("claude"));
  const calls = [];
  const target = {
    backend: "container", cwd: "/work", meta: { channelId: "C_BEDROCK_TEST" },
    container: { home: "/home/agent", claudeBedrockConfigDir: "/home/agent/.claude-bedrock", egress: { active: true, mode: "proxy" } },
    runtime: {
      capabilities: { isolated: true },
      spawn(spawnTarget, spec) {
        calls.push({ ...spec, finalEnv: containerRunEnv(spawnTarget, spec.env), spawnTarget });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "bedrock-session", result: "hello", total_cost_usd: 100, usage: { input_tokens: 7, output_tokens: 3 } })}\n`);
          child.emit("close", 0);
        });
        return child;
      },
    },
  };
  try {
    const result = await adapter.run({
      cwd: "/work", prompt: "hi", session: { id: "bedrock-session", fresh: true }, target,
      runtime: { pluginRuntime: null, settingsFile: "/lockdown.json", instructionFile: "/instructions.md", mcpConfigFile: "/mcp.json", strictMcp: true, permissionPromptTool: "mcp__gateway__permission_prompt" },
    });
    assert.equal(calls.length, 1);
    const spec = calls[0];
    assert.equal(spec.cmd, "/usr/local/bin/claude");
    assert.equal(spec.env.CLAUDE_CONFIG_DIR, "/home/agent/.claude-bedrock");
    assert.equal(spec.finalEnv.CLAUDE_CONFIG_DIR, "/home/agent/.claude-bedrock", "the actual container exec boundary must preserve the provider transcript directory");
    assert.equal(spec.spawnTarget.container.claudeConfigDir, "/home/agent/.claude-bedrock");
    assert.equal(spec.spawnTarget.meta.engine, "claude-bedrock");
    assert.equal(target.container.claudeConfigDir, undefined, "the adapter must not mutate the shared target");
    assert.equal(spec.env.AWS_REGION, "eu-central-1");
    assert.equal(spec.env.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(!JSON.stringify(spec).includes(KEY));
    const grant = lookupGrant(corePlaceholder(spec.env.AWS_BEARER_TOKEN_BEDROCK));
    assert.equal(grant.channelId, "C_BEDROCK_TEST");
    assert.equal(grant.secretName, "AWS_BEARER_TOKEN_BEDROCK");
    assert.equal(spec.args[spec.args.indexOf("--setting-sources") + 1], "");
    assert.equal(spec.args[spec.args.indexOf("--settings") + 1], "/lockdown.json");
    assert.equal(spec.args[spec.args.indexOf("--mcp-config") + 1], "/mcp.json");
    assert.ok(spec.args.includes("--strict-mcp-config"));
    assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
    assert.equal(result.content, "hello");
    assert.equal(result.costUSD, null);
    assert.equal(result.usage.input_tokens, 7);
  } finally {
    rmSync(bedrock.bedrockLoginHome(), { recursive: true, force: true });
  }
});
