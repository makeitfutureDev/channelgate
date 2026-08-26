import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";

import { footerButtons, referencedWorkspaceFiles, reviewFileButtons } from "../src/slack/footer.js";
import { FILES_ACTION_PATTERN } from "../src/slack/file-explorer.js";

// The 📄 buttons only exist for inline-code paths that resolve to a real file inside the run cwd.
// An agent in a gated channel folder writes folder-relative paths (and pasting the host's home
// directory into Slack would leak it), so the guide has to teach the relative form, name the
// Markdown-link form as the one that fails, and carry the rule where every turn sees it (SKILL.md).
test("gateway writing guidance teaches the inline-code path form that earns review buttons", () => {
  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../src/gateway/gateway-usage/platforms/slack/writing-replies.md", import.meta.url), "utf8");
  const repos = readFileSync(new URL("../src/gateway/gateway-usage/references/git-repos.md", import.meta.url), "utf8");

  assert.match(skill, /Name every file you point at in inline code/);
  assert.match(skill, /relative to the working folder/);
  assert.match(guide, /relative to the working\nfolder/);
  assert.match(guide, /✅[^\n]*`work\/acme-sow\/ACME_SOW\.pdf`/);
  assert.match(guide, /❌ \[REPORT\.md\]\(\/csv-import\/REPORT\.md\)/);
  assert.match(guide, /needs a `\/` or a file extension to be recognized/);
  assert.match(guide, /`📄 REPORT\.md` button/);
  assert.match(guide, /Never make a local path a Markdown link/);
  // A worktree path is gone by reply time, so repo work has to report the landed file.
  assert.match(repos, /canonical checkout\*\*, not the\n`\.worktrees\/<slug>\/…` copy/);
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "gateway-review-buttons-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside.md");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "spec one.md"), "one\n");
  await writeFile(path.join(root, "docs", "spec-two.md"), "two\n");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(root, "escape.md"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { root, outside };
}

test("workspace file extraction supports encoded links, inline paths, source lines, and dedupe", async (t) => {
  const { root } = await fixture(t);
  const one = path.join(root, "docs", "spec one.md");
  const two = path.join(root, "docs", "spec-two.md");
  const content = `Review [one](${one.replaceAll(" ", "%20")}:12), \`${one}\`, and \`${two}:7:3\`.`;
  assert.deepEqual(referencedWorkspaceFiles(content, root), [
    { relative: "docs/spec one.md", name: "spec one.md" },
    { relative: "docs/spec-two.md", name: "spec-two.md" },
  ]);
});

test("workspace file extraction resolves the folder-relative form agents actually write", async (t) => {
  const { root } = await fixture(t);
  const content = "Done. `docs/spec-two.md` — see also `./docs/spec one.md` and `docs/spec-two.md:7:3`.";
  assert.deepEqual(referencedWorkspaceFiles(content, root), [
    { relative: "docs/spec-two.md", name: "spec-two.md" },
    { relative: "docs/spec one.md", name: "spec one.md" },
  ]);
});

test("a relative reference is still confined to the run cwd and to real files", async (t) => {
  const { root } = await fixture(t);
  // Traversal, the symlink that escapes the root, a directory, and a name that doesn't exist.
  const content = "`../outside.md` `escape.md` `docs` `docs/missing.md` `../../etc/passwd`";
  assert.deepEqual(referencedWorkspaceFiles(content, root), []);
});

test("ordinary inline code is not mistaken for a file reference", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "main"), "extensionless\n");
  await writeFile(path.join(root, "npm test"), "not a command\n");
  // A bare word with no separator and no extension stays prose even when a matching file exists,
  // and a URL in backticks never reaches the filesystem.
  const content = "Checked out `main`, ran `npm test`, opened `https://example.com/docs/spec.md`.";
  assert.deepEqual(referencedWorkspaceFiles(content, root), []);
});

test("workspace file extraction rejects outside, escaping, missing, malformed, and absent context", async (t) => {
  const { root, outside } = await fixture(t);
  const content = `\`${outside}\` \`${root}/escape.md\` \`${root}/missing.md\` [bad](${root}/bad%ZZ.md)`;
  assert.deepEqual(referencedWorkspaceFiles(content, root), []);
  assert.deepEqual(referencedWorkspaceFiles(content, ""), []);
  assert.deepEqual(referencedWorkspaceFiles(content, "relative/root"), []);
});

test("review buttons are requester-bound, root-relative, and capped at five", async (t) => {
  const { root } = await fixture(t);
  const refs = [];
  for (let i = 0; i < 7; i++) {
    const file = path.join(root, `file-${i}.md`);
    await writeFile(file, `${i}\n`);
    refs.push(`\`${file}\``);
  }
  const buttons = reviewFileButtons(
    { cwd: root, content: refs.join(" ") },
    { channel: "C1", threadTs: "1.2", authorId: "U1" },
  );
  assert.equal(buttons.length, 5);
  assert.deepEqual(buttons.map((button) => button.action_id), [
    "cg_channel_files_review_0",
    "cg_channel_files_review_1",
    "cg_channel_files_review_2",
    "cg_channel_files_review_3",
    "cg_channel_files_review_4",
  ]);
  assert.deepEqual(JSON.parse(buttons[0].value), { o: "open_file", c: "C1", t: "1.2", u: "U1", p: "file-0.md" });
  assert.deepEqual(reviewFileButtons({ cwd: root, content: refs[0] }, { channel: "C1" }), []);

  const footer = footerButtons(
    { cwd: root, content: refs.join(" "), sessionId: "session-1", engine: "claude" },
    { channel: "C1", threadTs: "1.2", authorId: "U1" },
  );
  const actionIds = footer.map((button) => button.action_id);
  assert.equal(new Set(actionIds).size, actionIds.length, `duplicate footer action_id: ${actionIds.join(", ")}`);
  assert.ok(footer.filter((button) => button.action_id !== "resume_cmd_modal")
    .every((button) => FILES_ACTION_PATTERN.test(button.action_id)),
  "every file control must reach the shared handler");
});
