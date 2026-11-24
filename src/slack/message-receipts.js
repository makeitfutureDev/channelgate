// Slack can retry an already completed message after the receiving process has restarted.
// Store identifiers only, in a private namespace of the existing indexed transport journal.
import { getDb } from "../db/index.js";

const NAMESPACE = "slack-terminal-message";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 10_000;

export function hasCompletedSlackMessage(channel, ts) {
  if (!channel || !ts) return false;
  return Boolean(getDb().prepare(`SELECT 1 FROM inbound_events
    WHERE namespace = ? AND event_id = ? AND created_ms > ?`)
    .get(NAMESPACE, `${channel}:${ts}`, Date.now() - RETENTION_MS));
}

// The caller owns the transaction that retires the corresponding active run.
export function recordCompletedSlackMessage(db, channel, ts) {
  if (!channel || !ts) return;
  const now = Date.now();
  db.prepare(`INSERT INTO inbound_events
    (namespace, event_id, conversation_id, status, created_ms, data) VALUES (?, ?, ?, 'done', ?, '{}')
    ON CONFLICT(namespace, event_id) DO UPDATE SET created_ms = excluded.created_ms`)
    .run(NAMESPACE, `${channel}:${ts}`, channel, now);
  db.prepare(`DELETE FROM inbound_events WHERE namespace = ? AND status = 'done' AND created_ms <= ?`)
    .run(NAMESPACE, now - RETENTION_MS);
  db.prepare(`DELETE FROM inbound_events WHERE rowid IN (
    SELECT rowid FROM inbound_events WHERE namespace = ? AND status = 'done'
    ORDER BY created_ms DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(NAMESPACE, MAX_RECEIPTS);
}
