import { recordSlackThreadMessage } from "../gateway/slack-threads.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";

// Observe original message events, including unmentioned replies and DMs. Edits and
// deletions cannot resume a thread; bots only advance the last-message timestamp.
export async function observeSlackThreadMessage(client, event, botUserId) {
  if (event.subtype && !["file_share", "thread_broadcast", "bot_message", "me_message"].includes(event.subtype)) return;
  const threadTs = event.thread_ts ?? event.ts;
  const human = Boolean(event.user) && event.user !== botUserId && !event.bot_id && !event.app_id && event.subtype !== "bot_message";
  const resumed = recordSlackThreadMessage(event.channel, threadTs, event.ts, { human });
  if (resumed) await syncThreadDoneMarker(client, event.channel, threadTs);
}
