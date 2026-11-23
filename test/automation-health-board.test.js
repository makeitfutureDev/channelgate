// The Automations health board: one classifier, one scope rule, one edit/run path, used by the
// admin console and the Activity dashboard alike.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { upsertChannelEntry, patchChannelMeta, setUser } = await import("../src/config/store.js");
const schedules = await import("../src/config/schedules.js");
const runs = await import("../src/gateway/schedule-runs.js");
const health = await import("../src/gateway/automation-health.js");
const view = await import("../src/gateway/automations-view.js");
const scheduler = await import("../src/gateway/scheduler.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { automationBoardModuleSource, automationBoardBrowser } = await import("../src/web/automation-board.js");

const run = (patch) => ({ id: Math.random().toString(36).slice(2), startedAt: new Date().toISOString(), status: "succeeded", deliveryStatus: "delivered", ...patch });

test("the classifier keeps the run and the delivery apart and names the cause", () => {
  assert.equal(health.runProblem(run({ status: "succeeded", deliveryStatus: "failed", error: "slack: not_in_channel" })), "undeliverable");
  assert.equal(health.runProblem(run({ status: "succeeded", deliveryStatus: "failed", error: "ratelimited" })), "delivery_failed");
  assert.equal(health.runProblem(run({ status: "failed", errorKind: "authentication" })), "login");
  assert.equal(health.runProblem(run({ status: "failed", error: "Make API returned 401 Unauthorized" })), "credential");
  assert.equal(health.runProblem(run({ status: "failed", error: "spawn failed: EAGAIN" })), "resources");
  assert.equal(health.runProblem(run({ status: "failed", error: "Silent for 45 min, stopped" })), "timeout");
  assert.equal(health.runProblem(run({ status: "failed", outcomeSource: "agent-report", summary: "Could not find the file" })), "agent_failed");
  assert.equal(health.runProblem(run({ status: "failed", errorKind: "attempt_budget" })), "attempts");
  assert.equal(health.runProblem(run({ status: "blocked", errorKind: "license" })), "license");
  assert.equal(health.runProblem(run({ status: "blocked" })), "blocked");
  assert.equal(health.runProblem(run({ status: "unreported" })), "unreported");
  assert.equal(health.runProblem(run({ status: "running" })), null);
  assert.equal(health.runProblem(run({ status: "no-op", deliveryStatus: "suppressed" })), null);
  assert.deepEqual(health.stripCell(run({ status: "succeeded", deliveryStatus: "failed" })).delivery, "fail");
  assert.deepEqual(health.stripCell(run({ status: "succeeded", deliveryStatus: "failed" })).run, "ok");
});

test("health verdicts: broken, degraded, healthy, paused, with streaks and fix steps", () => {
  const ok = health.automationHealth({ enabled: true }, [run({}), run({})]);
  assert.equal(ok.health, "healthy"); assert.equal(ok.attention, false); assert.equal(ok.group, "healthy");

  const once = health.automationHealth({ enabled: true }, [run({ status: "blocked" }), run({})]);
  assert.equal(once.health, "degraded"); assert.equal(once.group, "failing");

  const streak = health.automationHealth({ enabled: true }, [run({ status: "failed", error: "boom" }), run({ status: "failed", error: "boom" }), run({})]);
  assert.equal(streak.health, "broken"); assert.equal(streak.streak, 2); assert.match(streak.problem.message, /2 runs in a row/);

  const gone = health.automationHealth({ enabled: true, executionState: "undeliverable", lastStatus: "undeliverable: not_in_channel" }, [run({})]);
  assert.equal(gone.health, "broken"); assert.equal(gone.group, "not-delivered"); assert.equal(gone.problem.key, "undeliverable");

  const interrupted = health.automationHealth({ enabled: false, executionState: "interrupted" }, [run({ status: "interrupted" })]);
  assert.equal(interrupted.health, "broken"); assert.equal(interrupted.problem.key, "interrupted");

  const paused = health.automationHealth({ enabled: false }, [run({ status: "failed" })]);
  assert.equal(paused.health, "paused"); assert.equal(paused.problem, null); assert.equal(paused.attention, false);

  const flaky = health.automationHealth({ enabled: true }, [run({}), run({ status: "failed" }), run({}), run({ status: "failed" }), run({})]);
  assert.equal(flaky.problem.key, "flaky");

  assert.equal(health.fixSteps("undeliverable", { botName: "ChannelGate" })[0].copy, "/invite @ChannelGate");
  assert.equal(health.fixSteps("undeliverable", {})[0].copy, undefined); // no made-up bot name
  assert.ok(health.fixSteps("failed", { kind: "API" }).every((s) => s.action !== "run-now")); // API runs cannot be re-run here
  assert.equal(health.automationHealth({ enabled: true }, []).strip.length, 0);
});

async function fixtureConversations() {
  getDb().exec("DELETE FROM schedules; DELETE FROM schedule_runs");
  const team = await upsertChannelEntry("CBOARD1", { name: "#ops-daily", type: "channel" });
  const hidden = await upsertChannelEntry("CBOARD2", { name: "finance", type: "channel" });
  const dm = await upsertChannelEntry("DBOARD1", { name: "dm", type: "im", isDM: true });
  const otherDm = await upsertChannelEntry("DBOARD2", { name: "dm2", type: "im", isDM: true });
  await patchChannelMeta(dm.slug, { dmUserId: "U_ANA" });
  await patchChannelMeta(otherDm.slug, { dmUserId: "U_TIB" });
  await setUser("U_ANA", { name: "Ana Pop" });
  await setUser("U_TIB", { name: "Tiberiu Socaci" });
  const mine = schedules.addSchedule({ channelId: "CBOARD1", slug: team.slug, cron: "0 9 * * 1", prompt: "Digest Make errors", description: "Weekly Make error digest", createdBy: "U_ANA" });
  const theirs = schedules.addSchedule({ channelId: "CBOARD1", slug: team.slug, cron: "0 8 * * 1-5", prompt: "Brief", description: "Daily inbox briefing", createdBy: "U_TIB" });
  const sudo = schedules.addSchedule({ channelId: "CBOARD1", slug: team.slug, cron: "0 3 * * *", prompt: "Backups", description: "Host check", createdBy: "U_TIB", sudo: true });
  schedules.addSchedule({ channelId: "CBOARD2", slug: hidden.slug, cron: "30 10 * * *", prompt: "Invoices", description: "Invoice reminders", createdBy: "U_TIB" });
  const personal = schedules.addSchedule({ channelId: "DBOARD1", slug: dm.slug, cron: "30 17 * * 1-5", prompt: "Standup", description: "Standup notes", createdBy: "U_ANA" });
  schedules.addSchedule({ channelId: "DBOARD2", slug: otherDm.slug, cron: "0 7 * * *", prompt: "x", description: "Someone else's DM task", createdBy: "U_TIB" });
  const record = (sched, patch) => { const r = runs.createScheduleRun(sched); runs.updateScheduleRun(r.id, { completedAt: new Date().toISOString(), ...patch }); return r; };
  record(mine, { status: "failed", error: "Make API 401 unauthorized", costUsd: 0.5 });
  record(mine, { status: "failed", error: "Make API 401 unauthorized", costUsd: 0.25 });
  record(theirs, { status: "succeeded", deliveryStatus: "failed", error: "not_in_channel" });
  schedules.updateSchedule(theirs.id, { executionState: "undeliverable", lastStatus: "undeliverable: not_in_channel" });
  record(personal, { status: "succeeded", deliveryStatus: "delivered", costUsd: 0.1 });
  return { mine, theirs, sudo, personal };
}

test("a member's board: only conversations they can access, their own DM, no host-access rows; edit rights follow the creator", async () => {
  const { mine, theirs } = await fixtureConversations();
  const access = { user: { isAdmin: false }, allows: async (e) => ["CBOARD1", "DBOARD1", "DBOARD2"].includes(e.channelId) };
  const board = await view.automationBoard(access, "U_ANA", { days: 7, botName: "ChannelGate" });
  assert.deepEqual(board.automations.map((a) => a.title).sort(), ["Daily inbox briefing", "Standup notes", "Weekly Make error digest"]);
  assert.equal(board.viewer.isAdmin, false);
  const digest = board.automations.find((a) => a.id === mine.id);
  assert.equal(digest.health, "broken"); assert.equal(digest.problem.key, "credential"); assert.equal(digest.streak, 2);
  assert.equal(digest.canEdit, true); assert.equal(digest.canRunNow, true); assert.equal(digest.mine, true);
  assert.equal(digest.createdByName, "Ana Pop"); assert.equal(digest.stats.costUsd, 0.75);
  const briefing = board.automations.find((a) => a.id === theirs.id);
  assert.equal(briefing.group, "not-delivered"); assert.equal(briefing.canEdit, false); assert.equal(briefing.canRunNow, false);
  assert.equal(briefing.fix[0].copy, "/invite @ChannelGate");
  assert.equal(board.automations.find((a) => a.title === "Standup notes").conversation, "Your direct messages");
  assert.equal(board.attention, 2);
  assert.deepEqual({ runs: board.kpis.runs, failed: board.kpis.failed, notDelivered: board.kpis.notDelivered }, { runs: 4, failed: 2, notDelivered: 1 });
  assert.equal(board.counts.broken, 2); assert.equal(board.counts.healthy, 1);
});

test("the admin console sees every conversation, every DM by name and host-access rows", async () => {
  await fixtureConversations();
  const board = await view.automationBoard(view.ADMIN_CONSOLE_ACCESS, "", { adminConsole: true });
  const titles = board.automations.map((a) => a.title);
  for (const t of ["Host check", "Invoice reminders", "Someone else's DM task", "Standup notes"]) assert.ok(titles.includes(t), t);
  assert.ok(board.automations.every((a) => a.canEdit));
  assert.equal(board.automations.find((a) => a.title === "Standup notes").conversation, "DM · Ana Pop");
});

test("only the creator, an admin or the DM owner may edit or run; members never flip host access", async () => {
  const { mine, theirs, personal } = await fixtureConversations();
  const access = { user: { isAdmin: false }, allows: async () => true };
  const entry = await view.checkedChannel(access, "U_ANA", "CBOARD1");
  await assert.rejects(view.updateAutomation(access, "U_ANA", entry, theirs.id, { enabled: false }), { status: 403, userFacing: true });
  await assert.rejects(view.runAutomationNow(access, "U_ANA", entry, theirs.id), { status: 403 });
  const paused = await view.updateAutomation(access, "U_ANA", entry, mine.id, { enabled: false, description: "Weekly Make digest", prompt: "Digest errors", cron: "15 9 * * 1" });
  assert.deepEqual([paused.enabled, paused.description, paused.cron], [false, "Weekly Make digest", "15 9 * * 1"]);
  await assert.rejects(view.updateAutomation(access, "U_ANA", entry, mine.id, { sudo: true }), { status: 400, userFacing: true });
  await assert.rejects(view.updateAutomation(access, "U_ANA", entry, mine.id, { cron: "nope" }), /valid five-field cron/);
  assert.equal(schedules.getSchedules().find((s) => s.id === mine.id).cron, "15 9 * * 1"); // rejected edit left it intact
  const dmEntry = await view.checkedChannel(access, "U_ANA", "DBOARD1");
  assert.equal((await view.updateAutomation(access, "U_ANA", dmEntry, personal.id, { enabled: false })).enabled, false);
  await assert.rejects(view.updateAutomation(access, "U_ANA", entry, "api:org-key", {}), { status: 400 });
});

let posts, timer;
beforeEach(() => {
  scheduler.resetSchedulerState();
  posts = [];
  const client = { chat: { postMessage: async (payload) => { posts.push(payload); return { ok: true, ts: `1791000000.${String(posts.length).padStart(6, "0")}` }; } } };
  clearInterval(timer);
  timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
});
after(() => clearInterval(timer));

test("Run now executes once outside the cron, records a manual trigger, and refuses loops and overlapping runs", async () => {
  getDb().exec("DELETE FROM schedules; DELETE FROM schedule_runs");
  const sched = schedules.addSchedule({ channelId: "C_RUNNOW", slug: "run-now", cron: "0 9 * * *", prompt: "Check", description: "Run-now check", createdBy: "U_ANA", notify: "none" });
  schedules.updateSchedule(sched.id, { enabled: false });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = async () => { await gate; return { engine: "claude", content: "Done.\n\n```automation-result\n{\"status\":\"succeeded\",\"summary\":\"ok\",\"connections\":[]}\n```" }; };
  const first = scheduler.runScheduleNow(sched.id, { by: "U_ANA", runOptions: { runner, deliver: async () => {} } });
  assert.equal(first.started, true);
  assert.throws(() => scheduler.runScheduleNow(sched.id, { runOptions: { runner } }), { status: 409 });
  release();
  await first.done;
  const [recorded] = runs.listScheduleRuns({ scheduleId: sched.id });
  assert.equal(recorded.trigger, "manual"); assert.equal(recorded.triggeredBy, "U_ANA"); assert.equal(recorded.status, "succeeded"); assert.equal(recorded.schedulingDelayMs, 0);
  assert.equal(schedules.getSchedules().find((s) => s.id === sched.id).enabled, false); // a paused automation stays paused
  const loop = schedules.addSchedule({ channelId: "C_RUNNOW", slug: "run-now", cron: "*/30 * * * *", prompt: "Loop", createdBy: "U_ANA", loop: true, threadTs: "1.2" });
  assert.throws(() => scheduler.runScheduleNow(loop.id), { status: 400 });
  assert.throws(() => scheduler.runScheduleNow("missing"), { status: 404 });
});

test("admin console routes: board, edit, validation errors, unknown automation", async () => {
  await fixtureConversations();
  await setUser("U_TIB", { name: "Tiberiu Socaci", role: "admin" });
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter());
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const board = await (await fetch(`${base}/automation-board/board?days=30`)).json();
    assert.equal(board.windowDays, 30); assert.equal(board.viewer.adminConsole, true);
    const target = board.automations.find((a) => a.title === "Invoice reminders");
    const res = await fetch(`${base}/automation-board/${target.channelId}/${target.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, resultPolicy: "on-failure" }) });
    assert.equal(res.status, 200);
    assert.equal(schedules.getSchedules().find((s) => s.id === target.id).resultPolicy, "on-failure");
    const bad = await fetch(`${base}/automation-board/${target.channelId}/${target.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delivery: "sideways" }) });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /invalid delivery/);
    assert.equal((await fetch(`${base}/automation-board/${target.channelId}/nope/runs`)).status, 200); // unknown id: empty history, not an error
    assert.equal((await fetch(`${base}/automation-board/CNOPE/x/run`, { method: "POST" })).status, 404);
  } finally { server.close(); }
});

test("the shared component ships as one module for the admin console and inline for the dashboard", async () => {
  const source = automationBoardModuleSource();
  const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(typeof mod.automationBoardBrowser, "function");
  assert.equal(mod.automationBoardBrowser.toString(), automationBoardBrowser.toString());
  assert.match(mod.AUTOMATION_BOARD_HTML, /id="ab-root"/);
  // Server text is only ever assigned as text: the one innerHTML is the constant icon table.
  const body = automationBoardBrowser.toString();
  assert.equal((body.match(/innerHTML/g) || []).length, 1);
  assert.match(body, /span\.innerHTML = "<svg viewBox='0 0 16 16'>" \+ \(ICONS\[name\] \|\| ""\) \+ "<\/svg>"/);
});
