// Post native Slack Block Kit data tables with the workspace BOT token. The caller supplies the
// channel/thread from trusted gateway context; neither is exposed as an AI-controlled tool
// argument. Data tables render with native headers, pagination, sorting, and filtering.
import { resolveSlackConfig } from "../config/settings.js";

const API = "https://slack.com/api";
const MAX_COLUMNS = 20;
const MAX_DATA_ROWS = 100;
const MAX_CELL_CHARS = 10_000;

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

function rawText(value, field) {
  if (typeof value !== "string") throw new Error(`\`${field}\` must be text or a finite number.`);
  const clean = value.trim() || "—";
  return { type: "raw_text", text: clean };
}

function dataCell(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`\`${field}\` must be text or a finite number.`);
    return { type: "raw_number", value, text: String(value) };
  }
  return rawText(value, field);
}

function cellChars(cell) {
  return String(cell.text || "").length;
}

function clippedFallback(value) {
  const text = String(value || "").trim();
  return text.length <= 3000 ? text : `${text.slice(0, 2999)}…`;
}

export function buildTableMessage({ caption, headers, rows, pageSize, rowHeaderColumn = 0, summary } = {}) {
  const cleanCaption = requiredText(caption, "caption", 300);
  const cleanHeaders = boundedArray(headers, "headers", MAX_COLUMNS)
    .map((header, index) => ({ type: "raw_text", text: requiredText(header, `headers[${index}]`, 200) }));
  const columnCount = cleanHeaders.length;
  const cleanRows = boundedArray(rows, "rows", MAX_DATA_ROWS).map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new Error(`\`rows[${rowIndex}]\` must be an array.`);
    if (row.length !== columnCount) {
      throw new Error(`Every row must contain exactly ${columnCount} cell${columnCount === 1 ? "" : "s"}.`);
    }
    return row.map((cell, columnIndex) => dataCell(cell, `rows[${rowIndex}][${columnIndex}]`));
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
    throw new Error("Table cells exceed Slack's 10,000-character limit; use `slack_upload_snippet` for a large export.");
  }

  const block = {
    type: "data_table",
    caption: cleanCaption,
    page_size: requestedPageSize,
    row_header_column_index: rowHeaderColumn,
    rows: blockRows,
  };
  const suppliedSummary = optionalText(summary, "summary", 3000);
  const generatedSummary = `${cleanCaption} — ${cleanRows.length} row${cleanRows.length === 1 ? "" : "s"}, ` +
    `${columnCount} column${columnCount === 1 ? "" : "s"}: ${cleanHeaders.map(({ text }) => text).join(", ")}.`;
  return { text: suppliedSummary || clippedFallback(generatedSummary), blocks: [block] };
}

export async function postTable(
  { channelId, threadTs = "", caption, headers, rows, pageSize, rowHeaderColumn, summary } = {},
  { token = resolveSlackConfig().botToken || "", fetchImpl = fetch } = {},
) {
  if (!channelId) throw new Error("No channel context — can't post a table here.");
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
