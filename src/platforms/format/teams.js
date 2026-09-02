// Outbound formatter for Microsoft Teams.
//
// Teams bot messages support a NARROW Markdown subset: bold, italic, strikethrough, links, inline
// code and code blocks. No tables, no headings, no inline images, and lists render on desktop only
// — so all four are degraded here. Anything that must be visually rich goes out as an Adaptive
// Card, which is a connector decision.
//
// Mentions are structural, not textual: the text carries `<at>Display Name</at>` and the message
// payload must carry a matching `entities` array, or the tag renders as literal text and pings
// nobody. `formatTeamsOutbound` therefore returns the entities alongside the text — a connector
// that drops them produces a visibly broken mention, which is why they travel together.
//
// SECURITY: model output is untrusted and Teams parses `<at>` in message text. Model-authored tags
// are entity-escaped before any sanctioned mention is inserted (Teams does decode `&lt;`), so the
// only live mentions are the ones this formatter created.
import { degradeMarkdown, chunkText } from "./degrade.js";
import { createMentionResolver } from "./mentions.js";

const DANGEROUS = /<(?=\/?at\b)/gi;

export function defangTeamsControlSeqs(text) {
  if (!text) return text || "";
  return text
    .split(/(`[^`]*`)/)
    .map((s) => (s.startsWith("`") && s.endsWith("`") ? s : s.replace(DANGEROUS, "&lt;")))
    .join("");
}

// Teams' documented per-message cap is ~28 KB of payload; the practical text budget is well under
// it once entities and card attachments are counted. 8k keeps a chunked answer comfortably legal.
export const MAX_TEAMS_MESSAGE_CHARS = 8_000;

export function createTeamsMentionResolver(normalizeName, collect) {
  return createMentionResolver({
    normalizeName,
    render: (id, displayName) => {
      collect(id, displayName);
      return `<at>${displayName}</at>`;
    },
    defang: defangTeamsControlSeqs,
    broadcastNames: ["channel", "team", "everyone", "here", "all"],
  });
}

export function formatTeamsOutbound(markdown, { capabilities = {}, directory = null, normalizeName = null } = {}) {
  const degraded = degradeMarkdown(markdown, capabilities, {
    bold: (t) => `**${t}**`,
    link: (label, url) => `[${label}](${url})`,
  });
  const defanged = defangTeamsControlSeqs(degraded);

  // One entity per DISTINCT mentioned user. Teams matches an entity to a `<at>` tag by its text, so
  // repeating the same person needs only one entity, but two different people must never collapse.
  const seen = new Map();
  const collect = (id, displayName) => {
    if (!seen.has(displayName)) seen.set(displayName, { type: "mention", text: `<at>${displayName}</at>`, mentioned: { id, name: displayName } });
  };
  const resolved = normalizeName && directory?.map?.size
    ? createTeamsMentionResolver(normalizeName, collect).resolve(defanged, directory)
    : defanged;

  const text = resolved.trim();
  // Entities are per-MESSAGE, so each chunk carries only the mentions its own text still contains.
  // A chunk shipped with an entity whose tag was split into the previous message is at best inert
  // and at worst rejected, so the filter is not cosmetic.
  const all = [...seen.values()];
  const chunks = chunkText(text, capabilities.maxMessageChars || MAX_TEAMS_MESSAGE_CHARS)
    .map((c) => ({ text: c, mentions: all.filter((m) => c.includes(m.text)) }));
  return { text, chunks };
}
