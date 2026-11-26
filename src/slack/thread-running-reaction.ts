import { getDb } from "../db/index.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { slackThreadFor } from "./thread-keys.js";

type ReactionArgs = { channel: string; timestamp: string; name: string };
type ReactionMethod = (args: ReactionArgs) => Promise<{ ok?: boolean; error?: string }>;
type Client = { reactions?: { add: ReactionMethod; remove: ReactionMethod } };
const owners = new Map<string, number>();
const retryMs = 60_000;

async function sync(client: Client, channel: string, thread: string) {
  const key = channel + ":" + thread;
  const release = await acquireKeyedLock("running-reaction", key);
  try {
    const db = getDb();
    const wanted = owners.has(key);
    const row = db.prepare("SELECT retry_ms FROM slack_running_reactions WHERE channel_id=? AND thread_ts=?").get(channel, thread);
    if (!client.reactions || (wanted ? row?.retry_ms === null : !row)) return;
    // Persist BEFORE the write. Slack may accept it even when the response is lost.
    db.prepare("INSERT OR REPLACE INTO slack_running_reactions(channel_id, thread_ts, retry_ms) VALUES(?,?,?)")
      .run(channel, thread, Date.now() + retryMs);
    try {
      const result = await client.reactions[wanted ? "add" : "remove"]({ channel, timestamp: thread, name: "arrow_forward" });
      if (result?.ok === false) throw Object.assign(new Error(), { code: result.error });
    } catch (error) {
      const apiError = error as { data?: { error?: string }; code?: string } | null;
      const code = apiError?.data?.error || apiError?.code;
      if (wanted ? code !== "already_reacted" : code !== "no_reaction" && code !== "message_not_found") return;
    }
    if (wanted) {
      db.prepare("UPDATE slack_running_reactions SET retry_ms=NULL WHERE channel_id=? AND thread_ts=?").run(channel, thread);
    } else {
      db.prepare("DELETE FROM slack_running_reactions WHERE channel_id=? AND thread_ts=?").run(channel, thread);
    }
  } finally {
    release();
  }
}

// Several producers can work in one thread. Only the last release clears the bot's reaction.
export function startRunningReaction(client: Client, channel: string, threadKey: string | null) {
  const thread = slackThreadFor(threadKey);
  if (!thread || !channel || !client?.reactions?.add || !client.reactions.remove) return () => {};
  const key = channel + ":" + thread;
  const count = owners.get(key) || 0;
  owners.set(key, count + 1);
  // Keep all Slack I/O off the engine/delivery critical path, including rate-limit waits.
  const update = () => { void sync(client, channel, thread).catch(() => {}); };
  if (!count) update();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const remaining = (owners.get(key) || 1) - 1;
    if (remaining) {
      owners.set(key, remaining);
    } else {
      owners.delete(key);
      update();
    }
  };
}

export function queueRunningReactionsForRecovery() {
  // A previous daemon's leases no longer exist. A replay takes a new lease when it starts.
  getDb().prepare("UPDATE slack_running_reactions SET retry_ms=0").run();
}

export async function retryRunningReactions(client: Client, now = Date.now()) {
  const rows = getDb().prepare("SELECT channel_id, thread_ts FROM slack_running_reactions WHERE retry_ms<=? ORDER BY retry_ms LIMIT 20").all(now);
  await Promise.all(rows.map((row: { channel_id: string; thread_ts: string }) => sync(client, row.channel_id, row.thread_ts)));
}
