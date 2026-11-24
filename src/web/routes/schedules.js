// Schedule admin routes: list every cron job, edit one, delete one. Split from admin.js;
// mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getChannelsIndex, getUsers } from "../../config/store.js";
import { getSchedules, updateSchedule, deleteSchedule } from "../../config/schedules.js";
import { cronValid } from "../../util/cron.js";
import { costHistoryStart } from "../../ee/cost-history.js";
import { listScheduleRuns, getScheduleRun, scheduleRunSummary, visibleScheduleRun } from "../../gateway/schedule-runs.js";
import { buildSchedulePatch } from "../../config/schedule-patch.js";
import { automationBoard, automationRuns, updateAutomation, runAutomationNow, acknowledgeAutomation, deleteAutomation, consoleChannel, setAutomationRoi, ADMIN_CONSOLE_ACCESS } from "../../gateway/automations-view.js";
import { roiOverview, setSkillRoi, setDefaultRate } from "../../gateway/roi-view.js";
import { adminSession } from "../auth.js";

export function createSchedulesRouter() {
  const router = Router();

  // ── Schedules ────────────────────────────────────────────────────────────────
  // All cron jobs, with their channel's display name attached, for grouping in the UI.
  router.get("/schedules", async (_req, res, next) => {
    try {
      const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
      const historyStart = costHistoryStart();
      const schedules = getSchedules().map((s) => ({
        ...s,
        channelName: scheduleConversationName(s, index[s.channelId], users),
        cronValid: cronValid(s.cron),
        runSummary: scheduleRunSummary(s.id, s.channelId, historyStart),
      }));
      res.json({ schedules });
    } catch (e) {
      next(e);
    }
  });

  // History is independent of live schedules, so deleted and one-time automations remain auditable.
  const history = async (req, res, next) => {
    try {
      const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: "limit must be between 1 and 100" });
      for (const key of ["scheduleId", "channelId", "before"]) {
        if (req.query[key] !== undefined && typeof req.query[key] !== "string") return res.status(400).json({ error: `invalid ${key}` });
      }
      const scheduleId = req.params.id || req.query.scheduleId;
      const channelId = req.query.channelId;
      const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
      const historyStart = costHistoryStart();
      // This page is the schedules' own history: without a schedule id it lists scheduled runs
      // only (HTTP API runs share the ledger and are read on the Automations page).
      const runs = listScheduleRuns({ scheduleId, channelId, limit, before: req.query.before, scheduledOnly: !scheduleId }).map((run) => ({
        ...visibleScheduleRun(run, historyStart), channelName: scheduleConversationName(run, index[run.channelId], users),
      }));
      res.json({ runs, summary: scheduleId ? scheduleRunSummary(scheduleId, channelId, historyStart) : null, nextBefore: runs.length === limit ? runs.at(-1).id : null });
    } catch (e) { next(e); }
  };
  router.get("/schedules/:id/runs", history);
  router.get("/schedule-runs", history);
  router.get("/schedule-runs/:id", async (req, res, next) => {
    try {
      const run = getScheduleRun(req.params.id);
      if (!run) return res.status(404).json({ error: "unknown automation run" });
      const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
      res.json({ run: { ...visibleScheduleRun(run), channelName: scheduleConversationName(run, index[run.channelId], users) } });
    } catch (e) { next(e); }
  });

  // ── Automation health board ──────────────────────────────────────────────────
  // The same board and actions the Activity dashboard serves its members, with the admin
  // console's scope: every conversation on every platform, every DM, host-access rows included.
  const consoleUser = (req) => adminSession(req)?.account?.userId || "";
  router.get("/automation-board/board", async (req, res, next) => {
    try {
      res.json(await automationBoard(ADMIN_CONSOLE_ACCESS, consoleUser(req), { days: Number(req.query.days) || 7, adminConsole: true }));
    } catch (e) { next(e); }
  });
  const boardAction = (fn) => async (req, res, next) => {
    try {
      const entry = await consoleChannel(String(req.params.channelId));
      res.json(await fn(entry, String(req.params.scheduleId).slice(0, 64), req));
    } catch (e) {
      if (e.userFacing || [400, 403, 404, 409, 429, 503].includes(e.status)) return res.status(e.status || 400).json({ error: e.userFacing ? e.message : e.status === 404 ? "That automation no longer exists." : "Not allowed." });
      next(e);
    }
  };
  // ROI: the same page and inputs as the Activity dashboard, over every conversation.
  router.get("/automation-board/roi", async (req, res, next) => {
    try { res.json(await roiOverview(ADMIN_CONSOLE_ACCESS, consoleUser(req), { days: Number(req.query.days) || 30, adminConsole: true })); }
    catch (e) { next(e); }
  });
  for (const [name, handler] of [["skill", setSkillRoi], ["default", setDefaultRate]]) {
    router.post(`/automation-board/roi/${name}`, async (req, res, next) => {
      try { res.json(await handler(ADMIN_CONSOLE_ACCESS, consoleUser(req), req.body || {})); }
      catch (e) { if (e.userFacing) return res.status(e.status || 400).json({ error: e.message }); next(e); }
    });
  }
  router.post("/automation-board/:channelId/:scheduleId/roi", boardAction((entry, id, req) => setAutomationRoi(ADMIN_CONSOLE_ACCESS, consoleUser(req), entry, id, req.body || {})));
  router.get("/automation-board/:channelId/:scheduleId/runs", boardAction((entry, id, req) => ({ runs: automationRuns(ADMIN_CONSOLE_ACCESS, entry, id, consoleUser(req)) })));
  router.post("/automation-board/:channelId/:scheduleId/update", boardAction(async (entry, id, req) => {
    const schedule = await updateAutomation(ADMIN_CONSOLE_ACCESS, consoleUser(req), entry, id, req.body || {}, { allowSudo: true });
    return { ok: true, enabled: schedule.enabled !== false };
  }));
  router.post("/automation-board/:channelId/:scheduleId/acknowledge", boardAction((entry, id, req) => acknowledgeAutomation(ADMIN_CONSOLE_ACCESS, consoleUser(req), entry, id, req.body || {})));
  router.post("/automation-board/:channelId/:scheduleId/run", boardAction((entry, id, req) => runAutomationNow(ADMIN_CONSOLE_ACCESS, consoleUser(req), entry, id)));
  router.post("/automation-board/:channelId/:scheduleId/delete", boardAction((entry, id, req) => ({ ok: deleteAutomation(ADMIN_CONSOLE_ACCESS, consoleUser(req), entry, id) })));

  router.put("/schedules/:id", async (req, res, next) => {
    try {
      const current = getSchedules().find((schedule) => schedule.id === req.params.id);
      if (!current) return res.status(404).json({ error: "unknown schedule" });
      const { patch, error } = await buildSchedulePatch(current, req.body || {}, { allowSudo: true });
      if (error) return res.status(400).json({ error });
      const updated = updateSchedule(req.params.id, patch, current);
      if (!updated) return res.status(409).json({ error: "The schedule changed while it was being edited. Reload and retry." });
      res.json({ ok: true, schedule: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/schedules/:id", (req, res, next) => {
    try {
      res.json({ ok: deleteSchedule(req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function scheduleConversationName(schedule, entry = {}, users = {}) {
  if (!entry?.isDM) return entry?.name || schedule.slug || schedule.channelId;
  const candidates = [entry.userId, entry.memberId, entry.name?.match(/^dm-(U[A-Z0-9]+)$/i)?.[1], schedule.slug?.match(/^dm-(U[A-Z0-9]+)$/i)?.[1], schedule.createdBy];
  const userId = candidates.find((id) => id && users[id]?.name);
  const name = users[userId]?.name || entry.name;
  return name && !/^dm[-_]/i.test(name) && name !== schedule.channelId ? `DM · ${name}` : "Direct message";
}

export { scheduleConversationName };
