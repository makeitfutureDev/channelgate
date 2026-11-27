// The Google Chat half of the agent directory seam (src/gateway/agent-directory*.js,
// src/gateway/agent-mail.js): live space metadata and a COMPLETE membership roster, nothing else.
// Never message history.
//
// Identity: gateway users on Google Chat are keyed by e-mail, while the Chat API names a member
// only as `users/NNN`. Every person the gateway has seen carries that resource name on their record
// (`googleChatUserName`, recorded by the transport on each message), so a member maps to the
// gateway id it uniquely belongs to and stays `users/NNN` otherwise — never a guess. The app's
// own membership is listed as `users/app` (Chat's alias for the calling app; the API omits app
// memberships), so a one-to-one DM reads as the requester plus the app, like a Slack IM roster.
import { isSpaceName, isUserName } from "./api.js";

export const GOOGLE_CHAT_APP_MEMBER = "users/app";

function spaceKind(space) {
  const type = String(space?.spaceType || "").toUpperCase();
  const legacy = String(space?.type || "").toUpperCase();
  if (type === "DIRECT_MESSAGE" || legacy === "DM" || space?.singleUserBotDm === true) return "im";
  if (type === "GROUP_CHAT") return "mpim";
  if (type === "SPACE" || legacy === "ROOM") {
    // Only a space discoverable across the organization is "public"; anything else — including a
    // response without access settings — is treated as private.
    return String(space?.accessSettings?.accessState || "").toUpperCase() === "DISCOVERABLE" ? "channel" : "group";
  }
  return "";
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

async function defaultLoadUsers() {
  const { getUsers } = await import("../../config/store.js");
  return getUsers();
}

// users/NNN → gateway user id, for resource names that belong to exactly one recorded user.
function identityMap(users = {}) {
  const map = new Map();
  const ambiguous = new Set();
  for (const [id, record] of Object.entries(users || {})) {
    const resource = record?.googleChatUserName;
    if (!isUserName(resource)) continue;
    if (map.has(resource)) ambiguous.add(resource);
    else map.set(resource, id);
  }
  for (const resource of ambiguous) map.delete(resource);
  return map;
}

export function createGoogleChatAgentDirectory({ api, loadUsers = defaultLoadUsers, maxMemberPages = 10 } = {}) {
  if (!api?.getSpace || !api?.listMemberships) throw new TypeError("Google Chat agent directory needs getSpace and listMemberships");
  return {
    async describeConversation({ conversationId }) {
      const name = String(conversationId || "");
      if (!isSpaceName(name)) return null;
      const space = await api.getSpace(name);
      if (!space || space.name !== name) return null;
      const type = spaceKind(space);
      if (!type) return null;
      return {
        name: String(space.displayName || ""),
        purpose: String(space.spaceDetails?.description || ""),
        topic: String(space.spaceDetails?.guidelines || ""),
        url: httpsUrl(space.spaceUri),
        type,
        isDM: type === "im",
        isGroupDM: type === "mpim",
        private: type !== "channel",
        // A space that admits people from outside the organization can gain readers no roster
        // shows today, exactly like a Slack Connect channel.
        shared: space.externalUserAllowed === true,
        archived: false,
      };
    },

    async conversationMembers({ conversationId }) {
      const name = String(conversationId || "");
      if (!isSpaceName(name)) return null;
      const memberships = await api.listMemberships(name, { maxPages: maxMemberPages });
      if (!Array.isArray(memberships)) return null;
      const identities = identityMap(await loadUsers());
      const members = new Set([GOOGLE_CHAT_APP_MEMBER]);
      for (const membership of memberships) {
        // A Google Group member brings readers the roster cannot enumerate: no proof possible.
        if (membership?.groupMember) return null;
        const state = String(membership?.state || "JOINED").toUpperCase();
        if (state !== "JOINED") continue;
        const member = membership?.member || {};
        if (String(member.type || "").toUpperCase() === "BOT") continue;
        if (!isUserName(member.name)) return null;
        members.add(identities.get(member.name) || member.name);
      }
      return [...members];
    },
  };
}
