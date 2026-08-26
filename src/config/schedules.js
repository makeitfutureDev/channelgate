// Schedule store — cron jobs / reminders per channel. Backed by SQLite (see ../db). Written by
// both the daemon (admin edits, run bookkeeping) and the scheduler MCP server (a separate
// process the gated AI calls) — SQLite's file locking (WAL + busy_timeout) makes that safe, which
// the old shared JSON file was not. Full record is stored as a JSON blob; channel_id + enabled are
// mirrored into columns so the hot filters index. Row order (rowid) preserves insertion order.
// Shape: { id, channelId, slug, cron, runAt, once, prompt, description, createdBy, kind, ack,
//          ackEmoji, escalateAfterMin, dmAfterMin, escalationStyle, notify, notifyUserId,
//          enabled, createdAt, lastRun, lastStatus }
// Thread-loop rows (see ../gateway/loops.js) add: { loop, loopId, threadTs, resumeThread,
//          ticksRemaining, loopReason, loopNoop }. They live in this same table on purpose — one
//          tick loop, one concurrency cap, one per-channel ceiling — and are declared here so the
//          record shape stays defined in exactly one place.
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson } from "../db/index.js";

export function getSchedules() {
  return getDb().prepare("SELECT data FROM schedules ORDER BY rowid").all().map((r) => fromJson(r.data, {}));
}

export function addSchedule({ channelId, slug, cron, prompt, description, createdBy, notify, notifyUserId, runAt, once, kind, ack, ackEmoji, escalateAfterMin, dmAfterMin, escalationStyle, loop, loopId, threadTs, resumeThread, ticksRemaining, loopReason, loopNoop }) {
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
  const next = { ...fromJson(row.data, {}), ...patch };
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
