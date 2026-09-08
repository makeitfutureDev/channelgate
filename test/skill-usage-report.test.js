import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const catalog = await import("../src/gateway/skills/catalog.js");
const { skillUsageReport, formatSkillUsageReport } = await import("../src/gateway/skills/usage.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, setUser } = await import("../src/config/store.js");
const { register } = await import("../src/mcp/tools/skills.js");
const file = (slug) => ({ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: usage fixture\n---\nNo action.\n` });

function record(slug, channelSlug, userId, extra = {}) {
  catalog.recordSkillUsage({ slug, channelSlug, userId, conversationId: "CRECORDED", engine: "codex", signal: "inferred", ...extra });
}

test("usage attribution uses recorded identities and the same bounded channel/time window as totals", () => {
  catalog.putSkillRevision({ files: [file("report-used")] });
  catalog.putSkillRevision({ files: [file("report-unused")] });
  record("report-used", "report-scope", "UAUTHOR", { conversationId: "CCURRENT" });
  record("report-used", "report-scope", "", { conversationId: "", signal: "exact", engine: "claude" });
  record("report-used", "other-scope", "UOUTSIDE");
  record("report-used", "report-scope", "UOLD", { ts: "2000-01-01T00:00:00.000Z" });
  record("report-used", "report-scope", "UFUTURE", { ts: "2099-01-01T00:00:00.000Z" });
  const report = skillUsageReport({ channelSlug: "report-scope", days: 7, grants: ["report-used", "report-unused"], includeAttribution: true });
  assert.equal(report.used[0].total, 2);
  assert.equal(report.used[0].exact, 1);
  assert.equal(report.used[0].inferred, 1);
  assert.equal(report.channels[0].total, 2);
  assert.equal(Date.parse(report.until) - Date.parse(report.since), 7 * 86400000);
  assert.equal(report.attribution.truncated, false);
  assert.deepEqual(report.attribution.rows.map((r) => [r.userId, r.conversationId, r.total]), [["", "", 1], ["UAUTHOR", "CCURRENT", 1]]);
  assert.deepEqual(report.neverUsed.map((r) => r.slug), ["report-unused"]);
  assert.equal(Object.hasOwn(skillUsageReport({ channelSlug: "report-scope" }), "attribution"), false, "extra author detail is opt-in, not added to existing API listings");
});

for (const [engine, count] of [["claude", 1], ["codex", 2]]) {
  test(`chat usage report: ${engine} keeps one total and actual author/conversation provenance across repeated calls`, async () => {
    const id = `CREPORT${engine.toUpperCase()}`;
    const entry = await upsertChannelEntry(id, { name: `workspace-${engine}`, type: "channel", isDM: false });
    const skill = `report-${engine}`, unused = `report-idle-${engine}`;
    for (const slug of [skill, unused]) catalog.putSkillRevision({ files: [file(slug)] });
    await saveChannelMeta(entry.slug, { channelId: id, skills: [skill, unused] });
    await setUser("UAUTHOR", { name: "Recorded author", approved: true });
    await setUser("UREQUESTER", { name: "Report requester", approved: true });
    for (let i = 0; i < count; i++) record(skill, entry.slug, "UAUTHOR", { engine, conversationId: id });
    record(skill, "different-channel", "UFOREIGN", { engine, conversationId: "CFOREIGN" });
    const tools = new Map();
    register({ registerTool: (name, _definition, handler) => tools.set(name, handler) }, {
      channelId: id, slug: entry.slug, createdBy: "UREQUESTER", text: (body) => body,
      requireAdmin: async () => false, requireManage: async () => false,
      loadMeta: async () => getChannelMeta(entry.slug),
    });
    await upsertChannelEntry(id, { name: `actual-channel-${engine}`, type: "channel", isDM: false });
    const report = await tools.get("skill_usage_report")({ days: 7 });
    assert.ok(report.includes(`"name":"actual-channel-${engine}"`));
    assert.ok(report.includes(`"workspaceSlug":"${entry.slug}"`));
    assert.ok(report.includes(`| ${skill} | ${count} | Recorded author (UAUTHOR): ${count} (recorded conversation ${id}) |`));
    assert.ok(report.includes(`| ${unused} | 0 | No usage recorded | Granted; never used in this window |`));
    assert.match(report, /Inferred SKILL\.md file reads; not confirmed invocations/);
    assert.match(report, /\| Skill \| Usage total \| Recorded authors \| Evidence \| Last recorded \|/);
    assert.doesNotMatch(report, /\| Exact \||\| Inferred \||UFOREIGN|UREQUESTER|Report requester/);
    assert.match(report, /Window: \d{4}-.* through \d{4}-.*\(rolling 7 days, UTC\)/);
    await upsertChannelEntry(id, { name: `renamed-${engine}`, type: "channel", isDM: false });
    await setUser("UAUTHOR", { name: "Updated author name" });
    const refreshed = await tools.get("skill_usage_report")({ days: 7 });
    assert.ok(refreshed.includes(`"name":"renamed-${engine}"`));
    assert.match(refreshed, /Updated author name \(UAUTHOR\)/);
  });
}

test("missing historical author IDs remain unknown and table metadata cannot introduce extra rows", () => {
  record("report-unknown", "report-unknown-channel", "", { conversationId: "" });
  const report = skillUsageReport({ channelSlug: "report-unknown-channel", includeAttribution: true });
  const output = formatSkillUsageReport(report, { conversationId: "CCURRENT", conversationName: "Current | name\nwith newline", userNames: new Map([["", "Requester must not be substituted"]]) });
  assert.match(output, /unrecorded user: 1 \(recorded conversation unrecorded conversation ID; workspace report-unknown-channel\)/);
  assert.doesNotMatch(output, /Requester must not be substituted/);
  assert.ok(output.includes('"name":"Current | name\\nwith newline"'));
});

test("bounded author aggregation discloses partial attribution without changing usage totals", () => {
  for (const user of ["ULIMITA", "ULIMITB", "ULIMITC"]) record("report-limited", "report-limit-channel", user);
  const report = skillUsageReport({ channelSlug: "report-limit-channel", includeAttribution: true });
  const limited = catalog.usageByAuthor({ channelSlug: "report-limit-channel", slugs: ["report-limited"], since: report.since, until: report.until, limit: 2 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.rows.length, 2);
  assert.equal(report.used[0].total, 3);
  const output = formatSkillUsageReport({ ...report, attribution: limited });
  assert.match(output, /Author attribution is partial/);
  assert.match(output, /\| report-limited \| 3 \|/);
  assert.doesNotMatch(output, /ULIMITC/);
  assert.deepEqual(catalog.usageByAuthor({ slugs: [] }), { rows: [], truncated: false });
});
