// The Bot Framework connector REST surface: send, update, delete, create a 1:1 conversation, read a
// roster. Everything Teams-outbound goes through here.
//
// TWO validations in this file are load-bearing security, not tidiness:
//
//   • serviceUrl host allowlist — the URL an activity is posted to arrives IN the inbound activity,
//     i.e. from the network. We mint a bearer token good for our whole bot and put it in that
//     request's Authorization header. An unvalidated serviceUrl is therefore a token-exfiltration
//     primitive: spoof an activity, point serviceUrl at your own host, collect the credential.
//     Hermes hit the same hazard from the env-var direction and landed on the same fix.
//   • conversation-id character set — the id lands in a URL path, so anything outside the documented
//     set is an attempt to escape /v3/conversations/<id>/activities.
import { setTimeout as delay } from "node:timers/promises";

const ALLOWED_SERVICE_HOSTS = new Set([
  "smba.trafficmanager.net",
  "smba.infra.gov.teams.microsoft.us",
]);
export const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

// Real ids look like "19:a1b2…@thread.tacv2" or "a:1x2y…". The reply-thread suffix
// (";messageid=1690000000000") is built by us, never accepted from outside, so ';' and '=' are
// deliberately absent from this set.
const CONVERSATION_RE = /^[A-Za-z0-9:@\-_.]+$/;
const ACTIVITY_RE = /^[A-Za-z0-9:@\-_.=|]+$/;

export const isConversationId = (v) => CONVERSATION_RE.test(String(v || ""));
export const isActivityId = (v) => ACTIVITY_RE.test(String(v || ""));

export function validateServiceUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  if (!ALLOWED_SERVICE_HOSTS.has(parsed.hostname)) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createTeamsApi({ auth, serviceUrl = DEFAULT_SERVICE_URL, fetchImpl = fetch, sleep = delay, attempts = 3, baseDelayMs = 500 } = {}) {
  if (!auth?.token) throw new TypeError("createTeamsApi requires a Teams auth provider");
  const base = validateServiceUrl(serviceUrl);
  if (!base) throw new Error(`Teams serviceUrl is not a known Bot Framework host: ${serviceUrl}`);

  async function call(path, { method = "POST", body = null } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const token = await auth.token();
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) return await res.json().catch(() => ({}));
      const text = await res.text().catch(() => "");
      const err = new Error(`Teams ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      if (res.status === 401) auth.reset?.();
      if (!RETRYABLE.has(res.status) && res.status !== 401) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastErr;
  }

  // A reply inside a Teams CHANNEL thread is addressed by extending the conversation id with the
  // root message id — there is no thread field on the activity. Building it here (rather than
  // accepting a pre-joined id from a caller) is what keeps the ';messageid=' suffix out of the
  // character set we accept from the network.
  function target(conversationId, threadKey = "") {
    const id = String(conversationId || "");
    if (!isConversationId(id)) throw new Error("Teams conversation id contains characters outside the Bot Framework set");
    const thread = String(threadKey || "");
    if (!thread) return encodeURIComponent(id);
    if (!isActivityId(thread)) throw new Error("Teams thread id contains characters outside the Bot Framework set");
    return encodeURIComponent(`${id};messageid=${thread}`);
  }

  return {
    serviceUrl: base,

    async sendActivity(conversationId, { text, entities = [], threadKey = "", attachments = null } = {}) {
      const activity = {
        type: "message",
        // Teams renders the narrow Markdown subset only when textFormat says so; without it the
        // asterisks in an answer show up literally.
        textFormat: "markdown",
        text: String(text ?? ""),
        ...(entities?.length ? { entities } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
      const res = await call(`v3/conversations/${target(conversationId, threadKey)}/activities`, { body: activity });
      return { messageId: res?.id || "" };
    },

    async updateActivity(conversationId, activityId, { text, entities = [] } = {}) {
      const id = String(activityId || "");
      if (!isActivityId(id)) throw new Error("Teams activity id contains characters outside the Bot Framework set");
      await call(`v3/conversations/${target(conversationId)}/activities/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { type: "message", textFormat: "markdown", text: String(text ?? ""), ...(entities?.length ? { entities } : {}) },
      });
    },

    async deleteActivity(conversationId, activityId) {
      const id = String(activityId || "");
      if (!isActivityId(id)) throw new Error("Teams activity id contains characters outside the Bot Framework set");
      await call(`v3/conversations/${target(conversationId)}/activities/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    // The 1:1 chat between the bot and one user. `userId` is the user's Bot Framework id (`29:…`)
    // — an Entra object id or a UPN will NOT work here, which is why the inbound normalizer keeps
    // the channel id alongside the AAD one.
    async createConversation({ userId, botId, tenantId = "" } = {}) {
      const res = await call("v3/conversations", {
        body: {
          isGroup: false,
          bot: { id: botId },
          members: [{ id: userId }],
          ...(tenantId ? { channelData: { tenant: { id: tenantId } } } : {}),
        },
      });
      return res?.id || "";
    },

    // Resolve the Microsoft 365 group GUID needed for Graph from an authenticated team activity.
    async teamInfo(teamId) {
      if (!isConversationId(teamId)) throw new Error("Teams team id contains invalid characters");
      return call(`v3/teams/${encodeURIComponent(teamId)}`, { method: "GET" });
    },

    // Roster for mention resolution. In a channel this needs RSC consent; without it Teams answers
    // 403 and the caller keeps its previous (possibly empty) directory.
    async listMembers(conversationId) {
      const res = await call(`v3/conversations/${target(conversationId)}/members`, { method: "GET" });
      const list = Array.isArray(res) ? res : (res?.members || []);
      return list
        .filter((m) => m?.id)
        .map((m) => ({ id: m.id, aadObjectId: m.aadObjectId || "", name: m.name || "", email: m.email || m.userPrincipalName || "" }));
    },
  };
}
