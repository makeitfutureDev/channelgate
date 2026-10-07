// Post native Slack Block Kit data tables with the workspace BOT token. The caller supplies the
// channel/thread from trusted gateway context; neither is exposed as an AI-controlled tool
// argument. Data tables render with native headers, pagination, sorting, and filtering.
//
// Cells come in three shapes. A finite number is a `raw_number` (numeric sorting). A plain string
// is a `raw_text` — unless it carries lightweight Markdown (a `[label](url)` link, a bare https
// URL, `**bold**`, `` `code` ``, `~~strike~~`), which becomes a `rich_text` cell so links stay
// clickable. An object cell is explicit: `{text, url, bold, italic, strike, code}` builds a
// formatted/link cell, `{user}` a real mention (the ONLY way cell data pings someone — a raw
// `<@U…>` in a string stays text, exactly as it does in a reply), and `{button: {label, url}}`
// builds an `action_cell` whose row button opens the URL. Header cells are always plain text
// (Slack rejects rich text there), so Markdown markers are stripped from them.
// The engine stream readers (engines/stream.js, engines/codex.js) import the block builder through
// reply-blocks.js, and config/settings.js imports the engine registry — so the settings read for
// the default bot token is deferred to the post itself, keeping this module out of that cycle.
const API = "https://slack.com/api";

async function defaultBotToken() {
  const { resolveSlackConfig } = await import("../config/settings.js");
  return resolveSlackConfig().botToken || "";
}
export const MAX_COLUMNS = 20;
export const MAX_DATA_ROWS = 200;
export const MAX_CELL_CHARS = 20_000;
const MAX_BUTTON_LABEL = 75;
export const TABLE_ROW_ACTION_ID = "cg_table_row";

function requiredText(value, field, max) {
  const out = String(value ?? "").trim();
  if (!out) throw new Error(`\`${field}\` is required.`);
  if (out.length > max) throw new Error(`\`${field}\` must be ${max} characters or fewer.`);
  return out;
}

function optionalText(value, field, max) {
  const out = String(value ?? "").trim();
  if (out.length > max) throw new Error(`\`${field}\` must be ${max} characters or fewer.`);
  return out;
}

function boundedArray(value, field, max) {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`\`${field}\` must contain at least one item.`);
  if (value.length > max) throw new Error(`\`${field}\` supports at most ${max} items.`);
  return value;
}

// Absolute http(s) URL or nothing. Slack rejects anything else in a link/button element. No
// whitespace or control character anywhere: `new URL()` would silently strip a newline that
// Slack then rejects, taking the whole block set with it.
function httpUrl(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/[\s\x00-\x1f\x7f]/.test(raw)) throw new Error(`\`${field}\` must be an absolute http(s) URL.`);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`\`${field}\` must be an absolute http(s) URL.`); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error(`\`${field}\` must be an absolute http(s) URL.`);
  }
  if (raw.length > 3000) throw new Error(`\`${field}\` must be 3000 characters or fewer.`);
  return raw;
}

// Lightweight Markdown → rich_text elements. Everything outside a recognized span is plain text.
// Spans: `[label](url)` (one level of balanced parentheses inside the URL), `**bold**` (no
// space inside the markers, so a glob such as `src/**/x` stays literal), `` `code` ``,
// `~~strike~~`, and a bare https URL (trailing punctuation and an unbalanced `)` excluded).
// No `<@U…>` here: a mention in cell data is only ever the explicit `{user}` cell, exactly as a
// raw `<@U…>` in a reply is escaped rather than pinged. Every span excludes its own opener from
// its body so a cell full of `[` or `*` costs linear time, not quadratic.
// A fresh regex per call: a shared global one carries `lastIndex` between test() and matchAll().
const SPAN_SOURCE = String.raw`\[([^\[\]\n]+)\]\((https?:\/\/(?:[^\s()<>|]|\([^\s()<>|]*\))+)\)` +
  String.raw`|\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*` +
  "|`([^`\\n]+)`" +
  String.raw`|~~(?=\S)([^~\n]+?)(?<=\S)~~` +
  String.raw`|(https?:\/\/[^\s<>|]+)`;
const spanRegex = () => new RegExp(SPAN_SOURCE, "g");

// A bare URL's run stops at whitespace, which swallows sentence punctuation and a closing
// parenthesis the URL did not open. Trim those back into the surrounding text.
function trimBareUrl(url) {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (!last) break;
    if (".,;:!?'\"".includes(last)) { end -= 1; continue; }
    if (last === ")") {
      const body = url.slice(0, end);
      const opens = (body.match(/\(/g) || []).length;
      const closes = (body.match(/\)/g) || []).length;
      if (closes > opens) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

export function richTextElements(text) {
  const source = String(text ?? "");
  const elements = [];
  let last = 0;
  const pushText = (value, style) => {
    if (!value) return;
    const previous = elements[elements.length - 1];
    if (previous?.type === "text" && !previous.style && !style) previous.text += value;
    else elements.push(style ? { type: "text", text: value, style } : { type: "text", text: value });
  };
  for (const match of source.matchAll(spanRegex())) {
    const [whole, linkText, linkUrl, bold, code, strike, bareUrl] = match;
    let consumed = whole.length;
    pushText(source.slice(last, match.index));
    if (linkUrl) elements.push({ type: "link", url: linkUrl, text: linkText });
    else if (bold) pushText(bold, { bold: true });
    else if (code) pushText(code, { code: true });
    else if (strike) pushText(strike, { strike: true });
    else if (bareUrl) {
      const url = trimBareUrl(bareUrl);
      consumed = url.length;
      elements.push({ type: "link", url });
    }
    last = match.index + consumed;
  }
  pushText(source.slice(last));
  return elements;
}

export function hasRichSpans(text) {
  return spanRegex().test(String(text ?? ""));
}

// The readable text of a cell (what counts against Slack's character limit, and what a header
// keeps once its markers are stripped).
function plainText(elements) {
  return elements.map((element) => {
    if (element.type === "link") return element.text || element.url;
    if (element.type === "user") return `@${element.user_id}`;
    return element.text || "";
  }).join("");
}

function richTextCell(elements) {
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

function rawText(value) {
  const clean = String(value ?? "").trim() || "—";
  return { type: "raw_text", text: clean };
}

function styledElements({ text, url, user, bold, italic, strike, code }, field) {
  if (user) {
    const id = String(user).trim().replace(/^<@|>$/g, "");
    if (!/^[UW][A-Z0-9]{2,}$/.test(id)) throw new Error(`\`${field}.user\` must be a Slack user id (U…).`);
    return [{ type: "user", user_id: id }];
  }
  const label = String(text ?? "").trim();
  const link = httpUrl(url, `${field}.url`);
  if (!label && !link) throw new Error(`\`${field}\` needs \`text\`, \`url\`, \`user\` or \`button\`.`);
  if (link) return [{ type: "link", url: link, ...(label ? { text: label } : {}) }];
  const style = {};
  if (bold) style.bold = true;
  if (italic) style.italic = true;
  if (strike) style.strike = true;
  if (code) style.code = true;
  return Object.keys(style).length ? [{ type: "text", text: label, style }] : richTextElements(label);
}

function actionCell(button, { field, row, column, actionIdPrefix }) {
  const label = requiredText(button?.label, `${field}.button.label`, MAX_BUTTON_LABEL);
  const url = httpUrl(button?.url, `${field}.button.url`);
  if (!url) throw new Error(`\`${field}.button.url\` is required.`);
  return {
    type: "action_cell",
    element: {
      type: "button",
      // Unique per cell: Slack refuses duplicate action_ids inside one block. The stable prefix is
      // what the ack-only handler in app.js matches.
      action_id: `${actionIdPrefix}_${row}_${column}`,
      text: { type: "plain_text", text: label, emoji: true },
      url,
      value: JSON.stringify({ r: row, c: column }),
    },
    fallback: { type: "raw_text", text: label },
  };
}

function dataCell(value, field, position) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`\`${field}\` must be text, a finite number, or a cell object.`);
    return { type: "raw_number", value, text: String(value) };
  }
  if (typeof value === "string") {
    if (!hasRichSpans(value)) return rawText(value);
    return richTextCell(richTextElements(value.trim()));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.button) return actionCell(value.button, { field, ...position });
    return richTextCell(styledElements(value, field));
  }
  throw new Error(`\`${field}\` must be text, a finite number, or a cell object.`);
}

export function cellChars(cell) {
  if (!cell) return 0;
  if (cell.type === "rich_text") return cell.elements.reduce((total, section) => total + plainText(section.elements || []).length, 0);
  if (cell.type === "action_cell") return String(cell.fallback?.text || "").length;
  return String(cell.text || "").length;
}

export function cellPlainText(cell) {
  if (!cell) return "";
  if (cell.type === "rich_text") return cell.elements.map((section) => plainText(section.elements || [])).join("");
  if (cell.type === "action_cell") return String(cell.fallback?.text || "");
  return String(cell.text || "");
}

function clippedFallback(value) {
  const text = String(value || "").trim();
  return text.length <= 3000 ? text : `${text.slice(0, 2999)}…`;
}

// The data_table block alone (no message wrapper) — shared by the standalone post and composed
// replies (reply-blocks.js).
// The raw size of a cell before any parsing: the cheap bound that refuses an oversized table
// before the span parser ever runs over it.
function rawCellLength(cell) {
  if (typeof cell === "string") return cell.length;
  if (typeof cell === "number") return String(cell).length;
  if (cell && typeof cell === "object") return String(cell.text ?? "").length + String(cell.button?.label ?? "").length;
  return 0;
}

export function buildTableBlock({ caption, headers, rows, pageSize, rowHeaderColumn = 0, actionIdPrefix = TABLE_ROW_ACTION_ID } = {}) {
  const cleanCaption = requiredText(caption, "caption", 300);
  const headerList = boundedArray(headers, "headers", MAX_COLUMNS);
  const rowList = boundedArray(rows, "rows", MAX_DATA_ROWS);
  const rawChars = rowList.flat().reduce((total, cell) => total + rawCellLength(cell), 0)
    + headerList.reduce((total, header) => total + String(header ?? "").length, 0);
  if (rawChars > MAX_CELL_CHARS * 2) {
    throw new Error("Table cells exceed Slack's 20,000-character limit; use `slack_upload_snippet` for a large export.");
  }
  const cleanHeaders = headerList
    .map((header, index) => {
      const text = requiredText(header, `headers[${index}]`, 200);
      return { type: "raw_text", text: hasRichSpans(text) ? plainText(richTextElements(text)) || text : text };
    });
  const columnCount = cleanHeaders.length;
  const cleanRows = rowList.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new Error(`\`rows[${rowIndex}]\` must be an array.`);
    if (row.length !== columnCount) {
      throw new Error(`Every row must contain exactly ${columnCount} cell${columnCount === 1 ? "" : "s"}.`);
    }
    return row.map((cell, columnIndex) => dataCell(cell, `rows[${rowIndex}][${columnIndex}]`, { row: rowIndex, column: columnIndex, actionIdPrefix }));
  });

  const requestedPageSize = pageSize ?? Math.min(10, cleanRows.length);
  if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 100) {
    throw new Error("`page_size` must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(rowHeaderColumn) || rowHeaderColumn < 0 || rowHeaderColumn >= columnCount) {
    throw new Error(`\`row_header_column\` must be an integer from 0 to ${columnCount - 1}.`);
  }

  const blockRows = [cleanHeaders, ...cleanRows];
  const charCount = blockRows.flat().reduce((total, cell) => total + cellChars(cell), 0);
  if (charCount > MAX_CELL_CHARS) {
    throw new Error("Table cells exceed Slack's 20,000-character limit; use `slack_upload_snippet` for a large export.");
  }

  return {
    block: {
      type: "data_table",
      caption: cleanCaption,
      page_size: requestedPageSize,
      row_header_column_index: rowHeaderColumn,
      rows: blockRows,
    },
    caption: cleanCaption,
    headers: cleanHeaders.map(({ text }) => text),
    rowCount: cleanRows.length,
    columnCount,
  };
}

export function buildTableMessage({ caption, headers, rows, pageSize, rowHeaderColumn = 0, summary } = {}) {
  const built = buildTableBlock({ caption, headers, rows, pageSize, rowHeaderColumn });
  const suppliedSummary = optionalText(summary, "summary", 3000);
  const generatedSummary = `${built.caption} — ${built.rowCount} row${built.rowCount === 1 ? "" : "s"}, ` +
    `${built.columnCount} column${built.columnCount === 1 ? "" : "s"}: ${built.headers.join(", ")}.`;
  return { text: suppliedSummary || clippedFallback(generatedSummary), blocks: [built.block] };
}

export async function postTable(
  { channelId, threadTs = "", caption, headers, rows, pageSize, rowHeaderColumn, summary } = {},
  { token = "", fetchImpl = fetch } = {},
) {
  if (!channelId) throw new Error("No channel context — can't post a table here.");
  if (!token) token = await defaultBotToken();
  if (!token) throw new Error("Slack bot token isn't configured (set it in the admin Settings).");
  const message = buildTableMessage({ caption, headers, rows, pageSize, rowHeaderColumn, summary });
  const body = { channel: channelId, ...message };
  if (threadTs) body.thread_ts = threadTs;

  const response = await fetchImpl(`${API}/chat.postMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Slack chat.postMessage failed (HTTP ${response.status}).`);
  if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error || "unknown error"}`);
  return { ts: data.ts || "", channel: data.channel || channelId };
}
