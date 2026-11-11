import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";
ensureTestEnv();
const { saveSettings, getSettings, getAgentsInstructions, getOrgAccessGrants } = await import("../src/config/settings.js");
const { getLicenseStatus } = await import("../src/ee/license.js");
const { putSkillRevision, getSkill, excludeSkill, setSkillDiscoverable } = await import("../src/gateway/skills/catalog.js");
const { grantSkillsToOrg, revokeSkillsFromOrg } = await import("../src/gateway/skills/authoring.js");
const { createSkillsRouter } = await import("../src/web/routes/skills.js");
const denied = { code: "enterprise_required", statusCode: 403 };
const files = slug => [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Organization policy regression.\n---\nFollow the saved policy.\n` }];
for (const tier of ["free", "none"]) {
  test(`${tier}: organization policies require Enterprise but downgrade preserves protections and permits removal`, () => {
    testLicenseEnv({ tier: "enterprise" });
    putSkillRevision({ ownerKind: "local", files: files("required-policy") });
    putSkillRevision({ ownerKind: "local", files: files("new-policy") });
    saveSettings({ agentsInstructions: "Follow organization policy.", accessGrants: { skills: [] } });
    grantSkillsToOrg(["required-policy"]);
    if (tier === "none") clearTestLicense(); else testLicenseEnv({ tier });
    assert.equal(getLicenseStatus().features.mandatoryOrgSkills, false);
    assert.equal(getLicenseStatus().features.organizationInstructions, false);
    assert.equal(getAgentsInstructions(), "Follow organization policy.");
    assert.deepEqual(getOrgAccessGrants().skills, ["required-policy"]);
    // Raw settings writes, mixed patches, and the authoring API cannot bypass licensing.
    assert.throws(() => saveSettings({ agentsInstructions: "Changed policy.", agentMemory: false }), denied);
    assert.notEqual(getSettings().agentMemory, false);
    assert.throws(() => saveSettings({ accessGrants: { skills: ["new-policy"] } }), denied);
    assert.throws(() => grantSkillsToOrg(["new-policy"]), denied);
    saveSettings({ agentsInstructions: "Follow organization policy.", accessGrants: { skills: ["required-policy"], mcps: ["free-connector"] } });
    assert.deepEqual(grantSkillsToOrg(["required-policy"]).added, []);
    revokeSkillsFromOrg(["required-policy"]);
    saveSettings({ agentsInstructions: "" });
    assert.equal(getAgentsInstructions(), "");
    assert.deepEqual(getOrgAccessGrants().skills, []);
    assert.throws(() => grantSkillsToOrg(["required-policy"]), denied);
    testLicenseEnv({ tier: "enterprise" });
    grantSkillsToOrg(["required-policy"]);
    saveSettings({ agentsInstructions: "Restored policy." });
    assert.equal(getAgentsInstructions(), "Restored policy.");
  });
}

test("Free governance HTTP request rejects before enabling or changing discoverability", async () => {
  testLicenseEnv({ tier: "enterprise" });
  putSkillRevision({ ownerKind: "local", files: files("atomic-policy") });
  excludeSkill("atomic-policy");
  setSkillDiscoverable("atomic-policy", false);
  testLicenseEnv({ tier: "free" });
  const app = express(); app.use(express.json()); app.use(createSkillsRouter());
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/skills/catalog/atomic-policy/governance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, discoverable: true, mandatory: true }),
    });
    assert.equal(response.status, 403);
    assert.equal(getSkill("atomic-policy").deleted, true);
    assert.equal(getSkill("atomic-policy").discoverable, false);
    const contradictory = await fetch(`http://127.0.0.1:${server.address().port}/skills/catalog/required-policy/governance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, mandatory: true }),
    });
    assert.equal(contradictory.status, 400);
    assert.ok(getOrgAccessGrants().skills.includes("required-policy"));
    assert.equal(getSkill("required-policy").deleted, false);
  } finally { await new Promise(resolve => server.close(resolve)); testLicenseEnv({ tier: "enterprise" }); }
});


test("Free MCP governance and org grants reject without partial catalog changes", async () => {
  const { register } = await import("../src/mcp/tools/skills.js");
  const handlers = new Map();
  register({ registerTool: (name, _definition, handler) => handlers.set(name, handler) }, {
    channelId: "C_POLICY", slug: "policy", createdBy: "U_POLICY",
    text: text => ({ content: [{ type: "text", text }] }), requireAdmin: async () => true,
  });
  testLicenseEnv({ tier: "free" });
  await assert.rejects(handlers.get("set_skill_governance")({ skill: "atomic-policy", mandatory: true, enabled: true, discoverable: true }), denied);
  assert.equal(getSkill("atomic-policy").deleted, true);
  assert.equal(getSkill("atomic-policy").discoverable, false);
  await assert.rejects(handlers.get("add_org_skills")({ slugs: ["new-policy"] }), denied);
  await assert.rejects(handlers.get("set_skill_governance")({ skill: "required-policy", enabled: false, mandatory: true }), { status: 400 });
  assert.ok(getOrgAccessGrants().skills.includes("required-policy"));
  assert.equal(getSkill("required-policy").deleted, false);
  testLicenseEnv({ tier: "enterprise" });
});
