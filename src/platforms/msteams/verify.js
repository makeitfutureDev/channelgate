// Inbound authentication for the Teams webhook.
//
// Unlike Slack's Socket Mode and Chat's Pub/Sub pull, the Teams path is a PUBLIC HTTPS endpoint:
// anyone on the internet can POST an activity at it. The only thing separating a real Teams message
// from a forged one is the bearer token Azure Bot Service attaches, so this check is the entire
// authentication boundary for the platform. It fails closed on every unknown.
//
// The rules are Microsoft's documented ones for the Bot Framework channel:
//   • RS256, signed by a key currently published in the Bot Framework JWKS
//   • issuer is api.botframework.com
//   • audience is OUR app id (a token minted for another bot must not work here)
//   • not expired / not used before nbf, with a small clock-skew allowance
//   • the token's serviceUrl claim matches the activity's serviceUrl — this is what stops a replayed
//     real token from being used to point our outbound token at somebody else's host
import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

const OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUERS = new Set(["https://api.botframework.com"]);
const CLOCK_SKEW_SEC = 300;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

// Cached JWKS. Microsoft rotates these keys, so a `kid` we have never seen forces ONE refresh (and
// no more than one per minute — an attacker sending random kids must not be able to turn our
// endpoint into a request amplifier against Microsoft's).
export function createJwksCache({ fetchImpl = fetch, now = Date.now, ttlMs = JWKS_TTL_MS, minRefreshMs = 60_000 } = {}) {
  let keys = new Map();
  let fetchedAt = 0;
  let inFlight = null;

  async function load() {
    const configRes = await fetchImpl(OPENID_CONFIG);
    if (!configRes.ok) throw new Error(`Bot Framework OpenID config fetch failed (${configRes.status})`);
    const config = await configRes.json();
    const jwksUri = String(config?.jwks_uri || "");
    // The document is fetched over TLS from a Microsoft host; still, the URI it names is followed
    // next, so it does not get to send us anywhere else.
    if (!/^https:\/\/[a-z0-9.-]+\.(botframework\.com|microsoftonline\.com|microsoft\.com)\//i.test(jwksUri)) {
      throw new Error("Bot Framework OpenID config named an unexpected jwks_uri");
    }
    const jwksRes = await fetchImpl(jwksUri);
    if (!jwksRes.ok) throw new Error(`Bot Framework JWKS fetch failed (${jwksRes.status})`);
    const jwks = await jwksRes.json();
    const next = new Map();
    for (const key of jwks?.keys || []) {
      if (key?.kty !== "RSA" || !key?.kid) continue;
      next.set(String(key.kid), key);
    }
    if (!next.size) throw new Error("Bot Framework JWKS carried no usable RSA keys");
    keys = next;
    fetchedAt = now();
    return keys;
  }

  return {
    async get(kid) {
      const stale = now() - fetchedAt > ttlMs;
      if (!keys.size || stale || (kid && !keys.has(kid) && now() - fetchedAt > minRefreshMs)) {
        if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
        try {
          await inFlight;
        } catch (err) {
          if (!keys.size) throw err; // no cached keys at all — the caller must reject
        }
      }
      return keys.get(String(kid)) || null;
    },
  };
}

// Returns { ok: true, claims } or { ok: false, reason }. The reason is for the log, never for the
// HTTP response body — telling a prober which check failed is free reconnaissance.
export async function verifyTeamsRequest({ authorization, appId, serviceUrl = "", jwks, now = Date.now } = {}) {
  const header = String(authorization || "");
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "missing bearer token" };
  const parts = match[1].split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  let head;
  let claims;
  try {
    head = decodeSegment(parts[0]);
    claims = decodeSegment(parts[1]);
  } catch {
    return { ok: false, reason: "unparseable token" };
  }
  if (head?.alg !== "RS256") return { ok: false, reason: `unsupported alg ${head?.alg}` };
  if (!ISSUERS.has(String(claims?.iss || ""))) return { ok: false, reason: "unexpected issuer" };

  // Constant-time compare on the audience: it is the one claim an attacker varies while probing.
  const expected = Buffer.from(String(appId || ""));
  const actual = Buffer.from(String(claims?.aud || ""));
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "audience is not this bot" };
  }

  const nowSec = Math.floor(now() / 1000);
  if (Number(claims?.exp || 0) + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: "token expired" };
  if (Number(claims?.nbf || 0) - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "token not yet valid" };

  // A real token carries the serviceUrl it was minted for. Requiring it to match the activity is
  // what makes a captured token useless for redirecting our replies.
  if (claims?.serviceurl && serviceUrl) {
    const claimUrl = String(claims.serviceurl).replace(/\/$/, "");
    if (claimUrl !== String(serviceUrl).replace(/\/$/, "")) return { ok: false, reason: "serviceUrl mismatch" };
  }

  const jwk = await jwks.get(head.kid).catch(() => null);
  if (!jwk) return { ok: false, reason: "unknown signing key" };
  let verified = false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verified = verifier.verify(publicKey, Buffer.from(parts[2], "base64url"));
  } catch {
    return { ok: false, reason: "signature check threw" };
  }
  if (!verified) return { ok: false, reason: "bad signature" };
  return { ok: true, claims };
}

// Bot Framework retries an activity it did not get a 2xx for, and Teams itself can deliver the same
// activity twice. Ids are hashed rather than stored raw so a memory dump of the daemon does not
// carry a list of message identifiers.
export function activityFingerprint(activity) {
  return createHash("sha256")
    .update(JSON.stringify([activity?.type, activity?.id, activity?.conversation?.id, activity?.timestamp, activity?.from?.id, activity?.text, activity?.entities, activity?.reactionsAdded, activity?.reactionsRemoved, activity?.channelData?.eventType, activity?.replyToId, activity?.attachments]))
    .digest("hex");
}
