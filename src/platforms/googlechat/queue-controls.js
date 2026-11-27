// Google Chat's busy-thread Steer / Cancel card: a message that has to wait behind running work in
// its session is already queued and runs on its own; under its "Queued in this session" line a
// Cards v2 card offers Steer conversation and Cancel request.
//
// The decision (who may answer, what a steer may interrupt) is the shared one in
// ../queue-choice.js. Clicks arrive through the ordinary card path (HTTP endpoint → verified event
// → control inbox → controls.onCard), so the conversation and the clicker come from Google's
// envelope, never the card data, and every answer is written back through the Chat REST API: a
// settled choice replaces the shared card's buttons with its outcome; a refusal, or "still queued",
// goes only to the clicker as a private message.
import { chatAction, chatButtons, chatCard, chatText } from "./cards.js";
import {
  QUEUE_STEER_ACTION, QUEUE_CANCEL_ACTION, QUEUE_DONE_TEXT, QUEUE_EVENT_ID, QUEUED_CARD_LINES, STILL_QUEUED_TITLE,
  answerQueueChoice, createQueuedCardTracker, isQueueAction, queuedNoticeText,
} from "../queue-choice.js";

// Google Chat has one intake lane per subscription (the transport's message namespace).
export const GOOGLE_CHAT_QUEUE_LANE = "chat";
const LANES = new Set([GOOGLE_CHAT_QUEUE_LANE]);
export const QUEUED_CARD_TITLE = "⏳ Waiting behind work in this session";
const FALLBACK_LINE = "Buttons not responding? `/stop` stops this session's work, including this message.";

const buttons = data => chatButtons([chatAction("Steer conversation", QUEUE_STEER_ACTION, "", data), chatAction("Cancel request", QUEUE_CANCEL_ACTION, "", data)]);

// The card names the waiting row only (lane + durable id); never an identity or a session.
export function queuedMessageChatCard({ queuedEvent }) {
  return chatCard(QUEUED_CARD_TITLE, [...QUEUED_CARD_LINES.map(chatText), chatText(FALLBACK_LINE),
    buttons({ q: queuedEvent.kind, e: queuedEvent.eventId })]);
}

export function createGoogleChatQueueControls({ connector, conversation, log = console } = {}) {
  // A settled card keeps only its outcome line: the message text becomes the outcome and the card
  // (with its buttons) is removed.
  const settle = ({ conversationId, messageId }, text) => connector.updateCard({ conversationId, messageId, card: null, text });
  const cards = createQueuedCardTracker({ platform: "googlechat", log, update: settle });
  connector.queuedEventStarted = event => cards.started(event);

  async function notice({ message, position, queuedEvent, isQueued }) {
    if (typeof connector.postCard !== "function" || !LANES.has(queuedEvent?.kind) || !QUEUE_EVENT_ID.test(queuedEvent?.eventId || "")) return false;
    const posted = await connector.postCard({ conversationId: message.rawConversationId, threadKey: message.threadKey,
      card: queuedMessageChatCard({ queuedEvent }), text: queuedNoticeText(position) });
    cards.remember(queuedEvent, { conversationId: message.rawConversationId, messageId: posted?.messageId });
    // It may have started (or been stopped) while the card was being sent.
    if (!isQueued()) await cards.retire(queuedEvent, QUEUE_DONE_TEXT);
    return true;
  }

  // `event` is the verified, normalized click (controls.onCard has already checked its space,
  // message and thread names); `data` its parsed card values.
  async function onAction(event, { action, data }) {
    const result = await answerQueueChoice({ action, data, conversationId: event.conversationId, actorId: event.userId,
      lanes: LANES, store: connector, conversation, auditEvent: "googlechat_queue_choice" });
    const queued = { kind: data.q, eventId: data.e };
    const viewer = event.userResourceName || event.raw?.senderName || event.userId;
    const where = { conversationId: event.rawConversationId, threadKey: event.threadKey };
    const privately = text => connector.post({ ...where, ephemeralTo: viewer, text });
    if (result.final) {
      // The shared card this process posted, then the clicked one (the same card, a private
      // "still queued" copy, or — after a restart — a card this process never saw).
      const shared = cards.posted(queued);
      await cards.retire(queued, result.text);
      if (shared?.messageId !== event.messageId) {
        try { await settle({ conversationId: event.rawConversationId, messageId: event.messageId }, result.text); }
        catch (error) {
          log.warn?.(`[googlechat] queue card could not be updated: ${error?.message || error}`);
          await privately(result.text);
        }
      }
      return;
    }
    // A refused stranger gets the reason only; the sender keeps both buttons while it still waits.
    if (result.denied) return privately(result.text);
    return connector.postCard({ ...where, privateTo: viewer, text: "",
      card: chatCard(STILL_QUEUED_TITLE, [chatText(result.text), buttons({ q: queued.kind, e: queued.eventId })]) });
  }

  return { notice, onAction, isAction: isQueueAction };
}
