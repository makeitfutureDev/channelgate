import { recordSlackThreadMessage } from "../gateway/slack-threads.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
import { mentionsBot } from "./message-normalize.js";

// Observe original activity, but only human messages addressed to this agent resume
// Later: an explicit mention in shared conversations, or a direct message to the agent.
export async function observeSlackThreadMessage(client, event, botUserId) {
  if (event.subtype && !["file_share", "thread_broadcast", "bot_message", "me_message"].includes(event.subtype)) return;
  const threadTs = event.thread_ts ?? event.ts;
  const human = Boolean(event.user) && event.user !== botUserId && !event.bot_id && !event.app_id && event.subtype !== "bot_message";
  const addressed = event.channel_type === "im" || mentionsBot(event.text, botUserId);
  const resumed = recordSlackThreadMessage(event.channel, threadTs, event.ts, { human: human && addressed });
  if (resumed) await syncThreadDoneMarker(client, event.channel, threadTs);
}
