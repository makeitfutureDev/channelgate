import { plainFailureText } from "../util/process-outcome.js";
import { engineLabel } from "../engines/registry.js";
import { createBusyThreadChoiceStore } from "./busy-thread-choice.js";

// "Ask before switching harness" (Settings → engineFallbackMode = "ask"): when a turn dies on a
// replay-safe provider failure that automatic failover WOULD have covered — a usage limit, a lost
// credential, or a provider that stayed unavailable through the in-place retries — the thread gets
// this card instead of a silent switch. A click re-enters the message pipeline with the ORIGINAL
// Slack event (same message, same attachments, same thread), on the harness the person chose:
// "Switch" also makes the thread continue on that harness (the same per-thread pin the `claude` /
// `codex` directive sets), "Try again" re-runs it where it failed. Same durable, expiring,
// single-shot store as the busy-thread card, so a restart, a stale click, or a 🛑 behave the same way.
export const ENGINE_SWITCH_ACTION = "cg_engine_switch";
export const ENGINE_RETRY_ACTION = "cg_engine_retry";
export const ENGINE_SWITCH_CHOICE_KIND = "engine_switch";

export function createEngineSwitchChoiceStore(options = {}) {
  return createBusyThreadChoiceStore({ ttlMs: 15 * 60 * 1000, ...options, kind: ENGINE_SWITCH_CHOICE_KIND });
}
export const engineSwitchChoices = createEngineSwitchChoiceStore();

// What happened, in one plain sentence. `ask` is the record's `ask` field (see the pipeline):
// { failedEngine, otherEngine, kind, transientRetries, bothFailed, fallbackError }.
export function engineSwitchChoiceText(ask = {}) {
  const failed = engineLabel(ask.failedEngine);
  const other = engineLabel(ask.otherEngine);
  const retries = Number(ask.transientRetries) || 0;
  const what = ask.kind === "authentication"
    ? `${failed} could not authenticate`
    : ask.kind === "usage_limit"
      ? `${failed} hit its usage limit`
      : retries
        ? `${failed} hit a temporary provider error — retried ${retries}× before giving up`
        : `${failed} hit a temporary provider error`;
  if (ask.bothFailed) {
    const why = plainFailureText(ask.fallbackError, 300);
    return `⚠️ ${what}, and ${other} could not answer either${why ? ` (${why.slice(0, 300)})` : ""}. Nothing ran for your message. Try again on either harness?`;
  }
  return `⚠️ ${what}. Nothing ran for your message. Switch this thread to ${other}, or try ${failed} again?`;
}

export function engineSwitchChoiceBlocks(id, ask = {}) {
  const failed = engineLabel(ask.failedEngine);
  const other = engineLabel(ask.otherEngine);
  const buttons = ask.bothFailed
    ? [
      { type: "button", style: "primary", action_id: ENGINE_RETRY_ACTION, text: { type: "plain_text", text: `Try ${failed} again` }, value: id },
      { type: "button", action_id: ENGINE_SWITCH_ACTION, text: { type: "plain_text", text: `Try ${other} again` }, value: id },
    ]
    : [
      { type: "button", style: "primary", action_id: ENGINE_SWITCH_ACTION, text: { type: "plain_text", text: `Switch to ${other}` }, value: id },
      { type: "button", action_id: ENGINE_RETRY_ACTION, text: { type: "plain_text", text: `Try ${failed} again` }, value: id },
    ];
  return [
    { type: "section", text: { type: "mrkdwn", text: engineSwitchChoiceText(ask) } },
    { type: "actions", elements: buttons },
  ];
}

export async function handleEngineSwitchChoice({ ack, body, action, client }, { processMessage }) {
  await ack();
  const userId = body?.user?.id || "";
  const channel = body?.channel?.id || body?.container?.channel_id || "";
  const threadTs = body?.message?.thread_ts || "";
  const choice = action?.action_id === ENGINE_SWITCH_ACTION ? "switch" : action?.action_id === ENGINE_RETRY_ACTION ? "retry" : "";
  if (!choice) return { ok: false, reason: "action" };

  const choiceId = String(action?.value || "");
  const outcome = engineSwitchChoices.take(choiceId, userId, channel);
  if (!outcome.ok) {
    const text = outcome.reason === "owner"
      ? "This choice belongs to the person who sent that message."
      : outcome.reason === "claimed"
        ? "This choice is already being handled."
        : "This choice has already been used, stopped, or expired. Send the message again if it still needs attention.";
    if (channel && userId) {
      await client.chat.postEphemeral({ channel, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}), text }).catch(() => {});
    }
    return outcome;
  }

  const ask = outcome.record.ask || {};
  // "Switch" runs on the other harness and pins the thread to it; "Try again" re-runs where it failed.
  const engine = choice === "switch" ? ask.otherEngine : ask.failedEngine;
  const messageTs = body?.message?.ts;
  if (channel && messageTs) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: choice === "switch" ? `↪️ Switching this thread to ${engineLabel(engine)}…` : `🔁 Trying ${engineLabel(engine)} again…`,
      blocks: [],
    }).catch(() => {});
  }

  let accepted = false;
  try {
    await processMessage(outcome.record.event, client, {
      ...(outcome.record.options || {}),
      engineChoice: engine,
      engineChoiceSwitch: choice === "switch",
      engineChoiceId: choiceId,
      onEngineChoiceAccepted: ({ runId, rec }) => {
        accepted = engineSwitchChoices.accept(choiceId, runId, rec);
        // The original message stays visible in Slack; once the choice is accepted the card has
        // done its job — remove it instead of leaving a second persistent bot message.
        if (accepted && channel && messageTs) client.chat.delete({ channel, ts: messageTs }).catch(() => {});
        return accepted;
      },
    });
    return { ok: true, choice, engine, accepted };
  } finally {
    engineSwitchChoices.release(choiceId);
  }
}

export function registerEngineSwitchChoiceActions(app, processMessage) {
  const handler = (payload) => handleEngineSwitchChoice(payload, { processMessage });
  app.action(ENGINE_SWITCH_ACTION, handler);
  app.action(ENGINE_RETRY_ACTION, handler);
}
