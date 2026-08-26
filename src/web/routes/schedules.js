// Schedule admin routes: list every cron job, edit one, delete one. Split from admin.js;
// mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getChannelsIndex } from "../../config/store.js";
import { getSchedules, updateSchedule, deleteSchedule } from "../../config/schedules.js";
import { cronValid, minIntervalMinutes } from "../../util/cron.js";
import { settingsForApi } from "../../config/settings.js";

export function createSchedulesRouter() {
  const router = Router();

  // ── Schedules ────────────────────────────────────────────────────────────────
  // All cron jobs, with their channel's display name attached, for grouping in the UI.
  router.get("/schedules", async (_req, res, next) => {
    try {
      const index = await getChannelsIndex();
      const schedules = getSchedules().map((s) => ({
        ...s,
        channelName: index[s.channelId]?.name || s.slug || s.channelId,
        cronValid: cronValid(s.cron),
      }));
      res.json({ schedules });
    } catch (e) {
      next(e);
    }
  });

  router.put("/schedules/:id", (req, res, next) => {
    try {
      const patch = {};
      if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
      if (typeof req.body?.cron === "string" && cronValid(req.body.cron)) {
        const floor = settingsForApi().scheduleMinIntervalMinutes;
        const gap = minIntervalMinutes(req.body.cron);
        if (gap !== null && gap < floor) return res.status(400).json({ error: `cron fires every ~${gap} min; minimum is ${floor} min` });
        patch.cron = req.body.cron;
      }
      if (Object.hasOwn(req.body || {}, "prompt")) {
        if (typeof req.body.prompt !== "string" || !req.body.prompt.trim()) {
          return res.status(400).json({ error: "prompt cannot be empty" });
        }
        patch.prompt = req.body.prompt;
      }
      if (typeof req.body?.description === "string") patch.description = req.body.description;
      if (["channel", "user", "none"].includes(req.body?.notify)) patch.notify = req.body.notify;
      if (typeof req.body?.notifyUserId === "string") patch.notifyUserId = req.body.notifyUserId.replace(/[<@>]/g, "").trim();
      const updated = updateSchedule(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: "unknown schedule" });
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
