// A model's generic self-description is not its selected runtime. Inspect the exact spawned
// prompts and CLI flags, including retries, so metadata cannot silently describe a prior attempt.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "runtime-identity-workspaces");
const { useFakeRuntime } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setThreadModel } = await import("../src/gateway/thread-engine.js");
const { runMessage } = await import("../src/gateway/run.js");

async function fixture(name, engine, model, extra = {}) {
  saveSettings({ engine, defaultClaudeModel: "sonnet", defaultCodexModel: "gpt-5.6-sol", engineFallback: true,
    engineEnabled: { claude: true, codex: true }, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal" });
  const authorId = `U_${name}`;
  const channelId = `C_${name}`;
  await setUser(authorId, { name: "Runtime fixture", approved: true });
  const entry = await upsertChannelEntry(channelId, { name: name.toLowerCase(), type: "channel" });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "channel", engine, model,
    effort: "high", memory: false, cleanMode: false, allowNetwork: false, ...extra });
  return { entry, channelId, authorId, threadKey: `${name}.1`, origin: "slack_foreground", preferCold: true };
}

function attempts(start) {
  return backend.calls.spawn.slice(start).filter((call) => call.args.some((arg) => String(arg).includes("[Gateway runtime for THIS attempt:")));
}

function metadata(call) {
  const prompt = call.args.find((arg) => String(arg).includes("[Gateway runtime for THIS attempt:"));
  assert.ok(prompt, "the launched engine must receive its runtime facts");
  const match = prompt.match(/^\[Gateway runtime for THIS attempt: (\{[^\n]*\})\n/m);
  assert.ok(match, "runtime facts occupy one JSON data line");
  assert.match(prompt, /configured model.*not.*provider-reported/i);
  return JSON.parse(match[1]);
}

for (const engine of ["claude", "codex"]) {
  test(`${engine}: fresh and resumed turns receive the current configured model and effort`, async () => {
    const initialModel = engine === "claude" ? "opus" : "gpt-5.6-sol";
    const changedModel = engine === "claude" ? "sonnet" : "gpt-6-astra";
    const context = await fixture(`IDENTITY_${engine}`, engine, initialModel);
    const start = backend.calls.spawn.length;
    await runMessage({ ...context, text: "Which engine and model are you running?" });
    await setThreadModel(context.entry.slug, context.threadKey, changedModel);
    await runMessage({ ...context, text: "And now?" });
    const calls = attempts(start);
    assert.equal(calls.length, 2);
    assert.deepEqual(metadata(calls[0]), { engine, configured_model: initialModel, configured_effort: "high", session: "fresh" });
    assert.deepEqual(metadata(calls[1]), { engine, configured_model: changedModel, configured_effort: "high", session: "resumed" });
    assert.ok(calls[1].args.includes(changedModel), "metadata agrees with the model passed to the CLI");
  });
}

test("clean runs retain only safe runtime facts, and an unspecified model stays unknown", async () => {
  const context = await fixture("IDENTITY_CLEAN", "codex", "", { cleanMode: true, effort: "" });
  saveSettings({ defaultCodexModel: "" });
  const start = backend.calls.spawn.length;
  await runMessage({ ...context, text: "Tell me what is inspectable." });
  const [call] = attempts(start);
  assert.ok(call);
  assert.deepEqual(metadata(call), { engine: "codex", configured_model: null, configured_effort: null, session: "fresh" });
  const prompt = call.args.find((arg) => String(arg).includes("[Gateway runtime for THIS attempt:"));
  assert.doesNotMatch(prompt, /Channel memory|Composio identities|Current personal skill grants/);
  assert.match(prompt, /null means.*not exposed/i);
});

test("model retry recomputes facts using the accepted replacement model", async () => {
  const context = await fixture("IDENTITY_MODEL_RETRY", "codex", "gpt-5.6", { cleanMode: true });
  const start = backend.calls.spawn.length;
  await runMessage({ ...context, text: "CODEX_STUB_REJECT_MODEL" });
  const calls = attempts(start);
  assert.equal(calls.length, 2);
  assert.equal(metadata(calls[0]).configured_model, "gpt-5.6");
  assert.equal(metadata(calls[1]).configured_model, "gpt-5.6-sol");
  assert.ok(calls[1].args.includes("gpt-5.6-sol"));
});

test("cross-engine fallback and its model retry use their own engine, model, effort and session", async () => {
  const context = await fixture("IDENTITY_ENGINE_RETRY", "claude", "gpt-5.6", { cleanMode: true });
  const start = backend.calls.spawn.length;
  await runMessage({ ...context, text: "CLAUDE_STUB_LIMIT_FAIL_SAFE CODEX_STUB_REJECT_MODEL" });
  const calls = attempts(start);
  assert.equal(calls.length, 3);
  assert.deepEqual(metadata(calls[0]), { engine: "claude", configured_model: "sonnet", configured_effort: "high", session: "fresh" });
  assert.deepEqual(metadata(calls[1]), { engine: "codex", configured_model: "gpt-5.6", configured_effort: null, session: "fresh" });
  assert.deepEqual(metadata(calls[2]), { engine: "codex", configured_model: "gpt-5.6-sol", configured_effort: null, session: "fresh" });
  const followupStart = backend.calls.spawn.length;
  await runMessage({ ...context, text: "CODEX_STUB_REJECT_MODEL" });
  const followup = attempts(followupStart);
  assert.equal(followup.length, 2, "the cooldown resumes the existing fallback conversation");
  assert.deepEqual(metadata(followup[1]), { engine: "codex", configured_model: "gpt-5.6-sol", configured_effort: null, session: "resumed" });
});

test("a lost resumed session gets fresh metadata when the gateway heals it", async (t) => {
  const context = await fixture("IDENTITY_HEAL", "claude", "sonnet", { cleanMode: true });
  await runMessage({ ...context, text: "Start the conversation." });
  const originalSpawn = backend.spawn;
  const seen = [];
  backend.spawn = (target, spec) => {
    if (spec.args.includes("-r")) {
      seen.push({ args: spec.args });
      throw new Error("No conversation found with session ID: synthetic-lost-session");
    }
    return originalSpawn(target, spec);
  };
  t.after(() => { backend.spawn = originalSpawn; });
  const start = backend.calls.spawn.length;
  await runMessage({ ...context, text: "Continue the conversation.", getFallbackContext: async () => "Prior fixture conversation." });
  assert.equal(seen.length, 1);
  assert.equal(metadata(seen[0]).session, "resumed");
  const calls = attempts(start);
  assert.equal(calls.length, 1);
  assert.equal(metadata(calls[0]).session, "fresh");
});
