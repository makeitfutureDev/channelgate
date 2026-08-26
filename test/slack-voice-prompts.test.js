import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The turn path lives in slack/message-pipeline.js; slack/app.js keeps the Bolt wiring
// (reaction handler and the processMessageEvent call sites).
const source = readFileSync(new URL("../src/slack/message-pipeline.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");

test("robot-face reactions reuse message files and explicitly bypass the mention gate", () => {
  assert.match(appSource, /const synthetic = \{[\s\S]*user: event\.user[\s\S]*files: msg\.files[\s\S]*\};/);
  assert.match(appSource, /processMessageEvent\(synthetic, client, \{ botUserId, teamId, bypassMention: true \}\)/);
});

test("audio prompt composition occurs before durable active-run persistence", () => {
  assert.match(source, /const audio = files\.filter\(isAudioFile\)[\s\S]*resolveAudioTranscripts\([\s\S]*composeVoicePrompt\([\s\S]*recordActiveRun\(runId/);
  assert.match(source, /const ordinaryFiles = files\.filter\(\(file\) => !isAudioFile\(file\)\)/);
});

test("voice-only transcription failure exits before starting an engine", () => {
  assert.match(source, /if \(!voice\.transcripts\.length && !prompt\.trim\(\)\) \{[\s\S]*chat\.postMessage[\s\S]*return;/);
  assert.match(source, /Generate transcript/);
  assert.match(source, /react 🤖/);
});

test("runtime setting drives local-first resolution and raw audio is not an engine attachment", () => {
  assert.match(source, /localEnabled: getWhisperEnabled\(\)/);
  assert.match(source, /downloadLocal: async \(file\) =>/);
  assert.match(source, /attachmentPaths = ordinary\.map\(\(s\) => s\.path\)/);
  assert.doesNotMatch(source, /attachmentPaths\s*=\s*audio/);
});
