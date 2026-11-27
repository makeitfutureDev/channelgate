// Teams and Google Chat bindings for the shared incoming-message flow.
import { conversationTurn } from "./conversation-turn.ts";
import { checkMessageAdmission, dispatchIncomingMessage } from "../gateway/message-flow.ts";
import { autoApproveUser } from "../gateway/user-auto-approval.js";
import { upsertChannelEntry, getChannelMeta, saveChannelMeta, patchChannelMeta, defaultChannelMeta, getUser, setUser } from "../config/store.js";
import { getDefaultChannelAccess, applyChannelTemplate, getDefaultNudges } from "../config/settings.js";
import { effectiveWorkDir, ensureChannelFolder } from "../gateway/folders.js";
import { runMessage } from "../gateway/run.js";
import { referencedWorkspaceFiles } from "../gateway/reply-files.js";
import { logEvent } from "../util/logger.js";
import { platformOr, platformSupports } from "./registry.js";
import { deliverConversationAnswer as deliver } from "./answer-delivery.js";
import { sessionKeyForMessage, rememberReplySession } from "./reply-sessions.js";
import { acknowledgeReaction } from "./reaction-controls.js";
import { dispatchMessageText } from "../gateway/chat-feature.ts";
import { prepareVoiceAttachments } from "./voice.js";
import { createConversationControls } from "./conversation-controls.js";
export { createConversationProgress } from "./conversation-progress.js";

// Store visibility controls where a conversation name may be shown. Map platform kinds explicitly.
const STORE_TYPE = { dm: "im", group: "mpim", channel: "channel" };

// Register (or refresh) the conversation and make sure its gated folder exists. The platform is
// stamped explicitly: reading a missing platform falls back to Slack, and a Google Chat space that
// silently claimed to be a Slack channel would be handed Slack's reply modes and Slack's guide.
export async function ensureConversation(message, connector = null) {
  // Directory failures must not block a turn or replace an already resolved name with an ID.
  const resolvedName = await connector?.conversationName?.(message).catch(() => "");
  const info = {
    name: resolvedName || message.conversationName || undefined,
    type: STORE_TYPE[message.kind] || "channel",
    isDM: message.isDM,
    platform: message.platform,
  };
  const entry = await upsertChannelEntry(message.conversationId, info);
  let meta = await getChannelMeta(entry.slug);
  if (!meta) {
    meta = applyChannelTemplate(defaultChannelMeta({ channelId: message.conversationId, ...info, name: entry.name }));
    if (!info.isDM) meta.access = getDefaultChannelAccess();
    if (info.isDM) meta.dmUserId = message.userId;
    await saveChannelMeta(entry.slug, meta);
  }
  if (meta.name !== entry.name) meta = await patchChannelMeta(entry.slug, () => ({ name: entry.name }));
  await ensureChannelFolder(entry.slug, meta);
  return { entry, meta };
}

// First sighting of an author: record them so an admin has someone to approve in the Users page.
// Unlike Slack there is no directory call to make — the display name rides the message.
async function ensureUserKnown(message) {
  const existing = await getUser(message.userId);
  if (existing) {
    if (existing.platform !== message.platform) await setUser(message.userId, { platform: message.platform });
    if (typeof existing.nudges !== "boolean") await setUser(message.userId, { nudges: getDefaultNudges() });
    return;
  }
  await setUser(message.userId, {
    platform: message.platform,
    name: message.userName || message.userEmail || message.userId,
    nudges: getDefaultNudges(),
  });
}

// `controls` may be shared with the surface's native controls (Teams queue cards steer the live
// lanes they own); `queueNotice` lets a surface answer a queued message with its own controls.
export function createIngest({ connector, log = console, run = runMessage, onCommand = null, voice = prepareVoiceAttachments, controls = createConversationControls(), queueNotice = null } = {}) {
  const adapter = platformOr(connector?.platform);

  // `fork` is set only by the daemon's own fork runner (a thread fork's opening request, authored
  // by its requester in the new thread): { sourceSessionId, onSourceForked, fallbackContext }. Its
  // text is a request, never a command, and the turn starts from a native copy of the source session.
  return async function ingest(message, { serviceUrl = '', queuedNoticeOnly = false, position = 0, isQueued = null, queuedEvent = null, onWorking = null, fork = null } = {}) {
    if (message.platform !== adapter.id) throw new Error(`${adapter.id} ingest received a ${message.platform} message`);
    if (serviceUrl) connector.rememberServiceUrl?.(message.rawConversationId, serviceUrl);

    // Nothing to answer. An empty body with attachments is still a turn (a screenshot with no
    // caption is a real request); an empty body with nothing at all is not.
    if (!message.text && !message.attachments.length) return { skipped: "empty" };

    // The mention gate, identical in spirit to Slack's: a DM addresses us by existing, anywhere
    // else must say so. Both surfaces additionally only DELIVER mentioned messages by default
    // (`seesUnmentionedMessages: false`), so this is belt and braces — and it stays correct if an
    // operator grants Teams RSC or Chat's space-wide events later.
    if (!message.isDM && !message.mentionsBot && !(message.trigger === "reaction" && platformSupports(adapter.id, "reactionTriggers"))) return { skipped: "not-mentioned" };

    let registered;
    try {
      registered = await ensureConversation(message, connector);
      await ensureUserKnown(message);
      await autoApproveUser(message.userId, message.userEmail, message.platform);
    } catch (error) {
      if (error?.code !== "license_registration_limit") throw error;
      await connector.post({ conversationId: message.rawConversationId, threadKey: message.threadKey, text: error.message });
      return { skipped: error.code };
    }
    const { entry, meta } = registered;
    // Trusted platform identity metadata also lets managers enroll an unapproved space member
    // as a scoped guest. Recording it grants no permission to run or use workspace controls.
    await connector.recordUser?.(message);

    return dispatchIncomingMessage({
      actorId: message.userId, isDM: message.isDM, meta, slug: entry.slug,
      // Resolving a quoted reply also persists its session mapping, so defer it until authorized.
      threadKey: () => sessionKeyForMessage(message),
      denied,
      admitted,
    });

    async function denied(reason, { threadKey }) {
      const unauthorized = reason === "unauthorized";
      if (unauthorized) log.info?.(`[${adapter.id}] unapproved author ${message.userId} in ${entry.slug} — ignoring`);
      await connector.post({
        conversationId: message.rawConversationId,
        threadKey: !unauthorized && message.trigger === "reaction" && message.threadKey ? threadKey : message.threadKey,
        text: unauthorized
          ? `Sorry ${message.userName || "there"}, you're not approved to use ChannelGate yet. An admin can approve you in the Users settings.`
          : "⛔ This is a sudo thread. Only organization admins can send messages or run work here.",
      }).catch(() => {});
      await logEvent(unauthorized ? "unauthorized_message" : "sudo_thread_message_rejected", {
        channel: message.conversationId, author: message.userId, slug: entry.slug, platform: adapter.id,
        ...(!unauthorized && { threadKey }),
      });
      return { skipped: reason };
    }

    async function admitted({ authorIsAdmin, threadKey: sessionKey }, processTurn) {
      if (message.trigger === "reaction" && message.threadKey) message = { ...message, threadKey: sessionKey };
      const rememberReply = (sent) => {
        if (message.kind !== "dm" && sent?.messageId) {
          rememberReplySession(message.conversationId, sent.messageId, sessionKey);
        }
      };

      const reply = async (text) => deliver(connector, message, null, text, rememberReply);
      // The Files/Variables/Settings menu (plus files the answer named) rides final answers, errors
      // and stops on surfaces whose connector renders it, bound to this requester like Slack's.
      const replyMenu = (result = null) => connector.replyMenu ? {
        conversationId: message.rawConversationId, sessionKey, authorId: message.userId,
        files: result ? referencedWorkspaceFiles(result.content, result.cwd || effectiveWorkDir(entry.slug, meta)) : [],
      } : null;
      // A durable queue notice shares every conversation/author/sudo gate with a turn, but cannot
      // run an engine or command. Recheck after authorization so cancelled or started work stays quiet.
      if (queuedNoticeOnly) {
        if (isQueued?.() && Number.isSafeInteger(position) && position > 0) {
          let shown = false;
          if (queueNotice && queuedEvent) {
            try { shown = await queueNotice({ message, sessionKey, position, queuedEvent, isQueued }); }
            catch (error) { log.warn?.(`[${adapter.id}] queue controls could not be posted: ${error?.message || error}`); }
          }
          if (!shown && isQueued()) await reply(`Queued in this session (position ${position}).`);
        }
        return { skipped: 'queue-notice' };
      }
      // Native command replies share the same source conversation and group quote mapping as text.
      const replyCard = platformSupports(adapter.id, 'richCards') !== 'none' && typeof connector.postCard === 'function' ? async ({ card, text = '' }) => {
        const sent = await connector.postCard({ conversationId: message.rawConversationId,
          threadKey: message.threadKey, card, text });
        rememberReply(sent);
        return sent;
      } : null;
      if (message.trigger === "reaction" && message.reactionAction === "ack") {
        await acknowledgeReaction({ message, reply, sessionKey });
        return { command: true };
      }
      const pendingAdmission = async pending => {
        if (!pending || !pending.text && !pending.attachments?.length) return false;
        if (!pending.isDM && !pending.mentionsBot && !(pending.trigger === 'reaction' && platformSupports(adapter.id, 'reactionTriggers'))) return false;
        const currentMeta = await getChannelMeta(entry.slug);
        if (!currentMeta) return false;
        const { denial } = await checkMessageAdmission({
          actorId: pending.userId, isDM: pending.isDM, meta: currentMeta, slug: entry.slug, threadKey: sessionKey,
        });
        return !denial;
      };
      const pendingControls = {
        pendingForSession: connector.pendingForSession ? scope => connector.pendingForSession({ ...scope, isEligible: pendingAdmission }) : null,
        cancelPendingForSession: connector.cancelPendingForSession ? scope => connector.cancelPendingForSession({ ...scope, isEligible: pendingAdmission }) : null,
      };
      if (!fork && onCommand && await onCommand({ message, sessionKey, entry, meta, authorIsAdmin, reply, replyCard, controls, ...pendingControls })) return { command: true };
      if (!fork && await controls.command({ message, sessionKey, slug: entry.slug, meta, authorIsAdmin, reply, ...pendingControls })) return { command: true };
      if (!fork && !message.attachments.length && message.trigger !== "reaction") {
        if (await dispatchMessageText({ text: message.text, channelId: message.conversationId, slug: entry.slug,
          actor: message.userId, threadKey: sessionKey, platform: adapter.id,
          usage: 'Use `ask #space <your question or request>` (quote a name with spaces: `ask #"Sales Team" …`).',
        }, reply)) return { command: true };
      }
      return processTurn(conversationTurn({
        connector, adapter, message, entry, meta, sessionKey, controls, log, run, voice, fork, onWorking,
        rememberReply, replyMenu, reply,
      }));
    }
  };
}
