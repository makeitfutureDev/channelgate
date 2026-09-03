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

  const result = await runMessage({
    ...channel,
    text: "CODEX_STUB_REJECT_MODEL",
    threadKey: "2100.100",
    origin: "slack_foreground",
    preferCold: true,
    // Only the harness/model pair is under test here; the same callback also reports WHERE the
    // turn resolved to (runtime backend + isolation), which has its own coverage.
    onRuntimeResolved: ({ engine, model }) => runtimes.push({ engine, model }),
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
