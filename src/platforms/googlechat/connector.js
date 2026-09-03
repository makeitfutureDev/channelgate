// The Google Chat ChatConnector: the only place that knows how bytes reach a Chat space.
import { validateConnector } from "../connector.js";
import { parseConversationId } from "../ids.js";
import { createChatApi, isSpaceName, isThreadName, isUserName } from "./api.js";
import { buildNameDirectory } from "../format/mentions.js";
import { normalizeName } from "../../slack/directory.js";

const DIRECTORY_TTL_MS = 15 * 60 * 1000;

// Stored conversation ids are qualified (`gchat:spaces/AAA`); the API needs the bare resource name.
// Accepting both here is what lets a caller pass whatever it happens to be holding without every
// call site remembering which form it has.
export function toSpaceName(conversationId) {
  const value = String(conversationId || "").trim();
  const { platform, id } = parseConversationId(value);
  return platform === "googlechat" ? id : value;
}

export function createGoogleChatConnector({ auth, capabilities, api = null, botUserId = "", log = console } = {}) {
  const chat = api || createChatApi({ auth });
  // Per-space member snapshots. Chat has no workspace-wide user list a bot can read, so the
  // directory is per space and built on demand — which is also the only correct scope: resolving
  // "@Ana" against a person who is not in this space would tag a stranger.
  const directories = new Map();

  async function directoryFor(conversationId) {
    const space = toSpaceName(conversationId);
    if (!isSpaceName(space)) return { map: new Map(), maxWords: 1 };
    const hit = directories.get(space);
    if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.snapshot;
    try {
      const members = await chat.listMembers(space);
      const snapshot = buildNameDirectory(
        members.map((m) => ({ id: m.id.replace(/^users\//, ""), names: [m.name, m.email].filter(Boolean) })),
        normalizeName,
      );
      directories.set(space, { snapshot, at: Date.now() });
      return snapshot;
    } catch (err) {
      log.warn?.(`[googlechat] member list failed for ${space}: ${err?.message || err}`);
      // Keep the last good snapshot; mention resolution simply no-ops until the next refresh.
      return hit?.snapshot || { map: new Map(), maxWords: 1 };
    }
  }

  // Defined outside the connector literal so `post()` can call them without depending on `this` —
  // several call sites destructure a connector's methods, and a `this`-bound helper breaks there.
  async function openDm(userId) {
    const raw = String(userId || "");
    // Callers hold whichever identity the inbound message carried: the Chat resource name for a
    // known sender, sometimes a bare id. An email cannot address this endpoint at all.
    const name = isUserName(raw) ? raw : (/^[A-Za-z0-9_-]+$/.test(raw) ? `users/${raw}` : "");
    if (!name) return "";
    return chat.findDirectMessage(name).catch(() => "");
  }

  // The session key the gateway carries is only usable as a Chat thread when it IS one. A synthetic
  // key (a scheduled run's id, a Slack ts inherited from shared plumbing) must post at top level
  // instead of being smuggled into a resource name — the same rule slackThreadFor enforces on the
  // Slack side.
  const threadFor = (threadKey) => (isThreadName(threadKey) ? String(threadKey) : null);

  return validateConnector({
    platform: "googlechat",
    capabilities,
    ready: () => true,
    api: chat, // escape hatch for Chat-only surfaces (Cards v2) once they exist
    botUserId,

    async post({ conversationId, threadKey, text, footer = "", ephemeralTo = "", buttons = null } = {}) {
      const space = toSpaceName(conversationId);
      let body = String(text ?? "");
      if (footer) body += `\n\n_${footer}_`;
      // Chat has no ephemeral message outside a slash-command response, so a control notice meant
      // for one person becomes a DM to that person rather than a public post. Falling back to the
      // space is deliberate: these are approval prompts and run notices, and losing one entirely is
      // worse than showing it to the room.
      if (ephemeralTo && !capabilities?.ephemeral) {
        const dm = await openDm(ephemeralTo).catch(() => "");
        if (dm) {
          const res = await chat.createMessage(dm, { text: body });
          return { messageId: res.messageId, conversationId: dm, threadKey: "", ephemeral: true };
        }
      }
      // Buttons need Cards v2, which the connector does not render yet. An approval prompt that
      // silently loses its controls looks like a hung run, so the actions are named in text.
      if (buttons?.length) {
        const labels = buttons.map((b) => b?.text || b?.label).filter(Boolean);
        if (labels.length) body += `\n\n_Reply with one of: ${labels.join(" · ")}_`;
      }
      const thread = threadFor(threadKey);
      const res = await chat.createMessage(space, { text: body, threadName: thread || "" });
      return { messageId: res.messageId, conversationId: space, threadKey: res.threadName || thread || "" };
    },

    async edit({ messageId, text, footer = "" } = {}) {
      let body = String(text ?? "");
      if (footer) body += `\n\n_${footer}_`;
      await chat.patchMessage(messageId, { text: body });
    },

    // Chat marks a deleted message with a "Message deleted by its author" tombstone, so the daemon
    // should prefer editing. Delete stays implemented because a few paths (an aborted preview) mean
    // it literally.
    async remove({ messageId } = {}) {
      await chat.deleteMessage(messageId);
    },

    openDm,
    threadFor,
    // DMs and unnamed group chats are flat; a named space may or may not be threaded, and the
    // inbound event is what tells us. The connector answers the general question conservatively.
    supportsThreads: (conversationId) => isSpaceName(toSpaceName(conversationId)),
    directory: (conversationId) => directoryFor(conversationId),
  });
}
