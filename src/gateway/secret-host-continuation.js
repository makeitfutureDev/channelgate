// Approval wakeups are durable, deduplicated by approval ID, and serialized with human turns.
import { createDurableInbox } from "../platforms/durable-inbox.js";
import { automationTarget, postNotice } from "../platforms/notify.js";
import { getChannelEntry, getChannelMeta, isAdminPrincipal, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { runMessage } from "./run.js";
import { runQueue } from "../slack/message-lifecycle.js";
import { deliverResult } from "../slack/deliver.js";
import { createUsageBank } from "./usage.js";
import { platformOfConversation } from "../platforms/ids.js";

export function createSecretHostContinuation({ slack, runner = runMessage, deliver = deliverResult, bank = (payload) => createUsageBank()(payload), target = (id) => automationTarget(slack, id) } = {}) {
  let timer;
  const inbox = createDurableInbox({
    namespace: "secret-host-continuation",
    isReady: (channelId) => Boolean(target(channelId)),
    async handle(action) {
      const key = `${action.slug}::${action.threadKey}`;
      const handle = { aborted: false, controller: new AbortController(), authorId: action.authorId, background: true };
      await runQueue.acquire(key, handle);
      try {
        if (handle.aborted) return;
        // Approval grants a destination, never the approver's identity or runtime privileges.
        const entry = await getChannelEntry(action.channelId);
        const meta = await getChannelMeta(action.slug);
        if (!entry || entry.slug !== action.slug || !meta || !isAuthorized(meta, action.authorId, Boolean(entry.isDM), {
          isAdminUser: await isAdminPrincipal(action.authorId), isApprovedUser: await isApproved(action.authorId),
        })) return;
        if (handle.aborted) return;
        const result = await runner({
          channelId: action.channelId, authorId: action.authorId, threadKey: action.threadKey,
          origin: "continuation", signal: handle.controller.signal,
          text: `[automatic continuation] Server approval was granted for variable ${action.secretName} on ${action.host}. `
            + "Continue the user's pending task and retry the request that was refused with secret-refused. "
            + "Check prior results before repeating any completed actions. Never display the variable's value.",
        });
        await bank({ channelId: action.channelId, slug: action.slug, authorId: action.authorId, engine: result.engine, taskKind: "background", result });
        if (handle.aborted) return;
        await deliver(target(action.channelId), { channel: action.channelId, threadKey: action.threadKey, result, footer: true });
      } finally { runQueue.release(key, handle); }
    },
    async interrupted(action) {
      const sent = await postNotice(target(action.channelId), { conversationId: action.channelId, threadKey: action.threadKey,
        text: "⚠️ The automatic continuation after server approval was interrupted. Check the previous result before continuing; it was not run again." });
      if (!sent) throw new Error("Continuation interruption notice could not be delivered");
    },
  });
  return {
    start() {
      inbox.start();
      timer ||= setInterval(() => inbox.wake(), 1000);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; inbox.stop(); },
    enqueue(record) {
      const action = record.action;
      if (!record.id || !action?.authorId || !action.threadKey) return false;
      // Other platforms own different session queues; do not bypass their coordination.
      if (platformOfConversation(action.channelId) !== "slack") return false;
      inbox.accept({ id: record.id, conversationId: action.channelId, payload: action });
      return true;
    },
  };
}
