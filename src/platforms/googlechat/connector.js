// The Google Chat ChatConnector: the only place that knows how bytes reach a Chat space.
import { validateConnector } from "../connector.js";
import { parseConversationId } from "../ids.js";
import { createChatApi, isSpaceName, isThreadName, isUserName, isMessageName, isPrivateViewerName } from "./api.js";
import { replyMenuCard } from "./reply-menu.js";
import { validateChatCard, routeCardActions } from "./cards.js";
import { buildNameDirectory } from "../format/mentions.js";
import { normalizeName } from "../../slack/directory.js";

const DIRECTORY_TTL_MS = 15 * 60 * 1000;
export const HISTORY_SCOPE_REMEDY = "Reading earlier Google Chat messages needs app authentication with administrator "
  + "approval for the scope https://www.googleapis.com/auth/chat.app.messages.readonly (the same approval reaction "
  + "controls use; docs/PLATFORMS.md → Google Chat). Ask a gateway admin to have a Workspace administrator approve it.";
function privateViewer(user) {
  if (!user) return null;
  const name = String(user).startsWith('users/') ? String(user) : `users/${user}`;
  if (!isPrivateViewerName(name)) throw new Error('Cannot address a private Google Chat message to this user');
  return { name };
}
function scopedThread(space, threadKey) {
  if (!isThreadName(threadKey)) return '';
  if (!threadKey.startsWith(`${space}/threads/`)) throw new Error('Google Chat thread belongs to another space');
  return String(threadKey);
}
function scopedMessage(space, messageId) {
  if (!isMessageName(messageId) || !messageId.startsWith(`${space}/messages/`)) throw new Error('Google Chat message belongs to another space');
}

// Stored conversation ids are qualified (`gchat:spaces/AAA`); the API needs the bare resource name.
// Accepting both here is what lets a caller pass whatever it happens to be holding without every
// call site remembering which form it has.
export function toSpaceName(conversationId) {
  const value = String(conversationId || "").trim();
  const { platform, id } = parseConversationId(value);
  return platform === "googlechat" ? id : value;
}

// `actionEndpoint` is the HTTP endpoint URL (or a getter, so a Public URL change applies live) that
// card clicks are routed to; see routeCardActions.
// `historyApi` returns the Chat client minted with the admin-approved chat.app.messages.readonly app
// scope (lazily: an unapproved scope must never break the messaging transport). Without it the
// conversation_history tool answers with the remedy instead of reading, and a historical file is
// reachable only on messages the bot client itself can read.
export function createGoogleChatConnector({ auth, capabilities, api = null, botUserId = "", actionEndpoint = "", historyApi = null, log = console } = {}) {
  const chat = api || createChatApi({ auth });
  const endpoint = () => String((typeof actionEndpoint === 'function' ? actionEndpoint() : actionEndpoint) || '');
  const cardsFor = card => card ? [{ cardId: 'channelgate', card: validateChatCard(routeCardActions(card, endpoint())) }] : [];
  const footerCards = (footer, menu) => footer || menu?.conversationId ? cardsFor(replyMenuCard({ footer, menu })) : [];
  // Per-space member snapshots. Chat has no workspace-wide user list a bot can read, so the
  // directory is per space and built on demand — which is also the only correct scope: resolving
  // "@Ana" against a person who is not in this space would tag a stranger.
  const directories = new Map();

  async function directoryFor(conversationId) {
    const space = toSpaceName(conversationId);
    if (!isSpaceName(space)) return { map: new Map(), maxWords: 1 };
    const hit = directories.get(space);
    if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.snapshot;
    try {
      const members = await chat.listMembers(space);
      const snapshot = buildNameDirectory(
        members.map((m) => ({ id: m.id.replace(/^users\//, ""), names: [m.name, m.email].filter(Boolean) })),
        normalizeName,
      );
      directories.set(space, { snapshot, at: Date.now() });
      return snapshot;
    } catch (err) {
      log.warn?.(`[googlechat] member list failed for ${space}: ${err?.message || err}`);
      // Keep the last good snapshot; mention resolution simply no-ops until the next refresh.
      return hit?.snapshot || { map: new Map(), maxWords: 1 };
    }
  }

  // Earlier public messages of a space or one of its threads, as plain rows for the model. Names
  // come from the space's member list (an app-authenticated message names its sender only by id).
  async function readHistory({ conversationId, threadKey = "", limit = 30 } = {}) {
    const space = toSpaceName(conversationId);
    if (!isSpaceName(space)) throw new Error("This is not a Google Chat space.");
    const thread = threadKey ? scopedThread(space, threadKey) : "";
    if (threadKey && !thread) throw new Error("That is not a Google Chat thread name.");
    const client = typeof historyApi === "function" ? historyApi() : historyApi;
    if (!client?.listMessages) throw new Error(HISTORY_SCOPE_REMEDY);
    let messages;
    try {
      messages = await client.listMessages(space, { threadName: thread, limit });
    } catch (error) {
      // An unapproved app scope fails when the token is minted (400/401) or at the call (403).
      if ([400, 401, 403].includes(error?.status) || /unauthorized_client|access_denied|invalid_scope/i.test(String(error?.message))) {
        throw new Error(HISTORY_SCOPE_REMEDY);
      }
      throw error;
    }
    const names = new Map();
    try { for (const m of await chat.listMembers(space)) names.set(m.id, m.name); } catch {}
    return messages.map((m) => ({
      // `id` is what the history formatter prints under a file, for conversation_download_file.
      id: m.name,
      name: m.name,
      thread: m.thread?.name || "",
      createTime: m.createTime || "",
      sender: m.sender?.type === "BOT" ? `${m.sender?.displayName || "an app"} [app]`
        : (m.sender?.displayName || names.get(m.sender?.name) || m.sender?.name || "unknown"),
      text: String(m.text ?? m.argumentText ?? ""),
      attachments: (m.attachment || []).map((a) => ({ name: a.contentName || "", type: a.contentType || "" })),
    }));
  }

  // A client that cannot read a message (chat.bot reaches only the app's own and addressed
  // messages; an unapproved or revoked app scope fails at token minting) is skipped, not fatal.
  const unreadable = (error, appScope) => [403, 404].includes(error?.status)
    || (appScope && ([400, 401].includes(error?.status) || /unauthorized_client|access_denied|invalid_scope/i.test(String(error?.message))));
  const readers = () => {
    const app = typeof historyApi === "function" ? historyApi() : historyApi;
    return [{ client: chat, appScope: false }, ...(app && app !== chat ? [{ client: app, appScope: true }] : [])];
  };

  // The file on one earlier message of THIS space, as an attachment the ordinary intake saves
  // under the shared size cap: { name, contentType, download }. Same order as a reacted message:
  // the bot client first, then the admin-approved app scope. Only bytes uploaded INTO Chat
  // (attachmentDataRef → media.download) are reachable; a Drive-picker share is refused.
  async function historyFile({ conversationId, message, thread = "", file = "" } = {}) {
    const space = toSpaceName(conversationId);
    if (!isSpaceName(space)) throw new Error("This is not a Google Chat space.");
    const name = String(message || "").trim();
    const threadName = String(thread || "").trim();
    if (!isMessageName(name)) throw new Error("Use a message id (spaces/…/messages/…) from an earlier conversation_history result.");
    if (!name.startsWith(`${space}/messages/`)) throw new Error("That message is not in this Google Chat conversation.");
    if (threadName && (!isThreadName(threadName) || !threadName.startsWith(`${space}/threads/`))) throw new Error("That thread is not in this Google Chat conversation.");
    let found = null;
    let scopeRefused = false;
    for (const { client, appScope } of readers()) {
      if (typeof client?.getMessage !== "function") continue;
      try { found = await client.getMessage(name); break; }
      catch (error) {
        if (!unreadable(error, appScope)) throw error;
        if (appScope && error?.status !== 404 && error?.status !== 403) scopeRefused = true;
      }
    }
    if (!found || found.name !== name) {
      throw new Error(scopeRefused ? HISTORY_SCOPE_REMEDY : "That message is not in this Google Chat conversation, or the app cannot read it.");
    }
    // Private (one-viewer) and deleted messages are never history, whoever can fetch them.
    if (found.privateMessageViewer || found.deleteTime) throw new Error("That message is not in this Google Chat conversation, or the app cannot read it.");
    if (threadName && found.thread?.name !== threadName) throw new Error("That message is not in that thread.");
    const files = (Array.isArray(found.attachment) ? found.attachment : []).filter((a) => a && (a.contentName || a.name));
    const label = (a) => String(a.contentName || a.name || "").split("/").pop();
    const wanted = String(file || "").trim().toLowerCase();
    const matches = wanted ? files.filter((a) => label(a).toLowerCase() === wanted) : files;
    if (!matches.length) throw new Error(files.length ? `That message has no file named "${file}". Its files: ${files.map(label).join(", ")}.` : "That message has no file attached.");
    if (matches.length > 1) throw new Error(`That message has several files; name one: ${matches.map(label).join(", ")}.`);
    const resourceName = String(matches[0].attachmentDataRef?.resourceName || "");
    if (!resourceName) {
      throw new Error(`${label(matches[0])} was shared from Google Drive, which the app cannot download (it needs a Drive permission the gateway does not request). Ask the person to upload it directly into the space, or provide an accessible copy.`);
    }
    return {
      name: label(matches[0]) || "attachment",
      contentType: String(matches[0].contentType || "application/octet-stream"),
      // media.download streams under the intake's per-file cap. The bot client reaches uploads on
      // messages addressed to the app; the app scope may reach the rest.
      download: async () => {
        let last = null;
        for (const { client, appScope } of readers()) {
          if (typeof client?.downloadAttachment !== "function") continue;
          try { return await client.downloadAttachment(resourceName); }
          catch (error) { if (!unreadable(error, appScope)) throw error; last = error; }
        }
        throw last || new Error("Google Chat attachment download is unavailable");
      },
    };
  }

  // Which thread a fresh session should be shown the start of (src/platforms/thread-hydration.js).
  // Only a REPLY inside a real thread: a DM's main flow has no thread key, and a top-level message
  // (threadReply false) is the first message of its thread — there is nothing earlier to show.
  function hydrationScope(message) {
    const raw = message?.raw?.message || {};
    const threadKey = threadFor(message?.threadKey);
    const space = toSpaceName(message?.rawConversationId || message?.conversationId);
    if (!threadKey || raw.threadReply !== true || !threadKey.startsWith(`${space}/threads/`)) return null;
    // A reaction's own id differs from the reacted message's; both are "the trigger".
    return { threadKey, triggerIds: [...new Set([message.messageId, raw.name].filter(Boolean).map(String))], triggerTime: String(raw.createTime || "") };
  }

  // Defined outside the connector literal so `post()` can call them without depending on `this` —
  // several call sites destructure a connector's methods, and a `this`-bound helper breaks there.
  async function openDm(userId) {
    const raw = String(userId || "");
    // Callers hold whichever identity the inbound message carried: the Chat resource name for a
    // known sender, sometimes a bare id. An email cannot address this endpoint at all.
    const name = isUserName(raw) ? raw : (/^[A-Za-z0-9_-]+$/.test(raw) ? `users/${raw}` : "");
    if (!name) return "";
    return chat.findDirectMessage(name).catch(() => "");
  }

  // The session key the gateway carries is only usable as a Chat thread when it IS one. A synthetic
  // key (a scheduled run's id, a Slack ts inherited from shared plumbing) must post at top level
  // instead of being smuggled into a resource name — the same rule slackThreadFor enforces on the
  // Slack side.
  const threadFor = (threadKey) => (isThreadName(threadKey) ? String(threadKey) : null);

  return validateConnector({
    platform: "googlechat",
    capabilities,
    replyMenu: true,
    progressStyle: 'working',
    workingText: '_⏳ Agent is working…_',
    ready: () => true,
    api: chat, // Chat-only surfaces use the same validated REST client.
    botUserId,

    async post({ conversationId, threadKey, text, footer = "", menu = null, ephemeralTo = "", buttons = null } = {}) {
      const space = toSpaceName(conversationId);
      let body = String(text ?? "");
      const cardsV2 = footerCards(footer, menu);
      // Generic unnamed actions have no verified dispatch target. Native controls use postCard.
      if (buttons?.length) {
        const labels = buttons.map((b) => b?.text || b?.label).filter(Boolean);
        if (labels.length) body += `\n\n_Reply with one of: ${labels.join(" · ")}_`;
      }
      const thread = scopedThread(space, threadKey);
      const res = await chat.createMessage(space, { text: body, threadName: thread, cardsV2,
        privateMessageViewer: privateViewer(ephemeralTo) });
      return { messageId: res.messageId, conversationId: space, threadKey: res.threadName || thread,
        ...(ephemeralTo ? { ephemeral: true } : {}) };
    },

    async postCard({ conversationId, threadKey, card, text = '', privateTo = '', ephemeralTo = '' } = {}) {
      const space = toSpaceName(conversationId);
      const thread = scopedThread(space, threadKey);
      const viewer = privateTo || ephemeralTo;
      const res = await chat.createMessage(space, { text: String(text), threadName: thread,
        cardsV2: cardsFor(card), privateMessageViewer: privateViewer(viewer) });
      return { messageId: res.messageId, conversationId: space, threadKey: res.threadName || thread,
        ...(viewer ? { ephemeral: true } : {}) };
    },

    async updateCard({ conversationId, messageId, card, text = '' } = {}) {
      scopedMessage(toSpaceName(conversationId), messageId);
      await chat.patchMessage(messageId, { text: String(text), cardsV2: cardsFor(card) });
    },

    async edit({ conversationId, messageId, text, footer = "", menu = null } = {}) {
      if (conversationId) scopedMessage(toSpaceName(conversationId), messageId);
      await chat.patchMessage(messageId, { text: String(text ?? ''), cardsV2: footerCards(footer, menu) });
    },

    // Chat marks a deleted message with a "Message deleted by its author" tombstone, so the daemon
    // should prefer editing. Delete stays implemented because a few paths (an aborted preview) mean
    // it literally.
    async remove({ messageId } = {}) {
      await chat.deleteMessage(messageId);
    },

    openDm,
    readHistory,
    historyFile,
    hydrationScope,
    threadFor,
    // DMs and unnamed group chats are flat; a named space may or may not be threaded, and the
    // inbound event is what tells us. The connector answers the general question conservatively.
    supportsThreads: (conversationId) => isSpaceName(toSpaceName(conversationId)),
    directory: (conversationId) => directoryFor(conversationId),
  });
}
