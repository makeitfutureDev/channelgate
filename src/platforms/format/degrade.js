// Capability-driven Markdown degradation — the pure core of "reply modes depend on the platform".
//
// The model writes one thing: standard Markdown. What survives differs per surface. Slack renders
// small pipe tables and headings; Google Chat's standard-Markdown mode renders neither in a plain
// message; Teams' bot subset renders neither plus no inline images, and lists only on desktop.
// Rather than teach the model three dialects (it would get it wrong, and an admin-overridden guide
// would drift), we degrade on the way OUT, driven by the capability descriptor.
//
// Every transform here is lossless in MEANING: a table becomes a fixed-width block that still shows
// every cell, a heading becomes an emphasized line, an image becomes a labelled link. Nothing is
// dropped silently — that would make a platform look like the model failed to answer.

const FENCE_RE = /^\s*(?:```|~~~)/;

// Split into fenced-code and prose segments so no transform ever rewrites code the user asked for.
export function splitFences(markdown) {
  const segments = [];
  let buffer = [];
  let fence = "";
  const flush = (code) => {
    if (buffer.length) segments.push({ code, text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of String(markdown ?? "").split("\n")) {
    if (!fence && FENCE_RE.test(line)) {
      flush(false);
      fence = line.trim().slice(0, 3);
      buffer.push(line);
      continue;
    }
    if (fence) {
      buffer.push(line);
      if (line.trim().startsWith(fence)) {
        flush(true);
        fence = "";
      }
      continue;
    }
    buffer.push(line);
  }
  // An unterminated fence stays code: re-flowing a half-written block would mangle it.
  flush(Boolean(fence));
  return segments;
}

// Apply `fn` to prose only, leaving fenced code byte-identical.
export function mapProse(markdown, fn) {
  return splitFences(markdown).map((s) => (s.code ? s.text : fn(s.text))).join("\n");
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

const SEPARATOR_CELL = /^:?-{1,}:?$/;
function isSeparator(line) {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c));
}
function isTableRow(line) {
  return line.includes("|") && /\|/.test(line.trim()) && line.trim().startsWith("|");
}

// Render parsed rows as a fixed-width block. Monospace is the one layout primitive every chat
// platform honours, so a table stays a table instead of collapsing into run-on text.
export function renderFixedWidthTable(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const widths = Array.from({ length: width }, (_, i) => Math.max(...padded.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(padded[0]), widths.map((w) => "-".repeat(w)).join("  ").trimEnd(), ...padded.slice(1).map(line)];
  return ["```", ...out, "```"].join("\n");
}

// GFM pipe tables → fixed-width code blocks. Only a header + separator + body is treated as a
// table; a lone line containing "|" is left alone.
export function tablesToFixedWidth(markdown) {
  return mapProse(markdown, (prose) => {
    const lines = prose.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
        const rows = [splitRow(lines[i])];
        let j = i + 2;
        for (; j < lines.length && isTableRow(lines[j]); j += 1) rows.push(splitRow(lines[j]));
        out.push(renderFixedWidthTable(rows));
        i = j - 1;
        continue;
      }
      out.push(lines[i]);
    }
    return out.join("\n");
  });
}

// ATX headings → an emphasized line in the target dialect. `bold` is supplied per platform because
// Slack's dialect uses single asterisks and standard Markdown uses double.
export function headingsToEmphasis(markdown, bold = (t) => `**${t}**`) {
  return mapProse(markdown, (prose) =>
    prose
      .split("\n")
      .map((line) => {
        const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        return m && m[2] ? bold(m[2]) : line;
      })
      .join("\n"));
}

// `![alt](url)` → a labelled link. On a surface with no inline images the alt text alone would
// leave the reader with no way to reach the asset.
export function imagesToLinks(markdown, link = (label, url) => `[${label}](${url})`) {
  return mapProse(markdown, (prose) =>
    prose.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => link(alt.trim() || url, url)));
}

// Markdown lists → literal bullet/number lines. Used where list rendering is client-dependent
// (Teams renders lists on desktop only), so the structure survives on every client.
export function listsToPlainLines(markdown) {
  return mapProse(markdown, (prose) =>
    prose
      .split("\n")
      .map((line) => {
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) return `${bullet[1]}• ${bullet[2]}`;
        const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
        if (numbered) return `${numbered[1]}${numbered[2]}. ${numbered[3]}`;
        return line;
      })
      .join("\n"));
}

export function blockQuotesToPlain(markdown) {
  return mapProse(markdown, (prose) =>
    prose.split("\n").map((line) => line.replace(/^(\s*)>\s?/, "$1")).join("\n"));
}

// The one entry point: degrade `markdown` to what `capabilities` can actually render.
export function degradeMarkdown(markdown, capabilities = {}, { bold, link } = {}) {
  let text = String(markdown ?? "");
  if (!capabilities.markdownTables) text = tablesToFixedWidth(text);
  if (!capabilities.markdownHeadings) text = headingsToEmphasis(text, bold);
  if (!capabilities.markdownImages) text = imagesToLinks(text, link);
  if (!capabilities.markdownLists) text = listsToPlainLines(text);
  if (!capabilities.blockQuotes) text = blockQuotesToPlain(text);
  return text;
}

// Split a finished message at the platform's hard character cap. Never splits inside a fence: a
// half-open ``` renders the rest of the answer as code on every client. Mirrors the intent of
// slack/format.js `chunkMrkdwn`, generalized over the cap.
export function chunkText(text, max = 4_000) {
  const limit = Math.max(200, Number(max) || 4_000);
  const body = String(text ?? "");
  if (body.length <= limit) return body ? [body] : [];
  const chunks = [];
  let current = [];
  let size = 0;
  let openFence = "";
  const flush = () => {
    if (!current.length) return;
    const closing = openFence ? `\n${openFence}` : "";
    chunks.push(current.join("\n") + closing);
    current = openFence ? [openFence] : [];
    size = openFence ? openFence.length + 1 : 0;
  };
  for (const line of body.split("\n")) {
    if (size + line.length + 1 > limit) flush();
    current.push(line);
    size += line.length + 1;
    if (!openFence && FENCE_RE.test(line)) openFence = line.trim().slice(0, 3);
    else if (openFence && line.trim().startsWith(openFence)) openFence = "";
  }
  flush();
  return chunks.filter((c) => c.trim());
}
