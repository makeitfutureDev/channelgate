// Read structured content that Slack carries outside a message's fallback `text`. Native tables
// can arrive as top-level blocks or inside legacy attachments; pasted composer content may wrap
// those blocks, so the extractor walks the documented block/attachment containers recursively.

const TABLE_TYPES = new Set(["table", "data_table"]);
const MAX_TABLES = 50; // Slack messages support at most 50 top-level blocks.
const MAX_ROWS = 101; // data_table: one header + up to 100 data rows.
const MAX_COLUMNS = 20;

function richTextLeaf(node) {
  const type = String(node?.type || "");
  if (type === "text") return String(node.text ?? "");
  if (type === "link") {
    const label = String(node.text ?? "").trim();
    const url = String(node.url ?? "").trim();
    if (!label) return url;
    return url && label !== url ? `${label} (${url})` : label;
  }
  if (type === "emoji") return node.name ? `:${node.name}:` : "";
  if (type === "user") return node.user_id ? `<@${node.user_id}>` : "";
  if (type === "channel") return node.channel_id ? `<#${node.channel_id}>` : "";
  if (type === "usergroup") return node.usergroup_id ? `<!subteam^${node.usergroup_id}>` : "";
  if (type === "broadcast") return node.range ? `@${node.range}` : "";
  if (type === "date") return String(node.fallback ?? node.text ?? node.timestamp ?? "");
  if (typeof node?.text === "string") return node.text;
  if (typeof node?.value === "string" || typeof node?.value === "number") return String(node.value);
  return "";
}

// Slack rich_text cells are nested blocks. Sections concatenate inline leaves; structural groups
// get newlines so lists/preformatted values remain readable inside the normalized cell.
export function flattenSlackRichText(node) {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(flattenSlackRichText).filter(Boolean).join("");
  if (typeof node !== "object") return String(node);

  const type = String(node.type || "");
  const children = Array.isArray(node.elements) ? node.elements : [];
  if (type === "rich_text") {
    return children.map(flattenSlackRichText).filter(Boolean).join("\n");
  }
  if (type === "rich_text_preformatted" || type === "rich_text_quote") {
    return children.map(flattenSlackRichText).join("");
  }
  if (type === "rich_text_section") {
    return children.map(flattenSlackRichText).join("");
  }
  if (type === "rich_text_list") {
    const ordered = node.style === "ordered";
    return children
      .map((child, index) => `${ordered ? `${index + 1}.` : "•"} ${flattenSlackRichText(child)}`)
      .join("\n");
  }
  return richTextLeaf(node);
}

function normalizeCell(cell) {
  if (cell == null) return "";
  if (typeof cell !== "object") return String(cell);
  if (cell.type === "raw_number") {
    if (typeof cell.value === "number" && Number.isFinite(cell.value)) return cell.value;
    return String(cell.text ?? cell.value ?? "");
  }
  if (cell.type === "raw_text") return String(cell.text ?? "");
  if (cell.type === "rich_text") return flattenSlackRichText(cell);
  return richTextLeaf(cell) || `[unsupported Slack cell: ${String(cell.type || "unknown")}]`;
}

function normalizeTable(block) {
  if (!Array.isArray(block?.rows) || block.rows.length === 0) return null;
  let skippedRows = 0;
  let clippedColumns = 0;
  const rows = [];
  for (const row of block.rows.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row)) {
      skippedRows += 1;
      continue;
    }
    if (row.length > MAX_COLUMNS) clippedColumns += row.length - MAX_COLUMNS;
    rows.push(row.slice(0, MAX_COLUMNS).map(normalizeCell));
  }
  if (!rows.length) return null;
  return {
    type: block.type,
    ...(String(block.caption || "").trim() ? { caption: String(block.caption).trim() } : {}),
    rows,
    ...(block.rows.length > MAX_ROWS ? { omittedRows: block.rows.length - MAX_ROWS } : {}),
    ...(skippedRows ? { skippedMalformedRows: skippedRows } : {}),
    ...(clippedColumns ? { omittedCellsBeyondColumnLimit: clippedColumns } : {}),
  };
}

// Returns normalized, JSON-safe tables in display order. The recursive walk deliberately starts
// only at the message's blocks/attachments so nested root/thread snapshots cannot leak into the
// current message content.
export function extractSlackTables(message = {}) {
  const tables = [];
  const seen = new WeakSet();

  function visit(value) {
    if (tables.length >= MAX_TABLES || value == null) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (TABLE_TYPES.has(value.type)) {
      const table = normalizeTable(value);
      if (table) tables.push(table);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  }

  visit(message.blocks);
  visit(message.attachments);
  return tables;
}

// JSON keeps row/column boundaries exact even when cells contain pipes, tabs, commas, or newlines.
// This is user-authored message content, not a privileged gateway instruction.
export function formatSlackTables(tables = []) {
  if (!Array.isArray(tables) || tables.length === 0) return "";
  const label = tables.length === 1 ? "Native Slack table" : `${tables.length} native Slack tables`;
  return `[${label} included in the message; rows are in display order:]\n${JSON.stringify(tables, null, 2)}`;
}

export function appendSlackTables(text, message) {
  const base = String(text || "").trim();
  const rendered = formatSlackTables(extractSlackTables(message));
  return [base, rendered].filter(Boolean).join("\n\n");
}
