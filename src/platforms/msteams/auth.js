// Bot Framework outbound auth: an Entra ID (Azure AD) client-credentials token.
//
// Same reasoning as the Google side — this is one form POST, so it is written against fetch rather
// than pulled in as `botbuilder` + `@azure/msal-node` and their dependency trees. Cached and
// single-flighted because a streamed answer edits its message once a second and every one of those
// edits needs a bearer token.
const LOGIN_HOST = "https://login.microsoftonline.com";
// The audience every Bot Framework connector call is issued against.
export const BOT_SCOPE = "https://api.botframework.com/.default";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// A multi-tenant bot authenticates against the shared Bot Framework tenant; a single-tenant bot
// against its own directory. Operators paste whichever their app registration uses.
export const MULTI_TENANT = "botframework.com";
const EXPIRY_MARGIN_MS = 60_000;

// Tenant ids reach a URL path. Real values are GUIDs or a domain name; anything else is either a
// typo or an attempt to redirect our client credentials at an attacker-controlled STS.
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,120}$/;

export function createTeamsAuth({ clientId, clientSecret, tenantId = MULTI_TENANT, scope = BOT_SCOPE, fetchImpl = fetch, now = Date.now } = {}) {
  if (![BOT_SCOPE, GRAPH_SCOPE].includes(scope)) throw new Error("Unsupported Teams token scope");
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "");
  const tenant = String(tenantId || MULTI_TENANT).trim() || MULTI_TENANT;
  if (!id || !secret) throw new Error("Teams app id and client secret are both required");
  if (!TENANT_RE.test(tenant)) throw new Error("Teams tenant id contains characters outside the expected set");

  let cached = null;
  let inFlight = null;

  async function refresh() {
    const res = await fetchImpl(`${LOGIN_HOST}/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
        scope,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        // error_description is where Entra puts the actionable part ("AADSTS7000215: Invalid client
        // secret", "AADSTS700016: application not found in tenant") — the status code alone is not
        // enough to tell an operator which of the three fields they got wrong.
        detail = parsed.error_description || parsed.error || detail;
      } catch { /* keep the raw body */ }
      const err = new Error(`Teams token request failed (${res.status}): ${detail}`);
      err.status = res.status;
      err.fatal = res.status === 400 || res.status === 401;
      throw err;
    }
    const parsed = JSON.parse(text);
    if (!parsed.access_token) throw new Error("Teams token response carried no access_token");
    cached = {
      token: parsed.access_token,
      expiresAt: now() + Math.max(0, Number(parsed.expires_in || 3600) * 1000) - EXPIRY_MARGIN_MS,
    };
    return cached.token;
  }

  return {
    clientId: id,
    tenantId: tenant,
    async token() {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
    reset() { cached = null; },
  };
}
