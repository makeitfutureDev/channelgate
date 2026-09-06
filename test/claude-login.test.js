import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const login = await import("../src/gateway/claude-login.js");
test("host subscriptions and stored setup tokens cannot authenticate gateway Claude", () => {
  for (const dir of [login.operatorClaudeConfigDir(), login.gatewayClaudeConfigDir()]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-subscription", refreshToken: "fixture-refresh" } }));
  }
  const result = login.resolveClaudeLogin({ env: {}, configured: () => "legacy-setup-token" });
  assert.equal(result.kind, "none");
  assert.equal(result.file, "");
  assert.match(result.reason, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-subscription|fixture-refresh|legacy-setup-token/);
});
test("service credentials follow CLI precedence and rotate the warm process fingerprint", () => {
  const a = login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "key-a" } });
  const b = login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "key-b" } });
  const proxy = login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "key-b", ANTHROPIC_AUTH_TOKEN: "proxy" } });
  assert.equal(a.kind, "api-key");
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(proxy.fingerprint, login.resolveClaudeLogin({ env: { ANTHROPIC_AUTH_TOKEN: "proxy" } }).fingerprint);
  assert.doesNotMatch(JSON.stringify(login.describeClaudeLogin(a)), /key-a/);
});
