import { getChannelEntry, getChannelMeta } from "../config/store.js";
import { liveConnector } from "../platforms/live.js";
import { deliverConversationAnswer } from "../platforms/answer-delivery.js";
import { rememberReplySession } from "../platforms/reply-sessions.js";
import { mdToMrkdwn } from "../slack/format.js";
import { postChunkedReply } from "../slack/util.js";
import { footerButtons } from "../slack/footer.js";
import { assertChannelMembership } from "./channel-membership.js";
import { canResumeVoice } from "./voice/turn-recovery.ts";
import { assertQuestionAccess } from "./question-access.js";
import { checkMessageAdmission } from "./message-flow.ts";
import { recoverTurnAnswers, slackDeliveryIdentity, type SavedAnswer } from "./turn-answer.ts";

type Slack = { snapshot(): { connected: boolean; teamId?: string | null; botUserId?: string | null }; getClient(): object | null };
export async function recoverConnectedTurnAnswers(slack: Slack, now = Date.now()) {
  async function route(saved: SavedAnswer, ambiguous: boolean) {
    const native = saved.platform === "slack";
    const connector = native ? null : liveConnector(saved.platform);
    const client = native && slack.snapshot().connected ? slack.getClient() : null;
    if (!(native ? client : connector)) return false as const;
    const identity = native ? slackDeliveryIdentity(slack.snapshot().teamId, slack.snapshot().botUserId) : connector.deliveryIdentity;
    if (!saved.identity || identity !== saved.identity) return false as const;
    const entry = await getChannelEntry(saved.channelId);
    if (!entry || entry.slug !== saved.slug || entry.disabled || entry.archived || entry.deleted) return "cancel" as const;
    const meta = await getChannelMeta(entry.slug);
    if (!meta || meta.disabled || meta.archived || meta.deleted) return "cancel" as const;
    if (native) assertChannelMembership({ ...meta, channelId: saved.channelId });
    const { denial } = await checkMessageAdmission({ actorId: saved.authorId, isDM: saved.isDM,
      meta, slug: saved.slug, threadKey: saved.sessionKey });
    if (denial) return "cancel" as const;
    if (saved.access === "voice" && !await canResumeVoice(client, saved)) return "cancel" as const;
    if (saved.access === "question") await assertQuestionAccess(saved, client);
    const text = ambiguous || saved.preview ? `Recovered reply (an earlier copy may already be visible)\n\n${saved.text}` : saved.text;
    if (native) return async () => {
      const buttons = footerButtons({}, { channel: saved.channelId, threadTs: saved.threadKey, authorId: saved.authorId });
      await postChunkedReply(client, saved.channelId, saved.threadKey, mdToMrkdwn(text).trim() || "_(no output)_", saved.footer, buttons);
    };
    return async () => {
      const message = { rawConversationId: saved.rawChannelId, threadKey: saved.threadKey, userId: saved.authorId, isDM: saved.isDM };
      await deliverConversationAnswer(connector, message, saved.placeholder || null, text, sent => {
        if (!saved.isDM && sent?.messageId) rememberReplySession(saved.channelId, sent.messageId, saved.sessionKey);
      }, saved.footer, saved.menu || null);
    };
  }
  await recoverTurnAnswers(route, now);
}

export function startTurnAnswerRecovery(slack: Slack) {
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try { await recoverConnectedTurnAnswers(slack); }
    catch (error) { console.warn("[reply] saved answer recovery failed", (error as Error).name); }
    finally { running = false; }
  }
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
