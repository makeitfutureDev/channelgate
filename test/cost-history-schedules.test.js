import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { addSchedule } = await import("../src/config/schedules.js");
const { getScheduleRun, listScheduleRuns, updateScheduleRun, appendScheduleRunEvent, scheduleRunSummary } = await import("../src/gateway/schedule-runs.js");
const { createSchedulesRouter } = await import("../src/web/routes/schedules.js");
const { register } = await import("../src/mcp/tools/schedules.js");

test("schedule HTTP and MCP costs obey history windows while operational history and raw updates survive", async t => {
  const now = Date.now();
  const db = getDb();
  const schedule = addSchedule({ channelId: "CHISTORY", slug: "history", cron: "0 9 * * *", prompt: "Check health", createdBy: "UHISTORY", notify: "none" });
  const cases = [["old", now - 45 * 86400000, 10], ["recent", now - 86400000, 2], ["unknown", null, 100]];
  for (const [id, timestamp, cost] of cases) {
    const run = { id, scheduleId: schedule.id, channelId: "CHISTORY", startedAt: timestamp ? new Date(timestamp).toISOString() : "invalid", completedAt: timestamp ? new Date(timestamp + 1000).toISOString() : null, status: "succeeded", engineStatus: "completed", deliveryStatus: "delivered", costUsd: cost, costEstimated: true, summary: "Keep $10 in report", events: [] };
    db.prepare("INSERT INTO schedule_runs(id,schedule_id,channel_id,started_ms,status,data) VALUES(?,?,?,?,?,?)").run(id, schedule.id, run.channelId, timestamp || 0, run.status, JSON.stringify(run));
  }
  const handlers = new Map();
  register({ registerTool: (name, config, fn) => handlers.set(name, fn) }, { channelId: "CHISTORY", text: value => value });
  const mcp = async args => JSON.parse(await handlers.get("get_schedule_runs")(args));
  const app = express(); app.use(createSchedulesRouter());
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  for (const tier of ["free", "enterprise", "free"]) {
    testLicenseEnv({ tier });
    const free = tier === "free";
    const expectedTotal = free ? 2 : 112;
    const listing = await get(`/schedules/${schedule.id}/runs`);
    const all = await get("/schedule-runs");
    const tool = await mcp({ schedule_id: schedule.id });
    const embedded = (await get("/schedules")).schedules.find(s => s.id === schedule.id).runSummary;
    for (const summary of [listing.summary, tool.summary, embedded, scheduleRunSummary(schedule.id, "CHISTORY")]) {
      assert.equal(summary.totalCostUsd, expectedTotal);
      assert.equal(summary.total, 3);
      assert.equal(summary.succeeded, 3);
      assert.equal(summary.retentionDays, 90);
      assert.equal(summary.costHistoryDays, free ? 30 : null);
    }
    for (const [id, , cost] of cases) {
      const detail = (await get(`/schedule-runs/${id}`)).run;
      const toolDetail = await mcp({ run_id: id });
      for (const run of [detail, toolDetail, ...[listing, all, tool].map(r => r.runs.find(x => x.id === id))]) {
        assert.equal(run.costUsd, !free || id === "recent" ? cost : null);
        assert.equal(run.status, "succeeded");
        assert.equal(run.summary, "Keep $10 in report");
      }
    }
    updateScheduleRun("old", { summary: "Updated operational summary" });
    appendScheduleRunEvent("old", { kind: "completed" });
    assert.equal(getScheduleRun("old").costUsd, 10);
    assert.equal(listScheduleRuns({ scheduleId: schedule.id }).find(r => r.id === "old").costUsd, 10);
    assert.ok(getScheduleRun("old").events.length);
    updateScheduleRun("old", { summary: "Keep $10 in report" });
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_runs").get().n, 3);
});
