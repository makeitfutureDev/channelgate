// Clean answerless turns get an informative notice. Explicit terminal failures take the error
// path even after narration, retain accounting, and never trigger an automatic empty-session heal.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await __useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, isAnswerlessResult, isEmptyResult, answerlessNotice, assertCompletedTurn } = await import("../src/gateway/run.js");

test("isAnswerlessResult: work was done but no text came back", () => {
  const spent = { usage: { input_tokens: 900, output_tokens: 120 } };
  assert.equal(isAnswerlessResult({ content: "", ...spent }), true);
  assert.equal(isAnswerlessResult({ content: "   \n", ...spent }), true);
  // Any answer at all is an answer — even a one-word one.
  assert.equal(isAnswerlessResult({ content: "done", ...spent }), false);
});

test("isAnswerlessResult and isEmptyResult never claim the same result", () => {
  // 0 tokens + no content is the broken-session shape: the resume-heal owns it, not the notice.
  const zeroWork = { content: "", usage: { input_tokens: 0, output_tokens: 0 } };
  assert.equal(isEmptyResult(zeroWork), true);
  assert.equal(isAnswerlessResult(zeroWork), false);
  // Cached-only input still counts as work done (same rule isEmptyResult uses).
  assert.equal(isAnswerlessResult({ content: "", usage: { cache_read_input_tokens: 4000 } }), true);
});

test("answerlessNotice names the harness's own ending and how much work ran", () => {
  const text = answerlessNotice({ endReason: "error_during_execution", engineError: true, toolUseCount: 26 });
  assert.match(text, /without a final message/i);
  assert.match(text, /26 tool calls ran/);
  assert.match(text, /error_during_execution/);
  assert.match(text, /reply here to continue/i);
  assert.match(text, /⚠️/); // the harness aborted the turn — that IS a warning
  assert.doesNotMatch(text, /Last output/); // nothing on stderr → no empty quote
  // When the CLI did say something on the way out, it is quoted as its own line.
  const withStderr = answerlessNotice({ endReason: "error_during_execution", engineError: true, toolUseCount: 2, diagnostic: "API Error: 400 prompt is too long" });
  assert.match(withStderr, /Last output from the harness: `API Error: 400 prompt is too long`/);
});

test("answerlessNotice: a clean ending with no reply is stated, not alarmed about", () => {
  // The model's last act was a tool call (a posted chart, a saved file) and the CLI said success.
  const clean = answerlessNotice({ endReason: "success", toolUseCount: 1 });
  assert.match(clean, /1 tool call ran/);
  assert.doesNotMatch(clean, /⚠️/);
  assert.doesNotMatch(clean, /success/);
  assert.match(clean, /same session/i);
  // No subtype at all (an engine that doesn't report one) is not evidence of an abort either.
  assert.doesNotMatch(answerlessNotice({ toolUseCount: 0 }), /⚠️/);
  assert.match(answerlessNotice({ toolUseCount: 0 }), /no tools ran/);
});

for (const narration of [false, true]) {
  test(`end to end: aborted turn ${narration ? "with narration" : "without text"} rejects and retains spend`, async () => {
    saveSettings({ engine: "claude", codexFallback: false, composioMode: "personal" });
    const channelId = narration ? "D_PARTIAL_FAILURE" : "D_ANSWERLESS";
    await setUser("U_ANSWERLESS", { name: "Answerless", approved: true, isAdmin: false });
    const entry = await upsertChannelEntry(channelId, { name: channelId, type: "im", isDM: true });
    await saveChannelMeta(entry.slug, {
      channelId, name: entry.name, type: "im", isDM: true, template: "custom",
      engine: "claude", cleanMode: true, allowNetwork: false,
    });
    const { readUsage } = await import("../src/gateway/usage.js");
    await assert.rejects(runMessage({
      channelId, authorId: "U_ANSWERLESS",
      text: `CLAUDE_STUB_ANSWERLESS ${narration ? "CLAUDE_STUB_PARTIAL_NARRATION" : ""}`,
      threadKey: "1900.900", origin: "slack_foreground", preferCold: true,
    }), (error) => {
      assert.match(error.message, /did not finish this turn/);
      assert.equal(error.details.incompleteTurn, true);
      assert.equal(error.details.replaySafe, false);
      assert.equal(error.details.endReason, "error_during_execution");
      assert.equal(error.details.toolUseCount, 1);
      assert.equal(error.details.usage.output_tokens, 120);
      assert.equal(error.details.usageRecorded, true);
      assert.equal(error.details.partialContent, narration ? "I will verify the update next." : "");
      return true;
    });
    const rows = await readUsage({ channelId });
    assert.equal(rows.length, 1, "failed spend is banked once rather than discarded");
    assert.equal(rows[0].tokensOut, 120);
  });
}

test("terminal failure cannot qualify as an empty-session heal; intentional steering survives", () => {
  const failed = { content: "", engineError: true, endReason: "error_during_execution", usage: { input_tokens: 0, output_tokens: 0 } };
  assert.equal(isEmptyResult(failed), true);
  assert.throws(() => assertCompletedTurn(failed, "claude", "keep-this-session"), (error) => {
    assert.equal(error.details.sessionId, "keep-this-session");
    assert.equal(error.details.replaySafe, false);
    return true;
  });
  const steered = { ...failed, interrupted: true };
  assert.equal(assertCompletedTurn(steered, "claude"), steered);
  const clean = { content: "done", engineError: false };
  assert.equal(assertCompletedTurn(clean, "claude"), clean);
});

test("a resumed zero-token explicit failure is never automatically replayed", async () => {
  const channelId = "D_ZERO_FAILURE";
  const entry = await upsertChannelEntry(channelId, { name: channelId, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude", cleanMode: true, allowNetwork: false });
  const request = { channelId, authorId: "U_ANSWERLESS", threadKey: "1900.901", origin: "slack_foreground", preferCold: true };
  await runMessage({ ...request, text: "First successful turn" });
  const before = runtime.calls.spawn.length;
  await assert.rejects(runMessage({ ...request, text: "CLAUDE_STUB_ANSWERLESS CLAUDE_STUB_ZERO_FAILURE" }), (error) => {
    assert.equal(error.details.incompleteTurn, true);
    assert.equal(error.details.replaySafe, false);
    return true;
  });
  assert.equal(runtime.calls.spawn.length - before, 1, "terminal failure does not trigger the empty-resume replay");
});
