// Destination policy (src/gateway/egress/policy.js): the SSRF boundary once containers run with
// `--network none`. Every resolved address is checked and ANY non-public one refuses the whole
// destination; the first address is pinned for the connect.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { checkDestination, isValidDestinationHost } = await import("../src/gateway/egress/policy.js");

function fakeDns(table) {
  return async (hostname, options) => {
    assert.deepEqual(options, { all: true, verbatim: true });
    if (!(hostname in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return table[hostname].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

const lookup = fakeDns({
  "public.example": ["93.184.215.14"],
  "metadata.example": ["169.254.169.254"],
  "lan.example": ["10.1.2.3"],
  "mixed.example": ["93.184.215.14", "192.168.1.10"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "mapped-meta.example": ["::ffff:a9fe:a9fe"],
  "v6.example": ["2606:4700::6810:84e5"],
  "ula.example": ["fd00::1"],
  "api.anthropic.com": ["160.79.104.10"],
  "db.supabase.example": ["93.184.215.20"],
  "loop.test": ["127.0.0.1"],
});

const on = { mode: "on", lookup };

test("the cloud metadata address is refused, by name and as a literal", async () => {
  for (const hostname of ["metadata.example", "169.254.169.254", "mapped-meta.example"]) {
    const result = await checkDestination({ hostname, port: 80, ...on });
    assert.equal(result.ok, false, hostname);
    assert.equal(result.category, "blocked-address");
    assert.match(result.reason, /link-local|metadata/);
    assert.equal(result.address, null);
  }
});

test("private, loopback, ULA and mixed answers are refused; IPv4-mapped forms too", async () => {
  for (const hostname of ["lan.example", "mixed.example", "mapped.example", "ula.example", "127.0.0.1", "::1", "[::ffff:10.0.0.1]", "0.0.0.0"]) {
    const result = await checkDestination({ hostname, port: 443, ...on });
    assert.equal(result.ok, false, hostname);
    assert.equal(result.category, "blocked-address", hostname);
  }
});

test("a public destination is allowed and its address pinned", async () => {
  assert.deepEqual(await checkDestination({ hostname: "public.example", port: 443, ...on }), { ok: true, address: "93.184.215.14", family: 4, tunnel: false });
  const v6 = await checkDestination({ hostname: "V6.Example.", port: 443, ...on });
  assert.equal(v6.ok, true);
  assert.equal(v6.address, "2606:4700::6810:84e5");
  // The callback form of dns.lookup is accepted too.
  const cb = await checkDestination({ hostname: "x.example", port: 443, mode: "on", lookup: (h, o, done) => done(null, [{ address: "93.184.215.99", family: 4 }]) });
  assert.equal(cb.address, "93.184.215.99");
});

test("mode off allows only the engine hosts; an allowlist narrows mode on", async () => {
  const engineHosts = ["api.anthropic.com", "*.openai.com"];
  assert.equal((await checkDestination({ hostname: "api.anthropic.com", port: 443, mode: "off", engineHosts, lookup })).ok, true);
  const off = await checkDestination({ hostname: "public.example", port: 443, mode: "off", engineHosts, lookup });
  assert.deepEqual([off.ok, off.category], [false, "network-off"]);
  const listed = await checkDestination({ hostname: "public.example", port: 443, mode: "on", allowHosts: ["public.example"], engineHosts, lookup });
  assert.equal(listed.ok, true);
  const unlisted = await checkDestination({ hostname: "v6.example", port: 443, mode: "on", allowHosts: ["public.example"], engineHosts, lookup });
  assert.deepEqual([unlisted.ok, unlisted.category], [false, "not-allowlisted"]);
  const engineAlways = await checkDestination({ hostname: "api.anthropic.com", port: 443, mode: "on", allowHosts: [], engineHosts, lookup });
  assert.equal(engineAlways.ok, true);
  const unknown = await checkDestination({ hostname: "public.example", port: 443, mode: "maybe", lookup });
  assert.deepEqual([unknown.ok, unknown.category], [false, "policy"]);
  // Even an engine host is refused when it resolves somewhere private.
  const poisoned = await checkDestination({ hostname: "api.anthropic.com", port: 443, mode: "off", engineHosts, lookup: fakeDns({ "api.anthropic.com": ["10.0.0.5"] }) });
  assert.equal(poisoned.category, "blocked-address");
});

test("rawPassthrough marks a tunnel, only for its exact host and port and only when on", async () => {
  const rawPassthrough = [{ host: "db.supabase.example", port: 5432 }];
  const tunnel = await checkDestination({ hostname: "db.supabase.example", port: 5432, mode: "on", rawPassthrough, lookup });
  assert.deepEqual(tunnel, { ok: true, address: "93.184.215.20", family: 4, tunnel: true });
  assert.equal((await checkDestination({ hostname: "db.supabase.example", port: 443, mode: "on", rawPassthrough, lookup })).tunnel, false);
  assert.equal((await checkDestination({ hostname: "db.supabase.example", port: 5432, mode: "on", allowHosts: [], rawPassthrough, lookup })).tunnel, true);
  assert.equal((await checkDestination({ hostname: "db.supabase.example", port: 5432, mode: "off", rawPassthrough, lookup })).ok, false);
});

test("invalid names, ports, DNS failures and the test-only loopback allowance", async () => {
  for (const [hostname, port] of [["bad host", 443], ["*.example.com", 443], ["x".repeat(64) + ".com", 443], ["public.example", 0], ["public.example", 70000], ["", 443], ["fe80::1%eth0", 443]]) {
    const result = await checkDestination({ hostname, port, ...on });
    assert.deepEqual([result.ok, result.category], [false, "invalid-destination"], `${hostname}:${port}`);
  }
  assert.equal((await checkDestination({ hostname: "nowhere.example", port: 443, ...on })).category, "dns-failure");
  assert.equal((await checkDestination({ hostname: "empty.example", port: 443, mode: "on", lookup: async () => [] })).category, "dns-failure");
  assert.equal((await checkDestination({ hostname: "loop.test", port: 443, ...on })).category, "blocked-address");
  const allowed = await checkDestination({ hostname: "loop.test", port: 443, ...on, allowLoopbackHosts: ["loop.test"] });
  assert.deepEqual([allowed.ok, allowed.address], [true, "127.0.0.1"]);
  assert.equal((await checkDestination({ hostname: "lan.example", port: 443, ...on, allowLoopbackHosts: ["lan.example"] })).ok, false, "the allowance covers loopback only");
  assert.equal(isValidDestinationHost("xn--bcher-kva.example"), true);
  assert.equal(isValidDestinationHost("-bad.example"), false);
  assert.equal(isValidDestinationHost("1.2.3"), false);
});
