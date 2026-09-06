// Wiring: credentials → Chat API + Pub/Sub puller + connector, started and stopped as one unit.
import { createHash } from "node:crypto";
import { createDurableInbox } from "../durable-inbox.js";
import { createGoogleAuth } from "./auth.js";
import { createChatApi } from "./api.js";
import { createPubSubPuller } from "./pubsub.js";
import { parseChatEvent, normalizeMessage, createSeenThreads } from "./events.js";
import { createGoogleChatConnector } from "./connector.js";

export async function startGoogleChat({
  serviceAccountJson,
  subscription,
  botUserId = "",
  capabilities,
  onMessage,
  onBotUserId = null,
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
  const inbox = deps.inbox || createDurableInbox({
    namespace: `googlechat:${subscription}`,
    handle: async ({ event, botId }) => onMessage(normalizeMessage(event, { botUserId: botId, seen: seenThreads, api })),
    interrupted: async ({ event, botId }) => {
      const message = normalizeMessage(event, { botUserId: botId, seen: seenThreads, api });
      await connector.post({ conversationId: message.conversationId, threadKey: message.threadKey,
        text: "This request was interrupted before its outcome could be confirmed. External actions may already have happened. Inspect the task before retrying; it was not run again automatically." });
    },
    log,
  });
  const seenThreads = createSeenThreads();

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
    if (event.type !== "message") return;

    const sender = event.message?.sender || {};
    // Never answer a bot — our own replies come back on the same topic, and two apps in one space
    // answering each other is an unbounded loop with a bill attached.
    if (sender.type === "BOT") return;
    const id = String(event.message?.name || metadata.messageId || createHash("sha256").update(JSON.stringify(envelope)).digest("hex"));
    const conversationId = String(event.space?.name || event.message?.space?.name || event.message?.name?.split("/messages/")[0] || "");
    return inbox.accept({ id, conversationId, payload: { event, botId: selfId } });
  }

  const puller = deps.puller || createPubSubPuller({ auth, subscription, onEvent, log,
    onFatal: (err) => log.error?.(`[googlechat] transport stopped: ${err?.message || err}`) });
  inbox.start();
  try { puller.start(); } catch (error) { inbox.stop(); throw error; }

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
    async stop() { inbox.stop(); await puller.stop(); },
  };
}
