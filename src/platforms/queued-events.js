// A queued message's own controls (the busy-thread Steer / Cancel card on Teams and Google Chat)
// name it by a lane word and its durable intake id. This module gives a transport's connector the
// four durable operations those controls need, over the shared `inbound_events` table.
//
// `namespaces` maps each closed lane word to THIS transport's own intake namespace, so card data
// can never point at another bot's or another transport's rows; `authorOf(row)` reads the sender a
// stored row names, in the identity form the surface's inbound messages use.
import { notifyInboxThread } from "./inbox-thread-change.ts";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

export function attachQueuedEventControls(connector, { namespaces, authorOf }) {
  const queueNamespace = kind => Object.hasOwn(namespaces, kind) ? namespaces[kind] : "";
  const queuedRow = (namespace, eventId) => getDb().prepare(`SELECT rowid AS id, event_id, conversation_id, status, data
    FROM inbound_events WHERE namespace = ? AND event_id = ?`).get(namespace, eventId);
  connector.queuedEvent = ({ kind, eventId }) => {
    const namespace = queueNamespace(kind);
    const row = namespace && typeof eventId === "string" ? queuedRow(namespace, eventId) : null;
    if (!row) return null;
    let conversationId = "", sessionKey = "";
    try { [conversationId, sessionKey] = JSON.parse(row.conversation_id); } catch { return null; }
    if (typeof conversationId !== "string" || typeof sessionKey !== "string") return null;
    return { kind, eventId, status: row.status, conversationId, sessionKey,
      authorId: row.status === "queued" ? authorOf(row) : "" };
  };
  // Drops exactly one waiting message. Work already running is untouched.
  connector.cancelQueuedEvent = ({ kind, eventId }) => {
    const namespace = queueNamespace(kind);
    if (!namespace) return false;
    const changed = getDb().prepare("UPDATE inbound_events SET status = 'done', data = '{}' WHERE namespace = ? AND event_id = ? AND status = 'queued' RETURNING conversation_id")
      .get(namespace, eventId);
    if (changed) notifyInboxThread(changed.conversation_id);
    return Boolean(changed);
  };
  // The session's queued messages AHEAD of this one, oldest first.
  connector.queuedAhead = ({ kind, eventId }) => {
    const namespace = queueNamespace(kind);
    const target = namespace ? queuedRow(namespace, eventId) : null;
    if (!target || target.status !== "queued") return null;
    return getDb().prepare(`SELECT rowid AS id, event_id, data FROM inbound_events
      WHERE namespace = ? AND conversation_id = ? AND status = 'queued' AND rowid < ? ORDER BY rowid`)
      .all(namespace, target.conversation_id, target.id).map(row => ({ eventId: row.event_id, authorId: authorOf(row) }));
  };
  // Moves one queued message to the front of its session's queue. The intake runs a session's rows
  // in rowid order, so the rows' contents rotate one place back and the steered message takes the
  // oldest queued slot; every other message keeps its relative order and its own identity.
  connector.prioritizeQueuedEvent = ({ kind, eventId }) => {
    const namespace = queueNamespace(kind);
    if (!namespace) return false;
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const target = queuedRow(namespace, eventId);
      if (!target || target.status !== "queued") { db.exec("ROLLBACK"); return false; }
      const rows = db.prepare(`SELECT rowid AS id, event_id, created_ms, data FROM inbound_events
        WHERE namespace = ? AND conversation_id = ? AND status = 'queued' AND rowid <= ? ORDER BY rowid`)
        .all(namespace, target.conversation_id, target.id);
      if (rows.length > 1) {
        const moved = [rows.at(-1), ...rows.slice(0, -1)];
        const write = db.prepare("UPDATE inbound_events SET event_id = ?, created_ms = ?, data = ? WHERE rowid = ?");
        // Event ids are unique per namespace: park them first, then write the rotated contents.
        for (const row of rows) write.run(`steer:${randomUUID()}`, row.created_ms, row.data, row.id);
        rows.forEach((row, index) => write.run(moved[index].event_id, moved[index].created_ms, moved[index].data, row.id));
      }
      db.exec("COMMIT");
      notifyInboxThread(target.conversation_id);
      return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return connector;
}
