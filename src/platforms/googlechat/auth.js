// Google service-account auth for the Chat + Pub/Sub REST calls.
//
// Deliberately hand-rolled instead of pulling in `googleapis`/`google-auth-library`: the daemon has
// five runtime dependencies and every one of them is a supply-chain surface inside a product whose
// pitch is confinement. What we actually need is one signed JWT assertion exchanged for an access
// token — ~60 lines against node:crypto — not a 200-package SDK.
//
// The token is cached and refreshed in a SINGLE flight: the Pub/Sub puller, the Chat writer, and a
// media download all reach for it concurrently, and three parallel refreshes against Google's STS
// is both wasteful and a rate-limit magnet.
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// The bot's own messaging operations (messages.create/patch/delete, spaces + membership reads,
// media.download for inbound attachments) plus the subscription pull. Least privilege: no Drive,
// no chat.messages.readonly — the app only ever sees what is published to its own topic.
export const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/pubsub",
];
// Refresh this far before the real expiry so a token can't die mid-request.
const EXPIRY_MARGIN_MS = 60_000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Accepts the raw JSON of a service-account key file (string or already-parsed object) and returns
// only the three fields we use. Throws with a message an admin can act on — a key pasted from the
// wrong place (an OAuth client, an API key) is the single most common setup mistake, and "invalid
// grant" three steps later is a terrible way to learn it.
export function parseServiceAccount(raw) {
  let json = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) throw new Error("Google service-account key is empty");
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Google service-account key is not valid JSON");
    }
  }
  if (!json || typeof json !== "object") throw new Error("Google service-account key must be a JSON object");
  if (json.type && json.type !== "service_account") {
    throw new Error(`Google credentials are of type "${json.type}" — a service_account key is required`);
  }
  const clientEmail = String(json.client_email || "").trim();
  const privateKey = String(json.private_key || "").replace(/\\n/g, "\n").trim();
  const projectId = String(json.project_id || "").trim();
  if (!clientEmail) throw new Error("Google service-account key has no client_email");
  if (!privateKey.includes("PRIVATE KEY")) throw new Error("Google service-account key has no usable private_key");
  return { clientEmail, privateKey, projectId };
}

export function createGoogleAuth({ serviceAccount, scopes = CHAT_SCOPES, fetchImpl = fetch, now = Date.now } = {}) {
  const sa = parseServiceAccount(serviceAccount);
  let cached = null; // { token, expiresAt }
  let inFlight = null;

  function assertion() {
    const iat = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({
      iss: sa.clientEmail,
      scope: scopes.join(" "),
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(sa.privateKey, "base64url")}`;
  }

  async function refresh() {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion(),
      }).toString(),
    });
    const body = await res.text();
    if (!res.ok) {
      // Google answers a bad key with a JSON {error, error_description}. Surface the description —
      // it distinguishes "clock skew" from "key revoked" from "API not enabled", and none of those
      // are guessable from a 400.
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error_description || parsed.error || detail;
      } catch { /* keep the raw body */ }
      const err = new Error(`Google token request failed (${res.status}): ${detail}`);
      err.status = res.status;
      // 400 invalid_grant / 401 = the key itself is bad; no amount of retrying fixes it.
      err.fatal = res.status === 400 || res.status === 401;
      throw err;
    }
    const parsed = JSON.parse(body);
    if (!parsed.access_token) throw new Error("Google token response carried no access_token");
    cached = {
      token: parsed.access_token,
      expiresAt: now() + Math.max(0, Number(parsed.expires_in || 3600) * 1000) - EXPIRY_MARGIN_MS,
    };
    return cached.token;
  }

  return {
    clientEmail: sa.clientEmail,
    projectId: sa.projectId,
    async token() {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inFlight) {
        inFlight = refresh().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    // Called when Google answers 401 on a real API call: the cached token is dead even though our
    // clock says otherwise (revoked key, rotated SA). Dropping it makes the next call re-mint.
    reset() { cached = null; },
  };
}
