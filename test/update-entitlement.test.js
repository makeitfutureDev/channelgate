import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, clearTestLicense, testLicenseEnv, tempDir, makeTestLicense, signTestLicense } from "./helpers.js";

ensureTestEnv();
const { hasAutomaticUpdateEntitlement } = await import("../src/ee/update-entitlement.js");
const { startUpdate } = await import("../src/gateway/updater.js");
const { sha256Hex } = await import("../src/ee/license.js");
const { metaSet } = await import("../src/db/index.js");

test("automatic update eligibility follows Enterprise verification, expiry and outage grace", () => {
  try {
    clearTestLicense();
    assert.equal(hasAutomaticUpdateEntitlement(), false);
    testLicenseEnv({ tier: "free" });
    assert.equal(hasAutomaticUpdateEntitlement(), false);
    testLicenseEnv();
    assert.equal(hasAutomaticUpdateEntitlement(), true);
    testLicenseEnv({ expiresAt: "2026-02-01T00:00:00Z" });
    assert.equal(hasAutomaticUpdateEntitlement(Date.parse("2026-02-02T00:00:00Z")), false);
    clearTestLicense();
    process.env.CHANNELGATE_LICENSE_KEY = "update-outage-fixture";
    const license = makeTestLicense();
    const keyHash = sha256Hex(process.env.CHANNELGATE_LICENSE_KEY);
    metaSet("license_cache", JSON.stringify({ license, signature: signTestLicense(license), keyHash, verifiedAt: "2026-02-01T00:00:00Z" }));
    metaSet("license_last_check", JSON.stringify({ outcome: "unreachable", keyHash, at: "2026-02-02T00:00:00Z" }));
    for (const date of ["2026-02-03", "2026-02-20"]) assert.equal(hasAutomaticUpdateEntitlement(Date.parse(date)), true);
    assert.equal(hasAutomaticUpdateEntitlement(Date.parse("2026-03-01")), false);
    for (const outcome of ["invalid", "revoked"]) {
      metaSet("license_last_check", JSON.stringify({ outcome, keyHash, at: "2026-02-02T00:00:00Z" }));
      assert.equal(hasAutomaticUpdateEntitlement(Date.parse("2026-02-03")), false);
    }
  } finally { testLicenseEnv(); }
});

test("all managed entrypoints refuse without creating a lock or spawning for a free license", () => {
  const root = tempDir("update-license-");
  try {
    testLicenseEnv({ tier: "free" });
    for (const source of ["admin-ui", "slack", "mcp", "unknown"]) {
      const result = startUpdate({ root, source }, { spawnImpl() { throw new Error("must not spawn"); } });
      assert.equal(result.forbidden, true);
      assert.match(result.error, /manually/);
      assert.equal(existsSync(path.join(root, "update.lock")), false);
    }
  } finally { testLicenseEnv(); }
});
