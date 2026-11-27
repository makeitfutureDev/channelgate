import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { createRunQueue, duplicateRequest, type TurnReceipts } from "./thread-turn-queue.ts";

// Payloads and recovery decisions stay in the producer's durable store. The receipt only records
// ownership and ordering, and therefore never contains prompts, file names, or answer content.
const RETENTION_MS = 7 * 86_400_000;
const terminal = "state IN ('finished','cancelled','interrupted')";
const MAX_RECEIPTS = 100_000;
let nextSweep = 0;

function sweep(now: number) {
  if (now < nextSweep) return;
  const db = getDb();
  db.prepare(`DELETE FROM thread_turn_receipts WHERE updated_ms <= ? AND ${terminal}`).run(now - RETENTION_MS);
  db.prepare(`DELETE FROM thread_turn_receipts WHERE sequence IN (
    SELECT sequence FROM thread_turn_receipts WHERE ${terminal}
    ORDER BY updated_ms DESC, sequence DESC LIMIT -1 OFFSET ?)`).run(MAX_RECEIPTS);
  nextSweep = now + 3_600_000;
}

export function sessionOwnerKey(channelId: string, sessionKey: string): string {
  const row = getDb().prepare("SELECT slug FROM channels WHERE channel_id=?").get(channelId);
  return `${row?.slug || channelId}::${sessionKey}`;
}

export function reconcileTurnReceipts() {
  getDb().prepare("UPDATE thread_turn_receipts SET state='interrupted', updated_ms=? WHERE state IN ('queued','active') AND NOT EXISTS (SELECT 1 FROM active_runs WHERE id=request_id)").run(Date.now());
}

export function turnReceipt(key: string, id: string) {
  const now = Date.now();
  sweep(now);
  return getDb().prepare(`SELECT sequence, state FROM thread_turn_receipts WHERE owner_key=? AND request_id=?
      AND (updated_ms > ? OR state IN ('active','queued'))`)
    .get(key, id, now - RETENTION_MS) as { sequence: number; state: string } | undefined;
}

// A paid retry is a new request with its own completion receipt and final answer. Native
// redelivery keeps the original ID; a retry button keeps the ID of its one-time choice.
export function slackTurnRequestId(key: string, messageId: string, options: { choiceId?: string; reactionId?: string; retry?: boolean }) {
  const base = `${key}::${messageId}`;
  if (options.choiceId) return `${base}::choice:${options.choiceId}`;
  if (options.reactionId) return `${base}::reaction:${options.reactionId}`;
  if (options.retry && turnReceipt(key, base)) return `${base}::retry:${randomUUID()}`;
  return base;
}

const receipts: TurnReceipts = {
  claim(key, handle, state) {
    const db = getDb();
    const now = Date.now();
    const id = handle.runId!;
    const existing = turnReceipt(key, id);
    if (existing) {
      if (!handle.recovery || existing.state === "cancelled") throw duplicateRequest();
      this.mark(key, handle, state);
      return existing.sequence;
    }
    // A terminal receipt may have expired since the last hourly sweep.
    db.prepare(`DELETE FROM thread_turn_receipts WHERE owner_key=? AND request_id=? AND updated_ms <= ? AND ${terminal}`)
      .run(key, id, now - RETENTION_MS);
    return Number(db.prepare(`INSERT INTO thread_turn_receipts
      (owner_key,request_id,origin,state,updated_ms) VALUES(?,?,?,?,?)`).run(key, id, handle.origin || "", state, now).lastInsertRowid);
  },
  mark(key, handle, state) {
    getDb().prepare("UPDATE thread_turn_receipts SET state=?, updated_ms=? WHERE owner_key=? AND request_id=?")
      .run(state, Date.now(), key, handle.runId!);
  },
  cancel(key, handle) {
    // Explicit user stops fence delivery recovery in the same transaction. A normal release
    // (including a daemon shutdown) can still leave a completed reply pending for reconnect.
    const db = getDb();
    const id = handle.runId!;
    db.exec("SAVEPOINT cancel_thread_turn");
    try {
      this.mark(key, handle, "cancelled");
      db.prepare("UPDATE turn_answers SET state='cancelled',payload='{}' WHERE id=? AND state IN ('pending','attempting','uncertain')").run(id);
      if (id.startsWith('["inbox",')) {
        const [, namespace, eventId] = JSON.parse(id);
        db.prepare("UPDATE inbound_events SET status='done', data='{}' WHERE namespace=? AND event_id=? AND status='running'").run(namespace, eventId);
      }
      db.exec("RELEASE cancel_thread_turn");
    } catch (error) {
      db.exec("ROLLBACK TO cancel_thread_turn");
      db.exec("RELEASE cancel_thread_turn");
      throw error;
    }
  },
};

export const runQueue = createRunQueue({ receipts });
