// A reminder must not stutter (QA ART-001). The scheduler renders "⏰ *Reminder:* <text>", and a
// prompt that already reads "Reminder: review the QA results" posted as
// "⏰ *Reminder:* Reminder: review the QA results".
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { reminderBody } = await import("../src/gateway/scheduler.js");

test("a leading Reminder: label is dropped before the renderer adds its own", () => {
  assert.equal(reminderBody("Reminder: review the QA results"), "review the QA results");
  assert.equal(reminderBody("reminder: review the QA results"), "review the QA results");
  assert.equal(reminderBody("REMINDER:review the QA results"), "review the QA results");
  assert.equal(reminderBody("  Reminder :  review the QA results  "), "review the QA results");
  assert.equal(reminderBody("Reminders: review the QA results"), "review the QA results");
});

test("text that is not a label is left exactly as written", () => {
  assert.equal(reminderBody("review the QA results"), "review the QA results");
  assert.equal(reminderBody("Remind me to review the QA results"), "Remind me to review the QA results");
  assert.equal(reminderBody("Ask Ana about the reminder: it never fired"), "Ask Ana about the reminder: it never fired");
  // Exactly ONE label is removed — a deliberate double is the author's own text.
  assert.equal(reminderBody("Reminder: Reminder: standup"), "Reminder: standup");
  assert.equal(reminderBody(""), "");
  assert.equal(reminderBody(null), "");
});

test("the rendered line carries one label and no leftover colon", () => {
  const render = (prompt) => `⏰ *Reminder:* ${reminderBody(prompt) || prompt}`;
  assert.equal(render("Reminder: review the QA results"), "⏰ *Reminder:* review the QA results");
  assert.equal(render("review the QA results"), "⏰ *Reminder:* review the QA results");
  // A prompt that is ONLY the label still posts something rather than an empty message.
  assert.equal(render("Reminder:"), "⏰ *Reminder:* Reminder:");
});
