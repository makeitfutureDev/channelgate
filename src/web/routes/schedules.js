// Schedule admin routes: list every cron job, edit one, delete one. Split from admin.js;
// mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { getChannelsIndex, getUsers } from "../../config/store.js";
import { getSchedules, updateSchedule, deleteSchedule } from "../../config/schedules.js";
import { cronValid, minIntervalMinutes } from "../../util/cron.js";
import { settingsForApi } from "../../config/settings.js";

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
      }));
      res.json({ schedules });
    } catch (e) {
      next(e);
    }
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
      if (Object.hasOwn(req.body || {}, "delivery") && !["standard", "daily-thread", "channel"].includes(req.body.delivery)) {
        return res.status(400).json({ error: "invalid delivery setting" });
      }
      if (["standard", "daily-thread", "channel"].includes(req.body?.delivery)) {
        if (req.body.delivery === "daily-thread" && (current.kind === "reminder" || current.once)) {
          return res.status(400).json({ error: "daily-thread delivery requires a recurring task schedule" });
        }
        patch.delivery = req.body.delivery;
        patch.dailyThreadDate = "";
        patch.dailyThreadTs = "";
      }
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
  const candidates = [entry.userId, entry.memberId, schedule.slug?.match(/^dm-(U[A-Z0-9]+)$/i)?.[1], schedule.createdBy];
  const userId = candidates.find((id) => id && users[id]?.name);
  const name = users[userId]?.name || entry.name;
  return name && !/^dm[-_]/i.test(name) && name !== schedule.channelId ? `DM · ${name}` : "Direct message";
}

export { scheduleConversationName };
