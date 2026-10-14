// The Google Chat HTTP endpoint: `POST /api/googlechat/events`.
//
// When a Chat app's connection setting is an HTTP endpoint URL, Google POSTs EVERY interaction
// event here — messages, membership, app commands and the card/button clicks a Pub/Sub topic never
// carries — and waits up to 30 seconds for a synchronous answer. This handler verifies the bearer
// token, hands the event object to the SAME `onEvent` the Pub/Sub puller feeds (so gating, dedupe,
// normalization and the durable inboxes are shared), and acknowledges with an empty JSON object.
// Everything the gateway says back goes through the Chat REST API afterwards, exactly as it does
// for a pulled event: the working line, the answer, the private control cards, the card edits. The
// empty acknowledgement is what keeps Chat from printing "unable to process your request".
import { createHash } from "node:crypto";

export const GOOGLE_CHAT_EVENTS_PATH = "/api/googlechat/events";

export function createGoogleChatWebhook({ verify, onEvent, enabled = () => true, log = console } = {}) {
  if (typeof verify !== "function" || typeof onEvent !== "function") throw new TypeError("createGoogleChatWebhook needs verify and onEvent");
  return async function handleGoogleChatEvent(req, res) {
    const reason = enabled();
    if (reason !== true) return res.status(503).json({ error: String(reason || "Google Chat endpoint is not enabled") });
    const result = await verify(req.get?.("authorization") ?? req.headers?.authorization);
    if (!result?.ok) {
      log.warn?.(`[googlechat] endpoint request rejected: ${result?.reason || "unauthorized"}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "invalid event" });
    // Google sends no event id on this path. The body hash is the dedupe key for events that carry
    // no resource name of their own (clicks); a message keeps its `spaces/…/messages/…` name.
    const messageId = `http:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`;
    try {
      await onEvent(body, {}, { messageId, source: "http", sender: result.sender });
    } catch (err) {
      log.error?.(`[googlechat] endpoint event not accepted: ${err?.message || err}`);
      return res.status(500).json({ error: "event not accepted" });
    }
    return res.status(200).json({});
  };
}
