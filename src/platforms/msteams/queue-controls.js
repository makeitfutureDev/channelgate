// Teams' answer to Slack's busy-thread card: a message that has to wait behind running work in its
// session gets an Adaptive Card with Steer conversation and Cancel request. It is already queued and
// runs on its own; the card only offers the two ways to change that.
//
// The decision (who may answer, what a steer may interrupt) is the shared one in
// ../queue-choice.js; this module renders it as Adaptive Cards and answers in the invoke response.
import {
  QUEUE_STEER_ACTION, QUEUE_CANCEL_ACTION, QUEUE_DONE_TEXT, QUEUE_EVENT_ID, QUEUED_CARD_LINES, STILL_QUEUED_TITLE,
  answerQueueChoice, createQueuedCardTracker, isQueueAction, queuedCardTitle, queuedNoticeText,
} from "../queue-choice.js";

export { QUEUE_STEER_ACTION, QUEUE_CANCEL_ACTION, QUEUE_DONE_TEXT };
const LANES = new Set(["bot", "graph"]);

const block = (text, extra = {}) => ({ type: "TextBlock", text, wrap: true, ...extra });
const card = (title, body = [], actions = []) => ({ type: "AdaptiveCard", version: "1.4",
  body: [block(title, { weight: "Bolder" }), ...body.map(text => block(text))], ...(actions.length ? { actions } : {}) });
const button = (title, verb, data) => ({ type: "Action.Execute", title, verb, data: { cgAction: verb, ...data },
  fallback: { type: "Action.Submit", title, data: { cgAction: verb, ...data } } });
const buttons = data => [button("Steer conversation", QUEUE_STEER_ACTION, data), button("Cancel request", QUEUE_CANCEL_ACTION, data)];

export function queuedMessageCard({ position, queuedEvent }) {
  return card(queuedCardTitle(position), QUEUED_CARD_LINES, buttons({ q: queuedEvent.kind, e: queuedEvent.eventId }));
}

const outcomeCard = text => card(text);

export function createTeamsQueueControls({ connector, conversation, log = console } = {}) {
  const cards = createQueuedCardTracker({ platform: "msteams", log, update: async (posted, text) => {
    if (typeof connector.updateCard !== "function") return;
    await connector.updateCard({ conversationId: posted.conversationId, messageId: posted.messageId, card: outcomeCard(text), text });
  } });
  connector.queuedEventStarted = event => cards.started(event);

  async function notice({ message, position, queuedEvent, isQueued }) {
    if (typeof connector.postCard !== "function" || !LANES.has(queuedEvent?.kind) || !QUEUE_EVENT_ID.test(queuedEvent?.eventId || "")) return false;
    const posted = await connector.postCard({ conversationId: message.rawConversationId, threadKey: message.threadKey,
      card: queuedMessageCard({ position, queuedEvent }), text: queuedNoticeText(position) });
    cards.remember(queuedEvent, { conversationId: message.rawConversationId, messageId: posted?.messageId });
    // It may have started (or been stopped) while the card was being sent.
    if (!isQueued()) await cards.retire(queuedEvent, QUEUE_DONE_TEXT);
    return true;
  }

  async function onAction(interaction, { respond }) {
    const result = await answerQueueChoice({ action: interaction.action, data: interaction.data, conversationId: interaction.conversationId,
      actorId: interaction.actorId, lanes: LANES, store: connector, conversation, auditEvent: "teams_queue_choice" });
    const event = { kind: interaction.data.q, eventId: interaction.data.e };
    // A refusal is the clicker's own answer: the shared card stays as it is for its owner.
    if (result.final) {
      cards.forget(event);
      if (interaction.responseMessageId && typeof connector.updateCard === "function") {
        await connector.updateCard({ conversationId: interaction.nativeConversationId, messageId: interaction.responseMessageId,
          card: outcomeCard(result.text), text: result.text }).catch(() => {});
      }
    }
    // The sender keeps both buttons when the message is still waiting; a refused stranger does not.
    if (!result.final && !result.denied) return respond(card(STILL_QUEUED_TITLE, [result.text], buttons({ q: event.kind, e: event.eventId })));
    return respond(outcomeCard(result.text));
  }

  return { notice, onAction, isAction: isQueueAction };
}
