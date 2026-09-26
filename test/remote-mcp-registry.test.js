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

test("holds: the minting caller's release drops an unheld grant; a relay connection's hold outlives it", async () => {
  const { releaseRemoteMcps, retainRemoteMcps, hasRemoteMcps } = await import("../src/mcp/remote-mcp-registry.js");
  const exp = Date.now() + 60_000;
  registerRemoteMcps({ jti: "hold-cold", exp, servers });
  releaseRemoteMcps("hold-cold");
  assert.equal(hasRemoteMcps("hold-cold"), false, "a cold turn's grant goes when the turn settles");

  registerRemoteMcps({ jti: "hold-warm", exp, servers });
  const connection = retainRemoteMcps("hold-warm");
  releaseRemoteMcps("hold-warm");
  assert.equal(hasRemoteMcps("hold-warm"), true, "a warm process's open relay keeps it");
  connection();
  connection(); // idempotent
  assert.equal(hasRemoteMcps("hold-warm"), false, "and it goes when that process hangs up");
  assert.equal(typeof retainRemoteMcps("never-registered"), "function");
});

test("clearRemoteMcpsWhere drops by metadata, held or not, and sees no values", async () => {
  const { clearRemoteMcpsWhere, retainRemoteMcps, hasRemoteMcps, revokeRemoteMcpsForAuthor } = await import("../src/mcp/remote-mcp-registry.js");
  const exp = Date.now() + 60_000;
  registerRemoteMcps({ jti: "w-1", exp, servers, meta: { channelId: "C1", slug: "one", authorId: "U1", origin: "ssh_session", headers: "ignored" } });
  registerRemoteMcps({ jti: "w-2", exp, servers, meta: { channelId: "C2", slug: "two", authorId: "U1", origin: "slack_foreground" } });
  registerRemoteMcps({ jti: "w-3", exp, servers, meta: { channelId: "C1", slug: "one", authorId: "U2", origin: "ssh_session" } });
  retainRemoteMcps("w-1");
  const seen = [];
  assert.equal(clearRemoteMcpsWhere((meta, jti) => { seen.push([jti, meta]); return meta.origin === "ssh_session" && meta.authorId === "U1"; }), 1);
  assert.ok(!hasRemoteMcps("w-1"), "held or not");
  assert.deepEqual(Object.keys(seen[0][1]).sort(), ["authorId", "channelId", "origin", "slug"], "metadata only");
  assert.equal(revokeRemoteMcpsForAuthor("U1"), 1);
  assert.ok(!hasRemoteMcps("w-2") && hasRemoteMcps("w-3"));
  assert.equal(clearRemoteMcpsWhere(() => { throw new Error("predicate bug"); }), 0, "a throwing predicate drops nothing");
  clearRemoteMcps("w-3");
});

test("remoteMcpServerProblem judges one server at a time, value-free", async () => {
  const { remoteMcpServerProblem } = await import("../src/mcp/remote-mcp-registry.js");
  assert.equal(remoteMcpServerProblem(servers["composio-user"]), "");
  const bad = [
    { url: "http://h.example/mcp", headers: {} },
    { url: "https://h.example/mcp", headers: { Authorization: "Bearer a\r\nX-Evil: 1" } },
    { url: "https://h.example/mcp", headers: { Authorization: 5 } },
    { url: "https://h.example/mcp", headers: { Authorization: "x".repeat(8 * 1024 + 1) } },
    { url: "https://h.example/mcp", headers: { "bad name": "v" } },
    { url: "https://h.example/mcp", headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`h${i}`, "v"])) },
    { url: "https://h.example/mcp", headers: ["not", "an", "object"] },
  ];
  for (const server of bad) {
    const problem = remoteMcpServerProblem(server);
    assert.ok(problem, JSON.stringify(server).slice(0, 60));
    assert.ok(!problem.includes("h.example") && !problem.includes("Bearer") && !problem.includes("xxx"), problem);
  }
});
