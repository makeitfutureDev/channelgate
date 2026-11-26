import assert from "node:assert/strict";
import test from "node:test";
import { turnReplyCallbacks } from "../src/gateway/turn-replies.ts";

test("a single turn forwards live reply callbacks until stopped and preserves absent capabilities", () => {
  const controller = new AbortController();
  const seen: unknown[] = [];
  const deliver = (value: unknown) => { seen.push(value); return "delivered"; };
  const sink = turnReplyCallbacks(controller.signal, { onDelta: deliver, onEvent: deliver, onRuntimeResolved: deliver });
  assert.equal(sink.onDelta?.("answer"), "delivered");
  sink.onEvent?.({ kind: "notice", text: "working" });
  sink.onRuntimeResolved?.({ model: "example" });
  controller.abort();
  sink.onDelta?.("late");
  sink.onEvent?.({ kind: "notice" });
  sink.onRuntimeResolved?.({ model: "late" });
  assert.deepEqual(seen, ["answer", { kind: "notice", text: "working" }, { model: "example" }]);
  assert.equal(turnReplyCallbacks(controller.signal, null).onDelta, undefined);
});
