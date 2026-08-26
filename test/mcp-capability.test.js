import test from "node:test";
import assert from "node:assert/strict";
import { mintGatewayCapability, verifyGatewayCapability } from "../src/gateway/mcp-capability.js";

const secret = "unit-test-capability-secret";
const identity = {
  secret,
  channelId: "C_CAP",
  slug: "cap-test",
  authorId: "U_CAP",
  threadKey: "1.234",
  origin: "slack_foreground",
  engine: "claude",
};

test("gateway capability round-trips the complete scoped run identity", () => {
  const token = mintGatewayCapability({ ...identity, now: 1_000, ttlMs: 5_000 });
  const verified = verifyGatewayCapability(token, { secret, now: 2_000 });
  assert.equal(verified.ok, true);
  assert.deepEqual(
    Object.fromEntries(["channelId", "slug", "authorId", "threadKey", "origin", "engine", "principalTrusted"].map((key) => [key, verified.claims[key]])),
    { channelId: "C_CAP", slug: "cap-test", authorId: "U_CAP", threadKey: "1.234", origin: "slack_foreground", engine: "claude", principalTrusted: true },
  );
  assert.equal(verified.claims.scope, "gateway-tools");
});

test("gateway capability carries untrusted API provenance as signed authority state", () => {
  const token = mintGatewayCapability({ ...identity, origin: "api_foreground", principalTrusted: false, now: 1_000, ttlMs: 5_000 });
  const verified = verifyGatewayCapability(token, { secret, now: 2_000 });
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.principalTrusted, false);
});

test("gateway capability fails closed when tampered, expired, incomplete, or signed elsewhere", () => {
  const token = mintGatewayCapability({ ...identity, now: 1_000, ttlMs: 5_000 });
  const [payload, signature] = token.split(".");
  assert.equal(verifyGatewayCapability(`${payload}x.${signature}`, { secret, now: 2_000 }).ok, false);
  assert.equal(verifyGatewayCapability(token, { secret: "wrong", now: 2_000 }).ok, false);
  assert.equal(verifyGatewayCapability(token, { secret, now: 6_000 }).ok, false);
  assert.equal(verifyGatewayCapability("", { secret, now: 2_000 }).ok, false);
  assert.throws(() => mintGatewayCapability({ ...identity, authorId: "" }), /complete run identity/i);
  assert.throws(() => mintGatewayCapability({ ...identity, origin: "invented" }), /complete run identity/i);
});
