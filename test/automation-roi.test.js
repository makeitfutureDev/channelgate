// ROI: what a person says one successful run or use is worth (minutes saved, hourly rate), set
// against the AI cost — per automation, per API source and per skill, on the Automations board
// and on the ROI page.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { upsertChannelEntry, patchChannelMeta, setUser } = await import("../src/config/store.js");
const schedules = await import("../src/config/schedules.js");
const { buildSchedulePatch } = await import("../src/config/schedule-patch.js");
const runs = await import("../src/gateway/schedule-runs.js");
const roi = await import("../src/gateway/roi.js");
const view = await import("../src/gateway/automations-view.js");
const { roiOverview, setSkillRoi, setDefaultRate } = await import("../src/gateway/roi-view.js");
const { createApiToken } = await import("../src/gateway/api-tokens.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { activityPage } = await import("../src/web/activity-page.js");
const { automationBoardModuleSource, automationBoardBrowser, AUTOMATION_ROI_HTML } = await import("../src/web/automation-board.js");

test("the ROI arithmetic: hours, value, net and multiple; the default rate; unknown cost claims nothing", () => {
  const r = roi.roiOf({ minutes: 30, rate: 60, counted: 10, costUsd: 5 });
  assert.deepEqual([r.configured, r.hoursSaved, r.valueUsd, r.costUsd, r.netUsd, r.multiple], [true, 5, 300, 5, 295, 59]);
  const byDefault = roi.roiOf({ minutes: 15, rate: 0, defaultRate: 40, counted: 4, costUsd: 20 });
  assert.deepEqual([byDefault.usesDefaultRate, byDefault.effectiveRate, byDefault.valueUsd, byDefault.netUsd, byDefault.multiple], [true, 40, 40, 20, 1]);
  const loss = roi.roiOf({ minutes: 1, rate: 60, counted: 1, costUsd: 3 });
  assert.deepEqual([loss.netUsd, loss.multiple], [-2, -0.7]);
  // Minutes without any rate: time saved is known, a value is not.
  const noRate = roi.roiOf({ minutes: 20, counted: 3, costUsd: 1 });
  assert.deepEqual([noRate.configured, noRate.hoursSaved, noRate.valueUsd, noRate.netUsd, noRate.multiple], [false, 1, 0, null, null]);
  // A skill: cost not attributed, so no net and no multiple; free runs have no multiple either.
  const skill = roi.roiOf({ minutes: 6, rate: 50, counted: 10, costUsd: null });
  assert.deepEqual([skill.valueUsd, skill.costUsd, skill.netUsd, skill.multiple], [50, null, null, null]);
  assert.equal(roi.roiOf({ minutes: 6, rate: 50, counted: 10, costUsd: 0 }).multiple, null);

  const totals = roi.roiTotals([r, byDefault, noRate]);
  assert.deepEqual([totals.items, totals.configured, totals.hoursSaved, totals.valueUsd, totals.costUsd, totals.unconfiguredCostUsd, totals.netUsd, totals.multiple],
    [3, 2, 6, 340, 25, 1, 315, 12.6]);
  assert.equal(roi.roiTotals([skill]).costKnown, false); assert.equal(roi.roiTotals([skill]).multiple, null);

  assert.equal(roi.roiCounts({ status: "succeeded", deliveryStatus: "delivered" }), true);
  assert.equal(roi.roiCounts({ status: "no-op", deliveryStatus: "suppressed" }), true);
  assert.equal(roi.roiCounts({ status: "succeeded", deliveryStatus: "failed" }), false);
  for (const status of ["failed", "blocked", "running", "interrupted", "unreported"]) assert.equal(roi.roiCounts({ status }), false, status);
});

test("ROI inputs are validated: plain non-negative numbers, bounded, empty clears", async () => {
  assert.equal(roi.roiMinutes("12.5"), 12.5); assert.equal(roi.roiMinutes(""), 0); assert.equal(roi.roiRate(null), 0); assert.equal(roi.roiRate(85.129), 85.13);
  for (const bad of [-1, "abc", "1e3", NaN, Infinity, {}, true, "12 min"]) assert.throws(() => roi.roiMinutes(bad), { status: 400, userFacing: true }, String(bad));
  assert.throws(() => roi.roiRate(100_001), /100,000 at most/);
  const current = { id: "s1", cron: "0 9 * * *", prompt: "p" };
  const { patch } = await buildSchedulePatch(current, { roiMinutes: "20", roiHourlyRate: 75 });
  assert.deepEqual([patch.roiMinutes, patch.roiHourlyRate], [20, 75]);
  assert.match((await buildSchedulePatch(current, { roiMinutes: -5 })).error, /Time saved must be a number/);
  assert.equal("roiMinutes" in (await buildSchedulePatch(current, { enabled: true })).patch, false);
});

test("stored inputs: API sources and skills by key, the default rate, both zero removes the row", () => {
  getDb().exec("DELETE FROM roi_assignments");
  roi.setRoiAssignment("api", "C1", "api:tok", { minutes: 10, rate: 50 }, "U1");
  roi.setRoiAssignment("api", "C2", "api:tok", { minutes: 5, rate: 0 }, "U1");
  roi.setRoiAssignment("skill", "", "invoice-check", { minutes: 3, rate: 0 }, "U1");
  assert.deepEqual(roi.getRoiAssignment("api", "C1", "api:tok").minutes, 10);
  assert.equal(roi.roiAssignments("api").size, 2); assert.equal(roi.roiAssignments("skill").get("\ninvoice-check").minutes, 3);
  roi.setRoiAssignment("api", "C1", "api:tok", { minutes: 12, rate: 50 }, "U2");
  assert.deepEqual([roi.getRoiAssignment("api", "C1", "api:tok").minutes, roi.getRoiAssignment("api", "C1", "api:tok").updatedBy], [12, "U2"]);
  roi.setRoiAssignment("api", "C1", "api:tok", { minutes: 0, rate: 0 });
  assert.equal(roi.getRoiAssignment("api", "C1", "api:tok"), null);
  assert.equal(roi.getDefaultRoiRate(), 0);
  assert.equal(roi.setDefaultRoiRate(45, "U1"), 45); assert.equal(roi.getDefaultRoiRate(), 45);
  assert.equal(roi.setDefaultRoiRate(0), 0); assert.equal(roi.getDefaultRoiRate(), 0);
});

const NOW = Date.now();
const record = (sched, patch, agoMs = 60_000) => {
  const r = runs.createAutomationRun({ scheduleId: sched.id, channelId: sched.channelId, startedMs: NOW - agoMs, description: sched.description || "", trigger: String(sched.id).startsWith("api:") ? "api" : "schedule" });
  runs.updateScheduleRun(r.id, { completedAt: new Date(NOW - agoMs + 500).toISOString(), deliveryStatus: "delivered", ...patch });
  return r;
};
const useSkill = (slug, channelSlug, userId, runId, agoMs = 60_000) => getDb().prepare("INSERT INTO skill_usage(ts, slug, channel_slug, user_id, run_id, signal) VALUES(?, ?, ?, ?, ?, 'exact')")
  .run(new Date(NOW - agoMs).toISOString(), slug, channelSlug, userId, runId);

async function fixture() {
  getDb().exec("DELETE FROM schedules; DELETE FROM schedule_runs; DELETE FROM roi_assignments; DELETE FROM skill_usage");
  const team = await upsertChannelEntry("CROI1", { name: "ops", type: "channel" });
  const closed = await upsertChannelEntry("CROI2", { name: "finance", type: "channel" });
  const dm = await upsertChannelEntry("DROI1", { name: "dm", type: "im", isDM: true });
  await patchChannelMeta(dm.slug, { dmUserId: "U_TIB" });
  await setUser("U_ANA", { name: "Ana Pop" });
  await setUser("U_TIB", { name: "Tiberiu Socaci", role: "admin" });
  const mine = schedules.addSchedule({ channelId: "CROI1", slug: team.slug, cron: "0 9 * * 1", prompt: "Digest", description: "Weekly digest", createdBy: "U_ANA", roiMinutes: 30, roiHourlyRate: 60 });
  const theirs = schedules.addSchedule({ channelId: "CROI1", slug: team.slug, cron: "0 8 * * *", prompt: "Brief", description: "Daily briefing", createdBy: "U_TIB" });
  const other = schedules.addSchedule({ channelId: "CROI2", slug: closed.slug, cron: "0 7 * * *", prompt: "Invoices", description: "Invoice reminders", createdBy: "U_TIB", roiMinutes: 10 });
  record(mine, { status: "succeeded", costUsd: 1 });
  record(mine, { status: "no-op", deliveryStatus: "suppressed", costUsd: 0.5 });
  record(mine, { status: "failed", error: "boom", costUsd: 0.5 });
  record(mine, { status: "succeeded", deliveryStatus: "failed", costUsd: 1 });      // the answer never arrived
  record(mine, { status: "succeeded", costUsd: 9 }, 40 * 86400000);                // outside 30 days
  record(theirs, { status: "succeeded", costUsd: 2 });
  record(other, { status: "succeeded", costUsd: 0.2 }); record(other, { status: "succeeded", costUsd: 0.2 });
  const token = createApiToken({ name: "crm sync", channelId: "CROI1", slug: team.slug, createdBy: "U_ANA" });
  const api = { id: `api:${token.record.id}`, channelId: "CROI1", description: "" };
  record(api, { status: "succeeded", costUsd: 0.25 }); record(api, { status: "completed", costUsd: 0.25 }); record(api, { status: "blocked", costUsd: 0.1 });
  useSkill("invoice-check", team.slug, "U_ANA", "r1"); useSkill("invoice-check", team.slug, "U_ANA", "r1"); // twice in one run = one use
  useSkill("invoice-check", team.slug, "U_TIB", "r2"); useSkill("invoice-check", closed.slug, "U_TIB", "r3");
  useSkill("invoice-check", dm.slug, "U_TIB", "r4"); useSkill("crm-notes", closed.slug, "U_TIB", "r5");
  useSkill("invoice-check", team.slug, "U_ANA", "r0", 120 * 86400000);
  return { mine, theirs, other, api, team, closed, dm };
}
const member = { user: { isAdmin: false }, allows: async (e) => ["CROI1", "DROI1"].includes(e.channelId) };
const admin = { user: { isAdmin: true }, allows: async () => true };

test("the board carries ROI per automation and for the window; only successful, delivered runs count", async () => {
  const { mine, theirs, api } = await fixture();
  const board = await view.automationBoard(member, "U_ANA", { days: 30, now: new Date(NOW) });
  const digest = board.automations.find((a) => a.id === mine.id);
  assert.deepEqual([digest.roi.counted, digest.roi.hoursSaved, digest.roi.valueUsd, digest.roi.costUsd, digest.roi.netUsd, digest.roi.multiple], [2, 1, 60, 3, 57, 19]);
  assert.equal(digest.canEditRoi, true); assert.equal("roiInput" in digest, false);
  const briefing = board.automations.find((a) => a.id === theirs.id);
  assert.deepEqual([briefing.roi.configured, briefing.roi.counted, briefing.roi.costUsd, briefing.canEditRoi], [false, 1, 2, false]);
  const source = board.automations.find((a) => a.id === api.id);
  assert.deepEqual([source.roi.configured, source.roi.counted, source.roi.costUsd, source.canEditRoi], [false, 2, 0.6, true]);
  assert.deepEqual([board.roi.items, board.roi.configured, board.roi.valueUsd, board.roi.costUsd, board.roi.netUsd, board.roi.multiple, board.roi.unconfiguredCostUsd], [3, 1, 60, 3, 57, 19, 2.6]);
  // The window is the board's own: a day-old board does not reach the run from 40 days ago either.
  assert.equal((await view.automationBoard(member, "U_ANA", { days: 7, now: new Date(NOW) })).roi.valueUsd, 60);
});

test("setting ROI: the creator or an admin for a schedule, whoever may see it for an API source; a default rate fills the gap", async () => {
  const { mine, theirs, api } = await fixture();
  const entry = await view.checkedChannel(member, "U_ANA", "CROI1");
  await assert.rejects(view.setAutomationRoi(member, "U_ANA", entry, theirs.id, { minutesSaved: 5, hourlyRate: 50 }), { status: 403 });
  await assert.rejects(view.setAutomationRoi(member, "U_ANA", entry, mine.id, { minutesSaved: "lots" }), { status: 400, userFacing: true });
  assert.deepEqual(await view.setAutomationRoi(member, "U_ANA", entry, mine.id, { minutesSaved: 45, hourlyRate: 80 }), { ok: true, minutesSaved: 45, hourlyRate: 80 });
  const stored = schedules.getSchedules().find((s) => s.id === mine.id);
  assert.deepEqual([stored.roiMinutes, stored.roiHourlyRate, stored.cron], [45, 80, "0 9 * * 1"]);
  assert.equal((await view.setAutomationRoi(admin, "U_TIB", entry, theirs.id, { minutesSaved: 5, hourlyRate: 0 })).minutesSaved, 5);

  await view.setAutomationRoi(member, "U_ANA", entry, api.id, { minutesSaved: 12, hourlyRate: 0 });
  assert.equal(roi.getRoiAssignment("api", "CROI1", api.id).minutes, 12);
  await assert.rejects(view.setAutomationRoi({ user: { isAdmin: false }, allows: async () => true }, "U_OTHER", entry, api.id, { minutesSaved: 1 }), (e) => e.status === 403 || e.status === 404);
  let board = await view.automationBoard(member, "U_ANA", { days: 30, now: new Date(NOW) });
  assert.equal(board.automations.find((a) => a.id === api.id).roi.configured, false); // minutes, but no rate anywhere

  await assert.rejects(setDefaultRate(member, "U_ANA", { hourlyRate: 50 }), { status: 403, userFacing: true });
  assert.deepEqual(await setDefaultRate(admin, "U_TIB", { hourlyRate: 50 }), { ok: true, hourlyRate: 50 });
  board = await view.automationBoard(member, "U_ANA", { days: 30, now: new Date(NOW) });
  const source = board.automations.find((a) => a.id === api.id);
  assert.deepEqual([source.roi.usesDefaultRate, source.roi.hoursSaved, source.roi.valueUsd, source.roi.netUsd], [true, 0.4, 20, 19.4]);
  assert.equal(board.roi.defaultRate, 50); assert.equal(board.roi.configured, 3);
  await view.setAutomationRoi(member, "U_ANA", entry, api.id, { minutesSaved: 0, hourlyRate: 0 });
  assert.equal(roi.getRoiAssignment("api", "CROI1", api.id), null);
});

test("the ROI page: automations, API sources and skills, scoped to what the viewer may open", async () => {
  const { mine, api } = await fixture();
  await assert.rejects(setSkillRoi(member, "U_ANA", { slug: "invoice-check", minutesSaved: 6, hourlyRate: 50 }), { status: 403 });
  await assert.rejects(setSkillRoi(admin, "U_TIB", { slug: "../x", minutesSaved: 6 }), { status: 400 });
  await setSkillRoi(admin, "U_TIB", { slug: "invoice-check", minutesSaved: 6, hourlyRate: 50 });
  await setSkillRoi(admin, "U_TIB", { slug: "unused-skill", minutesSaved: 1, hourlyRate: 50 });
  const entry = await view.checkedChannel(member, "U_ANA", "CROI1");
  await view.setAutomationRoi(member, "U_ANA", entry, api.id, { minutesSaved: 15, hourlyRate: 40 });

  const mineView = await roiOverview(member, "U_ANA", { days: 30, now: new Date(NOW) });
  assert.equal(mineView.windowDays, 30); assert.equal(mineView.viewer.isAdmin, false);
  assert.deepEqual(mineView.automations.items.map((i) => i.title), ["Weekly digest", "Daily briefing"]); // by value; the closed conversation is absent
  assert.deepEqual(mineView.api.items.map((i) => [i.id, i.roi.counted, i.roi.valueUsd, i.roi.costUsd]), [[api.id, 2, 20, 0.6]]);
  // Skills: the team channel only — not the closed conversation, not someone else's DM.
  assert.deepEqual(mineView.skills.items.map((i) => [i.id, i.runs, i.people, i.roi.valueUsd, i.roi.costUsd, i.roi.multiple, i.canEditRoi]), [["invoice-check", 2, 2, 10, null, null, false]]);
  assert.deepEqual([mineView.totals.valueUsd, mineView.totals.costUsd, mineView.totals.netUsd, mineView.totals.hoursSaved, mineView.totals.configured, mineView.totals.items], [90, 3.6, 86.4, 1.7, 3, 4]);
  assert.equal(mineView.totals.multiple, 24);
  assert.equal(mineView.automations.items.find((i) => i.id === mine.id).canEditRoi, true);

  const all = await roiOverview(admin, "U_TIB", { days: 30, now: new Date(NOW) });
  assert.ok(all.automations.items.some((i) => i.title === "Invoice reminders"));
  assert.deepEqual(all.skills.items.map((i) => [i.id, i.runs]), [["invoice-check", 4], ["crm-notes", 1], ["unused-skill", 0]]);
  assert.ok(all.skills.items.every((i) => i.canEditRoi));
  assert.equal(all.skills.totals.valueUsd, 20); assert.equal(all.skills.totals.costKnown, false);
  assert.equal((await roiOverview(admin, "U_TIB", { days: 365, now: new Date(NOW) })).windowDays, 30); // unknown window → the default
  assert.equal((await roiOverview(admin, "U_TIB", { days: 90, now: new Date(NOW) })).windowDays, 90);
});

test("admin console routes: the ROI overview and its three setters", async () => {
  const { mine, api } = await fixture();
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter());
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/automation-board`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(`/CROI1/${mine.id}/roi`, { minutesSaved: 20, hourlyRate: 90 })).status, 200);
    assert.equal((await post(`/CROI1/${encodeURIComponent(api.id)}/roi`, { minutesSaved: 10, hourlyRate: 0 })).status, 200);
    assert.equal((await post("/roi/default", { hourlyRate: 30 })).status, 200);
    assert.equal((await post("/roi/skill", { slug: "crm-notes", minutesSaved: 4, hourlyRate: 0 })).status, 200);
    const bad = await post(`/CROI1/${mine.id}/roi`, { minutesSaved: -3 });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Time saved must be a number/);
    assert.equal((await post("/roi/skill", { slug: "", minutesSaved: 4 })).status, 400);
    assert.equal((await post("/CNOPE/x/roi", { minutesSaved: 1 })).status, 404);
    const o = await (await fetch(`${base}/roi?days=30`)).json();
    assert.equal(o.viewer.adminConsole, true); assert.equal(o.defaultRate, 30);
    assert.deepEqual([o.automations.items.find((i) => i.id === mine.id).roi.valueUsd, o.api.items[0].roi.valueUsd, o.skills.items.find((i) => i.id === "crm-notes").roi.valueUsd], [60, 10, 2]);
    const board = await (await fetch(`${base}/board?days=30`)).json();
    assert.equal(board.roi.defaultRate, 30); assert.ok(board.roi.valueUsd > 0);
    assert.equal(schedules.getSchedules().find((s) => s.id === mine.id).roiMinutes, 20);
  } finally { server.close(); }
});

test("the ROI page ships in both surfaces from the one shared component", async () => {
  const page = activityPage({ sessionId: "s", csrf: "c", view: "roi" });
  assert.match(page.html, /<title>ROI · ChannelGate/);
  assert.match(page.html, /id="ab-root"/);
  assert.match(page.html, /\/roi" aria-current="page">ROI</);
  assert.doesNotMatch(page.html, /\/automations" aria-current="page"/);
  assert.match(page.html, /"page":"roi"/);
  const board = activityPage({ sessionId: "s", csrf: "c", view: "automations" }).html;
  assert.match(board, /href="\/activity\/s\/roi">ROI</); assert.match(board, /"roiHref":"\/activity\/s\/roi"/);
  const mod = await import(`data:text/javascript,${encodeURIComponent(automationBoardModuleSource())}`);
  assert.equal(mod.AUTOMATION_ROI_HTML, AUTOMATION_ROI_HTML);
  const body = automationBoardBrowser.toString();
  for (const needle of ["/roi?days=", "/roi/skill", "/roi/default", "itemPath(a, \"roi\")", "minutesSaved", "config.rootId"]) assert.ok(body.includes(needle), needle);
  assert.equal((body.match(/innerHTML/g) || []).length, 1);
});
