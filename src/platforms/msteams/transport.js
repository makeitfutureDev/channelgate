// Wiring: credentials → Bot Framework API + webhook handler + connector, as one startable unit.
//
// Note the asymmetry with Google Chat: there is nothing to "start" on the inbound side. Teams pushes
// to us, so the transport's job is to hold a verified handler that the Express app can route to and
// to prove the outbound credentials work before reporting itself connected.
import { createHash, randomUUID } from "node:crypto";
import { createDurableInbox } from "../durable-inbox.js";
import { createTeamsGraphEvents } from "./graph-events.js";
import { createTeamsEventStore } from "./event-store.js";
import { normalizeGraphEvents } from "./graph-activity.js";
import { splitConversationId } from "./activity.js";
import { createTeamsAuth, GRAPH_SCOPE } from "./auth.js";
import { createTeamsApi, DEFAULT_SERVICE_URL, validateServiceUrl, isConversationId } from "./api.js";
import { createTeamsConnector } from "./connector.js";
import { createTeamsWebhook } from "./webhook.js";
import { createJwksCache } from "./verify.js";

// The bot's own identity in an activity: Bot Framework prefixes the app id with the "28:" channel
// marker. Mention entities and the bot half of a new 1:1 conversation both use this form.
export const botIdFor = (appId) => (appId ? `28:${appId}` : "");

export async function startTeams({
  appId,
  appPassword,
  tenantId = "",
  serviceUrl = DEFAULT_SERVICE_URL,
  allMessageEvents = false,
  publicUrl = "",
  capabilities,
  onMessage,
  log = console,
  deps = {},
} = {}) {
  if (typeof onMessage !== "function") throw new TypeError("startTeams requires an onMessage handler");
  const auth = deps.auth || createTeamsAuth({ clientId: appId, clientSecret: appPassword, tenantId });
  // Same reason as the Chat side: fail at connect time with Entra's own error text rather than at
  // the first reply, hours later, in a channel.
  await auth.token();

  const api = deps.api || createTeamsApi({ auth, serviceUrl });
  const botId = botIdFor(appId);
  const connector = deps.connector || createTeamsConnector({ auth, capabilities, api, botId, tenantId, serviceUrl, log });
  const jwks = deps.jwks || createJwksCache();
  let graph = null;
  let eventStore = null;
  let inbox = null;
  let notificationInbox = null;
  let dispatchInbox = null;
  const graphEventsEnabled = allMessageEvents === true;
  if (graphEventsEnabled) {
    if (!publicUrl || !tenantId) throw new Error("Teams all-message events require Public URL and tenant ID");
    const graphAuth = deps.graphAuth || createTeamsAuth({ clientId: appId, clientSecret: appPassword, tenantId, scope: GRAPH_SCOPE });
    const normalizer = deps.normalizeGraphEvents || normalizeGraphEvents;
    eventStore = deps.eventStore || createTeamsEventStore({ appId });
    const activeSubscription = async row => (await eventStore.list()).some(current =>
      current.conversationId === row.conversationId && current.startedAt === row.startedAt);
    dispatchInbox = deps.graphDispatchInbox || (deps.createInbox || createDurableInbox)({
      namespace: `msteams-graph-dispatch:${appId}`,
      handle: async ({ inbound, serviceUrl: sourceUrl, subscription }) => {
        if (!await activeSubscription(subscription)) return;
        await onMessage(inbound, { serviceUrl: sourceUrl });
      },
      interrupted: async ({ inbound }) => {
        await connector.post({ conversationId: inbound.conversationId, threadKey: inbound.threadKey,
          text: "A Teams edit or reaction request was interrupted before its outcome could be confirmed. Check the conversation before retrying; it was not run again automatically." });
      },
      log,
    });
    inbox = deps.graphInbox || (deps.createInbox || createDurableInbox)({
      namespace: `msteams-graph:${appId}`,
      handle: async ({ message, row }) => {
        if (!await activeSubscription(row)) return;
        const nativeId = row.context.conversation.id;
        const rosterApi = deps.apiForServiceUrl?.(row.context.serviceUrl) || createTeamsApi({ auth, serviceUrl: row.context.serviceUrl });
        let roster;
        const resolveMember = async aadId => {
          roster ||= await rosterApi.listMembers(nativeId);
          return roster.find(member => member.aadObjectId === aadId) || null;
        };
        for (const inbound of await normalizer(message, row, { botId, resolveMember })) {
          if (!inbound.raw?.eventId) throw new Error("Teams Graph event requires stable identity");
          dispatchInbox.accept({ id: inbound.raw.eventId, conversationId: inbound.raw.eventId,
            payload: { inbound, serviceUrl: row.context.serviceUrl, subscription: { conversationId: row.conversationId, startedAt: row.startedAt } } });
        }
      },
      interrupted: async ({ row }) => {
        await connector.post({ conversationId: row.conversationId,
          text: "A Teams edit or reaction request was interrupted before its outcome could be confirmed. Check the conversation before retrying; it was not run again automatically." });
      },
      log,
    });
    notificationInbox = deps.graphNotificationInbox || (deps.createInbox || createDurableInbox)({
      namespace: `msteams-graph-notifications:${appId}`,
      handle: async ({ accepted }) => graph.processNotifications(accepted),
      // Only reads and durable downstream accepts have happened. Retrying these is safe;
      // snapshot/event identities prevent repeating already accepted engine work.
      interrupted: async ({ accepted }) => graph.processNotifications(accepted),
      log,
    });
    graph = (deps.createGraphEvents || createTeamsGraphEvents)({
      auth: graphAuth, notificationUrl: `${publicUrl.replace(/\/$/, "")}/api/teams/notifications`, tenantId,
      store: eventStore,
      enqueueNotifications: async accepted => {
        for (const envelope of accepted) {
          notificationInbox.accept({ id: randomUUID(), conversationId: envelope.row.conversationId,
            payload: { accepted: [envelope] } });
        }
      },
      log: (message, detail) => log.warn?.(`[msteams] ${message}`, detail),
      onMessage: async (message, row) => {
        const id = createHash("sha256").update(JSON.stringify([row.conversationId, message.id, message.etag, message.lastModifiedDateTime, message])).digest("hex");
        inbox.accept({ id, conversationId: row.conversationId, payload: { message, row } });
      },
    });
    dispatchInbox.start();
    inbox.start();
    notificationInbox.start();
    graph.start();
  }
  async function onActivity(activity) {
    if (!graph || !["message", "messageUpdate", "conversationUpdate", "installationUpdate"].includes(activity?.type)) return;
    const nativeId = splitConversationId(activity.conversation?.id).conversationId;
    const trustedService = validateServiceUrl(activity.serviceUrl);
    const activityTenant = activity.channelData?.tenant?.id || activity.conversation?.tenantId;
    if (!nativeId || !isConversationId(nativeId) || !trustedService || activityTenant !== tenantId) return;
    const removed = activity.type === "installationUpdate" && ["remove", "remove-upgrade"].includes(activity.action)
      || activity.type === "conversationUpdate" && activity.membersRemoved?.some(member => member.id === botId);
    if (removed) {
      const removedTeam = activity.channelData?.team || {};
      const affected = new Set([`teams:${nativeId}`]);
      if (activity.conversation?.conversationType === "channel" && (removedTeam.id || removedTeam.aadGroupId)) {
        for (const row of await eventStore.list()) {
          const savedTeam = row.context?.channelData?.team;
          if (savedTeam && (removedTeam.id && savedTeam.id === removedTeam.id
            || removedTeam.aadGroupId && savedTeam.aadGroupId === removedTeam.aadGroupId)) affected.add(row.conversationId);
        }
      }
      for (const conversationId of affected) await graph.remove(conversationId);
      return;
    }
    const kind = activity.conversation?.conversationType;
    let resource;
    let teamGuid = "";
    if (kind === "channel") {
      let team = activity.channelData?.team?.aadGroupId;
      if (!team && activity.channelData?.team?.id) {
        try {
          const rosterApi = deps.apiForServiceUrl?.(trustedService) || createTeamsApi({ auth, serviceUrl: trustedService });
          const info = await rosterApi.teamInfo(activity.channelData.team.id);
          team = info?.aadGroupId || info?.groupId;
        } catch { log.warn?.("[msteams] team identity unavailable for Graph event subscription"); return; }
      }
      const channel = activity.channelData?.channel?.id || nativeId;
      if (!team || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(team) || !isConversationId(channel)) return;
      teamGuid = team;
      resource = `/teams/${encodeURIComponent(team)}/channels/${encodeURIComponent(channel)}/messages`;
    } else if (kind === "groupChat" || kind === "groupchat") {
      resource = `/chats/${encodeURIComponent(nativeId)}/messages`;
    } else return;
    const row = {
      conversationId: `teams:${nativeId}`, resource,
      context: { conversation: { id: nativeId, conversationType: kind, name: activity.conversation?.name || "" },
        serviceUrl: trustedService, recipient: { id: botId },
        channelData: { tenant: { id: tenantId },
          ...(kind === "channel" ? { team: { aadGroupId: teamGuid, ...(activity.channelData?.team?.id ? { id: activity.channelData.team.id } : {}) }, channel: { id: activity.channelData?.channel?.id || nativeId } } : {}) } },
    };
    // Subscription errors are retried by Graph maintenance and never block a normal bot turn.
    void graph.ensure(row).catch(() => log.warn?.("[msteams] could not register conversation event subscription"));
  }
  const handler = createTeamsWebhook({ appId, botId, onMessage, onActivity, graphEventsEnabled, jwks, log });

  return {
    platform: "msteams",
    connector,
    handler,
    graphHandler: graph?.handle || null,
    graphEventsEnabled,
    onActivity,
    botId,
    detail: `bot ${appId}`,
    async stop() { notificationInbox?.stop(); inbox?.stop(); dispatchInbox?.stop(); await graph?.stop(); },
  };
}
