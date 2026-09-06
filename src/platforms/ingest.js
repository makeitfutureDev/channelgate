// From a normalized inbound message to an answered turn, for platforms that are not Slack.
//
// The Slack path (src/slack/message-pipeline.js) does a great deal more than this: Block Kit
// progress cards, approval buttons, busy-thread steering, the file explorer, in-thread slash
// commands. None of that is portable, and pretending otherwise would mean either a Slack-shaped
// façade over surfaces that cannot honour it, or a rewrite of 1400 lines before either new platform
// could say a word. So this is the HONEST subset — gate, authorize, register, run, answer — built
// on the same platform-neutral pieces the Slack pipeline uses (`runMessage`, the channel store,
// `ensureChannelFolder`, the usage ledger), so nothing here is a second implementation of a rule.
//
// What is deliberately NOT here yet, and must not be silently faked: interactive approvals (a
// non-admin channel's permission prompt has no button to press on these surfaces), live progress
// rendering, and stop/steer controls. Each is a capability question the adapter already answers, and
// each gets its own slice.
import { upsertChannelEntry, getChannelMeta, saveChannelMeta, defaultChannelMeta, getUser, setUser, isAdmin, isApproved } from "../config/store.js";
import { getDefaultChannelAccess, applyChannelTemplate, getDefaultNudges } from "../config/settings.js";
import { ensureChannelFolder } from "../gateway/folders.js";
import { isAuthorized } from "../gateway/modes.js";
import { runMessage } from "../gateway/run.js";
import { createUsageBank } from "../gateway/usage.js";
import { logEvent } from "../util/logger.js";
import { platformOr } from "./registry.js";
import { postFormatted } from "./connector.js";
import { saveInboundAttachments } from "./attachments.js";

// Conversation kinds as the channel store spells them. The store's vocabulary is Slack's, and it is
// a SECURITY value there (it decides whether a private channel's name may appear in App Home), so
// the mapping is explicit rather than a passthrough of whatever a platform calls things.
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

  return async function ingest(message) {
    if (message.platform !== adapter.id) throw new Error(`${adapter.id} ingest received a ${message.platform} message`);

    // Nothing to answer. An empty body with attachments is still a turn (a screenshot with no
    // caption is a real request); an empty body with nothing at all is not.
    if (!message.text && !message.attachments.length) return { skipped: "empty" };

    // The mention gate, identical in spirit to Slack's: a DM addresses us by existing, anywhere
    // else must say so. Both surfaces additionally only DELIVER mentioned messages by default
    // (`seesUnmentionedMessages: false`), so this is belt and braces — and it stays correct if an
    // operator grants Teams RSC or Chat's space-wide events later.
    if (!message.isDM && !message.mentionsBot) return { skipped: "not-mentioned" };

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
    } catch (err) {
      log.warn?.(`[${adapter.id}] placeholder post failed: ${err?.message || err}`);
    }

    let result;
    try {
      result = await run({
        channelId: message.conversationId,
        authorId: message.userId,
        text: message.text,
        threadKey: message.threadKey,
        attachments: paths,
        progressReport: false,
        // Not `slack_foreground`: that origin is what permits escalation to dangerous permissions,
        // and it means "a watched, Slack-authenticated turn". These turns are watched and
        // authenticated too, but the escalation question deserves its own decision rather than
        // inheriting one by copying a string.
        origin: `${adapter.id}_foreground`,
      });
    } catch (err) {
      log.error?.(`[${adapter.id}] run failed in ${entry.slug}: ${err?.message || err}`);
      await deliver(connector, message, placeholder, `⚠️ ${err?.message || err}`);
      return { error: err };
    }

    await bankUsage({ channelId: message.conversationId, slug: entry.slug, authorId: message.userId, engine: result.engine, taskKind: "interactive", result });

    let text = String(result.content || "").trim() || "_(no output)_";
    if (skipped.length) {
      text += `\n\n_Couldn't read ${skipped.length} attachment(s): ${skipped.join(", ")} — this surface only hands the bot files it uploaded directly._`;
    }
    await deliver(connector, message, placeholder, text);
    return { result };
  };
}

// One answer, formatted for the surface, replacing the placeholder where the surface allows it.
// A long answer is split at the platform's cap; the FIRST chunk edits the placeholder and the rest
// are posted after it, so the "Working on it…" line never survives next to the real answer.
async function deliver(connector, message, placeholder, text) {
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
        await connector.post({
          conversationId: message.rawConversationId,
          threadKey: placeholder.threadKey || message.threadKey,
          text: chunk.text,
          mentions: chunk.mentions || [],
        });
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
  });
}
