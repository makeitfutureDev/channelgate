// Slack Lists API client — a thin wrapper over the Slack Web API for the "Lists" feature
// (create a List, read/add/update items). Used by the gateway control MCP server so the bot can
// maintain a shared tasklist inside a channel. Auth uses the workspace BOT token from settings
// (needs the `lists:read` + `lists:write` scopes). This runs in the gateway's own subprocess
// (outside the run sandbox), so it can read the token from settings.json.
//
// Slack Lists model (see docs.slack.dev/reference/methods/slackLists.*):
//   - A List is a file (id `F…`) with a `schema` of columns. Each column has an `id` (`Col…`),
//     a `key`, a `name`, and a `type` (text/select/user/date/checkbox/number/…). Text columns
//     are ALWAYS rich text.
//   - A row is an "item" (id `Rec…`). Cells are addressed by `column_id`; the value key depends on
//     the column type (`rich_text`, `select`, `user`, `date`, `checkbox`, `number`, …).
import { resolveSlackConfig } from "../config/settings.js";
import { getChannelEntry, getChannelMeta, patchChannelMeta } from "../config/store.js";

const API = "https://slack.com/api";

// A List the bot itself creates starts with an EMPTY share set — files.info won't show it in any
// channel until a human shares it, which used to make the create→populate flow refuse its own
// freshly created List. Bot-created listIds are therefore remembered in the creating channel's
// meta and honored by assertListInChannel ahead of the share check. Best-effort on write: if the
// binding can't persist, the share-based guard still applies (fail closed, never open).
async function rememberBotList(listId, channelId) {
  try {
    const entry = await getChannelEntry(channelId);
    if (!entry?.slug) return;
    await patchChannelMeta(entry.slug, (meta) => ({ botLists: { ...(meta?.botLists || {}), [listId]: channelId } }));
  } catch {
    /* the guard falls back to the files.info share check */
  }
}

async function isBotListForChannel(listId, channelId) {
  try {
    const entry = await getChannelEntry(channelId);
    if (!entry?.slug) return false;
    return ((await getChannelMeta(entry.slug))?.botLists || {})[listId] === channelId;
  } catch {
    return false;
  }
}

function botToken() {
  return resolveSlackConfig().botToken || "";
}

// Call a Slack Web API method. `json` sends an application/json body (required by slackLists.*,
// whose params include nested arrays/objects); `form` sends x-www-form-urlencoded (for older
// scalar-param methods like files.info). Throws on transport failure or `ok:false`.
async function call(method, { json, form } = {}) {
  const token = botToken();
  if (!token) throw new Error("Slack bot token isn't configured (set it in the admin Settings).");
  const init = { method: "POST", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}` } };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(json || {});
  }
  const res = await fetch(`${API}/${method}`, init);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(slackError(method, data.error));
  return data;
}

// Friendlier messages for the errors that actually bite here.
function slackError(method, error) {
  const map = {
    missing_scope: "the bot is missing the lists scope — add `lists:read` and `lists:write` to the app and reinstall it.",
    not_allowed_token_type: "this needs a bot token with the lists scopes.",
    list_not_found: "no List with that id — check the id, or make sure the List is shared with the bot.",
    access_denied: "the bot can't access that List — share the List (or its channel) with the bot.",
    item_not_found: "no item with that id in this List.",
  };
  return map[error] || `Slack ${method} failed: ${error || "unknown error"}`;
}

// Accept a raw List/file id (`F…`) or a Slack List URL (…/lists/…/F0ABC…) → return the `F…` id.
export function parseListId(input) {
  const s = String(input || "").trim();
  const m = s.match(/\b(F[A-Z0-9]{6,})\b/);
  return m ? m[1] : s;
}

export function listChannelIds(file = {}) {
  const ids = new Set();
  for (const key of ["channels", "groups", "ims", "channel_ids"]) {
    for (const id of Array.isArray(file[key]) ? file[key] : []) ids.add(String(id));
  }
  if (file.channel_id) ids.add(String(file.channel_id));
  if (file.list_metadata?.channel_id) ids.add(String(file.list_metadata.channel_id));
  for (const visibility of ["public", "private"]) {
    for (const id of Object.keys(file.shares?.[visibility] || {})) ids.add(String(id));
  }
  return ids;
}

export function assertListFileInChannel(file, channelId) {
  if (!channelId) throw new Error("No channel context — can't access a List.");
  if (!listChannelIds(file).has(String(channelId))) {
    throw new Error("this List is not shared with the current channel");
  }
  return file;
}

// A pasted list id is a bot-token ambient capability. Refuse it unless Slack itself reports that
// the List is shared into this MCP process's current channel.
export async function assertListInChannel(listId, channelId) {
  if (!channelId) throw new Error("No channel context — can't access a List.");
  if (await isBotListForChannel(listId, channelId)) return null;
  const data = await call("files.info", { form: { file: listId } });
  return assertListFileInChannel(data.file || {}, channelId);
}

// Wrap a plain string as a Block Kit rich_text value (what text/rich_text cells require).
export function toRichText(str) {
  return [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: String(str ?? "") }] }] }];
}

// Flatten a rich_text value back to plain text (for readable summaries).
function flattenRichText(rt) {
  if (!Array.isArray(rt)) return "";
  let out = "";
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (typeof n?.text === "string") out += n.text;
      if (Array.isArray(n?.elements)) walk(n.elements);
    }
  };
  walk(rt);
  return out.trim();
}

// The default schema for a new tasklist when no columns are given — a primary "Name" text column
// plus a "Status" single-select (New / In progress / Done), mirroring Slack's own list template.
export const DEFAULT_TASK_SCHEMA = [
  { key: "name", name: "Name", type: "text", is_primary_column: true },
  {
    key: "status",
    name: "Status",
    type: "select",
    options: {
      format: "single_select",
      choices: [
        { value: "new", label: "New", color: "purple" },
        { value: "in_progress", label: "In progress", color: "yellow" },
        { value: "done", label: "Done", color: "green" },
      ],
    },
  },
];

// ── Schema resolution ───────────────────────────────────────────────────────────
// Fetch a List's column schema. Lists are files, so files.info returns list_metadata.schema.
// Returns [] if it can't be read (caller can still pass explicit column ids).
export async function getListSchema(listId) {
  try {
    const data = await call("files.info", { form: { file: listId } });
    return data?.file?.list_metadata?.schema || data?.content_metadata?.schema || [];
  } catch {
    return [];
  }
}

// Find the primary (text) column's key — the item's title/name.
function primaryColumn(schema) {
  return schema.find((c) => c.is_primary_column) || schema.find((c) => c.type === "text") || schema[0] || null;
}

// Map a select value/label to the option id Slack expects. Tries the raw value, the option id,
// and a case-insensitive label match; falls back to the given value untouched.
function resolveSelectOption(col, val) {
  const choices = col?.options?.choices || col?.options || [];
  const hit = choices.find(
    (c) =>
      c.value === val ||
      c.id === val ||
      String(c.label ?? c.text ?? "").toLowerCase() === String(val).toLowerCase()
  );
  return hit ? hit.value ?? hit.id ?? val : val;
}

// Coerce a friendly value into the { <valueKey>: … } shape for a column's type.
function coerceValue(col, v) {
  switch (col.type) {
    case "text":
    case "rich_text":
      return { rich_text: toRichText(v) };
    case "select":
    case "multi_select":
      return { select: (Array.isArray(v) ? v : [v]).map((x) => resolveSelectOption(col, x)).filter(Boolean) };
    case "user":
      return { user: Array.isArray(v) ? v : [v] };
    case "channel":
      return { channel: Array.isArray(v) ? v : [v] };
    case "date":
      return { date: Array.isArray(v) ? v : [v] };
    case "checkbox":
      return { checkbox: Boolean(v) };
    case "number":
    case "rating":
      return { number: (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isFinite(n)) };
    case "email":
      return { email: Array.isArray(v) ? v : [v] };
    case "phone":
      return { phone: Array.isArray(v) ? v : [v] };
    default:
      return { rich_text: toRichText(v) };
  }
}

// Turn a friendly { columnKeyOrNameOrId: value } map into cell entries against the schema.
// Unknown columns are skipped. `rowId` (present for updates) is attached as `row_id`.
function buildCells(schema, fields, rowId) {
  const out = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const col = schema.find(
      (c) => c.id === k || c.key === k || String(c.name ?? "").toLowerCase() === String(k).toLowerCase()
    );
    if (!col) continue;
    const base = rowId ? { row_id: rowId, column_id: col.id } : { column_id: col.id };
    out.push({ ...base, ...coerceValue(col, v) });
  }
  return out;
}

// A readable one-line value for a returned field (for list summaries).
function fieldDisplay(field, schema) {
  if (typeof field?.text === "string" && field.text) return field.text;
  if (Array.isArray(field?.rich_text)) return flattenRichText(field.rich_text);
  if (Array.isArray(field?.select) && field.select.length) {
    const col = schema.find((c) => c.id === field.column_id || c.key === field.key);
    const labelFor = (id) => {
      const ch = (col?.options?.choices || col?.options || []).find((c) => (c.value ?? c.id) === id);
      return ch ? ch.label ?? ch.text ?? id : id;
    };
    return field.select.map(labelFor).join(", ");
  }
  if (Array.isArray(field?.user) && field.user.length) return field.user.map((u) => `<@${u}>`).join(", ");
  if (Array.isArray(field?.date) && field.date.length) return field.date.join(", ");
  if (typeof field?.checkbox === "boolean") return field.checkbox ? "☑" : "☐";
  if (Array.isArray(field?.number) && field.number.length) return field.number.join(", ");
  if (Array.isArray(field?.email) && field.email.length) return field.email.join(", ");
  return "";
}

// ── High-level operations ─────────────────────────────────────────────────────────
export async function createList({ name, description, todoMode, columns, channelId } = {}) {
  if (!channelId) throw new Error("No channel context — can't create a List.");
  const body = { name: String(name || "").trim() || "Untitled list" };
  if (description) body.description_blocks = toRichText(description);
  if (todoMode) body.todo_mode = true;
  else body.schema = Array.isArray(columns) && columns.length ? columns : DEFAULT_TASK_SCHEMA;
  const data = await call("slackLists.create", { json: body });
  if (data.list_id) {
    // slackLists.create always produces a standalone List. Bind it to the conversation that
    // authorized this MCP call so members can actually see/edit the tracker the bot just made.
    // The same channel id is also retained locally for the fail-closed follow-up guard below.
    await call("slackLists.access.set", {
      json: { list_id: data.list_id, access_level: "write", channel_ids: [channelId] },
    });
    await rememberBotList(data.list_id, channelId);
  }
  return { listId: data.list_id, schema: data?.list_metadata?.schema || [] };
}

export async function addItem({ listId, name, fields, channelId } = {}) {
  await assertListInChannel(listId, channelId);
  const schema = await getListSchema(listId);
  const merged = { ...(fields || {}) };
  if (name != null && schema.length) {
    const pk = primaryColumn(schema);
    if (pk) merged[pk.id] = name;
  }
  const initial_fields = buildCells(schema, merged, null);
  // If we couldn't resolve any cell from the schema, at least try to set the title directly so a
  // brand-new/empty List still gets a usable row.
  const body = { list_id: listId };
  if (initial_fields.length) body.initial_fields = initial_fields;
  const data = await call("slackLists.items.create", { json: body });
  return { itemId: data?.item?.id || data?.id || "", raw: data };
}

export async function updateItem({ listId, itemId, name, fields, channelId } = {}) {
  await assertListInChannel(listId, channelId);
  const schema = await getListSchema(listId);
  const merged = { ...(fields || {}) };
  if (name != null && schema.length) {
    const pk = primaryColumn(schema);
    if (pk) merged[pk.id] = name;
  }
  const cells = buildCells(schema, merged, itemId);
  if (!cells.length) throw new Error("Nothing to update — pass a name and/or fields that match the List's columns.");
  await call("slackLists.items.update", { json: { list_id: listId, cells } });
  return { ok: true };
}

export async function listItems({ listId, limit = 100, channelId } = {}) {
  await assertListInChannel(listId, channelId);
  const schema = await getListSchema(listId);
  const data = await call("slackLists.items.list", { json: { list_id: listId, limit } });
  const items = (data?.items || data?.records || []).map((it) => {
    const fields = it.fields || it.cells || [];
    const pk = primaryColumn(schema);
    const titleField = pk ? fields.find((f) => f.column_id === pk.id || f.key === pk.key) : null;
    const title = titleField ? fieldDisplay(titleField, schema) : "";
    const cols = {};
    for (const f of fields) {
      const col = schema.find((c) => c.id === f.column_id || c.key === f.key);
      if (pk && col && col.id === pk.id) continue;
      const label = col?.name || f.key || f.column_id;
      const val = fieldDisplay(f, schema);
      if (val) cols[label] = val;
    }
    return { id: it.id, title, cols };
  });
  return { items, schema, cursor: data?.response_metadata?.next_cursor || "" };
}

// A compact, agent-readable schema summary (column names/keys/ids/types + select choices).
export async function describeSchema(listId, channelId) {
  await assertListInChannel(listId, channelId);
  const schema = await getListSchema(listId);
  return schema.map((c) => {
    const bits = [`${c.name} (key: ${c.key}, id: ${c.id}, type: ${c.type}${c.is_primary_column ? ", primary" : ""})`];
    const choices = c?.options?.choices || (c.type === "select" || c.type === "multi_select" ? c?.options : null);
    if (Array.isArray(choices) && choices.length) {
      bits.push("choices: " + choices.map((ch) => `${ch.label ?? ch.text ?? ch.value}`).join(" / "));
    }
    return bits.join(" — ");
  });
}
