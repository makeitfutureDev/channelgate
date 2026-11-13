import { getSlackThread, slackThreadIsDone, recordSlackThreadMessage } from "../gateway/slack-threads.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
import { mentionsBot } from "./message-normalize.js";
import { getChannelEntry } from "../config/store.js";
import { accessContext } from "./home-threads.js";
import { onConfigChange } from "../config/change-events.js";

let accessVersion = 0;
onConfigChange(() => { accessVersion++; });

// Observe original activity, but only human messages addressed to this agent reopen Done
// or resume Later: an explicit mention in shared conversations, or a direct message.
export async function observeSlackThreadMessage(client, event, botUserId) {
  if (event.subtype && !["file_share", "thread_broadcast", "bot_message", "me_message"].includes(event.subtype)) return;
  const threadTs = event.thread_ts ?? event.ts;
  const human = Boolean(event.user) && event.user !== botUserId && !event.bot_id && !event.app_id && event.subtype !== "bot_message";
  const addressed = event.channel_type === "im" || mentionsBot(event.text, botUserId);
  const row = getSlackThread(event.channel, threadTs);
  let admitted = false;
  if (human && addressed && row && (slackThreadIsDone(row) || row.later_ms > 0)) {
    // This observer runs before the message pipeline's admission gate. Recheck current
    // gateway/private/sudo access before allowing an inbound event to change saved choices.
    const version = accessVersion;
    const entry = await getChannelEntry(event.channel);
    const access = await accessContext(client, event.user);
    admitted = await access.allows(entry && { ...entry, channelId: event.channel }, threadTs)
      && version === accessVersion;
  }
  const resumed = recordSlackThreadMessage(event.channel, threadTs, event.ts, { human: admitted });
  if (resumed) await syncThreadDoneMarker(client, event.channel, threadTs);
}
