// The Activity dashboard's Settings → API tokens section: which conversations the viewer may hold
// a run API token in, the tokens of one of them, minting one and revoking one.
//
// Access is the dashboard's own rule (accessContext().allows — the viewer is authorized there by
// isAuthorized and, for a private conversation, still a member), re-checked on every request by
// checkedChannel; a DM is only ever the viewer's own. Inside a conversation the decision is the one
// every surface shares (src/gateway/api-tokens.js): your own tokens, or every token for a channel
// manager or an admin. A token is always minted for the SESSION owner — never a browser-named one.
import { listChannels, getChannelMeta, getUser } from "../config/store.js";
import { canManage } from "./modes.js";
import { checkedChannel } from "./automations-view.js";
import { conversationTokensFor, createApiToken, curlExample, revokeConversationToken } from "./api-tokens.js";
import { platformOfConversation } from "../platforms/ids.js";
import { activityChannelName } from "../slack/home-threads.js";
import { getPublicUrl } from "../config/settings.js";
import { logEvent } from "../util/logger.js";

const isDM = (entry) => Boolean(entry?.isDM || entry?.type === "im" || /^D[A-Z0-9]+$/.test(entry?.channelId || ""));

async function managerHere(access, userId, entry) {
  const meta = (await getChannelMeta(entry.slug)) || {};
  return canManage(meta, { authorId: userId, isAdminUser: access.user?.isAdmin === true, isApprovedUser: access.user?.approved === true });
}

const PUBLIC_FIELDS = ["id", "name", "prefix", "last4", "createdBy", "createdAt", "lastUsedAt", "revokedAt", "revoked"];
const publicToken = (token, userId) => ({ ...Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, token[key]])), mine: token.createdBy === userId });

// The conversations the viewer may open, their own DM first, each with how many active tokens
// the viewer sees there.
export async function apiTokenChannels(access, userId) {
  const rows = [];
  const entries = (await listChannels()).filter((entry) => platformOfConversation(entry.channelId) === "slack");
  // Membership checks for private conversations are Slack calls: a few at a time.
  for (let i = 0; i < entries.length; i += 8) {
    const batch = await Promise.all(entries.slice(i, i + 8).map(async (entry) => {
      if (!await access.allows(entry)) return null;
      const dm = isDM(entry);
      if (dm) {
        const meta = await getChannelMeta(entry.slug);
        if (meta?.dmUserId && meta.dmUserId !== userId) return null; // only the viewer's OWN DM
      }
      const manager = await managerHere(access, userId, entry);
      const count = conversationTokensFor({ channelId: entry.channelId, userId, manager, includeRevoked: false }).length;
      const name = dm ? "Your direct messages" : `#${String(await activityChannelName(entry)).replace(/^#+/, "")}`;
      return { channelId: entry.channelId, name, personal: dm, count };
    }));
    rows.push(...batch.filter(Boolean));
  }
  return rows.sort((a, b) => Number(b.personal) - Number(a.personal) || b.count - a.count || a.name.localeCompare(b.name));
}

export async function apiTokenChannelView(access, userId, channelId) {
  const entry = await checkedChannel(access, userId, channelId);
  const manager = await managerHere(access, userId, entry);
  return {
    manager,
    tokens: await Promise.all(conversationTokensFor({ channelId: entry.channelId, userId, manager, includeRevoked: false }).map(async (token) => ({
      ...publicToken(token, userId),
      createdByName: token.createdBy === userId ? "" : String((await getUser(token.createdBy).catch(() => null))?.name || ""),
    }))),
    example: curlExample(getPublicUrl()),
  };
}

// → { token, record, example }. `token` is the only time the value exists in clear; the caller
// returns it in this one response and nowhere else.
export async function createDashboardApiToken(access, userId, channelId, name, { authorize = async () => {} } = {}) {
  const entry = await checkedChannel(access, userId, channelId);
  await authorize();
  const minted = createApiToken({ name, channelId: entry.channelId, slug: entry.slug, createdBy: userId });
  await logEvent("api_token_created", { channel: entry.channelId, slug: entry.slug, id: minted.record.id, name: minted.record.name, author: userId, via: "dashboard" });
  return { token: minted.token, record: publicToken(minted.record, userId), example: curlExample(getPublicUrl(), minted.token) };
}

export async function revokeDashboardApiToken(access, userId, channelId, id, { authorize = async () => {} } = {}) {
  const entry = await checkedChannel(access, userId, channelId);
  const manager = await managerHere(access, userId, entry);
  await authorize();
  const token = revokeConversationToken({ id, channelId: entry.channelId, userId, manager });
  await logEvent("api_token_revoked", { channel: entry.channelId, slug: entry.slug, id: token.id, name: token.name, owner: token.createdBy, author: userId, via: "dashboard" });
  return publicToken(token, userId);
}
