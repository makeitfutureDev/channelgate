// A Slack Web API refusal's message is only its code; the schema pointer and reason travel in
// response_metadata.messages. The Settings error path must carry both, or "invalid_arguments"
// alone is undiagnosable from chat.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { slackErrorText } = await import("../src/slack/app.js");

test("slackErrorText appends Slack's response_metadata messages and caps the line", () => {
  const error = Object.assign(new Error("An API error occurred: invalid_arguments"), {
    data: { ok: false, error: "invalid_arguments", response_metadata: { messages: ["[ERROR] failed to match all allowed schemas [json-pointer:/view/blocks/5]", "[ERROR] must be less than 3001 characters [json-pointer:/view/blocks/5/text/text]"] } },
  });
  const text = slackErrorText(error);
  assert.match(text, /^An API error occurred: invalid_arguments — \[ERROR\] failed to match/);
  assert.match(text, /json-pointer:\/view\/blocks\/5\/text\/text/);
  assert.equal(slackErrorText(new Error("plain")), "plain");
  assert.equal(slackErrorText(null, "fallback"), "fallback");
  const long = Object.assign(new Error("x"), { data: { response_metadata: { messages: ["y".repeat(5000)] } } });
  assert.equal(slackErrorText(long).length, 1500);
});
