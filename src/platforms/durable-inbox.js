// Durable transport intake. Acceptance means the event is in SQLite, not that an engine finished.
// Queued events can resume after restart; running events cannot safely repeat unknown tool effects.
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson } from "../db/index.js";

const active = new Set();
const activeConversations = new Set();
const pumps = new Set();
const MAX_ACTIVE = 4;
const MAX_PENDING = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createDurableInbox({ namespace, handle, interrupted = async () => {}, log = console } = {}) {
  if (!namespace || typeof handle !== "function") throw new TypeError("Inbox requires a namespace and handler");
  const owner = randomUUID();
  let stopped = true;
  const db = getDb();
  const rows = () => db.prepare("SELECT * FROM inbound_events WHERE namespace = ? ORDER BY created_ms, rowid").all(namespace);

  function pump() {
    if (stopped) return;
    for (const row of rows()) {
      if (active.size >= MAX_ACTIVE) return;
      if (!["queued", "interrupted"].includes(row.status)) continue;
      const key = `${namespace}:${row.event_id}`;
      const conversation = `${namespace}:${row.conversation_id}`;
      if (active.has(key) || activeConversations.has(conversation)) continue;
      const wasInterrupted = row.status === "interrupted";
      const claimed = db.prepare("UPDATE inbound_events SET status = 'running', owner = ? WHERE namespace = ? AND event_id = ? AND status = ?")
        .run(owner, namespace, row.event_id, row.status);
      if (!claimed.changes) continue;
      active.add(key);
      activeConversations.add(conversation);
      Promise.resolve().then(() => wasInterrupted ? interrupted(fromJson(row.data, {})) : handle(fromJson(row.data, {})))
        .then(() => db.prepare("UPDATE inbound_events SET status = 'done', data = '{}' WHERE namespace = ? AND event_id = ? AND owner = ?").run(namespace, row.event_id, owner))
        .catch((error) => {
          // A handler may fail AFTER side effects. Keep an explicit interruption record, never
          // silently turn it back into queued execution. A failed notice waits for reconnect.
          db.prepare("UPDATE inbound_events SET status = ? WHERE namespace = ? AND event_id = ? AND owner = ?")
            .run(wasInterrupted ? "notice_failed" : "interrupted", namespace, row.event_id, owner);
          log.error?.(`[inbox] ${namespace} event interrupted: ${error?.message || error}`);
        })
        .finally(() => {
          active.delete(key);
          activeConversations.delete(conversation);
          for (const next of pumps) queueMicrotask(next);
        });
    }
  }

  return {
    accept({ id, conversationId, payload }) {
      if (stopped) throw new Error("Inbound transport is stopped; event was not accepted");
      if (!id || !conversationId) throw new Error("Inbound event requires stable event and conversation identifiers");
      if (db.prepare("SELECT 1 FROM inbound_events WHERE namespace = ? AND event_id = ?").get(namespace, id)) return { duplicate: true };
      const pending = db.prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace = ? AND status <> 'done'").get(namespace).n;
      if (pending >= MAX_PENDING) throw new Error("Inbound queue is full; the provider must redeliver later");
      db.prepare("INSERT OR IGNORE INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, 'queued', ?, '', ?)")
        .run(namespace, id, conversationId, Date.now(), toJson(payload));
      queueMicrotask(pump);
      return { accepted: true };
    },
    start() {
      stopped = false;
      db.prepare("DELETE FROM inbound_events WHERE namespace = ? AND status = 'done' AND created_ms < ?").run(namespace, Date.now() - RETENTION_MS);
      for (const row of rows()) {
        if (row.status === "running" && !active.has(`${namespace}:${row.event_id}`)) {
          db.prepare("UPDATE inbound_events SET status = 'interrupted' WHERE namespace = ? AND event_id = ?").run(namespace, row.event_id);
        } else if (row.status === "notice_failed") {
          db.prepare("UPDATE inbound_events SET status = 'interrupted' WHERE namespace = ? AND event_id = ?").run(namespace, row.event_id);
        }
      }
      pumps.add(pump);
      queueMicrotask(pump);
    },
    stop() { stopped = true; pumps.delete(pump); },
  };
}
