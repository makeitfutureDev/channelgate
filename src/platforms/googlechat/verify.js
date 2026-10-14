// Inbound authentication for the Google Chat HTTP endpoint.
//
// A Chat app has ONE connection setting: a Pub/Sub topic (the daemon pulls, nothing is exposed) or
// an HTTP endpoint URL. Only the endpoint receives card and button clicks, so an operator who wants
// interactive cards points the app at `<publicUrl>/api/googlechat/events` — a PUBLIC URL anyone can
// POST at. The bearer token Google attaches is the entire authentication boundary, exactly as the
// Bot Framework token is for Teams, and it fails closed on every unknown.
//
// Google's documented rules (developers.google.com/workspace/chat/verify-requests-from-chat):
//   • a Workspace add-on style app signs a Google OIDC ID token: issuer accounts.google.com,
//     audience = the configured endpoint URL, `email` = the app's per-project service account
//     (`service-<project-number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`), `email_verified`
//   • a standalone (non add-on) app signs with `chat@system.gserviceaccount.com`: either the same
//     OIDC shape with that email, or — when the app's "Authentication Audience" is the Cloud
//     project number — a JWT issued BY that account with the project number as audience, verified
//     against that account's published keys
//   • anything else, and anything expired, answers 401
// The sender list is exact: a token Google minted for ANOTHER customer's add-on pointed at our URL
// verifies cryptographically, so the email is what separates our app from a stranger's.
import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

export const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const CHAT_SYSTEM_ACCOUNT = "chat@system.gserviceaccount.com";
export const CHAT_SYSTEM_JWKS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_SYSTEM_ACCOUNT}`;
export const ADDON_SERVICE_ACCOUNT = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const OIDC_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SEC = 300;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function sameString(expected, actual) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(actual || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// Cached JWKS for ONE Google key URL. Google rotates these keys, so a `kid` we have never seen
// forces one refresh — and no more than one per minute, so a prober sending random kids cannot
// turn this endpoint into a request amplifier against Google's.
export function createGoogleJwks({ url, fetchImpl = fetch, now = Date.now, ttlMs = JWKS_TTL_MS, minRefreshMs = 60_000 } = {}) {
  if (!/^https:\/\/www\.googleapis\.com\//.test(String(url))) throw new Error("Google JWKS must be fetched from www.googleapis.com");
  let keys = new Map();
  let fetchedAt = 0;
  let inFlight = null;

  async function load() {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Google key fetch failed (${res.status})`);
    const jwks = await res.json();
    const next = new Map();
    for (const key of jwks?.keys || []) {
      if (key?.kty !== "RSA" || !key?.kid) continue;
      next.set(String(key.kid), key);
    }
    if (!next.size) throw new Error("Google key set carried no usable RSA keys");
    keys = next;
    fetchedAt = now();
    return keys;
  }

  return {
    async get(kid) {
      const stale = now() - fetchedAt > ttlMs;
      if (!keys.size || stale || (kid && !keys.has(kid) && now() - fetchedAt > minRefreshMs)) {
        if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
        try { await inFlight; }
        catch (err) { if (!keys.size) throw err; }
      }
      return keys.get(String(kid)) || null;
    },
  };
}

// The senders a deployment accepts: Google's shared Chat account always, plus the add-on's own
// per-project account when the operator configured it. Lower-cased once so the compare is exact.
export function googleChatSenders(appServiceAccount = "") {
  const set = new Set([CHAT_SYSTEM_ACCOUNT]);
  const own = String(appServiceAccount || "").trim().toLowerCase();
  if (own) set.add(own);
  return set;
}

// Returns { ok: true, claims, sender } or { ok: false, reason }. The reason is for the log, never
// for the HTTP response body — telling a prober which check failed is free reconnaissance.
export async function verifyGoogleChatRequest({ authorization, endpointUrl = "", projectNumber = "", appServiceAccount = "", oidcKeys, chatKeys, now = Date.now } = {}) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(authorization || "").trim());
  if (!match) return { ok: false, reason: "missing bearer token" };
  const parts = match[1].split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  let head, claims;
  try { head = decodeSegment(parts[0]); claims = decodeSegment(parts[1]); }
  catch { return { ok: false, reason: "unparseable token" }; }
  if (head?.alg !== "RS256" || !head?.kid) return { ok: false, reason: `unsupported token header` };

  const issuer = String(claims?.iss || "");
  const audience = Array.isArray(claims?.aud) ? (claims.aud.length === 1 ? claims.aud[0] : "") : claims?.aud;
  const expectedUrl = String(endpointUrl || "").replace(/\/$/, "");
  let keys;
  let sender;
  if (OIDC_ISSUERS.has(issuer)) {
    // Add-on apps and URL-audience standalone apps: an ID token for OUR endpoint, from OUR sender.
    if (!expectedUrl || !sameString(expectedUrl, String(audience || "").replace(/\/$/, ""))) return { ok: false, reason: "audience is not this endpoint" };
    if (claims?.email_verified !== true) return { ok: false, reason: "sender email not verified" };
    sender = String(claims?.email || "").toLowerCase();
    if (!googleChatSenders(appServiceAccount).has(sender)) return { ok: false, reason: "sender is not this Chat app" };
    keys = oidcKeys;
  } else if (issuer === CHAT_SYSTEM_ACCOUNT) {
    // Standalone app with the "project number" audience: a JWT issued by Google's Chat account.
    if (!projectNumber || !sameString(projectNumber, audience)) return { ok: false, reason: "audience is not this project" };
    sender = CHAT_SYSTEM_ACCOUNT;
    keys = chatKeys;
  } else return { ok: false, reason: "unexpected issuer" };

  const nowSec = Math.floor(now() / 1000);
  if (!Number.isFinite(Number(claims?.exp)) || Number(claims.exp) + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: "token expired" };
  if (Number(claims?.nbf || 0) - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "token not yet valid" };
  if (Number(claims?.iat || 0) - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "token issued in the future" };

  const jwk = keys ? await keys.get(head.kid).catch(() => null) : null;
  if (!jwk) return { ok: false, reason: "unknown signing key" };
  let verified = false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verified = verifier.verify(publicKey, Buffer.from(parts[2], "base64url"));
  } catch { return { ok: false, reason: "signature check threw" }; }
  if (!verified) return { ok: false, reason: "bad signature" };
  return { ok: true, claims, sender };
}
