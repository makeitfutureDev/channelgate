// Pure inbound-message normalization and command recognition. Keeping these rules independent of
// Bolt and run lifecycle makes the gateway's first security boundary directly testable.
export const SLACK_MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
const STOP_WORDS = new Set(["stop", "cancel", "abort", "halt", "stop it", "please stop", "stop please", "nevermind", "never mind"]);
const PENDING_WORDS = new Set(["pending", "my followups", "my follow-ups", "followups", "follow-ups"]);
const SLASH_COMMANDS = new Set(["help", "clear", "context", "model", "effort", "engine", "compact", "update", "mode", "pending", "followups", "resume", "delete", "files"]);

function normalizedControlText(text, punctuation = /[!.…]+$/) {
  return (text || "").trim().toLowerCase().replace(punctuation, "").replace(/\s+/g, " ");
}

export function isStopCommand(text) {
  return STOP_WORDS.has(normalizedControlText(text));
}

export function isPendingCommand(text) {
  return PENDING_WORDS.has(normalizedControlText(text, /[!.…?]+$/));
}

export function parseSlashCommand(text) {
  const value = (text || "").trim();
  if (!value.startsWith("/")) return null;
  const parts = value.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (!SLASH_COMMANDS.has(cmd)) return null;
  return { cmd, arg: parts.slice(1).join(" ").trim() };
}

export function mentionsBot(text, botUserId) {
  if (!text) return false;
  for (const match of text.matchAll(SLACK_MENTION_RE)) if (match[1] === botUserId) return true;
  return false;
}

export function stripMentions(text, botUserId) {
  return (text ?? "").replace(SLACK_MENTION_RE, (full, id) => (id === botUserId ? "" : full)).trim();
}

export function isIgnorable(event, botUserId, trustedApps = []) {
  if (event.user && event.user === botUserId) return true;
  const trusted =
    (event.bot_id && trustedApps.includes(event.bot_id)) ||
    (event.app_id && trustedApps.includes(event.app_id));
  if (event.bot_id && !trusted) return true;
  return ![undefined, "file_share", "thread_broadcast", "bot_message"].includes(event.subtype);
}
