import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, getUser, upsertChannelEntry, patchChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const picker = await import("../src/gateway/skills/channel-picker.js");
const view = await import("../src/gateway/skills-view.js");
const { activityPage } = await import("../src/web/activity-page.js");

const md = (name, description) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` });

catalog.putSkillRevision({ files: [md("Deploy Helper", "ships the app to production")], ownerKind: "local", createdBy: "U_ADMIN" });
catalog.putSkillRevision({ files: [md("Release Notes", "writes the changelog")], ownerKind: "local", createdBy: "U_ADMIN" });
catalog.putSkillRevision({ files: [md("Org Policy", "always on")], ownerKind: "local", createdBy: "U_ADMIN" });
await authoring.createLocalSkill({ files: [md("Their Notes", "someone else's")], createdBy: "U_OTHER", personal: true, publish: false });
saveSettings({ accessGrants: { skills: ["org-policy"] } });
await setUser("U_ME", { name: "Me", approved: true, isAdmin: false, skills: [] });
await setUser("U_OTHER", { name: "Other", approved: true, isAdmin: false, skills: [] });

const team = await upsertChannelEntry("CSKILL1", { name: "#team", type: "channel" });
await upsertChannelEntry("CSKILL2", { name: "secret", type: "group" });
const dm = await upsertChannelEntry("DSKILL1", { name: "dm", type: "im", isDM: true });
const otherDm = await upsertChannelEntry("DSKILL2", { name: "dm2", type: "im", isDM: true });
await patchChannelMeta(team.slug, { channelId: "CSKILL1", skills: [] });
await patchChannelMeta(dm.slug, { channelId: "DSKILL1", isDM: true, dmUserId: "U_ME", template: "custom", skills: [] });
await patchChannelMeta(otherDm.slug, { channelId: "DSKILL2", isDM: true, dmUserId: "U_OTHER" });
const allowed = new Set(["CSKILL1", "DSKILL1", "DSKILL2"]);
const access = { user: { isAdmin: false }, allows: async (e) => allowed.has(e.channelId) };

test("the picker lists Only me, the viewer's own DM and only the channels they can access", async () => {
  const channels = await view.skillChannels(access, "U_ME");
  assert.deepEqual(channels.map((c) => c.channelId), ["me", "DSKILL1", "CSKILL1"]);
  assert.equal(channels[1].name, "Your direct messages");
  assert.equal(channels[2].name, "#team");
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "CSKILL2", ["deploy-helper"]), { status: 403 });
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "DSKILL2", ["deploy-helper"]), { status: 403 });
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "bogus id", []), { status: 403 });
});

test("a channel's rows: organization skills locked on, personal skills never offered, saves add and remove", async () => {
  const entry = { ...team, channelId: "CSKILL1" };
  let data = await view.channelSkillsView(access, "U_ME", entry);
  const keys = data.skills.map((s) => s.key);
  assert.ok(keys.includes("deploy-helper") && keys.includes("release-notes"));
  assert.equal(keys.includes("their-notes"), false);
  const org = data.skills.find((s) => s.key === "org-policy");
  assert.deepEqual([org.selected, org.locked, org.source], [true, true, "organization"]);

  const saved = await view.saveSkillSelection(access, "U_ME", "CSKILL1", ["Deploy-Helper", "org-policy"]);
  assert.deepEqual(saved.added, ["Deploy-Helper"]);
  assert.deepEqual((await getChannelMeta(team.slug)).skills, ["deploy-helper"]); // locked org row is not copied in
  data = await view.channelSkillsView(access, "U_ME", entry);
  assert.deepEqual(data.skills.filter((s) => s.selected && !s.locked).map((s) => s.key), ["deploy-helper"]);
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "CSKILL1", ["deploy-helper", "their-notes"]), (e) => e.userFacing && /no longer available/.test(e.message));
  assert.deepEqual((await getChannelMeta(team.slug)).skills, ["deploy-helper"]); // refused before any write
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "CSKILL1", "deploy-helper"), /Choose skills/);
  assert.deepEqual((await view.saveSkillSelection(access, "U_ME", "CSKILL1", [])).removed, ["deploy-helper"]);
  assert.deepEqual((await getChannelMeta(team.slug)).skills, []);
});

test("Only me edits the viewer's personal tier", async () => {
  const before = await view.personalSkillsView("U_ME", false);
  assert.equal(before.kind, "personal");
  await view.saveSkillSelection(access, "U_ME", "me", ["release-notes"]);
  assert.deepEqual((await getUser("U_ME")).skills, ["release-notes"]);
  await assert.rejects(view.saveSkillSelection(access, "U_ME", "me", ["their-notes"]), (e) => e.userFacing && /not available to you/.test(e.message));
  await view.saveSkillSelection(access, "U_ME", "me", []);
  assert.deepEqual((await getUser("U_ME")).skills, []);
});

test("a template-managed DM is detached to its own copy on the first skill change", async () => {
  saveSettings({ dmTemplates: { user: { skills: ["release-notes"] } } });
  await patchChannelMeta(dm.slug, { template: "user", skills: [] });
  const data = await view.channelSkillsView(access, "U_ME", { ...dm, channelId: "DSKILL1" });
  assert.equal(data.dmTemplate, true);
  // A save with no change leaves the DM on the template.
  const shown = data.skills.filter((s) => s.selected && !s.locked).map((s) => s.key);
  await view.saveSkillSelection(access, "U_ME", "DSKILL1", shown);
  assert.equal((await getChannelMeta(dm.slug)).template, "user");
  await view.saveSkillSelection(access, "U_ME", "DSKILL1", [...shown, "deploy-helper"]);
  const after = await getChannelMeta(dm.slug);
  assert.equal(after.template, "custom");
  assert.deepEqual(after.skills.map((s) => s.toLowerCase()).sort(), [...shown, "deploy-helper"].sort());
});

test("requests waiting for an admin show to every member of the conversation they were filed in", async () => {
  const entry = { ...team, channelId: "CSKILL1" };
  assert.deepEqual((await view.channelSkillsView(access, "U_ME", entry)).pending, []);
  const { proposal } = authoring.proposeSkillChange({ skill: "org-policy", kind: "change", files: [md("Org Policy", "stricter")], note: "Tighten the wording", proposedBy: "U_OTHER", channelSlug: team.slug });
  const mine = authoring.proposeSkillChange({ skill: "release-notes", kind: "delete", note: "Unused", proposedBy: "U_ME", channelSlug: dm.slug }).proposal;
  // Another member's request is visible to the viewer, without the proposed files.
  const pending = (await view.channelSkillsView(access, "U_ME", entry)).pending;
  assert.deepEqual(pending.map((p) => [p.id, p.skill, p.kind, p.by, p.note]), [[proposal.id, "Org Policy", "change", "Other", "Tighten the wording"]]);
  assert.equal(pending[0].action, "Edit an organization skill");
  assert.equal("files" in pending[0], false);
  // "Only me" lists the viewer's own requests wherever they were filed; the picker counts both.
  assert.deepEqual((await view.personalSkillsView("U_ME", false)).pending.map((p) => p.id), [mine.id]);
  const channels = await view.skillChannels(access, "U_ME");
  assert.deepEqual(channels.map((c) => [c.channelId, c.pending]), [["me", 1], ["DSKILL1", 1], ["CSKILL1", 1]]);
  // A decided request leaves the list.
  await authoring.decideSkillProposal(proposal.id, { decision: "reject", decidedBy: "U_ADMIN" });
  assert.deepEqual((await view.channelSkillsView(access, "U_ME", entry)).pending, []);
  await authoring.decideSkillProposal(mine.id, { decision: "reject", decidedBy: "U_ADMIN" });
});

test("selection diff is case-insensitive", () => {
  assert.deepEqual(picker.skillSelectionDiff(["A", "b"], ["a", "C"]), { added: ["C"], removed: ["b"] });
});

test("the dashboard renders a Skills tab and page; Settings points to it", () => {
  const page = activityPage({ sessionId: "s", csrf: "c", view: "skills" });
  assert.match(page.html, /<title>Skills · ChannelGate/);
  assert.match(page.html, /id="skills-channel"/);
  assert.match(page.html, /id="skills-search"/);
  assert.match(page.html, /id="skills-pending"[^>]* hidden/);
  assert.match(page.html, /\/skills" aria-current="page">Skills</);
  assert.match(activityPage({ sessionId: "s", csrf: "c" }).html, />Skills<\/a>/);
  assert.match(activityPage({ sessionId: "s", csrf: "c", view: "settings" }).html, /Open the Skills page/);
});
