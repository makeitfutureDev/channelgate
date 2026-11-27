// Voice auto-start: a person who opted in (`voiceAutoStart` on their own user record, off by
// default) can send a voice clip as a reply in a thread THIS agent is already working in, and the
// agent starts without an @mention or a 🤖 reaction. It never applies to a top-level channel
// message (that would answer every clip anyone posts), never to a DM (DMs already need no
// mention), and never in a thread where another agent spoke last — two agents in one thread must
// not both pick up the same clip.
import { isAudioFile } from "../gateway/transcribe.js";
import { userVoiceAutoStartEnabled } from "../config/user-preferences.js";

const SCAN_PAGE = 200; // Slack's recommended conversations.replies page size
const SCAN_MAX_PAGES = 5; // bounded walk; a longer thread fails closed (mention to engage)
const USER_MENTION_RE = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>/;

/**
 * Cheap, synchronous shape check: is this an un-mentioned voice-clip reply inside a channel or
 * group thread? Everything that needs the database or the Slack API comes after it.
 */
export function isVoiceAutoStartCandidate(event = {}) {
  if (!event || typeof event !== "object") return false;
  if (!event.user || event.bot_id || event.app_id) return false;
  if (event.channel_type === "im") return false;
  if (![undefined, "file_share"].includes(event.subtype)) return false;
  if (!event.thread_ts || event.thread_ts === event.ts) return false;
  // A clip that @mentions a person is addressed to that person, not to the agent.
  if (USER_MENTION_RE.test(String(event.text || ""))) return false;
  return Array.isArray(event.files) && event.files.some((file) => isAudioFile(file));
}

/**
 * Did THIS bot post the most recent agent message in the thread? Our own posts carry
 * `user === botUserId`; another app's carry a bot_id/app_id without our user id. A thread this
 * bot never spoke in, one where another agent spoke after it, an unreadable thread and a thread
 * longer than the bounded walk all answer false.
 */
export async function isLatestAgentInThread(client, { channelId, threadTs, botUserId, excludeTs = "" } = {}) {
  if (!client?.conversations?.replies || !channelId || !threadTs || !botUserId) return false;
  let last = "";
  let cursor = "";
  try {
    for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
      const response = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) });
      for (const message of response?.messages || []) {
        if (!message || (excludeTs && message.ts === excludeTs)) continue;
        if (message.user === botUserId) last = "self";
        else if (message.bot_id || message.app_id || message.subtype === "bot_message") last = "other";
      }
      cursor = response?.response_metadata?.next_cursor || "";
      if (!cursor) return last === "self";
    }
    return false;
  } catch (error) {
    console.error("[slack] voice auto-start thread check failed:", String(error?.message || error).slice(0, 300));
    return false;
  }
}

/** Should this un-mentioned message start a turn under the author's voice auto-start setting? */
export async function shouldAutoStartVoice(event, client, { botUserId = "", loadUser } = {}) {
  if (!botUserId || !isVoiceAutoStartCandidate(event)) return false;
  const user = typeof loadUser === "function" ? await loadUser(event.user).catch(() => null) : null;
  if (!userVoiceAutoStartEnabled(user)) return false;
  return isLatestAgentInThread(client, { channelId: event.channel, threadTs: event.thread_ts, botUserId, excludeTs: event.ts });
}
