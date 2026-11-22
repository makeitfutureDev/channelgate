// Google Chat edited messages. A Chat app receives NO interaction event when someone edits a
// message; Google Workspace Events delivers `google.workspace.chat.message.v1.updated` (and its
// batch variant, sent automatically for bursts) through the same per-space subscriptions that carry
// reactions. The payload is the CURRENT message only — never the previous version — so "the edit
// added a mention" is decided against what the gateway already accepted for that message (the
// durable inbox), not against an earlier text. This module only parses; the transport decides.
import { isMessageName, isUserName } from "./api.js";
import { INBOUND_RETENTION_MS } from "../durable-inbox.js";

export const MESSAGE_UPDATED = "google.workspace.chat.message.v1.updated";
export const MESSAGE_BATCH_UPDATED = "google.workspace.chat.message.v1.batchUpdated";

// An edit is acted on only while it is recent (Pub/Sub keeps undelivered events for days: an outage
// must not start long-forgotten requests), and only on a message young enough that the inbox still
// remembers whether the app already handled it. Past the inbox retention an edit of an old,
// already-answered message could not be told apart from a first mention, so it never acts.
export const EDIT_MAX_AGE_MS = 60 * 60_000;
export const EDITED_MESSAGE_MAX_AGE_MS = INBOUND_RETENTION_MS - 24 * 60 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;

export function isMessageUpdateEventType(type) {
  return type === MESSAGE_UPDATED || type === MESSAGE_BATCH_UPDATED;
}

// Single `{ message }` and batch `{ messages: [{ message }] }` payloads. Anything that cannot be
// attributed to a message in a space is dropped here rather than redelivered forever.
export function parseMessageUpdateEvent(envelope, attributes = {}) {
  const type = String(attributes["ce-type"] || "");
  const time = String(attributes["ce-time"] || "");
  const items = type === MESSAGE_BATCH_UPDATED
    ? (Array.isArray(envelope?.messages) ? envelope.messages.map(item => item?.message) : [])
    : type === MESSAGE_UPDATED ? [envelope?.message] : [];
  const out = [];
  for (const message of items) {
    const name = String(message?.name || "");
    if (!isMessageName(name)) continue;
    const sender = message?.sender || {};
    out.push({
      message,
      messageName: name,
      space: name.split("/messages/")[0],
      senderName: isUserName(sender.name) ? String(sender.name) : "",
      senderType: String(sender.type || ""),
      // Google sets lastUpdateTime only when a PERSON edited the message; empty means some other
      // update (an attachment finishing, a card), which is never an edit trigger.
      lastUpdateTime: String(message?.lastUpdateTime || ""),
      createTime: String(message?.createTime || ""),
      eventTime: time || String(message?.lastUpdateTime || ""),
    });
  }
  return out;
}

// Fresh edit of a message the inbox can still vouch for. Invalid or future times never act.
export function editIsFresh(item, now = Date.now()) {
  const at = Date.parse(item?.eventTime);
  const created = Date.parse(item?.createTime);
  if (!Number.isFinite(at) || at > now + FUTURE_SKEW_MS || now - at > EDIT_MAX_AGE_MS) return false;
  return Number.isFinite(created) && created <= now + FUTURE_SKEW_MS && now - created <= EDITED_MESSAGE_MAX_AGE_MS;
}

// Exact: a USER_MENTION of THIS app's `users/…` id. Workspace Events carry every edit in the space,
// including edits that mention a different app, so "some bot was mentioned" (enough for an
// interaction event, which Google only sends to the mentioned app) is not enough here.
export function mentionsApp(message, appUserName) {
  if (!isUserName(appUserName)) return false;
  return (message?.annotations || []).some(a => a?.type === "USER_MENTION" && a?.userMention?.user?.name === appUserName);
}

// The text the model should read: `argumentText` when Google supplied it, otherwise the text with
// this app's mention ranges cut out (annotation startIndex/length are UTF-16 offsets, like JS).
export function editedArgumentText(message, appUserName) {
  if (typeof message?.argumentText === "string") return message.argumentText;
  let text = String(message?.text || "");
  const ranges = (message?.annotations || [])
    .filter(a => a?.type === "USER_MENTION" && a?.userMention?.user?.name === appUserName)
    .map(a => [Number(a.startIndex), Number(a.length)])
    .filter(([start, length]) => Number.isInteger(start) && Number.isInteger(length) && start >= 0 && length > 0 && start + length <= text.length)
    .sort((a, b) => b[0] - a[0]);
  for (const [start, length] of ranges) text = text.slice(0, start) + text.slice(start + length);
  return text.replace(/\s{2,}/g, " ").trim();
}

// The app's own `users/…` id, read from a message Google delivered TO the app (an interaction
// event, never a Workspace Events payload): a registered slash command names its app, and a space
// message that mentions exactly one app was delivered because it mentions us. Anything else is
// ambiguous and yields nothing.
export function appUserNameFromInteraction(message, { kind = "" } = {}) {
  const annotations = message?.annotations || [];
  const command = annotations.find(a => a?.type === "SLASH_COMMAND")?.slashCommand?.bot?.name;
  if (isUserName(command)) return String(command);
  if (kind === "dm" || annotations.some(a => a?.type === "SLASH_COMMAND")) return "";
  const bots = new Set(annotations
    .filter(a => a?.type === "USER_MENTION" && a?.userMention?.user?.type === "BOT")
    .map(a => String(a.userMention.user.name || "")));
  const [only] = bots;
  return bots.size === 1 && isUserName(only) ? only : "";
}
