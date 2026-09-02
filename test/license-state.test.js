// The licensing state machine (src/ee/license.js), driven by an explicit clock.
//
// resolveLicenseState() is a pure function of (is there a key?, the cached verification, the last
// check's outcome, now). That is deliberate: the interesting transitions are fourteen days and a
// month apart, and a feature whose correctness can only be observed by waiting is a feature nobody
// verifies. Everything below is one function call at a chosen instant.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { resolveLicenseState, nextUtcMonthStart, utcMonth, LICENSE_STATES, bannerFor } = await import("../src/ee/license.js");
const { NO_KEY_LIMITS, GRACE_MS } = await import("../src/ee/tiers.js");

const NO_KEY = { conversations: 1, messagesPerConversationPerMonth: 500 };
const FREE = { conversations: null, messagesPerConversationPerMonth: 500 };
const ENTERPRISE = { conversations: null, messagesPerConversationPerMonth: null };

const at = (iso) => Date.parse(iso);
const cacheOf = (tier, limits, verifiedAt, expiresAt = null) => ({
  license: { tier, limits, organization: "Acme", keyId: "k1", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt },
  signature: "sig",
  verifiedAt,
  keyHash: "hash",
});
const checked = (outcome, atIso) => ({ outcome, at: atIso, detail: "", keyHash: "hash" });

test("no key is the no-key tier", () => {
  const r = resolveLicenseState({ keyPresent: false, cache: null, lastCheck: null, now: at("2026-06-10T00:00:00Z") });
  assert.equal(r.state, "no_key");
  assert.deepEqual(r.limits, NO_KEY);
  assert.deepEqual(NO_KEY_LIMITS, NO_KEY, "the compiled-in default is the published no-key tier");
  assert.equal(bannerFor(r), null, "an unlicensed install is a healthy state, not a warning");
});

test("a key that has never been verified is grace on the no-key limits", () => {
  // A first boot behind a proxy outage must not be a lockout — but it also cannot be handed a tier
  // it has never proved, so the limits stay at the floor while the banner explains itself.
  const r = resolveLicenseState({ keyPresent: true, cache: null, lastCheck: checked("unreachable", "2026-06-10T00:00:00Z"), now: at("2026-06-10T00:01:00Z") });
  assert.equal(r.state, "grace");
  assert.deepEqual(r.limits, NO_KEY);
  assert.equal(bannerFor(r).level, "warn");
  assert.match(bannerFor(r).text, /not been verified yet/);
});

test("a fresh successful verification is valid on the payload's limits", () => {
  const r = resolveLicenseState({
    keyPresent: true,
    cache: cacheOf("free", FREE, "2026-06-10T00:00:00Z"),
    lastCheck: checked("verified", "2026-06-10T00:00:00Z"),
    now: at("2026-06-10T00:00:01Z"),
  });
  assert.equal(r.state, "valid");
  assert.deepEqual(r.limits, FREE);
  assert.equal(bannerFor(r), null, "a verified install carries no banner");
});

test("invalid and revoked drop to the no-key limits immediately, with a banner", () => {
  const cache = cacheOf("enterprise", ENTERPRISE, "2026-06-10T00:00:00Z");
  for (const [outcome, state] of [["invalid", "invalid"], ["revoked", "revoked"]]) {
    const r = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked(outcome, "2026-06-11T00:00:00Z"), now: at("2026-06-11T00:00:01Z") });
    assert.equal(r.state, state);
    // The platform positively said the key is not valid — that is a §3.2 statement, not a network
    // hiccup, so the month-boundary courtesy of the grace path does not apply.
    assert.deepEqual(r.limits, NO_KEY);
    assert.equal(bannerFor(r).level, "error");
  }
});

test("unreachable within 14 days keeps the last verified tier", () => {
  const verifiedAt = "2026-06-01T00:00:00Z";
  const cache = cacheOf("enterprise", ENTERPRISE, verifiedAt);
  for (const days of [0, 1, 7, 13.9]) {
    const now = at(verifiedAt) + days * 24 * 60 * 60 * 1000;
    const r = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now });
    assert.equal(r.state, "grace", `day ${days}`);
    assert.deepEqual(r.limits, ENTERPRISE, `day ${days} keeps the tier`);
  }
  assert.equal(GRACE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("past 14 days the tier is STILL kept until the next UTC month boundary", () => {
  // docs/LICENSE-KEYS.md: "it falls back to the no-key limits at the start of the next calendar
  // month — never mid-month, never silently."
  const verifiedAt = "2026-06-01T00:00:00Z"; // grace ends 2026-06-15
  const cache = cacheOf("enterprise", ENTERPRISE, verifiedAt);
  const r = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2026-06-20T12:00:00Z") });
  assert.equal(r.state, "expired_grace");
  assert.equal(r.fellBack, false);
  assert.deepEqual(r.limits, ENTERPRISE, "still the last tier — the drop is not allowed mid-month");
  assert.equal(r.graceEndedAt, "2026-06-15T00:00:00.000Z");
  assert.equal(r.fallbackAt, "2026-07-01T00:00:00.000Z");
  assert.match(bannerFor(r).text, /kept until the start of the next UTC month/);
});

test("at the month boundary the fallback to the no-key limits lands", () => {
  const verifiedAt = "2026-06-01T00:00:00Z";
  const cache = cacheOf("enterprise", ENTERPRISE, verifiedAt);
  const justBefore = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2026-06-30T23:59:59Z") });
  assert.deepEqual(justBefore.limits, ENTERPRISE);
  assert.equal(justBefore.fellBack, false);

  const justAfter = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2026-07-01T00:00:00Z") });
  assert.equal(justAfter.state, "expired_grace");
  assert.equal(justAfter.fellBack, true);
  assert.deepEqual(justAfter.limits, NO_KEY);
  assert.match(bannerFor(justAfter).text, /no-key limits are now in force/);
});

test("grace that ends inside a month waits for the NEXT month, not the current one", () => {
  // Verified on the 25th → grace ends on the 9th of the following month → the fallback lands on
  // the 1st of the month after that. The rule is "the month grace ran out in gets to finish".
  const verifiedAt = "2026-06-25T00:00:00Z"; // grace ends 2026-07-09
  const cache = cacheOf("free", FREE, verifiedAt);
  const inJuly = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2026-07-31T23:00:00Z") });
  assert.equal(inJuly.fellBack, false);
  assert.deepEqual(inJuly.limits, FREE);
  const inAugust = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2026-08-01T00:00:00Z") });
  assert.equal(inAugust.fellBack, true);
  assert.deepEqual(inAugust.limits, NO_KEY);
});

test("a cached license past its expiresAt cannot stay valid", () => {
  const cache = cacheOf("enterprise", ENTERPRISE, "2026-06-10T00:00:00Z", "2026-06-09T00:00:00Z");
  const r = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("verified", "2026-06-10T00:00:00Z"), now: at("2026-06-10T01:00:00Z") });
  assert.notEqual(r.state, "valid");
  assert.equal(r.state, "grace", "an expired payload falls into the unreachable lane, which still honours the month boundary");
});

test("a December verification rolls the fallback into the next YEAR", () => {
  const verifiedAt = "2026-12-20T00:00:00Z"; // grace ends 2027-01-03
  assert.equal(new Date(nextUtcMonthStart(at("2026-12-20T00:00:00Z"))).toISOString(), "2027-01-01T00:00:00.000Z");
  const cache = cacheOf("free", FREE, verifiedAt);
  const inJanuary = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2027-01-15T00:00:00Z") });
  assert.equal(inJanuary.fellBack, false);
  const inFebruary = resolveLicenseState({ keyPresent: true, cache, lastCheck: checked("unreachable", verifiedAt), now: at("2027-02-01T00:00:00Z") });
  assert.equal(inFebruary.fellBack, true);
});

test("the month key is UTC, not the daemon's local zone", () => {
  // 23:30 on 31 December in UTC+13 is already January locally; the ledger must not agree.
  assert.equal(utcMonth(at("2026-12-31T23:30:00Z")), "2026-12");
  assert.equal(utcMonth(at("2027-01-01T00:00:00Z")), "2027-01");
});

test("every reachable state is a declared one", () => {
  const cases = [
    { keyPresent: false, cache: null, lastCheck: null },
    { keyPresent: true, cache: null, lastCheck: checked("unreachable", "2026-06-01T00:00:00Z") },
    { keyPresent: true, cache: cacheOf("free", FREE, "2026-06-01T00:00:00Z"), lastCheck: checked("verified", "2026-06-01T00:00:00Z") },
    { keyPresent: true, cache: null, lastCheck: checked("invalid", "2026-06-01T00:00:00Z") },
    { keyPresent: true, cache: null, lastCheck: checked("revoked", "2026-06-01T00:00:00Z") },
    { keyPresent: true, cache: cacheOf("free", FREE, "2026-06-01T00:00:00Z"), lastCheck: checked("unreachable", "2026-06-20T00:00:00Z") },
  ];
  const seen = new Set(cases.map((c) => resolveLicenseState({ ...c, now: at("2026-07-05T00:00:00Z") }).state));
  for (const state of seen) assert.ok(LICENSE_STATES.includes(state), `${state} must be declared`);
  // …and every declared state is reachable, so the list cannot rot into a superset of reality.
  assert.deepEqual([...seen].sort(), [...LICENSE_STATES].sort());
});
