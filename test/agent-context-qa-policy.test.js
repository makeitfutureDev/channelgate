import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public contributor instructions retain dual-engine evidence without private account requirements", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  // AGENTS.md is the one tracked guide; CLAUDE.md and AGENTS.override.md are per-deployment entry
  // points (the gateway assembles them), and the private rules file is never committed.
  for (const entry of ["/CLAUDE.md", "/AGENTS.override.md", "/AGENTS.local.md", "/CLAUDE.local.md"]) {
    assert.ok(gitignore.split("\n").includes(entry), `.gitignore lists ${entry}`);
  }
  assert.match(agents, /ln -s AGENTS\.md CLAUDE\.md/, "a local Claude Code session is told how to load the guide");
  assert.match(agents, /when that file\s+exists, read it before starting any task/, "AGENTS.local.md is read by both engines");
  assert.match(agents, /Behavior changes need acceptance evidence/);
  assert.match(agents, /Claude and Codex/);
  assert.match(agents, /Contributors need\s+no private QA service access/);
  assert.match(agents, /fixtures, setup, prompt\/action, expected evidence and pass/);
  assert.match(agents, /AGENTS.local.md/);
});
