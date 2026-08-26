import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { modelOptionsForEngine } = await import("../src/slack/app.js");

test("Slack offers Fable 5 only as a Claude model", () => {
  const claudeValues = modelOptionsForEngine("claude").map(({ value }) => value);
  const codexValues = modelOptionsForEngine("codex").map(({ value }) => value);

  assert.ok(claudeValues.includes("claude-fable-5"));
  assert.ok(!codexValues.some((value) => /fable/i.test(value)));
});

test("admin UI offers Fable 5 only in its Claude model list", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const modelOptions = source.match(/const MODEL_OPTIONS = \{([\s\S]*?)\n};/)?.[1] || "";
  const claudeList = modelOptions.match(/claude:\s*\[([\s\S]*?)\n\s*\],\n\s*codex:/)?.[1] || "";
  const codexList = modelOptions.match(/codex:\s*\[([\s\S]*?)\n\s*\],/)?.[1] || "";

  assert.match(claudeList, /\["claude-fable-5", "Fable 5"\]/);
  assert.doesNotMatch(codexList, /fable/i);
});
