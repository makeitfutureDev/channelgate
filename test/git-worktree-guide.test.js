// One worktree per task is a rule three files have to agree on, because a run reads them in a
// fixed order and stops at the first one that seems to settle the question.
//
// The failure this guards was real: six unrelated features were built directly in a served
// checkout's working tree and left uncommitted, interleaved across the same shared files. The
// rule existed at the time — in SKILL.md, in references/git-repos.md and in that project's own
// AGENTS.md — but git-repos.md opened by handing the whole question to the project's instruction
// file, and that file mentioned worktrees only as a clause inside a paragraph about pull requests.
// A run that read both concluded the protocol did not apply and improvised in the shared tree.
//
// So the assertions here are about the SHAPE of the agreement, not the wording: the always-on
// SKILL.md rule states the prohibition (not merely the preference), and the reference hands the
// project file authority over WHICH branch while explicitly keeping the isolation itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const skillUrl = new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url);
const referenceUrl = new URL("../src/gateway/gateway-usage/references/git-repos.md", import.meta.url);
const agentsUrl = new URL("../AGENTS.md", import.meta.url);

test("the always-on rule prohibits editing the shared checkout, not just recommends a worktree", async () => {
  const skill = await readFile(skillUrl, "utf8");
  const rule = /^7\. \*\*In a git repo[^]*?`references\/git-repos\.md`\./m.exec(skill);
  assert.ok(rule, "rule 7 is still the git rule");
  const text = rule[0];
  assert.match(text, /never edit the shared checkout/i);
  assert.match(text, /concurrently/i);
  assert.match(text, /overwrite each other's uncommitted changes/i);
  // The two escape hatches that were actually used to skip it.
  assert.match(text, /"?[Ss]mall"?.*"?urgent"?.*not exemptions/is);
  assert.match(text, /AGENTS\.md can change WHICH branch.*never waives the isolation/is);
});

test("the reference gives a project authority over the branch but never over the isolation", async () => {
  const reference = await readFile(referenceUrl, "utf8");

  // What the project's own file decides.
  assert.match(reference, /Read the project's own instruction file.*first/is);
  assert.match(reference, /decides WHICH\s*\n?branch you start from and land on/is);
  assert.match(reference, /substitute the base branch/is);
  assert.match(reference, /`beta`.*`develop`.*`main` as releases only/is);

  // What it does not decide. This is the assertion whose absence caused the incident.
  assert.match(reference, /never waives is the\s+isolation itself/is);
  assert.match(reference, /one worktree per task, no edits in the shared\s+checkout/i);
  assert.match(reference, /mentions worktrees only in passing still requires them/i);

  // "Small" was the other exemption invented at the point of decision — Step 0.
  assert.match(reference, /"Small" is not an exemption/);
  assert.match(reference, /two branches even when they touch the same file/i);
});

test("this project's own instruction file carries the protocol, not a passing mention", async () => {
  const agents = await readFile(agentsUrl, "utf8");

  // A hard rule where the other invariants are read, and a section with the actual commands.
  assert.match(agents, /^- \*\*One worktree per task; never edit a shared checkout's working tree\.\*\*/m);
  assert.match(agents, /^### One worktree per task — before your first edit$/m);

  // The commands have to name THIS repo's base branch: landing development on main is its own rule
  // violation, so a protocol copied from a main-based project would be worse than none.
  const section = /^### One worktree per task[^]*?^### Beta development/m.exec(agents);
  assert.ok(section, "the section precedes the beta/promotion section");
  assert.match(section[0], /git worktree add -b <type>\/<slug> \.worktrees\/<slug> origin\/beta/);
  assert.doesNotMatch(section[0], /origin\/main/);
  assert.match(section[0], /never from `main`/);
  assert.match(section[0], /merge-base --is-ancestor/);
  assert.match(section[0], /never `rm -rf`/);
  assert.match(section[0], /uncommitted changes in the shared checkout that you did not write/i);
});
