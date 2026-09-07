import test from "node:test";
import assert from "node:assert/strict";
import { filterSkillCatalog } from "../public/skills-catalog-filters.js";

const skills = [
  { slug: "ordinary", enabled: true, discoverable: true, mandatory: false },
  { slug: "mandatory-one", enabled: true, discoverable: true, mandatory: true },
  { slug: "hidden", enabled: true, discoverable: false, mandatory: false },
  { slug: "disabled", enabled: false, discoverable: true, mandatory: false },
  { slug: "template-skill", enabled: true, discoverable: true, mandatory: false },
  { slug: "section-skill", enabled: true, discoverable: true, mandatory: false },
  { slug: "dependency-only", enabled: true, discoverable: true, mandatory: false },
];

const context = {
  overview: {
    orgSkills: ["mandatory-one"],
    templates: [{ slug: "development", resolved: ["template-skill"] }],
  },
  profiles: [{
    own: ["ordinary"],
    section: ["section-skill"],
    skillTemplate: "development",
    skills: ["ordinary", "template-skill", "section-skill", "dependency-only"],
  }],
};

const slugs = (filters) => filterSkillCatalog(skills, {
  enabled: "all",
  discoverable: "all",
  mandatory: "all",
  assigned: "all",
  ...filters,
}, context).map((skill) => skill.slug);

test("Mandatory selected removes every non-mandatory row", () => {
  assert.deepEqual(slugs({ mandatory: "1" }), ["mandatory-one"]);
  assert.ok(!slugs({ mandatory: "0" }).includes("mandatory-one"));
});

test("enabled and discoverable filters enforce both positive and negative states", () => {
  assert.deepEqual(slugs({ enabled: "0" }), ["disabled"]);
  assert.deepEqual(slugs({ discoverable: "0" }), ["hidden"]);
  assert.ok(!slugs({ enabled: "1" }).includes("disabled"));
  assert.ok(!slugs({ discoverable: "1" }).includes("hidden"));
});

test("Assigned means direct grants, templates and channel sections, not dependencies", () => {
  assert.deepEqual(slugs({ assigned: "1" }), ["ordinary", "mandatory-one", "template-skill", "section-skill"]);
  assert.ok(slugs({ assigned: "0" }).includes("dependency-only"));
});

test("source and category compose with governance and preserve unfiltered defaults", () => {
  const rows = [
    { slug: "a", sourceId: 1, category: "Sales", enabled: true, mandatory: true },
    { slug: "b", sourceId: 2, category: "Sales", enabled: true, mandatory: true },
    { slug: "c", sourceId: 1, category: "Development", enabled: false, mandatory: false },
  ];
  assert.equal(filterSkillCatalog(rows).length, 3);
  assert.deepEqual(filterSkillCatalog(rows, { source: "1", category: "Sales", mandatory: "1" }).map((s) => s.slug), ["a"]);
  assert.deepEqual(filterSkillCatalog(rows, { source: "1", enabled: "0" }).map((s) => s.slug), ["c"]);
});
