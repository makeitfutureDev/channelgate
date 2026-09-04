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
const { runMessage, resetEngineCooldowns, transientProviderFailure, transientRetryAttempts, transientRetryDelayMs } = await import("../src/gateway/run.js");
const { classifyCodexFailure } = await import("../src/engines/codex.js");
const { claudeProviderError } = await import("../src/engines/stream.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
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

test("the knobs read the environment PER TURN: two more attempts, a short pause in the suite", () => {
  assert.equal(transientRetryAttempts(), 2);
  assert.equal(transientRetryDelayMs(), 40);
  // Read at call time, so a value that lands in process.env after import (.env, settings.json) counts.
  process.env.CG_TRANSIENT_RETRY_ATTEMPTS = "9";
  process.env.CG_TRANSIENT_RETRY_DELAY_MS = "1m";
  assert.equal(transientRetryAttempts(), 5, "clamped to the cap");
  assert.equal(transientRetryDelayMs(), 60_000, "durations spell like the other knobs");
  process.env.CG_TRANSIENT_RETRY_DELAY_MS = "1e3";
  assert.equal(transientRetryDelayMs(), 10_000, "an unparseable value keeps the default instead of a truncated one");
  delete process.env.CG_TRANSIENT_RETRY_ATTEMPTS;
  process.env.CG_TRANSIENT_RETRY_DELAY_MS = "40";
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
  // The 404 an OpenAI-style backend answers for a model that does not exist is a REJECTION, not an outage.
  assert.equal(classifyCodexFailure({ message: "unexpected status 404 Not Found: The model `gpt-99` does not exist or you do not have access to it., url: http://127.0.0.1/v1/responses" }), "model_rejected");
  // Codex's own underscore codes for the same outages.
  assert.equal(classifyCodexFailure({ message: "Codex is currently experiencing high load.", providerType: "internal_server_error" }), "transient");
  assert.equal(classifyCodexFailure({ message: "stream closed", providerType: "response_stream_disconnected" }), "transient");
  assert.equal(classifyCodexFailure({ message: "could not reach the backend", providerType: "http_connection_failed" }), "transient");
  assert.equal(classifyCodexFailure({ message: "gave up", providerType: "retry_limit" }), "transient");
  // A progress line for a failure the CLI is still retrying is transient whatever status it quotes —
  // never a usage limit that would cool the engine down for 15 minutes and fail over.
  assert.equal(classifyCodexFailure({ message: "Reconnecting... 2/5 (unexpected status 429 Too Many Requests, url: https://chatgpt.com/backend-api/codex/responses)" }), "transient");
  // A LOG is not a verdict: from stderr only the explicit limit/auth phrasings count — a recovered
  // retry line, a quoted status or a timeout mention never makes a wedge or an unexplained exit replayable.
  assert.equal(classifyCodexFailure({ message: "WARN stream disconnected - retrying sampling request (1/5) sampling_error=unexpected status 429 Too Many Requests\nERROR timed out", source: "stderr" }), "");
  assert.equal(classifyCodexFailure({ message: "unexpected status 503 Service Unavailable", source: "stderr" }), "");
  assert.equal(classifyCodexFailure({ message: "You have run out of credits", source: "stderr" }), "usage_limit", "the explicit phrasings still count from a log");
  assert.equal(classifyCodexFailure({ message: "Not logged in. Run `codex login` to continue.", source: "stderr" }), "authentication");
});

test("the Claude classifier retries only what the provider failed to ANSWER", () => {
  const evt = (error, text) => claudeProviderError({ type: "assistant", error, message: { role: "assistant", content: [{ type: "text", text }] } });
  assert.equal(evt("server_error", "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)").kind, "availability");
  assert.equal(evt("overloaded", "API Error: 529 Overloaded").kind, "availability");
  assert.equal(evt("unknown", "API Error: 502 Bad Gateway").kind, "availability", "a 5xx in the text is an outage even under the unknown label");
  assert.equal(evt("unknown", "API Error: 400 mock: provider says no").kind, "provider", "the API Error prefix alone proves nothing — a 4xx was answered, and will be answered the same way again");
  assert.equal(evt("model_not_found", "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.").kind, "provider");
  assert.equal(evt("invalid_request", "Prompt is too long").kind, "invalid_request");
  assert.equal(evt("rate_limit", "You've hit your session limit · resets 6am").kind, "usage_limit");
  assert.equal(evt("authentication_failed", "OAuth session expired").kind, "authentication");
});

test("only a replay-safe transient failure of the engine that ran is retried", () => {
  const codex = (kind, replaySafe = true) => ({ details: { engine: "codex", providerError: true, providerKind: kind, replaySafe } });
  const claude = (kind, replaySafe = true) => ({ details: { engine: "claude", providerError: true, providerKind: kind, replaySafe } });
  assert.equal(transientProviderFailure(codex("transient"), "codex"), "transient");
  assert.equal(transientProviderFailure(claude("availability"), "claude"), "availability");
  assert.equal(transientProviderFailure(claude("connection"), "claude"), "connection");
  assert.equal(transientProviderFailure(claude("provider"), "claude"), "", "an unclassified error is a rejected request until proven otherwise — not replayed");
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
      assert.match(error.message, /retried 2× \(\d+m?s apart\) before giving up/);
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
  // A fresh session is CREATED by its id, and the stub — like the real CLI — refuses to create the
  // same id twice ("Session ID … is already in use"), so the reply above could only have arrived
  // because every attempt ran under a new id. Pin the ledger: three attempts, three ids, and the
  // thread keeps the one that answered.
  const { readFile } = await import("node:fs/promises");
  const { getSession } = await import("../src/gateway/sessions.js");
  const ids = (await readFile(path.join(result.cwd, ".cg-stub-sessions"), "utf8")).split("\n").filter(Boolean);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "no --session-id was reused across attempts");
  assert.equal(await getSession(entry.slug, "1903.004"), ids.at(-1), "the persisted id is the one that answered");
});

test("Claude: a transient failure AFTER text already streamed is not retried — the thread has seen half an answer", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", engineFallback: false, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_TR_TEXT", { name: "Transient After Text", approved: true, isAdmin: false });
  const entry = await channel("D_TR_TEXT", "transient-after-text", "claude");

  await assert.rejects(
    turn("D_TR_TEXT", "U_TR_TEXT", "CLAUDE_STUB_TRANSIENT_AFTER_TEXT", "1903.005"),
    (error) => {
      assert.match(error.message, /Connection dropped/);
      assert.doesNotMatch(error.message, /retried/);
      assert.equal(error.details.providerKind, "availability");
      assert.equal(error.details.replaySafe, false);
      return true;
    },
  );
  assert.equal(retryEvents(entry.slug).length, 0);
});

// The warm (pooled) Claude process — the production default — does not exit on a provider
// failure: it reports the assistant `error` marker, ends the turn as an is_error result and stays
// alive. That turn must REJECT with the classified failure (as print mode does by exiting 1), or
// the "API Error: …" text becomes the reply and nothing ever retries.
const warmTurn = (lines) => {
  const session = new PersistentClaudeSession({ cwd: "/tmp", args: [] });
  session.child = { stdin: { write: () => true } };
  session.state = "ready";
  const promise = session.send("hello", { timeoutMs: 1_000, maxSilenceMs: 1_000 });
  for (const line of lines) session._onStdout(`${JSON.stringify(line)}\n`);
  return { session, promise };
};
const OVERLOADED = { type: "assistant", error: "server_error", message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] } };
const ERROR_RESULT = { type: "result", subtype: "success", is_error: true, result: "API Error: 529 Overloaded", session_id: "s", usage: { input_tokens: 0, output_tokens: 0 } };

test("warm Claude: a provider failure the live process reports as an is_error result rejects, replay-safe", async () => {
  const { session, promise } = warmTurn([OVERLOADED, ERROR_RESULT]);
  await assert.rejects(promise, (error) => {
    assert.match(error.message, /529 Overloaded/);
    assert.equal(error.details.engine, "claude");
    assert.equal(error.details.providerError, true);
    assert.equal(error.details.providerKind, "availability");
    assert.equal(error.details.replaySafe, true);
    assert.equal(transientProviderFailure(error, "claude"), "availability");
    return true;
  });
  assert.equal(session.state, "dead", "the process is retired with the turn; the retry spawns afresh");
});

test("warm Claude: the same failure after streamed text is not replay-safe; a plain answer still resolves", async () => {
  const delta = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half an answer" } } };
  const { promise } = warmTurn([delta, OVERLOADED, ERROR_RESULT]);
  await assert.rejects(promise, (error) => { assert.equal(error.details.replaySafe, false); return true; });

  const ok = warmTurn([delta, { type: "result", subtype: "success", is_error: false, result: "Half an answer", session_id: "s", usage: { input_tokens: 3, output_tokens: 2 } }]);
  const result = await ok.promise;
  assert.equal(result.content, "Half an answer");
  assert.equal(ok.session.state, "ready");
});
