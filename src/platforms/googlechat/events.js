// Turning a Pub/Sub payload into something the gateway can act on.
//
// Google publishes Chat interaction events as CloudEvents: the EVENT TYPE lives in the Pub/Sub
// message attributes (`ce-type`), not in the JSON body, and the body's shape depends on that type.
// Three envelope layouts exist in the wild depending on how the app was configured, and an
// installation that hits the one we didn't handle just looks silently deaf — so all three are
// accepted, and anything unrecognized is ACKed and dropped rather than redelivered forever.
import { makeInbound } from "../inbound.js";

// A Chat app is added to a space, removed, a message arrives, a card button is clicked. We act on
// messages; membership tells us our own bot id (which is how mention detection works before the app
// has ever been mentioned).
export function parseChatEvent(envelope, attributes = {}) {
  const ceType = String(attributes["ce-type"] || attributes.ceType || "");
  const chat = envelope?.chat || {};

  if (ceType.includes("membership")) {
    const payload = chat.membershipPayload || {};
    return {
      type: ceType.includes("deleted") ? "membership.removed" : "membership.added",
      space: payload.space || {},
      membership: payload.membership || {},
    };
  }
  // Card clicks arrive on the same topic. We do not render cards yet, so they are ACKed as handled
  // rather than parsed — dropping them as "unknown" would be indistinguishable from a bug.
  if (ceType.includes("widget") || ceType.includes("card")) return { type: "card" };

  const extracted = extractMessage(envelope, chat);
  if (!extracted) return { type: "unknown", ceType };
  return { type: "message", ...extracted };
}

// Format 1 — Workspace Add-ons wrapper: { chat: { messagePayload: { message, space } } }
// Format 2 — native Chat API Pub/Sub:   { chat: { message, space } }  (no payload wrapper)
// Format 3 — legacy/HTTP-shaped event:  { message, space, type: "MESSAGE" }
function extractMessage(envelope, chat) {
  const payload = chat.messagePayload;
  if (payload?.message) return { message: payload.message, space: payload.space || payload.message.space || {} };
  if (chat.message) return { message: chat.message, space: chat.space || chat.message.space || {} };
  if (envelope?.message && (!envelope.type || String(envelope.type).toUpperCase() === "MESSAGE")) {
    return { message: envelope.message, space: envelope.space || envelope.message.space || {} };
  }
  return null;
}

// Google Chat has no "the app was mentioned" flag. It has annotations: a USER_MENTION whose user is
// of type BOT is us (a space contains exactly one instance of our app). `argumentText` is the text
// with the leading mention already stripped, which is what we want to feed the model — but its
// presence is NOT itself proof of a mention, so the annotation is the thing we test.
export function mentionsBot(message, botUserId = "") {
  for (const a of message?.annotations || []) {
    if (a?.type !== "USER_MENTION") continue;
    const user = a?.userMention?.user || {};
    if (user.type === "BOT") return true;
    if (botUserId && user.name === botUserId) return true;
  }
  return false;
}

// Google Chat spawns a FRESH thread for every top-level message typed into a DM's input box. Taking
// those at face value would mint a new session per message and reply inside a collapsed thread under
// each one. So: a thread we have never seen before in a DM is "main flow" — flat session, reply at
// top level. A thread we HAVE seen (the user clicked "Reply in thread") is a real side thread.
// In a named space threads are genuine containers and are always honoured.
//
// `seen` is the caller's memory of thread names (a Set-like with has/add). It is per-process and
// intentionally so: after a restart a DM side-thread reads as main flow once, which merges one turn
// into the DM's main session — recoverable and invisible. The alternative, persisting a counter for
// every thread ever seen, buys very little for a table that only grows.
export function resolveThreadKey({ kind, threadName, seen }) {
  if (!threadName) return "";
  if (kind !== "dm") { seen?.add?.(threadName); return threadName; }
  const known = Boolean(seen?.has?.(threadName));
  seen?.add?.(threadName);
  return known ? threadName : "";
}

export function normalizeMessage({ message, space }, { botUserId = "", seen = null, api = null } = {}) {
  const spaceName = String(space?.name || message?.space?.name || "");
  const spaceType = String(space?.spaceType || space?.type || "").toUpperCase();
  const kind = spaceType === "DIRECT_MESSAGE" || spaceType === "DM"
    ? "dm"
    : (space?.displayName ? "channel" : "group");
  const sender = message?.sender || {};
  const threadName = String(message?.thread?.name || "");

  return makeInbound({
    platform: "googlechat",
    conversationId: spaceName,
    conversationName: String(space?.displayName || spaceName),
    kind,
    threadKey: resolveThreadKey({ kind, threadName, seen }),
    messageId: String(message?.name || ""),
    // The email is the identity an operator recognizes and the one that matches a gateway user
    // record; the users/NNN resource name is kept for the Chat API calls that need it.
    userId: String(sender.email || sender.name || ""),
    userName: String(sender.displayName || sender.email || ""),
    userEmail: String(sender.email || ""),
    text: String(message?.argumentText ?? message?.text ?? "").trim(),
    mentionsBot: mentionsBot(message, botUserId),
    attachments: normalizeAttachments(message?.attachment || message?.attachments || [], api),
    raw: { message, space, senderName: String(sender.name || ""), threadName },
  });
}

function normalizeAttachments(list, api) {
  const out = [];
  for (const att of Array.isArray(list) ? list : []) {
    const resourceName = att?.attachmentDataRef?.resourceName || "";
    // No resourceName ⇒ a Drive-picker share, which needs a user-OAuth Drive scope we don't request.
    // Recorded with a null download() so the ingest layer can tell the user what it skipped instead
    // of silently dropping the file they just sent.
    out.push({
      name: String(att?.contentName || att?.name || "attachment").split("/").pop(),
      contentType: String(att?.contentType || "application/octet-stream"),
      source: String(att?.source || ""),
      download: resourceName && api ? () => api.downloadAttachment(resourceName) : null,
    });
  }
  return out;
}

// Bounded memory of thread names, for resolveThreadKey. Bounded because a busy DM mints a new
// thread per message: an unbounded Set here would be a slow leak that only shows up on the
// long-lived daemon, which is the one place it matters.
export function createSeenThreads(limit = 2000) {
  const seen = new Set();
  return {
    has: (name) => seen.has(name),
    add(name) {
      if (!name) return;
      seen.add(name);
      if (seen.size > limit) seen.delete(seen.values().next().value);
    },
    get size() { return seen.size; },
  };
}
