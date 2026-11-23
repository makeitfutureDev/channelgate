// One validator for every automation edit, so the admin console and the Activity dashboard
// accept exactly the same changes. Returns { patch } or { error } and never mutates `current`.
// `allowSudo` is the admin console only: a member's dashboard can never flip the host posture.
import { isAdmin } from "./store.js";
import { cronValid, minIntervalMinutes } from "../util/cron.js";
import { settingsForApi } from "./settings.js";
import { validateScheduleOptions } from "./schedule-options.js";
import { normalizeSuccessCriteria } from "../gateway/schedule-outcome.js";

const DELIVERIES = ["standard", "daily-thread", "channel", "dm-on-match", "thread"];
const has = (body, key) => Object.hasOwn(body, key);

export async function buildSchedulePatch(current, rawBody, { allowSudo = false } = {}) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const patch = {};
  if (has(body, "sudo")) {
    if (!allowSudo) return { error: "Only an organization admin can change host access from the admin console." };
    if (typeof body.sudo !== "boolean") return { error: "sudo must be a boolean" };
    patch.sudo = body.sudo;
  }
  if ((patch.sudo ?? current.sudo) && !(await isAdmin(current.createdBy))) {
    return { error: "A sudo schedule's creator must currently be an organization admin." };
  }
  if (has(body, "enabled")) {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be a boolean" };
    patch.enabled = body.enabled;
  }
  if (has(body, "cron")) {
    if (typeof body.cron !== "string" || !cronValid(body.cron)) return { error: "enter a valid five-field cron schedule" };
    const floor = settingsForApi().scheduleMinIntervalMinutes;
    const gap = minIntervalMinutes(body.cron);
    if (gap !== null && gap < floor) return { error: `cron fires every ~${gap} min; minimum is ${floor} min` };
    patch.cron = body.cron;
  }
  if (has(body, "runAt")) {
    if (!current.once) return { error: "run time can only be changed for one-time schedules" };
    const parsed = new Date(body.runAt);
    if (typeof body.runAt !== "string" || !body.runAt || Number.isNaN(parsed.getTime())) return { error: "enter a valid run date and time" };
    patch.runAt = parsed.toISOString();
  }
  if (has(body, "prompt")) {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) return { error: "prompt cannot be empty" };
    if (body.prompt.length > 20_000) return { error: "instructions are too long (20,000 characters at most)" };
    patch.prompt = body.prompt;
  }
  if (has(body, "description")) {
    if (typeof body.description !== "string" || body.description.length > 1000) return { error: "enter a name of at most 1,000 characters" };
    patch.description = body.description;
  }
  if (has(body, "successCriteria")) {
    try { patch.successCriteria = normalizeSuccessCriteria(body.successCriteria); }
    catch (error) { return { error: error.message }; }
  }
  if (has(body, "notify")) {
    if (!["channel", "user", "none"].includes(body.notify)) return { error: "invalid notification setting" };
    patch.notify = body.notify;
  }
  if (has(body, "notifyUserId")) {
    if (typeof body.notifyUserId !== "string") return { error: "invalid person to notify" };
    patch.notifyUserId = body.notifyUserId.replace(/[<@>]/g, "").trim();
  }
  if ((patch.notify ?? current.notify) === "user" && !(patch.notifyUserId ?? current.notifyUserId)) return { error: "choose a person to notify" };
  for (const [key, allowed] of [["executionVisibility", ["visible", "silent"]], ["resultPolicy", ["always", "on-result", "on-failure"]]]) {
    if (has(body, key)) {
      if (!allowed.includes(body[key])) return { error: `invalid ${key}` };
      patch[key] = body[key];
    }
  }
  if (has(body, "failureNotify")) {
    if (typeof body.failureNotify !== "boolean") return { error: "failureNotify must be a boolean" };
    patch.failureNotify = body.failureNotify;
  }
  if (has(body, "deliveryThread")) {
    if (typeof body.deliveryThread !== "string" || body.deliveryThread.length > 500 || /[\r\n\x00]/.test(body.deliveryThread)) return { error: "enter a valid delivery thread ID" };
    patch.deliveryThread = body.deliveryThread;
  }
  if (has(body, "delivery")) {
    if (!DELIVERIES.includes(body.delivery)) return { error: "invalid delivery setting" };
    if (body.delivery === "thread" && current.kind === "reminder") return { error: "existing-thread delivery requires a task schedule" };
    if (body.delivery === "daily-thread" && (current.kind === "reminder" || current.once)) return { error: "daily-thread delivery requires a recurring task schedule" };
    if (body.delivery === "dm-on-match" && (current.kind === "reminder" || !current.createdBy || !current.matchPrefix)) {
      return { error: "DM on match requires a task with a creator and a match prefix" };
    }
    if (body.delivery !== (current.delivery || "standard")) {
      patch.delivery = body.delivery;
      patch.dailyThreadDate = "";
      patch.dailyThreadTs = "";
    }
  }
  const optionsError = validateScheduleOptions({ ...current, ...patch });
  if (optionsError) return { error: optionsError };
  return { patch };
}
