import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public contributor instructions retain dual-engine evidence without private account requirements", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const claude = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");

  assert.equal(claude, agents, "CLAUDE.md must resolve to the canonical AGENTS.md");
  assert.match(agents, /Behavior changes need acceptance evidence/);
  assert.match(agents, /Claude and Codex/);
  assert.match(agents, /Contributors need\s+no private QA service access/);
  assert.match(agents, /fixtures, setup, prompt\/action, expected evidence and pass/);
  assert.match(agents, /AGENTS.local.md/);
});
