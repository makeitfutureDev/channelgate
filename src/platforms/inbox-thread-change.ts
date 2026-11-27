import { notifyThreadChanged } from "../gateway/thread-changes.js";

// Durable queue keys carry both native address components, so even removal of the last row
// can wake the existing authorized subscriber without broadcasting the event or its sender.
export function notifyInboxThread(conversation: string) {
  if (!conversation.startsWith("[")) return;
  try {
    const [channelId, threadTs] = JSON.parse(conversation);
    if (typeof channelId === "string" && typeof threadTs === "string") notifyThreadChanged({ channelId, threadTs });
  } catch { /* Some inboxes use opaque scheduling keys. */ }
}
