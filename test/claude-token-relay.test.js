import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { resolveContainerClaudeToken, claudeTokenFingerprint } = await import("../src/gateway/claude-token-relay.js");
test("gateway credential resolution never reads, refreshes, or returns a subscription token", async () => {
  let touched = 0;
  const result = await resolveContainerClaudeToken({ env: {}, configured: () => { touched++; return "old-token"; }, read: () => { touched++; }, refresh: () => { touched++; } });
  assert.equal(result.source, "none");
  assert.equal(result.token, "");
  assert.equal(touched, 0);
  assert.match(result.error, /service/);
});
test("service API keys authenticate without returning secret material, and rotation changes identity", async () => {
  const a = await resolveContainerClaudeToken({ env: { ANTHROPIC_API_KEY: "a" } });
  const b = await resolveContainerClaudeToken({ env: { ANTHROPIC_API_KEY: "b" } });
  assert.equal(a.source, "api-key");
  assert.equal(a.token, "");
  assert.notEqual(claudeTokenFingerprint(a), claudeTokenFingerprint(b));
});
