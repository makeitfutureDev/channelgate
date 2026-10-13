import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { applyGatewayGuide } = await import("../src/gateway/guide.js");
const { gatewayInstructionsBlock } = await import("../src/gateway/folders.js");
const { applyChannelMemory } = await import("../src/gateway/channel-memory.js");
const { buildMemoryReviewPrompt } = await import("../src/gateway/memory-review.js");

test("every surface delivers scope selection, the spam example and existing-schedule editing", async () => {
  const cwd = tempDir("cg-routing-");
  try {
    for (const platform of ["slack", "msteams", "googlechat"]) {
      await applyGatewayGuide(cwd, { platform });
      const root = path.join(cwd, ".claude/skills/gateway-usage");
      const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
      const reference = await readFile(path.join(root, "references/memory-and-rules.md"), "utf8");
      const reminders = await readFile(path.join(root, "references/reminders.md"), "utf8");
      assert.match(skill, /Classify every.*recurring request by scope/s);
      assert.match(skill, /Do not default to channel instructions/);
      assert.match(reference, /narrowest scope/);
      assert.match(reference, /relevant skill.*schedule.*Channel instructions/is);
      assert.match(reference, /never use channel instructions or memory as a fallback destination/);
      assert.match(reference, /Spam example/);
      assert.match(reference, /pending change is not saved/);
      assert.match(reminders, /expected_prompt/);
      assert.match(reminders, /Do not delete\/recreate a job/);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("both engines receive routing even without opening a skill, including Clean mode", () => {
  for (const cleanMode of [false, true]) {
    const block = gatewayInstructionsBlock({ cleanMode });
    assert.match(block, /Classify every ongoing request before saving/);
    assert.match(block, /reusable procedures → the relevant skill/);
    assert.match(block, /existing schedule instructions/);
    assert.match(block, /Never use memory or channel instructions as a/);
  }
});

test("memory skill and reduced-tool reviewer cannot turn procedural corrections into duplicate facts", async () => {
  const cwd = tempDir("cg-routing-memory-");
  try {
    await applyChannelMemory(cwd, { memory: true });
    const skill = await readFile(path.join(cwd, ".claude/skills/channel-memory/SKILL.md"), "utf8");
    assert.match(skill, /Before saving, classify ongoing requests by scope/);
    assert.match(skill, /Never rephrase a skill, schedule, or channel instruction/);
    const prompt = buildMemoryReviewPrompt({ transcript: 'Always also clean spam. This belongs in the email skill.' });
    assert.match(prompt, /procedures belong in skills/);
    assert.match(prompt, /including rules already saved or proposed elsewhere/);
    assert.match(prompt, /reviewer can only save facts/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
