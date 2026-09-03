// Transient provider failures are retried IN PLACE — same engine, same prompt, a pause in between —
// but only while the turn is provably replayable (no tool ran) and never for the authentication /
// usage-limit failures that belong to cross-engine failover. Drives the real orchestrator against
// the stub CLIs, which fail the first N invocations of a folder and then answer.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

// Read at import time by run.js: keep the pause short so the suite does not sleep 10 s per attempt.
process.env.CG_TRANSIENT_RETRY_DELAY_MS = "40";
delete process.env.CG_TRANSIENT_RETRY_ATTEMPTS;

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns, transientProviderFailure, TRANSIENT_RETRY_ATTEMPTS, TRANSIENT_RETRY_DELAY_MS } = await import("../src/gateway/run.js");
const { classifyCodexFailure } = await import("../src/engines/codex.js");
const { readEvents } = await import("../src/util/logger.js");

const channel = async (id, name, engine) => {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine, cleanMode: true, allowNetwork: false,
  });
  return entry;
};
const retryEvents = (slug) => readEvents({ limit: 200 }).filter((e) => e.event === "run_transient_retry" && e.slug === slug).reverse();
const turn = (channelId, authorId, text, threadKey) => runMessage({
  channelId, authorId, text, threadKey, origin: "slack_foreground", preferCold: true,
  getFallbackContext: async () => "Conversation context\n\n",
});

test("the knobs read the environment: two more attempts, a short pause in the suite", () => {
  assert.equal(TRANSIENT_RETRY_ATTEMPTS, 2);
  assert.equal(TRANSIENT_RETRY_DELAY_MS, 40);
});

test("the Codex classifier knows a transient failure from a wrong request or a credential", () => {
  assert.equal(classifyCodexFailure({ message: "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a3558aecdce7e43d-OTP" }), "transient", "the 2026-09-03 outage shape");
  assert.equal(classifyCodexFailure({ message: "unexpected status 503 Service Unavailable" }), "transient");
  assert.equal(classifyCodexFailure({ message: "Overloaded", status: 529 }), "transient");
  assert.equal(classifyCodexFailure({ message: "stream disconnected before completion: ECONNRESET" }), "transient");
  assert.equal(classifyCodexFailure({ message: "unexpected status 401 Unauthorized" }), "authentication", "a status quoted in prose still routes to its own kind");
  assert.equal(classifyCodexFailure({ message: "unexpected status 429 Too Many Requests" }), "usage_limit");
  assert.equal(classifyCodexFailure({ message: "Something in the request is malformed", status: 400 }), "", "a 400 is the caller's fault, not the provider's absence");
  assert.equal(classifyCodexFailure({ message: "stub failure detail" }), "");
});

test("only a replay-safe transient failure of the engine that ran is retried", () => {
  const codex = (kind, replaySafe = true) => ({ details: { engine: "codex", providerError: true, providerKind: kind, replaySafe } });
  const claude = (kind, replaySafe = true) => ({ details: { engine: "claude", providerError: true, providerKind: kind, replaySafe } });
  assert.equal(transientProviderFailure(codex("transient"), "codex"), "transient");
  assert.equal(transientProviderFailure(claude("availability"), "claude"), "availability");
  assert.equal(transientProviderFailure(claude("connection"), "claude"), "connection");
  assert.equal(transientProviderFailure(claude("provider"), "claude"), "provider");
  assert.equal(transientProviderFailure(codex("usage_limit"), "codex"), "", "limits belong to failover");
  assert.equal(transientProviderFailure(claude("authentication"), "claude"), "", "credentials belong to failover");
  assert.equal(transientProviderFailure(codex("model_rejected"), "codex"), "", "model rejections belong to the same-engine model retry");
  assert.equal(transientProviderFailure(claude("invalid_request"), "claude"), "", "a rejected request is not going to pass on a retry");
  assert.equal(transientProviderFailure(codex("transient", false), "codex"), "", "a turn that may have run a tool is never replayed");
  assert.equal(transientProviderFailure(codex("transient"), "claude"), "", "the error must come from the engine that ran");
  assert.equal(transientProviderFailure(new Error("plain"), "codex"), "");
});

test("Codex: two transient failures, then the answer — retried in place, the reply says so", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_TR_CODEX", { name: "Transient Codex", approved: true, isAdmin: false });
  const entry = await channel("D_TR_CODEX", "transient-codex", "codex");

  const result = await turn("D_TR_CODEX", "U_TR_CODEX", "CODEX_STUB_TRANSIENT_TWICE", "1903.001");

  assert.equal(result.engine, "codex", "the same engine answered — no failover for a transient failure");
  assert.notEqual(result.fellBack, true);
  assert.equal(result.transientRetries, 2);
  assert.match(result.content, /Codex hit a temporary provider error — retried 2× before answering/);
  assert.match(result.content, /Codex stub reply/);
  const events = retryEvents(entry.slug);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.attempt), [1, 2]);
  assert.ok(events.every((e) => e.engine === "codex" && e.kind === "transient" && e.maxAttempts === 2 && e.delayMs === 40 && /404 Not Found/.test(e.error)));
});

test("Codex: a failure that outlives every attempt surfaces the provider error, marked as retried, without failover", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_TR_ALWAYS", { name: "Transient Always", approved: true, isAdmin: false });
  const entry = await channel("D_TR_ALWAYS", "transient-always", "codex");

  await assert.rejects(
    turn("D_TR_ALWAYS", "U_TR_ALWAYS", "CODEX_STUB_TRANSIENT_ALWAYS", "1903.002"),
    (error) => {
      assert.match(error.message, /404 Not Found/);
      assert.match(error.message, /retried 2× \(\d+s apart\) before giving up/);
      assert.equal(error.details.engine, "codex");
      assert.equal(error.details.providerKind, "transient");
      assert.equal(error.details.transientRetries, 2);
      return true;
    },
  );
  assert.equal(retryEvents(entry.slug).length, 2, "exactly the configured retries, then stop");
});

test("Codex: a transient failure AFTER a tool ran is not retried — the turn may have had side effects", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: false, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_TR_TOOL", { name: "Transient After Tool", approved: true, isAdmin: false });
  const entry = await channel("D_TR_TOOL", "transient-after-tool", "codex");

  await assert.rejects(
    turn("D_TR_TOOL", "U_TR_TOOL", "CODEX_STUB_TRANSIENT_AFTER_TOOL", "1903.003"),
    (error) => {
      assert.match(error.message, /503 Service Unavailable/);
      assert.doesNotMatch(error.message, /retried/);
      assert.equal(error.details.providerKind, "transient");
      assert.equal(error.details.replaySafe, false);
      assert.equal(error.details.transientRetries, undefined);
      return true;
    },
  );
  assert.equal(retryEvents(entry.slug).length, 0);
});

test("Claude: an overloaded provider is retried the same way", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_TR_CLAUDE", { name: "Transient Claude", approved: true, isAdmin: false });
  const entry = await channel("D_TR_CLAUDE", "transient-claude", "claude");

  const result = await turn("D_TR_CLAUDE", "U_TR_CLAUDE", "CLAUDE_STUB_TRANSIENT_TWICE", "1903.004");

  assert.equal(result.engine, "claude");
  assert.equal(result.transientRetries, 2);
  assert.match(result.content, /Claude hit a temporary provider error — retried 2× before answering/);
  assert.match(result.content, /Stub engine reply/);
  const events = retryEvents(entry.slug);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.engine === "claude" && e.kind === "availability" && /529 Overloaded/.test(e.error)));
});
