import assert from "node:assert/strict";
import test from "node:test";
import { createStreamConsumer } from "../src/engines/stream.js";

test("streamed and completed Claude replies preserve the boundary between assistant messages", () => {
  const chunks = [];
  const stream = createStreamConsumer({ onDelta: text => chunks.push(text) });
  const emit = event => stream.consume({ type: "stream_event", event });
  const start = () => emit({ type: "message_start", message: { role: "assistant" } });
  const text = value => emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });
  start();
  text("I will ");
  text("check.");
  start(); // A tool-only request contributes no answer text.
  start();
  text("Found ");
  text("one.");
  start();
  text("\n\nExisting break.");
  start();
  assert.equal(stream.text, "I will check.\n\nFound one.\n\nExisting break.");
  assert.equal(chunks.join(""), stream.text);
});

test("duplicate message starts and child text do not split a parent's word", () => {
  const chunks = [];
  const stream = createStreamConsumer({ onDelta: text => chunks.push(text) });
  const start = (id, parent = null) => stream.consume({
    type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { id } },
  });
  const text = (value, parent = null) => stream.consume({
    type: "stream_event", parent_tool_use_id: parent, event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value },
    },
  });
  start("child-a", "tool-id");
  text("Child only", "tool-id");
  start("main-a");
  text("incom");
  start("main-a");
  text("plete");
  start("main-b");
  start("child-b", "tool-id");
  text("another child", "tool-id");
  text("Next.");
  assert.equal(stream.text, "incomplete\n\nNext.");
  assert.equal(chunks.join(""), stream.text);
});
