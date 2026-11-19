// The Activity dashboard's Automations page: which conversations a viewer may inspect, the
// automations (schedules, reminders, thread loops) of one of them in plain words, their run
// history, and deletion. Access is the dashboard's own rule (accessContext().allows), re-checked
// on every request; a schedule row is always looked up INSIDE the checked channel.
import { listChannels, getChannelEntry, getChannelMeta } from "../config/store.js";
import { listForChannel, deleteSchedule } from "../config/schedules.js";
import { listScheduleRuns, scheduleRunSummary, visibleScheduleRun } from "./schedule-runs.js";
import { costHistoryStart } from "../ee/cost-history.js";
import { scheduleNextRun } from "../mcp/tools/schedules.js";
import { parseCron } from "../util/cron.js";
import { daemonTimeZone, isUtcZone, zonedStamp } from "../util/timezone.js";
import { platformOfConversation } from "../platforms/ids.js";
import { activityChannelName } from "../slack/home-threads.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isDM = (entry) => Boolean(entry?.isDM || entry?.type === "im" || /^D[A-Z0-9]+$/.test(entry?.channelId || ""));

const list = (items) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const clock = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const sorted = (set) => [...set].sort((a, b) => a - b);
const full = (set, min, max) => set.size === max - min + 1;
// Ascending values with one constant gap starting at the field minimum: "every N".
function stepOf(values, min) {
  if (values.length < 2 || values[0] !== min) return 0;
  const step = values[1] - values[0];
  return values.every((v, i) => v === min + i * step) ? step : 0;
}
function dayWords(days) {
  const d = sorted(days);
  if (d.join() === "1,2,3,4,5") return "on weekdays";
  if (d.join() === "0,6") return "on weekends";
  return `on ${list(d.map((x) => DAYS[x]))}`;
}

// Plain-language recurrence for a 5-field cron, in the daemon's zone. Never echoes the
// expression: anything it cannot phrase becomes "On a custom schedule".
export function cronToWords(expr, { tz = daemonTimeZone() } = {}) {
  const sets = parseCron(expr);
  if (!sets) return "On a custom schedule";
  const [min, hour, dom, mon, dow] = sets;
  const mins = sorted(min), hours = sorted(hour);
  let time;
  if (full(min, 0, 59) && full(hour, 0, 23)) time = "Every minute";
  else if (full(hour, 0, 23) && stepOf(mins, 0)) time = `Every ${stepOf(mins, 0)} minutes`;
  else if (full(hour, 0, 23) && mins.length === 1) time = mins[0] === 0 ? "Every hour, on the hour" : `Every hour at ${mins[0]} past`;
  else if (mins.length === 1 && stepOf(hours, 0) > 1) time = `Every ${stepOf(hours, 0)} hours${mins[0] ? ` at ${mins[0]} past` : ""}`;
  else if (hours.length * mins.length <= 6) time = `At ${list(hours.flatMap((h) => mins.map((m) => clock(h, m))))}`;
  else if (mins.length === 1) time = `Every hour from ${clock(hours[0], mins[0])} to ${clock(hours.at(-1), mins[0])}`;
  else return "On a custom schedule";
  const domAll = full(dom, 1, 31), dowAll = dow.size === 7, monAll = full(mon, 1, 12);
  const parts = [time];
  if (!domAll && !dowAll) parts.push(`on day ${list(sorted(dom).map(ordinal))} of the month or ${dayWords(dow).slice(3)}`);
  else if (!domAll) parts.push(`on the ${list(sorted(dom).map(ordinal))} of the month`);
  else if (!dowAll) parts.push(dayWords(dow));
  else if (!/^Every (minute|\d+ minutes|hour|\d+ hours)/.test(time)) parts.push("every day");
  if (!monAll) parts.push(`in ${list(sorted(mon).map((m) => MONTHS[m]))}`);
  const zone = String(tz || "").trim();
  const zoned = /^At|from/.test(time) ? ` (${zone && !isUtcZone(zone) ? zone : "UTC"})` : "";
  return parts.join(" ") + zoned;
}

export function recurrenceWords(s, opts) {
  if (s.loop) return "Repeats in its thread until the loop finishes";
  if (s.intervalDays) return s.intervalDays === 1 ? "Every day" : `Every ${s.intervalDays} days`;
  if (s.once || (!s.cron && s.runAt)) return s.runAt ? `Once, on ${zonedStamp(new Date(s.runAt))}` : "Once";
  return cronToWords(s.cron, opts);
}

// The conversations the viewer may open, DM first. Sudo schedules are admin-only.
export async function automationChannels(access, userId) {
  const out = [];
  for (const entry of await listChannels()) {
    if (platformOfConversation(entry.channelId) !== "slack") continue;
    if (!await access.allows(entry)) continue;
    const dm = isDM(entry);
    const meta = dm ? await getChannelMeta(entry.slug) : null;
    if (dm && meta?.dmUserId && meta.dmUserId !== userId) continue; // only the viewer's OWN DM
    const count = listForChannel(entry.channelId).filter((s) => visible(s, access)).length;
    out.push({ channelId: entry.channelId, name: dm ? "Your direct messages (personal)" : `#${await activityChannelName(entry)}`, personal: dm, count });
  }
  return out.sort((a, b) => Number(b.personal) - Number(a.personal) || b.count - a.count || a.name.localeCompare(b.name));
}

const visible = (s, access) => !s.sudo || access.user?.isAdmin === true;

// Throws 403 unless the viewer may see this conversation right now.
export async function checkedChannel(access, userId, channelId) {
  const entry = typeof channelId === "string" && /^[A-Z0-9]{1,32}$/.test(channelId) ? await getChannelEntry(channelId) : null;
  if (!entry || !await access.allows({ ...entry, channelId })) throw Object.assign(new Error("Conversation denied"), { status: 403 });
  if (isDM(entry)) {
    const meta = await getChannelMeta(entry.slug);
    if (meta?.dmUserId && meta.dmUserId !== userId) throw Object.assign(new Error("Conversation denied"), { status: 403 });
  }
  return { ...entry, channelId };
}

const canDelete = (s, access, userId, entry) => access.user?.isAdmin === true || s.createdBy === userId || isDM(entry);

export function channelAutomations(access, userId, entry, now = new Date()) {
  const historyStart = costHistoryStart();
  return listForChannel(entry.channelId).filter((s) => visible(s, access)).map((s) => {
    const next = scheduleNextRun(s, now);
    const summary = scheduleRunSummary(s.id, entry.channelId, historyStart);
    return { id: s.id, title: s.description || (s.kind === "reminder" ? "Reminder" : "Scheduled task"),
      instructions: String(s.prompt || "").slice(0, 4000), kind: s.loop ? "Thread loop" : s.kind === "reminder" ? "Reminder" : "Task",
      recurrence: recurrenceWords(s), enabled: s.enabled !== false, nextRun: next ? zonedStamp(next) : null,
      createdBy: s.createdBy || "", mine: s.createdBy === userId, canDelete: canDelete(s, access, userId, entry),
      runs: { total: summary.total, lastStatus: summary.lastStatus, lastStartedAt: summary.lastStartedAt, successRate: summary.successRate } };
  });
}

const RUN_FIELDS = ["id", "status", "startedAt", "completedAt", "durationMs", "summary", "error", "engine", "model", "costUsd", "deliveryStatus", "taskStatus"];
export function automationRuns(access, entry, scheduleId) {
  const s = listForChannel(entry.channelId).find((x) => x.id === scheduleId);
  if (s && !visible(s, access)) throw Object.assign(new Error("Automation denied"), { status: 403 });
  return listScheduleRuns({ scheduleId, channelId: entry.channelId, limit: 30 })
    .map((r) => visibleScheduleRun(r)).map((r) => Object.fromEntries(RUN_FIELDS.map((k) => [k, r[k] ?? null])));
}

export function deleteAutomation(access, userId, entry, scheduleId) {
  const s = listForChannel(entry.channelId).find((x) => x.id === scheduleId);
  if (!s || !visible(s, access)) throw Object.assign(new Error("Not found"), { status: 404 });
  if (!canDelete(s, access, userId, entry)) throw Object.assign(new Error("Not yours"), { status: 403 });
  return deleteSchedule(scheduleId, entry.channelId);
}
