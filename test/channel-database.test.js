import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { createChannelDatabase, normalizeDatabaseRequest } = await import("../src/gateway/channel-database.js");
const { register } = await import("../src/mcp/tools/channel-database.js");

const ready = { configured: true, allowNetwork: true, state: "on", running: true };
const response = request => {
  const value = request.operation === "list_databases"
    ? { ok: true, operation: request.operation, databases: [], truncated: false }
    : request.operation === "list_tables"
      ? { ok: true, operation: request.operation, database: request.database, tables: [], truncated: false }
      : request.operation === "describe_table"
        ? { ok: true, operation: request.operation, database: request.database, table: request.table, columns: [] }
        : { ok: true, operation: request.operation, database: request.database, table: request.table,
          columns: request.columns, rows: [], truncated: false, truncatedCells: 0 };
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
};

function fixture(overrides = {}) {
  const state = { calls: [], statusCalls: 0 };
  state.database = createChannelDatabase({
    status: async id => { state.statusCalls++; return overrides.status ? overrides.status(id) : ready; },
    execute: async (id, request) => {
      state.calls.push([id, request]);
      return overrides.execute ? overrides.execute(id, request) : response(request);
    },
  });
  return state;
}

const list = { operation: "list_databases" };
const select = {
  operation: "select_rows", database: "customer-db", table: "orders", columns: ["id", "status"],
  filters: [{ column: "status", value: "paid" }], orderBy: { column: "id", direction: "desc" }, limit: 25,
};

test("structured protocol rejects SQL, expressions, paths, endpoints, credentials, and channel overrides", async () => {
  const invalid = [
    { operation: "SELECT * FROM users" },
    { ...select, database: "db; DROP DATABASE customer" },
    { ...select, table: "orders` WHERE 1=1 --" },
    { ...select, columns: ["COUNT(*)"] },
    { ...select, filters: [{ column: "id", value: { gt: 1 } }] },
    { ...select, sql: "DELETE FROM orders" },
    { operation: "list_databases", database: "other" },
    { ...select, channelId: "C_OTHER" },
    { ...select, host: "10.0.0.2" },
    { ...select, password: "must-not-leak" },
    { ...select, path: "/db/credentials.json" },
  ];
  const f = fixture();
  for (const input of invalid) {
    await assert.rejects(f.database.query("C_DB", input, { authorize: async () => true }));
  }
  assert.equal(f.statusCalls, 0);
  assert.equal(f.calls.length, 0);
});

test("normalization preserves typed equality values and applies a hard 100-row default", () => {
  const request = normalizeDatabaseRequest({
    operation: "select_rows", database: "db", table: "rows", columns: ["a"],
    filters: [
      { column: "a", value: null }, { column: "a", value: true },
      { column: "a", value: 12.5 }, { column: "a", value: "value" },
    ],
  });
  assert.deepEqual(request.filters.map(item => item.value), [null, true, 12.5, "value"]);
  assert.equal(request.limit, 100);
  assert.throws(() => normalizeDatabaseRequest({ ...select, limit: 101 }), /between 1 and 100/);
});

test("admission is mandatory and is rechecked after the per-channel queue", async () => {
  let releaseFirst;
  const firstEntered = new Promise(resolve => { releaseFirst = resolve; });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const f = fixture({ execute: async (_id, request) => {
    if (f.calls.length === 1) { releaseFirst(); await blocked; }
    return response(request);
  } });
  await assert.rejects(f.database.query("C_DB", list), { statusCode: 403 });
  const first = f.database.query("C_DB", list, { authorize: async () => true });
  await firstEntered;
  let allowed = true;
  const second = f.database.query("C_DB", list, { authorize: async () => allowed });
  await new Promise(resolve => setImmediate(resolve));
  allowed = false;
  unblock();
  await first;
  await assert.rejects(second, { statusCode: 403 });
  assert.equal(f.calls.length, 1);
});

test("one request runs per channel and the waiting queue is capped at three", async () => {
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  const f = fixture({ execute: async (_id, request) => {
    if (f.calls.length === 1) { entered(); await blocked; }
    return response(request);
  } });
  const authorize = async () => true;
  const first = f.database.query("C_DB", list, { authorize });
  await running;
  const waiting = [1, 2, 3].map(() => f.database.query("C_DB", list, { authorize }));
  await assert.rejects(f.database.query("C_DB", list, { authorize }), { statusCode: 429 });
  assert.equal(f.calls.length, 1);
  unblock();
  await Promise.all([first, ...waiting]);
  assert.equal(f.calls.length, 4);
});

test("Network off, unconfigured, and stopped VPN states block database effects", async () => {
  for (const [status, pattern] of [
    [{ ...ready, allowNetwork: false }, /Turn on Network/],
    [{ ...ready, configured: false }, /not configured/],
    [{ ...ready, state: "off", running: false }, /not connected and ready/],
    [{ ...ready, state: "starting", running: true }, /not connected and ready/],
  ]) {
    const f = fixture({ status: async () => status });
    await assert.rejects(f.database.query("C_DB", list, { authorize: async () => true }), pattern);
    assert.equal(f.calls.length, 0);
  }
});

test("rows are withheld when access or VPN posture changes during the database call", async () => {
  let allowed = true;
  const revoked = fixture({ execute: async (_id, request) => {
    allowed = false;
    return response(request);
  } });
  await assert.rejects(revoked.database.query("C_DB", list, { authorize: async () => allowed }), { statusCode: 403 });

  let checks = 0;
  const disconnected = fixture({ status: async () => ++checks === 1 ? ready : { ...ready, state: "off", running: false } });
  await assert.rejects(disconnected.database.query("C_DB", list, { authorize: async () => true }), /changed state/);
  assert.equal(disconnected.calls.length, 1);
});

test("helper failures, malformed output, and oversized output never disclose raw details", async () => {
  const cases = [
    { code: 1, stdout: JSON.stringify({ ok: false, errorClass: "password=must-not-leak" }), stderr: "token=must-not-leak" },
    { code: 1, stdout: JSON.stringify({ ok: false, errorClass: "database_access_denied", detail: "must-not-leak" }), stderr: "" },
    { code: 0, stdout: "password=must-not-leak", stderr: "" },
    { code: 0, stdout: JSON.stringify({ ok: true, operation: "select_rows", rows: [["x".repeat(270_000)]] }), stderr: "" },
  ];
  for (const output of cases) {
    const f = fixture({ execute: async () => output });
    await assert.rejects(
      f.database.query("C_DB", list, { authorize: async () => true }),
      error => error.statusCode === 503 && !error.message.includes("must-not-leak") && !error.message.includes("270000"),
    );
  }
  const classified = fixture({ execute: async () => ({
    code: 0, stdout: JSON.stringify({ ok: false, errorClass: "query_timed_out" }), stderr: "",
  }) });
  await assert.rejects(
    classified.database.query("C_DB", list, { authorize: async () => true }),
    error => error.statusCode === 503 && /exceeded its time limit/.test(error.message),
  );
});

test("successful helper responses are rebuilt from allowlisted result fields", async () => {
  const f = fixture({ execute: async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, operation: "list_databases", databases: ["customer"], truncated: false,
      password: "must-not-leak", credentials: { token: "must-not-leak" } }),
    stderr: "",
  }) });
  const result = await f.database.query("C_DB", list, { authorize: async () => true });
  assert.deepEqual(result, { ok: true, operation: "list_databases", databases: ["customer"], truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|password|credentials/);
});

test("MCP tool has no caller-selected channel and requires live capability plus channel access, not manager rank", async () => {
  const tools = new Map();
  let definition;
  const calls = [];
  let valid = true;
  let access = true;
  const ctx = {
    channelId: "C_CURRENT",
    text: value => ({ content: [{ type: "text", text: value }] }),
    verifyCapability: () => ({ ok: valid, claims: { principalTrusted: true } }),
    requireChannelAccess: async () => access,
    // Deliberately throws if a read path accidentally starts requiring manager privileges.
    requireManage: async () => { throw new Error("manager check must not run"); },
    channelDatabase: { query: async (channelId, request, { authorize }) => {
      if (!await authorize()) throw Object.assign(new Error("access changed"), { statusCode: 403 });
      calls.push([channelId, request]);
      return { ok: true, operation: request.operation, databases: [] };
    } },
  };
  register({ registerTool(name, def, handler) { definition = def; tools.set(name, handler); } }, ctx);
  assert.equal(Object.hasOwn(definition.inputSchema, "channelId"), false);
  const handler = tools.get("query_channel_database");
  const result = await handler(list);
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [["C_CURRENT", list]]);
  valid = false;
  assert.equal((await handler(list)).isError, true);
  access = false;
  valid = true;
  assert.equal((await handler(list)).isError, true);
  assert.equal(calls.length, 1);
});

test("count_rows and keyset paging normalize to a closed shape", () => {
  assert.deepEqual(
    normalizeDatabaseRequest({ operation: "count_rows", database: "db", table: "t", filters: [{ column: "a", value: 1 }] }),
    { operation: "count_rows", database: "db", table: "t", filters: [{ column: "a", value: 1 }] },
  );
  assert.deepEqual(normalizeDatabaseRequest({ operation: "count_rows", database: "db", table: "t" }).filters, []);
  assert.throws(() => normalizeDatabaseRequest({ operation: "count_rows", database: "db", table: "t", columns: ["a"] }), /do not apply/);
  assert.throws(() => normalizeDatabaseRequest({ operation: "count_rows", database: "db", table: "t", after: "1" }), /do not apply/);
  assert.equal(normalizeDatabaseRequest({ ...select, after: "9007199254740993" }).after, "9007199254740993");
  assert.equal(normalizeDatabaseRequest({ ...select, after: 42 }).after, "42");
  const { orderBy: _order, ...unordered } = select;
  assert.throws(() => normalizeDatabaseRequest({ ...unordered, after: "1" }), /requires orderBy/);
  assert.equal(normalizeDatabaseRequest({ ...select, after: "" }).after, "");
  for (const after of ["x".repeat(4097), 2 ** 60, 1.5, true, null, { id: 1 }]) {
    assert.throws(() => normalizeDatabaseRequest({ ...select, after }), /nextCursor/, JSON.stringify(after));
  }
});

test("count and page results are rebuilt from allowlisted fields and validated", async () => {
  const counted = fixture({ execute: async () => ({ code: 0, stderr: "",
    stdout: JSON.stringify({ ok: true, operation: "count_rows", database: "customer-db", table: "orders", count: 1234, secret: "must-not-leak" }) }) });
  const count = { operation: "count_rows", database: "customer-db", table: "orders" };
  assert.deepEqual(await counted.database.query("C_DB", count, { authorize: async () => true }),
    { ok: true, operation: "count_rows", database: "customer-db", table: "orders", count: 1234 });
  for (const bad of [-1, 1.5, "12", 2 ** 60]) {
    const f = fixture({ execute: async () => ({ code: 0, stderr: "",
      stdout: JSON.stringify({ ok: true, operation: "count_rows", database: "customer-db", table: "orders", count: bad }) }) });
    await assert.rejects(f.database.query("C_DB", count, { authorize: async () => true }), { statusCode: 503 });
  }

  const page = extra => fixture({ execute: async (_id, request) => ({ code: 0, stderr: "", stdout: JSON.stringify({
    ok: true, operation: "select_rows", database: request.database, table: request.table, columns: request.columns,
    rows: [[7, "paid"]], truncated: true, truncatedCells: 0, ...extra }) }) });
  const first = await page({ nextCursor: "7" }).database.query("C_DB", select, { authorize: async () => true });
  assert.equal(first.nextCursor, "7");
  const last = await page({ truncated: false, nextCursor: null }).database.query("C_DB", { ...select, after: "7" }, { authorize: async () => true });
  assert.equal(last.nextCursor, null);
  // A non-pageable order leaves the field out entirely rather than inventing one.
  assert.equal(Object.hasOwn(await page({}).database.query("C_DB", select, { authorize: async () => true }), "nextCursor"), false);
  for (const extra of [{ nextCursor: 7 }, { nextCursor: "x".repeat(4097) }, {}]) {
    await assert.rejects(page(extra).database.query("C_DB", { ...select, after: "1" }, { authorize: async () => true }), { statusCode: 503 });
  }
});

test("paging failures are named, and an extractor that predates paging says to rebuild", async () => {
  const failing = errorClass => fixture({ execute: async () => ({ code: 1, stderr: "", stdout: JSON.stringify({ ok: false, errorClass }) }) });
  await assert.rejects(failing("order_column_not_unique").database.query("C_DB", { ...select, after: "1" }, { authorize: async () => true }),
    /single-column primary key/);
  await assert.rejects(failing("invalid_cursor").database.query("C_DB", { ...select, after: "1" }, { authorize: async () => true }),
    /page cursor is invalid/);
  for (const [errorClass, request] of [["invalid_request", { ...select, after: "1" }],
    ["invalid_operation", { operation: "count_rows", database: "db", table: "t" }]]) {
    await assert.rejects(failing(errorClass).database.query("C_DB", request, { authorize: async () => true }),
      error => error.statusCode === 503 && /predates paging/.test(error.message) && /rebuild the VPN image/.test(error.message));
  }
  // An ordinary request keeps the ordinary message.
  await assert.rejects(failing("invalid_request").database.query("C_DB", select, { authorize: async () => true }),
    error => /request was invalid/.test(error.message) && !/predates/.test(error.message));
});

test("MCP tool schema advertises count_rows and a string cursor", () => {
  let definition;
  register({ registerTool(_name, def) { definition = def; } }, { channelId: "C", text: value => value });
  assert.ok(definition.inputSchema.operation.options.includes("count_rows"));
  assert.equal(definition.inputSchema.after.safeParse("abc").success, true);
  assert.equal(definition.inputSchema.after.safeParse(7).success, false);
  assert.match(definition.description, /nextCursor/);
});
