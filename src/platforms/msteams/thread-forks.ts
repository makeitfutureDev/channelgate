import { channelForks, type ForkTurn } from "../channel-forks.ts";
import { makeInbound } from "../inbound.js";
import { teamsAdapter } from "../msteams.js";
import { isConversationId } from "./api.js";
import { toConversationId } from "./connector.js";

type Surface = Parameters<typeof channelForks>[0];
type TeamsForkConnector = Surface["connector"] & {
  post: (request: {conversationId: string; threadKey: string; text: string; retry?: boolean}) => Promise<{messageId: string}>;
  startForkTurn?: (turn: ForkTurn) => void;
  supportsThreads: (id: string) => boolean;
};
const validRoot = (id: string) => /^\d+$/.test(String(id || ""));

export function teamsForkThreadUrl(conversationId: string, thread: string) {
  if (!isConversationId(conversationId) || !validRoot(thread)) return "";
  const url = new URL(`https://teams.microsoft.com/l/message/${encodeURIComponent(conversationId)}/${encodeURIComponent(thread)}`);
  url.searchParams.set("parentMessageId", thread);
  return url.href;
}

export function createTeamsThreadForks({ connector, conversation, log }: {
  connector: TeamsForkConnector; conversation: Surface["conversation"]; log?: Surface["log"];
}) {
  return {
    refusal: (id: string) => connector.supportsThreads(toConversationId(id)) ? "" : "Forks need a Microsoft Teams channel with reply chains.",
    ...channelForks({
      platform: "msteams", name: "Microsoft Teams", place: "a Teams channel", conversation, connector, log,
      ready: () => typeof connector.startForkTurn === "function",
      post: (conversationId, threadKey, text) => {
        const chunks = teamsAdapter.formatOutbound(text).chunks;
        // A fork post fits a single Teams activity (approved previews are capped at 2400 chars).
        // Do not retry a remote write whose acknowledgement may have been lost.
        return connector.post({ conversationId, threadKey, text: chunks.map((c: {text: string}) => c.text).join("\n"), retry: false });
      },
      root: (_id, root) => validRoot(root?.messageId) ? { threadKey: root.messageId, messageId: root.messageId } : null,
      validMessage: (_id, messageId) => validRoot(messageId),
      link: teamsForkThreadUrl,
      enqueue: turn => {
        if (!connector.startForkTurn) throw new Error("Microsoft Teams is not connected.");
        connector.startForkTurn(turn);
      },
    }),
  };
}

// The durable fork payload lives outside the inbound HTTP activity. The requester remains the
// author of the first turn although the bot owns the root and opening message in Teams.
export function teamsForkInbound(turn: ForkTurn) {
  if (!isConversationId(turn.conversationId) || !validRoot(turn.threadKey) || !validRoot(turn.messageId) ||
      !turn.authorId || !turn.fork?.sourceSessionId || !turn.fork.id) throw new Error("Invalid Teams fork opening request.");
  const message = { platform: "msteams", conversationId: turn.conversationId, conversationName: turn.conversationName,
    kind: "channel", userId: turn.authorId, userName: turn.authorName, threadKey: turn.threadKey, messageId: turn.messageId,
    text: turn.text, mentionsBot: true };
  return makeInbound(message);
}
