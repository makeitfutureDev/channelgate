// Durable external-conversation → chat-thread binding (a Slack root ts; a Google Chat/Teams thread name). The daemon is singleton; this lock covers
// the network awaits before a binding exists, while SQLite owns the restart-durable mapping.
// Bindings deliberately outlive api_jobs retention and contain no engine session authority.
import { getDb } from "../db/index.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { postNotice } from "../platforms/notify.js";
import { isSlackTs } from "../slack/thread-keys.js";
import { DEFAULT_PLATFORM } from "../platforms/registry.js";

export function validateConversationKey(key) {
  if (key === undefined) return "";
  if (typeof key !== "string" || !key.trim() || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw Object.assign(new Error("conversationKey must be a non-empty string of at most 200 characters without control characters."), { status: 400 });
  }
  return key; // Never truncate or normalize two caller keys into the same conversation.
}

function slackError(response) {
  if (response?.ok === false) throw Object.assign(new Error("Slack request failed."), { data: { error: response.error } });
  return response;
}

async function rootExists(client, channelId, threadTs) {
  try {
    // A one-message history range works with a bot token on public and private channels;
    // conversations.replies requires a user token for those channel types.
    const result = slackError(await client.conversations.history({ channel: channelId, oldest: threadTs, latest: threadTs, inclusive: true, limit: 1 }));
    if (!Array.isArray(result?.messages)) throw new Error("Slack did not return message history.");
    return result.messages.some((message) => message.ts === threadTs && message.subtype !== "tombstone");
  } catch (error) {
    const code = error?.data?.error;
    if (["message_not_found", "thread_not_found"].includes(code)) return false;
    // Permission loss, throttling and transport failures do not prove that the root vanished.
    throw error;
  }
}

export async function threadPermalink(client, channelId, threadTs) {
  try {
    const result = slackError(await client.chat.getPermalink({ channel: channelId, message_ts: threadTs }));
    return typeof result?.permalink === "string" && result.permalink ? result.permalink : null;
  } catch {
    return null; // Link lookup must not invalidate an already-created root or accepted event.
  }
}

// Google Chat / Teams: the binding holds the THREAD NAME the first kickoff opened (same column).
// There is no bot-token read of one message, so reuse is proven by the post itself: an event posted
// into the saved thread must come back in that thread. Chat falls back to a new thread when the
// saved one is gone (REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD); that new thread replaces the binding and
// begins a fresh agent session, exactly as a deleted Slack root does. A failed post throws (503).
async function resolveChatConversation(db, { client, channelId, conversationKey, kickoffText }) {
  const saved = db.prepare("SELECT thread_ts FROM api_conversations WHERE channel_id = ? AND conversation_key = ?").get(channelId, conversationKey);
  const posted = await postNotice(client, { conversationId: channelId, threadKey: saved?.thread_ts || "", text: kickoffText });
  const thread = String(posted?.threadKey || "");
  if (!thread) throw new Error("The chat platform did not return a thread for the conversation event.");
  const reused = Boolean(saved && thread === saved.thread_ts);
  if (!reused) {
    const now = Date.now();
    db.prepare(`INSERT INTO api_conversations(channel_id, conversation_key, thread_ts, thread_permalink, created_ms, updated_ms)
      VALUES(?, ?, ?, NULL, ?, ?) ON CONFLICT(channel_id, conversation_key)
      DO UPDATE SET thread_ts = excluded.thread_ts, thread_permalink = NULL, updated_ms = excluded.updated_ms`)
      .run(channelId, conversationKey, thread, now, now);
  } else {
    db.prepare("UPDATE api_conversations SET updated_ms = ? WHERE channel_id = ? AND conversation_key = ?").run(Date.now(), channelId, conversationKey);
  }
  return { threadTs: thread, threadReused: reused, threadPermalink: null };
}

export async function resolveApiConversation({ client, channelId, conversationKey, kickoffText, platform = DEFAULT_PLATFORM }) {
  const release = await acquireKeyedLock("api-conversation", JSON.stringify([channelId, conversationKey]));
  try {
    const db = getDb();
    if (platform && platform !== DEFAULT_PLATFORM) return await resolveChatConversation(db, { client, channelId, conversationKey, kickoffText });
    const saved = db.prepare("SELECT thread_ts, thread_permalink FROM api_conversations WHERE channel_id = ? AND conversation_key = ?").get(channelId, conversationKey);
    const reused = Boolean(saved && await rootExists(client, channelId, saved.thread_ts));
    let threadTs = reused ? saved.thread_ts : null;
    let permalink = reused ? saved.thread_permalink || null : null;
    if (!reused) {
      const posted = await postNotice(client, { conversationId: channelId, text: kickoffText });
      if (!isSlackTs(posted?.messageId) || posted.conversationId !== channelId) throw new Error("Slack did not return the requested thread root.");
      threadTs = posted.messageId;
      // Save the root before any optional remote lookup. If a later step fails, a retry reuses it.
      const now = Date.now();
      db.prepare(`INSERT INTO api_conversations(channel_id, conversation_key, thread_ts, thread_permalink, created_ms, updated_ms)
        VALUES(?, ?, ?, NULL, ?, ?) ON CONFLICT(channel_id, conversation_key)
        DO UPDATE SET thread_ts = excluded.thread_ts, thread_permalink = NULL, updated_ms = excluded.updated_ms`)
        .run(channelId, conversationKey, threadTs, now, now);
    } else {
      // Each event stays visible, as a reply rather than another top-level root.
      const posted = await postNotice(client, { conversationId: channelId, threadKey: threadTs, text: kickoffText });
      if (!posted?.messageId) throw new Error("Slack did not accept the conversation event.");
    }
    if (!permalink) permalink = await threadPermalink(client, channelId, threadTs);
    db.prepare("UPDATE api_conversations SET thread_permalink = ?, updated_ms = ? WHERE channel_id = ? AND conversation_key = ?")
      .run(permalink, Date.now(), channelId, conversationKey);
    return { threadTs, threadReused: reused, threadPermalink: permalink };
  } finally {
    release();
  }
}
