// Signature verification and the platform round trip (src/ee/license.js).
//
// The public key is the whole trust boundary: a response that does not verify against it must
// change NOTHING, in either direction. A forged upgrade and a forged downgrade are the same bug.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { ensureTestEnv, clearTestLicense, makeTestLicense, signTestLicense, testCanonicalJson, testLicenseKeyPair, testLicensePublicKeyPem } from "./helpers.js";

ensureTestEnv();
const { canonicalJson } = await import("../src/ee/tiers.js");
const {
  verifySignature,
  isWellFormedLicense,
  verifyLicense,
  readCache,
  getLicenseStatus,
  getEffectiveLimits,
  resetLicenseAnnouncements,
  offlineLicense,
} = await import("../src/ee/license.js");
const { buildUsageReport, resetLicenseUsage, licenseAdmission } = await import("../src/ee/limits.js");
const { saveSettings } = await import("../src/config/settings.js");
const { metaSet } = await import("../src/db/index.js");

// Every test in this file drives the NETWORK path, so the offline payload the scratch environment
// installs has to be out of the way (it deliberately short-circuits verification).
function networkMode() {
  delete process.env.CHANNELGATE_LICENSE_PAYLOAD;
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  process.env.CHANNELGATE_LICENSE_KEY = "cg-net-key";
  saveSettings({ licenseKey: "" });
  metaSet("license_cache", "");
  metaSet("license_last_check", "");
  resetLicenseAnnouncements();
}

const okResponse = (license, signature) => ({
  status: 200,
  json: async () => ({ ok: true, license, signature }),
});

test("canonical JSON sorts keys recursively and emits no whitespace", () => {
  const value = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } };
  assert.equal(canonicalJson(value), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  // Arrays keep their order — order is data, not formatting.
  assert.equal(canonicalJson([2, 1]), "[2,1]");
  // Two objects that differ only in key order sign identically.
  assert.equal(canonicalJson({ x: 1, y: 2 }), canonicalJson({ y: 2, x: 1 }));
  // …and the test's own independent encoder agrees, so encoder drift is caught.
  assert.equal(canonicalJson(value), testCanonicalJson(value));
});

test("a correctly signed license verifies", () => {
  const license = makeTestLicense({ tier: "free", limits: { conversations: null, messagesPerConversationPerMonth: 500 } });
  assert.equal(verifySignature(license, signTestLicense(license), testLicensePublicKeyPem()), true);
});

test("a tampered license does not verify", () => {
  const license = makeTestLicense({ tier: "free", limits: { conversations: null, messagesPerConversationPerMonth: 500 } });
  const signature = signTestLicense(license);
  const tampered = { ...license, tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } };
  assert.equal(verifySignature(tampered, signature, testLicensePublicKeyPem()), false);
  // Even a change the JSON encoder would normalize away is caught.
  assert.equal(verifySignature({ ...license, organization: "Someone Else" }, signature, testLicensePublicKeyPem()), false);
});

test("a garbage signature does not verify and does not throw", () => {
  const license = makeTestLicense();
  assert.equal(verifySignature(license, "not-base64url-at-all!!", testLicensePublicKeyPem()), false);
  assert.equal(verifySignature(license, "", testLicensePublicKeyPem()), false);
  assert.equal(verifySignature(license, null, testLicensePublicKeyPem()), false);
  // A well-formed signature of the WRONG length is refused before it reaches the crypto layer.
  assert.equal(verifySignature(license, Buffer.alloc(63).toString("base64url"), testLicensePublicKeyPem()), false);
  assert.equal(verifySignature(null, signTestLicense(license), testLicensePublicKeyPem()), false);
});

test("a signature from a different keypair does not verify", () => {
  const other = generateKeyPairSync("ed25519");
  const license = makeTestLicense();
  const foreign = signTestLicense(license, other.privateKey);
  assert.equal(verifySignature(license, foreign, testLicensePublicKeyPem()), false);
  // …and the real signature does not verify against the foreign public key either.
  assert.equal(
    verifySignature(license, signTestLicense(license), other.publicKey.export({ type: "spki", format: "pem" })),
    false,
  );
});

test("a malformed public key is a refusal, not a crash", () => {
  const license = makeTestLicense();
  assert.equal(verifySignature(license, signTestLicense(license), "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n"), false);
});

test("an unknown tier is refused even with a valid signature", () => {
  // Signature and shape are independent checks on purpose: an unrecognised tier carrying an
  // unlimited limits blob must never be interpreted as "probably fine".
  assert.equal(isWellFormedLicense(makeTestLicense({ tier: "platinum" })), false);
  assert.equal(isWellFormedLicense(makeTestLicense({ keyId: "" })), false);
  assert.equal(isWellFormedLicense(null), false);
  assert.equal(isWellFormedLicense(makeTestLicense({ tier: "free" })), true);
});

test("a 200 with a good signature is cached and becomes the valid state", async () => {
  networkMode();
  const license = makeTestLicense({ tier: "free", limits: { conversations: null, messagesPerConversationPerMonth: 500 } });
  const sent = [];
  const result = await verifyLicense({
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return okResponse(license, signTestLicense(license));
    },
  });
  assert.equal(result.outcome, "verified");
  assert.equal(getLicenseStatus().state, "valid");
  assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: 500 });
  assert.equal(readCache().license.tier, "free");

  // The request payload is exactly the three documented fields — never the workspace, the
  // channels, or anything identifying.
  assert.match(sent[0].url, /\/v1\/license\/verify$/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["installationId", "key", "version"]);
  assert.equal(sent[0].body.key, "cg-net-key");
  assert.match(sent[0].body.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a 200 whose signature does not verify changes nothing", async () => {
  networkMode();
  const good = makeTestLicense({ tier: "free", limits: { conversations: null, messagesPerConversationPerMonth: 500 } });
  await verifyLicense({ fetchImpl: async () => okResponse(good, signTestLicense(good)) });
  assert.equal(getLicenseStatus().state, "valid");

  const forged = makeTestLicense({ tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } });
  const result = await verifyLicense({ fetchImpl: async () => okResponse(forged, signTestLicense(forged, generateKeyPairSync("ed25519").privateKey)) });

  // Not cached, not `invalid` either: an unauthenticated response is evidence of nothing, so the
  // deployment keeps the tier it last proved and goes into grace.
  assert.equal(result.outcome, "unreachable");
  assert.equal(readCache().license.tier, "free");
  assert.equal(getLicenseStatus().state, "grace");
  assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: 500 });
});

test("401 is invalid_key, 403 is revoked, and both drop to the no-key limits", async () => {
  networkMode();
  const r401 = await verifyLicense({ fetchImpl: async () => ({ status: 401, json: async () => ({ ok: false, error: "invalid_key" }) }) });
  assert.equal(r401.outcome, "invalid");
  assert.equal(getLicenseStatus().state, "invalid");
  assert.deepEqual(getEffectiveLimits(), { conversations: 1, messagesPerConversationPerMonth: 500 });

  const r403 = await verifyLicense({ fetchImpl: async () => ({ status: 403, json: async () => ({ ok: false, error: "revoked" }) }) });
  assert.equal(r403.outcome, "revoked");
  assert.equal(getLicenseStatus().state, "revoked");
  assert.deepEqual(getEffectiveLimits(), { conversations: 1, messagesPerConversationPerMonth: 500 });
});

test("a network error or an unexpected status is unreachable, never a throw", async () => {
  networkMode();
  for (const fetchImpl of [
    async () => { throw new Error("ECONNREFUSED"); },
    async () => ({ status: 500, json: async () => ({}) }),
    async () => ({ status: 200, json: async () => ({ ok: false }) }),
  ]) {
    const result = await verifyLicense({ fetchImpl });
    assert.equal(result.outcome, "unreachable");
    assert.equal(getLicenseStatus().state, "grace");
  }
});

test("a signed offline payload verifies locally and makes no request at all", async () => {
  networkMode();
  const license = makeTestLicense({ tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } });
  process.env.CHANNELGATE_LICENSE_PAYLOAD = JSON.stringify({ license, signature: signTestLicense(license) });
  try {
    assert.equal(offlineLicense().license.tier, "enterprise");
    const result = await verifyLicense({ fetchImpl: async () => { throw new Error("the offline path must never call out"); } });
    assert.equal(result.outcome, "verified");
    assert.equal(getLicenseStatus().state, "valid");
    assert.deepEqual(getEffectiveLimits(), { conversations: null, messagesPerConversationPerMonth: null });
  } finally {
    delete process.env.CHANNELGATE_LICENSE_PAYLOAD;
  }
});

test("an offline payload signed by the wrong key is ignored", async () => {
  networkMode();
  const license = makeTestLicense({ tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } });
  process.env.CHANNELGATE_LICENSE_PAYLOAD = JSON.stringify({ license, signature: signTestLicense(license, generateKeyPairSync("ed25519").privateKey) });
  try {
    assert.equal(offlineLicense(), null);
    assert.deepEqual(getEffectiveLimits(), { conversations: 1, messagesPerConversationPerMonth: 500 });
  } finally {
    delete process.env.CHANNELGATE_LICENSE_PAYLOAD;
  }
});

test("the usage report carries hashes and counts only — never a name or an id in clear", async () => {
  networkMode();
  // Enterprise, so both conversations are admitted and the report has two rows to shape-check.
  const ent = makeTestLicense({ tier: "enterprise", limits: { conversations: null, messagesPerConversationPerMonth: null } });
  await verifyLicense({ fetchImpl: async () => okResponse(ent, signTestLicense(ent)) });
  resetLicenseUsage();
  // Two conversations whose ids would be recognisable if they leaked.
  for (const id of ["C_FINANCE_BOARD", "gchat:spaces/AcmeLegal"]) {
    licenseAdmission({ conversationId: id, origin: "slack_foreground" });
  }
  licenseAdmission({ conversationId: "C_FINANCE_BOARD", origin: "slack_foreground" });

  const report = buildUsageReport();
  assert.deepEqual(Object.keys(report).sort(), ["conversations", "installationId", "keyHash", "month", "version"]);
  assert.equal(report.keyHash, createHash("sha256").update("cg-net-key", "utf8").digest("hex"));
  assert.match(report.month, /^\d{4}-(0[1-9]|1[0-2])$/);
  assert.equal(report.conversations.length, 2);
  for (const entry of report.conversations) {
    assert.deepEqual(Object.keys(entry).sort(), ["count", "hash"]);
    assert.match(entry.hash, /^[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(report);
  for (const secret of ["C_FINANCE_BOARD", "AcmeLegal", "gchat", "cg-net-key"]) {
    assert.ok(!serialized.includes(secret), `${secret} must never leave the install`);
  }
  // The hashes are the SHA-256 of the qualified ids, so the platform can correlate months without
  // ever learning a channel name.
  const finance = createHash("sha256").update("C_FINANCE_BOARD", "utf8").digest("hex");
  assert.equal(report.conversations.find((c) => c.hash === finance).count, 2);
  resetLicenseUsage();
});
