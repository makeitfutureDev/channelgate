// Completion is shared by Activity, quiet nudges and pending digests, including reactions on
// older replies. A fresh human prompt can override existing completion evidence.
import { isCompletionReaction, messageHasCompletionReaction } from "./completion-reactions.js";
import { getSlackThread, pendingSlackThreadCompletionParticipants, slackThreadIsDone, updateSlackThreadRootCompletion } from "./slack-threads.js";

export async function inspectThreadCompletion(client, channelId, threadTs, { maxPages = Infinity, deadline = Infinity, progress = {} } = {}) {
  // Repair callers retain progress across bounded snapshots. No partial result is applied;
  // the original participant watermarks survive retries and fence concurrent own messages.
  if (!progress.inspectedAt) {
    const row = getSlackThread(channelId, threadTs);
    Object.assign(progress, { inspectedAt: Date.now(), root: null, lastMessageMs: 0,
      completed: false, cursor: undefined, seen: new Set(), completionUserIds: new Set(), completionActorMessageTs: {},
      completionParticipants: pendingSlackThreadCompletionParticipants(channelId, threadTs),
      botUserId: "", botVerified: false,
      legacyCandidate: Boolean(row?.root_done && row.done_ms === 0 && !row.root_reaction_ms && !row.completion_reopened_ms),
      legacyBotOnlyCompletion: true, sawCheck: false });
  }
  const budget = () => {
    if (Date.now() >= deadline) throw new Error("Thread completion inspection budget exceeded");
  };
  if (!progress.botVerified && progress.completionParticipants.length && client.auth?.test) {
    budget();
    const auth = await client.auth.test();
    if (auth.ok === false || !auth.user_id) throw new Error("Unable to verify completion marker identity");
    progress.botUserId = auth.user_id;
    progress.botVerified = true;
  }
  let pages = 0;
  do {
    budget();
    if (++pages > maxPages) throw new Error("Thread completion inspection page budget exceeded");
    const page = await client.conversations.replies({
      channel: channelId, ts: threadTs, limit: 100, ...(progress.cursor ? { cursor: progress.cursor } : {}),
    });
    if (page.ok === false) throw Object.assign(new Error("Unable to verify thread completion reactions"), { code: page.error || "thread_unavailable" });
    if (Array.isArray(page.messages) && !page.messages.length && !progress.cursor) {
      throw Object.assign(new Error("Thread no longer exists"), { code: "thread_not_found" });
    }
    if (!Array.isArray(page.messages) || !page.messages.length) throw new Error("Unable to verify thread completion reactions");
    // Commit only a complete page. Failed identity hydration must not retain an actor
    // from a partial page that may have changed by the time Slack is retried.
    const next = { root: progress.root, completed: progress.completed, lastMessageMs: progress.lastMessageMs,
      completionUserIds: new Set(progress.completionUserIds), completionActorMessageTs: { ...progress.completionActorMessageTs }, sawCheck: progress.sawCheck,
      legacyBotOnlyCompletion: progress.legacyBotOnlyCompletion };
    for (const raw of page.messages) {
      let message = raw;
      const incompleteActors = (reactions) => (reactions || []).some((reaction) =>
        isCompletionReaction(reaction.name) && reaction.count > new Set(reaction.users || []).size);
      if (progress.completionParticipants.length && incompleteActors(message.reactions)) {
        // Finish an admitted page (at most 100 messages) even after the caller's wait
        // budget expires; otherwise slow hydration would retry the same prefix forever.
        let reactions;
        if (!reactions && client.reactions?.get) {
          const full = await client.reactions.get({ channel: channelId, timestamp: message.ts, full: true });
          if (full.ok !== false && full.message?.reactions) reactions = full.message.reactions;
        }
        if (!reactions || incompleteActors(reactions)) throw new Error("Incomplete thread completion actor list");
        message = { ...message, reactions };
      }
      if (message.ts === threadTs) next.root = message;
      // Marker writes can complete while the Slack request is outstanding. Consult the
      // current saved identity, and keep bot identity separate from shared completion.
      const current = getSlackThread(channelId, threadTs);
      const mirrorUser = current?.completion_mirror_user;
      const savedLegacyMarker = Boolean(mirrorUser && current) && message.ts === threadTs && current.historical_completion_marker_user === mirrorUser
        && current.done_ms === 0 && !current.root_reaction_ms && !current.completion_reopened_ms;
      const evidence = mirrorUser && !savedLegacyMarker ? { ...message, reactions: message.reactions?.map((reaction) =>
        reaction.name === "white_check_mark" && reaction.users?.includes(mirrorUser)
          ? { ...reaction, count: reaction.count - 1 } : reaction) } : message;
      if (messageHasCompletionReaction(evidence)) next.completed = true;
      for (const reaction of message.reactions || []) {
        if (!isCompletionReaction(reaction.name) || !(reaction.count > 0)) continue;
        next.sawCheck = true;
        if (message.ts !== threadTs || reaction.name !== "white_check_mark" || reaction.count !== 1
          || reaction.users?.length !== 1 || reaction.users[0] !== progress.botUserId) next.legacyBotOnlyCompletion = false;
        for (const userId of reaction.users || []) {
          if (typeof userId === "string" && userId && userId !== mirrorUser && userId !== progress.botUserId) {
            next.completionUserIds.add(userId);
            if (Number(message.ts) > Number(next.completionActorMessageTs[userId] || 0)) next.completionActorMessageTs[userId] = message.ts;
          }
        }
      }
      const at = Math.floor(Number(message.ts) * 1000);
      if (Number.isFinite(at)) next.lastMessageMs = Math.max(next.lastMessageMs, at);
    }
    const cursor = page.response_metadata?.next_cursor?.trim();
    if ((page.has_more && !cursor) || (cursor && progress.seen.has(cursor))) throw new Error("Incomplete thread completion reaction pagination");
    if (cursor) progress.seen.add(cursor);
    Object.assign(progress, next, { cursor });
  } while (progress.cursor);
  const legacyBotOnlyCompletion = Boolean(progress.legacyCandidate && progress.botVerified && progress.sawCheck && progress.legacyBotOnlyCompletion);
  return { root: progress.root, completed: progress.completed || legacyBotOnlyCompletion,
    lastMessageMs: progress.lastMessageMs, inspectedAt: progress.inspectedAt,
    completionUserIds: [...progress.completionUserIds], completionActorMessageTs: progress.completionActorMessageTs, completionParticipants: progress.completionParticipants,
    legacyBotOnlyCompletion, legacyCompletionMarkerUser: legacyBotOnlyCompletion ? progress.botUserId : "" };
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
