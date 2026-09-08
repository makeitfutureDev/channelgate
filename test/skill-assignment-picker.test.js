import test from "node:test";
import assert from "node:assert/strict";
import { assignmentGroups } from "../public/skill-assignment-picker.js";

const skill = (slug, extra = {}) => ({ slug, name: slug, enabled: true, currentRevisionId: 1, ...extra });

test("inherited assignments appear once and never become removable or addable", () => {
  const selected = ["template", "own", "offline"];
  const result = assignmentGroups({
    skills: [skill("org"), skill("template"), skill("own"), skill("next")], selected,
    inherited: [{ id: "org", slugs: ["org"] }, { id: "template", slugs: ["ORG", "template"] }],
  });
  assert.deepEqual(result.groups.map((g) => g.skills.map((s) => s.slug)), [["org"], ["template"]]);
  assert.ok(result.groups.every((g) => g.locked));
  assert.deepEqual(result.own.map((s) => s.slug), ["offline", "own"]);
  assert.equal(result.own[0].unavailable, true);
  assert.deepEqual(result.available.map((s) => s.slug), ["next"]);
  assert.deepEqual(selected, ["template", "own", "offline"], "display deduplication never rewrites explicit grants");
  const switched = assignmentGroups({ skills: [skill("template"), skill("own")], selected });
  assert.ok(switched.own.some((s) => s.slug === "template"), "existing explicit overlap survives template removal");
});

test("personal, disabled and unapproved catalog entries cannot be newly selected", () => {
  const skills = [skill("personal", { visibility: "personal" }), skill("disabled", { enabled: false }), skill("deleted", { deleted: true }), skill("staged", { currentRevisionId: null }), skill("pinned", { currentRevisionId: null, pinnedRevisionId: 2 }), skill("normal")];
  const result = assignmentGroups({ skills, selected: ["disabled", "missing"] });
  assert.deepEqual(result.available.map((s) => s.slug), ["normal", "pinned"]);
  assert.deepEqual(result.own.map((s) => s.slug), ["disabled", "missing"], "unavailable saved grants remain removable");
});
