import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
// Every channel turn runs in a container-shaped target: the orchestrated turns resolve one through
// run.js's test seam, and the one direct runner call below is handed the same fake backend.
const { useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const fakeBackend = await useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, replaySafeGatewayDefaultModel } = await import("../src/gateway/run.js");
const { runCodex } = await import("../src/engines/codex.js");

async function codexChannel(id, { model = "gpt-5.6" } = {}) {
  await setUser(`U_${id}`, { name: id, approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(`D_${id}`, { name: id.toLowerCase(), type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: `D_${id}`,
    name: entry.name,
    type: "im",
    isDM: true,
    template: "custom",
    engine: "codex",
    model,
    effort: "high",
    cleanMode: true,
    allowNetwork: false,
  });
  return { entry, channelId: `D_${id}`, authorId: `U_${id}` };
}

test("a rejected channel model retries once with the distinct gateway default", async () => {
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", composioMode: "personal" });
  const channel = await codexChannel("MODEL_FALLBACK");
  const runtimes = [];
  const notes = [];

  const result = await runMessage({
    ...channel,
    text: "CODEX_STUB_REJECT_MODEL",
    threadKey: "2100.100",
    origin: "slack_foreground",
    preferCold: true,
    // Only the harness/model pair is under test here; the same callback also reports WHERE the
    // turn resolved to (runtime backend + isolation), which has its own coverage.
    onRuntimeResolved: ({ engine, model }) => runtimes.push({ engine, model }),
    onEvent: (event) => { if (event?.kind === "answer_note") notes.push(event.text); },
  });

  assert.equal(result.engine, "codex");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.deepEqual(runtimes, [
    { engine: "codex", model: "gpt-5.6" },
    { engine: "codex", model: "gpt-5.6-sol" },
  ]);
  assert.match(result.content, /gpt-5\.6 was rejected before the turn started/i);
  assert.match(result.content, /using gateway default gpt-5\.6-sol/i);
  assert.match(result.content, /model=gpt-5\.6-sol/);
  // The same sentence is ALSO announced to the delivery layer before the retry spawns: a surface
  // that streams its answer writes the message from the stream, never from `content`.
  assert.deepEqual(notes, ["⚠️ _gpt-5.6 was rejected before the turn started — using gateway default gpt-5.6-sol._\n\n"]);
});

test("a generic Codex failure is never replayed with the gateway default", async () => {
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", composioMode: "personal" });
  const channel = await codexChannel("MODEL_GENERIC");
  const runtimes = [];

  await assert.rejects(
    runMessage({
      ...channel,
      text: "CODEX_STUB_FAIL_GENERIC",
      threadKey: "2100.200",
      origin: "slack_foreground",
      preferCold: true,
      onRuntimeResolved: ({ engine, model }) => runtimes.push({ engine, model }),
    }),
    /stub failure detail/,
  );
  assert.deepEqual(runtimes, [{ engine: "codex", model: "gpt-5.6" }]);
});

test("a model rejection after a tool attempt is marked non-replayable", async () => {
  const target = fakeTarget(fakeBackend, "model-default-direct", { platform: "slack", channelId: "D_MODEL_DIRECT" });
  await assert.rejects(
    runCodex({
      cwd: projectRoot,
      prompt: "CODEX_STUB_REJECT_AFTER_TOOL",
      sessionId: "",
      isNewSession: true,
      clean: true,
      model: "gpt-5.6",
      timeoutMs: 1_000,
      target,
      artifactDir: target.artifactDir,
    }),
    (error) => {
      assert.equal(error.details?.providerKind, "model_rejected");
      assert.equal(error.details?.toolUseCount, 1);
      assert.equal(error.details?.replaySafe, false);
      assert.equal(replaySafeGatewayDefaultModel(error, {
        engine: "codex",
        model: "gpt-5.6",
        defaultModel: "gpt-5.6-sol",
      }), "");
      return true;
    },
  );
});

test("if the gateway default is also rejected, the original model error is preserved", async () => {
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", composioMode: "personal" });
  const channel = await codexChannel("MODEL_DOUBLE_FAIL");

  await assert.rejects(
    runMessage({
      ...channel,
      text: "CODEX_STUB_REJECT_ALL_MODELS",
      threadKey: "2100.300",
      origin: "slack_foreground",
      preferCold: true,
    }),
    (error) => {
      assert.match(error.message, /gpt-5\.6.*not supported/i);
      assert.equal(error.details?.defaultModel, "gpt-5.6-sol");
      assert.match(error.details?.defaultModelError || "", /gpt-5\.6-sol.*not supported/i);
      return true;
    },
  );
});

// ── The same path for Claude ─────────────────────────────────────────────────────────────────
async function claudeChannel(id, { model = "opus" } = {}) {
  await setUser(`U_${id}`, { name: id, approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(`D_${id}`, { name: id.toLowerCase(), type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: `D_${id}`, name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "claude", model, cleanMode: true, allowNetwork: false,
  });
  return { entry, channelId: `D_${id}`, authorId: `U_${id}` };
}

test("Claude: a rejected channel model retries once with the gateway default, under a new session id", async () => {
  saveSettings({ engine: "claude", defaultClaudeModel: "sonnet", composioMode: "personal" });
  const channel = await claudeChannel("CLAUDE_MODEL_FALLBACK");
  const runtimes = [];
  const notes = [];

  const result = await runMessage({
    ...channel,
    text: "CLAUDE_STUB_REJECT_MODEL",
    threadKey: "2100.400",
    origin: "slack_foreground",
    preferCold: true,
    onRuntimeResolved: ({ engine, model }) => runtimes.push({ engine, model }),
    onEvent: (event) => { if (event?.kind === "answer_note") notes.push(event.text); },
  });

  assert.equal(result.engine, "claude");
  assert.equal(result.model, "sonnet");
  assert.deepEqual(runtimes, [
    { engine: "claude", model: "opus" },
    { engine: "claude", model: "sonnet" },
  ]);
  assert.match(result.content, /opus was rejected before the turn started/i);
  assert.match(result.content, /using gateway default sonnet/i);
  assert.deepEqual(notes, ["⚠️ _opus was rejected before the turn started — using gateway default sonnet._\n\n"]);
  // The stub refuses a reused --session-id like the real CLI, so this reply proves the replay ran under a new id.
  assert.match(result.content, /model=sonnet/);
});

test("Claude: if the gateway default is also rejected, the original model error is preserved", async () => {
  saveSettings({ engine: "claude", defaultClaudeModel: "sonnet", composioMode: "personal" });
  const channel = await claudeChannel("CLAUDE_MODEL_DOUBLE_FAIL");
  await assert.rejects(
    runMessage({ ...channel, text: "CLAUDE_STUB_REJECT_ALL_MODELS", threadKey: "2100.500", origin: "slack_foreground", preferCold: true }),
    (error) => {
      assert.match(error.message, /Claude provider rejected the model: .*selected model \(opus\)/);
      assert.equal(error.details?.providerKind, "model_rejected");
      assert.equal(error.details?.defaultModel, "sonnet");
      assert.match(error.details?.defaultModelError || "", /selected model \(sonnet\)/);
      return true;
    },
  );
});

// ── The same substitution on the CROSS-ENGINE path ────────────────────────────────────────────
// A turn that failed over to the other harness resolves its own model there, and that model can be
// refused just as easily. The failover already speaks in the thread ("using Codex"), so a silent
// second substitution underneath it is even harder to notice than the primary one.
test("a model the fallback harness rejects is substituted and announced there too", async () => {
  saveSettings({
    engine: "claude", defaultClaudeModel: "sonnet", defaultCodexModel: "gpt-5.6-sol",
    engineFallback: true, engineFallbackMode: "auto", engineEnabled: { claude: true, codex: true },
    composioMode: "personal",
  });
  const channel = await claudeChannel("CROSS_MODEL_FALLBACK", { model: "gpt-5.6" });
  const runtimes = [];
  const notes = [];

  const result = await runMessage({
    ...channel,
    // Claude hits a replay-safe usage limit (nothing ran) → Codex answers; the channel's model is a
    // Codex one, so the fallback uses it — and this Codex refuses it.
    text: "CLAUDE_STUB_LIMIT_FAIL_SAFE CODEX_STUB_REJECT_MODEL",
    threadKey: "2100.600",
    origin: "slack_foreground",
    preferCold: true,
    onRuntimeResolved: ({ engine, model }) => runtimes.push({ engine, model }),
    onEvent: (event) => { if (event?.kind === "answer_note") notes.push(event.text); },
  });

  assert.equal(result.engine, "codex");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.deepEqual(runtimes.slice(-2), [
    { engine: "codex", model: "gpt-5.6" },
    { engine: "codex", model: "gpt-5.6-sol" },
  ]);
  assert.match(result.content, /hit its usage limit before any tool call — using Codex/i);
  assert.match(result.content, /gpt-5\.6 was rejected before the turn started — using gateway default gpt-5\.6-sol/i);
  assert.deepEqual(notes, ["⚠️ _gpt-5.6 was rejected before the turn started — using gateway default gpt-5.6-sol._\n\n"]);
});
