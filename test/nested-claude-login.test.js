import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { installNestedClaudeLogin } = await import("../src/gateway/nested-claude-login.js");
const { nestedClaudeLoginEnv, resolveEgressGrant, __resetGrantCaches } = await import("../src/gateway/egress/grants.js");
const { corePlaceholder } = await import("../src/gateway/egress/placeholders.js");
const { renderClaudeWrapper, CLAUDE_NESTED_LOGIN_FILE } = await import("../src/runtimes/container/vscode.js");
const { runClaude, buildClaudeEnv } = await import("../src/engines/claude.js");
const { qwenProviderEnv } = await import("../src/engines/qwen.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

function target(id = "C_NESTED") {
  const writes = [];
  return {
    backend: "container", slug: id.toLowerCase(), meta: { channelId: id }, artifactDir: "/artifacts",
    container: { home: "/home/agent", egress: { active: true, mode: "proxy" } },
    runtime: { capabilities: { isolated: true }, writeHomeFile: async (_, entry) => writes.push(entry) }, writes,
  };
}
const oauth = { token: "sk-ant-oat01-FAKE-HOST-TOKEN", source: "operator", expiresAt: Date.now() + 3_600_000 };

test("ordinary container login persists only a channel-bound placeholder, refreshed or cleared at every spawn", async () => {
  const t = target();
  assert.equal(await installNestedClaudeLogin(t, { resolveToken: async () => oauth }), true);
  assert.equal(t.writes[0].file, CLAUDE_NESTED_LOGIN_FILE);
  assert.match(t.writes[0].body, /CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-cgph_r/);
  assert.ok(!JSON.stringify(t.writes).includes(oauth.token));
  assert.ok(!JSON.stringify(t.writes).includes("refreshToken"));
  assert.equal(t.writes[1].file, "/home/agent/.local/bin/claude");
  assert.equal(t.writes[1].mode, 0o700);
  assert.match(t.writes[1].body, /channelgate-login\.env/);
  await installNestedClaudeLogin(t, { resolveToken: async () => ({ token: "", source: "none" }) });
  assert.equal(t.writes[2].body, "", "a removed login clears the persistent managed credential");
});

test("a legacy bridge, host, unbound channel or backend without private HOME writes receives no persistent login", async () => {
  for (const t of [
    { ...target(), container: { egress: { active: false } } },
    { ...target(), meta: {} },
    { ...target(), runtime: {} },
  ]) {
    assert.equal(await installNestedClaudeLogin(t, { resolveToken: async () => assert.fail("must not resolve a raw credential") }), false);
    assert.deepEqual(t.writes, []);
  }
});

test("API-key and bearer installations persist protected grants that resolve live and revoke when removed", async () => {
  const source = { ANTHROPIC_API_KEY: "fake-api-key", ANTHROPIC_AUTH_TOKEN: "fake-bearer" };
  const t = target("C_NESTED_API");
  await installNestedClaudeLogin(t, { resolveToken: async () => ({ token: "", source: "api-key" }), env: source });
  assert.ok(!t.writes[0].body.includes("fake-api-key"));
  const env = nestedClaudeLoginEnv({ target: t, relay: { source: "api-key" }, env: source });
  for (const [name, value] of Object.entries(env)) {
    const grant = await resolveEgressGrant(corePlaceholder(value), { env: source });
    assert.equal(grant.value, source[name]);
    assert.equal(grant.channelId, "C_NESTED_API");
    assert.deepEqual(grant.hosts, ["api.anthropic.com"]);
    assert.ok(grant.headers.includes("x-api-key"));
    __resetGrantCaches();
    assert.equal(await resolveEgressGrant(corePlaceholder(value), { env: {} }), null);
  }
});

test("API credentials intended for a custom endpoint are never relayed to Anthropic", async () => {
  const t = target("C_NESTED_CUSTOM");
  const custom = { ANTHROPIC_API_KEY: "custom-key", ANTHROPIC_BASE_URL: "https://custom.invalid" };
  assert.deepEqual(nestedClaudeLoginEnv({ target: t, relay: { source: "api-key" }, env: custom }), {});
  const canonical = nestedClaudeLoginEnv({ target: t, relay: { source: "api-key" }, env: { ANTHROPIC_API_KEY: "custom-key" } });
  assert.equal(await resolveEgressGrant(corePlaceholder(canonical.ANTHROPIC_API_KEY), { env: custom }), null,
    "changing the destination revokes a previously minted canonical grant");
});

test("nested Claude resets inherited Qwen routing and nested-session guard; editor wrappers retain the HOME fallback", () => {
  const dir = tempDir("cg-nested-wrapper-");
  const loginEnvFile = path.join(dir, "login.env");
  const wrapper = path.join(dir, "claude");
  const binary = path.join(dir, "actual-claude");
  const placeholder = "sk-ant-oat01-cgph_r_test";
  writeFileSync(loginEnvFile, `CLAUDE_CODE_OAUTH_TOKEN='${placeholder}'\n`);
  writeFileSync(binary, `#!/usr/bin/env node
const names = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "CG_CLAUDE_MAIN"];
console.log(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] || ""]))));
`);
  chmodSync(binary, 0o700);
  // This is the same renderer SSH/editor installation calls, with its temporary token gone.
  writeFileSync(wrapper, renderClaudeWrapper({ loginEnvFile, tokenFile: path.join(dir, "removed-editor-token"), claudeBin: binary }));
  chmodSync(wrapper, 0o700);
  const result = JSON.parse(execFileSync(wrapper, ["-p", "hello", "--model", "opus"], { encoding: "utf8", env: {
    ...process.env, ANTHROPIC_BASE_URL: "https://qwen.invalid/apps/anthropic", ANTHROPIC_AUTH_TOKEN: "qwen-key",
    ANTHROPIC_API_KEY: "wrong-key", CLAUDE_CODE_OAUTH_TOKEN: "wrong-token", CLAUDECODE: "1",
  } }));
  assert.deepEqual(result, { ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: placeholder, CLAUDECODE: "", CG_CLAUDE_MAIN: "" });
  writeFileSync(loginEnvFile, "ANTHROPIC_API_KEY='cgph_r_api'\n");
  const keyed = JSON.parse(execFileSync(wrapper, [], { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "old-token" } }));
  assert.equal(keyed.ANTHROPIC_API_KEY, "cgph_r_api");
  assert.equal(keyed.CLAUDE_CODE_OAUTH_TOKEN, "");
  const editorToken = path.join(dir, "removed-editor-token");
  writeFileSync(editorToken, "old-oauth");
  const keyedWithEditor = JSON.parse(execFileSync(wrapper, [], { encoding: "utf8", env: process.env }));
  assert.equal(keyedWithEditor.CLAUDE_CODE_OAUTH_TOKEN, "", "an old editor login cannot override an API-key or removed HOME login");
  writeFileSync(loginEnvFile, "");
  assert.equal(readFileSync(loginEnvFile, "utf8"), "");
  const missing = JSON.parse(execFileSync(wrapper, [], { encoding: "utf8", env: { ...process.env, ANTHROPIC_BASE_URL: "https://qwen.invalid", ANTHROPIC_AUTH_TOKEN: "qwen-key" } }));
  assert.equal(missing.ANTHROPIC_BASE_URL, "", "a missing Claude login must not silently delegate to Qwen");
  assert.equal(missing.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(missing.CLAUDE_CODE_OAUTH_TOKEN, "");
  const main = JSON.parse(execFileSync(wrapper, [], { encoding: "utf8", env: {
    ...process.env, CG_CLAUDE_MAIN: "1", ANTHROPIC_BASE_URL: "https://main.invalid",
    ANTHROPIC_AUTH_TOKEN: "main-auth", CLAUDE_CODE_OAUTH_TOKEN: "main-oauth",
  } }));
  assert.equal(main.ANTHROPIC_BASE_URL, "https://main.invalid", "gateway-managed main Claude preserves its resolved endpoint");
  assert.equal(main.ANTHROPIC_AUTH_TOKEN, "main-auth");
  assert.equal(main.CLAUDE_CODE_OAUTH_TOKEN, "main-oauth");
  assert.equal(main.CG_CLAUDE_MAIN, "", "the main-process marker is consumed before tools or children inherit it");
});

test("Qwen's main container process bypasses the Anthropic launcher and keeps its own provider credential", async () => {
  const backend = createFakeRuntimeBackend();
  const t = fakeTarget(backend, "nested-qwen", { channelId: "C_NESTED_QWEN" });
  mkdirSync(t.cwd, { recursive: true });
  const providerEnv = qwenProviderEnv({ apiKey: "fake-qwen-key", baseUrl: "https://qwen.invalid/apps/anthropic" });
  await runClaude({ cwd: t.cwd, prompt: "hello", target: t, providerEnv, engineId: "qwen", model: "qwen3.8-max", sessionId: "nested-qwen", isNewSession: true });
  assert.equal(backend.calls.spawn[0].cmd, "/usr/local/bin/claude");
  const env = buildClaudeEnv({ target: t, oauthToken: oauth.token, providerEnv }, {});
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "fake-qwen-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});
