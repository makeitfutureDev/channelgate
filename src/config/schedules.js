// Schedule store — cron jobs / reminders per channel. Backed by SQLite (see ../db). Written by
// both the daemon (admin edits, run bookkeeping) and the scheduler MCP server (a separate
// process the gated AI calls) — SQLite's file locking (WAL + busy_timeout) makes that safe, which
// the old shared JSON file was not. Full record is stored as a JSON blob; channel_id + enabled are
// mirrored into columns so the hot filters index. Row order (rowid) preserves insertion order.
// Shape: { id, channelId, slug, cron, runAt, once, prompt, description, createdBy, kind, ack,
//          ackEmoji, escalateAfterMin, dmAfterMin, escalationStyle, notify, notifyUserId,
//          delivery, dailyThreadDate, dailyThreadTs, enabled, createdAt, lastRun, lastStatus,
//          cronEligibleSince, lastCronFireMs, lastFireMinute, executionState, pendingDelivery }
// Thread-loop rows (see ../gateway/loops.js) add: { loop, loopId, threadTs, resumeThread,
//          ticksRemaining, loopReason, loopNoop }. They live in this same table on purpose — one
//          tick loop, one concurrency cap, one per-channel ceiling — and are declared here so the
//          record shape stays defined in exactly one place.
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson, metaGet, metaSet } from "../db/index.js";

export function getSchedules() {
  return getDb().prepare("SELECT data FROM schedules ORDER BY rowid").all().map((r) => fromJson(r.data, {}));
}

export function addSchedule({ channelId, slug, cron, prompt, description, createdBy, notify, notifyUserId, delivery, runAt, once, kind, ack, ackEmoji, escalateAfterMin, dmAfterMin, escalationStyle, loop, loopId, threadTs, resumeThread, ticksRemaining, loopReason, loopNoop }) {
  const sched = {
    id: randomUUID().slice(0, 8),
    channelId,
    slug: slug || "",
    cron: cron || "", // recurring schedules use cron; one-time schedules use runAt instead
    runAt: runAt || "", // ISO timestamp for a one-time ("run at") schedule
    once: Boolean(once), // fire a single time, then auto-delete
    prompt,
    description: description || "",
    createdBy: createdBy || "",
    // "task" (default): announce + run a Claude session. "reminder": post a single message (the
    // reminder text) with no Claude run — and, when ack is set, require a ✅ and escalate if missing.
    kind: kind === "reminder" ? "reminder" : "task",
    ack: Boolean(ack), // require acknowledgment (reminder kind only)
    ackEmoji: ackEmoji || "white_check_mark", // the reaction that acknowledges
    escalateAfterMin: escalateAfterMin ?? 120, // 1st reminder → 2nd reminder delay (minutes)
    dmAfterMin: dmAfterMin ?? 60, // 2nd reminder → DM-the-creator delay (minutes)
    escalationStyle: escalationStyle === "toplevel" ? "toplevel" : "thread",
    // Where the run is announced: "channel" (@channel ping), "user" (@person ping), "none" (quiet).
    notify: ["channel", "user", "none"].includes(notify) ? notify : "channel",
    notifyUserId: notifyUserId || "",
    // Ordinary tasks announce every run at the top level. Opt-in daily-thread delivery creates one
    // anchor per server-local day and sends every run result beneath it. The anchor state lives in
    // the JSON record so a daemon restart cannot create a second thread for the same day.
    delivery: kind !== "reminder" && ["daily-thread", "channel"].includes(delivery) && (!once || delivery === "channel") ? delivery : "standard",
    dailyThreadDate: "",
    dailyThreadTs: "",
    // Thread-loop binding (all falsy/empty for an ordinary schedule). `resumeThread` is what makes
    // the scheduler run the tick under the THREAD's session and reply in-thread instead of
    // announcing a new top-level run; `ticksRemaining` is the runaway budget.
    loop: Boolean(loop),
    loopId: loopId || "",
    threadTs: threadTs || "",
    resumeThread: Boolean(resumeThread),
    ticksRemaining: Number.isFinite(Number(ticksRemaining)) ? Number(ticksRemaining) : null,
    loopReason: loopReason || "",
    loopNoop: Boolean(loopNoop),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
  };
  getDb()
    .prepare("INSERT INTO schedules(id, channel_id, enabled, data) VALUES(?, ?, ?, ?)")
    .run(sched.id, sched.channelId || "", sched.enabled ? 1 : 0, toJson(sched));
  return sched;
}

export function countEnabledForChannel(channelId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM schedules WHERE channel_id = ? AND enabled = 1").get(channelId).n;
}

export function listForChannel(channelId) {
  return getDb().prepare("SELECT data FROM schedules WHERE channel_id = ? ORDER BY rowid").all(channelId).map((r) => fromJson(r.data, {}));
}

export function updateSchedule(id, patch) {
  const row = getDb().prepare("SELECT data FROM schedules WHERE id = ?").get(id);
  if (!row) return null;
  const previous = fromJson(row.data, {});
  const next = { ...previous, ...patch };
  // Re-enabling or changing a cron is a new eligibility boundary, never permission to replay
  // minutes that passed while disabled or under a different expression.
  if ((!previous.enabled && next.enabled) || previous.cron !== next.cron) {
    next.cronEligibleSince = new Date().toISOString();
  }
  getDb()
    .prepare("UPDATE schedules SET channel_id = ?, enabled = ?, data = ? WHERE id = ?")
    .run(next.channelId || "", next.enabled ? 1 : 0, toJson(next), id);
  return next;
}

export function deleteSchedule(id, channelId = null) {
  const info = channelId
    ? getDb().prepare("DELETE FROM schedules WHERE id = ? AND channel_id = ?").run(id, channelId)
    : getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return info.changes > 0;
}

// The scheduler's cursor and per-schedule claim are operational JSON state, not a new schema.
// Re-read the last evaluated minute at boot: it might have been only partially processed when
// the daemon died. Per-fire high-water marks make that overlap safe.
export function getSchedulerCursor() {
  const value = Number(metaGet("scheduler:last-tick-ms"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function saveSchedulerCursor(value) {
  metaSet("scheduler:last-tick-ms", value);
}

// CAS on the complete row avoids overwriting a concurrent MCP/admin edit. The caller retries a
// lost race on a later tick. Epoch minutes distinguish the two occurrences of a DST-fold minute.
export function claimScheduleMinute(id, minuteMs, legacyMinuteKey, expected) {
  const db = getDb();
  const row = db.prepare("SELECT data FROM schedules WHERE id = ?").get(id);
  if (!row) return null;
  const sched = fromJson(row.data, {});
  if (expected && (sched.cron !== expected.cron ||
    (sched.cronEligibleSince || sched.createdAt) !== (expected.cronEligibleSince || expected.createdAt))) return null;
  if (!sched.enabled || Number(sched.lastCronFireMs || 0) >= minuteMs || (!sched.lastCronFireMs && sched.lastFireMinute === legacyMinuteKey)) return null;
  const next = { ...sched, lastCronFireMs: minuteMs, lastFireMinute: legacyMinuteKey,
    ...(sched.kind !== "reminder" ? { executionState: "queued" } : {}) };
  const result = db.prepare("UPDATE schedules SET data = ? WHERE id = ? AND data = ?")
    .run(toJson(next), id, row.data);
  return result.changes ? next : null;
}
