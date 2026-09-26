// Placeholders and the header/query swap (src/gateway/egress/placeholders.js + rules.js). The swap
// is the one place a real credential re-enters traffic, so these pin the refusals as hard as the
// swaps: wrong host, wrong header, wrong position, canUse refusal, malformed Basic — each leaves
// the request bytes exactly as the container sent them.
//
// Real values are built at runtime (never a literal shaped like a provider token: the secret scan
// reads this file too).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  PLACEHOLDER_PREFIX, PLACEHOLDER_RE, mintPlaceholder, shapePlaceholder, findPlaceholders, corePlaceholder, placeholderScope,
} = await import("../src/gateway/egress/placeholders.js");
const {
  DEFAULT_SWAP_HEADERS, hostMatches, swapHeaders, swapRequest, placeholdersInRequest,
} = await import("../src/gateway/egress/rules.js");

const realValue = (label = "value") => `real-${label}-${crypto.randomBytes(12).toString("hex")}`;
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function grantFixture(overrides = {}) {
  return {
    placeholder: mintPlaceholder({ scope: "channel" }),
    value: realValue(),
    secretName: "GITHUB_TOKEN",
    scope: "channel",
    owner: "C_EGRESS",
    hosts: ["api.github.com"],
    headers: ["authorization"],
    format: "bearer",
    ...overrides,
  };
}

function resolverFor(...grants) {
  const map = new Map(grants.map((g) => [g.placeholder, g]));
  return (core) => map.get(core) || null;
}

const allowAll = () => ({ ok: true });

test("placeholders: format, scope letters, shape wrapper and detection", () => {
  for (const [scope, letter] of [["org", "o"], ["channel", "c"], ["personal", "p"], ["relay", "r"]]) {
    const ph = mintPlaceholder({ scope });
    assert.match(ph, new RegExp(`^${PLACEHOLDER_PREFIX}${letter}[a-z2-7]{32}$`));
    assert.equal(placeholderScope(ph), scope);
  }
  assert.throws(() => mintPlaceholder({ scope: "global" }), /unknown placeholder scope/);
  assert.notEqual(mintPlaceholder({ scope: "org" }), mintPlaceholder({ scope: "org" }));

  const shaped = shapePlaceholder({ scope: "relay", shape: "anthropic-oauth" });
  assert.ok(shaped.startsWith("sk-ant-oat01-cgph_r"));
  const core = corePlaceholder(shaped);
  assert.ok(core && core.startsWith("cgph_r"));
  assert.deepEqual(findPlaceholders(`Bearer ${shaped}`), [core]);
  // The whole shaped token is ONE match, so a swap replaces the wrapper too.
  const [match] = `x ${shaped} y`.matchAll(PLACEHOLDER_RE);
  assert.equal(match[0], shaped);
  assert.throws(() => shapePlaceholder({ scope: "relay", shape: "nope" }), /unknown placeholder shape/);

  const a = mintPlaceholder({ scope: "org" });
  const b = mintPlaceholder({ scope: "personal" });
  assert.deepEqual(findPlaceholders(`${a} and ${b} and ${a} again`), [a, b]);
  assert.deepEqual(findPlaceholders(`x${a}`), [], "a placeholder glued to an alphanumeric run is not a token");
  assert.deepEqual(findPlaceholders(`${a}Z`), []);
  assert.deepEqual(findPlaceholders(null), []);
  assert.equal(corePlaceholder(`${a} `), null);
});

test("hostMatches: exact names and one-level wildcards that never match the apex", () => {
  assert.equal(hostMatches("api.github.com", "api.github.com"), true);
  assert.equal(hostMatches("api.github.com", "API.GitHub.com."), true);
  assert.equal(hostMatches("api.github.com", "github.com"), false);
  assert.equal(hostMatches("*.vercel.app", "my-app.vercel.app"), true);
  assert.equal(hostMatches("*.vercel.app", "vercel.app"), false, "the apex is not covered by a wildcard");
  assert.equal(hostMatches("*.vercel.app", "a.b.vercel.app"), false, "one level only");
  assert.equal(hostMatches("*.vercel.app", "evilvercel.app"), false);
  assert.equal(hostMatches("", "x.com"), false);
  assert.ok(DEFAULT_SWAP_HEADERS.includes("authorization") && DEFAULT_SWAP_HEADERS.includes("x-vercel-token"));
});

test("swapHeaders: a bearer placeholder is swapped on the declared host", () => {
  const grant = grantFixture();
  const headers = { host: "api.github.com", authorization: `Bearer ${grant.placeholder}`, "user-agent": "gh" };
  const out = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(out.headers.authorization, `Bearer ${grant.value}`);
  assert.equal(headers.authorization, `Bearer ${grant.placeholder}`, "the input is never mutated");
  assert.deepEqual(out.swapped, [{ secretName: "GITHUB_TOKEN", scope: "channel", owner: "C_EGRESS" }]);
  assert.deepEqual(out.refused, []);
  assert.equal(out.scrub.get(grant.value), grant.placeholder);
  // GitHub's own `token` scheme is the same bearer position.
  const token = swapHeaders({ headers: { authorization: `token ${grant.placeholder}` }, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(token.headers.authorization, `token ${grant.value}`);
});

test("swapHeaders: another host gets the placeholder unchanged and the refusal is reported", () => {
  const grant = grantFixture();
  const headers = { host: "evil.example", authorization: `Bearer ${grant.placeholder}` };
  const out = swapHeaders({ headers, hostname: "evil.example", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(out.headers.authorization, `Bearer ${grant.placeholder}`);
  assert.deepEqual(out.swapped, []);
  assert.deepEqual(out.refused, [{ secretName: "GITHUB_TOKEN", reason: "host" }]);
  assert.equal(out.scrub.size, 0);
});

test("swapHeaders: wildcard hosts swap one level down, never on the apex", () => {
  const grant = grantFixture({ hosts: ["*.vercel.app"], headers: ["x-vercel-token"], format: "raw", secretName: "VERCEL_TOKEN" });
  const swap = (hostname) => swapHeaders({ headers: { "x-vercel-token": grant.placeholder }, hostname, resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(swap("preview.vercel.app").headers["x-vercel-token"], grant.value);
  assert.equal(swap("vercel.app").headers["x-vercel-token"], grant.placeholder);
  assert.equal(swap("a.b.vercel.app").headers["x-vercel-token"], grant.placeholder);
});

test("swapHeaders: basic-password swaps inside the decoded credential and re-encodes it", () => {
  const grant = grantFixture({ format: "basic-password", hosts: ["github.com"] });
  const headers = { authorization: `Basic ${b64(`x-access-token:${grant.placeholder}`)}` };
  const out = swapHeaders({ headers, hostname: "github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(out.headers.authorization, `Basic ${b64(`x-access-token:${grant.value}`)}`);
  assert.equal(out.swapped.length, 1);
  // The same placeholder in the USER half does not match a basic-password grant.
  const userHalf = swapHeaders({ headers: { authorization: `Basic ${b64(`${grant.placeholder}:x`)}` }, hostname: "github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(userHalf.headers.authorization, `Basic ${b64(`${grant.placeholder}:x`)}`);
  assert.deepEqual(userHalf.refused, [{ secretName: "GITHUB_TOKEN", reason: "format" }]);
  // basic-user is the mirror image.
  const userGrant = grantFixture({ format: "basic-user", hosts: ["github.com"] });
  const user = swapHeaders({ headers: { authorization: `Basic ${b64(`${userGrant.placeholder}:`)}` }, hostname: "github.com", resolveGrant: resolverFor(userGrant), canUse: allowAll });
  assert.equal(user.headers.authorization, `Basic ${b64(`${userGrant.value}:`)}`);
});

test("swapHeaders: canUse refusal leaves the header alone and carries the reason", () => {
  const grant = grantFixture({ scope: "personal", owner: "U_OWNER" });
  const headers = { authorization: `Bearer ${grant.placeholder}` };
  const out = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: () => ({ ok: false, reason: "owner-not-live" }) });
  assert.equal(out.headers.authorization, `Bearer ${grant.placeholder}`);
  assert.deepEqual(out.refused, [{ secretName: "GITHUB_TOKEN", reason: "owner-not-live", denied: true }]);
  // A throwing canUse is a refusal, never an exception.
  const thrown = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: () => { throw new Error("boom"); } });
  assert.equal(thrown.headers.authorization, `Bearer ${grant.placeholder}`);
  assert.equal(thrown.refused[0].reason, "denied");
});

test("swapHeaders: a placeholder in a header its grant does not list is left alone", () => {
  const grant = grantFixture();
  const headers = { "x-debug": grant.placeholder, cookie: `session=${grant.placeholder}` };
  const out = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.deepEqual(out.headers, headers);
  assert.deepEqual(out.swapped, []);
  assert.deepEqual(out.refused, [{ secretName: "GITHUB_TOKEN", reason: "header" }]);
  // Without an explicit list the grant accepts DEFAULT_SWAP_HEADERS only.
  const loose = grantFixture({ headers: undefined, format: "raw" });
  const viaDefault = swapHeaders({ headers: { "x-api-key": loose.placeholder, "x-other": loose.placeholder }, hostname: "api.github.com", resolveGrant: resolverFor(loose), canUse: allowAll });
  assert.equal(viaDefault.headers["x-api-key"], loose.value);
  assert.equal(viaDefault.headers["x-other"], loose.placeholder);
});

test("swapHeaders: malformed Basic credentials and odd values never throw and stay untouched", () => {
  const grant = grantFixture({ format: "basic-password" });
  const cases = [
    "Basic !!!not-base64!!!",
    `Basic ${b64("no-colon-here")}`,
    "Basic",
    `Basic ${b64(`u:${grant.placeholder}`).slice(0, -3)}`,
  ];
  for (const value of cases) {
    const out = swapHeaders({ headers: { authorization: value }, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
    assert.equal(out.headers.authorization, value, value);
    assert.deepEqual(out.swapped, []);
  }
  const weird = swapHeaders({ headers: { authorization: undefined, "x-api-key": ["a", grant.placeholder] }, hostname: "api.github.com", resolveGrant: () => { throw new Error("db down"); }, canUse: allowAll });
  assert.equal(weird.headers.authorization, undefined);
  assert.deepEqual(weird.headers["x-api-key"], ["a", grant.placeholder]);
  assert.deepEqual(weird.refused, [{ secretName: null, reason: "unknown-placeholder" }]);
});

test("swapHeaders: never a partial swap, never a header-breaking value, never across a Host mismatch", () => {
  const good = grantFixture({ format: ["basic-user", "basic-password"], secretName: "A" });
  const bad = grantFixture({ format: "basic-password", hosts: ["elsewhere.example"], secretName: "B" });
  const both = `Basic ${b64(`${good.placeholder}:${bad.placeholder}`)}`;
  const partial = swapHeaders({ headers: { authorization: both }, hostname: "api.github.com", resolveGrant: resolverFor(good, bad), canUse: allowAll });
  assert.equal(partial.headers.authorization, both, "one refused half keeps the whole header");
  assert.deepEqual(partial.swapped, []);
  assert.deepEqual(partial.refused.map((r) => r.reason).sort(), ["host", "partial"]);
  assert.equal(partial.scrub.size, 0);

  const crlf = grantFixture({ value: "line1\r\nX-Injected: yes", format: "raw", headers: ["x-api-key"] });
  const injected = swapHeaders({ headers: { "x-api-key": crlf.placeholder }, hostname: "api.github.com", resolveGrant: resolverFor(crlf), canUse: allowAll });
  assert.equal(injected.headers["x-api-key"], crlf.placeholder);
  assert.deepEqual(injected.refused, [{ secretName: "GITHUB_TOKEN", reason: "invalid-value" }]);

  const grant = grantFixture();
  const fronted = swapHeaders({ headers: { host: "evil.example", authorization: `Bearer ${grant.placeholder}` }, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(fronted.headers.authorization, `Bearer ${grant.placeholder}`);
  assert.equal(fronted.refused[0].reason, "host-header-mismatch");
  const withPort = swapHeaders({ headers: { host: "api.github.com:443", authorization: `Bearer ${grant.placeholder}` }, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(withPort.headers.authorization, `Bearer ${grant.value}`);

  const embedded = swapHeaders({ headers: { authorization: `Bearer ${grant.placeholder} extra` }, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(embedded.headers.authorization, `Bearer ${grant.placeholder} extra`);
  assert.equal(embedded.refused[0].reason, "format");
});

test("swapHeaders: plain http swaps only grants that opt in", () => {
  const grant = grantFixture();
  const headers = { authorization: `Bearer ${grant.placeholder}` };
  const refused = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll, plainHttp: true });
  assert.equal(refused.headers.authorization, headers.authorization);
  assert.equal(refused.refused[0].reason, "plain-http");
  const optIn = { ...grant, plainHttp: true };
  const ok = swapHeaders({ headers, hostname: "api.github.com", resolveGrant: resolverFor(optIn), canUse: allowAll, plainHttp: true });
  assert.equal(ok.headers.authorization, `Bearer ${grant.value}`);
});

test("swapRequest: query parameters swap only when the grant lists them", () => {
  const grant = grantFixture({ query: ["token"], value: "va lue&=x" });
  const path = `/v1/items?token=${grant.placeholder}&other=${grant.placeholder}#frag`;
  const out = swapRequest({ headers: {}, path, hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(out.path, `/v1/items?token=${encodeURIComponent(grant.value)}&other=${grant.placeholder}#frag`);
  assert.deepEqual(out.refused, [{ secretName: "GITHUB_TOKEN", reason: "query" }]);
  assert.equal(out.swapped.length, 1);
  assert.equal(swapRequest({ headers: {}, path: "/%E0%A4%A?x=1", hostname: "api.github.com", resolveGrant: resolverFor(grant), canUse: allowAll }).path, "/%E0%A4%A?x=1");
  assert.deepEqual(
    placeholdersInRequest({ headers: { authorization: `Basic ${b64(`u:${grant.placeholder}`)}` }, path: `/x?token=${grant.placeholder}` }),
    [grant.placeholder],
  );
});
