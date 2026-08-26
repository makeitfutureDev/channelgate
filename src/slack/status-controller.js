import { getActiveBackgroundJobs } from "../gateway/background.js";
import { listForChannel as listSchedulesForChannel } from "../config/schedules.js";
import { poolStats } from "../engines/session-pool.js";
import { runQueue } from "./message-lifecycle.js";

function fmtAgo(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export async function buildStatusReport(slug, channelId) {
  const parts = [];
  const background = getActiveBackgroundJobs?.();
  const jobs = background?.listForChannel ? background.listForChannel(slug) : [];
  if (jobs.length) {
    parts.push(`*🛠️ Background jobs (${jobs.length})*`);
    for (const job of jobs.slice(0, 10)) parts.push(`• ${job.kind === "agent" ? "🤖 " : ""}${job.label} — running ${fmtAgo(job.runtimeMs)}`);
  }
  let schedules = [];
  try { schedules = listSchedulesForChannel(channelId); } catch { schedules = []; }
  if (schedules.length) {
    parts.push(`*⏰ Scheduled (${schedules.length})*`);
    for (const schedule of schedules.slice(0, 15)) {
      const when = schedule.once || schedule.runAt
        ? `once @ ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`
        : `cron \`${schedule.cron}\``;
      parts.push(`• ${schedule.enabled ? "" : "(off) "}${schedule.description || schedule.prompt || "task"} — ${when}`);
    }
  }
  const warmKeys = (poolStats().keys || []).filter((key) => key.startsWith(`${slug}::`));
  const liveRuns = runQueue.keys()
    .filter((key) => key.startsWith(`${slug}::`))
    .reduce((count, key) => count + runQueue.count(key), 0);
  parts.push(`*⚡ Now*: ${liveRuns} run${liveRuns === 1 ? "" : "s"} in flight · ${warmKeys.length} warm session${warmKeys.length === 1 ? "" : "s"}`);
  if (!jobs.length && !schedules.length && !liveRuns) return "Nothing is running or scheduled in this channel right now. ✨";
  return parts.join("\n");
}
