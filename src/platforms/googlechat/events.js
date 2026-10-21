// Turning a Pub/Sub payload into something the gateway can act on.
//
// Google publishes Chat interaction events as CloudEvents: the EVENT TYPE lives in the Pub/Sub
// message attributes (`ce-type`), not in the JSON body, and the body's shape depends on that type.
// Three envelope layouts exist in the wild depending on how the app was configured, and an
// installation that hits the one we didn't handle just looks silently deaf — so all three are
// accepted, and anything unrecognized is ACKed and dropped rather than redelivered forever.
import { makeInbound } from "../inbound.js";
import { isSpaceName, isMessageName, isThreadName } from "./api.js";

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
  // The HTTP endpoint carries no CloudEvent attributes: the add-on payload key, or the legacy
  // `type`, is the only thing that says what happened. Membership there names the space but not
  // the app's own member record, so the bot id is learned from a later mention instead.
  const legacyType = String(envelope?.type || "").toUpperCase();
  if (chat.addedToSpacePayload || legacyType === "ADDED_TO_SPACE") {
    const payload = chat.addedToSpacePayload || envelope;
    return { type: "membership.added", space: payload.space || chat.space || {}, membership: payload.membership || {} };
  }
  if (chat.removedFromSpacePayload || legacyType === "REMOVED_FROM_SPACE") {
    const payload = chat.removedFromSpacePayload || envelope;
    return { type: "membership.removed", space: payload.space || chat.space || {}, membership: payload.membership || {} };
  }
  // Add-on, native Pub/Sub and legacy HTTP events all carry the ACTOR separately from the
  // bot-authored source message. Never use the message sender or action parameters as identity.
  if (chat.buttonClickedPayload || chat.action || envelope?.type === "CARD_CLICKED"
    || ceType.includes("widget") || ceType.includes("card") || ceType.includes("button")) {
    const payload = chat.buttonClickedPayload || chat;
    return { type: "card", space: payload.space || chat.space || envelope?.space || {},
      message: payload.message || chat.message || envelope?.message || {},
      user: chat.user || envelope?.user || {},
      action: payload.action || chat.action || envelope?.action || {},
      commonEventObject: envelope?.commonEventObject || envelope?.common || chat.commonEventObject || {},
      eventTime: chat.eventTime || envelope?.eventTime || "" };
  }

  const extracted = extractMessage(envelope, chat);
  if (!extracted) return { type: "unknown", ceType };
  return { type: "message", ...extracted };
}

export function normalizeCardEvent(event) {
  const { message = {}, space = {}, user = {}, action = {}, commonEventObject = {} } = event;
  const spaceName = String(space.name || message.space?.name || "");
  const messageId = String(message.name || "");
  if (!isSpaceName(spaceName) || !isMessageName(messageId) || !messageId.startsWith(`${spaceName}/messages/`)
    || user.type === "BOT" || !(user.email || user.name)) return null;
  const thread = String(message.thread?.name || "");
  if (thread && (!isThreadName(thread) || !thread.startsWith(`${spaceName}/threads/`))) return null;
  const submitted = Array.isArray(action.parameters)
    ? Object.fromEntries(action.parameters.filter(p => typeof p?.key === 'string').map(p => [p.key, String(p.value ?? '')]))
    : { ...(action.parameters || {}) };
  const parameters = Object.assign(Object.create(null), submitted, commonEventObject.parameters || {});
  return { platform: "googlechat", conversationId: `gchat:${spaceName}`, rawConversationId: spaceName,
    conversationName: String(space.displayName || spaceName),
    kind: /^(DIRECT_MESSAGE|DM)$/i.test(space.spaceType || space.type || '') ? 'dm' : space.displayName ? 'channel' : 'group',
    messageId, threadKey: thread, userId: String(user.email || user.name), userResourceName: String(user.name || ''),
    userName: String(user.displayName || user.email || user.name), userEmail: String(user.email || ''),
    // Add-on clicks name the endpoint URL as the function; the action's own name rides `cgAction`.
    action: { function: String(parameters.cgAction || action.function || action.actionMethodName || commonEventObject.invokedFunction || ''), parameters },
    commonEventObject, formInputs: commonEventObject.formInputs || {},
    raw: { message, space, user, senderName: String(user.name || ''), threadName: thread },
  };
}

// Format 1 — Workspace Add-ons wrapper: { chat: { messagePayload: { message, space } } }
// Format 2 — native Chat API Pub/Sub:   { chat: { message, space } }  (no payload wrapper)
// Format 3 — legacy/HTTP-shaped event:  { message, space, type: "MESSAGE" }
function extractMessage(envelope, chat) {
  const command = chat.appCommandPayload;
  if (command?.message) {
    // Quick commands need an operator-specific ID map; message actions contain someone else's
    // original text. Neither is a new literal slash-command request that we can safely dispatch.
    const type = command.appCommandMetadata?.appCommandType;
    if (type && type !== 'SLASH_COMMAND') return null;
    return {
      message: { ...command.message, ...(chat.user ? { sender: chat.user } : {}) },
      space: command.space || chat.space || command.message.space || {},
      appCommand: true,
    };
  }
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

export const GOOGLE_CHAT_CONTROL_COMMAND = /^\/(help|status|clear|stop|cancel|model|effort|settings|files|secrets|sendfile)(?:\s|$)/i;

// A registered slash command arrives with `argumentText` holding ONLY the arguments (Google's own
// example: text "/debug show code", argumentText " show code"). The command itself is the
// SLASH_COMMAND annotation's commandName, or failing that the literal message text. Command IDs
// are operator-chosen, so a number is never mapped to a name. A typed "@app /help" carries no
// slash-command metadata and keeps the mention-stripped argumentText.
export function messageCommandText(message, { appCommand = false } = {}) {
  const argument = String(message?.argumentText ?? message?.text ?? '').trim();
  const annotation = (message?.annotations || []).find(a => a?.type === 'SLASH_COMMAND')?.slashCommand;
  if (!appCommand && message?.slashCommand?.commandId == null && !annotation) return argument;
  const name = String(annotation?.commandName || '').trim();
  if (/^\/[A-Za-z0-9_-]+$/.test(name)) {
    const prefixed = argument.toLowerCase() === name.toLowerCase() || argument.toLowerCase().startsWith(`${name.toLowerCase()} `);
    return prefixed ? argument : `${name} ${argument}`.trim();
  }
  const literal = String(message?.text ?? '').trim();
  return literal.startsWith('/') ? literal : argument;
}

export function normalizeMessage({ message, space, appCommand = false }, { botUserId = "", seen = null, api = null } = {}) {
  const spaceName = String(space?.name || message?.space?.name || "");
  const spaceType = String(space?.spaceType || space?.type || "").toUpperCase();
  const kind = spaceType === "DIRECT_MESSAGE" || spaceType === "DM"
    ? "dm"
    : (space?.displayName ? "channel" : "group");
  const sender = message?.sender || {};
  const threadName = String(message?.thread?.name || "");
  const quoted = String(message?.quotedMessageMetadata?.name || '');
  const text = messageCommandText(message, { appCommand });
  // Command IDs are chosen by the app operator, so we never infer a command name from a number.
  // Only a registered invocation carrying a supported literal command bypasses the mention gate.
  const registeredCommand = (appCommand || message?.slashCommand?.commandId != null
    || (message?.annotations || []).some(a => a?.type === 'SLASH_COMMAND'))
    && GOOGLE_CHAT_CONTROL_COMMAND.test(text);

  return makeInbound({
    platform: "googlechat",
    conversationId: spaceName,
    conversationName: String(space?.displayName || spaceName),
    kind,
    threadKey: resolveThreadKey({ kind, threadName, seen }),
    messageId: String(message?.name || ""),
    replyToId: isMessageName(quoted) && quoted.startsWith(`${spaceName}/messages/`) ? quoted : '',
    // The email is the identity an operator recognizes and the one that matches a gateway user
    // record; the users/NNN resource name is kept for the Chat API calls that need it.
    userId: String(sender.email || sender.name || ""),
    userName: String(sender.displayName || sender.email || ""),
    userEmail: String(sender.email || ""),
    text,
    mentionsBot: registeredCommand || mentionsBot(message, botUserId),
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
