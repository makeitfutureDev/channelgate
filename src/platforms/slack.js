// Slack platform adapter. The transport itself already exists under src/slack/ — this file is the
// descriptor plus the thin ChatConnector that wraps a Bolt WebClient, so the rest of the daemon can
// stop reaching for `client.chat.postMessage` directly.
//
// Slack is the reference surface: every capability here is "yes", which is exactly why the seam had
// to be built before a second platform. Nothing degrades on Slack, so nothing about its behaviour
// changes by routing through the connector.
import { validatePlatformAdapter } from "./contract.js";
import { validateConnector } from "./connector.js";
import { mdToMrkdwn, resolveMentions, chunkMrkdwn } from "../slack/format.js";
import { slackThreadFor } from "../slack/thread-keys.js";
import { getDirectory, normalizeName } from "../slack/directory.js";
import { MAX_SLACK_CHARS } from "../slack/util.js";

export function createSlackConnector(client, { capabilities } = {}) {
  if (!client?.chat?.postMessage) throw new TypeError("createSlackConnector requires a Slack WebClient");
  return validateConnector({
    platform: "slack",
    capabilities,
    ready: () => true,
    client, // escape hatch for the Slack-only surfaces (Block Kit modals, Lists, native charts)

    // One message. `threadKey` is a SESSION key, not necessarily a Slack ts — slackThreadFor is the
    // single rule that turns it into a legal thread_ts (or null = post top-level), shared with the
    // MCP tool servers so a scheduled run's synthetic key can never reach Slack as a thread_ts.
    async post({ conversationId, threadKey, text, ephemeralTo = "", blocks = null } = {}) {
      const thread_ts = threadKey ? slackThreadFor(threadKey) : null;
      const payload = { channel: conversationId, text, ...(thread_ts ? { thread_ts } : {}), ...(blocks ? { blocks } : {}) };
      if (ephemeralTo) {
        try {
          const res = await client.chat.postEphemeral({ ...payload, user: ephemeralTo });
          return { messageId: res?.message_ts || "", conversationId, threadKey, ephemeral: true };
        } catch {
          // Some Slack surfaces refuse threaded ephemerals. Keeping the control usable matters more
          // than its privacy here — the same fallback the in-thread commands already use.
        }
      }
      const res = await client.chat.postMessage(payload);
      return { messageId: res?.ts || "", conversationId: res?.channel || conversationId, threadKey };
    },

    async edit({ conversationId, messageId, text, blocks = null } = {}) {
      await client.chat.update({ channel: conversationId, ts: messageId, text, ...(blocks ? { blocks } : {}) });
    },

    async remove({ conversationId, messageId } = {}) {
      await client.chat.delete({ channel: conversationId, ts: messageId });
    },

    async openDm(userId) {
      const res = await client.conversations.open({ users: userId });
      return res?.channel?.id || "";
    },

    threadFor: (threadKey) => slackThreadFor(threadKey),
    supportsThreads: () => true,
    directory: () => getDirectory(client).catch(() => ({ map: new Map(), maxWords: 1 })),
  });
}

export const slackAdapter = validatePlatformAdapter({
  id: "slack",
  label: "Slack",
  // Slack conversation ids are stored BARE, with no platform prefix: every existing row in the
  // channels/sessions/usage tables predates this seam and must keep resolving. New platforms are
  // prefixed instead (see ids.js).
  idPrefix: "",
  folderName: "slack",
  transport: "socket-mode",
  status: "ga",
  conversationKinds: ["channel", "group", "mpim", "im"],
  capabilities: {
    nativeStreaming: true,
    messageEdit: true,
    editsPerSecond: 1,
    threading: "native",
    mixedThreading: false,
    ephemeral: true,
    deleteMessage: true,
    reactions: true,
    maxMessageChars: MAX_SLACK_CHARS,
    markdown: "mrkdwn",
    // Slack renders small pipe tables in the streamed Markdown renderer; mdToMrkdwn converts the
    // rest. Headings do NOT render (mdToMrkdwn bolds them), hence false.
    markdownTables: true,
    markdownHeadings: false,
    markdownImages: false,
    markdownLists: true,
    blockQuotes: true,
    richCards: "block-kit",
    buttons: true,
    modals: true,
    nativeTables: true,
    nativeCharts: true,
    lists: true,
    canvases: true,
    fileUpload: true,
    snippets: true,
    attachmentsIn: "full",
    seesUnmentionedMessages: true,
    mentionSyntax: "slack",
    mentionByEmail: false,
    broadcast: true,
    proactivePost: true,
    proactiveDm: true,
  },
  formatOutbound(markdown, { directory = null, capabilities = this?.capabilities } = {}) {
    // Slack keeps its existing pipeline byte-for-byte: mdToMrkdwn escapes model-authored control
    // sequences, resolveMentions restores sanctioned "@Name" pings, chunkMrkdwn splits it.
    const text = resolveMentions(mdToMrkdwn(markdown || ""), directory).trim();
    const chunks = chunkMrkdwn(text, Math.min(2900, capabilities?.maxMessageChars || 2900))
      .filter((c) => c.trim())
      .map((c) => ({ text: c, mentions: [] }));
    return { text, chunks };
  },
  createConnector: (client, options) => createSlackConnector(client, options),
  normalizeName,
  health: async () => ({ ready: true, detail: "" }),
});
