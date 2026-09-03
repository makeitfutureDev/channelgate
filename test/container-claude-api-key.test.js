// The daemon's own ANTHROPIC_API_KEY is a valid Claude credential for a container channel — the
// documented Linux service-install path (docs/OPERATIONS.md) has no login to relay at all.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
// ensureTestEnv() seeds a stub OPERATOR login into the scratch CLAUDE_CONFIG_DIR so every relayed
// run in the suite has something to relay. These cases are about the world WITHOUT a login, so they
// point the operator config dir at an empty directory of their own (the login resolver reads the
// variable at call time; the gateway's own engine home under the scratch root is empty already).
process.env.CLAUDE_CONFIG_DIR = tempDir("cg-no-claude-login-");

const credentials = await import("../src/runtimes/container/credentials.js");
const { resolveContainerClaudeToken } = await import("../src/gateway/claude-token-relay.js");

const NO_LOGIN_SETTINGS = { hasClaudeOauthToken: false };
const KEYED = { ANTHROPIC_API_KEY: "sk-ant-test" };
const TOKENED = { ANTHROPIC_AUTH_TOKEN: "bearer-test" };
const BARE = {};

test("api-key: with no gateway login, an API key in the daemon env settles Claude to the api-key mode", () => {
  // Neither the operator config dir nor the engine home holds a login, so without a key this is "missing".
  assert.equal(credentials.settleCredentialModes(NO_LOGIN_SETTINGS, BARE).modes.claude, "missing");
  assert.equal(credentials.settleCredentialModes(NO_LOGIN_SETTINGS, KEYED).modes.claude, "api-key");
  assert.equal(credentials.settleCredentialModes(NO_LOGIN_SETTINGS, TOKENED).modes.claude, "api-key");
  // A configured setup-token still wins.
  assert.equal(credentials.settleCredentialModes({ hasClaudeOauthToken: true }, KEYED).modes.claude, "token");
});

test("api-key: the pre-spawn gate reads the key from the LIVE environment, and its absence keeps the gate closed", () => {
  const target = (mode) => ({ container: { credentialMode: { claude: mode, codex: "shared-file" } } });
  assert.equal(credentials.credentialError(target("api-key"), "claude", KEYED), null);
  assert.equal(credentials.credentialError(target("missing"), "claude", KEYED), null, "a key that appeared after settling counts, like a login would");
  const closed = credentials.credentialError(target("api-key"), "claude", BARE);
  assert.match(String(closed?.message), /no Claude login to relay.*claude setup-token.*Settings → Container runtime.*ANTHROPIC_API_KEY/s);
  assert.ok(credentials.credentialNotes(target("api-key")).some((n) => /API key/.test(n)));
});

test("api-key: the relay resolver reports source api-key instead of failing closed when there is no login", async () => {
  // No login on disk anywhere: the scratch operator config dir and the engine home are both empty
  // (test/helpers.js pins CLAUDE_CONFIG_DIR precisely so this is deterministic).
  const none = await resolveContainerClaudeToken({ configured: () => "", env: BARE });
  assert.equal(none.token, "");
  assert.equal(none.source, "none");
  assert.match(none.error, /ANTHROPIC_API_KEY/);

  const keyed = await resolveContainerClaudeToken({ configured: () => "", env: KEYED });
  assert.equal(keyed.token, "");
  assert.equal(keyed.source, "api-key");
  assert.equal(keyed.expiresAt, 0);

  // An expired login the host could not refresh also falls back to the key rather than dead-ending.
  const expiredLogin = { kind: "operator", file: "/nowhere/.credentials.json", configDir: "/nowhere", home: "/nowhere", accessExpiresAt: 1, expiresAt: 0, fingerprint: "x", detail: "", reason: "" };
  const expired = await resolveContainerClaudeToken({
    resolveLogin: () => expiredLogin,
    read: () => ({ token: "old", expiresAt: 1 }), refresh: async () => {}, now: () => 10_000, configured: () => "", env: KEYED,
  });
  assert.equal(expired.source, "api-key");

  // A setup-token beats the key, and a real login beats it too.
  const fixed = await resolveContainerClaudeToken({ configured: () => "setup-token", env: KEYED });
  assert.equal(fixed.token, "setup-token");
  assert.equal(fixed.source, "settings");
  const liveLogin = { ...expiredLogin, accessExpiresAt: Date.now() + 3_600_000 };
  const fresh = await resolveContainerClaudeToken({
    resolveLogin: () => liveLogin,
    read: () => ({ token: "live", expiresAt: Date.now() + 3_600_000 }), configured: () => "", env: KEYED,
  });
  assert.equal(fresh.source, "operator");
  assert.equal(fresh.token, "live");
});
