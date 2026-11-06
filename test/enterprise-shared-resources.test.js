import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";

ensureTestEnv();
const { getSettings, saveSettings, applyChannelTemplate } = await import("../src/config/settings.js");
const { patchOrgEnv, getOrgEnv, listOrgEnv, resolveRunEnv, patchSecretEntry } = await import("../src/config/scoped-env.js");
const { placeholderFor, resolveEgressGrant, resolveEgressRunEnv, codexRelayPlaceholderFor } = await import("../src/gateway/egress/grants.js");
const { putSkillRevision, upsertTemplate, getTemplate, resolveTemplateSkills } = await import("../src/gateway/skills/catalog.js");
const { channelSkillGrants, templateOfMeta, assignTemplateToChannel } = await import("../src/gateway/skills/templates.js");
const { addSkillsToTemplate, removeSkillsFromTemplate } = await import("../src/gateway/skills/authoring.js");
const { resolveSyncConfig, syncAllNow, syncChannelNow, testChannelSync, __confinedRcloneLaunch } = await import("../src/gateway/drivesync.js");
const { saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { createSkillsRouter } = await import("../src/web/routes/skills.js");
const denied = { code: "enterprise_required", statusCode: 403 };

function license(tier) {
  if (tier === "none") clearTestLicense();
  else testLicenseEnv({ tier });
}

for (const tier of ["free", "none"]) {
  test(`${tier}: retained organization variables cannot reach runs or cached proxy grants`, async () => {
    license("enterprise");
    patchOrgEnv({ set: { name: "ORG_TEST_TOKEN", value: "organization-secret-123456", hosts: ["api.example.com"], exposure: "hidden" } });
    const placeholder = placeholderFor({ scope: "organization", secretName: "ORG_TEST_TOKEN" });
    assert.ok(await resolveEgressGrant(placeholder), "populate the live proxy material cache before downgrade");
    license(tier);
    assert.ok(getOrgEnv().ORG_TEST_TOKEN, "preserve the stored entry");
    assert.ok(listOrgEnv().some(row => row.name === "ORG_TEST_TOKEN"), "masked settings stay inspectable");
    assert.equal(await resolveEgressGrant(placeholder), null, "cached grants stop immediately");
    const resolved = await resolveRunEnv({ meta: { env: { CHANNEL_TEST: { value: "channel-value-123456", provider: "local" } } } });
    assert.equal(resolved.env.ORG_TEST_TOKEN, undefined);
    assert.equal(resolved.env.CHANNEL_TEST, "channel-value-123456");
    assert.throws(() => patchOrgEnv({ set: { name: "OTHER_ORG", value: "blocked-org-value-123456" } }), denied);
    await assert.rejects(patchSecretEntry({ scope: "organization", name: "ORG_TEST_TOKEN", exposure: "readable" }), denied);
    license("enterprise");
    assert.ok(await resolveEgressGrant(placeholder), "upgrade restores existing saved configuration");
    license(tier);
    patchOrgEnv({ remove: "ORG_TEST_TOKEN" });
    assert.equal(getOrgEnv().ORG_TEST_TOKEN, undefined, "downgraded deployments can remove retained variables");
    license("enterprise");
  });

  test(`${tier}: skill template assignment is retained without granting its skills`, async () => {
    license("enterprise");
    putSkillRevision({ ownerKind: "local", files: [{ path: "SKILL.md", content: "---\nname: enterprise-template-only\ndescription: Template test skill.\n---\nUse this for tests.\n" }] });
    const template = upsertTemplate({ slug: "enterprise-test", name: "Enterprise test", skills: ["enterprise-template-only"] });
    const meta = { skillTemplate: template.slug, skills: ["direct-free-skill"] };
    assert.deepEqual(channelSkillGrants(meta), ["enterprise-template-only", "direct-free-skill"]);
    license(tier);
    assert.equal(templateOfMeta(meta), null);
    assert.deepEqual(channelSkillGrants(meta), ["direct-free-skill"]);
    assert.equal(resolveTemplateSkills(getTemplate(template.slug)).skills[0].slug, "enterprise-template-only", "stored catalog remains readable while runtime grants are inactive");
    assert.equal(getTemplate(template.slug).skills[0], "enterprise-template-only");
    await assert.rejects(assignTemplateToChannel("unused", template.slug), denied);
    assert.throws(() => addSkillsToTemplate(template.slug, ["enterprise-template-only"]), denied);
    assert.equal(removeSkillsFromTemplate(template.slug, ["enterprise-template-only"]).removed.length, 1, "allow cleanup on downgrade");
    license("enterprise");
    addSkillsToTemplate(template.slug, ["enterprise-template-only"]);
    assert.deepEqual(channelSkillGrants(meta), ["enterprise-template-only", "direct-free-skill"]);
  });

  test(`${tier}: Drive sync refuses manual/test/launch paths before any process or credential work`, async () => {
    license("enterprise");
    saveSettings({ driveSyncEnabled: true, driveSyncKeyJson: "retained-drive-key" });
    license(tier);
    assert.equal(resolveSyncConfig().code, "enterprise_required");
    await assert.rejects(syncAllNow(), denied);
    await assert.rejects(syncChannelNow("unused"), denied);
    await assert.rejects(testChannelSync({ syncDriveFolder: "test-folder" }), denied);
    await assert.rejects(__confinedRcloneLaunch({}), denied);
    assert.equal(getSettings().driveSyncEnabled, true);
    assert.equal(getSettings().driveSyncKeyJson, "retained-drive-key");
    license("enterprise");
    saveSettings({ driveSyncEnabled: false, driveSyncKeyJson: "" });
  });
}

test("Free template API mutations reject with 403 while existing catalog data stays readable", async () => {
  license("free");
  const app = express();
  app.use(express.json());
  app.use(createSkillsRouter());
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${url}/skills/templates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Blocked template" }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "enterprise_required");
    const read = await fetch(`${url}/skills/templates`);
    assert.equal(read.status, 200);
    assert.ok((await read.json()).templates.some(template => template.slug === "enterprise-test"));
  } finally {
    await new Promise(resolve => server.close(resolve));
    license("enterprise");
  }
});


test("cached dedicated Codex relay pauses on downgrade and resumes without deleting the saved login", async () => {
  license("enterprise");
  const placeholder = codexRelayPlaceholderFor({ channelId: "C_ENT_CODEX_CACHE" });
  const deps = { metaFor: async () => ({ codexAuthSource: "channel", channelId: "C_ENT_CODEX_CACHE" }), codexRelayToken: async () => ({ token: "fake-codex-relay-token", source: "chatgpt" }) };
  assert.ok(await resolveEgressGrant(placeholder, deps));
  license("free");
  assert.equal(await resolveEgressGrant(placeholder, deps), null, "cached token cannot bypass current entitlement");
  license("enterprise");
  assert.ok(await resolveEgressGrant(placeholder, deps));
});


test("downgraded whole-record saves retain unchanged Drive/template setup and allow explicit cleanup", async () => {
  license("enterprise");
  const saved = { channelId: "C_SHARED_PRESERVE", skillTemplate: "enterprise-test", syncDriveFolder: "https://drive.google.com/drive/folders/12345678901234567890" };
  await saveChannelMeta("shared-entitlement-setup", saved);
  license("free");
  await saveChannelMeta("shared-entitlement-setup", { ...saved, model: "sonnet" });
  assert.equal((await getChannelMeta("shared-entitlement-setup")).skillTemplate, saved.skillTemplate);
  await assert.rejects(saveChannelMeta("shared-entitlement-setup", { ...saved, skillTemplate: "other" }), denied);
  await assert.rejects(saveChannelMeta("shared-entitlement-setup", { ...saved, syncDriveFolder: "https://drive.google.com/drive/folders/other-folder" }), denied);
  await saveChannelMeta("shared-entitlement-setup", { ...saved, skillTemplate: "", syncDriveFolder: "" });
  assert.equal((await getChannelMeta("shared-entitlement-setup")).skillTemplate, "");
  assert.equal((await getChannelMeta("shared-entitlement-setup")).syncDriveFolder, "");
  license("enterprise");
});


test("a saved Enterprise channel default cannot block ordinary Free channel creation", async () => {
  license("enterprise");
  const original = getSettings().channelTemplate;
  saveSettings({ channelTemplate: { skillTemplate: "enterprise-test", skills: ["ordinary-direct-skill"], allowBash: true } });
  try {
    license("free");
    const initial = applyChannelTemplate(defaultChannelMeta({ channelId: "C_FREE_NEW_DEFAULT", name: "Free registration", isDM: false }));
    assert.equal(initial.skillTemplate, "");
    assert.deepEqual(initial.skills, ["ordinary-direct-skill"]);
    assert.equal(initial.allowBash, true);
    await saveChannelMeta("free-new-default", initial);
    assert.equal((await getChannelMeta("free-new-default")).skillTemplate, "");
    assert.equal(getSettings().channelTemplate.skillTemplate, "enterprise-test", "saved Enterprise default retained");
    license("enterprise");
    assert.equal(applyChannelTemplate(defaultChannelMeta({ channelId: "C_ENT_NEW_DEFAULT", name: "Enterprise registration", isDM: false })).skillTemplate, "enterprise-test");
  } finally {
    license("enterprise");
    saveSettings({ channelTemplate: original || {} });
  }
});
