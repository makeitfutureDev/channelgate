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

test("the board's 30-day totals count every run and its AI cost, whatever window is selected", async () => {
  const { mine } = await fixtureConversations();
  const access = { user: { isAdmin: false }, allows: async (e) => ["CBOARD1", "DBOARD1", "DBOARD2"].includes(e.channelId) };
  const today = await view.automationBoard(access, "U_ANA", { days: 1 });
  assert.deepEqual(today.totals, { days: 30, runs: 4, costUsd: 0.85, costSince: today.totals.costSince, costLimited: false });
  // Ten days later the runs have left the 7-day window but are still in the 30-day totals.
  const later = await view.automationBoard(access, "U_ANA", { days: 7, now: new Date(Date.now() + 10 * 86400_000) });
  assert.equal(later.kpis.runs, 0);
  assert.equal(later.totals.runs, 4); assert.equal(later.totals.costUsd, 0.85);
  assert.equal(later.automations.find((a) => a.id === mine.id).month.runs, 2);
  // Past 30 days they drop out.
  const gone = await view.automationBoard(access, "U_ANA", { days: 30, now: new Date(Date.now() + 31 * 86400_000) });
  assert.deepEqual({ runs: gone.totals.runs, costUsd: gone.totals.costUsd }, { runs: 0, costUsd: 0 });
  // Cost the plan's history does not show is left out; the runs still count.
  const hidden = runs.runTotalsSince({ scheduleId: mine.id, channelId: "CBOARD1", sinceMs: 0, historyStart: new Date(Date.now() + 60_000) });
  assert.deepEqual(hidden, { runs: 2, costUsd: 0 });
  assert.deepEqual(runs.runTotalsSince({ scheduleId: mine.id, channelId: "CBOARD1", sinceMs: 0, historyStart: null }), { runs: 2, costUsd: 0.75 });
});

test("each row carries its own window cost and a link target for its last run", async () => {
  const { mine, personal } = await fixtureConversations();
  const access = { user: { isAdmin: false }, allows: async (e) => ["CBOARD1", "DBOARD1", "DBOARD2"].includes(e.channelId) };
  // The latest run announced itself in a thread and failed before delivering anything.
  const failed = runs.createScheduleRun(mine);
  runs.updateScheduleRun(failed.id, { status: "failed", error: "Make API 401 unauthorized", costUsd: 0.05, thread: "1764000000.000100", completedAt: new Date().toISOString() });
  // A delivered run links to where its answer went, ahead of its announcement.
  const delivered = runs.createScheduleRun(personal);
  runs.updateScheduleRun(delivered.id, { status: "succeeded", deliveryStatus: "delivered", deliveryThread: "1764000000.000300", thread: "1764000000.000200", completedAt: new Date().toISOString() });
  const board = await view.automationBoard(access, "U_ANA", { days: 7, teamId: "T0TEAM1" });
  assert.equal(board.teamId, "T0TEAM1");
  const digest = board.automations.find((a) => a.id === mine.id);
  assert.equal(digest.stats.costUsd, 0.8); // the row's cost in the selected window
  assert.equal(digest.lastRun.thread, "1764000000.000100"); assert.equal(digest.lastRun.costUsd, 0.05);
  assert.equal(board.automations.find((a) => a.id === personal.id).lastRun.thread, "1764000000.000300");
  assert.equal(view.automationRuns(access, { channelId: "CBOARD1" }, mine.id, "U_ANA")[0].thread, "1764000000.000100");
  // A run with no thread (a channel post, a headless API run) has nothing to open but its conversation.
  assert.equal(health.runThread({}), "");
  assert.equal((await view.automationBoard(access, "U_ANA", { teamId: "not a team" })).teamId, "");
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

test("an acknowledged error stops counting: the automation goes back to healthy, the history stays", () => {
  const failed = run({ status: "failed", error: "boom" });
  const older = run({ status: "failed", error: "boom" });
  const broken = health.automationHealth({ enabled: true }, [failed, older, run({})]);
  assert.equal(broken.health, "broken"); assert.equal(broken.openErrors, 2);

  const acked = { ...failed, acknowledgedAt: new Date().toISOString(), acknowledgedByName: "Ana Pop" };
  const one = health.automationHealth({ enabled: true }, [acked, older, run({})]);
  assert.equal(one.health, "healthy"); assert.equal(one.problem, null); assert.equal(one.openErrors, 1);
  assert.deepEqual([one.acknowledgement.byName, one.acknowledgement.label, one.acknowledgement.runId], ["Ana Pop", "Run failed", failed.id]);
  assert.equal(one.stats.failed, 2); // the honest window stats keep the failures
  assert.equal(one.strip.at(-1).ack, true); assert.equal(one.strip.at(0).ack, false); // oldest → newest
  assert.equal(health.runProblem(acked), "failed"); assert.equal(health.openProblem(acked), null);

  // A new failure after the acknowledgement opens a fresh problem.
  assert.equal(health.automationHealth({ enabled: true }, [run({ status: "failed" }), acked]).health, "degraded");

  // Acknowledged failures no longer make an automation flaky.
  const ack = (r) => ({ ...r, acknowledgedAt: new Date().toISOString() });
  const mixed = [run({}), ack(run({ status: "failed" })), run({}), ack(run({ status: "failed" })), run({})];
  assert.equal(health.automationHealth({ enabled: true }, mixed).health, "healthy");

  // Schedule-level verdicts stay acknowledged until the scheduler writes a different status.
  const gone = { enabled: true, executionState: "undeliverable", lastStatus: "undeliverable: not_in_channel", acknowledgedStatus: "undeliverable: not_in_channel" };
  assert.equal(health.automationHealth(gone, [run({})]).health, "healthy");
  assert.equal(health.automationHealth({ ...gone, lastStatus: "undeliverable: channel_not_found" }, [run({})]).problem.key, "undeliverable");
  const interrupted = { enabled: false, executionState: "interrupted", lastStatus: "interrupted: x", acknowledgedStatus: "interrupted: x" };
  assert.equal(health.automationHealth(interrupted, [ack(run({ status: "interrupted" }))]).health, "paused");
});

test("acknowledging: one run, all errors, undo; only the creator, an admin or the DM owner", async () => {
  const { mine, theirs } = await fixtureConversations();
  const access = { user: { isAdmin: false }, allows: async () => true };
  const entry = await view.checkedChannel(access, "U_ANA", "CBOARD1");
  const board = async () => (await view.automationBoard(access, "U_ANA", {})).automations;
  const item = async (id) => (await board()).find((a) => a.id === id);
  assert.equal((await item(mine.id)).canAcknowledge, true);
  assert.equal((await item(theirs.id)).canAcknowledge, false);
  await assert.rejects(view.acknowledgeAutomation(access, "U_ANA", entry, theirs.id, {}), { status: 403, userFacing: true });

  const [newest, older] = runs.listScheduleRuns({ scheduleId: mine.id });
  await assert.rejects(view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, { runId: "nope" }), { status: 404 });
  await assert.rejects(view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, { undo: true }), { status: 400 });
  const one = await view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, { runId: newest.id });
  assert.equal(one.acknowledged, 1);
  let digest = await item(mine.id);
  assert.equal(digest.health, "healthy"); assert.equal(digest.openErrors, 1); assert.equal(digest.acknowledgement.byName, "Ana Pop");
  const listed = view.automationRuns(access, entry, mine.id, "U_ANA");
  assert.equal(listed[0].acknowledgedByName, "Ana Pop"); assert.equal(listed[0].problem, "credential"); assert.equal(listed[1].acknowledgedAt, null);
  assert.equal(runs.getScheduleRun(newest.id).status, "failed"); // the outcome is never rewritten

  await view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, { runId: newest.id, undo: true });
  assert.equal((await item(mine.id)).health, "broken");

  const all = await view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, {});
  assert.equal(all.acknowledged, 2);
  digest = await item(mine.id);
  assert.equal(digest.health, "healthy"); assert.equal(digest.openErrors, 0);
  assert.ok(runs.getScheduleRun(older.id).acknowledgedAt);
  await assert.rejects(view.acknowledgeAutomation(access, "U_ANA", entry, mine.id, { runId: (await runs.createScheduleRun(mine)).id }), { status: 400 }); // nothing to acknowledge on a live run

  // An admin acknowledges the schedule-level "undeliverable" verdict; a new status re-opens it.
  const admin = { user: { isAdmin: true }, allows: async () => true };
  await view.acknowledgeAutomation(admin, "U_TIB", entry, theirs.id, {});
  assert.equal((await item(theirs.id)).health, "healthy");
  schedules.updateSchedule(theirs.id, { lastStatus: "undeliverable: channel_not_found" });
  assert.equal((await item(theirs.id)).problem.key, "undeliverable");
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
  app.use(createAdminRouter({ slack: { snapshot: () => ({ teamId: "T0ADMIN" }) } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const board = await (await fetch(`${base}/automation-board/board?days=30`)).json();
    assert.equal(board.windowDays, 30); assert.equal(board.viewer.adminConsole, true);
    assert.equal(board.teamId, "T0ADMIN"); // the console can open rows in the Slack app too
    const target = board.automations.find((a) => a.title === "Invoice reminders");
    const res = await fetch(`${base}/automation-board/${target.channelId}/${target.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, resultPolicy: "on-failure" }) });
    assert.equal(res.status, 200);
    assert.equal(schedules.getSchedules().find((s) => s.id === target.id).resultPolicy, "on-failure");
    const bad = await fetch(`${base}/automation-board/${target.channelId}/${target.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delivery: "sideways" }) });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /invalid delivery/);
    assert.equal((await fetch(`${base}/automation-board/${target.channelId}/nope/runs`)).status, 200); // unknown id: empty history, not an error
    assert.equal((await fetch(`${base}/automation-board/CNOPE/x/run`, { method: "POST" })).status, 404);
    const digest = board.automations.find((a) => a.title === "Weekly Make error digest");
    const ack = await fetch(`${base}/automation-board/${digest.channelId}/${digest.id}/acknowledge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(ack.status, 200); assert.equal((await ack.json()).acknowledged, 2);
    const after = await (await fetch(`${base}/automation-board/board?days=30`)).json();
    assert.equal(after.automations.find((a) => a.id === digest.id).health, "healthy");
    const badRun = await fetch(`${base}/automation-board/${digest.channelId}/${digest.id}/acknowledge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: 7 }) });
    assert.equal(badRun.status, 400);
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
  // Slack links open the app (a slack:// deep link to the run's thread), never an arbitrary URL.
  assert.match(body, /"slack:\/\/channel\?team=" \+ team \+ "&id=" \+ channelId/);
  assert.match(body, /"&message=" \+ ts \+ "&thread_ts=" \+ ts/);
  assert.match(body, /span\.innerHTML = "<svg viewBox='0 0 16 16'>" \+ \(ICONS\[name\] \|\| ""\) \+ "<\/svg>"/);
});
