import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createSkillUsageRecorder, skillSlugsFromText } = await import("../src/gateway/skills/usage.js");

function fixture() {
  const parent = { id: 1, slug: "package-proof", meta: { plugin: { kind: "plugin" } } };
  const inner = { id: 2, slug: "proof", meta: {} };
  const ordinary = { id: 3, slug: "ordinary", meta: {} };
  const rows = [];
  const recorder = createSkillUsageRecorder({
    lookup: (name) => ({ "package-proof": parent, "manifest-name": parent, proof: inner, ordinary })[name],
    record: (row) => rows.push(row), revisionFor: (skill) => ({ id: skill.id + 10 }),
  });
  return { recorder, rows };
}

test("native plugin skill calls attribute to the package before a same-name standalone inner skill", () => {
  const { recorder, rows } = fixture();
  recorder.onEvent({ kind: "tool_use", name: "Skill", target: "manifest-name:proof" });
  assert.deepEqual(rows.map(({ slug, skillId, revisionId, signal }) => ({ slug, skillId, revisionId, signal })),
    [{ slug: "package-proof", skillId: 1, revisionId: 11, signal: "exact" }]);
  recorder.onEvent({ kind: "tool_use", name: "Skill", target: "package-proof:other-inner" });
  assert.equal(rows.length, 1, "different bundled skills deduplicate under their package");
});

test("shared skill plugin qualification keeps bare attribution unless prefix is a catalog plugin", () => {
  const { recorder, rows } = fixture();
  recorder.onEvent({ kind: "tool_use", name: "Skill", target: "gateway-shared-skills:proof" });
  recorder.onEvent({ kind: "tool_use", name: "Skill", target: "ordinary:another" });
  assert.deepEqual(rows.map(({ slug, signal }) => ({ slug, signal })),
    [{ slug: "proof", signal: "exact" }, { slug: "another", signal: "exact" }]);
});

test("compiled and workspace package reads infer package usage without recording the inner standalone skill", () => {
  const digest = "abcdef0123456789abcdef01";
  const shapes = [
    `/artifact/plugin-packages/codex/package-proof-${digest}/package/skills/proof/SKILL.md`,
    `/artifact/plugin-packages/claude/package-proof-${digest}/package/custom/nested/SKILL.md`,
    "/project/.claude/skills/package-proof/package/skills/proof/SKILL.md",
    "/project/.agents/skills/package-proof/package/skills/proof/SKILL.md",
  ];
  for (const path of shapes) {
    assert.deepEqual(skillSlugsFromText(`cat '${path}'`), ["package-proof"]);
    const { recorder, rows } = fixture();
    recorder.onEvent({ kind: "tool_use", name: "Read", target: path });
    assert.deepEqual(rows.map(({ slug, skillId, signal }) => ({ slug, skillId, signal })),
      [{ slug: "package-proof", skillId: 1, signal: "inferred" }]);
    recorder.onEvent({ kind: "tool_use", name: "Skill", target: "manifest-name:proof" });
    assert.deepEqual(rows.map((row) => row.signal), ["inferred", "exact"], "exact upgrades inferred evidence");
  }
  assert.deepEqual(skillSlugsFromText(`cat '${shapes[0]}' && cat '/skills/ordinary/SKILL.md' '${shapes[2]}'`),
    ["package-proof", "ordinary"]);
});

test("package path attribution respects root boundaries, digest length, suffix, and safe path segments", () => {
  const valid = "plugin-packages/codex/package-proof-abcdef0123456789abcdef01/package/custom/SKILL.md";
  for (const text of [
    `my${valid}`, valid.replace("abcdef0123456789abcdef01", "abcdef"),
    `${valid}.backup`, valid.replace("/custom/", "/../custom/"),
    "/project/my.claude/skills/package-proof/package/custom/SKILL.md",
  ]) assert.deepEqual(skillSlugsFromText(text), [], text);
});
