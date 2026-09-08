// Session identity is separate from a platform's native reply address. In a flat group chat,
// each new message starts a session; quoted user and bot messages point back to its root.
// Persist only IDs, scoped to the qualified conversation, so quotes still resolve after restart.
import { getDb } from "../db/index.js";

export function rememberReplySession(conversationId, messageId, threadKey) {
  if (!messageId) return;
  getDb().prepare(`INSERT INTO conversation_reply_sessions(conversation_id, message_id, thread_key)
    VALUES (?, ?, ?) ON CONFLICT(conversation_id, message_id) DO NOTHING`)
    .run(conversationId, messageId, threadKey);
}

export function sessionKeyForMessage(message) {
  if (message.threadKey) return message.threadKey;
  if (message.kind !== "group") return message.conversationId;
  if (!message.messageId) throw new Error("Group chat message has no message id");
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const lookup = db.prepare(`SELECT thread_key FROM conversation_reply_sessions
      WHERE conversation_id = ? AND message_id = ?`);
    const existing = lookup.get(message.conversationId, message.messageId);
    const quoted = message.replyToId ? lookup.get(message.conversationId, message.replyToId) : null;
    const key = existing?.thread_key || quoted?.thread_key || `group:${message.replyToId || message.messageId}`;
    rememberReplySession(message.conversationId, message.messageId, key);
    db.exec("COMMIT");
    return key;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
