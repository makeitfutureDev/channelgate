// Native inboxes keep waiting requests in SQLite until the handler can acquire its turn.
// Read only live connector namespaces and threads already authorized for this Activity viewer.
import { getChannelMeta } from "../config/store.js";
import { getDb } from "../db/index.js";
import { checkMessageAdmission } from "../gateway/message-flow.ts";
import { inboundRequestId } from "../gateway/turn-answer.ts";
import { liveConnector } from "./live.js";
import { platformSupports } from "./registry.js";

type Message = { conversationId: string; userId: string; isDM: boolean; mentionsBot?: boolean; trigger?: string; text?: string; attachments?: unknown[] };
type Thread = { channel_id: string; thread_ts: string; slug: string; platform: string };
type InboxRow = { namespace: string; event_id: string; conversation_id: string; data: string };
export type PendingTurn = { channelId: string; threadKey: string; requestId: string; authorId: string; origin: string };

export async function eligiblePendingMessage(platform: string, message: Message | null, slug: string, sessionKey: string) {
  if (!message || !message.text && !message.attachments?.length) return false;
  if (!message.isDM && !message.mentionsBot && !(message.trigger === "reaction" && platformSupports(platform, "reactionTriggers"))) return false;
  const meta = await getChannelMeta(slug);
  if (!meta) return false;
  const { denial } = await checkMessageAdmission({ actorId: message.userId, isDM: message.isDM, meta, slug, threadKey: sessionKey });
  return !denial;
}

export function pendingActivityReader(namespaces: string[], normalize: (row: InboxRow) => Message | null | Promise<Message | null>) {
  return async (threads: Thread[]) => {
    const permitted = new Map(threads.map(row => [JSON.stringify([row.channel_id, row.thread_ts]), row]));
    const rows = getDb().prepare(`SELECT namespace,event_id,conversation_id,data FROM inbound_events
      WHERE namespace IN (SELECT value FROM json_each(?)) AND status='queued'
      AND conversation_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
      .all(JSON.stringify(namespaces), JSON.stringify([...permitted.keys()])) as InboxRow[];
    const pending: PendingTurn[] = [];
    for (const raw of rows) {
      try {
        const thread = permitted.get(raw.conversation_id);
        if (!thread) continue;
        const message = await normalize(raw);
        if (!message?.userId || message.conversationId !== thread.channel_id) continue;
        if (!await eligiblePendingMessage(thread.platform, message, thread.slug, thread.thread_ts)) continue;
        pending.push({ channelId: thread.channel_id, threadKey: thread.thread_ts,
          requestId: inboundRequestId(raw.namespace, raw.event_id), origin: thread.platform + "_foreground", authorId: message.userId });
      } catch { /* An undecodable legacy or currently inadmissible request is private. */ }
    }
    return pending;
  };
}

export async function pendingActivityTurns(authorizedRows: Thread[]): Promise<PendingTurn[]> {
  const groups = new Map<string, Thread[]>();
  for (const row of authorizedRows) {
    const group = groups.get(row.platform);
    if (group) group.push(row);
    else groups.set(row.platform, [row]);
  }
  const results = await Promise.all([...groups].map(async ([platform, rows]) => {
    const connector = liveConnector(platform);
    return await connector?.pendingForActivity?.(rows) || [];
  }));
  return results.flat();
}
