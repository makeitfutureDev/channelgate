// From a normalized inbound message to an answered turn, for platforms that are not Slack.
// Text controls, per-session serialization and conservative progress edits use the same gateway
// policy/stores as Slack. Interactive approval escalation remains deliberately unavailable here.
import { upsertChannelEntry, getChannelMeta, saveChannelMeta, defaultChannelMeta, getUser, setUser, isAdmin, isApproved } from "../config/store.js";
import { getDefaultChannelAccess, applyChannelTemplate, getDefaultNudges } from "../config/settings.js";
import { ensureChannelFolder } from "../gateway/folders.js";
import { isAuthorized } from "../gateway/modes.js";
import { runMessage } from "../gateway/run.js";
import { createUsageBank } from "../gateway/usage.js";
import { logEvent } from "../util/logger.js";
import { platformOr, platformSupports } from "./registry.js";
import { postFormatted } from "./connector.js";
import { sessionKeyForMessage, rememberReplySession } from "./reply-sessions.js";
import { saveInboundAttachments } from "./attachments.js";

// Conversation kinds as the channel store spells them. The store's vocabulary is Slack's, and it is
// a SECURITY value there (it decides whether a private channel's name may appear in App Home), so
// the mapping is explicit rather than a passthrough of whatever a platform calls things.
import { createConversationControls } from "./conversation-controls.js";

const STORE_TYPE = { dm: "im", group: "mpim", channel: "channel" };

// Register (or refresh) the conversation and make sure its gated folder exists. The platform is
// stamped explicitly: reading a missing platform falls back to Slack, and a Google Chat space that
// silently claimed to be a Slack channel would be handed Slack's reply modes and Slack's guide.
export async function ensureConversation(message) {
  const info = {
    name: message.conversationName || message.conversationId,
    type: STORE_TYPE[message.kind] || "channel",
    isDM: message.isDM,
    platform: message.platform,
  };
  const entry = await upsertChannelEntry(message.conversationId, info);
  let meta = await getChannelMeta(entry.slug);
  if (!meta) {
    meta = applyChannelTemplate(defaultChannelMeta({ channelId: message.conversationId, ...info }));
    if (!info.isDM) meta.access = getDefaultChannelAccess();
    meta.nudges = getDefaultNudges();
    if (info.isDM) meta.dmUserId = message.userId;
    await saveChannelMeta(entry.slug, meta);
  }
  await ensureChannelFolder(entry.slug, meta);
  return { entry, meta };
}

// First sighting of an author: record them so an admin has someone to approve in the Users page.
// Unlike Slack there is no directory call to make — the display name rides the message.
async function ensureUserKnown(message) {
  if (await getUser(message.userId)) return;
  await setUser(message.userId, { name: message.userName || message.userEmail || message.userId });
}

export function createIngest({ connector, log = console, run = runMessage } = {}) {
  const adapter = platformOr(connector?.platform);
  const bankUsage = createUsageBank();
  const controls = createConversationControls();

  return async function ingest(message) {
    if (message.platform !== adapter.id) throw new Error(`${adapter.id} ingest received a ${message.platform} message`);

    // Nothing to answer. An empty body with attachments is still a turn (a screenshot with no
    // caption is a real request); an empty body with nothing at all is not.
    if (!message.text && !message.attachments.length) return { skipped: "empty" };

    // The mention gate, identical in spirit to Slack's: a DM addresses us by existing, anywhere
    // else must say so. Both surfaces additionally only DELIVER mentioned messages by default
    // (`seesUnmentionedMessages: false`), so this is belt and braces — and it stays correct if an
    // operator grants Teams RSC or Chat's space-wide events later.
    if (!message.isDM && !message.mentionsBot && !(message.trigger === "reaction" && platformSupports(adapter.id, "reactionTriggers"))) return { skipped: "not-mentioned" };

    const { entry, meta } = await ensureConversation(message);
    await ensureUserKnown(message);

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
    const rememberReply = (sent) => {
      if (message.kind === "group" && !message.threadKey && sent?.messageId) {
        rememberReplySession(message.conversationId, sent.messageId, sessionKey);
      }
    };

    const reply = async (text) => deliver(connector, message, null, text, rememberReply);
    if (await controls.command({ message, sessionKey, slug: entry.slug, meta, authorIsAdmin, reply })) return { command: true };
    return controls.execute({ message, sessionKey, queued: reply, work: async (signal) => {
    // Attachments land in the channel folder, exactly where the Slack path puts them, so the model
    // reads them with the same tool and the same confinement.
    const { paths, skipped } = await saveInboundAttachments(message, { slug: entry.slug, meta, log });

    // These surfaces have no typing indicator the daemon can drive for minutes, and no streaming.
    // A placeholder message is the only honest "I'm working on it" available — and it is also the
    // message the answer edits, so a finished turn leaves ONE message behind, not two.
    let placeholder = null;
    try {
      placeholder = await connector.post({
        conversationId: message.rawConversationId,
        threadKey: message.threadKey,
        text: "_Working on it…_",
      });
      rememberReply(placeholder);
    } catch (err) {
      log.warn?.(`[${adapter.id}] placeholder post failed: ${err?.message || err}`);
    }

    const progress = createConversationProgress({ connector, message, placeholder, adapter, log });
    let result;
    try {
      result = await run({
        channelId: message.conversationId,
        authorId: message.userId,
        text: message.text,
        // Session roots for flat chats must never become native reply addresses.
        threadKey: sessionKey,
        attachments: paths,
        signal,
        onDelta: progress.activity,
        onEvent: progress.event,
        progressReport: false,
        // Not `slack_foreground`: that origin is what permits escalation to dangerous permissions,
        // and it means "a watched, Slack-authenticated turn". These turns are watched and
        // authenticated too, but the escalation question deserves its own decision rather than
        // inheriting one by copying a string.
        origin: `${adapter.id}_foreground`,
      });
    } catch (err) {
      log.error?.(`[${adapter.id}] run failed in ${entry.slug}: ${err?.message || err}`);
      await progress.stop();
      await deliver(connector, message, placeholder, signal.aborted ? "Stopped." : `⚠️ ${err?.message || err}`, rememberReply);
      return { error: err };
    }

    await progress.stop();
    if (signal.aborted) { await deliver(connector, message, placeholder, "Stopped.", rememberReply); return { skipped: "cancelled" }; }
    await bankUsage({ channelId: message.conversationId, slug: entry.slug, authorId: message.userId, engine: result.engine, taskKind: "interactive", result });

    let text = String(result.content || "").trim() || "_(no output)_";
    if (skipped.length) {
      text += `\n\n_Couldn't read ${skipped.length} attachment(s): ${skipped.join(", ")} — this surface only hands the bot files it uploaded directly._`;
    }
    await deliver(connector, message, placeholder, text, rememberReply);
    return { result };
    } });
  };
}

// One answer, formatted for the surface, replacing the placeholder where the surface allows it.
// A long answer is split at the platform's cap; the FIRST chunk edits the placeholder and the rest
// are posted after it, so the "Working on it…" line never survives next to the real answer.
async function deliver(connector, message, placeholder, text, rememberReply = () => {}) {
  const adapter = platformOr(connector.platform);
  const directory = await connector.directory?.(message.rawConversationId).catch(() => null);
  const formatted = adapter.formatOutbound(text, { directory, capabilities: adapter.capabilities });
  const chunks = formatted.chunks.length ? formatted.chunks : [{ text, mentions: [] }];

  if (placeholder?.messageId && adapter.capabilities.messageEdit) {
    try {
      await connector.edit({
        conversationId: placeholder.conversationId || message.rawConversationId,
        messageId: placeholder.messageId,
        text: chunks[0].text,
        mentions: chunks[0].mentions || [],
      });
      for (const chunk of chunks.slice(1)) {
        rememberReply(await connector.post({
          conversationId: message.rawConversationId,
          threadKey: placeholder.threadKey || message.threadKey,
          text: chunk.text,
          mentions: chunk.mentions || [],
        }));
      }
      return;
    } catch (err) {
      // The placeholder may have been deleted, or the edit budget exhausted. Falling through to a
      // fresh post is the difference between a visible answer and a silent one.
    }
  }
  await postFormatted(connector, {
    conversationId: message.rawConversationId,
    threadKey: placeholder?.threadKey || message.threadKey,
    formatted: { chunks },
    onPosted: rememberReply,
  });
}

// Progress contains state only, never model/tool payloads. At most one periodic update per
// 30 seconds, with in-flight edits drained before the final answer to prevent stale overwrites.
export function createConversationProgress({ connector, message, placeholder, adapter, log = console, intervalMs = 30000, now = Date.now }) {
  const started = now();
  let lastActivity = started;
  let state = 'Working';
  let pending = Promise.resolve();
  let updating = false;
  let stopped = false;
  const agents = new Set();
  const tick = () => {
    if (stopped || updating) return;
    const text = `${state} — ${Math.floor((now() - started) / 1000)}s elapsed; last activity ${Math.floor((now() - lastActivity) / 1000)}s ago; ${agents.size} subagent(s) running. Still connected.`;
    updating = true;
    pending = Promise.resolve().then(() => placeholder?.messageId && adapter.capabilities.messageEdit
      ? connector.edit({ conversationId: placeholder.conversationId || message.rawConversationId, messageId: placeholder.messageId, text })
      : connector.post({ conversationId: message.rawConversationId, threadKey: message.threadKey, text }))
      .catch((err) => log.warn?.(`[${adapter.id}] progress update failed: ${err?.message || err}`))
      .finally(() => { updating = false; });
  };
  const timer = setInterval(tick, Math.max(30000, intervalMs));
  timer.unref?.();
  return {
    activity() { lastActivity = now(); state = 'Working'; },
    event(event) {
      if (event?.kind === 'agent_activity') {
        const key = String(event.id || event.name || 'agent');
        if (event.status === 'running') agents.add(key); else agents.delete(key);
      }
      if (event?.kind === 'run_queued') state = `Waiting for a gateway run slot (position ${Number(event.position) || 1})`;
      else if (event?.kind === 'notice') state = 'Working; waiting for the engine';
      else { lastActivity = now(); state = 'Working'; }
    },
    async stop() { stopped = true; clearInterval(timer); await pending; },
  };
}
