import { turnReplyCallbacks } from "../gateway/turn-replies.ts";
import { runAdmissionRefusalKind } from "../gateway/run-admission-result.js";
import { recordPlatformThreadMessage, recordPlatformThreadOutcome } from "../gateway/platform-threads.js";
import { footerText } from "../gateway/reply-stats.js";
import { createUsageBank } from "../gateway/usage.js";
import { saveInboundAttachments } from "./attachments.js";
import path from "node:path";
import { removeRegularFileWithin } from "../gateway/safe-fs.js";
import { hydrateFreshThread, threadContextFetcher } from "./thread-hydration.js";
import { voiceTranscriptReplies } from "../gateway/voice-transcript-replies.js";
import { createConversationProgress } from "./conversation-progress.js";
import { hasVoiceAttachments, type prepareVoiceAttachments } from "./voice.js";
import { wasSteered } from "./conversation-controls.js";
import { deliverConversationAnswer as deliver } from "./answer-delivery.js";
import { logEvent } from "../util/logger.js";
import { effectiveWorkDir } from "../gateway/folders.js";
import { handledMessage, type MessageTurn } from "../gateway/message-flow.ts";
import type { makeInbound } from "./inbound.js";
import type { createConversationControls } from "./conversation-controls.js";

type Message = ReturnType<typeof makeInbound>;
type Posted = { messageId: string; threadKey?: string; conversationId?: string };
type Answer = { content?: string; engine?: string; cwd?: string; engineError?: unknown; isError?: boolean; error?: unknown };
type VoicePrompt = Awaited<ReturnType<typeof prepareVoiceAttachments>>;
type Prepared = { voicePrompt: VoicePrompt; skipped: string[]; threadContext: string };
type Outcome = { result: Answer } | { skipped: string } | { error: unknown };
type Lane = { signal: AbortSignal; progress: ReturnType<typeof createConversationProgress>; placeholder: Posted | null };
type Turn = MessageTurn<undefined, Lane, Prepared, Answer, Outcome>;
type Connector = {
  post: (payload: { conversationId: string; threadKey: string; text: string; signal: AbortSignal }) => Promise<Posted>;
  workingText?: string;
};
type TurnOptions = {
  connector: Connector;
  adapter: { id: string };
  message: Message;
  entry: { slug: string };
  meta: Record<string, unknown>;
  sessionKey: string;
  controls: Pick<ReturnType<typeof createConversationControls>, "execute">;
  log: Console;
  run: (args: Record<string, unknown>) => Promise<Answer>;
  voice: typeof prepareVoiceAttachments;
  fork?: { sourceSessionId: string; onSourceForked?: () => void; fallbackContext?: () => Promise<string> };
  onWorking?: (posted: Posted) => void;
  rememberReply: (posted: Posted) => void;
  replyMenu: (result?: Answer) => object | null;
  reply: (text: string) => Promise<unknown>;
};
const STEERED_TEXT = "↪️ Interrupted to answer your newer message, which runs next in this session.";
const detail = (error: unknown) => String(error && typeof error === "object" && "message" in error ? error.message || error : error);

// Teams and Google Chat share queue controls, attachment preparation and editable final replies.
export function conversationTurn({
  connector, adapter, message, entry, meta, sessionKey, controls, log, run, voice, fork,
  onWorking, rememberReply, replyMenu, reply,
}: TurnOptions): Turn {
  const bankUsage = createUsageBank();
  function noteWorking(placeholder: Posted) {
    try { onWorking?.(placeholder); }
    catch (error) { log.warn?.(`[${adapter.id}] working message not recorded: ${detail(error)}`); }
  }
  return {
    withQueue(_before, start) {
      return controls.execute({ message, sessionKey, queued: reply, work: async (signal: AbortSignal) => {
        // Remember the editable working message so the final answer or restart recovery can replace it.
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
          log.warn?.(`[${adapter.id}] placeholder post failed: ${detail(err)}`);
        }

        const progress = createConversationProgress({ connector, message, placeholder, adapter, log });
        return start({ signal, placeholder, progress });
      } });
    },

    async prepareForRun(_before, lane) {
      const { signal } = lane;
      signal.throwIfAborted();
      const saved = await saveInboundAttachments(message, { slug: entry.slug, meta, log });
      signal.throwIfAborted();
      if (hasVoiceAttachments(message)) lane.progress.phase('Transcribing voice locally');
      const voicePrompt = await voice(message, saved.paths, {
        signal,
        removeProcessed: (file: { path: string }) => removeRegularFileWithin(
          path.join(effectiveWorkDir(entry.slug, meta), "uploads"),
          file.path,
        ),
      });
      if (voicePrompt.cleanupFailed?.length) {
        await logEvent("attachment_cleanup_failed", {
          channel: message.conversationId,
          author: message.userId,
          slug: entry.slug,
          platform: adapter.id,
          reasons: voicePrompt.cleanupFailed.map((item: { name: string; reason: string }) => `${item.name}: ${item.reason}`).join("; ").slice(0, 1000),
        });
      }
      if (voicePrompt.hasVoice && !voicePrompt.hasPrompt && !voicePrompt.paths.length) {
        await lane.progress.stop();
        await deliver(connector, message, lane.placeholder, voicePrompt.failureNotice || 'Could not transcribe this audio. Please send text or ask an administrator to check local Whisper.', rememberReply);
        return handledMessage({ skipped: 'voice-unavailable' });
      }
      const transcriptReplies = voiceTranscriptReplies(voicePrompt.transcripts);
      if (transcriptReplies.length) await lane.progress.stop();
      for (const text of transcriptReplies) {
        signal.throwIfAborted();
        // Reuse the original placeholder for the first transcript. Clear our handle before
        // delivery so a later error/final answer can never overwrite a visible transcript.
        const transcriptPlaceholder = lane.placeholder;
        lane.placeholder = null;
        await deliver(connector, message, transcriptPlaceholder, text, rememberReply, '', null, { resolveNames: false });
      }
      if (transcriptReplies.length) {
        signal.throwIfAborted();
        lane.placeholder = await connector.post({ conversationId: message.rawConversationId, threadKey: message.threadKey, text: '_⏳ Agent is working…_', signal });
        rememberReply(lane.placeholder);
        noteWorking(lane.placeholder);
        lane.progress = createConversationProgress({ connector, message, placeholder: lane.placeholder, adapter, log });
      }
      signal.throwIfAborted();
      lane.progress.activity();
      try { recordPlatformThreadMessage({ message, slug: entry.slug, threadKey: sessionKey }); } catch (error) { log.warn?.(`[${adapter.id}] Activity index failed: ${detail(error)}`); }
      // A fresh session inside an existing thread starts with the thread's earlier messages
      // (connectors that declare hydrationScope; bounded, best effort, never an error). Read here,
      // after the session queue and behind the placeholder, like Slack's first-turn replay.
      const threadContext = await hydrateFreshThread({ connector, message, slug: entry.slug, sessionKey, log });
      signal.throwIfAborted();
      return { voicePrompt, skipped: saved.skipped, threadContext };
    },

    run({ voicePrompt, threadContext }, { signal, progress }) {
      signal.throwIfAborted();
      return run({
        channelId: message.conversationId,
        authorId: message.userId,
        text: threadContext + voicePrompt.text,
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
        attachments: voicePrompt.paths,
        signal,
        ...turnReplyCallbacks(signal, { onDelta: progress.activity, onEvent: progress.event, onRuntimeResolved: progress.runtime }),
        progressReport: false,
        // Permission escalation is bound to the authenticated surface.
        origin: `${adapter.id}_foreground`,
      });
    },

    async onRunError(err, { signal, progress, placeholder }) {
      try { recordPlatformThreadOutcome(message.conversationId, sessionKey, { status: signal.aborted ? "idle" : "error" }); } catch { /* Activity cannot replace the answer */ }
      log.error?.(`[${adapter.id}] run failed in ${entry.slug}: ${detail(err)}`);
      await progress.stop();
      await deliver(connector, message, placeholder, wasSteered(signal) ? STEERED_TEXT : signal.aborted ? "Stopped." : `⚠️ ${detail(err)}`, rememberReply, "", replyMenu());
      return wasSteered(signal) ? { skipped: "steered" } : { error: err };
    },

    async deliver(result, { voicePrompt, skipped }, { signal, progress, placeholder }) {
      try { recordPlatformThreadOutcome(message.conversationId, sessionKey, { status: runAdmissionRefusalKind(result) || result?.engineError || result?.isError || result?.error ? "error" : "idle" }); } catch { /* best effort */ }
      await progress.stop();
      if (signal.aborted) {
        const steered = wasSteered(signal);
        await deliver(connector, message, placeholder, steered ? STEERED_TEXT : "Stopped.", rememberReply, "", replyMenu());
        return { skipped: steered ? "steered" : "cancelled" };
      }
      await bankUsage({ channelId: message.conversationId, slug: entry.slug, authorId: message.userId, engine: result.engine, taskKind: "interactive", result });

      let text = String(result.content || "").trim() || "_(no output)_";
      if (voicePrompt.failureNotice) text += `\n\n${voicePrompt.failureNotice}`;
      if (skipped.length) {
        text += `\n\n_Couldn't read ${skipped.length} attachment(s): ${skipped.join(", ")} — this surface only hands the bot files it uploaded directly._`;
      }
      await deliver(connector, message, placeholder, text, rememberReply, footerText(result), replyMenu(result));
      return { result };
    },
  };
}
