// Conversation-id namespacing across platforms.
//
// The channels / sessions / usage / active_runs tables are keyed by an opaque `channel_id`. With
// one surface that was unambiguous. With three it is not: a Google Chat space name and a Teams
// conversation id are both arbitrary strings, and a collision would cross-wire two organizations'
// conversations into one gated folder — a confinement break, not a cosmetic bug.
//
// Slack ids stay BARE. Every row written before this seam is a Slack row, and rewriting them would
// be a migration with no upside; "no prefix" is therefore a valid, reserved namespace meaning Slack.
import { DEFAULT_PLATFORM, platformOr, isPlatformId, PLATFORM_IDS } from "./registry.js";

const PREFIXES = PLATFORM_IDS.map((id) => ({ id, prefix: platformOr(id).idPrefix })).filter((p) => p.prefix);

// "C123" (slack) · "gchat:spaces/AAA" · "teams:19:…@thread.tacv2"
export function qualifyConversationId(platform, rawId) {
  const id = String(rawId ?? "").trim();
  if (!id) return "";
  const prefix = platformOr(platform).idPrefix;
  if (!prefix) return id;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

// Split a stored id back into { platform, id }. An unprefixed id is Slack's.
export function parseConversationId(qualified) {
  const value = String(qualified ?? "").trim();
  for (const { id, prefix } of PREFIXES) {
    if (value.startsWith(prefix)) return { platform: id, id: value.slice(prefix.length) };
  }
  return { platform: DEFAULT_PLATFORM, id: value };
}

export function platformOfConversation(qualified) {
  return parseConversationId(qualified).platform;
}

// Guard for anything that accepts a platform id off the wire (admin API, MCP tool argument).
export function normalizePlatformId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return isPlatformId(id) ? id : "";
}
