// Google Chat reaction events. A Chat app receives NO interaction event for a reaction; Google
// Workspace Events subscriptions publish them to Pub/Sub as CloudEvents
// (`google.workspace.chat.reaction.v1.created|deleted`, plus batch variants). This module turns
// one such event into plain records; the transport decides what may act on them.
import { createHash } from "node:crypto";
import { isMessageName, isUserName } from "./api.js";

export const REACTION_CREATED = "google.workspace.chat.reaction.v1.created";
export const REACTION_DELETED = "google.workspace.chat.reaction.v1.deleted";
export const REACTION_BATCH_CREATED = "google.workspace.chat.reaction.v1.batchCreated";
export const REACTION_BATCH_DELETED = "google.workspace.chat.reaction.v1.batchDeleted";
export const REACTION_EVENT_TYPES = [REACTION_CREATED, REACTION_DELETED];
export const SUBSCRIPTION_LIFECYCLE_PREFIX = "google.workspace.events.subscription.v1.";

// How old a reaction may be when it reaches the daemon. Pub/Sub retains undelivered events for
// days; an outage must not replay a stale Stop onto newer work or start long-forgotten requests.
export const REACTION_MAX_AGE_MS = Object.freeze({ stop: 10 * 60_000, engage: 60 * 60_000, ack: 24 * 60 * 60_000 });
const FUTURE_SKEW_MS = 5 * 60_000;

const REACTION_RE = /^(spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+)\/reactions\/[A-Za-z0-9_.-]+$/;
const STOP = new Set(["🛑"]);
const ACK = new Set(["✅"]);
const bare = value => String(value || "").replace(/[\uFE0F\uFE0E]/g, "").trim();

export function isReactionEventType(type) {
  return [REACTION_CREATED, REACTION_DELETED, REACTION_BATCH_CREATED, REACTION_BATCH_DELETED].includes(String(type || ""));
}

// Stop and Tick are fixed controls on every surface; activation emojis are the operator's
// `googleChatMentionReactions` (which the settings validator keeps disjoint from the controls).
// Custom (workspace-uploaded) emojis carry no Unicode value and never act.
export function googleChatReactionAction(emoji, activationReactions = ["🤖"]) {
  const unicode = bare(emoji?.unicode);
  if (!unicode) return "";
  if (STOP.has(unicode)) return "stop";
  if (ACK.has(unicode)) return "ack";
  return activationReactions.some(item => bare(item) === unicode) ? "engage" : "";
}

// Both single and batch payloads, created and deleted. Anything malformed is dropped here rather
// than redelivered forever: a reaction we cannot attribute to a message and a person cannot act.
export function parseReactionEvent(envelope, attributes = {}) {
  const type = String(attributes["ce-type"] || "");
  const time = String(attributes["ce-time"] || "");
  const items = type === REACTION_BATCH_CREATED || type === REACTION_BATCH_DELETED
    ? (Array.isArray(envelope?.reactions) ? envelope.reactions.map(item => item?.reaction) : [])
    : [envelope?.reaction];
  const deleted = type === REACTION_DELETED || type === REACTION_BATCH_DELETED;
  const out = [];
  for (const reaction of items) {
    const name = String(reaction?.name || "");
    const match = REACTION_RE.exec(name);
    if (!match || !isMessageName(match[1])) continue;
    const user = reaction?.user || {};
    out.push({
      transition: deleted ? "removed" : "added",
      name,
      messageName: match[1],
      space: match[1].split("/messages/")[0],
      userName: isUserName(user.name) ? String(user.name) : "",
      userType: String(user.type || ""),
      emoji: reaction?.emoji || {},
      eventTime: time,
      // CloudEvent time is the provider's event time. Retries and Pub/Sub redeliveries keep it, so
      // reaction name + time is one stable identity, while a genuine re-addition gets a new one.
      id: `reaction:${createHash("sha256").update(JSON.stringify([name, time, deleted ? "removed" : "added"])).digest("hex")}`,
    });
  }
  return out;
}

// Fresh, and not from the future: the only reactions allowed to act.
export function reactionIsFresh(item, action, now = Date.now()) {
  const at = Date.parse(item?.eventTime);
  if (!Number.isFinite(at) || at > now + FUTURE_SKEW_MS) return false;
  return now - at <= (REACTION_MAX_AGE_MS[action] ?? 0);
}

// The reactor arrives as `users/NNN` only. Gateway identities are e-mail addresses; the transport
// records each author's `users/NNN` (`googleChatUserName`) whenever Google delivers one of their
// messages or clicks. Unknown or ambiguous resources resolve to nobody — never to a guess.
export function resolveReactor(userName, users = {}) {
  if (!isUserName(userName)) return "";
  let found = "";
  for (const [id, record] of Object.entries(users)) {
    if (record?.googleChatUserName !== userName) continue;
    if (found) return "";
    found = id;
  }
  return found;
}
