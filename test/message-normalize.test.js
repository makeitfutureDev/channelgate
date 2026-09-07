import test from "node:test";
import assert from "node:assert/strict";
import {
  isIgnorable,
  isPendingCommand,
  isStopCommand,
  mentionsBot,
  parseSlashCommand,
  stripMentions,
} from "../src/slack/message-normalize.js";

test("message controls normalize case, spacing, and trailing punctuation", () => {
  assert.equal(isStopCommand("  Please   STOP! "), true);
  assert.equal(isStopCommand("stop reviewing"), false);
  assert.equal(isPendingCommand("My Follow-Ups?"), true);
  assert.equal(isPendingCommand("pending review my PR"), false);
  assert.deepEqual(parseSlashCommand(" /MODEL high "), { cmd: "model", arg: "high" });
  assert.equal(parseSlashCommand("/unknown"), null);
});

test("mention normalization targets only the configured bot", () => {
  const text = "hello <@B123|gateway> and <@U456>";
  assert.equal(mentionsBot(text, "B123"), true);
  assert.equal(mentionsBot(text, "B999"), false);
  assert.equal(stripMentions(text, "B123"), "hello  and <@U456>");
});

test("inbound subtype and trusted-bot gating fails closed", () => {
  assert.equal(isIgnorable({ user: "B123" }, "B123"), true);
  assert.equal(isIgnorable({ user: "U1", subtype: "message_changed" }, "B123"), true);
  assert.equal(isIgnorable({ user: "U1", bot_id: "APP1", subtype: "bot_message" }, "B123", []), true);
  assert.equal(isIgnorable({ user: "U1", bot_id: "APP1", subtype: "bot_message" }, "B123", ["APP1"]), false);
});

test("loop Stop phrases enter cancellation without swallowing requests about code", () => {
  for (const text of ["stop the loop", "Stop the check loop now!", "please cancel this loop", "halt my watch loop please"]) assert.equal(isStopCommand(text), true, text);
  for (const text of ["how do I stop the loop", "stop the loop when done", "stop reviewing", "please stop the loop and deploy"]) assert.equal(isStopCommand(text), false, text);
});
