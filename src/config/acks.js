// Pending-acknowledgment store — one entry per fired reminder that still awaits a ✅. Backed by
// SQLite (see ../db). Written by the daemon scheduler (creates on fire, escalates, deletes on
// timeout) and by the Slack reaction handler (deletes when someone acknowledges); SQLite locking
// keeps those safe. Full record stored as a JSON blob; channel_id is mirrored to a column.
// Shape: { id, scheduleId, channelId, slug, messageTs, messageTsList, threadTs, text, title,
//          createdBy, notifyUserId, notify, ackEmoji, stage, nextAt, escalateAfterMin,
//          dmAfterMin, escalationStyle, createdAt }
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson } from "../db/index.js";

export function getAcks() {
  return getDb().prepare("SELECT data FROM acks ORDER BY rowid").all().map((r) => fromJson(r.data, {}));
}

export function addAck(entry) {
  const ack = {
    id: randomUUID().slice(0, 8),
    scheduleId: entry.scheduleId || "",
    channelId: entry.channelId,
    slug: entry.slug || "",
    messageTs: entry.messageTs, // the original reminder message users react to
    messageTsList: entry.messageTsList || [entry.messageTs], // every message a ✅ acknowledges (original + escalation reposts)
    threadTs: entry.threadTs || entry.messageTs, // thread for escalation reposts
    text: entry.text || "",
    title: entry.title || "",
    createdBy: entry.createdBy || "", // DM target at the final escalation
    notifyUserId: entry.notifyUserId || "",
    notify: entry.notify || "channel",
    ackEmoji: entry.ackEmoji || "white_check_mark",
    stage: "sent1", // sent1 → (escalate) → sent2 → (escalate) → DM + delete
    nextAt: entry.nextAt, // ISO timestamp of the next escalation
    escalateAfterMin: entry.escalateAfterMin ?? 120,
    dmAfterMin: entry.dmAfterMin ?? 60,
    escalationStyle: entry.escalationStyle === "toplevel" ? "toplevel" : "thread",
    createdAt: new Date().toISOString(),
  };
  getDb().prepare("INSERT INTO acks(id, channel_id, data) VALUES(?, ?, ?)").run(ack.id, ack.channelId || "", toJson(ack));
  return ack;
}

export function updateAck(id, patch) {
  const row = getDb().prepare("SELECT data FROM acks WHERE id = ?").get(id);
  if (!row) return null;
  const next = { ...fromJson(row.data, {}), ...patch };
  getDb().prepare("UPDATE acks SET channel_id = ?, data = ? WHERE id = ?").run(next.channelId || "", toJson(next), id);
  return next;
}

export function deleteAck(id) {
  return getDb().prepare("DELETE FROM acks WHERE id = ?").run(id).changes > 0;
}

// Find the pending ack a reaction belongs to: same channel + one of its ackable messages (the
// original reminder OR any escalation repost). Falls back to `messageTs` for entries written
// before `messageTsList` existed.
export function findAckByMessage(channelId, messageTs) {
  if (!channelId || !messageTs) return null;
  const rows = getDb().prepare("SELECT data FROM acks WHERE channel_id = ?").all(channelId);
  for (const r of rows) {
    const a = fromJson(r.data, {});
    if (a.messageTs === messageTs || (a.messageTsList || []).includes(messageTs)) return a;
  }
  return null;
}
