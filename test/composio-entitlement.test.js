import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, testLicenseEnv, makeTestLicense, signTestLicense } from "./helpers.js";

ensureTestEnv();
const { hasComposioSdkEntitlement } = await import("../src/ee/composio-entitlement.js");
const { sha256Hex } = await import("../src/ee/license.js");
const { metaSet } = await import("../src/db/index.js");

test("SDK entitlement requires Enterprise, honors expiry, and retains the published outage grace", () => {
  try {
    clearTestLicense();
    assert.equal(hasComposioSdkEntitlement(), false);
    testLicenseEnv({ tier: "free" });
    assert.equal(hasComposioSdkEntitlement(), false);
    testLicenseEnv();
    assert.equal(hasComposioSdkEntitlement(), true);
    testLicenseEnv({ expiresAt: "2026-02-01T00:00:00Z" });
    assert.equal(hasComposioSdkEntitlement(Date.parse("2026-02-02T00:00:00Z")), false);

    clearTestLicense();
    process.env.CHANNELGATE_LICENSE_KEY = "outage-test-key";
    const license = makeTestLicense();
    const keyHash = sha256Hex(process.env.CHANNELGATE_LICENSE_KEY);
    metaSet("license_cache", JSON.stringify({ license, signature: signTestLicense(license), keyHash, verifiedAt: "2026-02-01T00:00:00Z" }));
    metaSet("license_last_check", JSON.stringify({ outcome: "unreachable", keyHash, at: "2026-02-02T00:00:00Z", detail: "fixture outage" }));
    assert.equal(hasComposioSdkEntitlement(Date.parse("2026-02-03T00:00:00Z")), true);
    assert.equal(hasComposioSdkEntitlement(Date.parse("2026-02-20T00:00:00Z")), true);
    assert.equal(hasComposioSdkEntitlement(Date.parse("2026-03-01T00:00:00Z")), false);
    for (const outcome of ["invalid", "revoked"]) {
      metaSet("license_last_check", JSON.stringify({ outcome, keyHash, at: "2026-02-02T00:00:00Z" }));
      assert.equal(hasComposioSdkEntitlement(Date.parse("2026-02-03T00:00:00Z")), false, outcome);
    }
  } finally { testLicenseEnv(); }
});
