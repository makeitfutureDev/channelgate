// Authorized chat entry points supply actor and conversation identity. The caller's reply
// function retains its native address, formatting, chunking and quoted-message bookkeeping.
import { runApprovedHarnessesCommand } from "./approved-harnesses.js";
import { activeAgentMail, AgentMailError, parseAskDirective } from "./agent-mail.js";
import { logEvent } from "../util/logger.js";

type ChatFeatureRequest = { channelId: string; slug: string; actor: string } & (
  | { kind: "harnesses"; arg: string; meta: Record<string, unknown>; isAdmin: boolean; source: "slack-command" | "chat-command" }
  | { kind: "ask"; text: string; threadKey: string; platform: string; usage: string; formatName?: (name: string) => string }
);

async function featureReply(request: ChatFeatureRequest): Promise<string | null> {
  if (request.kind === "harnesses") return runApprovedHarnessesCommand(request);
  const ask = parseAskDirective(request.text);
  if (!ask) return null;
  const mail = activeAgentMail();
  if (!mail) return "Agent messaging is not available on this gateway right now.";
  if (!ask.message) return request.usage;
  const { channelId, slug, actor, threadKey, platform } = request;
  try {
    const sent = await mail.send({ channelId, slug, createdBy: actor, threadKey, to: ask.to,
      message: ask.message, origin: `${platform}_foreground` });
    const target = sent.to?.name ? (request.formatName?.(sent.to.name) ?? sent.to.name) : sent.to?.slug || ask.to;
    return `💬 Asked the ${target} agent — its replies land here.`;
  } catch (error) {
    if (!(error instanceof AgentMailError)) throw error;
    await logEvent("agent_message_refused", { channel: channelId, author: actor, slug, to: ask.to,
      reason: error.message, directive: true, platform }).catch(() => {});
    return `🚫 Not sent: ${error.message}`;
  }
}

export async function dispatchChatFeature(request: ChatFeatureRequest, reply: (text: string) => Promise<unknown>): Promise<boolean> {
  const text = await featureReply(request);
  if (text === null) return false;
  await reply(text);
  return true;
}
