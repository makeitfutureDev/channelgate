// Teams' answer to Slack's busy-thread card: a message that has to wait behind running work in its
// session gets a card with Steer conversation and Cancel request. It is already queued and runs on
// its own; the card only offers the two ways to change that.
//
// The card carries no authority. Its data names one durable intake row (a closed lane word plus the
// row's id); every click re-reads that row and checks it is still waiting, that it belongs to the
// clicked conversation, and that the clicker sent it (or is a current admin admitted to the
// conversation). Because the row IS the record, the buttons keep working across a restart.
import { getChannelEntry, getChannelMeta, isAdmin } from "../../config/store.js";
import { isAuthorized } from "../../gateway/modes.js";
import { logEvent } from "../../util/logger.js";

export const QUEUE_STEER_ACTION = "queue.steer";
export const QUEUE_CANCEL_ACTION = "queue.cancel";
const LANES = new Set(["bot", "graph"]);
const EVENT_ID = /^[A-Za-z0-9:_.=+/-]{1,512}$/;

const block = (text, extra = {}) => ({ type: "TextBlock", text, wrap: true, ...extra });
const card = (title, body = [], actions = []) => ({ type: "AdaptiveCard", version: "1.4",
  body: [block(title, { weight: "Bolder" }), ...body.map(text => block(text))], ...(actions.length ? { actions } : {}) });
const button = (title, verb, data) => ({ type: "Action.Execute", title, verb, data: { cgAction: verb, ...data },
  fallback: { type: "Action.Submit", title, data: { cgAction: verb, ...data } } });

export function queuedMessageCard({ position, queuedEvent }) {
  const data = { q: queuedEvent.kind, e: queuedEvent.eventId };
  return card(`⏳ Your message is queued (position ${position}).`, [
    "It runs automatically when the work ahead of it finishes — no action needed.",
    "Steer conversation interrupts your current run and answers this message next. Cancel request drops only this message.",
  ], [button("Steer conversation", QUEUE_STEER_ACTION, data), button("Cancel request", QUEUE_CANCEL_ACTION, data)]);
}

const outcomeCard = text => card(text);
export const QUEUE_DONE_TEXT = "This message has already started, finished or been cancelled.";

export function createTeamsQueueControls({ connector, conversation, log = console } = {}) {
  // Process-local: which card announced which waiting message, so the card can say "started"
  // instead of offering buttons for a message that is already running. After a restart the card
  // keeps its buttons, and a click answers that the message is no longer waiting.
  const cards = new Map();
  const keyOf = ({ kind, eventId }) => `${kind}:${eventId}`;
  const retire = async (key, text) => {
    const posted = cards.get(key);
    cards.delete(key);
    if (!posted?.messageId || typeof connector.updateCard !== "function") return;
    await connector.updateCard({ conversationId: posted.conversationId, messageId: posted.messageId, card: outcomeCard(text), text })
      .catch(error => log.warn?.(`[msteams] queue card could not be updated: ${error?.message || error}`));
  };
  connector.queuedEventStarted = (event) => {
    if (!event?.eventId || !cards.has(keyOf(event))) return;
    void retire(keyOf(event), "▶️ Your queued message has started.");
  };

  async function notice({ message, position, queuedEvent, isQueued }) {
    if (typeof connector.postCard !== "function" || !LANES.has(queuedEvent?.kind) || !EVENT_ID.test(queuedEvent?.eventId || "")) return false;
    const text = `Queued in this session (position ${position}).`;
    const posted = await connector.postCard({ conversationId: message.rawConversationId, threadKey: message.threadKey,
      card: queuedMessageCard({ position, queuedEvent }), text });
    if (posted?.messageId) cards.set(keyOf(queuedEvent), { conversationId: message.rawConversationId, messageId: posted.messageId });
    // It may have started (or been stopped) while the card was being sent.
    if (!isQueued()) await retire(keyOf(queuedEvent), QUEUE_DONE_TEXT);
    while (cards.size > 1000) cards.delete(cards.keys().next().value);
    return true;
  }

  // Who may answer: the sender, or a current organization admin the conversation admits. The
  // conversation check uses Teams' verified envelope, never the card data.
  async function authority(interaction, target) {
    if (target.conversationId !== interaction.conversationId) return { ok: false, reason: "conversation" };
    if (interaction.actorId === target.authorId) return { ok: true, admin: false };
    if (!await isAdmin(interaction.actorId)) return { ok: false, reason: "owner" };
    const entry = await getChannelEntry(interaction.conversationId);
    const meta = entry ? await getChannelMeta(entry.slug) : null;
    if (!meta || !isAuthorized(meta, interaction.actorId, Boolean(entry.isDM), { isAdminUser: true })) return { ok: false, reason: "access" };
    return { ok: true, admin: true };
  }

  async function answer(interaction) {
    const choice = interaction.action === QUEUE_STEER_ACTION ? "steer" : "cancel";
    const kind = interaction.data.q, eventId = interaction.data.e;
    if (!LANES.has(kind) || typeof eventId !== "string" || !EVENT_ID.test(eventId)) throw new Error("Invalid queue control.");
    const event = { kind, eventId };
    const target = connector.queuedEvent?.(event);
    if (!target || target.status !== "queued") { cards.delete(keyOf(event)); return { text: QUEUE_DONE_TEXT, final: true }; }
    const allowed = await authority(interaction, target);
    if (!allowed.ok) {
      return { text: allowed.reason === "owner" ? "This choice belongs to the person who sent that message."
        : allowed.reason === "access" ? "Only a current organization admin with access to this conversation can answer another person's choice."
          : "This control belongs to a different conversation.", final: false, denied: true };
    }
    const audit = outcome => logEvent("teams_queue_choice", { channel: target.conversationId, author: interaction.actorId,
      requesterId: target.authorId, choice, outcome, admin: allowed.admin });
    if (choice === "cancel") {
      // Re-read inside the same synchronous step as the write: a row that started meanwhile is
      // not "queued" any more and the update changes nothing.
      const cancelled = connector.cancelQueuedEvent(event);
      await audit(cancelled ? "cancelled" : "not-queued");
      return { text: cancelled ? "🚫 Queued message cancelled. Work already running keeps going." : QUEUE_DONE_TEXT, final: true };
    }
    // Steer. Everything from the check to the interrupt is synchronous, so the run it inspected is
    // the run it interrupts and no other message can start in between.
    const ahead = connector.queuedAhead(event);
    if (!ahead) { await audit("not-queued"); return { text: QUEUE_DONE_TEXT, final: true }; }
    if (ahead.some(row => row.authorId !== target.authorId)) {
      await audit("other-author-queued");
      return { text: "Another person's message is waiting ahead of this one, so it keeps its place. It still runs automatically.", final: false };
    }
    const state = conversation.steerState(target.conversationId, target.sessionKey, target.authorId);
    if (state === "other-author" || state === "clearing") {
      await audit(state);
      return { text: state === "clearing" ? "This session is being cleared. Your message stays queued."
        : "The running work belongs to another person, so it is not interrupted. Your message stays queued and runs automatically.", final: false };
    }
    if (!connector.prioritizeQueuedEvent(event)) { await audit("not-queued"); return { text: QUEUE_DONE_TEXT, final: true }; }
    const steered = conversation.steer({ conversationId: target.conversationId, sessionKey: target.sessionKey, authorId: target.authorId });
    await audit(steered === "steered" ? "steered" : "prioritized");
    return { text: steered === "steered" ? "↪️ Steering — interrupting your current run to answer this message next."
      : "↪️ Moved to the front of this session's queue. It starts as soon as a slot is free.", final: true };
  }

  async function onAction(interaction, { respond }) {
    const result = await answer(interaction);
    const event = { kind: interaction.data.q, eventId: interaction.data.e };
    // A refusal is the clicker's own answer: the shared card stays as it is for its owner.
    if (result.final) {
      cards.delete(keyOf(event));
      if (interaction.responseMessageId && typeof connector.updateCard === "function") {
        await connector.updateCard({ conversationId: interaction.nativeConversationId, messageId: interaction.responseMessageId,
          card: outcomeCard(result.text), text: result.text }).catch(() => {});
      }
    }
    // The sender keeps both buttons when the message is still waiting; a refused stranger does not.
    if (!result.final && !result.denied) {
      const data = { q: event.kind, e: event.eventId };
      return respond(card("⏳ Your message is still queued.", [result.text],
        [button("Steer conversation", QUEUE_STEER_ACTION, data), button("Cancel request", QUEUE_CANCEL_ACTION, data)]));
    }
    return respond(outcomeCard(result.text));
  }

  return { notice, onAction, isAction: action => action === QUEUE_STEER_ACTION || action === QUEUE_CANCEL_ACTION };
}
