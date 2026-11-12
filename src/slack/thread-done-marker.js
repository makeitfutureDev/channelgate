// Root markers mirror durable Done/Later choices; they never independently choose either state.
import { getDb } from "../db/index.js";
import { getSlackThread, slackThreadIsDone, updateSlackThreadRootCompletion } from "../gateway/slack-threads.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";

const identities = new WeakMap();
async function botIdentity(client) {
  if (!identities.has(client)) {
    const pending = client.auth.test().then((result) => {
      if (result?.ok === false || !result?.user_id) throw new Error("Unable to identify completion marker author");
      return result.user_id;
    }).catch((error) => { identities.delete(client); throw error; });
    identities.set(client, pending);
  }
  return identities.get(client);
}

async function syncLaterMarker(client, row) {
  const later = row.later_ms > 0 && !slackThreadIsDone(row);
  if (!later && !row.later_marker) return;
  if (later) {
    // Save BEFORE sending so Resume/Done can clean up a clock even if this request crashes.
    getDb().prepare("UPDATE slack_threads SET later_marker=1 WHERE channel_id=? AND thread_ts=?")
      .run(row.channel_id, row.thread_ts);
  }
  try {
    const result = await client.reactions[later ? "add" : "remove"]({ channel: row.channel_id, timestamp: row.thread_ts, name: "clock3" });
    if (result?.ok === false) throw Object.assign(new Error("Unable to sync thread Later marker"), { code: result.error });
  } catch (error) {
    const code = error.data?.error || error.code;
    if (code !== (later ? "already_reacted" : "no_reaction")) throw error;
  }
  if (!later) {
    // reactions.remove removes only this bot's clock; human reactions remain untouched.
    getDb().prepare("UPDATE slack_threads SET later_marker=0 WHERE channel_id=? AND thread_ts=?")
      .run(row.channel_id, row.thread_ts);
  }
}

export async function syncThreadDoneMarker(client, channelId, threadTs) {
  const release = await acquireKeyedLock("thread-done-marker", `${channelId}::${threadTs}`);
  try {
    const row = getSlackThread(channelId, threadTs);
    if (!row) return;
    const done = slackThreadIsDone(row);
    await syncLaterMarker(client, row);
    if (!done && !row.completion_mirror_user) {
      getDb().prepare("UPDATE slack_threads SET completion_marker_retry_ms=0 WHERE channel_id=? AND thread_ts=? AND done_ms=? AND root_done=? AND root_reaction_ms=? AND later_ms=?")
        .run(channelId, threadTs, row.done_ms, row.root_done, row.root_reaction_ms, row.later_ms);
      return;
    }
    const userId = await botIdentity(client);
    // Persist identity before sending: a crash or Slack event during the request must not make
    // this bot's marker count as a fresh completion choice after a restart.
    getDb().prepare("UPDATE slack_threads SET completion_mirror_user=? WHERE channel_id=? AND thread_ts=?")
      .run(userId, channelId, threadTs);
    try {
      const result = await client.reactions[done ? "add" : "remove"]({ channel: channelId, timestamp: threadTs, name: "white_check_mark" });
      if (result?.ok === false) throw Object.assign(new Error("Unable to sync thread completion marker"), { code: result.error });
    } catch (error) {
      const code = error.data?.error || error.code;
      if (code !== (done ? "already_reacted" : "no_reaction")) throw error;
    }
    getDb().prepare("UPDATE slack_threads SET completion_marker_retry_ms=0 WHERE channel_id=? AND thread_ts=? AND done_ms=? AND root_done=? AND root_reaction_ms=? AND later_ms=?")
      .run(channelId, threadTs, row.done_ms, row.root_done, row.root_reaction_ms, row.later_ms);
  } catch (error) {
    getDb().prepare("UPDATE slack_threads SET completion_marker_retry_ms=? WHERE channel_id=? AND thread_ts=?")
      .run(Date.now() + 60_000, channelId, threadTs);
    // Keep durable completion even when Slack is temporarily unavailable; the daemon
    // retries the marker. Never turn failed decoration into a lost Done/Reopen decision.
    console.error("[slack] thread completion marker failed:", error.data?.error || error.code || "slack_unavailable");
  } finally { release(); }
}

// Only outstanding writes are retried, in small batches. Intent lives beside completion so a
// restart/reconnect cannot strand a saved Done/Later choice before the Slack write completes.
export async function retryThreadDoneMarkers(client, { now = Date.now(), limit = 20 } = {}) {
  const rows = getDb().prepare("SELECT * FROM slack_threads WHERE completion_marker_retry_ms>0 AND completion_marker_retry_ms<=? ORDER BY completion_marker_retry_ms LIMIT ?").all(now, limit);
  for (const row of rows) {
    try {
      if (row.done_ms <= 0) {
        const inspected = await inspectThreadCompletion(client, row.channel_id, row.thread_ts);
        updateSlackThreadRootCompletion(row.channel_id, { ts: row.thread_ts }, inspected);
      }
      await syncThreadDoneMarker(client, row.channel_id, row.thread_ts);
    } catch {
      getDb().prepare("UPDATE slack_threads SET completion_marker_retry_ms=? WHERE channel_id=? AND thread_ts=?")
        .run(now + 60_000, row.channel_id, row.thread_ts);
    }
  }
}

export function startThreadDoneMarkerSync({ slack, intervalMs = 60_000 } = {}) {
  let running = false;
  const sweep = async () => {
    const client = slack.getClient();
    if (running || !client) return;
    running = true;
    try { await retryThreadDoneMarkers(client); }
    catch { /* a later sweep retries after a transient store/transport failure */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { void sweep(); }, intervalMs);
  timer.unref?.();
  const unsubscribe = slack.onConnected(() => { void sweep(); });
  void sweep();
  return () => { clearInterval(timer); unsubscribe(); };
}
