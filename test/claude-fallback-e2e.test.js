import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { setThreadModel } = await import("../src/gateway/thread-engine.js");

const claudeDM = async (id, name) => {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "claude", cleanMode: true, allowNetwork: false,
  });
  return entry;
};

test("a replay-safe thrown Claude usage-limit failure transparently falls back to Codex", async () => {
  saveSettings({ engine: "claude", codexFallback: true, composioMode: "personal" });
  await setUser("U_SAFE_LIMIT", { name: "Safe Limit", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_SAFE_LIMIT", { name: "safe-limit", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_SAFE_LIMIT",
    name: entry.name,
    type: "im",
    isDM: true,
    template: "custom",
    engine: "claude",
    cleanMode: true,
    allowNetwork: false,
  });

  const result = await runMessage({
    channelId: "D_SAFE_LIMIT",
    authorId: "U_SAFE_LIMIT",
    text: "CLAUDE_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1900.050",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "codex");
  assert.equal(result.fellBackToCodex, true);
  assert.match(result.content, /usage limit.*using Codex/i);
  assert.match(result.content, /Codex stub reply/);
});

test("a Codex cross-engine fallback also replaces a rejected channel model with its gateway default", async () => {
  saveSettings({ engine: "claude", defaultCodexModel: "gpt-5.6-sol", codexFallback: true, composioMode: "personal" });
  await setUser("U_SAFE_MODEL_FALLBACK", { name: "Safe Model Fallback", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_SAFE_MODEL_FALLBACK", { name: "safe-model-fallback", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_SAFE_MODEL_FALLBACK",
    name: entry.name,
    type: "im",
    isDM: true,
    template: "custom",
    engine: "claude",
    model: "gpt-5.6",
    cleanMode: true,
    allowNetwork: false,
  });

  const result = await runMessage({
    channelId: "D_SAFE_MODEL_FALLBACK",
    authorId: "U_SAFE_MODEL_FALLBACK",
    text: "CLAUDE_STUB_AUTH_FAIL_SAFE CODEX_STUB_REJECT_MODEL",
    threadKey: "1900.075",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "codex");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.match(result.content, /Claude authentication.*using Codex/i);
  assert.match(result.content, /gpt-5\.6 was rejected before the turn started/i);
  assert.match(result.content, /model=gpt-5\.6-sol/);
});

test("a replay-safe thrown Claude authentication failure transparently falls back to Codex", async () => {
  saveSettings({ engine: "claude", codexFallback: true, composioMode: "personal" });
  await setUser("U_SAFE_FALLBACK", { name: "Safe Fallback", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_SAFE_FALLBACK", { name: "safe-fallback", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_SAFE_FALLBACK",
    name: entry.name,
    type: "im",
    isDM: true,
    template: "custom",
    engine: "claude",
    cleanMode: true,
    allowNetwork: false,
  });

  const result = await runMessage({
    channelId: "D_SAFE_FALLBACK",
    authorId: "U_SAFE_FALLBACK",
    text: "CLAUDE_STUB_AUTH_FAIL_SAFE",
    threadKey: "1900.100",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "codex");
  assert.equal(result.fellBackToCodex, true);
  assert.match(result.content, /Claude authentication.*using Codex/i);
  assert.match(result.content, /Codex stub reply/);
});

// ── A limit that arrives as the ANSWER, on a thread the user pinned ─────────────
// The engine exits 0 and its reply IS the notice. An ordinary thread is quietly re-answered by
// the other harness; a pinned one keeps the notice — and has to be told that on purpose.

test("a usage-limit ANSWER on an unpinned thread is still re-answered by Codex", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", codexFallback: true, composioMode: "personal" });
  await setUser("U_LIMIT_ANSWER", { name: "Limit Answer", approved: true, isAdmin: false });
  await claudeDM("D_LIMIT_ANSWER", "limit-answer");

  const result = await runMessage({
    channelId: "D_LIMIT_ANSWER",
    authorId: "U_LIMIT_ANSWER",
    text: "CLAUDE_STUB_LIMIT_ANSWER",
    threadKey: "1903.010",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "codex");
  assert.match(result.content, /hit its usage limit — answered with Codex/i);
});

test("the same limit ANSWER on a pinned thread keeps the notice and says why", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", codexFallback: true, composioMode: "personal" });
  await setUser("U_LIMIT_PINNED", { name: "Limit Pinned", approved: true, isAdmin: false });
  const entry = await claudeDM("D_LIMIT_PINNED", "limit-pinned");
  await setThreadModel(entry.slug, "1903.020", "opus");

  const result = await runMessage({
    channelId: "D_LIMIT_PINNED",
    authorId: "U_LIMIT_PINNED",
    text: "CLAUDE_STUB_LIMIT_ANSWER",
    threadKey: "1903.020",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude", "the pinned harness answered, whatever it had to say");
  assert.match(result.content, /pinned to Claude/i);
  assert.match(result.content, /say `codex` in this thread to move it/i);
  assert.match(result.content, /hit your usage limit/i, "the engine's own notice is preserved");
});
