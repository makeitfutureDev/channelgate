// Composio SDK session lifecycle. The SDK key stays inside this daemon module; callers receive
// only a session-scoped MCP URL plus non-secret metadata. Connected accounts are keyed by the
// stable external identity in Composio, while SQLite keeps per-thread remote session mappings.
import { requireComposioSdkEntitlement } from "./composio-entitlement.js";
import { Composio } from "@composio/core";
import { getComposioSdkApiKey } from "../config/settings.js";
import {
  composioIdentity,
  composioSessionKey,
  deleteComposioSession,
  getComposioSession,
  saveComposioSession,
} from "./composio-sessions.js";

let cachedKey = "";
let cachedClient = null;
const inFlight = new Map();

function productionClient() {
  const apiKey = getComposioSdkApiKey();
  if (!apiKey) throw new Error("Composio SDK mode needs an organization API key");
  if (!cachedClient || apiKey !== cachedKey) {
    cachedKey = apiKey;
    cachedClient = new Composio({ apiKey });
  }
  return cachedClient;
}

function isMissingSession(error) {
  const statuses = [
    error?.statusCode,
    error?.status,
    error?.cause?.statusCode,
    error?.cause?.status,
    error?.error?.statusCode,
    error?.error?.status,
  ];
  return statuses.some((status) => Number(status) === 404);
}

function endpointFrom(session, source) {
  const sessionId = String(session?.sessionId || session?.session_id || "").trim();
  const rawUrl = String(session?.mcp?.url || "").trim();
  if (!sessionId || !rawUrl) throw new Error("Composio returned an incomplete MCP session");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Composio returned a non-HTTPS MCP session");
  return {
    mode: "sdk",
    url: url.toString(),
    sessionId,
    source,
  };
}

function singleFlight(key, work) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(work)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export async function resolveSdkSession({
  workspaceId = "",
  kind = "",
  id = "",
  threadKey = "",
  accessKind = "",
  manageConnections = false,
  client = null,
} = {}) {
  requireComposioSdkEntitlement();
  const identityId = composioIdentity({ workspaceId, kind, id });
  const sessionKey = composioSessionKey({ identityId, threadKey, accessKind });
  const source = kind === "user" ? "sdk-user" : "sdk-channel";
  const sdk = client || productionClient();

  return singleFlight(sessionKey, async () => {
    const stored = getComposioSession(sessionKey);
    if (stored) {
      try {
        const resumed = endpointFrom(
          await sdk.sessions.use(stored.sessionId, { mcp: true }),
          source
        );
        saveComposioSession({
          sessionKey,
          identityId,
          scopeKind: kind,
          threadKey,
          accessKind,
          sessionId: resumed.sessionId,
          mcpUrl: resumed.url,
        });
        return resumed;
      } catch (error) {
        if (!isMissingSession(error)) throw error;
        deleteComposioSession(sessionKey);
      }
    }

    const created = endpointFrom(
      await sdk.sessions.create(identityId, {
        mcp: true,
        manageConnections: Boolean(manageConnections),
      }),
      source
    );
    saveComposioSession({
      sessionKey,
      identityId,
      scopeKind: kind,
      threadKey,
      accessKind,
      sessionId: created.sessionId,
      mcpUrl: created.url,
    });
    return created;
  });
}
