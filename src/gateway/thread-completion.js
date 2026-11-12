// Completion is shared by Activity, quiet nudges and pending digests, including reactions on
// older replies. Later messages do not undo a person's completion choice.
import { messageHasCompletionReaction } from "./completion-reactions.js";
import { getSlackThread, slackThreadIsDone, updateSlackThreadRootCompletion } from "./slack-threads.js";

export async function inspectThreadCompletion(client, channelId, threadTs) {
  const inspectedAt = Date.now();
  let cursor;
  let root = null;
  let lastMessageMs = 0;
  let completed = false;
  const seen = new Set();
  do {
    const page = await client.conversations.replies({
      channel: channelId, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}),
    });
    if (page.ok === false) throw Object.assign(new Error("Unable to verify thread completion reactions"), { code: page.error || "thread_unavailable" });
    if (Array.isArray(page.messages) && !page.messages.length && !cursor) {
      throw Object.assign(new Error("Thread no longer exists"), { code: "thread_not_found" });
    }
    if (!Array.isArray(page.messages) || !page.messages.length) {
      throw new Error("Unable to verify thread completion reactions");
    }
    const mirrorUser = getSlackThread(channelId, threadTs)?.completion_mirror_user;
    for (const message of page.messages) {
      if (message.ts === threadTs) root = message;
      const evidence = message.ts === threadTs && mirrorUser ? { ...message, reactions: message.reactions?.map((reaction) =>
        reaction.name === "white_check_mark" && reaction.users?.includes(mirrorUser)
          ? { ...reaction, count: reaction.count - 1 } : reaction) } : message;
      if (messageHasCompletionReaction(evidence)) completed = true;
      const at = Math.floor(Number(message.ts) * 1000);
      if (Number.isFinite(at)) lastMessageMs = Math.max(lastMessageMs, at);
    }
    cursor = page.response_metadata?.next_cursor?.trim();
    if ((page.has_more && !cursor) || (cursor && seen.has(cursor))) {
      throw new Error("Incomplete thread completion reaction pagination");
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { root, completed, lastMessageMs, inspectedAt };
}

export async function threadHasCompletionReaction(client, channelId, threadTs) {
  return (await inspectThreadCompletion(client, channelId, threadTs)).completed;
}

export async function threadIsComplete(client, channelId, threadTs) {
  const row = getSlackThread(channelId, threadTs);
  if (row?.done_ms > 0) return true;
  const inspected = await inspectThreadCompletion(client, channelId, threadTs);
  if (!row) return inspected.completed;
  updateSlackThreadRootCompletion(channelId, { ts: threadTs }, inspected);
  return slackThreadIsDone(getSlackThread(channelId, threadTs));
}
