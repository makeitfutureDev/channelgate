// Slack supports neither HTML nor full Markdown — only its own "mrkdwn" (a limited subset) for
// text, plus Block Kit for layout. Agents emit GitHub-flavored Markdown, so this converts it to
// mrkdwn before posting and fixes the things Slack renders wrong:
//   **bold** / __bold__  → *bold*        (Slack bold is a single asterisk)
//   *italic*             → _italic_      (a single asterisk is BOLD to Slack)
//   ***bolditalic***     → *_bolditalic_*
//   # / ## / ### heading → *heading*     (Slack has no headings — they show literally)
//   [text](http…)        → <http…|text>  (Slack link syntax)
//   - / * / + bullets    → • bullets
//   ~~strike~~           → ~strike~
//   --- / *** rules      → a divider line
//   | pipe | tables |    → an aligned monospace code block (Slack never renders tables)
// Content inside fenced ``` and inline `code` is left untouched (byte-exact).
//
// SECURITY: model output is untrusted. Slack parses `&`, `<`, `>` as control characters in
// message text — a raw `<@U…>` pings a user and `<!channel>` broadcasts for real, and a plain
// "a < b" corrupts rendering. Every NON-code segment is entity-escaped here, so those sequences
// render as literal text; the only live `<…|…>`/`<…>` links in the output are the ones this
// converter generates itself (from markdown links, escaped inside).

import { normalizeName } from "./directory.js";
import { createMentionResolver } from "../platforms/format/mentions.js";

const MAX_CELL = 80; // cap very long table cells so a code-block grid stays readable

// Slack's three control characters. Escaped in all prose; generated link syntax is added after.
function escapeSlack(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Markdown link: label + URL. The URL charset allows one level of balanced parens
// (…/wiki/Foo_(bar)) so such links no longer truncate at the inner ")".
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;

// Emphasis conversion, shared by plain prose and link labels. Order matters: triple markers
// first, then double (parked behind a \u0001 placeholder so the single-* pass can't re-match
// the converted bold), then single *italic* → _italic_.
function emphasize(s) {
  return s
    .replace(/\*\*\*([^\n*]+)\*\*\*/g, "\u0001_$1_\u0001") // ***bolditalic*** → bold+italic
    .replace(/___([^\n_]+)___/g, "\u0001_$1_\u0001")
    .replace(/\*\*([^\n*]+)\*\*/g, "\u0001$1\u0001") // **bold** → placeholder (restored below)
    .replace(/__([^\n_]+)__/g, "\u0001$1\u0001") // __bold__ → placeholder
    .replace(/(^|[^*\w])\*([^\s*][^\n*]*?)\*(?=[^*\w]|$)/g, "$1_$2_") // *italic* → _italic_
    .replace(/\u0001/g, "*") // restore bold markers
    .replace(/~~([^\n~]+)~~/g, "~$1~"); // ~~strike~~ → ~strike~
}

function transformInlineSegment(s) {
  const stash = [];
  const keep = (text) => {
    stash.push(text);
    return `\u0000${stash.length - 1}\u0000`;
  };
  // Strip stray placeholder chars so untrusted text can't forge a stash slot.
  let t = String(s).replace(/[\u0000\u0001]/g, "");
  // Generate link syntax FIRST (parked so the escape below can't touch the wrapper), escaping
  // the URL and label themselves — Slack wants entities escaped inside <…> too.
  t = t.replace(MD_LINK_RE, (_m, label, url) => keep(`<${escapeSlack(url)}|${emphasize(escapeSlack(label))}>`));
  t = t.replace(/<(https?:\/\/[^<>\s|]+)>/g, (_m, url) => keep(`<${escapeSlack(url)}>`)); // md autolink
  t = emphasize(escapeSlack(t));
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

// Apply inline transforms but preserve `inline code` spans verbatim.
function transformInline(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((p) => (p.startsWith("`") && p.endsWith("`") ? p : transformInlineSegment(p)))
    .join("");
}

// Strip markdown to plain text — for table cells, which render inside a literal code block.
function stripInline(s) {
  return s
    .replace(MD_LINK_RE, "$1")
    .replace(/\*\*\*([^\n*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^\n*]+)\*\*/g, "$1")
    .replace(/__([^\n_]+)__/g, "$1")
    .replace(/~~([^\n~]+)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\\|/g, "|")
    .trim();
}

const looksLikeRow = (line) => line.includes("|");
const isSeparatorRow = (line) => /\|/.test(line) && /-/.test(line) && /^[\s:|-]+$/.test(line.replace(/`[^`]*`/g, ""));

function parseRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => stripInline(c.trim()));
}

function renderTable(rows) {
  const header = parseRow(rows[0]);
  const data = rows.slice(2).map(parseRow); // rows[1] is the separator
  const grid = [header, ...data];
  const cols = Math.max(...grid.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...grid.map((r) => Math.min((r[c] || "").length, MAX_CELL)));
  }
  const fmt = (r) =>
    r
      .map((cell, c) => (cell || "").slice(0, MAX_CELL).padEnd(widths[c]))
      .join("  ")
      .replace(/\s+$/, "");
  return ["```", fmt(header), ...data.map(fmt), "```"].join("\n");
}

export function mdToMrkdwn(text) {
  if (!text) return "";
  const src = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inFence = false;

  while (i < src.length) {
    const line = src[i];

    if (/^\s*```/.test(line)) {
      out.push(line);
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    // Table: a row immediately followed by a separator row.
    if (looksLikeRow(line) && i + 1 < src.length && isSeparatorRow(src[i + 1])) {
      const block = [line, src[i + 1]];
      let j = i + 2;
      while (j < src.length && looksLikeRow(src[j]) && src[j].trim() && !/^\s*```/.test(src[j])) block.push(src[j++]);
      out.push(renderTable(block));
      i = j;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`*${transformInline(heading[2].trim())}*`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────────");
      i++;
      continue;
    }

    // Blockquote: keep the leading ">" live (it's Slack's own quote marker) and transform the rest
    // — the escape pass would otherwise turn it into a literal "&gt;".
    const quote = /^(\s*)>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${quote[1]}> ${transformInline(quote[2])}`);
      i++;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${transformInline(bullet[2])}`);
      i++;
      continue;
    }

    out.push(transformInline(line));
    i++;
  }

  return out.join("\n");
}

// Split mrkdwn into ≤max-char chunks on line boundaries, keeping fenced code blocks valid across
// the split (close on one side, reopen on the next). Slack section blocks cap at 3000 chars;
// plain-message callers pass their own budget. Exported: the posting path chunks long replies
// into multiple threaded messages instead of hard-truncating.
export function chunkMrkdwn(text, max = 2900) {
  const chunks = [];
  let cur = "";
  let fenceOpen = false;
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  for (const raw of text.split("\n")) {
    // Hard-split a single line that's longer than the budget.
    const pieces = raw.length > max ? raw.match(new RegExp(`.{1,${max}}`, "g")) : [raw];
    for (const line of pieces) {
      const add = (cur ? "\n" : "") + line;
      if (cur && cur.length + add.length > max) {
        if (fenceOpen) cur += "\n```";
        flush();
        cur = fenceOpen ? "```\n" + line : line;
      } else {
        cur += add;
      }
    }
    if (/^\s*```/.test(raw)) fenceOpen = !fenceOpen;
  }
  flush();
  return chunks.length ? chunks : [""];
}

// ── Mention resolution ────────────────────────────────────────────────────────────────────────
// Turn plain "@Display Name" text the agent writes into a real Slack mention "<@UID>" using the
// cached workspace directory (name → id, from directory.js). The agent just writes the name it
// already knows — no id lookup at generation time — and this rewrites it so the tag actually pings.
//
// The matcher itself is platform-neutral and lives in platforms/format/mentions.js, shared with the
// Google Chat and Teams formatters; only the rendered markup, the defanger, and Slack's broadcast
// words are supplied here. Behaviour is unchanged: exact directory match only (longest name wins),
// emails / mid-word "@" / `inline code` untouched, existing <@UID> tokens passed through.

const slackMentions = createMentionResolver({
  normalizeName,
  render: (id) => `<@${id}>`,
  defang: (text) => defangControlSeqs(text),
  broadcastNames: ["here", "channel", "everyone", "group"], // Slack broadcasts, not people
});

// Rewrite "@Name" → "<@id>" throughout `text`, skipping `inline code` spans. `dir` is a directory.js
// snapshot ({ map, maxWords }); with an empty/missing map the text is returned unchanged.
export function resolveMentions(text, dir) {
  return slackMentions.resolve(text, dir);
}

// Streaming variant: native-stream mode appends the answer in arbitrary delta slices, so a single
// "@Name" can straddle a chunk boundary. push() emits everything safe to send now (completed
// mentions resolved) and keeps only a short trailing run that might still be growing into an
// "@name"; flush() releases the remainder at the end of the stream.
export function createMentionStream(dir) {
  return slackMentions.stream(dir);
}

// Native-streaming counterpart of escapeSlack: markdown_text deltas bypass mdToMrkdwn, so
// model-authored Slack control sequences (<!channel>, <@U…>, <#C…>) would render LIVE — a
// prompt-injected broadcast in the highest-traffic path. Defang just the opening "<" of those
// shapes in non-code text; the stream's own sanctioned mentions are inserted AFTERWARDS by
// resolveMentions, so they stay live. Code spans are left byte-exact.
export function defangControlSeqs(text) {
  if (!text) return text || "";
  return text
    .split(/(`[^`]*`)/)
    .map((s) => (s.startsWith("`") && s.endsWith("`") ? s : s.replace(/<(?=[!@#])/g, "&lt;")))
    .join("");
}


// Build the message payload's blocks: the converted body as one or more section blocks, plus the
// run stats as a small grey context block. Caller passes the already-converted-or-raw content.
export function buildReplyBlocks(content, footer) {
  const md = mdToMrkdwn(content);
  const blocks = chunkMrkdwn(md)
    .filter((c) => c.trim())
    .map((c) => ({ type: "section", text: { type: "mrkdwn", text: c.slice(0, 3000) } }));
  if (!blocks.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "_(no output)_" } });
  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.slice(0, 3000) }] });
  return blocks;
}
