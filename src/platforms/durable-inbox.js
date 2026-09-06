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
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH = 500;

export function createDurableInbox({ namespace, handle, interrupted = async () => {}, log = console, now = Date.now } = {}) {
  if (!namespace || typeof handle !== "function") throw new TypeError("Inbox requires a namespace and handler");
  const owner = randomUUID();
  let stopped = true;
  const db = getDb();
  let cleanupTimer = null;
  let lastCleanup = -Infinity;
  function cleanup() {
    const stamp = now();
    if (stamp - lastCleanup < CLEANUP_INTERVAL_MS) return;
    // Keep each sweep bounded. The namespace/status/time index excludes pending work and avoids
    // loading old payloads into JavaScript; a large backlog drains over subsequent accepts/ticks.
    const result = db.prepare(`DELETE FROM inbound_events WHERE rowid IN (
      SELECT rowid FROM inbound_events WHERE namespace = ? AND status = 'done' AND created_ms < ?
      ORDER BY created_ms LIMIT ?
    )`).run(namespace, stamp - RETENTION_MS, CLEANUP_BATCH);
    lastCleanup = result.changes === CLEANUP_BATCH ? -Infinity : stamp;
  }

  function readyRows(limit) {
    // Group only the bounded pending set (at most MAX_PENDING), never completed history. A
    // running row remains the head of its conversation, preventing a later queued event passing
    // it after reconnect. Read payloads only for the few heads this pump can actually dispatch.
    return db.prepare(`WITH heads AS (
      SELECT min(rowid) AS head FROM inbound_events
      WHERE namespace = ? AND status IN ('queued', 'running', 'interrupted') GROUP BY conversation_id
    ) SELECT event_id, conversation_id, status FROM inbound_events
      WHERE rowid IN (SELECT head FROM heads) AND status IN ('queued', 'interrupted')
      ORDER BY rowid LIMIT ?`).all(namespace, limit);
  }

  function pump() {
    if (stopped) return;
    if (active.size >= MAX_ACTIVE) return;
    for (const row of readyRows(MAX_ACTIVE - active.size)) {
      const key = `${namespace}:${row.event_id}`;
      const conversation = `${namespace}:${row.conversation_id}`;
      if (active.has(key) || activeConversations.has(conversation)) continue;
      const wasInterrupted = row.status === "interrupted";
      const claimed = db.prepare("UPDATE inbound_events SET status = 'running', owner = ? WHERE namespace = ? AND event_id = ? AND status = ?")
        .run(owner, namespace, row.event_id, row.status);
      if (!claimed.changes) continue;
      const saved = db.prepare("SELECT data FROM inbound_events WHERE namespace = ? AND event_id = ?").get(namespace, row.event_id);
      active.add(key);
      activeConversations.add(conversation);
      Promise.resolve().then(() => wasInterrupted ? interrupted(fromJson(saved.data, {})) : handle(fromJson(saved.data, {})))
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
      cleanup();
      if (db.prepare("SELECT 1 FROM inbound_events WHERE namespace = ? AND event_id = ?").get(namespace, id)) return { duplicate: true };
      const pending = db.prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace = ? AND status IN ('queued', 'running', 'interrupted', 'notice_failed')").get(namespace).n;
      if (pending >= MAX_PENDING) throw new Error("Inbound queue is full; the provider must redeliver later");
      db.prepare("INSERT OR IGNORE INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, 'queued', ?, '', ?)")
        .run(namespace, id, conversationId, now(), toJson(payload));
      queueMicrotask(pump);
      return { accepted: true };
    },
    start() {
      stopped = false;
      cleanup();
      if (!cleanupTimer) {
        cleanupTimer = setInterval(() => {
          try { cleanup(); } catch (error) { log.error?.(`[inbox] ${namespace} cleanup failed: ${error?.message || error}`); }
        }, CLEANUP_INTERVAL_MS);
        cleanupTimer.unref?.();
      }
      const recoveryRows = db.prepare("SELECT event_id, status FROM inbound_events WHERE namespace = ? AND status IN ('running', 'notice_failed')").all(namespace);
      for (const row of recoveryRows) {
        if (row.status === "running" && !active.has(`${namespace}:${row.event_id}`)) {
          db.prepare("UPDATE inbound_events SET status = 'interrupted' WHERE namespace = ? AND event_id = ?").run(namespace, row.event_id);
        } else if (row.status === "notice_failed") {
          db.prepare("UPDATE inbound_events SET status = 'interrupted' WHERE namespace = ? AND event_id = ?").run(namespace, row.event_id);
        }
      }
      pumps.add(pump);
      queueMicrotask(pump);
    },
    stop() { stopped = true; pumps.delete(pump); clearInterval(cleanupTimer); cleanupTimer = null; },
  };
}
