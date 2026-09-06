// The two enforcement points (src/ee/limits.js): conversation admission and the monthly cap.
//
// This is the file that decides whether an unlicensed install is usable-but-limited or simply
// broken, so it covers all four tiers of state the acceptance criteria name: no key, free key,
// enterprise key, and the runs that must never be counted at all.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, makeTestLicense, signTestLicense, testLicenseEnv, testLicensePublicKeyPem } from "./helpers.js";

ensureTestEnv();
const {
  licenseAdmission,
  resetLicenseUsage,
  conversationUsage,
  usageTotals,
  isExemptRun,
  WARN_AT,
} = await import("../src/ee/limits.js");
const { getEffectiveLimits, getLicenseStatus, utcMonth, resetLicenseAnnouncements } = await import("../src/ee/license.js");
const { saveSettings } = await import("../src/config/settings.js");
const { signupUrl } = await import("../src/ee/tiers.js");

// Install a tier for the duration of one test. The offline payload is the same signed artefact a
// real air-gapped enterprise install runs on — no check is stubbed out.
function tier(kind) {
  resetLicenseUsage();
  resetLicenseAnnouncements();
  saveSettings({ licenseKey: "" });
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  if (kind === "none") {
    clearTestLicense();
    return;
  }
  const limits = kind === "free"
    ? { conversations: null, messagesPerConversationPerMonth: 500 }
    : { conversations: null, messagesPerConversationPerMonth: null };
  testLicenseEnv({ tier: kind === "free" ? "free" : "enterprise", limits });
}

const admit = (id, origin = "slack_foreground") => licenseAdmission({ conversationId: id, origin });

test("no key: the first conversation of the month is served and every other one is refused", () => {
  tier("none");
  assert.deepEqual(getEffectiveLimits(), { conversations: 1, messagesPerConversationPerMonth: 500 });

  const first = admit("C_FIRST");
  assert.equal(first.allowed, true);
  assert.equal(first.runs, 1);

  const second = admit("C_SECOND");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "conversation_limit");
  assert.match(second.notice, /limited to 1 conversation without a license key/);
  assert.match(second.notice, /get a free key at /);
  assert.ok(second.notice.includes(signupUrl()), "the notice always carries the way out");

  // The allowed conversation keeps working, and the refusal is stable rather than first-come per
  // message — the admitted set is persisted, so a restart cannot hand the allowance to somebody
  // else mid-month.
  assert.equal(admit("C_FIRST").allowed, true);
  assert.equal(admit("C_SECOND").allowed, false);
  assert.equal(admit("C_THIRD").allowed, false);

  const rows = conversationUsage();
  assert.equal(rows.find((r) => r.conversationId === "C_FIRST").admitted, true);
  assert.equal(rows.find((r) => r.conversationId === "C_SECOND").admitted, false);
  assert.equal(rows.find((r) => r.conversationId === "C_SECOND").runs, 0, "a refused conversation never accrues runs");
});

test("a refused turn is a reply, never an exception and never silence", () => {
  tier("none");
  admit("C_ONLY");
  const refused = admit("C_OTHER");
  assert.equal(refused.allowed, false);
  assert.ok(refused.notice.length > 40, "the notice has to explain itself on its own");
  assert.ok(!/undefined|null|NaN/.test(refused.notice));
});

test("a free key unlocks every conversation and keeps the 500-message cap", () => {
  tier("free");
  assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: 500 });
  for (const id of ["C_A", "C_B", "C_C", "gchat:spaces/X", "teams:19:abc@thread.tacv2"]) {
    assert.equal(admit(id).allowed, true, `${id} should be admitted on a free key`);
  }
  assert.equal(usageTotals().conversations, 5);
});

test("the monthly cap refuses at the limit and warns exactly once at 80%", () => {
  tier("free");
  const cap = 500;
  const warnAt = Math.ceil(cap * WARN_AT);
  assert.equal(warnAt, 400);

  let warnings = 0;
  let firstWarningAt = 0;
  for (let i = 1; i <= cap; i++) {
    const result = admit("C_BUSY");
    assert.equal(result.allowed, true, `run ${i} should be admitted`);
    if (result.warning) {
      warnings++;
      firstWarningAt = firstWarningAt || i;
      assert.match(result.warning, new RegExp(`${i} of its ${cap} AI messages`));
    }
  }
  assert.equal(firstWarningAt, warnAt, "the warning fires the first time the run count reaches 80%");
  assert.equal(warnings, 1, "and exactly once for the month");

  const overCap = admit("C_BUSY");
  assert.equal(overCap.allowed, false);
  assert.equal(overCap.reason, "monthly_cap");
  assert.match(overCap.notice, /used all 500 AI messages/);
  assert.match(overCap.notice, /resets at the start of the next UTC month/);
  assert.equal(conversationUsage().find((r) => r.conversationId === "C_BUSY").runs, cap, "a refused run is not counted");

  // A different conversation on the same key is unaffected — the cap is per conversation.
  assert.equal(admit("C_QUIET").allowed, true);
});

test("an enterprise key never limits anything", () => {
  tier("enterprise");
  assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: null });
  for (let i = 0; i < 60; i++) assert.equal(admit(`C_${i}`).allowed, true);
  for (let i = 0; i < 600; i++) {
    const result = admit("C_HOT");
    assert.equal(result.allowed, true);
    assert.equal(result.warning, "", "there is no 80% of unlimited");
  }
  assert.equal(conversationUsage({ limit: 1 })[0].runs, 600, "usage is still counted, just never enforced");
});

test("memory-review runs are exempt by origin and by toolset", () => {
  tier("none");
  assert.equal(admit("C_ONLY").allowed, true);

  // The reviewer runs against a conversation that is NOT in the allowed set and must still run:
  // it is the deployment talking to itself about a conversation that already happened.
  const byOrigin = licenseAdmission({ conversationId: "C_ELSEWHERE", origin: "memory_review" });
  assert.equal(byOrigin.allowed, true);
  assert.equal(byOrigin.exempt, true);
  const byToolset = licenseAdmission({ conversationId: "C_ELSEWHERE", origin: "background_agent", toolset: "memory-review" });
  assert.equal(byToolset.allowed, true);
  assert.equal(byToolset.exempt, true);

  assert.equal(isExemptRun({ origin: "memory_review" }), true);
  assert.equal(isExemptRun({ origin: "slack_foreground", toolset: "full" }), false);

  // And they leave no trace in the ledger, so they can never consume somebody's allowance.
  assert.equal(conversationUsage().some((r) => r.conversationId === "C_ELSEWHERE"), false);
});

test("every non-exempt origin counts", () => {
  tier("enterprise");
  for (const origin of ["slack_foreground", "api_foreground", "schedule", "background_agent", "continuation", "recovery", "diagnosis"]) {
    assert.equal(admit("C_ALL_ORIGINS", origin).allowed, true);
  }
  assert.equal(conversationUsage().find((r) => r.conversationId === "C_ALL_ORIGINS").runs, 7);
});

test("the ledger is keyed on the UTC month, so a new month is a clean slate", () => {
  tier("none");
  const thisMonth = utcMonth();
  admit("C_JUNE");
  assert.equal(admit("C_JULY").allowed, false, "still the same month");

  // Next month: nothing is admitted yet, so the first conversation to speak wins again.
  const nextMonthMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2);
  const next = licenseAdmission({ conversationId: "C_JULY", origin: "slack_foreground", now: nextMonthMs });
  assert.equal(next.allowed, true);
  assert.notEqual(next.month, thisMonth);
  // …and the previous month's ledger is untouched.
  assert.equal(conversationUsage({ month: thisMonth }).find((r) => r.conversationId === "C_JUNE").runs, 1);
});

test("an empty conversation id is never charged to anybody", () => {
  tier("none");
  const result = licenseAdmission({ conversationId: "", origin: "slack_foreground" });
  assert.equal(result.allowed, true);
  assert.equal(usageTotals().conversations, 0);
});

test("an EXPIRED offline payload grants nothing — the no-key limits, immediately", () => {
  // The live failure (QA OPS-11): an air-gapped enterprise payload whose `expiresAt` had passed
  // weeks earlier still resolved to tier `enterprise` with unlimited conversations, and admission
  // let every conversation through. An offline payload is stamped verifiedAt = READ time, so it
  // always looks freshly verified; routing an expired one into the "platform unreachable" grace
  // lane therefore meant `now < verifiedAt + 14 days` was true forever. It now fails closed.
  resetLicenseUsage();
  resetLicenseAnnouncements();
  saveSettings({ licenseKey: "" });
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  testLicenseEnv({
    tier: "enterprise",
    limits: { conversations: null, messagesPerConversationPerMonth: null },
    expiresAt: "2020-01-01T00:00:00.000Z",
  });

  const status = getLicenseStatus();
  assert.equal(status.state, "expired");
  assert.notEqual(status.tier, "enterprise", "a dead licence does not report the tier it was sold as");
  assert.equal(status.expiresAt, "2020-01-01T00:00:00.000Z", "…while still saying when it ran out");
  assert.equal(status.banner.level, "error");

  assert.deepEqual(getEffectiveLimits(), { conversations: 1, messagesPerConversationPerMonth: 500 });
  assert.equal(admit("C_EXPIRED_FIRST").allowed, true, "the free allowance still works");
  const second = admit("C_EXPIRED_SECOND");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "conversation_limit");

  // The identical payload with a FUTURE expiry is the enterprise tier it always was — the fix
  // turns on the date, not on the payload being offline.
  resetLicenseUsage();
  resetLicenseAnnouncements();
  testLicenseEnv({
    tier: "enterprise",
    limits: { conversations: null, messagesPerConversationPerMonth: null },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(getLicenseStatus().state, "valid");
  assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: null });
  assert.equal(admit("C_STILL_VALID_1").allowed, true);
  assert.equal(admit("C_STILL_VALID_2").allowed, true);
});
