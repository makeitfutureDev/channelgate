import { getChannelEntry } from "../config/store.js";
import { getSlackThread, isSlackThreadEligible, setSlackThreadDone, setSlackThreadLater, updateSlackThreadRootCompletion } from "../gateway/slack-threads.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";
import { isCompletionReaction } from "../gateway/completion-reactions.js";
import { accessContext } from "./home-threads.js";
import { onConfigChange } from "../config/change-events.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
let accessVersion = 0;
onConfigChange(() => { accessVersion++; });

// Root and reply reactions use the same durable completion evidence. On removal inspect the
// whole thread, since a second check on another message may still keep it complete.
export async function syncThreadCompletionReaction(client, event, { added = false } = {}) {
  if (!isCompletionReaction(event?.reaction) || event.item?.type !== "message") return;
  const channelId = event.item.channel;
  if (!await getChannelEntry(channelId)) return;
  const result = await client.reactions.get({ channel: channelId, timestamp: event.item.ts, full: true });
  if (result?.ok === false || !result?.message) return;
  const threadTs = result.message.thread_ts || result.message.ts || event.item.ts;
  if (!getSlackThread(channelId, threadTs)) return;
  const inspected = await inspectThreadCompletion(client, channelId, threadTs);
  updateSlackThreadRootCompletion(channelId, { ts: threadTs }, {
    ...inspected, reactionAt: added ? Math.floor(Number(event.event_ts) * 1000) || 0 : 0,
  });
  await syncThreadDoneMarker(client, channelId, threadTs);
}

// The owner's native 👍 feedback also means Done. Its untrusted button value cannot name a
// different conversation/thread or bypass current admission, private membership or sudo rules.
export async function completeThreadFromFeedback(input) {
  return changeThreadFromFeedback(input, "up");
}

export async function postponeThreadFromFeedback(input) {
  return changeThreadFromFeedback(input, "down");
}

async function changeThreadFromFeedback({ client, body, parsed }, verdict) {
  const channelId = body?.channel?.id || body?.container?.channel_id;
  const threadTs = body?.message?.thread_ts || body?.message?.ts;
  const userId = body?.user?.id;
  if (parsed?.verdict !== verdict || !channelId || !threadTs || !userId || parsed.channel !== channelId || parsed.threadTs !== threadTs) return false;
  const row = getSlackThread(channelId, threadTs);
  if (!row || row.starter_id !== userId || !isSlackThreadEligible(row)) return false;
  const version = accessVersion;
  const entry = await getChannelEntry(channelId);
  if (!entry) return false;
  const access = await accessContext(client, userId);
  if (!await access.allows({ ...entry, channelId }, threadTs)) return false;
  const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
  const root = page?.ok !== false && page?.messages?.find((message) => message.ts === threadTs);
  if (!root || root.user !== userId || root.bot_id) return false;
  const freshAccess = await accessContext(client, userId);
  const freshEntry = await getChannelEntry(channelId);
  if (!await freshAccess.allows(freshEntry && { ...freshEntry, channelId }, threadTs) || version !== accessVersion) return false;
  const changed = verdict === "down" ? setSlackThreadLater(channelId, threadTs, userId, true)
    : setSlackThreadDone(channelId, threadTs, userId, true);
  if (changed) await syncThreadDoneMarker(client, channelId, threadTs);
  // The root shows the thread's state; the liked answer also gets visible confirmation.
  // Only write after the same ownership/access checks, and keep Done if decoration fails.
  const messageTs = body?.message?.ts;
  if (changed && verdict === "up" && messageTs && messageTs !== threadTs && getSlackThread(channelId, threadTs)?.completion_mirror_user) {
    try {
      const result = await client.reactions.add({ channel: channelId, timestamp: messageTs, name: "white_check_mark" });
      if (result?.ok === false) throw Object.assign(new Error("Unable to mark liked answer"), { code: result.error });
    } catch (error) {
      const code = error.data?.error || error.code;
      if (code !== "already_reacted") console.error("[slack] liked answer marker failed:", code || "slack_unavailable");
    }
  }
  return changed;
}
