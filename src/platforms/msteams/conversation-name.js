// Teams often omits conversation.name on channel messages. Resolve the two human names
// through the existing Bot Framework login, preserving the native IDs for routing.
import { createTeamsApi, isConversationId, validateServiceUrl } from "./api.js";

const part = value => String(value || "").trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
export function teamsChannelName(teamName, channelName) {
  const team = part(teamName);
  const channel = part(channelName);
  return team && channel ? `${team}-${channel}` : "";
}

export function activityConversationName(activity = {}) {
  if (String(activity.conversation?.conversationType).toLowerCase() !== "channel") return String(activity.conversation?.name || "");
  return teamsChannelName(activity.channelData?.team?.name, activity.channelData?.channel?.name || activity.conversation?.name);
}

export function createTeamsConversationNameResolver({ auth, apiForServiceUrl, now = Date.now } = {}) {
  const cache = new Map();
  return async message => {
    if (message.kind !== "channel") return message.conversationName || "";
    const activity = message.raw?.activity || message.raw?.context || {};
    const direct = activityConversationName(activity);
    if (direct) return direct;
    const data = activity.channelData || {};
    const teamId = String(data.team?.id || "");
    const channelId = String(data.channel?.id || message.rawConversationId || "");
    const serviceUrl = validateServiceUrl(activity.serviceUrl);
    if (!isConversationId(teamId) || !isConversationId(channelId) || !serviceUrl) return "";
    const key = `${serviceUrl}|${teamId}`;
    let hit = cache.get(key);
    if (!hit || hit.until <= now()) {
      // Cache in-flight reads as well as results; large teams can message concurrently.
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      hit = { until: now() + 30_000 };
      hit.result = (async () => {
        const signal = AbortSignal.timeout(8_000);
        const api = apiForServiceUrl?.(serviceUrl) || createTeamsApi({ auth, serviceUrl,
          fetchImpl: (url, init) => fetch(url, { ...init, signal }) });
        const [team, channels] = await Promise.allSettled([
          Promise.resolve().then(() => api.teamInfo(teamId)),
          Promise.resolve().then(() => api.listChannels(teamId)),
        ]);
        const teamName = team.status === "fulfilled" ? team.value?.name || "" : "";
        const list = channels.status === "fulfilled" && Array.isArray(channels.value) ? channels.value : [];
        if (teamName && channels.status === "fulfilled") hit.until = now() + 5 * 60_000;
        return { teamName, channels: list };
      })();
      cache.set(key, hit);
    }
    const names = await hit.result;
    const channel = names.channels.find(item => item.id === channelId);
    // Bot Framework returns null for the default General channel (whose ID equals team ID).
    const channelName = data.channel?.name || activity.conversation?.name || channel?.name || (channel && channelId === teamId ? "General" : "");
    return teamsChannelName(data.team?.name || names.teamName, channelName);
  };
}
