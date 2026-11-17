import { getSlackThread, recordSlackThreadMessage, recordSlackThreadParticipation } from "../gateway/slack-threads.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
import { mentionsBot } from "./message-normalize.js";
import { getChannelEntry } from "../config/store.js";
import { accessContext } from "./home-threads.js";
import { onConfigChange } from "../config/change-events.js";

let accessVersion = 0;
onConfigChange(() => { accessVersion++; });

// Authorized original human activity joins/unhides the author's personal list. Only
// messages addressed to this agent reopen Done or resume Later: a mention or a DM.
export async function observeSlackThreadMessage(client, event, botUserId) {
  if (event.subtype && !["file_share", "thread_broadcast", "bot_message", "me_message"].includes(event.subtype)) return;
  const threadTs = event.thread_ts ?? event.ts;
  const human = Boolean(event.user) && event.user !== botUserId && !event.bot_id && !event.app_id && event.subtype !== "bot_message";
  const addressed = event.channel_type === "im" || mentionsBot(event.text, botUserId);
  const row = getSlackThread(event.channel, threadTs);
  let admitted = false;
  if (human && row) {
    // This observer runs before the message pipeline's admission gate. Recheck current
    // gateway/private/sudo access before allowing an inbound event to change saved choices.
    const version = accessVersion;
    const entry = await getChannelEntry(event.channel);
    const access = await accessContext(client, event.user);
    admitted = await access.allows(entry && { ...entry, channelId: event.channel }, threadTs)
      && version === accessVersion;
  }
  if (admitted) recordSlackThreadParticipation(event.channel, threadTs, event.user, event.ts);
  const resumed = recordSlackThreadMessage(event.channel, threadTs, event.ts, { human: admitted && addressed });
  if (resumed) await syncThreadDoneMarker(client, event.channel, threadTs);
}
