import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";

const ambient = process.env.CHANNELGATE_LICENSE_PUBLIC_KEY;
delete process.env.CHANNELGATE_LICENSE_PUBLIC_KEY;
const {
  PLACEHOLDER_PUBLIC_KEY_PEM,
  PRODUCTION_PUBLIC_KEY_PEM,
  isPlaceholderKey,
  licensePublicKeyPem,
} = await import("../src/ee/license-public-key.js");

test.after(() => {
  if (ambient === undefined) delete process.env.CHANNELGATE_LICENSE_PUBLIC_KEY;
  else process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = ambient;
});

test("the default trust root is the production Ed25519 key, not the development placeholder", () => {
  assert.equal(licensePublicKeyPem(), PRODUCTION_PUBLIC_KEY_PEM);
  assert.notEqual(PRODUCTION_PUBLIC_KEY_PEM, PLACEHOLDER_PUBLIC_KEY_PEM);
  assert.equal(isPlaceholderKey(), false);
  assert.equal(createPublicKey(PRODUCTION_PUBLIC_KEY_PEM).asymmetricKeyType, "ed25519");
});

test("an environment override still supports escaped newlines for staging and rotation", () => {
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = PLACEHOLDER_PUBLIC_KEY_PEM.replace(/\n/g, "\\n");
  assert.equal(licensePublicKeyPem(), PLACEHOLDER_PUBLIC_KEY_PEM);
  assert.equal(isPlaceholderKey(), true);
});
