// Skill templates as LIVE assignments (docs/SKILLS.md, "Templates"): a conversation follows one
// template and adds its own skills on top; the channel tier is template + additions; editing the
// template reaches every follower; the admin API validates assignments; DM templates carry one.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const catalog = await import("../src/gateway/skills/catalog.js");
const templates = await import("../src/gateway/skills/templates.js");
const { resolveAccessGrants } = await import("../src/gateway/access-grants.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { effectiveMeta } = await import("../src/gateway/run.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const md = (name, description, extra = "") => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n` });

catalog.putSkillRevision({ files: [md("Sales Play", "sales", "category: Sales\nrequires: [crm-base]\n")], ownerKind: "local" });
catalog.putSkillRevision({ files: [md("CRM Base", "crm", "category: Internal\n")], ownerKind: "local" });
catalog.putSkillRevision({ files: [md("Outreach", "outreach", "category: Sales\n")], ownerKind: "local" });
catalog.putSkillRevision({ files: [md("Extra Tool", "an addition")], ownerKind: "local" });
templates.seedBuiltinTemplates();

const entry = await upsertChannelEntry("C_TPL_ASSIGN", { name: "tpl-assign", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: "C_TPL_ASSIGN", name: "tpl-assign", type: "channel", isDM: false }), skills: ["extra-tool"] });

const app = express();
app.use(express.json());
app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
async function request(p, { method = "GET", body } = {}) {
  const response = await fetch(base + p, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test("the channel tier is the assigned template's current skills plus the conversation's own additions", async () => {
  const meta = await getChannelMeta(entry.slug);
  assert.deepEqual(templates.channelSkillGrants(meta), ["extra-tool"], "no template: only the additions");
  const assigned = await templates.assignTemplateToChannel(entry.slug, "Sales");
  assert.equal(assigned.skillTemplate, "sales");
  assert.ok(assigned.add.includes("sales-play") && assigned.add.includes("outreach") && assigned.add.includes("crm-base"), "template skills and their dependencies gained");
  assert.deepEqual(assigned.keep, ["extra-tool"], "the addition stays");
  const after = await getChannelMeta(entry.slug);
  assert.equal(after.skillTemplate, "sales");
  assert.deepEqual(after.skills, ["extra-tool"], "additions are stored separately from the template");
  const tier = templates.channelSkillGrants(after);
  assert.deepEqual(tier.sort(), ["extra-tool", "outreach", "sales-play"]);
  // The grant union sees the full tier through withTemplateSkills.
  const grants = resolveAccessGrants({ organization: { skills: ["org-only"] }, channel: templates.withTemplateSkills(after) });
  assert.deepEqual(grants.skills.sort(), ["extra-tool", "org-only", "outreach", "sales-play"]);

  // Editing the template reaches the follower without touching the conversation.
  catalog.putSkillRevision({ files: [md("New Sales Skill", "just added", "category: Sales\n")], ownerKind: "local" });
  assert.ok(templates.channelSkillGrants(await getChannelMeta(entry.slug)).includes("new-sales-skill"), "a live link, not a copy");
  // Clearing keeps the additions.
  const cleared = await templates.assignTemplateToChannel(entry.slug, "none");
  assert.equal(cleared.skillTemplate, "");
  assert.deepEqual(cleared.skills, ["extra-tool"]);
  assert.equal(await templates.assignTemplateToChannel(entry.slug, "no-such-template"), null);
  assert.equal(await templates.assignTemplateToChannel("no-such-channel", "sales"), null);
});

test("preview reports gains, keeps and drops against the current tier", async () => {
  await templates.assignTemplateToChannel(entry.slug, "sales");
  const p = templates.previewTemplate("development", await getChannelMeta(entry.slug));
  assert.equal(p.template.slug, "development");
  assert.ok(p.remove.includes("sales-play"), "switching templates drops the old template's skills");
  assert.deepEqual(p.keep, ["extra-tool"]);
  const none = templates.previewTemplate("", await getChannelMeta(entry.slug));
  assert.equal(none.template, null);
  assert.deepEqual(none.names, ["extra-tool"]);
  assert.equal(templates.previewTemplate("nope", {}), null);
  const assignments = await templates.templateAssignments();
  assert.ok(assignments.get("sales").some((c) => c.slug === entry.slug));
});

test("DM templates carry a skill template through effectiveMeta", () => {
  saveSettings({ dmTemplates: { user: { skills: ["extra-tool"], skillTemplate: "sales", allowedMcps: [], allowedCodexMcps: [], model: "", effort: "", adminMode: false, allowBash: false, allowNetwork: false, autoMode: false, cleanMode: false, engine: "" } } });
  const dm = effectiveMeta({ isDM: true, template: "user", skills: [], skillTemplate: "" });
  assert.equal(dm.skillTemplate, "sales");
  assert.deepEqual(dm.skills, ["extra-tool"]);
  assert.ok(templates.channelSkillGrants(dm).includes("sales-play"));
});

test("admin API: assign from the template side and the conversation side, validate on the channel PUT, expose it on profiles", async () => {
  const list = await request("/api/skills/templates");
  assert.ok(list.json.templates.find((t) => t.slug === "sales").channels.some((c) => c.slug === entry.slug), "templates list who follows them");
  const viaTemplate = await request("/api/skills/templates/development/assign", { method: "POST", body: { channel: entry.slug } });
  assert.equal(viaTemplate.status, 200);
  assert.equal((await getChannelMeta(entry.slug)).skillTemplate, "development");
  const viaChannel = await request(`/api/skills/profile/${entry.slug}/template`, { method: "POST", body: { template: "sales" } });
  assert.equal(viaChannel.json.assigned.skillTemplate, "sales");
  assert.equal((await request(`/api/skills/profile/${entry.slug}/template`, { method: "POST", body: { template: "ghost" } })).status, 404);
  const profile = await request(`/api/skills/profile/${entry.slug}`);
  assert.equal(profile.json.skillTemplate, "sales");
  assert.equal(profile.json.template.slug, "sales");
  assert.deepEqual(profile.json.own, ["extra-tool"]);
  assert.ok(profile.json.profile.active.some((e) => e.slug === "sales-play"));
  const profiles = await request("/api/skills/profiles");
  assert.equal(profiles.json.profiles.find((p) => p.slug === entry.slug).skillTemplate, "sales");
  const preview = await request(`/api/skills/templates/development/preview?channel=${entry.slug}`);
  assert.ok(preview.json.preview.remove.includes("sales-play"));

  // The channel PUT accepts a template slug (resolving its name) and refuses an unknown one.
  const put = await request(`/api/channels/C_TPL_ASSIGN/meta`, { method: "PUT", body: { skillTemplate: "Development", skills: ["extra-tool"] } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal((await getChannelMeta(entry.slug)).skillTemplate, "development");
  const bad = await request(`/api/channels/C_TPL_ASSIGN/meta`, { method: "PUT", body: { skillTemplate: "no-such" } });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  assert.equal((await getChannelMeta(entry.slug)).skillTemplate, "development", "a refused save changes nothing");
  const clear = await request(`/api/channels/C_TPL_ASSIGN/meta`, { method: "PUT", body: { skillTemplate: "" } });
  assert.equal(clear.status, 200);
  assert.equal((await getChannelMeta(entry.slug)).skillTemplate, "");
});

test("the channel tier includes the channel's own repository section", async () => {
  catalog.putSkillRevision({ files: [md("Section Skill", "kept in the channel section")], ownerKind: "local", channelScope: "C_TPL_ASSIGN" });
  const meta = await getChannelMeta(entry.slug);
  assert.ok(templates.channelSkillGrants(meta).includes("section-skill"));
  assert.ok(templates.withTemplateSkills(meta).skills.includes("section-skill"));
  assert.equal(templates.channelSkillGrants({ ...meta, channelId: "C_OTHER_CHANNEL" }).includes("section-skill"), false, "another channel's tier does not see it");
  assert.ok(resolveAccessGrants({ organization: { skills: [] }, channel: templates.withTemplateSkills(meta) }).skills.includes("section-skill"), "and the grant union carries it");
});
