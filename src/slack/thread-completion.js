import { getChannelEntry, getChannelMeta, getUser } from "../config/store.js";
import { getSlackThread, setSlackThreadDone, updateSlackThreadRootCompletion } from "../gateway/slack-threads.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";
import { isCompletionReaction } from "../gateway/completion-reactions.js";
import { isAuthorized } from "../gateway/modes.js";
import { getThreadSudo } from "../gateway/thread-engine.js";
import { listConversationMemberIds } from "./members.js";

// Root and reply reactions use the same durable completion evidence. On removal inspect the
// whole thread, since a second check/thumb on another message may still keep it complete.
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
}

// The owner's native 👍 feedback also means Done. Its untrusted button value cannot name a
// different conversation/thread or bypass current admission, private membership or sudo rules.
export async function completeThreadFromFeedback({ client, body, parsed }) {
  const channelId = body?.channel?.id || body?.container?.channel_id;
  const threadTs = body?.message?.thread_ts || body?.message?.ts;
  const userId = body?.user?.id;
  if (parsed?.verdict !== "up" || !channelId || !threadTs || !userId || parsed.channel !== channelId || parsed.threadTs !== threadTs) return false;
  const row = getSlackThread(channelId, threadTs);
  if (!row || row.starter_id !== userId) return false;
  const entry = await getChannelEntry(channelId);
  if (!entry) return false;
  const [meta, user] = await Promise.all([getChannelMeta(entry.slug), getUser(userId)]);
  if (!meta || !isAuthorized(meta, userId, Boolean(entry.isDM || meta.isDM), { isAdminUser: user?.isAdmin === true, isApprovedUser: user?.approved === true })) return false;
  if (!["channel", "C"].includes(entry.type) && !(await listConversationMemberIds(client, channelId)).includes(userId)) return false;
  if (!user?.isAdmin && await getThreadSudo(entry.slug, threadTs)) return false;
  return setSlackThreadDone(channelId, threadTs, userId, true);
}
