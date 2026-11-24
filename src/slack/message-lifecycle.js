// Process-lifetime coordination for inbound Slack turns. The pipeline consumes this narrow API;
// queue ownership and duplicate-trigger state no longer live beside normalization and gating.
import { hasCompletedSlackMessage } from "./message-receipts.js";
import { claimSlackMessageTrigger } from "./attachments.js";
import { createRunQueue, createTtlSet } from "./util.js";

export const runQueue = createRunQueue();
const seenMessageTriggers = createTtlSet(5 * 60 * 1000);

export function claimMessageTrigger(event) {
  return claimSlackMessageTrigger(seenMessageTriggers, event) && !hasCompletedSlackMessage(event.channel, event.ts || event.event_ts);
}
