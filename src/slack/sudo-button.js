// The "🔓 Sudo off" reply-menu button (footer.js). While a thread is in `/sudo` (direct-host)
// posture, every reply menu in it LEADS with this button, so the posture is visible on every answer
// and one click returns the thread to the channel container — the same transition `/sudo off`
// makes. The button is a control, never authority: the click re-checks the clicker's CURRENT
// organization-admin status and the thread's live flag, and refuses while work is running or
// queued, exactly as the typed command does.
import { getDb } from "../db/index.js";
import { getChannelEntry, isAdmin } from "../config/store.js";
import { getThreadSudo, setThreadSudo } from "../gateway/thread-engine.js";
import { CODE_CHANNEL_SESSION_KEY, isCodeChannelMeta } from "../gateway/code-channels.js";
import { abortPooled } from "../engines/session-pool.js";
import { runQueue } from "./message-lifecycle.js";
import { logEvent } from "../util/logger.js";

export const SUDO_OFF_ACTION_ID = "cg_sudo_off";
export const SUDO_DISABLED_TEXT = "✅ Sudo disabled for this thread. New turns return to the channel's normal container runtime. Only organization admins may have used the thread while sudo was enabled.";
const NOT_ADMIN = "Only organization admins can turn off `/sudo`.";
const BUSY = "This thread has running or queued work — stop it or wait for it to finish before changing `/sudo`.";
const ALREADY_OFF = "Sudo is already OFF for this thread.";
const STALE = "This button is no longer valid for this thread.";

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// The thread key the pipeline stores sudo under: the Slack thread ts, or a code channel's single
// channel-wide session key (gateway/code-channels.js codeChannelReplyTarget).
function sudoThreadFor(channelId, threadTs) {
  if (!channelId) return null;
  const db = getDb();
  const entryRow = db.prepare("SELECT slug, data FROM channels WHERE channel_id = ?").get(channelId);
  const slug = entryRow ? entryRow.slug || parseJson(entryRow.data, {})?.slug || "" : "";
  if (!slug) return null;
  const metaRow = db.prepare("SELECT data FROM channel_meta WHERE slug = ?").get(slug);
  const threadKey = isCodeChannelMeta(metaRow ? parseJson(metaRow.data, {}) : {}) ? CODE_CHANNEL_SESSION_KEY : threadTs;
  return threadKey ? { slug, threadKey } : null;
}

// Synchronous, for the reply-menu render path. Any failure reads as "off": the menu then simply
// lacks the shortcut, and `/sudo status` / `/sudo off` stay available.
export function slackThreadSudoOn(channelId, threadTs) {
  try {
    const thread = sudoThreadFor(channelId, threadTs);
    if (!thread) return false;
    const row = getDb()
      .prepare("SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind = 'sudo'")
      .get(thread.slug, thread.threadKey);
    return Boolean(row?.value);
  } catch {
    return false;
  }
}

export function sudoOffButton(channelId, threadTs, authorId = "") {
  if (!channelId) return null;
  return {
    type: "button",
    action_id: SUDO_OFF_ACTION_ID,
    style: "danger",
    text: { type: "plain_text", text: "🔓 Sudo off", emoji: true },
    accessibility_label: "Sudo is on for this thread. Turn it off and return to the channel container",
    value: JSON.stringify({ o: "off", c: channelId, t: threadTs || "", u: authorId || "" }),
  };
}

export async function handleSudoOffAction({ ack, body, action, client }, deps = {}) {
  const {
    checkAdmin = isAdmin,
    channelEntry = getChannelEntry,
    queue = runQueue,
    retirePooled = abortPooled,
    log = logEvent,
  } = deps;
  await ack();
  const userId = body?.user?.id;
  const channel = body?.channel?.id || body?.container?.channel_id;
  if (!userId || !channel) return;
  const ephemeral = (text, threadTs) => client.chat.postEphemeral({ channel, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}), text }).catch(() => {});
  const command = parseJson(action?.value || "{}", {}) || {};
  const candidate = String(command.t || body?.message?.thread_ts || body?.message?.ts || "");
  const threadTs = /^\d+\.\d+$/.test(candidate) ? candidate : "";
  if (command.o !== "off" || command.c !== channel) return ephemeral(STALE, threadTs);
  if (!await checkAdmin(userId)) return ephemeral(NOT_ADMIN, threadTs);
  if (!await channelEntry(channel)) return ephemeral(STALE, threadTs);
  const thread = sudoThreadFor(channel, threadTs);
  if (!thread) return ephemeral(STALE, threadTs);
  if (!await getThreadSudo(thread.slug, thread.threadKey)) return ephemeral(ALREADY_OFF, threadTs);
  const runKey = `${thread.slug}::${thread.threadKey}`;
  if (queue.count(runKey) > 0) return ephemeral(BUSY, threadTs);
  await setThreadSudo(thread.slug, thread.threadKey, false);
  retirePooled(runKey); // retire an idle host process so the next turn starts in the container
  await log("sudo_thread_changed", { channel, author: userId, slug: thread.slug, threadKey: thread.threadKey, enabled: false, via: "button" });
  await client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: `${SUDO_DISABLED_TEXT} _(Turned off by <@${userId}>.)_` });
}

export function registerSudoOffAction(app) {
  app.action(SUDO_OFF_ACTION_ID, (args) => handleSudoOffAction(args));
}
