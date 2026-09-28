import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { modelOptionsForEngine } = await import("../src/slack/app.js");

test("Slack offers a short Claude list with exact versioned IDs", () => {
  const claudeValues = modelOptionsForEngine("claude").map(({ value }) => value);
  const codexValues = modelOptionsForEngine("codex").map(({ value }) => value);

  assert.deepEqual(claudeValues, ["__default__", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"]);
  assert.ok(!codexValues.some((value) => /fable/i.test(value)));
  assert.equal(modelOptionsForEngine("claude", "fable").at(-1).label, "Current: fable");
  assert.equal(modelOptionsForEngine("claude", "claude-opus-5-5").length, claudeValues.length);
});

test("admin UI consumes server model manifests and keeps exact versions as its offline fallback", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const modelOptions = source.match(/const MODEL_OPTIONS = \{([\s\S]*?)\n};/)?.[1] || "";
  const claudeList = modelOptions.match(/claude:\s*\[([\s\S]*?)\n\s*\],\n\s*codex:/)?.[1] || "";
  const codexList = modelOptions.match(/codex:\s*\[([\s\S]*?)\n\s*\],/)?.[1] || "";

  assert.match(source, /m\.models \|\| \[\]/);
  assert.match(source, /MODEL_EFFORT_OPTIONS/);
  assert.match(source, /current && modelMatchesEngine\(current, eng\).*options\.push\(\[current, current\]\)/);
  assert.match(claudeList, /\["claude-opus-5-5", "Opus 5\.5"\]/);
  assert.match(claudeList, /\["claude-fable-5-1", "Fable 5\.1"\]/);
  assert.doesNotMatch(claudeList, /\["(?:best|fable|opusplan)",/);
  assert.doesNotMatch(codexList, /fable/i);
});
