// One finished answer onto a non-Slack surface: the platform-neutral half of ingest.js's reply path,
// shared with the daemon-driven turns that run there too (agent mail, src/gateway/agent-mail.js).
import { userReplyMentionsEnabled } from "../config/user-preferences.js";
import { getUser } from "../config/store.js";
import { platformOr } from "./registry.js";
import { postFormatted } from "./connector.js";

// One answer, formatted for the surface, replacing the placeholder where the surface allows it.
// A long answer is split at the platform's cap; the FIRST chunk edits the placeholder and the rest
// are posted after it, so the "Working on it…" line never survives next to the real answer.
/** @param {object} connector
 * @param {object} message
 * @param {{messageId: string, conversationId?: string, threadKey?: string} | null} placeholder
 * @param {string} text
 * @param {(sent: {messageId: string, conversationId?: string, threadKey?: string}) => void} rememberReply
 * @param {string} footer
 * @param {object | null} menu */
export async function deliverConversationAnswer(connector, message, placeholder, text, rememberReply = () => {}, footer = "", menu = null, { resolveNames = true } = {}) {
  const adapter = platformOr(connector.platform);
  const directory = resolveNames ? await connector.directory?.(message.rawConversationId).catch(() => null) : null;
  const formatted = adapter.formatOutbound(text, {
    directory, capabilities: adapter.capabilities,
    // A completed foreground reply addresses its authenticated requester. Notices and DMs do
    // not add a notification tag; the surface formatter owns the native mention representation.
    requester: footer && !message.isDM && message.userId && userReplyMentionsEnabled(await getUser(message.userId))
      ? { id: message.userId, name: message.userName || message.userId } : null,
  });
  const chunks = formatted.chunks.length ? formatted.chunks : [{ text, mentions: [] }];

  if (placeholder?.messageId && adapter.capabilities.messageEdit) {
    let edited = false;
    try {
      await connector.edit({
        conversationId: placeholder.conversationId || message.rawConversationId,
        messageId: placeholder.messageId,
        text: chunks[0].text,
        mentions: chunks[0].mentions || [],
        ...(chunks.length === 1 && footer ? { footer } : {}),
        ...(chunks.length === 1 && menu ? { menu } : {}),
      });
      edited = true;
    } catch {
      // A missing placeholder can be replaced by a fresh post.
    }
    if (edited) {
      for (const [index, chunk] of chunks.slice(1).entries()) {
        rememberReply(await connector.post({
          conversationId: message.rawConversationId,
          threadKey: placeholder.threadKey || message.threadKey,
          text: chunk.text,
          mentions: chunk.mentions || [],
          ...(index === chunks.length - 2 && footer ? { footer } : {}),
          ...(index === chunks.length - 2 && menu ? { menu } : {}),
        }));
      }
      return;
    }
  }
  await postFormatted(connector, {
    conversationId: message.rawConversationId,
    threadKey: placeholder?.threadKey || message.threadKey,
    formatted: { chunks },
    footer,
    menu,
    onPosted: rememberReply,
  });
  // A failed edit can leave the working activity visible beside a freshly posted answer.
  // Remove it only after successful delivery, so a post failure never erases the only message.
  if ((adapter.id === "msteams" || connector.progressStyle === "working") && placeholder?.messageId && typeof connector.remove === "function") {
    await connector.remove({ conversationId: placeholder.conversationId || message.rawConversationId,
      messageId: placeholder.messageId }).catch(err => console.warn(`[${adapter.id}] working message cleanup failed: ${err?.message || err}`));
  }
}
