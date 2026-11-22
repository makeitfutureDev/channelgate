// Wiring: credentials → Chat API + Pub/Sub puller + connector, started and stopped as one unit.
import { createHash } from "node:crypto";
import { createDurableInbox } from "../durable-inbox.js";
import { createGoogleAuth, CHAT_REACTION_EVENT_SCOPES } from "./auth.js";
import { createChatApi, isSpaceName, isMessageName, isThreadName } from "./api.js";
import { createPubSubPuller } from "./pubsub.js";
import { parseChatEvent, normalizeMessage, normalizeCardEvent, eventShape, createSeenThreads, messageCommandText, resolveThreadKey, GOOGLE_CHAT_CONTROL_COMMAND } from "./events.js";
import { createGoogleChatConnector } from "./connector.js";
import { sessionKeyForMessage } from "../reply-sessions.js";
import { makeInbound } from "../inbound.js";
import { attachQueuedEventControls } from "../queued-events.js";
import { GOOGLE_CHAT_QUEUE_LANE } from "./queue-controls.js";
import { getDb, fromJson, metaGet, metaSet } from "../../db/index.js";
import { getUsers } from "../../config/store.js";
import { logEvent } from "../../util/logger.js";
import { isReactionEventType, parseReactionEvent, googleChatReactionAction, reactionIsFresh, resolveReactor, SUBSCRIPTION_LIFECYCLE_PREFIX } from "./reactions.js";
import { createWorkspaceEventsClient, createReactionSubscriptions } from "./workspace-events.js";
import { isMessageUpdateEventType, parseMessageUpdateEvent, editIsFresh, mentionsApp, editedArgumentText, appUserNameFromInteraction } from "./edits.js";
import { createGoogleJwks, verifyGoogleChatRequest, GOOGLE_OIDC_CERTS_URL, CHAT_SYSTEM_JWKS_URL } from "./verify.js";
import { createGoogleChatWebhook } from "./webhook.js";

export async function startGoogleChat({
  serviceAccountJson,
  subscription,
  botUserId = "",
  // A Pub/Sub topic enables reaction controls and the edit trigger: Workspace Events subscriptions
  // publish each space's reaction and message-update events there. It must be the topic the pulled
  // `subscription` is attached to.
  reactionTopic = "",
  // The HTTP endpoint (`<publicUrl>/api/googlechat/events`) is the connection setting that carries
  // card and button clicks. `appServiceAccount` is the add-on's per-project sender; `projectNumber`
  // is the audience of a standalone app configured with the "project number" authentication
  // audience. Empty endpoint + empty project number = the endpoint answers 503 with the remedy.
  endpointUrl = "",
  appServiceAccount = "",
  projectNumber = "",
  getActivationReactions = () => ["🤖"],
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
  // The app's own users/NNN id: the configured value, else the one learned earlier (kept across
  // restarts, because the edit trigger needs it exactly and membership events are rare).
  const selfKey = `googlechat_bot_user_id:${subscription}`;
  let selfId = String(botUserId || metaGet(selfKey) || "");
  const learnSelf = (name, how) => {
    if (!/^users\/[A-Za-z0-9_-]+$/.test(String(name || "")) || name === selfId) return;
    selfId = String(name);
    try { metaSet(selfKey, selfId); } catch (error) { log.warn?.(`[googlechat] bot user id not saved: ${error?.message || error}`); }
    onBotUserId?.(selfId);
    log.info?.(`[googlechat] learned bot user id ${selfId} (${how})`);
  };
  // The admin-approved app-scope token (chat.app.messages.readonly): reaction subscriptions, the
  // reacted message, and conversation_history reads. Minted lazily on a SEPARATE auth, so an
  // unapproved scope fails only those features, never messaging.
  let eventsAuthCache = deps.eventsAuth || null;
  const eventsAuth = () => (eventsAuthCache ||= createGoogleAuth({ serviceAccount: serviceAccountJson, scopes: CHAT_REACTION_EVENT_SCOPES }));
  let historyApiCache = deps.historyApi || null;
  const historyApi = () => (historyApiCache ||= createChatApi({ auth: eventsAuth() }));
  const connector = deps.connector || createGoogleChatConnector({ auth, capabilities, api, botUserId: selfId, historyApi, log });
  const seenThreads = createSeenThreads();
  const namespace = `googlechat:${subscription}`;
  const controlNamespace = `googlechat-controls:${subscription}`;
  const isControl = event => event.type === 'card'
    // Stop and Tick bypass the session queue like /stop, so they reach a turn while it runs.
    || (event.type === 'reaction' && event.action !== 'engage')
    || GOOGLE_CHAT_CONTROL_COMMAND.test(messageCommandText(event.message, { appCommand: event.appCommand }));
  const inboundFor = ({ event, botId, threadKey }) => {
    if (event.type === 'reaction') return reactionInbound({ event, botId, threadKey });
    const normalized = normalizeMessage(event, { botUserId: botId, api });
    // An edit that newly mentions the app runs like a mention, labelled as an edit.
    const message = event.edit ? { ...normalized, trigger: 'edit' } : normalized;
    return threadKey === undefined ? message : { ...message, threadKey };
  };
  // The durable id a message or reaction was accepted under (see onEvent / onReactionEvent). A
  // steer rotates row contents together with their ids, so the payload always names its own row.
  const queuedEventId = payload => String(payload.event.type === 'reaction' ? payload.event.reaction?.id || '' : payload.event.message?.name || '');
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
      // A queued message's Steer / Cancel card retires once its message starts on its own.
      if (payload.event.type !== 'card') connector.queuedEventStarted?.({ kind: GOOGLE_CHAT_QUEUE_LANE, eventId: queuedEventId(payload) });
      if (payload.event.type === 'card') {
        const card = normalizeCardEvent(payload.event);
        if (card) await onCard?.(card);
      } else if (payload.event.type === 'reaction') await handleReaction(payload);
      else await onMessage(inboundFor(payload));
    },
    interrupted: async payload => {
      // A reaction control interrupted by a restart is not re-announced: the reactor can react again.
      if (payload.event.type === 'reaction') return;
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
      const message = payload.event.type === 'reaction' ? await resolvedReaction(payload, { quiet: true }) : inboundFor(payload);
      if (message && isQueued()) await onMessage(message, { queuedNoticeOnly: true, position, isQueued, queuedEvent: { kind: GOOGLE_CHAT_QUEUE_LANE, eventId } });
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

  // The busy-thread Steer / Cancel card names one waiting row of THIS subscription's message lane.
  attachQueuedEventControls(connector, { namespaces: { [GOOGLE_CHAT_QUEUE_LANE]: namespace },
    authorOf: row => inboundFor(fromJson(row.data, {})).userId || '' });

  // ── Reactions (Google Workspace Events) ───────────────────────────────────────────────────
  const reactionsEnabled = Boolean(reactionTopic);
  const eventsApi = reactionsEnabled ? deps.eventsApi || createChatApi({ auth: eventsAuth() }) : null;
  const subscriptions = reactionsEnabled ? deps.reactionSubscriptions || createReactionSubscriptions({
    client: deps.eventsClient || createWorkspaceEventsClient({ auth: eventsAuth() }),
    listSpaces: () => api.listSpaces(), topic: reactionTopic, log,
  }) : null;
  // Removals seen by this process. A removal can overtake its own addition (separate deliveries);
  // the addition must then never act. Bounded like the thread memory.
  const removedReactions = new Map();
  const spaceCache = new Map();
  const reactionInbound = ({ event, botId, threadKey }) => {
    const { reaction, action, message, space, userId = '', userName = '' } = event;
    const base = normalizeMessage({ message, space }, { botUserId: botId, api });
    const fromApp = message?.sender?.type === 'BOT';
    return makeInbound({
      platform: 'googlechat', conversationId: base.rawConversationId, conversationName: base.conversationName, kind: base.kind,
      threadKey: threadKey ?? base.threadKey, messageId: reaction.id, replyToId: String(message?.name || reaction.messageName),
      userId, userName: userName || userId, userEmail: userId.includes('@') ? userId : '',
      trigger: 'reaction', reactionAction: action,
      // Reacting to the app's own answer continues that task; reacting to a person's message asks
      // the app to act on its text. The reacted text is content: it never runs as a command.
      text: fromApp ? 'Continue the task from this message.' : base.text,
      attachments: fromApp ? [] : base.attachments,
      raw: { ...base.raw, senderName: reaction.userName, reaction: { name: reaction.name, emoji: reaction.emoji, eventTime: reaction.eventTime } },
    });
  };
  // The reactor arrives as users/NNN only, resolved when the reaction acts (not when it arrived),
  // so the mapping is the person's latest recorded one. null = withdrawn or unattributable.
  async function resolvedReaction(payload, { quiet = false } = {}) {
    const { reaction } = payload.event;
    if (removedReactions.has(reaction.name) && Date.parse(removedReactions.get(reaction.name)) >= Date.parse(reaction.eventTime)) return null;
    const users = await getUsers();
    const userId = resolveReactor(reaction.userName, users);
    if (!userId) {
      if (!quiet) {
        log.info?.(`[googlechat] reaction by unmapped user ${reaction.userName} ignored`);
        await logEvent('googlechat_reaction_unmapped', { platform: 'googlechat', channel: `gchat:${reaction.space}`, reactor: reaction.userName, action: payload.event.action });
      }
      return null;
    }
    return inboundFor({ ...payload, event: { ...payload.event, userId, userName: users[userId]?.name || userId } });
  }
  async function handleReaction(payload) {
    const message = await resolvedReaction(payload);
    if (message) await onMessage(message);
  }
  function forgetRemoved(item) {
    removedReactions.set(item.name, item.eventTime);
    if (removedReactions.size > 2000) removedReactions.delete(removedReactions.keys().next().value);
    // A queued (not yet started) action for this reaction is withdrawn. Running work is not undone:
    // removing a Stop after it acted cannot restart anything.
    getDb().prepare(`UPDATE inbound_events SET status = 'done', data = '{}' WHERE namespace IN (?, ?) AND status = 'queued'
      AND json_extract(data, '$.event.reaction.name') = ?`).run(namespace, controlNamespace, item.name);
  }
  async function fetchReacted(messageName) {
    // chat.bot reaches the app's own and addressed messages; the admin-approved app scope reaches
    // other public messages. A message that is gone or invisible to both cannot be acted on.
    for (const client of [api, eventsApi]) {
      try { return await client.getMessage(messageName); }
      catch (error) {
        // A revoked app-scope approval fails at token minting (400/401): unreadable, not transient.
        if (![403, 404].includes(error?.status) && !(client === eventsApi && [400, 401].includes(error?.status))) throw error;
      }
    }
    return null;
  }
  async function spaceFor(name) {
    const cached = spaceCache.get(name);
    if (cached && cached.until > Date.now()) return cached.space;
    const space = await api.getSpace(name);
    spaceCache.set(name, { space, until: Date.now() + 10 * 60_000 });
    if (spaceCache.size > 500) spaceCache.delete(spaceCache.keys().next().value);
    return space;
  }
  async function onReactionEvent(envelope, attributes) {
    if (!reactionsEnabled) return;
    const activation = getActivationReactions();
    for (const item of parseReactionEvent(envelope, attributes)) {
      if (item.transition === 'removed') { forgetRemoved(item); continue; }
      if (item.userType === 'BOT' || !item.userName) continue;
      const action = googleChatReactionAction(item.emoji, activation);
      if (!action) continue;
      if (!reactionIsFresh(item, action)) {
        log.info?.(`[googlechat] stale ${action} reaction on ${item.messageName} ignored`);
        continue;
      }
      if (removedReactions.has(item.name) && Date.parse(removedReactions.get(item.name)) >= Date.parse(item.eventTime)) continue;
      // Resolved here so queued work names its author (stop/queue ownership checks read it), and
      // again when it acts. An unattributable reactor never reaches the inbox.
      const users = await getUsers();
      const userId = resolveReactor(item.userName, users);
      if (!userId) {
        log.info?.(`[googlechat] reaction by unmapped user ${item.userName} ignored`);
        await logEvent('googlechat_reaction_unmapped', { platform: 'googlechat', channel: `gchat:${item.space}`, reactor: item.userName, action });
        continue;
      }
      const message = await fetchReacted(item.messageName);
      if (!message || message.name !== item.messageName) {
        log.info?.(`[googlechat] reacted message ${item.messageName} is not readable; ${action} ignored`);
        continue;
      }
      // Never act through another app's output.
      if (action === 'engage' && message.sender?.type === 'BOT' && selfId && message.sender.name !== selfId) continue;
      const space = await spaceFor(item.space).catch(error => { if ([403, 404].includes(error?.status)) return null; throw error; });
      if (!space || space.name !== item.space) continue;
      const kind = /^(DIRECT_MESSAGE|DM)$/i.test(space.spaceType || space.type || '') ? 'dm' : 'other';
      const threadName = String(message.thread?.name || '');
      // Reactions never teach the DM thread memory; they follow what messages established.
      const threadKey = resolveThreadKey({ kind, threadName, seen: { has: n => seenThreads.has(n), add() {} } });
      const payload = { event: { type: 'reaction', reaction: item, action, message, space, userId, userName: users[userId]?.name || userId }, botId: selfId, threadKey };
      const control = action !== 'engage';
      const conversationId = queueKey(payload);
      const position = control ? 0 : Number(getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace = ? AND conversation_id = ? AND status IN ('queued', 'running')")
        .get(namespace, conversationId).n);
      const accepted = (control ? controlInbox : inbox).accept({ id: item.id, conversationId, payload });
      if (position && accepted?.accepted) {
        try { noticeInbox.accept({ id: item.id, conversationId, payload: { payload, eventId: item.id, position } }); }
        catch (error) { log.warn?.(`[googlechat] queue notice could not be accepted: ${error?.message || error}`); }
      }
    }
  }

  // ── Edit trigger (Workspace Events message updates, same subscriptions as reactions) ────────
  // "Newly mentioned" is judged against the durable inbox: a message already accepted under its
  // own name — its original mention, or an earlier edit — never runs again, whatever the edit.
  const handledMessage = name => Boolean(getDb().prepare("SELECT 1 FROM inbound_events WHERE namespace IN (?, ?) AND event_id = ?")
    .get(namespace, controlNamespace, name));
  function withdrawEdit(item) {
    // The mention was edited away before its queued run started: that run is withdrawn. The row is
    // deleted rather than tombstoned so adding the mention back later still counts as new. An
    // update older than the queued edit (out-of-order delivery) withdraws nothing.
    const at = Date.parse(item.lastUpdateTime);
    for (const ns of [namespace, controlNamespace]) {
      const row = getDb().prepare("SELECT data FROM inbound_events WHERE namespace = ? AND event_id = ? AND status = 'queued'").get(ns, item.messageName);
      const queued = row ? fromJson(row.data, {}).event : null;
      if (!queued?.edit || !(Date.parse(queued.message?.lastUpdateTime) < at)) continue;
      getDb().prepare("DELETE FROM inbound_events WHERE namespace = ? AND event_id = ? AND status = 'queued'").run(ns, item.messageName);
      log.info?.(`[googlechat] mention removed from ${item.messageName} before its edit trigger ran; withdrawn`);
    }
  }
  let warnedNoSelf = false;
  async function onMessageUpdateEvent(envelope, attributes) {
    if (!reactionsEnabled) return;
    for (const item of parseMessageUpdateEvent(envelope, attributes)) {
      // The app's own progress edits arrive here too (about once a second while a turn runs) and
      // are dropped before any lookup; so is every other app's, and any update no person made.
      if (item.senderType === 'BOT' || !item.senderName || !item.lastUpdateTime) continue;
      if (!selfId) {
        // Without the app's own id a mention of THIS app cannot be told from another app's.
        if (!warnedNoSelf) { warnedNoSelf = true; log.warn?.('[googlechat] edit trigger inactive until the app\'s users/… id is known (mention the app once, or set Bot user ID)'); }
        continue;
      }
      if (!mentionsApp(item.message, selfId)) { withdrawEdit(item); continue; }
      if (!editIsFresh(item)) {
        log.info?.(`[googlechat] stale edit of ${item.messageName} ignored`);
        continue;
      }
      if (handledMessage(item.messageName)) continue;
      // The payload names the sender as users/NNN only; the person is resolved through the same
      // recorded mapping reactions use. Unknown or ambiguous resolves to nobody.
      const users = await getUsers();
      const userId = resolveReactor(item.senderName, users);
      if (!userId) {
        log.info?.(`[googlechat] edit by unmapped user ${item.senderName} ignored`);
        await logEvent('googlechat_edit_unmapped', { platform: 'googlechat', channel: `gchat:${item.space}`, sender: item.senderName });
        continue;
      }
      const space = await spaceFor(item.space).catch(error => { if ([403, 404].includes(error?.status)) return null; throw error; });
      if (!space || space.name !== item.space) continue;
      // A DM already answered the message itself; an edit there is not a new request.
      if (/^(DIRECT_MESSAGE|DM)$/i.test(space.spaceType || space.type || '')) continue;
      const threadName = String(item.message.thread?.name || '');
      if (threadName && (!isThreadName(threadName) || !threadName.startsWith(`${item.space}/threads/`))) continue;
      const message = { ...item.message, argumentText: editedArgumentText(item.message, selfId),
        sender: { ...item.message.sender, email: userId, displayName: users[userId]?.name || userId } };
      const event = { type: 'message', edit: true, message, space };
      const normalized = normalizeMessage(event, { botUserId: selfId, seen: seenThreads, api });
      log.info?.(`[googlechat] edit of ${item.messageName} newly mentions the app; accepted`);
      acceptMessage({ event, id: item.messageName, threadKey: normalized.threadKey });
    }
  }

  async function onEvent(envelope, attributes, metadata = {}) {
    const ceType = String(attributes?.["ce-type"] || "");
    if (isReactionEventType(ceType)) return onReactionEvent(envelope, attributes);
    // Only Workspace Events emit message updates (there is no interaction event for an edit).
    // Routed before parseChatEvent, which would otherwise read `{ message }` as a NEW message.
    if (isMessageUpdateEventType(ceType)) return onMessageUpdateEvent(envelope, attributes);
    if (ceType.startsWith(SUBSCRIPTION_LIFECYCLE_PREFIX)) {
      log.info?.(`[googlechat] reaction subscription lifecycle event ${ceType.slice(SUBSCRIPTION_LIFECYCLE_PREFIX.length)}`);
      subscriptions?.reconcile();
      return;
    }
    const event = parseChatEvent(envelope, attributes);
    if (event.type === "membership.added") {
      // The app's own users/NNN id, learned the first time it is added to a space. It is what makes
      // mention detection exact rather than "any bot mention counts".
      const member = event.membership?.member || {};
      if (member.type === "BOT") learnSelf(member.name, "added to a space");
      subscriptions?.reconcile();
      return;
    }
    if (event.type === "membership.removed") { subscriptions?.reconcile(); return; }
    if (event.type === 'card') {
      const card = normalizeCardEvent(event);
      // Clicks are the event class most likely to arrive in an unexpected shape or over an
      // unexpected connection; say which path carried each one, and never drop one silently.
      if (!card || !onCard) {
        log.warn?.(`[googlechat] card click dropped (${card ? 'no handler' : 'unrecognized shape'}) via ${metadata.source || 'pubsub'}: ${eventShape(envelope, attributes)}`);
        return;
      }
      log.info?.(`[googlechat] card click received via ${metadata.source || 'pubsub'}: ${card.action.function || 'no action'}`);
      const id = String(metadata.messageId || attributes?.['ce-id'] || createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
      const payload = { event, botId: selfId };
      return controlInbox.accept({ id: `card:${id}`, conversationId: queueKey(payload), payload });
    }
    if (event.type !== "message") {
      log.info?.(`[googlechat] event ignored (${event.type}) via ${metadata.source || 'pubsub'}: ${eventShape(envelope, attributes)}`);
      return;
    }

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
    if (!selfId) learnSelf(appUserNameFromInteraction(event.message, { kind: message.kind }), "named in a message sent to the app");
    return acceptMessage({ event, id, threadKey: message.threadKey });
  }

  // One intake for every message that may start work — delivered mentions and edit triggers —
  // so both get the same control lane, session queue and queue-position notice.
  function acceptMessage({ event, id, threadKey }) {
    const payload = { event, botId: selfId, threadKey };
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

  const endpoint = String(endpointUrl || "").replace(/\/$/, "");
  const oidcKeys = deps.oidcKeys || createGoogleJwks({ url: GOOGLE_OIDC_CERTS_URL, fetchImpl: deps.fetchImpl });
  const chatKeys = deps.chatKeys || createGoogleJwks({ url: CHAT_SYSTEM_JWKS_URL, fetchImpl: deps.fetchImpl });
  const handler = createGoogleChatWebhook({
    enabled: () => (endpoint || projectNumber) ? true : "Google Chat endpoint is not enabled: set the gateway Public URL and reconnect Google Chat",
    verify: authorization => verifyGoogleChatRequest({ authorization, endpointUrl: endpoint, projectNumber, appServiceAccount, oidcKeys, chatKeys }),
    onEvent, log,
  });

  const puller = deps.puller || createPubSubPuller({ auth, subscription, onEvent, log, fetchImpl: deps.fetchImpl,
    onFatal: (err) => {
      subscriptions?.stop();
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
  // Reaction subscriptions never gate the messaging transport: a missing admin approval or API
  // shows up as degraded reaction status while messages, commands and cards keep working.
  subscriptions?.start();

  return {
    platform: "googlechat",
    connector,
    puller,
    // Exposed because it IS the transport's behaviour: bot-filtering, dedupe, learning our own user
    // id, normalization. Tests drive it directly, and the HTTP endpoint below feeds it the same
    // event objects Pub/Sub delivers.
    onEvent,
    // The Express route for `POST /api/googlechat/events` (src/web/app.js) calls this.
    handler,
    endpointUrl: endpoint,
    get botUserId() { return selfId; },
    reactionSubscriptions: subscriptions,
    get detail() {
      const parts = [`pulling ${subscription}`, endpoint ? `endpoint ${endpoint}` : projectNumber ? `endpoint (project ${projectNumber})` : "endpoint off (set Public URL)"];
      if (subscriptions) {
        const s = subscriptions.status;
        parts.push(`reactions ${s.error ? `${s.state}: ${s.error}` : s.state === 'starting' ? 'starting' : `${s.active}/${s.spaces} spaces`}`);
      }
      return parts.join("; ");
    },
    async stop() { subscriptions?.stop(); inbox.stop(); controlInbox.stop(); noticeInbox.stop(); onStop?.(); await puller.stop(); },
  };
}
