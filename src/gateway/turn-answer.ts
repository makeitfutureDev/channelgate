import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

type Inbox = { namespace: string; eventId: string; owner: string };
const inbound = new AsyncLocalStorage<Inbox>();
export function withInboundAnswerScope<T>(scope: Inbox, handle: () => T): T { return inbound.run(scope, handle); }

export function inboundRequestId(namespace: string, eventId: string) {
  return JSON.stringify(["inbox", namespace, eventId]);
}
export function currentInboundRequestId() {
  const scope = inbound.getStore();
  return scope && inboundRequestId(scope.namespace, scope.eventId);
}
type Posted = { messageId: string; conversationId?: string; threadKey?: string };
export type SavedAnswer = {
  platform: string; channelId: string; rawChannelId: string; threadKey: string; sessionKey: string;
  authorId: string; slug: string; isDM: boolean; text: string; footer: string;
  identity?: string; preview?: boolean; access?: "voice" | "question"; placeholder?: Posted | null; menu?: object | null;
};
// Workspace, bot and destination must continue to identify the same sending account on reconnect.
export function slackDeliveryIdentity(team?: string | null, bot?: string | null) {
  return team && bot ? JSON.stringify([team, bot]) : "";
}
export function slackAnswer({ channelId, threadKey, sessionKey, authorId, slug, isDM, identity, text, footer, access, preview }: {
  channelId: string; threadKey: string; sessionKey: string; authorId: string; slug: string;
  isDM?: boolean; identity?: string; text: string; footer?: string; preview?: boolean; access?: "voice" | "question";
}): SavedAnswer {
  return { platform: "slack", rawChannelId: channelId, channelId, threadKey, sessionKey, authorId, slug,
    isDM: Boolean(isDM), text, identity, access, preview, footer: footer || "" };
}

const held = new Set<string>();
const retention = 7 * 24 * 60 * 60_000;
const maxAttempts = 3;
type Action = "send" | "cancel" | "defer";
type Outcome = "delivered" | "cancelled" | "pending" | "duplicate";
type Sender = () => Promise<void | false>;
type Row = { id: string; platform: string; attempts: number; payload: string };
function terminal(id: string, state: "delivered" | "cancelled" | "abandoned") {
  getDb().prepare("UPDATE turn_answers SET state=?, payload='{}' WHERE id=?").run(state, id);
}
export function hasSavedTurnAnswer(id: string) {
  return Boolean(getDb().prepare("SELECT 1 FROM turn_answers WHERE id=?").get(id));
}

function checkpoint(id: string, payload: SavedAnswer, cancelled: boolean, scope?: Inbox) {
  const db = getDb();
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const saved = db.prepare("INSERT OR IGNORE INTO turn_answers(id,platform,state,due_ms,created_ms,payload) VALUES(?,?,?,?,?,?)")
      .run(id, payload.platform, cancelled ? "cancelled" : "pending", now, now, cancelled ? "{}" : JSON.stringify(payload));
    db.prepare("UPDATE active_runs SET data=json_set(data,'$.replySaved',1) WHERE id=?").run(id);
    if (scope) db.prepare("UPDATE inbound_events SET status='done', data='{}' WHERE namespace=? AND event_id=? AND owner=? AND status='running'")
      .run(scope.namespace, scope.eventId, scope.owner);
    db.exec("COMMIT");
    return Boolean(saved.changes);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
async function attempt(id: string, previous: number, send: Sender, propagateError = false): Promise<Outcome> {
  const db = getDb();
  // A dead process leaves 'attempting' on disk. The remote server may already have accepted it.
  const claimed = db.prepare("UPDATE turn_answers SET state='attempting', attempts=attempts+1 WHERE id=? AND attempts=? AND state IN ('pending','attempting','uncertain')")
    .run(id, previous);
  if (!claimed.changes) return "duplicate";
  try {
    if (await send() === false) {
      terminal(id, "cancelled");
      return "cancelled";
    }
  } catch (error) {
    if (db.prepare("SELECT 1 FROM turn_answers WHERE id=? AND state='cancelled'").get(id)) return "cancelled";
    if (previous + 1 >= maxAttempts) {
      terminal(id, "abandoned");
      console.warn(`[reply] delivery exhausted after ${maxAttempts} attempts for ${id}`);
    } else {
      db.prepare("UPDATE turn_answers SET state='uncertain', due_ms=? WHERE id=?").run(Date.now() + 30_000 * (previous + 1), id);
    }
    if (propagateError) throw error;
    return "pending";
  }
  terminal(id, "delivered");
  return "delivered";
}

// Saving and claiming ownership are synchronous up to the first await. Preparation can bank
// usage or close a preview. A crash during preparation leaves a definitely unsent final.
export async function deliverTurnAnswer(payload: SavedAnswer, runId: string | undefined,
  prepare: () => Promise<Action>, send: Sender,
  options: { signal?: AbortSignal; cancelled?: () => boolean; propagateError?: boolean } = {}): Promise<Outcome> {
  const scope = inbound.getStore();
  const sourceId = currentInboundRequestId();
  const id = runId || sourceId || randomUUID();
  const stopped = () => !options.cancelled || options.cancelled();
  const cancelled = Boolean(options.signal?.aborted && stopped());
  if (!checkpoint(id, payload, cancelled, id === sourceId ? scope : undefined)) return "duplicate";
  held.add(id);
  const cancelIfStopped = () => {
    if (stopped()) {
      getDb().prepare("UPDATE turn_answers SET state='cancelled', payload='{}' WHERE id=? AND state IN ('pending','attempting')").run(id);
    }
  };
  options.signal?.addEventListener("abort", cancelIfStopped, { once: true });
  try {
    const action = await prepare();
    if (cancelled || action === "cancel") { terminal(id, "cancelled"); return "cancelled"; }
    if (action === "defer") return "pending";
    return await attempt(id, 0, send, options.propagateError);
  } finally {
    options.signal?.removeEventListener("abort", cancelIfStopped);
    held.delete(id);
  }
}

type Route = false | "cancel" | Sender;
export async function recoverTurnAnswers(route: (saved: SavedAnswer, ambiguous: boolean) => Promise<Route>, now = Date.now()) {
  const db = getDb();
  db.prepare("DELETE FROM turn_answers WHERE created_ms < ?").run(now - retention);
  const rows = db.prepare("SELECT id, platform, attempts, payload FROM turn_answers WHERE state IN ('pending','attempting','uncertain') AND due_ms <= ? ORDER BY due_ms,rowid LIMIT 50").all(now) as Row[];
  for (const row of rows) {
    if (held.has(row.id)) continue;
    held.add(row.id);
    try {
      // Revisit unavailable routes later so they cannot starve connected conversations.
      db.prepare("UPDATE turn_answers SET due_ms=? WHERE id=?").run(now + 60_000, row.id);
      if (row.attempts >= maxAttempts) { terminal(row.id, "abandoned"); continue; }
      const send = await route(JSON.parse(row.payload) as SavedAnswer, row.attempts > 0);
      if (send === "cancel") terminal(row.id, "cancelled");
      else if (send) await attempt(row.id, row.attempts, send);
    } catch (error) { console.warn(`[reply] recovery check failed for ${row.id}`, (error as Error).name); }
    finally { held.delete(row.id); }
  }
}
