// The one shape every transport hands the gateway.
//
// Slack's pipeline eats a raw Slack event today; Google Chat and Teams events look nothing like it
// and nothing like each other. Rather than teach the pipeline three dialects, each transport
// normalizes into this record and the gateway reads only these fields. It is deliberately the
// SMALLEST set that answers the gating questions the daemon actually asks: who spoke, where, in
// which thread, were we addressed, and what came attached.
//
// `conversationId` is the QUALIFIED id (`gchat:spaces/AAA`, `teams:19:…`) — the value stored in the
// channels/sessions tables. `rawConversationId` is the same id in the platform's own wire format,
// which is what an API call must use. Mixing those two up is the bug this pair of fields exists to
// prevent.
import { qualifyConversationId } from "./ids.js";
import { requirePlatform } from "./registry.js";

// "dm" = 1:1 with the bot · "group" = unnamed multi-person chat · "channel" = a named space/channel.
// The gate that matters downstream is dm-vs-not: a DM needs no mention, everything else does.
const KINDS = new Set(["dm", "group", "channel"]);

export function makeInbound({
  platform,
  conversationId,
  conversationName = "",
  kind = "channel",
  threadKey = "",
  messageId = "",
  userId = "",
  userName = "",
  userEmail = "",
  text = "",
  mentionsBot = false,
  attachments = [],
  raw = null,
} = {}) {
  requirePlatform(platform); // unknown platform is a programming error, not a degraded message
  const rawConversationId = String(conversationId || "").trim();
  if (!rawConversationId) throw new TypeError(`${platform} inbound message has no conversation id`);
  if (!KINDS.has(kind)) throw new TypeError(`${platform} inbound message has unknown kind "${kind}"`);
  return {
    platform,
    conversationId: qualifyConversationId(platform, rawConversationId),
    rawConversationId,
    conversationName: String(conversationName || ""),
    kind,
    isDM: kind === "dm",
    // A platform-native thread handle (Chat thread name, Teams reply-chain id) or "" for a flat
    // conversation. The gateway's session key is derived from it, never parsed out of it.
    threadKey: String(threadKey || ""),
    messageId: String(messageId || ""),
    userId: String(userId || ""),
    userName: String(userName || ""),
    userEmail: String(userEmail || ""),
    text: String(text || ""),
    // Whether the bot was explicitly addressed. Outside a DM this is the gate: no mention, no run.
    mentionsBot: Boolean(mentionsBot),
    // [{ name, contentType, size, download() -> Promise<Buffer> }] — lazy, because most inbound
    // messages carry none and a download is a network call we should not make until the message has
    // passed authorization.
    attachments: Array.isArray(attachments) ? attachments : [],
    raw,
  };
}
