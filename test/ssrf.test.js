import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { classifyAddress, assertPublicHttpUrl } = await import("../src/web/security.js");

// The run API fetches a caller-supplied fileUrl and POSTs to a caller-supplied webhook, both from
// inside the host. Scheme was the only check, which made it a proxy into everything the daemon can
// reach — the gateway's own admin API on loopback, private hosts, cloud metadata. Worse for
// fileUrl: the bytes are handed to an agent that will summarize them straight into Slack.

const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address }));

test("classifyAddress names the address ranges that must never be reached", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback", "IPv4-mapped IPv6 must not slip through");
  assert.equal(classifyAddress("10.1.2.3"), "private");
  assert.equal(classifyAddress("192.168.1.1"), "private");
  assert.equal(classifyAddress("172.16.0.1"), "private");
  assert.equal(classifyAddress("172.31.255.255"), "private");
  assert.equal(classifyAddress("169.254.169.254"), "link-local / cloud metadata");
  assert.equal(classifyAddress("fd00::1"), "private");
});

test("classifyAddress leaves genuinely public addresses alone", () => {
  // 172.15 and 172.32 sit just outside the /12 — a prefix match would wrongly block them.
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(classifyAddress(ip), "", `${ip} is public and must be allowed`);
  }
});

test("a literal internal address is refused without touching DNS", async () => {
  let resolved = false;
  const lookup = async () => {
    resolved = true;
    return [];
  };
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1:4747/api/settings", { lookup }), /loopback/);
  await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/", { lookup }), /metadata/);
  assert.equal(resolved, false, "a literal address needs no resolver");
});

test("localhost by name is refused", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://localhost:4747/", { lookup: lookupTo("8.8.8.8") }), /loopback/);
});

test("a PUBLIC hostname that resolves to an internal address is refused", async () => {
  // The attack the hostname-only check misses entirely.
  await assert.rejects(
    () => assertPublicHttpUrl("https://totally-normal.example/", { lookup: lookupTo("127.0.0.1") }),
    /resolves to a loopback address/,
  );
});

test("every resolved address must be public, not just the first", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl("https://mixed.example/", { lookup: lookupTo("8.8.8.8", "10.0.0.5") }),
    /private/,
  );
});

test("non-http schemes are refused", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
    await assert.rejects(() => assertPublicHttpUrl(url, { lookup: lookupTo("8.8.8.8") }), /http\(s\)/);
  }
});

test("a genuinely public URL passes and comes back parsed", async () => {
  const url = await assertPublicHttpUrl("https://hooks.example.com/abc?x=1", { lookup: lookupTo("93.184.216.34") });
  assert.equal(url.hostname, "hooks.example.com");
  assert.equal(url.pathname, "/abc");
});

test("an unresolvable host is refused rather than attempted", async () => {
  const lookup = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(() => assertPublicHttpUrl("https://nope.invalid/", { lookup }), /could not resolve/);
});

test("malformed input is refused", async () => {
  await assert.rejects(() => assertPublicHttpUrl("not a url", { lookup: lookupTo("8.8.8.8") }), /not a valid URL/);
});
