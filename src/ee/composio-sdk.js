// Composio SDK session lifecycle. The SDK key stays inside this daemon module; callers receive
// only a session-scoped MCP URL plus non-secret metadata. Connected accounts are keyed by the
// stable external identity in Composio, while SQLite keeps per-thread remote session mappings.
import { requireComposioSdkEntitlement } from "./composio-entitlement.js";
import { createHash } from "node:crypto";
import { Composio } from "@composio/core";
import { getComposioSdkApiKey, getComposioSdkPolicy } from "../config/settings.js";
import { composioSessionPolicy } from "../config/composio-sdk-policy.js";
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

  const prepared = await singleFlight(sessionKey, async () => {
    const policy = composioSessionPolicy(getComposioSdkPolicy());
    const policyFingerprint = JSON.stringify(policy);
    const stored = getComposioSession(sessionKey);
    if (stored) {
      try {
        const session = await sdk.sessions.use(stored.sessionId, { mcp: true });
        // Apply current policy before exposing any tools, including sessions persisted before
        // these controls existed. A failed update must not return an unrestricted old endpoint.
        await session.update({ ...policy, manageConnections: { enable: Boolean(manageConnections) } });
        const resumed = endpointFrom(session, source);
        saveComposioSession({
          sessionKey,
          identityId,
          scopeKind: kind,
          threadKey,
          accessKind,
          sessionId: resumed.sessionId,
          mcpUrl: resumed.url,
        });
        return { endpoint: resumed, policyFingerprint };
      } catch (error) {
        if (!isMissingSession(error)) throw error;
        deleteComposioSession(sessionKey);
      }
    }

    const created = endpointFrom(
      await sdk.sessions.create(identityId, {
        mcp: true,
        manageConnections: Boolean(manageConnections),
        ...policy,
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
    return { endpoint: created, policyFingerprint };
  });
  // Every caller checks after awaiting the shared preparation. A settings save can happen
  // while Composio is in flight, including before a second caller joins that older request.
  // Keep the mapping for the next attempt, but never expose its stale policy to either caller.
  if (prepared.policyFingerprint !== JSON.stringify(composioSessionPolicy(getComposioSdkPolicy()))) {
    throw new Error("Composio SDK policy changed while preparing the session; retry the run");
  }
  // The remote URL survives policy updates. Include a value-free revision so warm engine
  // processes reconnect and discover changed account-selection/tool schemas on the next turn.
  return { ...prepared.endpoint, policyDigest: `sha256:${createHash("sha256").update(prepared.policyFingerprint).digest("hex")}` };
}
