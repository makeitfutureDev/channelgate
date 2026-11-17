// Explicit completion on behalf of an authenticated caller. A stored owner is never enough:
// verify the Slack root, current admission/private/sudo access and caller liveness before writing.
import { getChannelEntry } from "../config/store.js";
import { onConfigChange } from "../config/change-events.js";
import { accessContext } from "./home-threads.js";
import { getSlackThread, slackThreadRootOwner, isSlackThreadEligible, slackThreadIsDone, setSlackThreadDone, recordSlackThreadMessage, recordSlackThreadParticipation, markSlackThreadCompletionDismissed } from "../gateway/slack-threads.js";
import { markDone, clearDone } from "../gateway/followups.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
import { isSlackTs } from "./thread-keys.js";

let accessVersion = 0;
onConfigChange(() => { accessVersion++; });
const denied = () => Object.assign(new Error("Only the thread's starter with current conversation access can mark it Done. Other participants can use Hide in Activity."), { status: 403 });

export async function completeThreadForCaller(client, { channelId, threadTs, userId, assertCurrent = () => {} }) {
  if (!channelId || !isSlackTs(threadTs) || !userId) throw denied();
  const version = accessVersion;
  const check = async () => {
    const row = getSlackThread(channelId, threadTs);
    if (!row || row.starter_id !== userId || !isSlackThreadEligible(row)) throw denied();
    const entry = await getChannelEntry(channelId);
    const ctx = await accessContext(client, userId);
    if (!await ctx.allows(entry && { ...entry, channelId }, threadTs)) throw denied();
  };
  await check();
  const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
  const root = result?.ok !== false && result?.messages?.find((message) => message.ts === threadTs);
  if (slackThreadRootOwner(channelId, root) !== userId) throw denied();
  await check();
  // This callback is synchronous: after it, no awaited work separates authorization from mutation.
  assertCurrent();
  if (version !== accessVersion) throw denied();
  const row = getSlackThread(channelId, threadTs);
  if (!row || row.starter_id !== userId || !isSlackThreadEligible(row)) throw denied();
  const alreadyDone = slackThreadIsDone(row);
  if (!alreadyDone && !setSlackThreadDone(channelId, threadTs, userId, true)) throw denied();
  if (alreadyDone) markSlackThreadCompletionDismissed(channelId, threadTs, userId);
  markDone(userId, channelId, threadTs);
  await syncThreadDoneMarker(client, channelId, threadTs);
  const current = getSlackThread(channelId, threadTs);
  return { done: slackThreadIsDone(current), alreadyDone, markerPending: Boolean(current?.completion_marker_retry_ms), title: current?.title || row.title };
}

// A spoken task is an explicit caller request even though Slack transports it as a bot post.
// Use only its successfully posted Slack timestamp, with the caller's current access rechecked.
export async function recordVoiceThreadRequest(client, { channelId, threadTs, messageTs, userId, assertCurrent = () => {} }) {
  if (!isSlackTs(messageTs) || !isSlackTs(threadTs) || !userId) return false;
  const version = accessVersion;
  const entry = await getChannelEntry(channelId);
  const ctx = await accessContext(client, userId);
  if (!await ctx.allows(entry && { ...entry, channelId }, threadTs)) throw new Error("You no longer have access to this conversation.");
  assertCurrent();
  if (version !== accessVersion) throw new Error("You no longer have access to this conversation.");
  recordSlackThreadParticipation(channelId, threadTs, userId, messageTs);
  const resumed = recordSlackThreadMessage(channelId, threadTs, messageTs, { human: true });
  if (resumed) {
    clearDone(userId, channelId, threadTs);
    await syncThreadDoneMarker(client, channelId, threadTs);
  }
  return resumed;
}
