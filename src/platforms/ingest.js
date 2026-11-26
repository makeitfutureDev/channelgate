import { runAdmissionRefusalKind } from "../gateway/run-admission-result.js";
import { recordPlatformThreadMessage, recordPlatformThreadOutcome } from "../gateway/platform-threads.js";
import { autoApproveUser } from "../gateway/user-auto-approval.js";
// From a normalized inbound message to an answered turn, for platforms that are not Slack.
// Text controls, per-session serialization and conservative progress edits use the same gateway
// policy/stores as Slack. Interactive approval escalation remains deliberately unavailable here.
import { upsertChannelEntry, getChannelMeta, saveChannelMeta, patchChannelMeta, defaultChannelMeta, getUser, setUser, isAdmin, isApproved } from "../config/store.js";
import { getDefaultChannelAccess, applyChannelTemplate, getDefaultNudges } from "../config/settings.js";
import { effectiveWorkDir, ensureChannelFolder } from "../gateway/folders.js";
import { isAuthorized } from "../gateway/modes.js";
import { runMessage } from "../gateway/run.js";
import { footerText } from "../gateway/reply-stats.js";
import { referencedWorkspaceFiles } from "../gateway/reply-files.js";
import { createConversationProgress } from "./conversation-progress.js";
export { createConversationProgress } from "./conversation-progress.js";
import { createUsageBank } from "../gateway/usage.js";
import { logEvent } from "../util/logger.js";
import { platformOr, platformSupports } from "./registry.js";
import { deliverConversationAnswer as deliver } from "./answer-delivery.js";
import { sessionKeyForMessage, rememberReplySession } from "./reply-sessions.js";
import { saveInboundAttachments } from "./attachments.js";
import path from "node:path";
import { removeRegularFileWithin } from "../gateway/safe-fs.js";
import { acknowledgeReaction } from "./reaction-controls.js";
import { getThreadSudo } from "../gateway/thread-engine.js";
import { hydrateFreshThread, threadContextFetcher } from "./thread-hydration.js";
import { dispatchChatFeature } from "../gateway/chat-feature.ts";

// Conversation kinds as the channel store spells them. The store's vocabulary is Slack's, and it is
// a SECURITY value there (it decides whether a private channel's name may appear in App Home), so
// the mapping is explicit rather than a passthrough of whatever a platform calls things.
import { prepareVoiceAttachments, hasVoiceAttachments } from "./voice.js";
import { voiceTranscriptReplies } from "../gateway/voice-transcript-replies.js";
import { createConversationControls, wasSteered } from "./conversation-controls.js";

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
  const bankUsage = createUsageBank();
  const STEERED_TEXT = "↪️ Interrupted to answer your newer message, which runs next in this session.";

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

    const authorIsAdmin = await isAdmin(message.userId);
    const authorApproved = await isApproved(message.userId);
    if (!isAuthorized(meta, message.userId, message.isDM, { isAdminUser: authorIsAdmin, isApprovedUser: authorApproved })) {
      log.info?.(`[${adapter.id}] unapproved author ${message.userId} in ${entry.slug} — ignoring`);
      await connector.post({
        conversationId: message.rawConversationId,
        threadKey: message.threadKey,
        text: `Sorry ${message.userName || "there"}, you're not approved to use ChannelGate yet. An admin can approve you in the Users settings.`,
      }).catch(() => {});
      await logEvent("unauthorized_message", { channel: message.conversationId, author: message.userId, slug: entry.slug, platform: adapter.id });
      return { skipped: "unauthorized" };
    }

    const sessionKey = sessionKeyForMessage(message);
    if (message.trigger === "reaction" && message.threadKey) message = { ...message, threadKey: sessionKey };
    if (await getThreadSudo(entry.slug, sessionKey) && !authorIsAdmin) {
      await connector.post({
        conversationId: message.rawConversationId,
        threadKey: message.threadKey,
        text: "⛔ This is a sudo thread. Only organization admins can send messages or run work here.",
      }).catch(() => {});
      await logEvent("sudo_thread_message_rejected", { channel: message.conversationId, author: message.userId, slug: entry.slug, threadKey: sessionKey, platform: adapter.id });
      return { skipped: "sudo-admin-only" };
    }
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
      const pendingAdmin = await isAdmin(pending.userId);
      const pendingApproved = await isApproved(pending.userId);
      const currentMeta = await getChannelMeta(entry.slug);
      if (!currentMeta || !isAuthorized(currentMeta, pending.userId, pending.isDM, { isAdminUser: pendingAdmin, isApprovedUser: pendingApproved })) return false;
      if (await getThreadSudo(entry.slug, sessionKey) && !pendingAdmin) return false;
      return true;
    };
    const pendingControls = {
      pendingForSession: connector.pendingForSession ? scope => connector.pendingForSession({ ...scope, isEligible: pendingAdmission }) : null,
      cancelPendingForSession: connector.cancelPendingForSession ? scope => connector.cancelPendingForSession({ ...scope, isEligible: pendingAdmission }) : null,
    };
    if (!fork && onCommand && await onCommand({ message, sessionKey, entry, meta, authorIsAdmin, reply, replyCard, controls, ...pendingControls })) return { command: true };
    if (!fork && await controls.command({ message, sessionKey, slug: entry.slug, meta, authorIsAdmin, reply, ...pendingControls })) return { command: true };
    if (!fork && !message.attachments.length && message.trigger !== "reaction" && platformSupports(adapter.id, "agentDirectory")) {
      if (await dispatchChatFeature({ kind: "ask", text: message.text, channelId: message.conversationId, slug: entry.slug,
        actor: message.userId, threadKey: sessionKey, platform: adapter.id,
        usage: 'Use `ask #space <your question or request>` (quote a name with spaces: `ask #"Sales Team" …`).',
      }, reply)) return { command: true };
    }
    // The surface's durable intake remembers the visible working message, so a restart can replace
    // it with the interruption notice instead of leaving it spinning.
    const noteWorking = (placeholder) => { try { onWorking?.(placeholder); } catch (error) { log.warn?.(`[${adapter.id}] working message not recorded: ${error?.message || error}`); } };
    return controls.execute({ message, sessionKey, queued: reply, work: async (signal) => {
    // These surfaces have no typing indicator the daemon can drive for minutes, and no streaming.
    // A placeholder message is the only honest "I'm working on it" available — and it is also the
    // message the answer edits, so a finished turn leaves ONE message behind, not two.
    let placeholder = null;
    try {
      placeholder = await connector.post({
        conversationId: message.rawConversationId,
        threadKey: message.threadKey,
        text: adapter.id === "msteams"
          ? hasVoiceAttachments(message) ? "_⏳ Preparing voice transcription…_" : "_⏳ Agent is working…_"
          : hasVoiceAttachments(message) ? "_Preparing voice transcription…_" : connector.workingText || "_Working on it…_",
        signal,
      });
      rememberReply(placeholder);
      noteWorking(placeholder);
    } catch (err) {
      log.warn?.(`[${adapter.id}] placeholder post failed: ${err?.message || err}`);
    }

    let progress = createConversationProgress({ connector, message, placeholder, adapter, log });
    let result;
    let skipped = [];
    let prepared;
    try {
      signal.throwIfAborted();
      const saved = await saveInboundAttachments(message, { slug: entry.slug, meta, log });
      skipped = saved.skipped;
      signal.throwIfAborted();
      if (hasVoiceAttachments(message)) progress.phase('Transcribing voice locally');
      prepared = await voice(message, saved.paths, {
        signal,
        removeProcessed: (file) => removeRegularFileWithin(
          path.join(effectiveWorkDir(entry.slug, meta), "uploads"),
          file.path,
        ),
      });
      if (prepared.cleanupFailed?.length) {
        await logEvent("attachment_cleanup_failed", {
          channel: message.conversationId,
          author: message.userId,
          slug: entry.slug,
          platform: adapter.id,
          reasons: prepared.cleanupFailed.map((item) => `${item.name}: ${item.reason}`).join("; ").slice(0, 1000),
        });
      }
      if (prepared.hasVoice && !prepared.hasPrompt && !prepared.paths.length) {
        await progress.stop();
        await deliver(connector, message, placeholder, prepared.failureNotice || 'Could not transcribe this audio. Please send text or ask an administrator to check local Whisper.', rememberReply);
        return { skipped: 'voice-unavailable' };
      }
      const transcriptReplies = voiceTranscriptReplies(prepared.transcripts);
      if (transcriptReplies.length) await progress.stop();
      for (const text of transcriptReplies) {
        signal.throwIfAborted();
        // Reuse the original placeholder for the first transcript. Clear our handle before
        // delivery so a later error/final answer can never overwrite a visible transcript.
        const transcriptPlaceholder = placeholder;
        placeholder = null;
        await deliver(connector, message, transcriptPlaceholder, text, rememberReply, '', null, { resolveNames: false });
      }
      if (transcriptReplies.length) {
        signal.throwIfAborted();
        placeholder = await connector.post({ conversationId: message.rawConversationId, threadKey: message.threadKey, text: '_⏳ Agent is working…_', signal });
        rememberReply(placeholder);
        noteWorking(placeholder);
        progress = createConversationProgress({ connector, message, placeholder, adapter, log });
      }
      signal.throwIfAborted();
      progress.activity();
      try { recordPlatformThreadMessage({ message, slug: entry.slug, threadKey: sessionKey }); } catch (error) { log.warn?.(`[${adapter.id}] Activity index failed: ${error?.message || error}`); }
      // A fresh session inside an existing thread starts with the thread's earlier messages
      // (connectors that declare hydrationScope; bounded, best effort, never an error). Read here,
      // after the session queue and behind the placeholder, like Slack's first-turn replay.
      const threadContext = await hydrateFreshThread({ connector, message, slug: entry.slug, sessionKey, log });
      signal.throwIfAborted();
      result = await run({
        channelId: message.conversationId,
        authorId: message.userId,
        text: threadContext + prepared.text,
        // A session healed, switched or failed over mid-turn replays the thread the same way,
        // unless this turn already carries it.
        getFallbackContext: threadContext ? null : threadContextFetcher({ connector, message, log }),
        // Session roots for flat chats must never become native reply addresses.
        threadKey: sessionKey,
        ...(fork?.sourceSessionId ? {
          forkSourceSessionId: fork.sourceSessionId,
          onForkSessionResolved: () => fork.onSourceForked?.(),
          getForkFallbackContext: typeof fork.fallbackContext === "function" ? fork.fallbackContext : null,
        } : {}),
        attachments: prepared.paths,
        signal,
        onDelta: progress.activity,
        onEvent: progress.event,
        onRuntimeResolved: progress.runtime,
        progressReport: false,
        // Not `slack_foreground`: that origin is what permits escalation to dangerous permissions,
        // and it means "a watched, Slack-authenticated turn". These turns are watched and
        // authenticated too, but the escalation question deserves its own decision rather than
        // inheriting one by copying a string.
        origin: `${adapter.id}_foreground`,
      });
    } catch (err) {
      try { recordPlatformThreadOutcome(message.conversationId, sessionKey, { status: signal.aborted ? "idle" : "error" }); } catch { /* Activity cannot replace the answer */ }
      log.error?.(`[${adapter.id}] run failed in ${entry.slug}: ${err?.message || err}`);
      await progress.stop();
      await deliver(connector, message, placeholder, wasSteered(signal) ? STEERED_TEXT : signal.aborted ? "Stopped." : `⚠️ ${err?.message || err}`, rememberReply, "", replyMenu());
      return wasSteered(signal) ? { skipped: "steered" } : { error: err };
    }

    try { recordPlatformThreadOutcome(message.conversationId, sessionKey, { status: runAdmissionRefusalKind(result) || result?.engineError || result?.isError || result?.error ? "error" : "idle" }); } catch { /* best effort */ }
    await progress.stop();
    if (signal.aborted) {
      const steered = wasSteered(signal);
      await deliver(connector, message, placeholder, steered ? STEERED_TEXT : "Stopped.", rememberReply, "", replyMenu());
      return { skipped: steered ? "steered" : "cancelled" };
    }
    await bankUsage({ channelId: message.conversationId, slug: entry.slug, authorId: message.userId, engine: result.engine, taskKind: "interactive", result });

    let text = String(result.content || "").trim() || "_(no output)_";
    if (prepared.failureNotice) text += `\n\n${prepared.failureNotice}`;
    if (skipped.length) {
      text += `\n\n_Couldn't read ${skipped.length} attachment(s): ${skipped.join(", ")} — this surface only hands the bot files it uploaded directly._`;
    }
    await deliver(connector, message, placeholder, text, rememberReply, footerText(result), replyMenu(result));
    return { result };
    } });
  };
}
