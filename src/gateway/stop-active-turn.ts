import { getDb } from "../db/index.js";
import { abortPooled } from "../engines/session-pool.js";
import { logEvent } from "../util/logger.js";
import { finishActiveRun } from "./active-runs.js";
import { runQueue } from "./thread-turn-owner.ts";

// Call only after admission. Pin the native command event to the owner it first saw, including
// an idle thread. A connector retry after promotion must never cancel the following request.
export function stopActiveTurn({ slug, channelId, threadKey, actor, admin, eventId }: {
  slug: string; channelId: string; threadKey: string; actor: string; admin: boolean; eventId: string;
}) {
  if (!eventId) return "The message has no request ID. Send a new stop active message in this thread.";
  const key = slug + "::" + threadKey;
  const current = runQueue.snapshot(key).active;
  const db = getDb();
  const now = Date.now();
  db.prepare("DELETE FROM thread_stop_targets WHERE created_ms < ?").run(now - 7 * 86400_000);
  db.prepare("INSERT INTO thread_stop_targets(owner_key,actor,event_id,target_id,created_ms) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(key, actor, eventId, current?.requestId || "", now);
  const target = db.prepare("SELECT target_id FROM thread_stop_targets WHERE owner_key=? AND actor=? AND event_id=?")
    .get(key, actor, eventId)?.target_id;
  if (!target) return "Nothing is running in this thread right now.";
  if (!current || current.requestId !== target) return "The turn selected by this message has already stopped.";
  if (!admin && (!current.authorId || current.authorId !== actor)) return "Only the run author or an organization admin can stop this turn.";
  if (runQueue.stopActive(key, current.requestId)) {
    finishActiveRun(current.requestId);
    abortPooled(key);
    void logEvent("run_stopped", { channel: channelId, author: actor, slug, threadKey, runId: current.requestId, state: "active" });
  }
  return "Stopped the active turn. Queued requests keep their place.";
}
