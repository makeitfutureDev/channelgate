import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const VERSION = 2;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
import { RUN_ORIGINS } from "../engines/contract.js";

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ORIGINS = new Set(RUN_ORIGINS); // single source: engines/contract.js

const encode = (value) => Buffer.from(value).toString("base64url");
const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

export function mintGatewayCapability({ secret, channelId, slug, authorId, threadKey, origin, engine, principalTrusted = true, now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!secret || !channelId || !slug || !authorId || !threadKey || !ORIGINS.has(origin)) {
    throw new Error("Cannot mint gateway capability without a complete run identity");
  }
  const ttl = Math.min(Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
  const claims = {
    v: VERSION,
    aud: "channelgate-mcp",
    channelId,
    slug,
    authorId,
    threadKey,
    origin,
    engine: String(engine || ""),
    principalTrusted: principalTrusted === true,
    scope: "gateway-tools",
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyGatewayCapability(token, { secret, now = Date.now() } = {}) {
  if (!token || !secret) return { ok: false, reason: "missing capability or signing secret" };
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "malformed capability" };
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "invalid capability signature" };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid capability payload" };
  }
  if (claims?.v !== VERSION || claims.aud !== "channelgate-mcp" || claims.scope !== "gateway-tools") {
    return { ok: false, reason: "unsupported capability" };
  }
  if (!claims.channelId || !claims.slug || !claims.authorId || !claims.threadKey || !ORIGINS.has(claims.origin) || typeof claims.principalTrusted !== "boolean") {
    return { ok: false, reason: "incomplete capability claims" };
  }
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.iat > now + 30_000 || claims.exp <= now || claims.exp - claims.iat > MAX_TTL_MS) {
    return { ok: false, reason: "expired or invalid capability lifetime" };
  }
  return { ok: true, claims };
}

export const GATEWAY_CAPABILITY_TTL_MS = DEFAULT_TTL_MS;
