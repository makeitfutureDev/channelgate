import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canonical agent instructions require dual-engine Airtable acceptance cases", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const claude = await readFile(new URL("../CLAUDE.md", import.meta.url), "utf8");

  assert.equal(claude, agents, "CLAUDE.md must resolve to the canonical AGENTS.md");
  assert.match(agents, /Every shipped feature needs live dual-engine acceptance coverage/);
  assert.match(agents, /both Claude and Codex/);
  assert.match(agents, /ChannelGate QA/);
  assert.match(agents, /human-like prompt\/action/);
  assert.match(agents, /never substitute an agent-side account/);
});
