import { randomUUID } from "node:crypto";
import { getChannelEntry, getChannelMeta } from "../config/store.js";
import { isCodeChannelMeta } from "../gateway/code-channels.js";
import { getThreadSudo } from "../gateway/thread-engine.js";
import { logEvent } from "../util/logger.js";
import { accessContext } from "./home-threads.js";

export const FORK_ACTION_ID = "cg_reply_fork";
const SUBMIT_ID = "cg_reply_fork_submit";
const INPUT_BLOCK = "fork_request";
const INPUT_ACTION = "message";
const MAX_REQUEST = 6000;
const DRAFT_TTL = 15 * 60_000;
const MAX_DRAFTS = 500;
const SLACK_TS = /^\d{1,16}\.\d{1,6}$/;
const TITLE = "Fork conversation";
const UNAVAILABLE = "This Fork button is unavailable. Open Fork on the reply you want to continue from.";
const UNAUTHORIZED = "You are not authorized to fork this conversation.";
const SUDO = "A sudo thread cannot be forked into an ordinary channel thread.";
const CODE_CHANNEL = "Message forks are available in ordinary Slack threads. Code channels share one session.";
const OPEN_FAILED = "Couldn't open Fork. Try the button again.";

// Slack's trigger_id is valid for three seconds after the click. The clicker's authorization
// needs store reads and, in a private conversation, a Slack membership listing, which can outlast
// that window on a busy daemon — so the modal is opened FIRST in a loading state and filled (or
// replaced by the refusal) once the checks are done. A Slack error code is logged (never its
// payload) so a failed open is diagnosable from the audit feed.
const modal = (blocks, extra = {}) => ({
  type: "modal", title: { type: "plain_text", text: TITLE },
  close: { type: "plain_text", text: "Close" }, blocks, ...extra,
});
const loadingView = () => modal([{ type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Checking your access…" } }]);
const refusalView = (text) => modal([{ type: "section", text: { type: "mrkdwn", text } }]);
const formView = (token) => modal([
  { type: "section", text: { type: "mrkdwn", text: "Start a new thread with recent visible Slack messages through this reply. Up to 200 messages / 24,000 characters are copied; longer history is shortened. Later messages and private tool history are excluded. Files and channel memory remain shared with this channel." } },
  { type: "input", block_id: INPUT_BLOCK, label: { type: "plain_text", text: "Your next message" },
    element: { type: "plain_text_input", action_id: INPUT_ACTION, multiline: true, max_length: MAX_REQUEST } },
], { callback_id: SUBMIT_ID, private_metadata: token,
  submit: { type: "plain_text", text: "Fork" }, close: { type: "plain_text", text: "Cancel" } });
// Only Slack's short error code or the client's error kind; a message or payload may carry content.
const errorCode = (error) => String(error?.data?.error || error?.code || "error").slice(0, 80);

// Store the cutoff on the server: modal metadata contains only a single-use opaque token.
// A restart expires open forms, and a bounded TTL prevents abandoned forms accumulating.
export function registerReplyForkActions(app, processMessageEvent, { botUserId = "", teamId = "" } = {}) {
  const drafts = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [key, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(key);
  };
  const ephemeral = async (client, draft, text) => {
    try {
      await client.chat.postEphemeral({ channel: draft.channel, user: draft.user,
        ...(draft.threadTs ? { thread_ts: draft.threadTs } : {}), text });
    } catch { /* A removed channel/member may no longer accept even an ephemeral error. */ }
  };
  const authorize = async (client, draft) => {
    const entry = await getChannelEntry(draft.channel);
    const access = await accessContext(client, draft.user);
    if ((!access.user.approved && !access.user.isAdmin)
      || (draft.boundAuthor && draft.boundAuthor !== draft.user && !access.user.isAdmin)
      || !await access.allows(entry && { ...entry, channelId: draft.channel }, draft.threadTs)) {
      return { error: UNAUTHORIZED };
    }
    if (await getThreadSudo(entry.slug, draft.threadTs)) return { error: SUDO };
    if (isCodeChannelMeta(await getChannelMeta(entry.slug))) return { error: CODE_CHANNEL };
    return { entry };
  };
  const openFailed = async (client, draft, error, stage) => {
    await logEvent("reply_fork_open_failed", { channel: draft.channel, author: draft.user, stage, error: errorCode(error) });
    await ephemeral(client, draft, OPEN_FAILED);
  };

  app.action(FORK_ACTION_ID, async ({ ack, body, action, client }) => {
    await ack();
    const draft = { channel: body?.channel?.id || body?.container?.channel_id || "",
      user: body?.user?.id || "", threadTs: "" };
    if (!draft.channel || !draft.user) return;
    let command = null;
    try { command = JSON.parse(action?.value || "{}"); } catch { command = null; }
    const message = body?.message;
    const sourceTs = message?.ts;
    const threadTs = message?.thread_ts || sourceTs;
    const actionTs = action?.action_ts;
    if (!command || typeof command !== "object"
      || !teamId || body?.team?.id !== teamId || !botUserId || message?.user !== botUserId
      || command.c !== draft.channel
      || (command.t !== threadTs && !(!message?.thread_ts && command.t === ""))
      || (body?.channel?.id && body?.container?.channel_id && body.channel.id !== body.container.channel_id)
      || (body?.container?.message_ts && body.container.message_ts !== sourceTs)
      || typeof sourceTs !== "string" || !SLACK_TS.test(sourceTs)
      || typeof threadTs !== "string" || !SLACK_TS.test(threadTs)
      || typeof actionTs !== "string" || !SLACK_TS.test(actionTs)
      || (command.u !== undefined && typeof command.u !== "string")) {
      await ephemeral(client, draft, UNAVAILABLE);
      return;
    }
    Object.assign(draft, { teamId, threadTs, sourceTs, actionTs, boundAuthor: command.u || "" });
    // Consume the trigger before any store or Slack read (see the note above).
    let viewId = "";
    let hash = "";
    try {
      const opened = await client.views.open({ trigger_id: body.trigger_id, view: loadingView() });
      if (opened?.ok === false || !opened?.view?.id) throw Object.assign(new Error("Modal unavailable"), { code: "no_view_id" });
      viewId = opened.view.id;
      hash = opened.view.hash || "";
    } catch (error) {
      await openFailed(client, draft, error, "open");
      return;
    }
    const update = (view) => client.views.update({ view_id: viewId, ...(hash ? { hash } : {}), view });
    let token = "";
    try {
      const access = await authorize(client, draft);
      if (access.error) { await update(refusalView(access.error)); return; }
      prune();
      while (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
      token = randomUUID();
      drafts.set(token, { ...draft, expiresAt: Date.now() + DRAFT_TTL });
      const filled = await update(formView(token));
      if (filled?.ok === false) throw Object.assign(new Error("Modal unavailable"), { code: "update_failed" });
    } catch (error) {
      if (token) drafts.delete(token);
      await update(refusalView(OPEN_FAILED)).catch(() => {});
      await openFailed(client, draft, error, "fill");
    }
  });

  app.view(SUBMIT_ID, async ({ ack, body, view, client }) => {
    prune();
    const token = view?.private_metadata;
    const draft = drafts.get(token);
    const error = (text) => ack({ response_action: "errors", errors: { [INPUT_BLOCK]: text } });
    if (!draft || body?.user?.id !== draft.user || body?.team?.id !== draft.teamId) {
      await error("This Fork form expired or is unavailable. Reopen Fork from the selected reply.");
      return;
    }
    const raw = view?.state?.values?.[INPUT_BLOCK]?.[INPUT_ACTION]?.value;
    const task = typeof raw === "string" ? raw.trim() : "";
    if (!task || task.length > MAX_REQUEST) {
      await error(`Enter a message between 1 and ${MAX_REQUEST} characters.`);
      return;
    }
    // Consume synchronously before the first await: concurrent Slack retries cannot dispatch
    // twice. Ack before network-backed membership checks to meet Slack's three-second deadline.
    drafts.delete(token);
    await ack();
    try {
      const access = await authorize(client, draft);
      if (access.error) { await ephemeral(client, draft, access.error); return; }
      const entry = access.entry;
      const channelType = ["channel", "group", "mpim", "im"].includes(entry.type)
        ? entry.type : entry.isDM ? "im" : "";
      await processMessageEvent({ type: "message", channel: draft.channel, channel_type: channelType,
        user: draft.user, thread_ts: draft.threadTs, ts: draft.actionTs, text: `/fork ${task}`, files: [] },
      client, { botUserId, teamId: draft.teamId, bypassMention: true, forkMessageTs: draft.sourceTs });
    } catch {
      // API exceptions may contain message content or credentials; never surface their payloads.
      await ephemeral(client, draft, "Couldn't start the fork. Open Fork on the reply to try again.");
    }
  });
}
