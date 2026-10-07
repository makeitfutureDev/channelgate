// Schedule admin routes: list every cron job, edit one, delete one. Split from admin.js;
// mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getChannelsIndex, getUsers } from "../../config/store.js";
import { getSchedules, updateSchedule, deleteSchedule } from "../../config/schedules.js";
import { cronValid, minIntervalMinutes } from "../../util/cron.js";
import { settingsForApi } from "../../config/settings.js";
import { listScheduleRuns, getScheduleRun, scheduleRunSummary } from "../../gateway/schedule-runs.js";
import { validateScheduleOptions } from "../../config/schedule-options.js";

export function createSchedulesRouter() {
  const router = Router();

  // ── Schedules ────────────────────────────────────────────────────────────────
  // All cron jobs, with their channel's display name attached, for grouping in the UI.
  router.get("/schedules", async (_req, res, next) => {
    try {
      const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
      const schedules = getSchedules().map((s) => ({
        ...s,
        channelName: scheduleConversationName(s, index[s.channelId], users),
        cronValid: cronValid(s.cron),
        runSummary: scheduleRunSummary(s.id, s.channelId),
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
      const runs = listScheduleRuns({ scheduleId, channelId, limit, before: req.query.before }).map((run) => ({
        ...run, channelName: scheduleConversationName(run, index[run.channelId], users),
      }));
      res.json({ runs, summary: scheduleId ? scheduleRunSummary(scheduleId, channelId) : null, nextBefore: runs.length === limit ? runs.at(-1).id : null });
    } catch (e) { next(e); }
  };
  router.get("/schedules/:id/runs", history);
  router.get("/schedule-runs", history);
  router.get("/schedule-runs/:id", async (req, res, next) => {
    try {
      const run = getScheduleRun(req.params.id);
      if (!run) return res.status(404).json({ error: "unknown automation run" });
      const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
      res.json({ run: { ...run, channelName: scheduleConversationName(run, index[run.channelId], users) } });
    } catch (e) { next(e); }
  });

  router.put("/schedules/:id", (req, res, next) => {
    try {
      const current = getSchedules().find((schedule) => schedule.id === req.params.id);
      if (!current) return res.status(404).json({ error: "unknown schedule" });
      const patch = {};
      if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
      if (Object.hasOwn(req.body || {}, "cron")) {
        if (typeof req.body.cron !== "string" || !cronValid(req.body.cron)) {
          return res.status(400).json({ error: "enter a valid five-field cron schedule" });
        }
        const floor = settingsForApi().scheduleMinIntervalMinutes;
        const gap = minIntervalMinutes(req.body.cron);
        if (gap !== null && gap < floor) return res.status(400).json({ error: `cron fires every ~${gap} min; minimum is ${floor} min` });
        patch.cron = req.body.cron;
      }
      if (Object.hasOwn(req.body || {}, "runAt")) {
        if (!current.once) return res.status(400).json({ error: "run time can only be changed for one-time schedules" });
        const parsed = new Date(req.body.runAt);
        if (typeof req.body.runAt !== "string" || !req.body.runAt || Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: "enter a valid run date and time" });
        }
        patch.runAt = parsed.toISOString();
      }
      if (Object.hasOwn(req.body || {}, "prompt")) {
        if (typeof req.body.prompt !== "string" || !req.body.prompt.trim()) {
          return res.status(400).json({ error: "prompt cannot be empty" });
        }
        patch.prompt = req.body.prompt;
      }
      if (typeof req.body?.description === "string") patch.description = req.body.description;
      if (Object.hasOwn(req.body || {}, "notify") && !["channel", "user", "none"].includes(req.body.notify)) {
        return res.status(400).json({ error: "invalid notification setting" });
      }
      if (["channel", "user", "none"].includes(req.body?.notify)) patch.notify = req.body.notify;
      if (typeof req.body?.notifyUserId === "string") patch.notifyUserId = req.body.notifyUserId.replace(/[<@>]/g, "").trim();
      const nextNotify = patch.notify ?? current.notify;
      const nextNotifyUserId = patch.notifyUserId ?? current.notifyUserId;
      if (nextNotify === "user" && !nextNotifyUserId) return res.status(400).json({ error: "choose a person to notify" });
      for (const [key, allowed] of [["executionVisibility", ["visible", "silent"]], ["resultPolicy", ["always", "on-result"]]]) {
        if (Object.hasOwn(req.body || {}, key)) {
          if (!allowed.includes(req.body[key])) return res.status(400).json({ error: `invalid ${key}` });
          patch[key] = req.body[key];
        }
      }
      if (Object.hasOwn(req.body || {}, "failureNotify")) {
        if (typeof req.body.failureNotify !== "boolean") return res.status(400).json({ error: "failureNotify must be a boolean" });
        patch.failureNotify = req.body.failureNotify;
      }
      if (Object.hasOwn(req.body || {}, "deliveryThread")) {
        if (typeof req.body.deliveryThread !== "string" || req.body.deliveryThread.length > 500 || /[\r\n\x00]/.test(req.body.deliveryThread)) return res.status(400).json({ error: "enter a valid delivery thread ID" });
        patch.deliveryThread = req.body.deliveryThread;
      }
      if (Object.hasOwn(req.body || {}, "delivery") && !["standard", "daily-thread", "channel", "dm-on-match", "thread"].includes(req.body.delivery)) {
        return res.status(400).json({ error: "invalid delivery setting" });
      }
      if (["standard", "daily-thread", "channel", "dm-on-match", "thread"].includes(req.body?.delivery)) {
        if (req.body.delivery === "thread" && current.kind === "reminder") return res.status(400).json({ error: "existing-thread delivery requires a task schedule" });
        if (req.body.delivery === "daily-thread" && (current.kind === "reminder" || current.once)) {
          return res.status(400).json({ error: "daily-thread delivery requires a recurring task schedule" });
        }
        if (req.body.delivery === "dm-on-match" && (current.kind === "reminder" || !current.createdBy || !current.matchPrefix)) {
          return res.status(400).json({ error: "DM on match requires a task with a creator and a match prefix" });
        }
        patch.delivery = req.body.delivery;
        patch.dailyThreadDate = "";
        patch.dailyThreadTs = "";
      }
      const optionsError = validateScheduleOptions({ ...current, ...patch });
      if (optionsError) return res.status(400).json({ error: optionsError });
      const updated = updateSchedule(req.params.id, patch);
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
