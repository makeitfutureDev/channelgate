import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
process.env.SESSION_KEEPALIVE = "0";
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setThreadEngine, setThreadModel } = await import("../src/gateway/thread-engine.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { runFailureText } = await import("../src/slack/message-pipeline.js");
const { createFakeRuntimeBackend, useFakeRuntime } = await import("./runtime-fake.js");
const cli = path.join(tempDir("pinned-provider-guidance-"), "provider.mjs");
writeFileSync(cli, `
const engine = process.env.PINNED_FIXTURE_ENGINE;
const message = "The selected model is unavailable.";
const event = engine === "claude"
  ? { type: "assistant", error: "invalid_request_error", message: { content: [{ type: "text", text: message }] } }
  : { type: "turn.failed", error: { message } };
console.log(JSON.stringify(event));
process.exitCode = 1;
`);
const backend = createFakeRuntimeBackend();
const spawn = backend.spawn.bind(backend);
const engines = [];
backend.spawn = (target, spec) => {
  const engine = String(spec.cmd).includes("codex") ? "codex" : "claude";
  engines.push(engine);
  return spawn(target, { ...spec, cmd: process.execPath, args: [cli, ...spec.args], env: { ...spec.env, PINNED_FIXTURE_ENGINE: engine } });
};
await useFakeRuntime(backend);
await setUser("UPINNEDPROVIDER", { approved: true, isAdmin: false });

for (const engine of ["claude", "codex"]) {
  for (const pinned of [true, false]) {
    test(`${engine}: ${pinned ? "pinned" : "default"} unclassified provider failure never replays and gives the applicable guidance`, async () => {
      resetEngineCooldowns();
      saveSettings({ engine, engineEnabled: { claude: true, codex: true }, engineFallback: true, memoryReviewEvery: 0, composioMode: "personal" });
      const channelId = `D_PINNED_PROVIDER_${engine}_${pinned}`;
      const entry = await upsertChannelEntry(channelId, { name: `pinned-provider-${engine}-${pinned}`, type: "im", isDM: true });
      await saveChannelMeta(entry.slug, { channelId, type: "im", isDM: true, template: "custom", engine, cleanMode: true, allowBash: false, allowNetwork: false });
      const threadKey = "1900000000.000001";
      const model = engine === "claude" ? "opus" : "gpt-5.6-sol";
      if (pinned) {
        await setThreadEngine(entry.slug, threadKey, engine);
        await setThreadModel(entry.slug, threadKey, model);
      }
      const before = engines.length;
      await assert.rejects(runMessage({ channelId, authorId: "UPINNEDPROVIDER", threadKey, text: "Run the harmless provider probe.", origin: "slack_foreground", preferCold: true }), (error) => {
        assert.equal(error.details.providerError, true);
        assert.equal(error.details.engine, engine);
        assert.equal(Boolean(error.details.runtimePinned), pinned);
        const reply = runFailureText(error);
        assert.match(reply, /The selected model is unavailable/);
        if (pinned) {
          assert.equal(error.details.pinnedEngine, engine);
          assert.equal(error.details.pinnedModel, model);
          assert.match(reply, /This thread is pinned/);
          assert.match(reply, /say .* to move it, or \/model to repin it/);
          assert.ok(reply.includes(model));
        } else {
          assert.doesNotMatch(reply, /pinned|unavailable right now|to move it/);
        }
        return true;
      });
      assert.deepEqual(engines.slice(before), [engine], "diagnostic guidance must not authorize another engine attempt");
    });
  }
}

test("non-provider errors and resumable interruptions keep their existing remedies", () => {
  for (const details of [{ engine: "codex", runtimePinned: true, providerError: false }, { engine: "claude", explicitStop: true, providerError: false }]) {
    assert.doesNotMatch(runFailureText({ message: "The process ended.", details }), /pinned|to move it/);
  }
  const interrupted = { message: "The turn was interrupted.", details: { engine: "codex", providerError: true, runtimePinned: true } };
  assert.match(runFailureText(interrupted, { resumable: true }), /send `continue`/);
  assert.doesNotMatch(runFailureText(interrupted, { resumable: true }), /pinned|to move it/);
});


const { credentialError: containerCredentialError } = await import("../src/runtimes/container/credentials.js");
for (const engine of ["claude", "codex"]) {
  for (const pin of ["engine", "model", "none"]) {
    test(`${engine}: missing runtime credential preserves ${pin} pin guidance without starting either engine`, async (t) => {
      resetEngineCooldowns();
      saveSettings({ engine, engineEnabled: { claude: true, codex: true }, engineFallback: true, memoryReviewEvery: 0, composioMode: "personal" });
      const channelId = `D_RUNTIME_CREDENTIAL_${engine}_${pin}`;
      const entry = await upsertChannelEntry(channelId, { name: `runtime-credential-${engine}-${pin}`, type: "im", isDM: true });
      await saveChannelMeta(entry.slug, { channelId, type: "im", isDM: true, template: "custom", engine, cleanMode: true, allowBash: false, allowNetwork: false });
      const threadKey = "1900000000.000002";
      const model = engine === "claude" ? "opus" : "gpt-5.6-sol";
      if (pin === "engine") await setThreadEngine(entry.slug, threadKey, engine);
      if (pin === "model") await setThreadModel(entry.slug, threadKey, model);
      const credential = path.join(engine === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME, engine === "claude" ? ".credentials.json" : "auth.json");
      const original = readFileSync(credential);
      unlinkSync(credential);
      t.after(() => { writeFileSync(credential, original, { mode: 0o600 }); delete backend.credentialError; resetEngineCooldowns(); });
      // The isolated backend owns its Codex login gate. Exercise its real synchronous probe
      // against the removed scratch login, without mounting or copying any operator profile.
      backend.credentialError = (target, requestedEngine) => requestedEngine === "codex"
        ? containerCredentialError({ ...target, container: { ...target.container, credentialMode: { codex: "relay" } } }, requestedEngine)
        : null;
      const before = engines.length;
      await assert.rejects(runMessage({ channelId, authorId: "UPINNEDPROVIDER", threadKey, text: "Please answer using the pinned engine.", origin: "slack_foreground", preferCold: true }), (error) => {
        assert.equal(error.details.runtimeCredential, true);
        assert.notEqual(error.details.providerError, true, "configuration errors must not become replay-safe provider failures");
        assert.equal(error.details.engine, engine);
        const reply = runFailureText(error);
        assert.match(reply, /login|sign.in|credential/i);
        assert.match(reply, engine === "claude" ? /Claude/i : /Codex/i);
        if (pin !== "none") {
          assert.equal(error.details.runtimePinned, true);
          assert.equal(error.details.pinnedEngine, engine);
          assert.match(reply, /This thread is pinned/);
          assert.match(reply, /say .* to move it, or \/model to repin it/);
          if (pin === "model") assert.equal(error.details.pinnedModel, model);
        } else {
          assert.notEqual(error.details.runtimePinned, true);
          assert.doesNotMatch(reply, /pinned|to move it/);
        }
        return true;
      });
      assert.deepEqual(engines.slice(before), [], "credential refusal never starts or falls back to another engine");
    });
  }
}
