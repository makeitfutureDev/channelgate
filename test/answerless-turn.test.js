// A turn that runs tools, spends tokens, and then ends with NO final message used to reach Slack
// as a bare "(empty response)" — no reason, no hint that the harness had aborted the turn rather
// than the model choosing silence (src/slack/progress.js finalize). These guard the replacement:
// the runner carries the CLI's own verdict (result subtype / is_error) out of the process, and
// run.js turns an answerless result into a notice that names it. Distinct from isEmptyResult,
// which is the 0-token broken-session shape the resume-heal repairs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, isAnswerlessResult, isEmptyResult, answerlessNotice } = await import("../src/gateway/run.js");

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

test("end to end: an aborted turn is delivered as the notice, not as an empty reply", async () => {
  saveSettings({ engine: "claude", codexFallback: false, composioMode: "personal" });
  await setUser("U_ANSWERLESS", { name: "Answerless", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_ANSWERLESS", { name: "answerless", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_ANSWERLESS", name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "claude", cleanMode: true, allowNetwork: false,
  });

  const result = await runMessage({
    channelId: "D_ANSWERLESS",
    authorId: "U_ANSWERLESS",
    text: "CLAUDE_STUB_ANSWERLESS",
    threadKey: "1900.900",
    origin: "slack_foreground",
    preferCold: true,
  });

  assert.equal(result.answerless, true);
  assert.equal(result.endReason, "error_during_execution");
  assert.equal(result.engineError, true);
  assert.equal(result.toolUseCount, 1);
  // The CLI's stderr tail rides the result on an answerless turn — on an exit-0 abort no error
  // path ever reads it, and it is usually the only statement of the real cause.
  assert.equal(typeof result.diagnostic, "string");
  assert.match(result.content, /without a final message/i);
  assert.match(result.content, /error_during_execution/);
  // The spend is still the run's own — the notice must not overwrite the accounting the ledger reads.
  assert.equal(result.usage.output_tokens, 120);
});
