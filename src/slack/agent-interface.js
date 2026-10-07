// Slack's newer agent interface surfaces, wired as Bolt handlers: the native Stop button
// (`agent_session_stopped`), session renames (`agent_session_title_changed`), the 👍/👎 answer
// feedback controls, and the ack-only URL buttons inside composed replies and data-table rows.
// Kept out of app.js so the handlers can be exercised without the whole Bolt wiring.
import { logEvent } from "../util/logger.js";
import { stoppedSessionTarget } from "./agent-sessions.js";
import { REPLY_FEEDBACK_ACTION_ID, parseFeedbackValue } from "./footer.js";
import { TABLE_ROW_ACTION_ID } from "./tables.js";

export const TABLE_ROW_ACTION_PATTERN = new RegExp(`^${TABLE_ROW_ACTION_ID}(?:$|_)`);
export const REPLY_LINK_ACTION_PATTERN = /^cg_reply_link(?:$|_)/;

export function registerAgentInterfaceHandlers(app, {
  botUserId = "",
  seenEvents,
  authorizedControlEntry,
  stopRunsInChannel,
  setAssistantStatus,
} = {}) {
  // Native Stop: Slack halts the in-progress streams itself (`streaming_message_ts`) and tells us
  // which thread's session the user stopped. The stop is scoped to that one thread and passes the
  // same authorization gate as a `stop` message or a 🛑 reaction. Whether or not a run was found,
  // the session is moved off `processing` — Slack never does that on its own, so a stale press
  // would otherwise leave the loading UX up for an hour.
  app.event("agent_session_stopped", async ({ event, client, body }) => {
    try {
      const target = stoppedSessionTarget(event);
      if (!target || target.user === botUserId) return;
      const eventKey = body?.event_id || `agent-stop:${target.channel}:${target.threadTs}:${event?.event_ts || ""}`;
      if (seenEvents && !seenEvents.add(eventKey)) return;
      const entry = await authorizedControlEntry(target.channel, target.user);
      let stopped = 0;
      if (entry) stopped = await stopRunsInChannel(client, target.channel, entry.slug, target.user, target.threadTs);
      if (!stopped) void setAssistantStatus?.(client, target.channel, target.threadTs, "");
      void logEvent("agent_session_stopped", {
        channel: target.channel,
        threadKey: target.threadTs,
        author: target.user,
        slug: entry?.slug || "",
        authorized: Boolean(entry),
        runs: stopped,
        streams: target.streamingMessageTs.length,
      });
    } catch (e) {
      console.error("[slack] agent_session_stopped error:", e?.message || e);
    }
  });

  // A user renamed the session from Slack's own UI. Nothing to apply (titles are Slack-owned);
  // recorded so the thread's history explains the new name.
  app.event("agent_session_title_changed", async ({ event }) => {
    const channel = String(event?.channel || "");
    const threadTs = String(event?.thread_ts || "");
    if (!channel || !threadTs) return;
    void logEvent("agent_session_renamed", {
      channel,
      threadKey: threadTs,
      author: String(event?.user || ""),
      title: String(event?.title || "").slice(0, 200),
    });
  });

  // 👍 / 👎 on an answer. Any channel member's verdict counts; it is an opinion, not a privilege.
  app.action(REPLY_FEEDBACK_ACTION_ID, async ({ ack, body, action, client }) => {
    await ack();
    try {
      const parsed = parseFeedbackValue(action?.value ?? action?.selected_option?.value);
      if (!parsed) return;
      const channel = body?.channel?.id || body?.container?.channel_id || parsed.channel;
      const messageTs = body?.message?.ts || body?.container?.message_ts || "";
      const threadTs = body?.message?.thread_ts || parsed.threadTs || messageTs;
      const user = body?.user?.id || "";
      void logEvent("reply_feedback", {
        channel,
        threadKey: threadTs,
        messageTs,
        author: user,
        verdict: parsed.verdict,
        requester: parsed.authorId,
      });
      if (parsed.verdict === "down" && channel && user && typeof client?.chat?.postEphemeral === "function") {
        await client.chat.postEphemeral({
          channel,
          user,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: "Thanks for the 👎 — reply in this thread with what was off and I'll fix it.",
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[slack] reply feedback error:", e?.message || e);
    }
  });

  // URL buttons open in the client; Slack still dispatches a block_actions payload that must be
  // acknowledged or the button shows a warning. Nothing else to do.
  app.action(TABLE_ROW_ACTION_PATTERN, async ({ ack }) => { await ack(); });
  app.action(REPLY_LINK_ACTION_PATTERN, async ({ ack }) => { await ack(); });
}
