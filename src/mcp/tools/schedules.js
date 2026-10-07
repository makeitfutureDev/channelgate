// Scheduling tools for the gateway control MCP server: create/list/delete this channel's
// recurring (cron) and one-time schedules. Split out of gateway-server.js — registered via
// register(server, ctx); the tool contracts are unchanged.
import { z } from "zod";
import { addSchedule, listForChannel, updateSchedule, deleteSchedule, countEnabledForChannel } from "../../config/schedules.js";
import { listScheduleRuns, getScheduleRun, scheduleRunSummary } from "../../gateway/schedule-runs.js";
import { validateScheduleOptions } from "../../config/schedule-options.js";
import { cronValid, minIntervalMinutes, nextCronRun } from "../../util/cron.js";
import { daemonTimeZone, isUtcZone, zonedStamp } from "../../util/timezone.js";
import { getScheduleMinIntervalMinutes, getScheduleMaxPerChannel } from "../../config/settings.js";

// Every schedule time in this file is the DAEMON's wall clock (the scheduler tick evaluates crons
// against it). The zone has to travel WITH the time or it gets relabelled on the way to the user:
// the channel container's own clock was Etc/UTC, and a `15 9 * * 1-5` cron was reported live as
// "9:15 UTC" for a schedule that fires 09:15 in Bucharest (QA ART-002). The container runtime now
// exports the daemon's TZ too, but a stated zone is what makes the reply verifiable rather than a
// second thing that has to be configured right. The stamps name the zone; this sentence tells the
// agent to keep the name when it repeats them.
export function zoneHint() {
  const tz = daemonTimeZone();
  if (!tz || isUtcZone(tz)) return "";
  return ` (Times are the gateway's local zone, ${tz} — say the zone when you tell the user, and don't convert it.)`;
}

export function register(server, ctx) {
  const { channelId, slug, createdBy, text } = ctx;

  // ── Scheduling (any allowed user) ──────────────────────────────────────────────
  server.registerTool(
    "create_schedule",
    {
      description:
        "Schedule a task in THIS channel — either RECURRING (cron) or ONE-TIME (run once, then it " +
        "auto-deletes). For a fixed interval, pass `interval_days` (1–365; first run after that many days). " +
        "For recurring cron, pass `cron`, a 5-field expression 'minute hour day-of-month " +
        "month day-of-week' (e.g. '0 9 * * *' = every day 09:00; '0 9 * * 1' = Mondays 09:00). Times are " +
        "the GATEWAY's local zone — never assume UTC: the reply names the zone and the next fire " +
        "time, and that is what you quote to the user. For a one-time reminder/task, pass " +
        "`in_minutes` (run N minutes from now — e.g. " +
        "120 for 'in 2 hours') OR `run_at` (an ISO-8601 local datetime like '2026-06-26T15:30'); leave " +
        "`cron` empty. `prompt` is what to do; `description` is the title in the 'Running:' " +
        "announcement. It runs as YOU (your tokens/mode) in this channel's folder. LEAVE `notify` AND " +
        "`delivery` UNSET unless the user explicitly asked for them: the defaults (`notify:'channel'` = " +
        "@channel in the run's own thread; `delivery:'standard'` = a 'Running:' announcement with the " +
        "result threaded beneath it) are what a plain 'remind me' / 'every morning do X' means. " +
        "`notify:'user'` (pass a Slack user id in `notify_user`) or `notify:'none'` only when the user " +
        "asked for that person or for silence. `delivery:'channel'` (result posted top-level, no thread) " +
        "and `delivery:'daily-thread'` (one top-level Running message per server-local day, every run " +
        "threaded beneath it; recurring tasks only) are opt-in, only when the user asked for them. " +
        "`delivery:'dm-on-match'` needs `match_prefix`: no routine messages or failure posts; only a result beginning with that prefix is DM'd to the creator, then the schedule stops. Failures remain visible in schedule status. " +
        "Use execution_visibility:'silent' to omit startup announcements, independently of the destination. " +
        "Use result_policy:'on-result' to suppress only explicitly reported healthy no-op checks; unreported outcomes are never success. " +
        "failure_notify:false hides failure posts but keeps errors in run history. delivery:'thread' sends results to delivery_thread (defaults to THIS thread), with a fresh agent session per fire. " +
        "Every task receives a structured outcome-report instruction automatically; history exposes engine completion separately from agent-reported task success and connections. " +
        "schedules must fire no more often than the configured minimum interval (default 60 min). " +
        "Set `kind:'reminder'` to post a SINGLE reminder message instead of running a Claude session " +
        "(no token cost, no restatement). With `ack:true` the reminder requires a ✅: if nobody reacts " +
        "within `ack_escalate_minutes` (default 120) a 2nd notice is posted, then after `ack_dm_minutes` " +
        "(default 60) more the creator is DM'd and the chain closes; a ✅ at any time closes it.",
      inputSchema: {
        execution_visibility: z.enum(["visible", "silent"]).optional(),
        result_policy: z.enum(["always", "on-result"]).optional(),
        failure_notify: z.boolean().optional(),
        delivery_thread: z.string().optional(),
        cron: z.string().optional(),
        interval_days: z.number().int().positive().optional(),
        in_minutes: z.number().optional(),
        run_at: z.string().optional(),
        prompt: z.string(),
        description: z.string().optional(),
        notify: z.enum(["channel", "user", "none"]).optional(),
        notify_user: z.string().optional(),
        delivery: z.enum(["standard", "daily-thread", "channel", "dm-on-match", "thread"]).optional(),
        match_prefix: z.string().optional(),
        kind: z.enum(["task", "reminder"]).optional(),
        ack: z.boolean().optional(),
        ack_escalate_minutes: z.number().optional(),
        ack_dm_minutes: z.number().optional(),
      },
    },
    async ({ execution_visibility, result_policy, failure_notify, delivery_thread, cron, interval_days, in_minutes, run_at, prompt, description, notify, notify_user, delivery, match_prefix, kind, ack, ack_escalate_minutes, ack_dm_minutes }) => {
      if (!channelId) return text("No channel context — cannot schedule here.");
      const deliveryThread = delivery === "thread" ? String(delivery_thread || ctx.threadKey || "").trim() : "";
      const optionError = validateTaskOptions({ ...argumentsToOptions({ execution_visibility, result_policy, failure_notify, delivery_thread: deliveryThread }), delivery }, kind || "task", channelId);
      if (optionError) return text(optionError);
      const taskOptions = { executionVisibility: execution_visibility, resultPolicy: result_policy, failureNotify: failure_notify, deliveryThread };
      const mode = notify || "channel";
      // The HTTP run API principal is not a person to ping: an API-created user-mode schedule must
      // name its recipient.
      const notifyUserId = mode === "user" ? String(notify_user || "").replace(/[<@>]/g, "").trim() || (ctx.apiPrincipal ? "" : createdBy) : "";
      if (mode === "user" && !notifyUserId) return text("notify \"user\" needs notify_user (a Slack user id) when the schedule is created from an HTTP API run.");
      const who = mode === "channel" ? "@channel" : mode === "user" ? `<@${notifyUserId}>` : "(quiet, no ping)";

      // Reminder-kind fields (no-op for a plain task): a single posted message + optional ✅ chain.
      const reminderFields = {
        kind: kind || "task",
        ack: kind === "reminder" ? Boolean(ack) : false,
        escalateAfterMin: ack_escalate_minutes ?? 120,
        dmAfterMin: ack_dm_minutes ?? 60,
        escalationStyle: "thread",
      };

      // Per-channel ceiling on enabled schedules (runaway backstop).
      const maxPer = getScheduleMaxPerChannel();
      if (countEnabledForChannel(channelId) >= maxPer) {
        return text(`This channel already has ${maxPer} enabled schedules (the limit). Delete one first with delete_schedule.`);
      }

      if (delivery === "dm-on-match" && (kind === "reminder" || !createdBy || !String(match_prefix || "").trim())) {
        return text("dm-on-match requires a task, a requesting user, and a nonempty match_prefix. Only matching results are DM'd; routine checks and errors stay in the schedule status.");
      }
      if (interval_days !== undefined) {
        if (!Number.isInteger(interval_days) || interval_days < 1 || interval_days > 365 || cron || in_minutes || run_at || kind === "reminder" || delivery === "daily-thread") {
          return text("interval_days requires 1–365 days, a task, and no cron, in_minutes, run_at, or daily-thread delivery.");
        }
        const when = new Date(Date.now() + interval_days * 24 * 60 * 60_000);
        const s = addSchedule({ channelId, slug, prompt, description, createdBy, notify: mode, notifyUserId, delivery,
          matchPrefix: String(match_prefix || "").trim(), intervalDays: interval_days, runAt: when.toISOString(), ...reminderFields, ...taskOptions });
        return text(`${optionsHint(s)}✅ Scheduled (id ${s.id}): "${description || prompt}" — every ${interval_days} days, next run ${zonedStamp(when)}${delivery === "dm-on-match" ? `; only results beginning with ${JSON.stringify(s.matchPrefix)} are DM'd to the creator, then checks stop` : `, notifies ${who}`}.${zoneHint()}`);
      }

      // One-time mode: in_minutes or run_at given → fire once, then auto-delete.
      const oneTime = (typeof in_minutes === "number" && in_minutes > 0) || (typeof run_at === "string" && run_at.trim());
      if (oneTime) {
        if (delivery === "daily-thread") return text("Daily-thread delivery is only available for recurring task schedules.");
        let when;
        if (typeof in_minutes === "number" && in_minutes > 0) when = new Date(Date.now() + in_minutes * 60_000);
        else when = new Date(run_at);
        if (!Number.isFinite(when.getTime())) return text(`Couldn't parse the time. Use \`in_minutes\` (e.g. 120) or \`run_at\` ISO like "2026-06-26T15:30".`);
        if (when.getTime() <= Date.now() - 60_000) return text("That time is in the past — pick a future time.");
        const s = addSchedule({ channelId, slug, prompt, description, createdBy, notify: mode, notifyUserId, delivery, matchPrefix: String(match_prefix || "").trim(), runAt: when.toISOString(), once: true, ...reminderFields, ...taskOptions });
        const what = reminderFields.kind === "reminder" ? "One-time reminder" : "One-time task";
        // The stamp NAMES the zone and gives the UTC equivalent, so the reply cannot be relabelled
        // by an agent that formats the instant against some other clock (QA ART-002).
        return text(`${optionsHint(s)}✅ ${what} scheduled (id ${s.id}) for ${zonedStamp(when)}: "${description || prompt}", notifies ${who}${reminderFields.ack ? " · requires ✅" : ""}.${zoneHint()}`);
      }

      // Recurring mode: require a valid cron and enforce the minimum-interval floor.
      if (!cron || !cronValid(cron)) return text(`Invalid cron "${cron || ""}". Use 5 fields (e.g. "0 9 * * *"), or pass in_minutes/run_at for a one-time task.`);
      if (delivery === "daily-thread" && kind === "reminder") return text("Daily-thread delivery is only available for task schedules, not reminders.");
      const floor = getScheduleMinIntervalMinutes();
      const gap = minIntervalMinutes(cron);
      if (gap !== null && gap < floor) {
        return text(`That cron fires every ~${gap} min, which is more often than the ${floor}-min minimum for gateway schedules. For a short-interval check that stays in THIS thread ("every few minutes until X"), use your harness's own loop pacing (the /loop skill: ScheduleWakeup or CronCreate — the gateway re-arms the thread; see the gateway-usage reference loops.md). Otherwise use a less frequent schedule (e.g. hourly "0 * * * *") or a one-time task.`);
      }
      const s = addSchedule({ channelId, slug, cron, prompt, description, createdBy, notify: mode, notifyUserId, delivery, matchPrefix: String(match_prefix || "").trim(), ...reminderFields, ...taskOptions });
      const what = reminderFields.kind === "reminder" ? "Reminder" : "Scheduled";
      const next = nextCronRun(cron);
      const nextText = next ? ` · next run ${zonedStamp(next)}` : "";
      return text(`${optionsHint(s)}✅ ${what} (id ${s.id}): "${description || prompt}" — cron \`${cron}\`${nextText}, notifies ${who}${s.delivery === "daily-thread" ? " · one thread per day" : s.delivery === "channel" ? " · posts directly in channel" : ""}${reminderFields.ack ? " · requires ✅" : ""}.${zoneHint()}`);
    }
  );

  server.registerTool(
    "list_schedules",
    { description: "List the scheduled tasks in this channel.", inputSchema: {} },
    async () => {
      const list = listForChannel(channelId);
      if (!list.length) return text("No schedules in this channel.");
      return text(
        list
          .map((s) => `• ${s.id} [${s.enabled ? "on" : "off"}] ${s.intervalDays ? `every ${s.intervalDays} days · next ${zonedStamp(new Date(s.runAt))}` : `cron \`${s.cron}\``} — ${s.description || s.prompt} (${s.executionVisibility || "visible"}; ${s.resultPolicy || "always"}; last ${s.lastStatus || "not run"}; ${s.delivery === "dm-on-match" ? `DM creator only on ${JSON.stringify(s.matchPrefix)}` : `notifies ${s.notify === "user" ? `<@${s.notifyUserId}>` : s.notify || "channel"}${s.delivery === "daily-thread" ? ", one thread/day" : s.delivery === "channel" ? ", direct in channel" : ""}`})`)
          .join("\n") + (zoneHint() ? `\n${zoneHint().trim()}` : "")
      );
    }
  );


  server.registerTool("get_schedule_runs", {
    description: "Read this channel's automation health history and logs (including deleted/one-time schedules). Engine facts and agent-reported task/connection outcomes are separate. History is retained for 90 days; no historical backfill.",
    inputSchema: { schedule_id: z.string().optional(), run_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), before: z.string().optional() },
  }, async ({ schedule_id, run_id, limit, before }) => {
    if (!channelId) return text("No channel context.");
    if (run_id) return text(JSON.stringify(getScheduleRun(run_id, channelId) || { error: "No run in this channel." }));
    return text(JSON.stringify({ summary: scheduleRunSummary(schedule_id, channelId), runs: listScheduleRuns({ scheduleId: schedule_id, channelId, limit, before }) }));
  });

  server.registerTool("update_schedule", {
    description: "Change visibility, result-only filtering, error notifications or delivery for an existing task in THIS channel. Existing engine sessions remain fresh per fire. Use get_schedule_runs to inspect health.",
    inputSchema: { id: z.string(), execution_visibility: z.enum(["visible", "silent"]).optional(), result_policy: z.enum(["always", "on-result"]).optional(), failure_notify: z.boolean().optional(),
      delivery: z.enum(["standard", "daily-thread", "channel", "dm-on-match", "thread"]).optional(), delivery_thread: z.string().optional() },
  }, async ({ id, ...options }) => {
    const current = listForChannel(channelId).find((s) => s.id === id);
    if (!channelId || !current) return text("No schedule in this channel.");
    const patch = argumentsToOptions(options);
    if (patch.delivery === "thread" && !patch.deliveryThread) patch.deliveryThread = ctx.threadKey || "";
    const next = { ...current, ...patch };
    const error = validateTaskOptions(next, current.kind, channelId);
    if (error) return text(error);
    if (next.delivery === "daily-thread" && current.once) return text("Daily-thread delivery requires a recurring task.");
    if (next.delivery === "dm-on-match" && (!current.createdBy || !current.matchPrefix)) return text("DM on match requires a creator and match prefix.");
    if (patch.delivery && patch.delivery !== current.delivery) Object.assign(patch, { dailyThreadDate: "", dailyThreadTs: "" });
    const updated = updateSchedule(id, patch);
    return text(`Updated ${id}: ${updated.executionVisibility || "visible"}, ${updated.resultPolicy || "always"}, delivery ${updated.delivery}, failure messages ${updated.failureNotify !== false ? "on" : "off"}.`);
  });

  server.registerTool(
    "delete_schedule",
    { description: "Delete a scheduled task in this channel by its id.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const ok = deleteSchedule(id, channelId);
      return text(ok ? `🗑️ Deleted schedule ${id}.` : `No schedule ${id} in this channel.`);
    }
  );
}

function argumentsToOptions(o) {
  const mapping = { execution_visibility: "executionVisibility", result_policy: "resultPolicy", failure_notify: "failureNotify", delivery_thread: "deliveryThread", delivery: "delivery" };
  return Object.fromEntries(Object.entries(o).filter(([key, value]) => Object.hasOwn(mapping, key) && value !== undefined).map(([key, value]) => [mapping[key], value]));
}

function validateTaskOptions(options, kind, channelId) {
  return validateScheduleOptions({ ...options, kind, channelId });
}

function optionsHint(s) {
  if (s.executionVisibility !== "silent" && s.resultPolicy !== "on-result" && s.delivery !== "thread" && s.failureNotify !== false) return "";
  return `Run options: ${s.executionVisibility}, ${s.resultPolicy}, ${s.delivery}${s.deliveryThread ? ` (${s.deliveryThread})` : ""}; failure messages ${s.failureNotify ? "on" : "off"}.\n`;
}
