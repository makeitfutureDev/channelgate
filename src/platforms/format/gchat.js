// Outbound formatter for Google Chat.
//
// Google Chat's standard-Markdown mode (`markup_syntax: MARKDOWN`, GA 2026-08-07) renders real
// Markdown — bold, italic, strikethrough, code, links, lists — but NOT tables and NOT headings in a
// plain message. Both are degraded here rather than taught to the model: tables become fixed-width
// blocks, headings become bold lines. Tables that genuinely need to be tabular go out as Cards v2
// or a snippet artifact, which is a connector decision, not a formatter one.
//
// SECURITY: `<users/{id}>` in outgoing text creates a REAL mention, and `<users/all>` pings the
// whole space. Model output is untrusted, so those sequences are defanged before any sanctioned
// mention is inserted — exactly the contract slack/format.js enforces for `<!channel>`.
import { degradeMarkdown, chunkText } from "./degrade.js";
import { createMentionResolver } from "./mentions.js";

// Google Chat's own text does not document an escape for `<users/…>`, and HTML entities are not
// reliably decoded in plain message text. Breaking the sequence with a zero-width space is the
// safest defang available: visually identical for a reader, unparseable as an annotation.
// TODO(connector): re-verify against a live space when the Chat transport lands — if `&lt;` turns
// out to render correctly in MARKDOWN mode, prefer it (it survives copy/paste cleanly).
const ZWSP = "​";
const DANGEROUS = /<(?=users\/|\/?chat-user\b)/g;

export function defangChatControlSeqs(text) {
  if (!text) return text || "";
  return text
    .split(/(`[^`]*`)/)
    .map((s) => (s.startsWith("`") && s.endsWith("`") ? s : s.replace(DANGEROUS, `<${ZWSP}`)))
    .join("");
}

export function createChatMentionResolver(normalizeName) {
  return createMentionResolver({
    normalizeName,
    // Chat's id-based mention. The user id is the bare numeric id; the resource form is what the
    // API expects inline in message text.
    render: (id) => `<users/${id}>`,
    defang: defangChatControlSeqs,
    // `all` is Chat's space-wide broadcast; the Slack words are kept reserved too so a directory
    // that happens to contain a user literally named "Channel" can never become a broadcast.
    broadcastNames: ["all", "here", "channel", "everyone", "group"],
  });
}

// Google Chat's per-message text cap.
export const MAX_CHAT_MESSAGE_CHARS = 4_096;

export function formatChatOutbound(markdown, { capabilities = {}, directory = null, normalizeName = null } = {}) {
  const degraded = degradeMarkdown(markdown, capabilities, {
    bold: (t) => `**${t}**`,
    link: (label, url) => `[${label}](${url})`,
  });
  const defanged = defangChatControlSeqs(degraded);
  const resolved = normalizeName && directory?.map?.size
    ? createChatMentionResolver(normalizeName).resolve(defanged, directory)
    : defanged;
  const text = resolved.trim();
  // Chat mentions are inline in the text, so every chunk is self-contained and carries no entities.
  return { text, chunks: chunkText(text, capabilities.maxMessageChars || MAX_CHAT_MESSAGE_CHARS).map((c) => ({ text: c, mentions: [] })) };
}
