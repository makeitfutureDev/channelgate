// The busy-thread choice for surfaces other than Slack: a message that has to wait behind running
// work in its session is already queued and runs on its own; its card (an Adaptive Card on Teams,
// a Cards v2 card on Google Chat) offers Steer conversation and Cancel request. This module is the
// platform-neutral decision both cards share; each surface only renders the card and the answer.
//
// The card carries no authority. Its data names one durable intake row (a closed lane word plus the
// row's id); every click re-reads that row and checks it is still waiting, that it belongs to the
// clicked conversation (taken from the surface's verified envelope, never the card data), and that
// the clicker sent it (or is a current admin admitted to the conversation). Because the row IS the
// record, the buttons keep working across a restart.
import { getChannelEntry, getChannelMeta, isAdmin } from "../config/store.js";
import { isAuthorized } from "../gateway/modes.js";
import { logEvent } from "../util/logger.js";

export const QUEUE_STEER_ACTION = "queue.steer";
export const QUEUE_CANCEL_ACTION = "queue.cancel";
export const isQueueAction = action => action === QUEUE_STEER_ACTION || action === QUEUE_CANCEL_ACTION;
export const QUEUE_EVENT_ID = /^[A-Za-z0-9:_.=+/-]{1,512}$/;
export const QUEUE_DONE_TEXT = "This message has already started, finished or been cancelled.";
export const QUEUE_STARTED_TEXT = "▶️ Your queued message has started.";
export const queuedNoticeText = position => `Queued in this session (position ${position}).`;
export const queuedCardTitle = position => `⏳ Your message is queued (position ${position}).`;
export const QUEUED_CARD_LINES = Object.freeze([
  "It runs automatically when the work ahead of it finishes — no action needed.",
  "Steer conversation interrupts your current run and answers this message next. Cancel request drops only this message.",
]);
export const STILL_QUEUED_TITLE = "⏳ Your message is still queued.";

// Who may answer: the sender, or a current organization admin the conversation admits.
async function authority({ conversationId, actorId }, target) {
  if (target.conversationId !== conversationId) return { ok: false, reason: "conversation" };
  if (actorId === target.authorId) return { ok: true, admin: false };
  if (!await isAdmin(actorId)) return { ok: false, reason: "owner" };
  const entry = await getChannelEntry(conversationId);
  const meta = entry ? await getChannelMeta(entry.slug) : null;
  if (!meta || !isAuthorized(meta, actorId, Boolean(entry.isDM), { isAdminUser: true })) return { ok: false, reason: "access" };
  return { ok: true, admin: true };
}

// One click → { text, final, denied }. `final` means the card's question is settled (the shared card
// should lose its buttons); `denied` means the clicker may not answer it at all. `store` is the
// transport's connector carrying attachQueuedEventControls' operations; `conversation` the live
// session lanes the surface's ingest owns.
export async function answerQueueChoice({ action, data, conversationId, actorId, lanes, store, conversation, auditEvent }) {
  const choice = action === QUEUE_STEER_ACTION ? "steer" : "cancel";
  const kind = data?.q, eventId = data?.e;
  if (!lanes.has(kind) || typeof eventId !== "string" || !QUEUE_EVENT_ID.test(eventId)) throw new Error("Invalid queue control.");
  const event = { kind, eventId };
  const target = store.queuedEvent?.(event);
  if (!target || target.status !== "queued") return { text: QUEUE_DONE_TEXT, final: true };
  const allowed = await authority({ conversationId, actorId }, target);
  if (!allowed.ok) {
    return { text: allowed.reason === "owner" ? "This choice belongs to the person who sent that message."
      : allowed.reason === "access" ? "Only a current organization admin with access to this conversation can answer another person's choice."
        : "This control belongs to a different conversation.", final: false, denied: true };
  }
  const audit = outcome => logEvent(auditEvent, { channel: target.conversationId, author: actorId,
    requesterId: target.authorId, choice, outcome, admin: allowed.admin });
  if (choice === "cancel") {
    // Re-read inside the same synchronous step as the write: a row that started meanwhile is
    // not "queued" any more and the update changes nothing.
    const cancelled = store.cancelQueuedEvent(event);
    await audit(cancelled ? "cancelled" : "not-queued");
    return { text: cancelled ? "🚫 Queued message cancelled. Work already running keeps going." : QUEUE_DONE_TEXT, final: true };
  }
  // Steer. Everything from the check to the interrupt is synchronous, so the run it inspected is
  // the run it interrupts and no other message can start in between.
  const ahead = store.queuedAhead(event);
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
  if (!store.prioritizeQueuedEvent(event)) { await audit("not-queued"); return { text: QUEUE_DONE_TEXT, final: true }; }
  const steered = conversation.steer({ conversationId: target.conversationId, sessionKey: target.sessionKey, authorId: target.authorId });
  await audit(steered === "steered" ? "steered" : "prioritized");
  return { text: steered === "steered" ? "↪️ Steering — interrupting your current run to answer this message next."
    : "↪️ Moved to the front of this session's queue. It starts as soon as a slot is free.", final: true };
}

// Process-local memory of which posted card announced which waiting message, so the card can say
// "started" instead of offering buttons for a message that is already running. After a restart the
// card keeps its buttons, and a click answers that the message is no longer waiting.
// `update(posted, text)` repaints one posted card on the surface.
export function createQueuedCardTracker({ update, log = console, platform = "platform" } = {}) {
  const cards = new Map();
  const keyOf = ({ kind, eventId }) => `${kind}:${eventId}`;
  const retire = async (event, text) => {
    const key = keyOf(event), posted = cards.get(key);
    cards.delete(key);
    if (!posted?.messageId) return;
    await Promise.resolve().then(() => update(posted, text))
      .catch(error => log.warn?.(`[${platform}] queue card could not be updated: ${error?.message || error}`));
  };
  return {
    remember(event, posted) {
      if (posted?.messageId) cards.set(keyOf(event), posted);
      while (cards.size > 1000) cards.delete(cards.keys().next().value);
    },
    forget: event => cards.delete(keyOf(event)),
    posted: event => cards.get(keyOf(event)) || null,
    retire,
    started(event) {
      if (!event?.eventId || !cards.has(keyOf(event))) return;
      void retire(event, QUEUE_STARTED_TEXT);
    },
  };
}
