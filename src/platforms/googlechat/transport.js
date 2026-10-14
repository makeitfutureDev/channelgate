// Wiring: credentials → Chat API + Pub/Sub puller + connector, started and stopped as one unit.
import { createHash } from "node:crypto";
import { createDurableInbox } from "../durable-inbox.js";
import { createGoogleAuth } from "./auth.js";
import { createChatApi, isSpaceName, isMessageName, isThreadName } from "./api.js";
import { createPubSubPuller } from "./pubsub.js";
import { parseChatEvent, normalizeMessage, normalizeCardEvent, createSeenThreads, messageCommandText, GOOGLE_CHAT_CONTROL_COMMAND } from "./events.js";
import { createGoogleChatConnector } from "./connector.js";
import { sessionKeyForMessage } from "../reply-sessions.js";
import { getDb, fromJson } from "../../db/index.js";

export async function startGoogleChat({
  serviceAccountJson,
  subscription,
  botUserId = "",
  capabilities,
  onMessage,
  onCard = null,
  onStop = null,
  onBotUserId = null,
  onFatal = null,
  log = console,
  deps = {},
} = {}) {
  if (typeof onMessage !== "function") throw new TypeError("startGoogleChat requires an onMessage handler");
  const auth = deps.auth || createGoogleAuth({ serviceAccount: serviceAccountJson });
  // Mint a token before declaring the transport connected. A bad key otherwise surfaces as a quiet
  // pull loop that never delivers anything, which is the least debuggable failure available.
  await auth.token();

  const api = deps.api || createChatApi({ auth });
  let selfId = String(botUserId || "");
  const connector = deps.connector || createGoogleChatConnector({ auth, capabilities, api, botUserId: selfId, log });
  const seenThreads = createSeenThreads();
  const namespace = `googlechat:${subscription}`;
  const controlNamespace = `googlechat-controls:${subscription}`;
  const isControl = event => event.type === 'card'
    || GOOGLE_CHAT_CONTROL_COMMAND.test(messageCommandText(event.message, { appCommand: event.appCommand }));
  const inboundFor = ({ event, botId, threadKey }) => {
    const message = normalizeMessage(event, { botUserId: botId, api });
    return threadKey === undefined ? message : { ...message, threadKey };
  };
  const queueKey = payload => {
    if (payload.event.type === 'card') {
      const card = normalizeCardEvent(payload.event);
      return card ? JSON.stringify([card.conversationId, card.threadKey]) : null;
    }
    const message = inboundFor(payload);
    return JSON.stringify([message.conversationId, sessionKeyForMessage(message)]);
  };
  const inboxOptions = {
    conversationKey: queueKey,
    handle: async payload => {
      if (payload.event.type === 'card') {
        const card = normalizeCardEvent(payload.event);
        if (card) await onCard?.(card);
      } else await onMessage(inboundFor(payload));
    },
    interrupted: async payload => {
      const card = payload.event.type === 'card';
      const message = card ? normalizeCardEvent(payload.event) : inboundFor(payload);
      if (!message) return;
      // A button click concerns only its clicker; never announce it to the whole space.
      const viewer = card ? message.userResourceName : '';
      await connector.post({ conversationId: message.rawConversationId || message.conversationId, threadKey: message.threadKey,
        ...(card && /^users\/[A-Za-z0-9_-]+$/.test(viewer) ? { ephemeralTo: viewer } : {}),
        text: card
          ? "Your button action was interrupted by a gateway restart before its outcome could be confirmed. Reopen the controls to check the current state before trying again."
          : "This request was interrupted before its outcome could be confirmed. External actions may already have happened. Inspect the task before retrying; it was not run again automatically." });
    },
    log,
  };
  const inbox = deps.inbox || (deps.createInbox || createDurableInbox)({
    ...inboxOptions, namespace,
    queuedNamespace: payload => isControl(payload.event) ? controlNamespace : null,
  });
  const controlInbox = deps.controlInbox || (deps.createInbox || createDurableInbox)({
    ...inboxOptions, namespace: controlNamespace, concurrencyGroup: "platform-controls",
  });
  const noticeInbox = deps.noticeInbox || (deps.createInbox || createDurableInbox)({
    namespace: `googlechat-queue-notices:${subscription}`, concurrencyGroup: 'platform-events',
    handle: async ({ payload, eventId, position }) => {
      const isQueued = () => getDb().prepare("SELECT 1 FROM inbound_events WHERE namespace = ? AND event_id = ? AND status = 'queued'").get(namespace, eventId);
      if (isQueued()) await onMessage(inboundFor(payload), { queuedNoticeOnly: true, position, isQueued });
    },
    // Queue notices have no engine effects; an interrupted, obsolete position can be omitted.
    log,
  });
  const pendingRows = (conversationId, sessionKey) => getDb().prepare(`SELECT event_id, data FROM inbound_events
    WHERE namespace = ? AND conversation_id = ? AND status = 'queued' ORDER BY rowid`)
    .all(namespace, JSON.stringify([conversationId, sessionKey]));
  connector.pendingForSession = async ({ conversationId, sessionKey, isEligible = async () => true }) => {
    const eligible = [];
    for (const row of pendingRows(conversationId, sessionKey)) {
      const message = inboundFor(fromJson(row.data, {}));
      if (await isEligible(message)) eligible.push(message);
    }
    return { count: eligible.length, authors: [...new Set(eligible.map(m => m.userId))] };
  };
  connector.cancelPendingForSession = async ({ conversationId, sessionKey, authorId, authorIsAdmin, isEligible = async () => true }) => {
    const eligibility = new Map();
    for (const row of pendingRows(conversationId, sessionKey)) eligibility.set(row.event_id, await isEligible(inboundFor(fromJson(row.data, {}))));
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = pendingRows(conversationId, sessionKey);
      if (rows.some(row => !eligibility.has(row.event_id))) { db.exec('ROLLBACK'); return { allowed: false, changed: true, cancelled: 0 }; }
      if (!authorIsAdmin && rows.some(row => eligibility.get(row.event_id) && inboundFor(fromJson(row.data, {})).userId !== authorId)) {
        db.exec('ROLLBACK'); return { allowed: false, cancelled: 0 };
      }
      const cancel = db.prepare("UPDATE inbound_events SET status = 'done', data = '{}' WHERE namespace = ? AND event_id = ? AND status = 'queued'");
      let cancelled = 0;
      for (const row of rows) cancelled += Number(cancel.run(namespace, row.event_id).changes);
      db.exec('COMMIT');
      return { allowed: true, cancelled };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };

  async function onEvent(envelope, attributes, metadata = {}) {
    const event = parseChatEvent(envelope, attributes);
    if (event.type === "membership.added") {
      // The app's own users/NNN id, learned the first time it is added to a space. It is what makes
      // mention detection exact rather than "any bot mention counts".
      const member = event.membership?.member || {};
      if (member.type === "BOT" && member.name && member.name !== selfId) {
        selfId = String(member.name);
        onBotUserId?.(selfId);
        log.info?.(`[googlechat] learned bot user id ${selfId}`);
      }
      return;
    }
    if (event.type === 'card') {
      const card = normalizeCardEvent(event);
      if (!card || !onCard) return;
      const id = String(metadata.messageId || attributes?.['ce-id'] || createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
      const payload = { event, botId: selfId };
      return controlInbox.accept({ id: `card:${id}`, conversationId: queueKey(payload), payload });
    }
    if (event.type !== "message") return;

    const sender = event.message?.sender || {};
    // Never answer a bot — our own replies come back on the same topic, and two apps in one space
    // answering each other is an unbounded loop with a bill attached.
    if (sender.type === "BOT") return;
    const space = String(event.space?.name || event.message?.space?.name || '');
    const messageName = String(event.message?.name || '');
    const threadName = String(event.message?.thread?.name || '');
    if (!isSpaceName(space) || !isMessageName(messageName) || !messageName.startsWith(`${space}/messages/`)
      || (threadName && (!isThreadName(threadName) || !threadName.startsWith(`${space}/threads/`)))) return;
    const id = String(event.message?.name || metadata.messageId || createHash("sha256").update(JSON.stringify(envelope)).digest("hex"));
    const message = normalizeMessage(event, { botUserId: selfId, seen: seenThreads, api });
    const payload = { event, botId: selfId, threadKey: message.threadKey };
    const control = isControl(event);
    const conversationId = queueKey(payload);
    const position = control ? 0 : Number(getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace = ? AND conversation_id = ? AND status IN ('queued', 'running')")
      .get(namespace, conversationId).n);
    const accepted = (control ? controlInbox : inbox).accept({ id, conversationId, payload });
    if (position && accepted?.accepted) {
      try { noticeInbox.accept({ id, conversationId, payload: { payload, eventId: id, position } }); }
      catch (error) { log.warn?.(`[googlechat] queue notice could not be accepted: ${error?.message || error}`); }
    }
    return accepted;
  }

  const puller = deps.puller || createPubSubPuller({ auth, subscription, onEvent, log, fetchImpl: deps.fetchImpl,
    onFatal: (err) => {
      inbox.stop();
      controlInbox.stop();
      noticeInbox.stop();
      onStop?.();
      log.error?.(`[googlechat] transport stopped: ${err?.message || err}`);
      onFatal?.(err);
    } });
  inbox.start();
  controlInbox.start();
  noticeInbox.start();
  try { puller.start(); } catch (error) { inbox.stop(); controlInbox.stop(); noticeInbox.stop(); onStop?.(); throw error; }

  return {
    platform: "googlechat",
    connector,
    puller,
    // Exposed because it IS the transport's behaviour: bot-filtering, dedupe, learning our own user
    // id, normalization. Tests drive it directly, and the documented HTTP-endpoint mode (the
    // alternative to a Pub/Sub connection) would feed the identical handler.
    onEvent,
    get botUserId() { return selfId; },
    detail: `pulling ${subscription}`,
    async stop() { inbox.stop(); controlInbox.stop(); noticeInbox.stop(); onStop?.(); await puller.stop(); },
  };
}
