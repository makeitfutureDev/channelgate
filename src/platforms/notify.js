// The one place daemon-side automation posts a message.
//
// Nine gateway modules — scheduler, background jobs, follow-up digests, nudges, self-diagnosis,
// restart recovery, API runs, shutdown, transcription — post unattended notices into a
// conversation. Each used to build the Slack wire payload itself (`chat.postMessage({ thread_ts })`,
// ~22 call sites), which meant a second surface would have needed twenty-two edits and would have
// silently broken on the first one anybody missed. They call postNotice() instead, and the
// connector owns the wire format.
//
// The bridge is deliberate: these call sites currently receive a raw Slack `client` through their
// existing plumbing, so `asConnector` accepts either a connector or a Slack client and wraps the
// latter. That keeps this slice a pure refactor. When the turn pipeline is extracted, the plumbing
// carries a connector end to end and the wrapping branch goes away.
import { createSlackConnector, slackAdapter } from "./slack.js";
import { liveConnector } from "./live.js";
import { platformOfConversation } from "./ids.js";

const wrapped = new WeakMap();

export function asConnector(clientOrConnector) {
  if (!clientOrConnector) return null;
  // A connector identifies itself; anything else with a Slack chat API is a legacy WebClient.
  if (clientOrConnector.platform && typeof clientOrConnector.post === "function") return clientOrConnector;
  if (!clientOrConnector.chat?.postMessage) return null;
  let connector = wrapped.get(clientOrConnector);
  if (!connector) {
    connector = createSlackConnector(clientOrConnector, { capabilities: slackAdapter.capabilities });
    wrapped.set(clientOrConnector, connector);
  }
  return connector;
}

// Post one unattended notice. Returns the posted message ({ messageId, conversationId, threadKey }),
// which several callers need — the follow-up digest edits its own message later and self-diagnosis
// uses the posted id as the session key for the thread it just opened.
//
// `blocks` is a SLACK-ONLY rich payload. It is accepted here (rather than at a raw client call)
// precisely so the connector can decide: a platform without Block Kit ignores it and the plain
// `text` still delivers, instead of the call failing or posting nothing.
export async function postNotice(target, { conversationId, threadKey = "", text, blocks = null, ephemeralTo = "" } = {}) {
  const connector = asConnector(target);
  if (!connector) return null;
  const payload = { conversationId, threadKey, text, ephemeralTo };
  if (blocks && connector.capabilities?.richCards === "block-kit") payload.blocks = blocks;
  return connector.post(payload);
}

// Post something that must reach ONE person and nobody else — an approval link is a bearer
// credential minted for the requester, so the shared thread is the one place it may never appear.
//
// Where the platform has an ephemeral primitive (Slack) that is the delivery: it lands in the same
// thread the card is in, so the context is right there. Where it does not (Teams and Google Chat
// both declare `ephemeral: false`), the private equivalent is a 1:1 message. The ephemeral attempt
// is `ephemeralOnly`, which suppresses the connector's ordinary "fall back to a public post"
// behaviour — a failure here falls back to the DM, never to the channel.
export async function postPrivately(target, { conversationId, threadKey = "", userId, text, blocks = null } = {}) {
  const connector = asConnector(target);
  if (!connector || !userId || !text) return null;
  if (connector.capabilities?.ephemeral) {
    const payload = { conversationId, threadKey, text, ephemeralTo: userId, ephemeralOnly: true };
    if (blocks && connector.capabilities?.richCards === "block-kit") payload.blocks = blocks;
    const sent = await connector.post(payload).catch(() => null);
    if (sent?.ephemeral) return sent;
  }
  return postDirectMessage(connector, { userId, text, blocks }).catch(() => null);
}

// Open (or find) the 1:1 conversation with a user and post into it. The scheduler's acknowledgement
// DMs and the follow-up digest both need this, and "open a DM" is a different API on every surface.
export async function postDirectMessage(target, { userId, text, blocks = null } = {}) {
  const connector = asConnector(target);
  if (!connector) return null;
  const conversationId = await connector.openDm(userId);
  if (!conversationId) return null;
  return postNotice(connector, { conversationId, text, blocks });
}

// Resolve readiness for the destination surface. An unrelated Slack outage must never hold a
// Chat/Teams result, and a Slack client must never receive a namespaced foreign conversation id.
export function automationTarget(slackManager, conversationId) {
  const platform = platformOfConversation(conversationId);
  const live = liveConnector(platform);
  if (live && live.ready?.() !== false) return live;
  const client = slackManager?.snapshot?.().connected ? slackManager.getClient?.() : null;
  return asConnector(client)?.platform === platform ? client : null;
}
