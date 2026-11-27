// Outbound formatter for Google Chat.
//
// Every text write is sent with `markupSyntax: MARKUP_SYNTAX_MARKDOWN` (googlechat/api.js), so a
// reply renders as standard Markdown — bold, italic, strikethrough, code, links, lists, quotes —
// whatever syntax the operator's Chat app defaults to. Tables and headings are still degraded here
// (fixed-width blocks, bold lines) until a live space proves they render in a plain message; tables
// that genuinely need to be tabular go out as Cards v2 or a file, a connector decision.
//
// SECURITY: in Markdown mode `<chat-user data-user="users/{id}">` creates a REAL mention and
// `users/all` pings the whole space; the Chat-syntax form `<users/{id}>` does the same in older
// apps. Model output is untrusted, so every such sequence is defanged — case-insensitively, since
// the Markdown form is an HTML tag — before any sanctioned mention is inserted, exactly the contract
// slack/format.js enforces for `<!channel>`. The other `chat-*` tags (emoji, citations) are
// defanged too: only the gateway decides what the app's message annotates.
import { degradeMarkdown, chunkText } from "./degrade.js";
import { createMentionResolver } from "./mentions.js";

// Chat documents no escape for a literal `<`, so the sequence is broken with a zero-width space:
// visually identical for a reader, unparseable as a tag or annotation in either syntax. Inline code
// spans are left verbatim (a code span is literal text in both syntaxes).
const ZWSP = "​";
const DANGEROUS = /<(?=\s*\/?\s*(?:users\/|chat-[a-z]))/gi;

export function defangChatControlSeqs(text) {
  if (!text) return text || "";
  return text
    .split(/(`[^`]*`)/)
    .map((s) => (s.startsWith("`") && s.endsWith("`") ? s : s.replace(DANGEROUS, `<${ZWSP}`)))
    .join("");
}

// The sanctioned mention markup, for an id the gateway itself resolved (never model text).
export function chatUserMention(user) {
  const id = String(user || '').replace(/^users\//, '');
  if (/^[A-Za-z0-9_-]+$/.test(id)) return `<chat-user data-user="users/${id}">`;
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(id)) return `<chat-user data-email="${id}">`;
  return '';
}

export function createChatMentionResolver(normalizeName) {
  return createMentionResolver({
    normalizeName,
    // Markdown mode's id-based mention. The user id is the bare numeric id.
    render: (id) => chatUserMention(id),
    defang: defangChatControlSeqs,
    // `all` is Chat's space-wide broadcast; the Slack words are kept reserved too so a directory
    // that happens to contain a user literally named "Channel" can never become a broadcast.
    broadcastNames: ["all", "here", "channel", "everyone", "group"],
  });
}

// Google Chat's per-message text cap.
export const MAX_CHAT_MESSAGE_CHARS = 4_096;

export function formatChatOutbound(markdown, { capabilities = {}, directory = null, normalizeName = null, requester = null } = {}) {
  const degraded = degradeMarkdown(markdown, capabilities, {
    bold: (t) => `**${t}**`,
    link: (label, url) => `[${label}](${url})`,
  });
  const defanged = defangChatControlSeqs(degraded);
  const resolved = normalizeName && directory?.map?.size
    ? createChatMentionResolver(normalizeName).resolve(defanged, directory)
    : defanged;
  let text = resolved.trim();
  // The requester comes from authenticated intake. Add the mention after defanging model text.
  const mention = chatUserMention(requester?.id);
  if (mention) text += `${text ? '\n\n' : ''}${mention}`;
  // Chat mentions are inline in the text, so every chunk is self-contained and carries no entities.
  return { text, chunks: chunkText(text, capabilities.maxMessageChars || MAX_CHAT_MESSAGE_CHARS).map((c) => ({ text: c, mentions: [] })) };
}
