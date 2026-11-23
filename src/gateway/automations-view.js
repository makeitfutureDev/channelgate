// The Activity dashboard's Automations page: which conversations a viewer may inspect, the
// automations (schedules, reminders, thread loops) of one of them in plain words, their run
// history, and deletion. Access is the dashboard's own rule (accessContext().allows), re-checked
// on every request; a schedule row is always looked up INSIDE the checked channel.
import { listChannels, getChannelEntry, getChannelMeta, getUsers } from "../config/store.js";
import { listForChannel, deleteSchedule, updateSchedule } from "../config/schedules.js";
import { listScheduleRuns, scheduleRunSummary, visibleScheduleRun, scheduleRunsSince } from "./schedule-runs.js";
import { automationHealth, fixSteps } from "./automation-health.js";
import { buildSchedulePatch } from "../config/schedule-patch.js";
import { costHistoryStart } from "../ee/cost-history.js";
import { scheduleNextRun } from "../mcp/tools/schedules.js";
import { parseCron } from "../util/cron.js";
import { daemonTimeZone, isUtcZone, zonedStamp } from "../util/timezone.js";
import { platformOfConversation } from "../platforms/ids.js";
import { activityChannelName } from "../slack/home-threads.js";
import { apiSourcesForChannel, apiSourceRuns, API_SOURCE_PREFIX } from "./api-run-history.js";

// The synthetic conversation of channel-less API runs (api-runs.js API_CHANNEL_ID). Admin-only.
const API_CHANNEL_ID = "cg-api";
const apiSources = (access, userId, channelId) => apiSourcesForChannel(channelId, { isAdmin: access.user?.isAdmin === true, userId });

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
  // Count first: a conversation without automations is never listed, and skipping it here
  // also spares its (possibly Slack-backed) membership check.
  const candidates = [];
  for (const entry of await listChannels()) {
    if (entry.channelId === API_CHANNEL_ID) {
      const sources = access.user?.isAdmin === true ? apiSources(access, userId, API_CHANNEL_ID) : [];
      if (sources.length) out.push({ channelId: API_CHANNEL_ID, name: "API runs without a conversation", personal: false, count: sources.length, failing: sources.filter(apiFailing).length });
      continue;
    }
    if (platformOfConversation(entry.channelId) !== "slack") continue;
    const shown = listForChannel(entry.channelId).filter((s) => visible(s, access));
    const sources = apiSources(access, userId, entry.channelId);
    if (shown.length + sources.length) candidates.push({ entry, shown, sources });
  }
  await access.prefetch?.(candidates.map((c) => c.entry));
  for (const { entry, shown, sources } of candidates) {
    const count = shown.length + sources.length;
    if (!await access.allows(entry)) continue;
    const dm = isDM(entry);
    const meta = dm ? await getChannelMeta(entry.slug) : null;
    if (dm && meta?.dmUserId && meta.dmUserId !== userId) continue; // only the viewer's OWN DM
    const name = String(await activityChannelName(entry)).replace(/^#+/, "");
    out.push({ channelId: entry.channelId, name: dm ? "Your direct messages (personal)" : `#${name}`, personal: dm, count, failing: failingCount(shown, entry.channelId) + sources.filter(apiFailing).length });
  }
  return out.sort((a, b) => Number(b.personal) - Number(a.personal) || b.count - a.count || a.name.localeCompare(b.name));
}

// A run that ended badly: the automations an admin should look at first.
export const FAILED_RUN_STATUSES = new Set(["failed", "blocked", "interrupted"]);
// Enabled automations whose LAST run failed (a paused one is not asking for attention).
function failingCount(schedules, channelId) {
  const historyStart = costHistoryStart();
  return schedules.filter((s) => s.enabled !== false && FAILED_RUN_STATUSES.has(scheduleRunSummary(s.id, channelId, historyStart).lastStatus)).length;
}

const visible = (s, access) => !s.sudo || access.user?.isAdmin === true;
// An API source asks for attention when its latest finished run failed.
const apiFailing = (source) => FAILED_RUN_STATUSES.has(source.runs.lastStatus);

// Throws 403 unless the viewer may see this conversation right now.
export async function checkedChannel(access, userId, channelId) {
  if (channelId === API_CHANNEL_ID) {
    if (access.user?.isAdmin !== true) throw Object.assign(new Error("Conversation denied"), { status: 403 });
    return { channelId, slug: "api", name: "API runs", synthetic: true };
  }
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
  const api = apiSources(access, userId, entry.channelId).map((src) => ({ id: src.id, title: src.title,
    instructions: "", kind: "API", recurrence: src.revoked ? "Started by HTTP API calls · token revoked" : "Started by HTTP API calls",
    enabled: true, nextRun: null, createdBy: "", mine: false, canDelete: false,
    runs: { total: src.runs.total, running: src.runs.running, lastStatus: src.runs.lastStatus, lastStartedAt: src.runs.lastStartedAt, successRate: src.runs.successRate, costUsd: src.runs.costUsd } }));
  if (entry.synthetic) return api;
  return api.concat(listForChannel(entry.channelId).filter((s) => visible(s, access)).map((s) => {
    const next = scheduleNextRun(s, now);
    const summary = scheduleRunSummary(s.id, entry.channelId, historyStart);
    return { id: s.id, title: s.description || (s.kind === "reminder" ? "Reminder" : "Scheduled task"),
      instructions: String(s.prompt || "").slice(0, 4000), successCriteria: String(s.successCriteria || "").slice(0, 2000), kind: s.loop ? "Thread loop" : s.kind === "reminder" ? "Reminder" : "Task",
      recurrence: recurrenceWords(s), posting: postingWords(s), enabled: s.enabled !== false, nextRun: next ? zonedStamp(next) : null,
      createdBy: s.createdBy || "", mine: s.createdBy === userId, canDelete: canDelete(s, access, userId, entry),
      runs: { total: summary.total, lastStatus: summary.lastStatus, lastStartedAt: summary.lastStartedAt, successRate: summary.successRate } };
  }));
}

// How a task shows in chat, in words (schedule options executionVisibility + resultPolicy).
function postingWords(s) {
  if (s.kind === "reminder" || s.loop) return "";
  const start = s.executionVisibility === "silent" ? "Silent start" : "";
  const result = s.resultPolicy === "on-failure" ? "posts only failures" : s.resultPolicy === "on-result" ? "posts only results" : "";
  return [start, result].filter(Boolean).join(", ");
}

const RUN_FIELDS = ["id", "status", "startedAt", "completedAt", "durationMs", "summary", "error", "engine", "model", "costUsd", "deliveryStatus", "taskStatus",
  "errorKind", "deliveryAttempts", "tokensIn", "tokensOut", "toolUseCount", "trigger", "scheduledAt", "engineStatus", "outcomeSource", "connections", "events", "eventsDropped"];
export function automationRuns(access, entry, scheduleId, userId = "") {
  if (scheduleId.startsWith(API_SOURCE_PREFIX)) return apiSourceRuns(entry.channelId, scheduleId, { isAdmin: access.user?.isAdmin === true, userId });
  const s = listForChannel(entry.channelId).find((x) => x.id === scheduleId);
  if (s && !visible(s, access)) throw Object.assign(new Error("Automation denied"), { status: 403 });
  return listScheduleRuns({ scheduleId, channelId: entry.channelId, limit: 30 })
    .map((r) => visibleScheduleRun(r)).map((r) => Object.fromEntries(RUN_FIELDS.map((k) => [k, r[k] ?? null])));
}

// The automation a viewer may CHANGE: visible to them, and theirs to change. An automation runs as
// its creator, so letting anyone else rewrite or start it would run their words with the
// creator's identity and connections. Admins, the creator, and the owner of a DM may.
function ownedSchedule(access, userId, entry, scheduleId) {
  if (scheduleId.startsWith(API_SOURCE_PREFIX)) throw Object.assign(new Error("API runs are started by their API token; revoke the token to stop them."), { status: 400, userFacing: true });
  const s = listForChannel(entry.channelId).find((x) => x.id === scheduleId);
  if (!s || !visible(s, access)) throw Object.assign(new Error("Not found"), { status: 404 });
  if (!canDelete(s, access, userId, entry)) throw Object.assign(new Error("Only the person who created this automation, or an admin, can change it."), { status: 403, userFacing: true });
  return s;
}

export function deleteAutomation(access, userId, entry, scheduleId) {
  if (scheduleId.startsWith(API_SOURCE_PREFIX)) throw Object.assign(new Error("API runs are not deletable; revoke the token instead"), { status: 404 });
  return deleteSchedule(ownedSchedule(access, userId, entry, scheduleId).id, entry.channelId);
}

// Edit or pause/resume. Same validator as the admin console, without the host-access switch
// unless the caller is the admin console itself.
export async function updateAutomation(access, userId, entry, scheduleId, body, { allowSudo = false } = {}) {
  const current = ownedSchedule(access, userId, entry, scheduleId);
  const { patch, error } = await buildSchedulePatch(current, body, { allowSudo });
  if (error) throw Object.assign(new Error(error), { status: 400, userFacing: true });
  if (!Object.keys(patch).length) return current;
  const updated = updateSchedule(current.id, patch, current);
  if (!updated) throw Object.assign(new Error("The automation changed while it was being edited. Reload and try again."), { status: 409, userFacing: true });
  return updated;
}

export async function runAutomationNow(access, userId, entry, scheduleId) {
  const s = ownedSchedule(access, userId, entry, scheduleId);
  const { runScheduleNow } = await import("./scheduler.js");
  runScheduleNow(s.id, { by: userId || "dashboard" });
  return { started: true };
}

// ── The health board ──────────────────────────────────────────────────────────────────────────
const isOneTime = (s) => Boolean(s.once || (s.runAt && !s.intervalDays && !s.cron));
const DELIVERY_WORDS = { standard: "New thread", "daily-thread": "Daily thread", channel: "Channel post", "dm-on-match": "DM on match", thread: "Existing thread" };
export const BOARD_WINDOWS = [1, 7, 30];

function kindOf(s) { return s.loop ? "Thread loop" : s.kind === "reminder" ? "Reminder" : "Task"; }

function scheduleItem(s, conv, ctx) {
  const { access, userId, users, now, sinceMs, historyStart, entry, botName } = ctx;
  const runs = listScheduleRuns({ scheduleId: s.id, channelId: conv.channelId, limit: 30 }).map((r) => visibleScheduleRun(r, historyStart));
  const windowRuns = scheduleRunsSince({ scheduleId: s.id, channelId: conv.channelId, sinceMs }).map((r) => visibleScheduleRun(r, historyStart));
  const health = automationHealth(s, runs, windowRuns);
  const next = scheduleNextRun(s, now);
  const may = canDelete(s, access, userId, entry);
  const kind = kindOf(s);
  const engineRun = runs.find((r) => r.engine || r.model);
  return {
    id: s.id, channelId: conv.channelId, conversation: conv.name, personal: conv.personal, kind,
    title: s.description || (s.kind === "reminder" ? "Reminder" : "Scheduled task"),
    instructions: String(s.prompt || "").slice(0, 20_000), successCriteria: String(s.successCriteria || "").slice(0, 2000),
    recurrence: recurrenceWords(s),
    timing: { cron: s.cron || "", once: isOneTime(s), runAt: s.runAt || null, intervalDays: s.intervalDays || 0, loop: Boolean(s.loop) },
    nextRun: next ? next.toISOString() : null, nextRunText: next ? zonedStamp(next) : null,
    enabled: s.enabled !== false,
    delivery: s.delivery || "standard", deliveryWords: kind === "Reminder" ? "Channel post" : DELIVERY_WORDS[s.delivery || "standard"] || "New thread", posting: postingWords(s),
    resultPolicy: s.resultPolicy || "always", executionVisibility: s.executionVisibility || "visible",
    notify: s.notify || "channel", notifyUserId: s.notifyUserId || "", failureNotify: s.failureNotify !== false,
    hasMatchPrefix: Boolean(s.matchPrefix), deliveryThread: s.deliveryThread || "", sudo: s.sudo === true,
    createdBy: s.createdBy || "", createdByName: users[s.createdBy]?.name || "", mine: Boolean(userId) && s.createdBy === userId,
    canEdit: may, canDelete: may, canRunNow: may && !s.loop,
    engine: engineRun ? { engine: engineRun.engine || "", model: engineRun.model || "" } : null,
    ...health,
    fix: health.problem ? fixSteps(health.problem.key, { kind, once: isOneTime(s), botName }) : [],
  };
}

function apiItem(src, conv, ctx) {
  const { access, userId, sinceMs } = ctx;
  const runs = apiSourceRuns(conv.channelId, src.id, { isAdmin: access.user?.isAdmin === true, userId, limit: 30 });
  const windowRuns = runs.filter((r) => Date.parse(r.startedAt) >= sinceMs);
  const health = automationHealth(null, runs, windowRuns);
  const engineRun = runs.find((r) => r.engine || r.model);
  return {
    id: src.id, channelId: conv.channelId, conversation: conv.name, personal: conv.personal, kind: "API",
    title: src.title, instructions: "", successCriteria: "",
    recurrence: src.revoked ? "Started by HTTP API calls · token revoked" : "Started by HTTP API calls",
    timing: { cron: "", once: false, runAt: null, intervalDays: 0, loop: false }, nextRun: null, nextRunText: null,
    enabled: true, delivery: "", deliveryWords: "API caller", posting: "", resultPolicy: "always", executionVisibility: "visible",
    notify: "none", notifyUserId: "", failureNotify: false, hasMatchPrefix: false, deliveryThread: "", sudo: false,
    createdBy: "", createdByName: "", mine: false, canEdit: false, canDelete: false, canRunNow: false,
    engine: engineRun ? { engine: engineRun.engine || "", model: engineRun.model || "" } : null,
    ...health,
    fix: health.problem ? fixSteps(health.problem.key, { kind: "API" }) : [],
  };
}

// Every automation the viewer may see, with its health verdict, plus the board's totals.
// `adminConsole` is the admin UI: every conversation on every platform, every DM, sudo rows.
// Otherwise it is exactly the Activity dashboard's rule (automationChannels above).
export async function automationBoard(access, userId, { days = 7, now = new Date(), adminConsole = false, botName = "" } = {}) {
  const windowDays = BOARD_WINDOWS.includes(Number(days)) ? Number(days) : 7;
  const sinceMs = now.getTime() - windowDays * 86400_000;
  const users = await getUsers();
  const historyStart = costHistoryStart();
  const automations = [];
  const conversations = [];
  for (const entry of await listChannels()) {
    const isApi = entry.channelId === API_CHANNEL_ID;
    if (isApi && access.user?.isAdmin !== true) continue;
    if (!isApi && !adminConsole && platformOfConversation(entry.channelId) !== "slack") continue;
    const shown = isApi ? [] : listForChannel(entry.channelId).filter((s) => visible(s, access));
    const sources = apiSources(access, userId, entry.channelId);
    if (!shown.length && !sources.length) continue;
    if (!adminConsole && !isApi && !await access.allows(entry)) continue;
    const dm = !isApi && isDM(entry);
    const meta = dm ? await getChannelMeta(entry.slug) : null;
    if (dm && !adminConsole && meta?.dmUserId && meta.dmUserId !== userId) continue;
    let name;
    if (isApi) name = "API runs without a conversation";
    else if (dm) {
      const owner = meta?.dmUserId || entry.userId || "";
      name = adminConsole ? (users[owner]?.name ? `DM · ${users[owner].name}` : "Direct message") : "Your direct messages";
    } else name = `#${String(await activityChannelName(entry)).replace(/^#+/, "")}`;
    const conv = { channelId: entry.channelId, name, personal: dm };
    const ctx = { access, userId, users, now, sinceMs, historyStart, entry: isApi ? { ...entry, channelId: API_CHANNEL_ID } : entry, botName };
    const items = [...sources.map((src) => apiItem(src, conv, ctx)), ...shown.map((s) => scheduleItem(s, conv, ctx))];
    automations.push(...items);
    conversations.push({ ...conv, count: items.length, attention: items.filter((a) => a.attention).length });
  }
  const totals = automations.reduce((t, a) => {
    t.runs += a.stats.runs; t.finished += a.stats.finished; t.succeeded += a.stats.succeeded; t.failed += a.stats.failed;
    t.notDelivered += a.stats.notDelivered; t.costUsd += a.stats.costUsd; return t;
  }, { runs: 0, finished: 0, succeeded: 0, failed: 0, notDelivered: 0, costUsd: 0 });
  const counts = { broken: 0, degraded: 0, healthy: 0, paused: 0 };
  for (const a of automations) counts[a.health] += 1;
  return {
    viewer: { isAdmin: access.user?.isAdmin === true, adminConsole, userId: userId || "" },
    windowDays, generatedAt: now.toISOString(), botName,
    kpis: { ...totals, costUsd: Math.round(totals.costUsd * 100) / 100, successRate: totals.finished ? totals.succeeded / totals.finished : null },
    counts, attention: automations.filter((a) => a.attention).length,
    conversations: conversations.sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name)),
    automations,
  };
}

// The admin console's conversation lookup: any stored conversation, on any platform.
export async function consoleChannel(channelId) {
  if (channelId === API_CHANNEL_ID) return { channelId, slug: "api", name: "API runs", synthetic: true };
  const entry = typeof channelId === "string" && channelId.length <= 200 ? await getChannelEntry(channelId) : null;
  if (!entry) throw Object.assign(new Error("Unknown conversation"), { status: 404 });
  return { ...entry, channelId };
}

// The admin console's access: every conversation, every row, sudo included.
export const ADMIN_CONSOLE_ACCESS = Object.freeze({ user: Object.freeze({ isAdmin: true }), allows: async () => true });
