import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureTestEnv, testLicenseEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { getLicenseStatus } = await import("../src/ee/license.js");
const { saveSettings } = await import("../src/config/settings.js");
const { defaultChannelMeta, saveChannelMeta, getChannelMeta, setUser, getUser } = await import("../src/config/store.js");
const { decideSkillSwap, setSkillModelFrontmatter, withSkillRuntimeHeader } = await import("../src/gateway/skill-runtime.js");
const { getThreadSkillModel, setThreadSkillModel } = await import("../src/gateway/thread-engine.js");
const { autoApproveUser, getAutoApprovalPolicy } = await import("../src/gateway/user-auto-approval.js");
const { codexLoginCandidatesFor } = await import("../src/gateway/channel-codex-auth.js");
const { startChannelCodexLogin } = await import("../src/gateway/channel-codex-login.js");
const { listEngineMcps, listCodexRuntimeMcps } = await import("../src/gateway/mcp-discovery.js");
const { runCodex } = await import("../src/engines/codex.js");
const { createAccessToken, createUserAccessToken, verifyAccessToken, revokeAccessToken } = await import("../src/gateway/skills/tokens.js");
const { skillsMcpAuthGate, skillsMcpHandler } = await import("../src/web/skills-mcp.js");
const enterpriseDenied = error => error.status === 403 && error.code === "enterprise_required";
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("selected controls stop using saved Enterprise configuration after downgrade and resume after upgrade", async () => {
  testLicenseEnv();
  const skill = { slug: "model-skill", meta: { model: "sonnet" } };
  const swap = { skill, meta: { skillRuntimeSwap: true }, engine: "claude", model: "opus" };
  const channel = { ...defaultChannelMeta("D_ENTERPRISE_CONTROLS", "Enterprise controls", true), channelId: "D_ENTERPRISE_CONTROLS", skillRuntimeSwap: true, codexAuthSource: "channel", engine: "codex" };
  await saveChannelMeta("enterprise-controls", channel);
  await setThreadSkillModel("enterprise-controls", "thread", "sonnet");
  saveSettings({ userAutoApprovalEnabled: true, userAutoApprovalDomains: ["example.com"] });
  await setUser("U_ENT_DOMAIN", { name: "Member", approved: false });
  const token = createAccessToken({ name: "Catalog" });
  assert.equal(verifyAccessToken(token.token).id, token.record.id);
  assert.equal(decideSkillSwap(swap).action, "inline");
  assert.match(codexLoginCandidatesFor(channel)[0], /auth\.json$/);

  try {
    testLicenseEnv({ tier: "free" });
    assert.equal(getLicenseStatus().features.skillModelRouting, false);
    assert.equal(decideSkillSwap(swap).reason, "enterprise-required");
    assert.equal(await getThreadSkillModel("enterprise-controls", "thread"), "");
    await assert.rejects(setThreadSkillModel("enterprise-controls", "new", "sonnet"), enterpriseDenied);
    assert.throws(() => setSkillModelFrontmatter("# Skill", "sonnet"), enterpriseDenied);
    assert.doesNotThrow(() => setSkillModelFrontmatter("---\nmodel: sonnet\n---\n", ""));
    const bundle = { files: [{ path: "SKILL.md", content: "---\nmodel: sonnet\n---\n# Skill" }] };
    assert.doesNotMatch(withSkillRuntimeHeader(skill, bundle).files[0].content.toString("utf8"), /^model:/m);
    assert.equal(getAutoApprovalPolicy().enabled, false);
    assert.equal(await autoApproveUser("U_ENT_DOMAIN", "member@example.com", "slack"), false);
    assert.equal((await getUser("U_ENT_DOMAIN")).approved, false);
    saveSettings({ userAutoApprovalEnabled: false });
    assert.throws(() => saveSettings({ userAutoApprovalEnabled: true }), enterpriseDenied);
    assert.throws(() => codexLoginCandidatesFor(channel), enterpriseDenied);
    assert.equal(codexLoginCandidatesFor({ codexAuthSource: "gateway" }), null);
    let spawned = false;
    assert.throws(() => startChannelCodexLogin(channel.channelId, "device", { spawnImpl() { spawned = true; } }), enterpriseDenied);
    assert.equal(spawned, false);
    await assert.rejects(listEngineMcps("codex", { channelId: channel.channelId }), enterpriseDenied);
    await assert.rejects(listCodexRuntimeMcps({ channelId: channel.channelId, spawnImpl() { assert.fail("must not discover dedicated apps"); } }), enterpriseDenied);
    await assert.rejects(runCodex({ target: { meta: channel, runtime: { spawn() { assert.fail("downgraded dedicated login must not spawn"); } } }, cwd: process.env.CG_WORKSPACE_DIR, prompt: "blocked" }), enterpriseDenied);
    assert.equal(verifyAccessToken(token.token), null, "existing token is inert");
    assert.throws(() => createAccessToken({ name: "Blocked" }), enterpriseDenied);
    assert.throws(() => createUserAccessToken({ ownerId: "U_ENT_DOMAIN", name: "Blocked personal token" }), enterpriseDenied);
    for (const handler of [skillsMcpAuthGate(), skillsMcpHandler()]) {
      const res = response();
      await handler({ headers: { authorization: `Bearer ${token.token}` }, skillsToken: token.record }, res, () => assert.fail("endpoint must not continue"));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, "enterprise_required");
    }
    // Config remains removable on a downgraded installation.
    await saveChannelMeta("enterprise-controls", { ...(await getChannelMeta("enterprise-controls")), skillRuntimeSwap: false, codexAuthSource: "gateway" });
    await assert.rejects(saveChannelMeta("enterprise-controls", channel), enterpriseDenied);
    for (const field of ["skillTemplate", "syncDriveFolder"]) {
      await assert.rejects(saveChannelMeta("enterprise-controls", { ...(await getChannelMeta("enterprise-controls")), [field]: "new-value" }), enterpriseDenied);
    }
    saveSettings({ userAutoApprovalEnabled: false });
    assert.equal(revokeAccessToken(token.record.id).revoked, true);

    testLicenseEnv();
    assert.equal(decideSkillSwap(swap).action, "inline");
    assert.equal(await getThreadSkillModel("enterprise-controls", "thread"), "sonnet", "saved preference is retained for reactivation");
    saveSettings({ userAutoApprovalEnabled: true });
    assert.equal(await autoApproveUser("U_ENT_DOMAIN", "member@example.com", "slack"), true);
    assert.ok(createAccessToken({ name: "Restored" }).token);
  } finally {
    testLicenseEnv();
    saveSettings({ userAutoApprovalEnabled: false });
  }
});


test("downgrade rewrites managed skill copies without native model directives or old routing headers", async () => {
  const { putSkillRevision, getSkill, skillBundle } = await import("../src/gateway/skills/catalog.js");
  const { materializeSkill } = await import("../src/gateway/skills/materialize.js");
  const name = "enterprise-materialized-model";
  const root = tempDir("cg-enterprise-model-copy-");
  const source = "---\nname: enterprise-materialized-model\ndescription: Entitlement fixture\nmodel: sonnet\n---\n# Skill\n\nKeep the authored instructions.\n";
  const nested = '---\nname: child\ndescription: Nested skill\n"model": gpt-6.1-sol\n---\n# Nested skill\n';
  testLicenseEnv();
  putSkillRevision({ ownerKind: "local", files: [{ path: "SKILL.md", content: source }, { path: "skills/child/SKILL.md", content: nested }] });
  const read = file => readFile(path.join(root, name, file), "utf8");
  try {
    assert.equal((await materializeSkill(root, name)).state, "written");
    assert.match(await read("SKILL.md"), /model: sonnet/);
    assert.match(await read("SKILL.md"), /`use_skill`/);
    testLicenseEnv({ tier: "free" });
    assert.equal((await materializeSkill(root, name)).state, "written", "same revision is repaired when entitlement changes");
    assert.doesNotMatch(await read("SKILL.md"), /model: sonnet|`use_skill`/);
    assert.match(await read("SKILL.md"), /Keep the authored instructions/);
    assert.doesNotMatch(await read("skills/child/SKILL.md"), /"model":/);
    assert.equal((await materializeSkill(root, name)).state, "unchanged");
    assert.equal(skillBundle(getSkill(name)).files.find(file => file.path === "SKILL.md").content.toString("utf8"), source, "catalog bytes remain portable and retained");
    testLicenseEnv();
    assert.equal((await materializeSkill(root, name)).state, "written");
    assert.match(await read("SKILL.md"), /model: sonnet/);
    assert.match(await read("SKILL.md"), /`use_skill`/);
    assert.match(await read("skills/child/SKILL.md"), /"model":/);
  } finally { testLicenseEnv(); }
});
