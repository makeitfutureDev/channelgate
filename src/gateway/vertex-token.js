// Google Vertex AI access tokens for provider licenses (`claude-gcp`, `codex-gcp`).
//
// A Vertex license stores a service-account KEY (src/engines/license-state.js). That key never
// leaves the daemon: here it signs a short-lived assertion, Google's token endpoint answers with an
// access token good for about an hour, and THAT token is what the egress proxy swaps in for the
// license's placeholder on the Vertex hosts. A container never holds the key or the token.
//
// Three things are deliberately fixed:
//   • the token endpoint — always Google's, never the `token_uri` inside the uploaded JSON, which
//     is attacker-controlled text and would otherwise receive a signed assertion;
//   • the scope — cloud-platform, the one Vertex prediction needs;
//   • the transport — the public-address-only fetch, never the global one.
// Errors carry Google's own error code and description and nothing of the key.
import { createHash, createSign } from "node:crypto";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ASSERTION_TTL_S = 3600;
// A cached token is handed out only while this much of its life remains, so a request that starts
// now does not arrive expired.
const DEFAULT_MIN_REMAINING_MS = 5 * 60_000;
const MAX_CACHE = 64;

const b64url = (value) => Buffer.from(value).toString("base64url");
const cache = new Map(); // key fingerprint → { token, expiresAt }
const pending = new Map(); // key fingerprint → Promise

export const serviceAccountFingerprint = (stored) => createHash("sha256").update(String(stored || "")).digest("hex").slice(0, 24);

function parseStored(stored) {
  try {
    const parsed = JSON.parse(String(stored || ""));
    if (parsed && typeof parsed.client_email === "string" && typeof parsed.private_key === "string") return parsed;
  } catch { /* fall through */ }
  return null;
}

export function signServiceAccountAssertion(account, { now = Date.now() } = {}) {
  const issued = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = { iss: account.client_email, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat: issued, exp: issued + ASSERTION_TTL_S };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(account.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

async function mint(stored, { fetchImpl, timeoutMs, now }) {
  const account = parseStored(stored);
  if (!account) throw new Error("no usable service-account key is stored");
  let assertion;
  try {
    assertion = signServiceAccountAssertion(account, { now: now() });
  } catch {
    // node:crypto names the key material in some failures; say only what the admin can act on.
    throw new Error("the service-account private key could not be used to sign (is the key file complete?)");
  }
  let response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(`Google's token endpoint could not be reached (${String(error?.name || "error")})`), { unreachable: true });
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token) {
    const code = String(body?.error || "").replace(/[^\w.-]/g, "").slice(0, 60);
    const description = String(body?.error_description || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
    throw Object.assign(
      new Error(`Google refused the service-account key (HTTP ${response.status}${code ? `, ${code}` : ""}${description ? `: ${description}` : ""})`),
      { rejected: response.status >= 400 && response.status < 500 },
    );
  }
  const lifetimeMs = Math.max(60, Math.min(Number(body.expires_in) || ASSERTION_TTL_S, ASSERTION_TTL_S)) * 1000;
  return { token: body.access_token, expiresAt: now() + lifetimeMs };
}

/**
 * The access token for a stored service-account key: `{ token, expiresAt }`. Cached per key until
 * `minRemainingMs` of its life is left; concurrent callers share one request. Throws a value-free
 * Error (`rejected: true` when Google refused the key, `unreachable: true` when it was not reached).
 */
export async function vertexAccessToken(stored, { fetchImpl, minRemainingMs = DEFAULT_MIN_REMAINING_MS, timeoutMs = 15_000, now = Date.now } = {}) {
  const key = serviceAccountFingerprint(stored);
  const hit = cache.get(key);
  if (hit && hit.expiresAt - now() > minRemainingMs) return hit;
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const fetcher = fetchImpl || (await import("../mcp/public-fetch.js")).publicPinnedFetch;
      const fresh = await mint(stored, { fetchImpl: fetcher, timeoutMs, now });
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, fresh);
      return fresh;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

// A key that was replaced or removed must not keep answering from the cache.
export function forgetVertexToken(stored) {
  cache.delete(serviceAccountFingerprint(stored));
}
export function __resetVertexTokens() {
  cache.clear();
  pending.clear();
}
