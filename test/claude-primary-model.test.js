import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { runClaude } = await import("../src/engines/claude.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const { createStreamConsumer } = await import("../src/engines/stream.js");
const { resolveCurrentModel, modelLabel, contextWindowFor } = await import("../src/gateway/model-info.js");
const { recordUsage, readUsage } = await import("../src/gateway/usage.js");

const primary = "claude-opus-5";
const auxiliary = "claude-haiku-4-5-20251001";
const terminal = {
  type: "result", subtype: "success", result: "CONTAINER-OK", session_id: "primary-model-session",
  usage: { input_tokens: 29054, output_tokens: 11 }, total_cost_usd: 0.1487925,
  modelUsage: {
    [auxiliary]: { inputTokens: 1200, outputTokens: 30, contextWindow: 200000 },
    [primary]: { inputTokens: 29054, outputTokens: 11, contextWindow: 1000000 },
  },
};
const events = [
  { type: "system", subtype: "init", model: "claude-sonnet-4-6" },
  { type: "assistant", parent_tool_use_id: null, message: { model: primary, content: [{ type: "text", text: "CONTAINER-OK" }] } },
  { type: "assistant", parent_tool_use_id: "child-agent", message: { model: auxiliary, content: [{ type: "text", text: "Longer ancillary output" }] } },
  terminal,
];

async function assertAttribution(result, suffix) {
  const governed = { ...result, engine: "claude", model: "opus[1m]" };
  assert.equal(result.primaryModel, primary);
  assert.equal(resolveCurrentModel(governed), primary, "actual primary answer beats larger auxiliary usage");
  assert.equal(modelLabel(governed), "Opus 1M", "footer keeps the governing variant");
  assert.equal(contextWindowFor(governed), 1000000);
  assert.deepEqual(result.raw.modelUsage, terminal.modelUsage, "provider accounting remains untouched");
  const channelId = `primary-model-${suffix}`;
  await recordUsage({ channelId, slug: channelId, engine: "claude", result: governed });
  const rows = await readUsage({ channelId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, primary);
  assert.equal(rows[0].runtimeModel, primary);
  assert.equal(rows[0].costUSD, terminal.total_cost_usd);
}

test("cold Claude accounts the short primary answer model instead of larger auxiliary usage", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const target = { backend: "test", runtime: { capabilities: {}, spawn() {
    queueMicrotask(() => {
      child.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      child.emit("close", 0, null);
    });
    return child;
  } } };
  const result = await runClaude({ cwd: process.cwd(), prompt: "Reply with exactly CONTAINER-OK.", target, timeoutMs: 1000 });
  await assertAttribution(result, "cold");
});

test("warm Claude retains primary model attribution across turns and ignores child models", async () => {
  const session = new PersistentClaudeSession({ cwd: process.cwd(), args: [] });
  session.child = { stdin: { write() { return true; } } };
  session.state = "ready";
  for (const suffix of ["warm-fresh", "warm-resume"]) {
    const turn = session.send("Reply with exactly CONTAINER-OK.", { timeoutMs: 1000 });
    for (const event of suffix === "warm-fresh" ? events : events.slice(1)) session._handleLine(JSON.stringify(event));
    await assertAttribution(await turn, suffix);
  }
  session._clearIdle();
});

test("primary stream metadata prefers assistant over init and ignores synthetic or child events", () => {
  const stream = createStreamConsumer();
  stream.consume({ type: "system", subtype: "init", model: primary });
  assert.equal(stream.model, primary, "init is a fallback before any primary message");
  stream.consume({ type: "stream_event", parent_tool_use_id: "child", event: { type: "message_start", message: { model: auxiliary } } });
  stream.consume({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>" } });
  assert.equal(stream.model, primary);
  stream.consume({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { model: "claude-sonnet-4-6" } } });
  stream.consume({ type: "system", subtype: "init", model: auxiliary });
  assert.equal(stream.model, "claude-sonnet-4-6", "primary provider message takes precedence over init metadata");
  assert.equal(resolveCurrentModel({ primaryModel: stream.model, model: "opus[1m]", raw: terminal }), "claude-sonnet-4-6", "a provider model change is not hidden by the configured alias or auxiliary accounting");
});
