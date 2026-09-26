// The daemon's in-memory registry behind the `remote-mcp` socket relay (src/mcp/remote-mcp-registry.js):
// the ONLY place a relayed server's real URL and headers live once a run is containerized.
import test from "node:test";
import assert from "node:assert/strict";
import { clearRemoteMcps, lookupRemoteMcp, registerRemoteMcps, remoteMcpRegistryStats } from "../src/mcp/remote-mcp-registry.js";

const NOW = 1_700_000_000_000;
const servers = {
  "composio-user": { url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_user_secret" } },
  "make-toolbox": { url: "https://eu1.make.com/mcp/server/abc", headers: { Authorization: "Bearer mk_secret" } },
};

test("a registration answers per jti and name, returns copies, and is gone once cleared", () => {
  registerRemoteMcps({ jti: "jti-a", exp: NOW + 10_000, servers, now: NOW });
  const hit = lookupRemoteMcp("jti-a", "composio-user", NOW + 1);
  assert.deepEqual(hit, servers["composio-user"]);
  hit.headers["x-consumer-api-key"] = "tampered";
  assert.equal(lookupRemoteMcp("jti-a", "composio-user", NOW + 1).headers["x-consumer-api-key"], "ck_user_secret", "callers get a copy");
  assert.equal(lookupRemoteMcp("jti-a", "makeitfuture-toolbox", NOW + 1), null, "a name the run was not given");
  assert.equal(lookupRemoteMcp("jti-other", "composio-user", NOW + 1), null, "another capability's jti");
  assert.deepEqual(remoteMcpRegistryStats(NOW + 1), { registrations: 1, servers: 2, sweeping: true });
  clearRemoteMcps("jti-a");
  assert.equal(lookupRemoteMcp("jti-a", "composio-user", NOW + 1), null);
  assert.deepEqual(remoteMcpRegistryStats(NOW + 1), { registrations: 0, servers: 0, sweeping: false }, "an empty registry keeps no timer");
});

test("an entry expires with its capability and is swept on lookup", () => {
  registerRemoteMcps({ jti: "jti-b", exp: NOW + 5_000, servers, now: NOW });
  assert.ok(lookupRemoteMcp("jti-b", "make-toolbox", NOW + 4_999));
  assert.equal(lookupRemoteMcp("jti-b", "make-toolbox", NOW + 5_000), null);
  assert.equal(remoteMcpRegistryStats(NOW + 5_000).registrations, 0);
});

test("registrations are bounded and never echo a value in their refusal", () => {
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, servers["make-toolbox"]]));
  assert.throws(() => registerRemoteMcps({ jti: "j", exp: NOW + 1_000, servers: many, now: NOW }), /at most 16/);
  const huge = "x".repeat(8 * 1024 + 1);
  for (const [label, bad] of [
    ["oversized header", { a: { url: "https://h.example/mcp", headers: { Authorization: huge } } }],
    ["non-string header", { a: { url: "https://h.example/mcp", headers: { Authorization: 5 } } }],
    ["header injection", { a: { url: "https://h.example/mcp", headers: { Authorization: "a\r\nX: y" } } }],
    ["plain http", { a: { url: "http://h.example/mcp", headers: {} } }],
    ["credentials in url", { a: { url: "https://u:p@h.example/mcp", headers: {} } }],
    ["bad name", { "Bad Name": { url: "https://h.example/mcp", headers: {} } }],
  ]) {
    let error;
    try { registerRemoteMcps({ jti: "j", exp: NOW + 1_000, servers: bad, now: NOW }); } catch (e) { error = e; }
    assert.ok(error, label);
    assert.ok(!error.message.includes("xxxx") && !error.message.includes("h.example"), `${label}: terse refusal`);
  }
  assert.throws(() => registerRemoteMcps({ jti: "j", exp: NOW - 1, servers, now: NOW }), /live expiry/);
  assert.throws(() => registerRemoteMcps({ jti: "", exp: NOW + 1_000, servers, now: NOW }), /capability id/);
  // Exactly the 8 KB bound is accepted.
  registerRemoteMcps({ jti: "j-max", exp: NOW + 1_000, servers: { a: { url: "https://h.example/mcp", headers: { Authorization: "x".repeat(8 * 1024) } } }, now: NOW });
  clearRemoteMcps("j-max");
});
