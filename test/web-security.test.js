// Unit tests for the pure security helpers in src/web/security.js (node:test, no deps).
// Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tempDir } from "./helpers.js";
import {
  isLoopbackHost,
  pathWithin,
  resolveWithinRoot,
  timingSafeEqualStr,
  clientKey,
  createLoginLimiter,
  sanitizeMcpMatch,
  sanitizeCodexMcpSelection,
} from "../src/web/security.js";

// ── isLoopbackHost ──────────────────────────────────────────────────────────────
test("isLoopbackHost: loopback forms", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.1.2.3"), true); // whole 127/8 block
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true); // IPv4-mapped, as remoteAddress reports
});

test("isLoopbackHost: non-loopback forms", () => {
  assert.equal(isLoopbackHost("0.0.0.0"), false); // wildcard = reachable from the network
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("::ffff:192.168.1.10"), false);
  assert.equal(isLoopbackHost("1270.0.0.1"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(undefined), false);
});

// ── pathWithin ──────────────────────────────────────────────────────────────────
test("pathWithin: containment is separator-aware", () => {
  const root = path.join(path.sep, "home", "user");
  assert.equal(pathWithin(root, root), true); // the root itself
  assert.equal(pathWithin(root, path.join(root, "a", "b")), true); // nested child
  assert.equal(pathWithin(root, path.join(root, "..foo")), true); // dir literally named "..foo"
  assert.equal(pathWithin(root, `${root}2`), false); // sibling sharing the prefix (/home/user2)
  assert.equal(pathWithin(root, path.join(root, "..")), false); // parent
  assert.equal(pathWithin(root, path.join(root, "..", "other")), false); // .. escape
  assert.equal(pathWithin(root, path.join(path.sep, "etc")), false); // unrelated absolute
});

// ── resolveWithinRoot (real filesystem: symlinks + nonexistent paths) ───────────
test("resolveWithinRoot: realpath containment", (t) => {
  const base = tempDir("cg-sec-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, "root", "inner"), { recursive: true });
  const root = realpathSync(path.join(base, "root")); // realpath: os.tmpdir() is itself a symlink on macOS
  const outside = path.join(base, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(root, "leak")); // symlink inside root → outside it
  symlinkSync(path.join(root, "inner"), path.join(root, "alias")); // symlink staying inside

  assert.equal(resolveWithinRoot(root, root), root);
  assert.equal(resolveWithinRoot(root, path.join(root, "inner")), path.join(root, "inner"));
  assert.equal(resolveWithinRoot(root, path.join(root, "alias")), path.join(root, "inner")); // flattened
  assert.equal(resolveWithinRoot(root, path.join(root, "leak")), null); // symlink escape
  assert.equal(resolveWithinRoot(root, path.join(root, "..")), null); // .. escape
  assert.equal(resolveWithinRoot(root, path.join(root, "inner", "..", "..", "outside")), null);
  assert.equal(resolveWithinRoot(root, path.join(root, "missing")), null); // nonexistent → reject
});

// ── timingSafeEqualStr ──────────────────────────────────────────────────────────
test("timingSafeEqualStr: equality without length short-circuit", () => {
  assert.equal(timingSafeEqualStr("hunter2", "hunter2"), true);
  assert.equal(timingSafeEqualStr("hunter2", "hunter3"), false); // same length
  assert.equal(timingSafeEqualStr("hunter2", "hunter22"), false); // different length — no throw
  assert.equal(timingSafeEqualStr("", "x"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});

// ── clientKey ───────────────────────────────────────────────────────────────────
// Everything a per-IP limiter buckets on. The daemon is reached through a loopback tunnel, so the
// socket address is the same for every caller on earth — the forwarding headers are the only thing
// that tells them apart, and they may be believed only where they cannot be forged.
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test("clientKey: with no proxy declared, the socket is the client and every forwarded header is ignored", () => {
  // A loopback socket is NOT evidence of a proxy: any process on the host, any tunnel, opens one.
  // Trusting it let a caller pick a fresh backoff bucket per request by writing its own header.
  for (const socket of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "198.51.100.9"]) {
    assert.equal(clientKey(req(socket, { "x-forwarded-for": "203.0.113.5" }), ""), socket);
    assert.equal(clientKey(req(socket, { "cf-connecting-ip": "203.0.113.5" }), ""), socket);
    assert.equal(clientKey(req(socket), ""), socket);
  }
  // The default mode comes from settings/env; with neither set it is "".
  delete process.env.CG_TRUST_PROXY;
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5", "cf-connecting-ip": "198.51.100.7" })), "127.0.0.1");
  // No socket at all (a synthetic request) still produces a stable, non-empty bucket.
  assert.equal(clientKey({}), "unknown");
});

test("clientKey: 'cloudflare' reads CF-Connecting-IP only — X-Forwarded-For is a client's claim there", () => {
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.5" }), "cloudflare"), "198.51.100.7");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }), "cloudflare"), "127.0.0.1");
  // Brackets/ports as some proxies write them; garbage is ignored rather than becoming a bucket.
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "[2001:db8::1]:443" }), "cloudflare"), "2001:db8::1");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "evil; DROP" }), "cloudflare"), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "1".repeat(500) }), "cloudflare"), "127.0.0.1");
});

test("clientKey: 'xff' reads the LAST X-Forwarded-For hop (the proxy's), never the first (the client's)", () => {
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }), "xff"), "203.0.113.5");
  // A client that prepends hops cannot choose its bucket: the trusted proxy appended the last one.
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "10.9.9.9, 10.8.8.8, 203.0.113.5" }), "xff"), "203.0.113.5");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": " 203.0.113.5 " }), "xff"), "203.0.113.5");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5:9000" }), "xff"), "203.0.113.5");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "[2001:db8::1]:443" }), "xff"), "2001:db8::1");
  // CF-Connecting-IP is not this proxy's header.
  assert.equal(clientKey(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7" }), "xff"), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "not-an-ip" }), "xff"), "127.0.0.1");
  assert.equal(clientKey(req("127.0.0.1", { "x-forwarded-for": "unknown" }), "xff"), "127.0.0.1"); // RFC 7239's placeholder
  // A proxy on ANOTHER host: the socket is not loopback, and the declared header is still honoured.
  assert.equal(clientKey(req("198.51.100.9", { "x-forwarded-for": "203.0.113.5" }), "xff"), "203.0.113.5");
});

test("clientKey: the mode comes from settings (over env); the legacy CG_TRUST_PROXY=1 means xff", async () => {
  const { saveSettings, getTrustProxy, normalizeTrustProxy, TRUST_PROXY_MODES } = await import("../src/config/settings.js");
  assert.deepEqual(TRUST_PROXY_MODES, ["", "cloudflare", "xff"]);
  for (const [raw, mode] of [["", ""], ["none", ""], ["0", ""], ["false", ""], ["cloudflare", "cloudflare"], ["CF", "cloudflare"], ["xff", "xff"],
    ["X-Forwarded-For", "xff"], ["1", "xff"], ["true", "xff"], ["yes", "xff"], ["bogus", null], ["127.0.0.1", null]]) {
    assert.equal(normalizeTrustProxy(raw), mode, `normalize(${JSON.stringify(raw)})`);
  }
  const headers = { "x-forwarded-for": "10.9.9.9, 203.0.113.5", "cf-connecting-ip": "198.51.100.7" };
  try {
    saveSettings({ trustProxy: "" });
    process.env.CG_TRUST_PROXY = "1";
    assert.equal(getTrustProxy(), "", "a stored value (even the empty one) wins over the env");
    assert.equal(clientKey(req("127.0.0.1", headers)), "127.0.0.1");
    // No stored value: the env decides, and the legacy truthy spelling means xff.
    saveSettings({ trustProxy: null });
    assert.equal(getTrustProxy(), "xff");
    assert.equal(clientKey(req("127.0.0.1", headers)), "203.0.113.5");
    process.env.CG_TRUST_PROXY = "cloudflare";
    assert.equal(getTrustProxy(), "cloudflare");
    assert.equal(clientKey(req("127.0.0.1", headers)), "198.51.100.7");
    process.env.CG_TRUST_PROXY = "bogus";
    assert.equal(getTrustProxy(), "", "an unknown env value trusts nothing");
  } finally {
    delete process.env.CG_TRUST_PROXY;
  }
  saveSettings({ trustProxy: "cloudflare" });
  assert.equal(getTrustProxy(), "cloudflare");
  assert.equal(clientKey(req("127.0.0.1", headers)), "198.51.100.7", "the default argument reads the stored setting");
  saveSettings({ trustProxy: "xff" });
  assert.equal(clientKey(req("127.0.0.1", headers)), "203.0.113.5");
  saveSettings({ trustProxy: "" });
  assert.equal(clientKey(req("127.0.0.1", headers)), "127.0.0.1");
});

// ── createLoginLimiter ──────────────────────────────────────────────────────────
test("loginLimiter: free attempts, exponential backoff, cap", () => {
  const lim = createLoginLimiter({ freeAttempts: 2, baseDelayMs: 1000, maxDelayMs: 4000, ttlMs: 60_000 });
  const ip = "10.0.0.9";
  assert.equal(lim.retryAfterMs(ip, 0), 0); // unknown ip
  lim.recordFailure(ip, 0);
  assert.equal(lim.retryAfterMs(ip, 0), 0); // 1 failure < freeAttempts
  lim.recordFailure(ip, 0);
  assert.equal(lim.retryAfterMs(ip, 0), 1000); // 2 failures → base delay
  assert.equal(lim.retryAfterMs(ip, 1000), 0); // delay elapsed
  lim.recordFailure(ip, 1000);
  assert.equal(lim.retryAfterMs(ip, 1000), 2000); // 3 failures → doubled
  lim.recordFailure(ip, 1000);
  lim.recordFailure(ip, 1000);
  lim.recordFailure(ip, 1000);
  assert.equal(lim.retryAfterMs(ip, 1000), 4000); // capped at maxDelayMs
});

test("loginLimiter: success resets; entries expire after the TTL; IPs are independent", () => {
  const lim = createLoginLimiter({ freeAttempts: 1, baseDelayMs: 1000, maxDelayMs: 4000, ttlMs: 5000 });
  lim.recordFailure("a", 0);
  assert.equal(lim.retryAfterMs("a", 0), 1000);
  assert.equal(lim.retryAfterMs("b", 0), 0); // other IPs unaffected
  lim.recordSuccess("a");
  assert.equal(lim.retryAfterMs("a", 0), 0); // success clears the slate
  lim.recordFailure("a", 0);
  assert.equal(lim.retryAfterMs("a", 6000), 0); // pruned after ttlMs of quiet
  lim.recordFailure("a", 6000);
  assert.equal(lim.retryAfterMs("a", 6000), 1000); // and starts over from 1 failure
});

test("loginLimiter: a global failure cap bounds guessing from fresh keys, and drains with the window", () => {
  const lim = createLoginLimiter({ freeAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000, ttlMs: 60_000, globalMaxFailures: 5, globalWindowMs: 10_000 });
  // Each attempt from a never-seen key: per-key backoff never engages, the global count climbs.
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.retryAfterMs(`key-${i}`, i * 100), 0, `attempt ${i} is still free`);
    lim.recordFailure(`key-${i}`, i * 100);
  }
  // The cap is reached: the next fresh key waits — the maximum per-key delay, never more.
  assert.equal(lim.retryAfterMs("fresh", 500), 4000);
  // A known-good client is held too (it is the same scrypt the attacker is burning), and a key
  // with its own backoff gets the larger of the two waits.
  lim.recordFailure("slow", 500); lim.recordFailure("slow", 500); lim.recordFailure("slow", 500);
  assert.equal(lim.retryAfterMs("slow", 500), 4000);
  // As the window drains past the oldest failures, the hold lifts: eight failures were recorded
  // (t=0…400, then three at 500); the count drops back under 5 once the one at t=300 leaves the
  // window, at 10_300.
  assert.equal(lim.retryAfterMs("fresh", 10_000), 300);
  assert.equal(lim.retryAfterMs("fresh", 10_200), 100);
  assert.equal(lim.retryAfterMs("fresh", 10_300), 0);
  // The cap can be turned off, and its defaults are the documented 50 per 10 minutes.
  const open = createLoginLimiter({ freeAttempts: 3, globalMaxFailures: 0 });
  for (let i = 0; i < 200; i++) open.recordFailure(`k${i}`, 0);
  assert.equal(open.retryAfterMs("another", 0), 0);
  const dflt = createLoginLimiter();
  for (let i = 0; i < 49; i++) dflt.recordFailure(`k${i}`, 0);
  assert.equal(dflt.retryAfterMs("another", 0), 0);
  dflt.recordFailure("k49", 0);
  assert.equal(dflt.retryAfterMs("another", 0), 300_000);
  assert.equal(dflt.retryAfterMs("another", 600_000), 0);
});

// ── sanitizeMcpMatch ────────────────────────────────────────────────────────────
test("sanitizeMcpMatch: accepts only the two known shapes, drops extras", () => {
  assert.deepEqual(sanitizeMcpMatch({ serverUrl: "https://mcp.example.com/x" }), { serverUrl: "https://mcp.example.com/x" });
  assert.deepEqual(sanitizeMcpMatch({ serverName: "playwright" }), { serverName: "playwright" });
  assert.deepEqual(sanitizeMcpMatch({ serverUrl: "http://a.b", extra: "dropped" }), { serverUrl: "http://a.b" }); // unknown keys stripped
  assert.equal(sanitizeMcpMatch({ serverUrl: "file:///etc/passwd" }), null); // non-http(s) scheme
  assert.equal(sanitizeMcpMatch({ serverName: "   " }), null); // blank name
  assert.equal(sanitizeMcpMatch({ serverName: 42 }), null); // wrong type
  assert.equal(sanitizeMcpMatch("playwright"), null); // not an object
  assert.equal(sanitizeMcpMatch(["a"]), null); // arrays rejected
  assert.equal(sanitizeMcpMatch(null), null);
  assert.equal(sanitizeMcpMatch({}), null);
});

test("sanitizeCodexMcpSelection accepts only safe app groups and server identities", () => {
  assert.deepEqual(
    sanitizeCodexMcpSelection({
      id: "boost_space",
      name: "Boost.space",
      kind: "tool-group",
      serverName: "codex_apps",
      toolPrefix: "boost_space",
      tools: ["must.not.persist"],
    }),
    {
      id: "boost_space",
      name: "Boost.space",
      kind: "tool-group",
      serverName: "codex_apps",
      toolPrefix: "boost_space",
    },
  );
  assert.deepEqual(
    sanitizeCodexMcpSelection({
      id: "local-docs",
      name: "local-docs",
      kind: "server",
      serverName: "local-docs",
    }),
    {
      id: "local-docs",
      name: "local-docs",
      kind: "server",
      serverName: "local-docs",
    },
  );
  assert.equal(sanitizeCodexMcpSelection({ id: "github", name: "GitHub", kind: "tool-group", serverName: "other", toolPrefix: "github" }), null);
  assert.equal(sanitizeCodexMcpSelection({ id: "bad.id", name: "Bad", kind: "tool-group", serverName: "codex_apps", toolPrefix: "bad.id" }), null);
  assert.equal(sanitizeCodexMcpSelection({ id: "x", name: "X", kind: "server", serverName: 'x".enabled=true' }), null);
  assert.equal(sanitizeCodexMcpSelection({ id: "x", name: "X", kind: "unknown", serverName: "x" }), null);
  assert.equal(sanitizeCodexMcpSelection(null), null);
});

test("classifyAddress blocks CGN/special/benchmarking/reserved v4 and site-local/NAT64 v6", async () => {
  const { classifyAddress } = await import("../src/web/security.js");
  // 100.64/10 carrier-grade NAT (Alibaba metadata lives at 100.100.100.200)
  assert.match(classifyAddress("100.100.100.200"), /carrier-grade/);
  assert.match(classifyAddress("100.64.0.1"), /carrier-grade/);
  assert.match(classifyAddress("100.127.255.254"), /carrier-grade/);
  assert.equal(classifyAddress("100.128.0.1"), ""); // just outside /10 — public
  assert.match(classifyAddress("192.0.0.170"), /special/);
  assert.match(classifyAddress("198.18.0.1"), /benchmark/);
  assert.match(classifyAddress("198.19.255.1"), /benchmark/);
  assert.match(classifyAddress("255.255.255.255"), /reserved/);
  assert.match(classifyAddress("240.0.0.1"), /reserved/);
  assert.match(classifyAddress("fec0::1"), /site-local/);
  assert.match(classifyAddress("64:ff9b::7f00:1"), /NAT64/);
});
