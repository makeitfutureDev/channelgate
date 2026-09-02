import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

// ── Tool-surface claims (v0.8) ────────────────────────────────────────────────────────────────
// A containerized run reaches the gateway MCP server over the daemon socket, where the ONLY thing
// it presents is this bearer — so the reduced-toolset switch and the progress-report opt-in must
// travel inside the signature rather than in an environment the daemon cannot see.
test("the toolset and progress-report switches are signed claims", () => {
  const token = mintGatewayCapability({ ...identity, toolset: "memory-review", progressReport: true, now: 1_000, ttlMs: 5_000 });
  const verified = verifyGatewayCapability(token, { secret, now: 2_000 });
  assert.equal(verified.claims.toolset, "memory-review");
  assert.equal(verified.claims.progressReport, true);

  const plain = verifyGatewayCapability(mintGatewayCapability({ ...identity, now: 1_000, ttlMs: 5_000 }), { secret, now: 2_000 });
  assert.equal(plain.claims.toolset, "");
  assert.equal(plain.claims.progressReport, false);
});

test("a token minted before these claims existed still verifies — they are optional, not required", () => {
  // Hand-built payload in the pre-v0.8 shape, signed with the same secret.
  const claims = {
    v: 2, aud: "channelgate-mcp", channelId: "C_CAP", slug: "cap-test", authorId: "U_CAP",
    threadKey: "1.234", origin: "slack_foreground", engine: "claude", principalTrusted: true,
    scope: "gateway-tools", iat: 1_000, exp: 6_000, jti: "old-token",
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const legacy = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  const verified = verifyGatewayCapability(legacy, { secret, now: 2_000 });
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(verified.claims.toolset, undefined);
  assert.equal(verified.claims.progressReport, undefined);
});

test("a tampered toolset/progress claim of the wrong TYPE is refused, not coerced", () => {
  const forge = (extra) => {
    const claims = {
      v: 2, aud: "channelgate-mcp", channelId: "C_CAP", slug: "cap-test", authorId: "U_CAP",
      threadKey: "1.234", origin: "slack_foreground", engine: "claude", principalTrusted: true,
      scope: "gateway-tools", iat: 1_000, exp: 6_000, jti: "forged", ...extra,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  assert.match(verifyGatewayCapability(forge({ toolset: { evil: true } }), { secret, now: 2_000 }).reason, /invalid capability toolset/);
  assert.match(verifyGatewayCapability(forge({ progressReport: "yes" }), { secret, now: 2_000 }).reason, /invalid capability progress/);
});
