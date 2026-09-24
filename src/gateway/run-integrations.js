// The integrations a run receives — the author's and the channel's Composio identities, the
// toolbox tokens, the Make toolbox — resolved in ONE place for every caller that prepares an
// engine environment: a chat turn (run.js) and an interactive SSH session (ssh-session.js), which
// must be the same environment or "it works in Slack but not over SSH" is the bug. Moved out of
// run.js verbatim; run.js re-exports the Composio resolvers so their existing importers stay put.
import { getComposioToken, getToolboxToken, isAdmin, isApproved } from "../config/store.js";
import { getComposioMode, getDefaultComposioToken, getDefaultToolboxToken } from "../config/settings.js";
import { resolveSdkSession } from "../ee/composio-sdk.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { canManage } from "./modes.js";
import { resolveMakeToolboxRuntime } from "./make-toolbox.js";
import { resolveRunUserIdentity } from "./access-grants.js";
import { composioIdentitiesForRun, composioIdentityPreamble } from "./mcp.js";

export function resolveTokenSource({ clean, channelToken, userToken, defaultToken, noOrg }) {
  if (clean) return { token: "", source: "clean" };
  if (channelToken) return { token: channelToken, source: "channel" };
  if (userToken) return { token: userToken, source: "user" };
  if (!noOrg && defaultToken) return { token: defaultToken, source: "org" };
  return { token: "", source: noOrg ? "none-no-org-default" : "none" };
}

// Composio is intentionally different from the other token-backed integrations: expose the active
// author's identity and the gateway's shared identity at the same time instead of choosing one.
// `composio-user` is personal-only; shared `composio` is channel-first, then org-default.
// A DM is a private, one-person conversation: there is no shared audience to act on behalf of, so
// the shared identity (channel token AND the org default) is suppressed there and only the
// author's personal `composio-user` is injected. Everything else keeps both identities.
export function resolveComposioConnections({ clean = false, userToken = "", channelToken = "", defaultToken = "", noOrg = false, isDM = false } = {}) {
  if (clean) {
    return {
      user: { token: "", source: "clean" },
      shared: { token: "", source: "clean" },
    };
  }
  const user = { token: userToken || "", source: userToken ? "user" : "none" };
  if (isDM) return { user, shared: { token: "", source: "none-dm" } };
  return {
    user,
    shared: channelToken
      ? { token: channelToken, source: "channel" }
      : !noOrg && defaultToken
        ? { token: defaultToken, source: "org" }
        : { token: "", source: noOrg ? "none-no-org-default" : "none" },
  };
}

export async function resolveComposioRuntime({
  clean = false,
  mode = "personal",
  workspaceId = "",
  channelId = "",
  authorId = "",
  threadKey = "",
  meta = {},
  authorIsAdmin = false,
  authorIsApproved = false,
  userToken = "",
  channelToken = "",
  defaultToken = "",
  noOrg = false,
  isDM = false,
  principalTrusted = true,
  resolveSdk = resolveSdkSession,
} = {}) {
  if (clean || mode !== "sdk") {
    const legacy = resolveComposioConnections({
      clean,
      userToken: principalTrusted ? userToken : "",
      channelToken,
      defaultToken,
      noOrg,
      isDM,
    });
    return {
      mode: mode === "sdk" ? "sdk" : "personal",
      user: { ...legacy.user, endpoint: null },
      shared: { ...legacy.shared, endpoint: null },
    };
  }

  requireComposioSdkEntitlement();
  const mayManageShared = principalTrusted && canManage(meta, {
    authorId,
    isAdminUser: authorIsAdmin,
    isApprovedUser: authorIsApproved,
  });
  const [userResult, sharedResult] = await Promise.allSettled([
    principalTrusted ? resolveSdk({
      workspaceId,
      kind: "user",
      id: authorId,
      threadKey,
      accessKind: "owner",
      manageConnections: true,
    }) : null,
    // Same rule as personal mode: a DM has no shared audience, so no channel session is minted.
    isDM
      ? null
      : resolveSdk({
        workspaceId,
        kind: "channel",
        id: channelId,
        threadKey,
        accessKind: mayManageShared ? "manager" : "member",
        manageConnections: mayManageShared,
      }),
  ]);

  return {
    mode: "sdk",
    user: !principalTrusted
      ? { token: "", source: "none-untrusted-principal", endpoint: null }
      : userResult.status === "fulfilled"
      ? { token: "", source: "sdk-user", endpoint: userResult.value }
      : { token: "", source: "sdk-unavailable", endpoint: null },
    shared: isDM
      ? { token: "", source: "none-dm", endpoint: null }
      : sharedResult.status === "fulfilled"
        ? { token: "", source: "sdk-channel", endpoint: sharedResult.value }
        : { token: "", source: "sdk-unavailable", endpoint: null },
  };
}

/**
 * Everything a run's MCP payload and prompt need to know about its integrations. `untrustedPrincipal`
 * withholds the PERSONAL identity (the HTTP run API authenticates its key, not the author it names);
 * `clean` (Lean) resolves nothing. Returns the tokens themselves — the caller redacts them out of
 * its output — plus the one-line identity preamble the prompt carries.
 */
export async function resolveRunIntegrations({ meta = {}, channelId = "", authorId = "", threadKey = "", workspaceId = "", clean = false, untrustedPrincipal = false } = {}) {
  const noOrg = Boolean(meta.noDefaultTokens);
  const composioMode = getComposioMode();
  const effectiveWorkspaceId = String(workspaceId || process.env.CG_SLACK_TEAM_ID || "").trim();
  // The HTTP API authenticates its API key, not the caller-supplied Slack author id. Never use
  // that untrusted id to read a personal connector token or infer admin/approval state. Shared
  // channel/org identities remain available; the user identity is intentionally absent.
  const userIdentity = await resolveRunUserIdentity({
    authorId,
    untrustedPrincipal,
    needsApproval: composioMode === "sdk" && !clean,
    loadComposioToken: getComposioToken,
    loadToolboxToken: getToolboxToken,
    loadIsAdmin: isAdmin,
    loadIsApproved: isApproved,
  });
  const composio = await resolveComposioRuntime({
    clean,
    mode: composioMode,
    workspaceId: effectiveWorkspaceId,
    channelId,
    authorId,
    threadKey,
    meta,
    authorIsAdmin: userIdentity.isAdmin,
    authorIsApproved: userIdentity.isApproved,
    principalTrusted: !untrustedPrincipal,
    channelToken: meta.composioToken,
    userToken: userIdentity.composioToken,
    defaultToken: getDefaultComposioToken(),
    noOrg,
    isDM: Boolean(meta.isDM || meta.type === "im"),
  });
  const toolbox = resolveTokenSource({ clean, channelToken: meta.toolboxToken, userToken: userIdentity.toolboxToken, defaultToken: getDefaultToolboxToken(), noOrg });
  const composioUserToken = composio.user.token;
  const composioToken = composio.shared.token;
  const composioUserEndpoint = composio.user.endpoint;
  const composioEndpoint = composio.shared.endpoint;
  // The per-run half of the identity rule (CO-04: "check the calendar" with both identities present
  // read the SHARED one and posted a colleague's week into the channel, where the other harness
  // asked first). The managed instructions block carries the rule; this one line carries the fact
  // it applies to — WHICH identities this turn received — which only a per-run prompt can say,
  // since `composio-user` is per author. Empty when the run injects neither (clean mode, no tokens),
  // so a channel without Composio pays nothing for it.
  const identities = composioIdentitiesForRun({
    clean,
    principalTrusted: !untrustedPrincipal,
    composioUserEndpoint,
    composioUserToken,
    composioEndpoint,
    composioToken,
  });
  const { makeToolboxUrl, makeToolboxKey } = resolveMakeToolboxRuntime({
    makeToolboxUrl: meta.makeToolboxUrl,
    makeToolboxKey: meta.makeToolboxKey,
    clean,
  });
  return {
    userIdentity, composio, toolbox, identities,
    composioUserToken, composioToken, composioUserEndpoint, composioEndpoint, toolboxToken: toolbox.token,
    makeToolboxUrl, makeToolboxKey,
    composioIdentityPrefix: composioIdentityPreamble(identities),
  };
}
