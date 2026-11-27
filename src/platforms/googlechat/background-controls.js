// Google Chat access to background work: the Cards v2 "Check status" button on a job's started
// notice, and `/jobs` listing what is running in this conversation. Same gate as Slack's button
// and Teams': an admin, an approved user, or an explicit guest of THIS conversation; a job is
// reported only for the conversation Google's verified click envelope names, never one the card
// data names. Every answer is a private message only the clicker (or the /jobs sender) sees.
import {
  BACKGROUND_ACCESS_DENIED, BACKGROUND_STATUS_ACTION, backgroundAccessEntry, backgroundJobStatus, backgroundJobsChatCard,
  backgroundJobsText, backgroundStatusChatCard, listBackgroundJobs,
} from "../../gateway/background-status.js";

export function createGoogleChatBackgroundControls({ connector, status = backgroundJobStatus, list = listBackgroundJobs, log = console } = {}) {
  // Process-local: the private status cards this process posted, so a Refresh repaints its own
  // card instead of adding another. After a restart a Refresh simply posts a fresh private card.
  const statusCards = new Set();
  const remember = messageId => {
    if (!messageId) return;
    statusCards.add(messageId);
    while (statusCards.size > 1000) statusCards.delete(statusCards.values().next().value);
  };

  // `event` is the verified, normalized click (controls.onCard has already checked its names).
  async function onAction(event, { data }) {
    const where = { conversationId: event.rawConversationId, threadKey: event.threadKey };
    const viewer = event.userResourceName || event.raw?.senderName || event.userId;
    const entry = await backgroundAccessEntry(event.conversationId, event.userId);
    if (!entry) { await connector.post({ ...where, ephemeralTo: viewer, text: BACKGROUND_ACCESS_DENIED }); return; }
    const card = backgroundStatusChatCard(status({ jobId: data.id, slug: entry.slug }));
    if (statusCards.has(event.messageId)) {
      try { await connector.updateCard({ conversationId: event.rawConversationId, messageId: event.messageId, card, text: "" }); return; }
      catch (error) { log.warn?.(`[googlechat] background status refresh failed: ${error?.message || error}`); }
    }
    const sent = await connector.postCard({ ...where, privateTo: viewer, card, text: "" });
    remember(sent?.messageId);
  }

  // `/jobs`: the conversation's running work, each with its own status button, shown privately to
  // the sender; the text list is the fallback when a private card cannot be delivered.
  async function command({ message, reply }) {
    if (message.trigger === "reaction" || !/^\/jobs\s*$/i.test(String(message.text || "").trim())) return false;
    const entry = await backgroundAccessEntry(message.conversationId, message.userId);
    if (!entry) { await reply(BACKGROUND_ACCESS_DENIED); return true; }
    const jobs = list(entry.slug);
    const viewer = message.raw?.senderName || "";
    if (typeof connector.postCard === "function" && /^users\/[A-Za-z0-9_-]+$/.test(viewer)) {
      try {
        await connector.postCard({ conversationId: message.rawConversationId, threadKey: message.threadKey, privateTo: viewer,
          card: backgroundJobsChatCard(jobs), text: "" });
        return true;
      } catch (error) { log.warn?.(`[googlechat] /jobs card could not be posted: ${error?.message || error}`); }
    }
    await reply(backgroundJobsText(jobs));
    return true;
  }

  return { onAction, command, isAction: action => action === BACKGROUND_STATUS_ACTION };
}
