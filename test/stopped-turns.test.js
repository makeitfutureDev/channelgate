// Stopped-turn replay markers: request 2+ in a Slack thread can be killed before Codex records
// that request, so the next turn gets a one-shot copy of only the stopped user request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { clearStoppedTurn, formatStoppedTurnContext, saveStoppedTurn, takeStoppedTurn } = await import("../src/gateway/stopped-turns.js");

test("stopped turn markers are one-shot per Slack thread", () => {
  clearStoppedTurn("chan", "111.1");
  assert.equal(takeStoppedTurn("chan", "111.1"), null);

  assert.equal(saveStoppedTurn({ channelId: "C1", slug: "chan", threadKey: "111.1", authorId: "U1", text: "roll back this feature" }), true);
  assert.equal(saveStoppedTurn({ channelId: "C1", slug: "chan", threadKey: "222.2", authorId: "U1", text: "different thread" }), true);

  const first = takeStoppedTurn("chan", "111.1");
  assert.equal(first.text, "roll back this feature");
  assert.equal(first.authorId, "U1");
  assert.equal(takeStoppedTurn("chan", "111.1"), null);

  const other = takeStoppedTurn("chan", "222.2");
  assert.equal(other.text, "different thread");
});

test("empty stopped prompts are ignored", () => {
  clearStoppedTurn("chan", "empty");
  assert.equal(saveStoppedTurn({ slug: "chan", threadKey: "empty", text: "   " }), false);
  assert.equal(takeStoppedTurn("chan", "empty"), null);
});

test("formats stopped request as context with current message authoritative", () => {
  const block = formatStoppedTurnContext({ text: "please finish the migration" });
  assert.match(block, /previous user request/i);
  assert.match(block, /current user message below is authoritative/i);
  assert.match(block, /<previous_stopped_request>\nplease finish the migration\n<\/previous_stopped_request>/);
  assert.equal(formatStoppedTurnContext(null), "");
});
