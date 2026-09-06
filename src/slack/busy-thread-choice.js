import { randomUUID } from "node:crypto";
import {
  acceptPendingRunChoice,
  clearActiveRun,
  clearPendingRunChoice,
  getPendingRunChoice,
  listPendingRunChoices,
  recordPendingRunChoice,
} from "../gateway/active-runs.js";

export const BUSY_THREAD_STEER_ACTION = "cg_busy_thread_steer";
export const BUSY_THREAD_QUEUE_ACTION = "cg_busy_thread_queue";
export const BUSY_THREAD_CANCEL_ACTION = "cg_busy_thread_cancel";
// The three answers a busy-thread card accepts, in button order. Exported so the admin approvals
// API validates against this list rather than a copy of it.
export const BUSY_THREAD_CHOICES = ["steer", "queue", "cancel"];

// One durable, expiring store of "a Slack message is waiting on a button" records, keyed by the
// KIND of question asked: the busy-thread card (steer / queue / cancel) and the harness-switch card
// (src/slack/engine-switch-choice.js) share the table and the TTL but never see each other's rows.
// A record with no kind is a busy-thread one (rows written before kinds existed).
export const BUSY_THREAD_CHOICE_KIND = "busy_thread";
const kindOf = (record) => record?.kind || BUSY_THREAD_CHOICE_KIND;

export function createBusyThreadChoiceStore({ ttlMs = 10 * 60 * 1000, maxEntries = 1000, now = Date.now, kind = BUSY_THREAD_CHOICE_KIND } = {}) {
  const claimed = new Set();
  const limit = Math.max(1, Number(maxEntries) || 1);
  const mine = () => listPendingRunChoices().filter((record) => kindOf(record) === kind);

  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const record of mine()) {
      if ((record.choiceCreatedAt || 0) > cutoff) continue;
      clearPendingRunChoice(record.id);
      claimed.delete(record.id);
    }
  };

  return {
    create(record) {
      sweep();
      const pending = mine();
      for (let index = 0; index <= pending.length - limit; index++) {
        clearPendingRunChoice(pending[index].id);
        claimed.delete(pending[index].id);
      }
      const id = randomUUID();
      const event = record?.event || {};
      const saved = {
        ...record,
        kind,
        channelId: event.channel || "",
        threadKey: event.thread_ts || event.ts || "",
        authorId: event.user || "",
        choiceCreatedAt: now(),
      };
      if (!recordPendingRunChoice(id, saved)) throw new Error("Could not save the busy-thread choice.");
      return id;
    },
    take(id, userId, channelId = "") {
      sweep();
      id = String(id || "");
      const record = getPendingRunChoice(id);
      if (!record || kindOf(record) !== kind) return { ok: false, reason: "expired" };
      if (!userId || record.event?.user !== userId) return { ok: false, reason: "owner" };
      if (channelId && record.event?.channel !== channelId) return { ok: false, reason: "channel" };
      if (claimed.has(id)) return { ok: false, reason: "claimed" };
      claimed.add(id);
      return { ok: true, record };
    },
    // Every card of this kind still waiting on a decision (expired ones swept first). The admin
    // approvals API lists these beside the permission cards.
    list() {
      sweep();
      return mine();
    },
    // Claim a card on behalf of the person who raised it. The admin approvals API resolves the
    // same card an authorized Slack user could click; the ownership rule above is a chat-UI guard
    // (only the sender of THAT message may click), not an authority boundary the admin session
    // has to pass a second time.
    takeAsAdmin(id) {
      const record = getPendingRunChoice(String(id || ""));
      if (!record || kindOf(record) !== kind) return { ok: false, reason: "expired" };
      return this.take(id, record.event?.user || "", "");
    },
    // Remember which Slack message carries this card, so a decision made ANYWHERE (the buttons or
    // the admin API) can retire the card instead of leaving a dead one in the thread.
    noteCard(id, messageTs) {
      const key = String(id || "");
      const record = getPendingRunChoice(key);
      if (!record || kindOf(record) !== kind || !messageTs) return false;
      return recordPendingRunChoice(key, { ...record, choiceMessageTs: String(messageTs) });
    },
    accept(id, runId, rec) {
      const accepted = acceptPendingRunChoice(String(id || ""), runId, rec);
      if (accepted) claimed.delete(String(id || ""));
      return accepted;
    },
    release(id) {
      claimed.delete(String(id || ""));
    },
    discard(id) {
      claimed.delete(String(id || ""));
      return clearPendingRunChoice(String(id || ""));
    },
    // Is a card already waiting on THIS Slack message? Slack redelivers unacked envelopes (most
    // visibly after a restart, when the in-memory envelope dedupe is gone), and a second card for
    // the same message reads to the user as the gateway asking a question they never prompted.
    pendingFor(channelId, ts) {
      if (!channelId || !ts) return null;
      sweep();
      return mine().find((rec) => rec?.event?.channel === channelId && rec?.event?.ts === ts) || null;
    },
    size() {
      sweep();
      return mine().length;
    },
  };
}

export const busyThreadChoices = createBusyThreadChoiceStore();

export function busyThreadChoiceBlocks(id) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "This thread is already running. Should I interrupt it with your new message, add your message to the queue, or drop the new message?",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: BUSY_THREAD_STEER_ACTION,
          text: { type: "plain_text", text: "Steer Conversation" },
          value: id,
        },
        {
          type: "button",
          action_id: BUSY_THREAD_QUEUE_ACTION,
          text: { type: "plain_text", text: "Add to Queue" },
          value: id,
        },
        // Cancel discards ONLY the message waiting on this card. The turn already running keeps
        // going — stopping that is what `stop` / 🛑 is for.
        {
          type: "button",
          style: "danger",
          action_id: BUSY_THREAD_CANCEL_ACTION,
          text: { type: "plain_text", text: "Cancel Request" },
          value: id,
        },
      ],
    },
  ];
}

export async function handleBusyThreadChoice({ ack, body, action, client }, { processMessage }) {
  await ack();
  const userId = body?.user?.id || "";
  const channel = body?.channel?.id || body?.container?.channel_id || "";
  const threadTs = body?.message?.thread_ts || "";
  const choice = action?.action_id === BUSY_THREAD_STEER_ACTION
    ? "steer"
    : action?.action_id === BUSY_THREAD_QUEUE_ACTION
      ? "queue"
      : action?.action_id === BUSY_THREAD_CANCEL_ACTION
        ? "cancel"
        : "";
  if (!choice) return { ok: false, reason: "action" };

  const choiceId = String(action?.value || "");
  const outcome = busyThreadChoices.take(choiceId, userId, channel);
  if (!outcome.ok) {
    const text = outcome.reason === "owner"
      ? "This choice belongs to the person who sent that message."
      : outcome.reason === "claimed"
        ? "This message choice is already being handled."
        : "This choice has already been used, stopped, or expired. Send the message again if it still needs attention.";
    if (channel && userId) {
      await client.chat.postEphemeral({
        channel,
        user: userId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text,
      }).catch(() => {});
    }
    return outcome;
  }

  const messageTs = body?.message?.ts || outcome.record?.choiceMessageTs || "";
  return applyBusyThreadChoice({ choiceId, record: outcome.record, choice, client, channel, messageTs, processMessage });
}

// The half of a busy-thread decision that is NOT Slack-shaped, shared by the button handler and
// the admin approvals API: cancel drops the waiting message durably, steer/queue re-enter the
// pipeline with the exact stored event. Whoever calls this has already claimed the card through
// the store (take / takeAsAdmin), which is what makes a double resolution impossible.
export async function applyBusyThreadChoice({ choiceId, record, choice, client, channel = "", messageTs = "", processMessage }) {
  // Cancel never re-enters the pipeline: the pending message is dropped durably (so no restart or
  // stale click can resurrect it) and the run in progress is deliberately left untouched.
  if (choice === "cancel") {
    busyThreadChoices.discard(choiceId);
    if (client?.chat?.update && channel && messageTs) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: "🚫 Request cancelled — your new message was dropped. The run already in progress is still going.",
        blocks: [],
      }).catch(() => {});
    }
    return { ok: true, choice, cancelled: true };
  }

  let accepted = false;
  try {
    await processMessage(record.event, client, {
      ...(record.options || {}),
      busyChoice: choice,
      busyChoiceId: choiceId,
      onBusyChoiceAccepted: ({ runId, rec }) => {
        accepted = busyThreadChoices.accept(choiceId, runId, rec);
        if (accepted && client?.chat?.delete && channel && messageTs) {
          // The user's follow-up already remains visible in Slack. Once its choice is accepted,
          // remove the temporary bot card instead of turning it into a second persistent message.
          client.chat.delete({ channel, ts: messageTs }).catch(() => {});
        }
        return accepted;
      },
    });
    return { ok: true, choice, accepted };
  } finally {
    busyThreadChoices.release(choiceId);
  }
}

export function registerBusyThreadChoiceActions(app, processMessage) {
  const handler = (payload) => handleBusyThreadChoice(payload, { processMessage });
  app.action(BUSY_THREAD_STEER_ACTION, handler);
  app.action(BUSY_THREAD_QUEUE_ACTION, handler);
  app.action(BUSY_THREAD_CANCEL_ACTION, handler);
}

// Warm Claude sessions support an in-protocol interrupt. Cold Claude turns and Codex runs do not,
// but both receive the active handle's AbortSignal, so aborting that process is the engine-neutral
// steering fallback. Do not set `aborted`: that flag means an explicit stop and would discard the
// accepted successor instead of handing the thread to it.
export function steerActiveRun(runQueue, runKey, { expectedRunId = "", requesterAuthorId = "", interruptWarm = () => false } = {}) {
  const active = runQueue.activeHandle(runKey);
  if (!active) return "idle";
  if (expectedRunId && active.runId !== expectedRunId) return "changed";
  if (requesterAuthorId && active.authorId && active.authorId !== requesterAuthorId) return "other-author";
  active.steered = true;
  // Steering intentionally abandons this exact run. Terminalize it before signalling the
  // in-memory process so a daemon crash in the handoff window cannot replay already-attempted
  // work alongside the durable successor.
  if (active.runId) clearActiveRun(active.runId);
  if (interruptWarm()) return "interrupted";
  active.controller?.abort();
  return "aborted";
}
