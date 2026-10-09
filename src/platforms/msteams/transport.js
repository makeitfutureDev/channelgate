// Wiring: credentials → Bot Framework API + webhook handler + connector, as one startable unit.
//
// Note the asymmetry with Google Chat: there is nothing to "start" on the inbound side. Teams pushes
// to us, so the transport's job is to hold a verified handler that the Express app can route to and
// to prove the outbound credentials work before reporting itself connected.
import { createTeamsFileResolver } from "./files.js";
import { createHash, randomUUID } from "node:crypto";
import { createDurableInbox } from "../durable-inbox.js";
import { createTeamsGraphEvents } from "./graph-events.js";
import { createTeamsEventStore } from "./event-store.js";
import { normalizeGraphEvents } from "./graph-activity.js";
import { normalizeActivity, splitConversationId } from "./activity.js";
import { createTeamsAuth, GRAPH_SCOPE } from "./auth.js";
import { createTeamsApi, DEFAULT_SERVICE_URL, validateServiceUrl, isConversationId } from "./api.js";
import { createTeamsConnector } from "./connector.js";
import { createTeamsActivityDispatcher, createTeamsWebhook } from "./webhook.js";
import { activityFingerprint, createJwksCache } from "./verify.js";
import { teamsActivationFingerprint } from "./reactions.js";
import { sessionKeyForMessage } from "../reply-sessions.js";
import { getDb, fromJson } from "../../db/index.js";
import { logEvent } from "../../util/logger.js";

// The bot's own identity in an activity: Bot Framework prefixes the app id with the "28:" channel
// marker. Mention entities and the bot half of a new 1:1 conversation both use this form.
export const botIdFor = (appId) => (appId ? `28:${appId}` : "");

export async function startTeams({
  appId,
  appPassword,
  tenantId = "",
  serviceUrl = DEFAULT_SERVICE_URL,
  allMessageEvents = false,
  getActivationReactions = () => undefined,
  getActivationVersion = () => '',
  publicUrl = "",
  filesEnabled = false,
  fileDriveIds = [],
  capabilities,
  onMessage,
  onInvoke = null,
  onStop = null,
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
  const resolveFile = filesEnabled === true ? createTeamsFileResolver({
    auth: deps.graphAuth || createTeamsAuth({ clientId: appId, clientSecret: appPassword, tenantId, scope: GRAPH_SCOPE }),
    allowedDriveIds: fileDriveIds,
  }) : null;
  const connector = deps.connector || createTeamsConnector({ auth, capabilities, api, apiForServiceUrl: deps.apiForServiceUrl, botId, tenantId, serviceUrl, log });
  const jwks = deps.jwks || createJwksCache();
  let graph = null;
  let eventStore = null;
  let inbox = null;
  let notificationInbox = null;
  let dispatchInbox = null;
  let graphControlInbox = null;
  let noticeInbox = null;
  const graphEventsEnabled = allMessageEvents === true;
  const queueKey = inbound => JSON.stringify([inbound.conversationId, sessionKeyForMessage(inbound)]);
  const botNamespace = `msteams-bot:${appId}`;
  const graphNamespace = `msteams-graph-dispatch:${appId}`;
  function queuePosition(conversationId) {
    return getDb().prepare(`SELECT count(*) AS n FROM inbound_events
      WHERE namespace IN (?, ?) AND conversation_id = ? AND status IN ('queued', 'running')`)
      .get(botNamespace, graphNamespace, conversationId).n;
  }
  function pendingRows(conversationId, sessionKey) {
    return getDb().prepare(`SELECT namespace, event_id, data FROM inbound_events
      WHERE namespace IN (?, ?) AND conversation_id = ? AND status = 'queued' ORDER BY rowid`)
      .all(botNamespace, graphNamespace, JSON.stringify([conversationId, sessionKey]));
  }
  const pendingAuthor = row => {
    const payload = fromJson(row.data, {});
    return payload.activity?.from?.id || payload.inbound?.userId || "";
  };
  const pendingInbound = row => {
    const payload = fromJson(row.data, {});
    return payload.inbound || normalizeActivity(payload.activity, { botId, activationReactions: getActivationReactions() });
  };
  connector.pendingForSession = async ({ conversationId, sessionKey, isEligible = async () => true }) => {
    const rows = pendingRows(conversationId, sessionKey);
    const eligible = [];
    for (const row of rows) if (await isEligible(pendingInbound(row))) eligible.push(row);
    return { count: eligible.length, authors: [...new Set(eligible.map(pendingAuthor))] };
  };
  connector.cancelPendingForSession = async ({ conversationId, sessionKey, authorId, authorIsAdmin, isEligible = async () => true }) => {
    const eligibility = new Map();
    for (const row of pendingRows(conversationId, sessionKey)) {
      eligibility.set(`${row.namespace}:${row.event_id}`, await isEligible(pendingInbound(row)));
    }
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = pendingRows(conversationId, sessionKey);
      // Admission lookups happen outside the transaction. If another row appeared during them,
      // refuse this attempt rather than cancel an author whose current authority is unknown.
      if (rows.some(row => !eligibility.has(`${row.namespace}:${row.event_id}`))) {
        db.exec("ROLLBACK");
        return { allowed: false, changed: true, cancelled: 0 };
      }
      if (!authorIsAdmin && rows.some(row => eligibility.get(`${row.namespace}:${row.event_id}`) && pendingAuthor(row) !== authorId)) {
        db.exec("ROLLBACK");
        return { allowed: false, cancelled: 0 };
      }
      const cancel = db.prepare("UPDATE inbound_events SET status = 'done', data = '{}' WHERE namespace = ? AND event_id = ? AND status = 'queued'");
      let cancelled = 0;
      for (const row of rows) cancelled += Number(cancel.run(row.namespace, row.event_id).changes);
      db.exec("COMMIT");
      return { allowed: true, cancelled };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  if (graphEventsEnabled) {
    if (!publicUrl || !tenantId) throw new Error("Teams all-message events require Public URL and tenant ID");
    const graphAuth = deps.graphAuth || createTeamsAuth({ clientId: appId, clientSecret: appPassword, tenantId, scope: GRAPH_SCOPE });
    const normalizer = deps.normalizeGraphEvents || normalizeGraphEvents;
    eventStore = deps.eventStore || createTeamsEventStore({ appId });
    const activeSubscription = async row => (await eventStore.list()).some(current =>
      current.conversationId === row.conversationId && current.startedAt === row.startedAt);
    const graphDispatchOptions = {
      conversationKey: ({ inbound }) => queueKey(inbound),
      handle: async ({ inbound, serviceUrl: sourceUrl, subscription }) => {
        if (!await activeSubscription(subscription)) return;
        if (inbound.reactionAction === 'engage') {
          const current = (await eventStore.list()).find(row => row.conversationId === subscription.conversationId);
          if (subscription.activationReactionsFingerprint === undefined
            || subscription.activationReactionsFingerprint !== teamsActivationFingerprint(getActivationReactions())
            || subscription.activationReactionsVersion !== getActivationVersion()
            || current?.activationReactionsVersion !== subscription.activationReactionsVersion
            || current?.activationReactionsFingerprint !== subscription.activationReactionsFingerprint
            || current?.activationReactionsStartedAt !== subscription.activationReactionsStartedAt) return;
        }
        if (resolveFile) inbound.attachments = (inbound.attachments || []).map(file => ({ ...file, download: file.reference ? resolveFile(file.reference) : null }));
        await onMessage(inbound, { serviceUrl: sourceUrl });
      },
      interrupted: async ({ inbound, serviceUrl: sourceUrl }) => {
        if (sourceUrl) connector.rememberServiceUrl?.(inbound.rawConversationId || inbound.conversationId, sourceUrl);
        await connector.post({ conversationId: inbound.conversationId, threadKey: inbound.threadKey,
          text: "A Teams edit or reaction request was interrupted before its outcome could be confirmed. Check the conversation before retrying; it was not run again automatically." });
      },
      log,
    };
    dispatchInbox = deps.graphDispatchInbox || (deps.createInbox || createDurableInbox)({
      ...graphDispatchOptions, namespace: graphNamespace,
      queuedNamespace: ({ inbound }) => ["stop", "ack"].includes(inbound?.reactionAction) ? `msteams-graph-controls:${appId}` : null,
    });
    graphControlInbox = deps.graphControlInbox || (deps.createInbox || createDurableInbox)({
      ...graphDispatchOptions, namespace: `msteams-graph-controls:${appId}`, concurrencyGroup: "platform-controls",
    });
    inbox = deps.graphInbox || (deps.createInbox || createDurableInbox)({
      namespace: `msteams-graph:${appId}`,
      concurrencyGroup: "platform-events",
      handle: async ({ message, row }) => {
        if (!await activeSubscription(row)) return;
        // Settings may have changed while a snapshot waited in the durable queue.
        row = await graph.refresh(row);
        if (!row) return;
        const nativeId = row.context.conversation.id;
        const rosterApi = deps.apiForServiceUrl?.(row.context.serviceUrl) || createTeamsApi({ auth, serviceUrl: row.context.serviceUrl });
        let roster;
        const resolveMember = async aadId => {
          roster ||= await rosterApi.listMembers(nativeId);
          return roster.find(member => member.aadObjectId === aadId) || null;
        };
        for (const inbound of await normalizer(message, row, { botId, resolveMember, activationReactions: getActivationReactions(), activationVersion: getActivationVersion() })) {
          if (!inbound.raw?.eventId) throw new Error("Teams Graph event requires stable identity");
          const selectedInbox = ["stop", "ack"].includes(inbound.reactionAction) ? graphControlInbox : dispatchInbox;
          const conversationId = queueKey(inbound);
          const position = selectedInbox === dispatchInbox ? queuePosition(conversationId) : 0;
          const accepted = selectedInbox.accept({ id: inbound.raw.eventId, conversationId,
            payload: { inbound, serviceUrl: row.context.serviceUrl, subscription: { conversationId: row.conversationId, startedAt: row.startedAt,
              activationReactionsFingerprint: row.activationReactionsFingerprint, activationReactionsVersion: row.activationReactionsVersion, activationReactionsStartedAt: row.activationReactionsStartedAt } } });
          if (position && accepted?.accepted) {
            try { noticeInbox.accept({ id: `graph:${inbound.raw.eventId}`, conversationId,
              payload: { inbound, namespace: graphNamespace, eventId: inbound.raw.eventId, serviceUrl: row.context.serviceUrl, position } }); }
            catch (error) { log.warn?.(`[msteams] queue notice could not be accepted: ${error?.message || error}`); }
          }
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
      concurrencyGroup: "platform-events",
      handle: async ({ accepted }) => graph.processNotifications(accepted),
      // Only reads and durable downstream accepts have happened. Retrying these is safe;
      // snapshot/event identities prevent repeating already accepted engine work.
      interrupted: async ({ accepted }) => graph.processNotifications(accepted),
      log,
    });
    graph = (deps.createGraphEvents || createTeamsGraphEvents)({
      auth: graphAuth, notificationUrl: `${publicUrl.replace(/\/$/, "")}/api/teams/notifications`, tenantId,
      store: eventStore, getActivationReactions, getActivationVersion,
      enqueueNotifications: async accepted => {
        for (const envelope of accepted) {
          notificationInbox.accept({ id: randomUUID(), conversationId: envelope.row.conversationId,
            payload: { accepted: [envelope] } });
        }
      },
      observe: deps.observeGraph || logEvent,
      log: (message, detail) => log.warn?.(`[msteams] ${message} ${JSON.stringify(detail)}`),
      onMessage: async (message, row) => {
        const id = createHash("sha256").update(JSON.stringify([row.conversationId, message.id, message.etag, message.lastModifiedDateTime, message])).digest("hex");
        inbox.accept({ id, conversationId: row.conversationId, payload: { message, row } });
      },
    });
    dispatchInbox.start();
    graphControlInbox.start();
    inbox.start();
    notificationInbox.start();
    graph.start();
  }
  async function onActivity(activity) {
    const trustedService = validateServiceUrl(activity.serviceUrl);
    const nativeId = splitConversationId(activity.conversation?.id).conversationId;
    if (trustedService && isConversationId(nativeId)) connector.rememberServiceUrl?.(nativeId, trustedService);
    if (!graph || !["message", "messageUpdate", "conversationUpdate", "installationUpdate"].includes(activity?.type)) return;
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
          ...(kind === "channel" ? { team: { ...(activity.channelData?.team?.name ? { name: activity.channelData.team.name } : {}), aadGroupId: teamGuid, ...(activity.channelData?.team?.id ? { id: activity.channelData.team.id } : {}) }, channel: { id: activity.channelData?.channel?.id || nativeId, ...(activity.channelData?.channel?.name ? { name: activity.channelData.channel.name } : {}) } } : {}) } },
    };
    // Subscription errors are retried by Graph maintenance and never block a normal bot turn.
    void graph.ensure(row).catch(() => log.warn?.("[msteams] could not register conversation event subscription"));
  }
  const botInboxOptions = {
    handle: createTeamsActivityDispatcher({ botId, onMessage, resolveFile, onActivity, graphEventsEnabled, getActivationReactions }),
    interrupted: async ({ activity, serviceUrl: sourceUrl }) => {
      const message = normalizeActivity(activity, { botId, activationReactions: getActivationReactions() });
      if (!message) return;
      // Both a failed handler and a restart may leave unknown external effects. Notify in the
      // original verified conversation instead of repeating the request automatically.
      if (sourceUrl) connector.rememberServiceUrl?.(message.rawConversationId, sourceUrl);
      await connector.post({ conversationId: message.rawConversationId, threadKey: message.threadKey,
        text: "This Teams request was interrupted before its outcome could be confirmed. External actions may already have happened. Inspect the task before retrying; it was not run again automatically." });
    },
    log,
  };
  const botInbox = deps.botInbox || (deps.createInbox || createDurableInbox)({
    ...botInboxOptions, namespace: botNamespace,
  });
  const controlInbox = deps.botControlInbox || (deps.createInbox || createDurableInbox)({
    ...botInboxOptions, namespace: `msteams-bot-controls:${appId}`, concurrencyGroup: "platform-controls",
  });
  noticeInbox = deps.botNoticeInbox || (deps.createInbox || createDurableInbox)({
    namespace: `msteams-bot-queue-notices:${appId}`, concurrencyGroup: "platform-events",
    handle: async payload => {
      const isQueued = () => getDb().prepare("SELECT 1 FROM inbound_events WHERE namespace = ? AND event_id = ? AND status = 'queued'")
        .get(payload.namespace || botNamespace, payload.eventId || activityFingerprint(payload.activity));
      if (!isQueued()) return;
      if (payload.inbound) {
        await onMessage(payload.inbound, { serviceUrl: payload.serviceUrl, queuedNoticeOnly: true, position: payload.position, isQueued });
        return;
      }
      const dispatch = createTeamsActivityDispatcher({ botId, resolveFile, graphEventsEnabled, getActivationReactions,
        onMessage: (message, context) => onMessage(message, { ...context, queuedNoticeOnly: true, position: payload.position, isQueued }),
      });
      await dispatch(payload);
    },
    // A queue notice has no engine effects; if interrupted, omit an obsolete position report.
    log,
  });
  const handler = createTeamsWebhook({ appId, botId, onMessage, onInvoke, resolveFile, onActivity, graphEventsEnabled, jwks, log, getActivationReactions,
    acceptActivity: ({ activity, serviceUrl: sourceUrl }) => {
      const inbound = normalizeActivity(activity, { botId, activationReactions: getActivationReactions() });
      const isControl = inbound && (inbound.trigger === "reaction" ? ["stop", "ack"].includes(inbound.reactionAction)
        : /^\/(help|status|clear|stop|cancel|model|effort|settings|files|secrets|sendfile)(?:\s|$)/i.test(inbound.text));
      const selectedInbox = isControl ? controlInbox : botInbox;
      const conversationId = inbound ? queueKey(inbound)
        : splitConversationId(activity.conversation.id).conversationId;
      const position = !isControl && inbound ? queuePosition(conversationId) : 0;
      const accepted = selectedInbox.accept({ id: activityFingerprint(activity), conversationId,
        payload: { activity, serviceUrl: sourceUrl } });
      if (position && accepted?.accepted) {
        try { noticeInbox.accept({ id: activityFingerprint(activity), conversationId, payload: { activity, serviceUrl: sourceUrl, position } }); }
        catch (error) { log.warn?.(`[msteams] queue notice could not be accepted: ${error?.message || error}`); }
      }
      return accepted;
    },
  });
  botInbox.start();
  controlInbox.start();
  noticeInbox.start();

  return {
    platform: "msteams",
    connector,
    handler,
    graphHandler: graph?.handle || null,
    graphEventsEnabled,
    onActivity,
    botId,
    detail: `bot ${appId}`,
    async stop() { onStop?.(); botInbox.stop(); controlInbox.stop(); noticeInbox.stop(); notificationInbox?.stop(); inbox?.stop(); dispatchInbox?.stop(); graphControlInbox?.stop(); await graph?.stop(); },
  };
}
