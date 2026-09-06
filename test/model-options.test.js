import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { modelOptionsForEngine } = await import("../src/slack/app.js");

test("Slack offers Claude rolling aliases only on the Claude harness", () => {
  const claudeValues = modelOptionsForEngine("claude").map(({ value }) => value);
  const codexValues = modelOptionsForEngine("codex").map(({ value }) => value);

  assert.ok(claudeValues.includes("best"));
  assert.ok(claudeValues.includes("fable"));
  assert.ok(claudeValues.includes("sonnet[1m]"));
  assert.ok(!codexValues.some((value) => /fable/i.test(value)));
});

test("admin UI consumes server model manifests and keeps rolling aliases as its offline fallback", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const modelOptions = source.match(/const MODEL_OPTIONS = \{([\s\S]*?)\n};/)?.[1] || "";
  const claudeList = modelOptions.match(/claude:\s*\[([\s\S]*?)\n\s*\],\n\s*codex:/)?.[1] || "";
  const codexList = modelOptions.match(/codex:\s*\[([\s\S]*?)\n\s*\],/)?.[1] || "";

  assert.match(source, /m\.models \|\| \[\]/);
  assert.match(source, /MODEL_EFFORT_OPTIONS/);
  assert.match(source, /current && modelMatchesEngine\(current, eng\).*options\.push\(\[current, current\]\)/);
  assert.match(claudeList, /\["fable", "Fable"\]/);
  assert.match(claudeList, /\["best", "Best"\]/);
  assert.doesNotMatch(codexList, /fable/i);
});
