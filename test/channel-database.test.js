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
