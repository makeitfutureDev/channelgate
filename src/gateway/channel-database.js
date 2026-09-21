// Channel-scoped database reads through the operator-provisioned VPN extractor.
// Callers provide structured operations only; the fixed host helper derives the
// service, endpoint, credentials, and container identity from this channel id.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayRoot } from "../config/paths.js";
import { runCommand } from "./vpn-service.js";
import { getChannelVpnStatus } from "./channel-vpn-control.js";

const helper = fileURLToPath(new URL("../../scripts/channel-vpn.mjs", import.meta.url));
const OPERATIONS = new Set(["list_databases", "list_tables", "describe_table", "select_rows"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/;
const MAX_ROWS = 100;
const MAX_COLUMNS = 50;
const MAX_FILTERS = 20;
const MAX_QUEUED_PER_CHANNEL = 3;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 + 1024;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const SAFE_FAILURES = new Map([
  ["invalid_request", "The database request was invalid."],
  ["request_too_large", "The database request was too large."],
  ["invalid_operation", "That database operation is not supported."],
  ["invalid_database", "The database name is invalid."],
  ["invalid_table", "The table name is invalid."],
  ["invalid_columns", "The requested columns are invalid."],
  ["invalid_column", "A requested column name is invalid."],
  ["invalid_filters", "The equality filters are invalid."],
  ["invalid_filter_column", "A filter column name is invalid."],
  ["invalid_filter_value", "A filter value is invalid or too large."],
  ["invalid_order", "The row ordering is invalid."],
  ["invalid_order_column", "The order-by column name is invalid."],
  ["invalid_limit", "The row limit must be between 1 and 100."],
  ["database_not_found", "The requested database is unavailable."],
  ["table_not_found", "The requested table is unavailable."],
  ["column_not_found", "A requested column is unavailable."],
  ["database_authentication_failed", "The database rejected the configured credentials."],
  ["database_access_denied", "The configured database account cannot read that data."],
  ["query_timed_out", "The database query exceeded its time limit."],
  ["statement_timeout_unavailable", "The database server could not enforce the required query time limit."],
  ["result_too_large", "The database result exceeded the safe response limit."],
  ["table_metadata_too_large", "The table has too many columns to inspect safely."],
  ["database_route_not_tunnel", "The database route is not using the configured VPN tunnel."],
  ["public_default_route_changed", "The VPN route safety check failed."],
  ["route_not_ready", "The VPN route is not ready."],
  ["database_credentials_unavailable", "The database credentials are unavailable."],
  ["invalid_database_credentials", "The database credentials are invalid."],
  ["invalid_database_credentials_file", "The database credentials file is not private and regular."],
  ["database_connection_or_query_failed", "The database could not complete the read-only request."],
  ["database_query_failed", "The database could not complete the read-only request."],
]);

function helperEnv() {
  const env = { CHANNELGATE_DIR: gatewayRoot() };
  for (const name of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "CHANNELGATE_DB", "CG_WORKSPACE_DIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function name(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw fail(`${label} is invalid.`);
  return value;
}

function scalar(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))) {
    if (typeof value === "string" && value.length > 4096) throw fail("A filter value is too large.");
    return value;
  }
  throw fail("Filter values must be strings, numbers, booleans, or null.");
}

export function normalizeDatabaseRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Database request is invalid.");
  const extra = Object.keys(input).filter(key => !["operation", "database", "table", "columns", "filters", "orderBy", "limit"].includes(key));
  if (extra.length || !OPERATIONS.has(input.operation)) throw fail("Database operation is invalid.");
  const fields = {
    list_databases: new Set(["operation"]),
    list_tables: new Set(["operation", "database"]),
    describe_table: new Set(["operation", "database", "table"]),
    select_rows: new Set(["operation", "database", "table", "columns", "filters", "orderBy", "limit"]),
  }[input.operation];
  if (Object.keys(input).some(key => !fields.has(key))) throw fail("Database request contains fields that do not apply to this operation.");
  const request = { operation: input.operation };
  if (input.operation !== "list_databases") request.database = name(input.database, "Database name");
  if (["describe_table", "select_rows"].includes(input.operation)) request.table = name(input.table, "Table name");
  if (input.operation !== "select_rows") return request;

  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > MAX_COLUMNS) {
    throw fail(`columns must contain between 1 and ${MAX_COLUMNS} names.`);
  }
  request.columns = input.columns.map(column => name(column, "Column name"));
  if (new Set(request.columns).size !== request.columns.length) throw fail("Column names must be unique.");
  const filters = input.filters ?? [];
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) throw fail(`At most ${MAX_FILTERS} equality filters are allowed.`);
  request.filters = filters.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, "column") || !Object.hasOwn(item, "value")) {
      throw fail("Each filter must contain only column and value.");
    }
    return { column: name(item.column, "Filter column"), value: scalar(item.value) };
  });
  if (input.orderBy !== undefined) {
    const order = input.orderBy;
    if (!order || typeof order !== "object" || Array.isArray(order) ||
        Object.keys(order).length !== 2 || !Object.hasOwn(order, "column") || !Object.hasOwn(order, "direction") ||
        !["asc", "desc"].includes(order.direction)) throw fail("orderBy must contain a column and asc or desc direction.");
    request.orderBy = { column: name(order.column, "Order-by column"), direction: order.direction };
  }
  const limit = input.limit ?? MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw fail(`limit must be between 1 and ${MAX_ROWS}.`);
  request.limit = limit;
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw fail("Database request is too large.", 413);
  return request;
}

function boundedString(value, maximum = 4096) {
  if (typeof value !== "string" || value.length > maximum) throw fail("The database service returned an invalid response.", 503);
  return value;
}

function publicCell(value) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string" && value.length <= 4096) return value;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 2 &&
      value.encoding === "base64" && typeof value.data === "string" && value.data.length <= 5500 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
    return { encoding: "base64", data: value.data };
  }
  throw fail("The database service returned an invalid response.", 503);
}

function publicResult(value, request) {
  if (value.operation !== request.operation) throw fail("The database service returned an invalid response.", 503);
  if (request.operation === "list_databases") {
    if (!Array.isArray(value.databases) || value.databases.length > 1000) throw fail("The database service returned an invalid response.", 503);
    return { ok: true, operation: request.operation, databases: value.databases.map(item => boundedString(item, 64)), truncated: value.truncated === true };
  }
  if (value.database !== request.database) throw fail("The database service returned an invalid response.", 503);
  if (request.operation === "list_tables") {
    if (!Array.isArray(value.tables) || value.tables.length > 1000) throw fail("The database service returned an invalid response.", 503);
    return { ok: true, operation: request.operation, database: request.database, tables: value.tables.map(item => boundedString(item, 64)), truncated: value.truncated === true };
  }
  if (value.table !== request.table || !Array.isArray(value.columns)) throw fail("The database service returned an invalid response.", 503);
  if (request.operation === "describe_table") {
    if (value.columns.length > 1000) throw fail("The database service returned an invalid response.", 503);
    const columns = value.columns.map(column => {
      if (!column || typeof column !== "object" || Array.isArray(column)) throw fail("The database service returned an invalid response.", 503);
      return {
        name: boundedString(column.name, 64), dataType: boundedString(column.dataType, 64),
        columnType: boundedString(column.columnType, 1024), nullable: column.nullable === true,
        key: boundedString(column.key, 64), default: publicCell(column.default), extra: boundedString(column.extra, 1024),
      };
    });
    return { ok: true, operation: request.operation, database: request.database, table: request.table, columns };
  }
  if (value.columns.length !== request.columns.length || value.columns.some((column, index) => column !== request.columns[index]) ||
      !Array.isArray(value.rows) || value.rows.length > request.limit) throw fail("The database service returned an invalid response.", 503);
  const rows = value.rows.map(row => {
    if (!Array.isArray(row) || row.length !== request.columns.length) throw fail("The database service returned an invalid response.", 503);
    return row.map(publicCell);
  });
  const truncatedCells = Number.isInteger(value.truncatedCells) && value.truncatedCells >= 0 ? value.truncatedCells : 0;
  return { ok: true, operation: request.operation, database: request.database, table: request.table,
    columns: [...request.columns], rows, truncated: value.truncated === true, truncatedCells };
}

function parseResult(result, request) {
  let value;
  try { value = JSON.parse(result?.stdout || ""); } catch { throw fail("The database service returned an invalid response.", 503); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("The database service returned an invalid response.", 503);
  if (result.code !== 0 || value.ok !== true) {
    throw fail(SAFE_FAILURES.get(value.errorClass) || "The database service could not complete the read-only request.", 503);
  }
  // The extractor is trusted code, but keep its public protocol JSON-only and bounded before
  // handing data to the MCP transport. This also rejects accidental secret-bearing oddities such
  // as undefined, functions, circular values, or an oversized helper implementation regression.
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail("The database service returned an invalid response.", 503); }
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES || value.operation === undefined) {
    throw fail("The database service returned an invalid response.", 503);
  }
  return publicResult(value, request);
}

function createQueue() {
  const channels = new Map();
  async function acquire(channelId) {
    let state = channels.get(channelId);
    if (!state) {
      state = { active: false, waiters: [] };
      channels.set(channelId, state);
    }
    if (!state.active) state.active = true;
    else {
      if (state.waiters.length >= MAX_QUEUED_PER_CHANNEL) throw fail("This channel already has too many database requests waiting. Try again shortly.", 429);
      await new Promise(resolve => state.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) next();
      else channels.delete(channelId);
    };
  }
  return { acquire };
}

export function createChannelDatabase({
  status = getChannelVpnStatus,
  execute = (channelId, request) => runCommand(process.execPath, [helper, "query", "--channel", channelId], {
    cwd: path.dirname(path.dirname(helper)), env: helperEnv(), input: JSON.stringify(request),
    timeoutMs: 45_000, maxOutputBytes: MAX_OUTPUT_BYTES,
  }),
} = {}) {
  const queue = createQueue();

  async function query(channelId, input, { authorize } = {}) {
    if (typeof channelId !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(channelId)) throw fail("Channel is invalid.");
    const request = normalizeDatabaseRequest(input);
    if (typeof authorize !== "function" || !await authorize()) throw fail("Your access to this channel is no longer valid.", 403);
    const release = await queue.acquire(channelId);
    try {
      // Everything below is deliberately inside the per-channel queue. A queued request cannot
      // inherit the authority, Network setting, or runtime state observed when it first arrived.
      if (!await authorize()) throw fail("Your access to this channel changed while the request was waiting.", 403);
      const vpn = await status(channelId);
      if (vpn?.allowNetwork !== true) throw fail("Turn on Network for this channel before querying its database.", 409);
      if (vpn?.configured !== true) throw fail("The channel database VPN is not configured. Ask an administrator to finish setup.", 409);
      if (vpn?.state !== "on" || vpn?.running !== true) throw fail("The channel VPN database service is not connected and ready.", 409);
      // Re-check at the last async boundary before the fixed helper can touch the database.
      if (!await authorize()) throw fail("Your access to this channel changed before the database request ran.", 403);
      let result;
      try { result = await execute(channelId, request); }
      catch { throw fail("The database service is unavailable. Check the channel VPN status and try again.", 503); }
      // The database response can itself take long enough for access or Network/VPN posture to
      // change. Never release rows based only on the admission check that preceded the RPC.
      if (!await authorize()) throw fail("Your access to this channel changed while the database request ran.", 403);
      const after = await status(channelId);
      if (after?.allowNetwork !== true || after?.configured !== true || after?.state !== "on" || after?.running !== true) {
        throw fail("The channel VPN database service changed state while the request ran. No rows were returned.", 409);
      }
      if (!await authorize()) throw fail("Your access to this channel changed before database rows could be returned.", 403);
      return parseResult(result, request);
    } finally {
      release();
    }
  }
  return { query };
}

const database = createChannelDatabase();
export const queryChannelDatabase = database.query;
