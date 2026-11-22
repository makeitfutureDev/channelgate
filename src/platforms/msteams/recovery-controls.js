// "Run again" on a Teams request interrupted by a restart (or a failed handler). The gateway never
// replays such a request by itself — its outcome is unknown and external actions may already have
// happened — so the notice hands the decision to the person who asked. The card names only a held
// durable record; the transport checks the clicker against that record's author and conversation,
// and the replay passes every ordinary message gate again when it runs.
import { logEvent } from "../../util/logger.js";

export const RECOVERY_RETRY_ACTION = "recovery.retry";
const RETRY_ID = /^[0-9a-f-]{36}$/;

const block = (text, extra = {}) => ({ type: "TextBlock", text, wrap: true, ...extra });
const card = (body, actions = []) => ({ type: "AdaptiveCard", version: "1.4", body, ...(actions.length ? { actions } : {}) });

export function interruptedCard(text, retryId) {
  const data = { cgAction: RECOVERY_RETRY_ACTION, r: retryId };
  return card([block("⚠️ Interrupted", { weight: "Bolder" }), block(text),
    block("Check the conversation first. If it should run again, the person who asked can choose Run again within 24 hours.", { isSubtle: true })],
  [{ type: "Action.Execute", title: "Run again", verb: RECOVERY_RETRY_ACTION, data,
    fallback: { type: "Action.Submit", title: "Run again", data } }]);
}

const REASONS = {
  owner: "Only the person who sent the interrupted request can run it again.",
  conversation: "This control belongs to a different conversation.",
  expired: "This request is more than 24 hours old. Send it again if it is still needed.",
  gone: "This request was already run again or is no longer available. Send it again if it is still needed.",
};

export function createTeamsRecoveryControls({ connector } = {}) {
  async function onAction(interaction, { respond }) {
    const id = String(interaction.data.r || "");
    if (!RETRY_ID.test(id) || typeof connector.retryInterrupted !== "function") return respond(card([block(REASONS.gone)]));
    const result = connector.retryInterrupted({ id, actorId: interaction.actorId, conversationId: interaction.conversationId });
    await logEvent("teams_interrupted_retry", { channel: interaction.conversationId, author: interaction.actorId,
      outcome: result.ok ? "queued" : result.reason });
    if (!result.ok) return respond(card([block(REASONS[result.reason] || REASONS.gone)]));
    const text = "🔁 Running the interrupted request again.";
    // The shared card loses its button for everyone, not only for the clicker.
    if (interaction.responseMessageId && typeof connector.updateCard === "function") {
      await connector.updateCard({ conversationId: interaction.nativeConversationId, messageId: interaction.responseMessageId,
        card: card([block(text)]), text }).catch(() => {});
    }
    return respond(card([block(text)]));
  }
  return { onAction, isAction: action => action === RECOVERY_RETRY_ACTION };
}
