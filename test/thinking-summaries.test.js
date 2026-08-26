// Thinking summaries: the status line says WHAT the model is reasoning about, not just that it
// reasons. The Claude stream consumer surfaces throttled summaries from thinking_delta chunks;
// Codex completed reasoning items carry their own summary text.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createStreamConsumer, thinkingSummary, THINKING_SUMMARY_MAX } = await import("../src/engines/stream.js");
const { progressFromCodexEvent } = await import("../src/engines/codex.js");

test("thinkingSummary takes the latest complete line, collapsed and clipped", () => {
  assert.equal(thinkingSummary("First line\nThe   real\tlatest line "), "The real latest line");
  assert.equal(thinkingSummary(""), "");
  const long = "x".repeat(THINKING_SUMMARY_MAX + 20);
  const clipped = thinkingSummary(long);
  assert.equal(clipped.length, THINKING_SUMMARY_MAX);
  assert.ok(clipped.endsWith("…"));
});

test("a Claude thinking block emits a bare event, then a summary once enough text arrived", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  });
  assert.deepEqual(events, [{ kind: "thinking" }]);

  // Too little text — no summary yet.
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user wants" } },
  });
  assert.equal(events.length, 1);

  // A newline completes the first line: the summary fires.
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " a cleaner Slack reply.\n" } },
  });
  assert.deepEqual(events.at(-1), { kind: "thinking", summary: "The user wants a cleaner Slack reply." });

  // Immediately after, more deltas are time-throttled — no burst of API-driving events.
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Next thought.\n" } },
  });
  assert.equal(events.filter((event) => event.kind === "thinking").length, 2);

  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
});

test("redacted thinking only emits the bare event — no content can leak", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning\n" } },
  });
  assert.deepEqual(events, [{ kind: "thinking" }]);
});

test("Claude tool results close the matching live tool without exposing result content", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":"npm test"}' },
    },
  });
  consumer.consume({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
  consumer.consume({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "SECRET TEST OUTPUT",
        is_error: false,
      }],
    },
  });

  assert.deepEqual(events, [
    { kind: "tool_use", id: "toolu_1", name: "Bash", target: "npm test" },
    { kind: "tool_result", id: "toolu_1", name: "Bash", target: "npm test", status: "completed" },
  ]);
  assert.equal(JSON.stringify(events).includes("SECRET TEST OUTPUT"), false,
    "raw tool results must never be copied into Slack progress");
});

test("Codex completed reasoning items carry their summary text; started items stay bare", () => {
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.started", item: { type: "reasoning" } }),
    { event: { kind: "thinking" } },
  );
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "**Weighing options**\nComparing the two APIs" } }),
    { event: { kind: "thinking", summary: "Comparing the two APIs" } },
  );
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.completed", item: { type: "reasoning" } }),
    { event: { kind: "thinking" } },
  );
});
