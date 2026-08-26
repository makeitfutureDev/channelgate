import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { runClaude } = await import("../src/engines/claude.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const { claudeProviderErrorMessage } = await import("../src/engines/stream.js");
const { replaySafeFallbackKind } = await import("../src/gateway/run.js");

const RESET_MESSAGE = "Claude usage limit reached: You’ve hit your session limit · resets 6am (Europe/Bucharest)";
const RATE_LIMIT_EVENT = {
  type: "assistant",
  error: "rate_limit",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "You’ve hit your session limit · resets 6am (Europe/Bucharest)" }],
  },
};

test("provider error extraction preserves Claude's actionable reset message", () => {
  assert.equal(claudeProviderErrorMessage(RATE_LIMIT_EVENT), RESET_MESSAGE);
  assert.equal(
    claudeProviderErrorMessage({ type: "assistant", message: { content: [{ type: "text", text: "A rate limit is a quota." }] } }),
    "",
    "normal assistant prose must not become an engine error",
  );
  assert.equal(
    claudeProviderErrorMessage({
      type: "assistant",
      error: "authentication_error",
      message: { content: [{ type: "text", text: "Sign in again to continue." }] },
    }),
    "Claude authentication failed: Sign in again to continue.",
  );
  assert.equal(
    claudeProviderErrorMessage({ type: "assistant", error: "provider_mystery" }),
    "Claude provider returned an error",
    "unknown provider identifiers stay in diagnostics instead of becoming opaque user-facing labels",
  );
});

test("cold Claude nonzero exit surfaces the provider usage-limit message", async () => {
  const fixtureBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-rate-limit");
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixtureBin}${path.delimiter}${previousPath || ""}`;
  try {
    await assert.rejects(
      runClaude({
        cwd: fixtureBin,
        prompt: "run the scheduled task",
        sessionId: "11111111-2222-3333-4444-555555555555",
        isNewSession: true,
        timeoutMs: 1_000,
        maxSilenceMs: 1_000,
      }),
      (error) => {
        assert.equal(error.message, RESET_MESSAGE);
        assert.equal(error.details?.exitCode, 1);
        assert.equal(error.details?.providerKind, "usage_limit");
        assert.equal(error.details?.replaySafe, true);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("warm Claude process death surfaces the provider usage-limit message", async () => {
  const writes = [];
  const session = new PersistentClaudeSession({ cwd: "/tmp", args: [] });
  session.child = { stdin: { write: (value) => (writes.push(value), true) } };
  session.state = "ready";

  const turn = session.send("run the scheduled task", { timeoutMs: 1_000, maxSilenceMs: 1_000 });
  session._onStdout(`${JSON.stringify(RATE_LIMIT_EVENT)}\n`);
  session._die(new Error("Claude failed because it reported a general error."));

  await assert.rejects(turn, (error) => {
    assert.equal(error.message, RESET_MESSAGE);
    assert.match(String(error.cause?.message || ""), /reported a general error/);
    assert.equal(error.details?.providerKind, "usage_limit");
    assert.equal(error.details?.replaySafe, true);
    return true;
  });
  assert.equal(session.state, "dead");
  assert.equal(writes.length, 1);
});

test("a provider failure after any Claude tool attempt is not replay-safe", async () => {
  const session = new PersistentClaudeSession({ cwd: "/tmp", args: [] });
  session.child = { stdin: { write: () => true } };
  session.state = "ready";
  const turn = session.send("do something", { timeoutMs: 1_000, maxSilenceMs: 1_000 });
  session._onStdout(`${JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Bash" } },
  })}\n`);
  session._onStdout(`${JSON.stringify(RATE_LIMIT_EVENT)}\n`);
  session._die(new Error("Claude failed"));
  await assert.rejects(turn, (error) => {
    assert.equal(error.details?.providerKind, "usage_limit");
    assert.equal(error.details?.replaySafe, false);
    assert.equal(replaySafeFallbackKind(error, "claude"), "");
    return true;
  });
});

test("only replay-safe thrown authentication and usage-limit failures qualify for fallback", () => {
  assert.equal(replaySafeFallbackKind({
    details: { engine: "claude", providerError: true, providerKind: "authentication", replaySafe: true },
  }, "claude"), "authentication");
  assert.equal(replaySafeFallbackKind({
    details: { engine: "claude", providerError: true, providerKind: "usage_limit", replaySafe: true },
  }, "claude"), "usage_limit");
  assert.equal(replaySafeFallbackKind({
    details: { engine: "claude", providerError: true, providerKind: "authentication", replaySafe: false },
  }, "claude"), "");
  assert.equal(replaySafeFallbackKind({
    details: { engine: "claude", providerError: true, providerKind: "availability", replaySafe: true },
  }, "claude"), "");
});
