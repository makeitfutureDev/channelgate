// The Microsoft Teams ChatConnector.
import { validateConnector } from "../connector.js";
import { parseConversationId } from "../ids.js";
import { createTeamsApi, isConversationId } from "./api.js";
import { buildNameDirectory } from "../format/mentions.js";
import { normalizeName } from "../../slack/directory.js";

const DIRECTORY_TTL_MS = 15 * 60 * 1000;

export function toConversationId(conversationId) {
  const value = String(conversationId || "").trim();
  const { platform, id } = parseConversationId(value);
  return platform === "msteams" ? id : value;
}

export function createTeamsConnector({ auth, capabilities, api = null, botId = "", tenantId = "", serviceUrl, log = console } = {}) {
  const teams = api || createTeamsApi({ auth, ...(serviceUrl ? { serviceUrl } : {}) });
  const directories = new Map();
  const threadFor = (key) => (/^[0-9]+$/.test(String(key || "")) ? String(key) : null);

  async function directoryFor(conversationId) {
    const id = toConversationId(conversationId);
    if (!isConversationId(id)) return { map: new Map(), maxWords: 1 };
    const hit = directories.get(id);
    if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.snapshot;
    try {
      const members = await teams.listMembers(id);
      const snapshot = buildNameDirectory(
        // The mention entity must carry the Bot Framework id, so that is what the directory maps to.
        members.map((m) => ({ id: m.id, names: [m.name, m.email].filter(Boolean) })),
        normalizeName,
      );
      directories.set(id, { snapshot, at: Date.now() });
      return snapshot;
    } catch (err) {
      // A channel roster needs RSC consent the tenant admin may not have granted. Without it
      // mentions simply stay literal text, which is the correct degradation.
      log.warn?.(`[msteams] roster read failed for ${id}: ${err?.message || err}`);
      return hit?.snapshot || { map: new Map(), maxWords: 1 };
    }
  }

  async function openDm(userId) {
    const id = String(userId || "");
    if (!isConversationId(id) || !botId) return "";
    return teams.createConversation({ userId: id, botId, tenantId }).catch(() => "");
  }

  return validateConnector({
    platform: "msteams",
    capabilities,
    ready: () => true,
    api: teams,
    botId,

    // `mentions` is the entity array the Teams formatter produced alongside this chunk's text. Text
    // and entities MUST travel together: an `<at>` tag whose entity was dropped renders as literal
    // markup and pings nobody, which looks like the bot forgot how to address people.
    async post({ conversationId, threadKey, text, mentions = [], footer = "", ephemeralTo = "", buttons = null } = {}) {
      const id = toConversationId(conversationId);
      let body = String(text ?? "");
      if (footer) body += `\n\n_${footer}_`;
      if (buttons?.length) {
        const labels = buttons.map((b) => b?.text || b?.label).filter(Boolean);
        if (labels.length) body += `\n\n_Reply with one of: ${labels.join(" · ")}_`;
      }
      // Teams has no ephemeral message at all. Same rule as Google Chat: a notice addressed to one
      // person goes to their 1:1 chat, and only falls back to the room if that cannot be opened.
      if (ephemeralTo && !capabilities?.ephemeral) {
        const dm = await openDm(ephemeralTo);
        if (dm) {
          const res = await teams.sendActivity(dm, { text: body, entities: mentions });
          return { messageId: res.messageId, conversationId: dm, threadKey: "", ephemeral: true };
        }
      }
      const thread = threadFor(threadKey) || "";
      const res = await teams.sendActivity(id, { text: body, entities: mentions, threadKey: thread });
      return { messageId: res.messageId, conversationId: id, threadKey: thread };
    },

    async edit({ conversationId, messageId, text, mentions = [], footer = "" } = {}) {
      let body = String(text ?? "");
      if (footer) body += `\n\n_${footer}_`;
      await teams.updateActivity(toConversationId(conversationId), messageId, { text: body, entities: mentions });
    },

    async remove({ conversationId, messageId } = {}) {
      await teams.deleteActivity(toConversationId(conversationId), messageId);
    },

    openDm,
    // A Teams thread handle is the root activity id, which is digits. Anything else is a synthetic
    // key from shared plumbing and must post into the conversation itself rather than be smuggled
    // into a ";messageid=" suffix.
    threadFor,
    // Only channels have reply chains; 1:1 and group chats are flat.
    supportsThreads: (conversationId) => String(toConversationId(conversationId)).includes("@thread."),
    directory: (conversationId) => directoryFor(conversationId),
  });
}
