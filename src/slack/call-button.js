import { getChannelEntry } from "../config/store.js";
import { voiceCallsAvailable } from "../config/settings.js";
import { accessContext } from "./home-threads.js";
import { activityCallPath, createActivityGrantUrl } from "../web/activity.js";

// The "📞 Call" reply-menu button (footer.js). Like Dashboard, a shared reply carries only a
// control: the click mints a private ten-minute Activity launch for the verified clicker that
// opens the voice-call page bound to this conversation and thread. The call itself is admitted
// again by gateway/voice/calls.js when it starts.
export const REPLY_CALL_ACTION_ID = "cg_reply_call";
const OPEN_ACTION_ID = "cg_reply_call_open";
const UNAVAILABLE = "Voice calls are not enabled on this gateway. Ask an administrator to turn them on under Settings → Voice calls.";
const DENIED = "You are not authorized to call the agent from this conversation.";
const NO_URL = "Voice calls need a Public URL. Ask an administrator to configure it.";
const STALE = "This Call button is unavailable. Use the one on a newer reply.";

export async function handleReplyCallAction({ ack, body, action, client }, { teamId, baseUrl, available = voiceCallsAvailable } = {}) {
  await ack();
  const userId = body?.user?.id;
  const channel = body?.channel?.id || body?.container?.channel_id;
  if (!userId || !channel) return;
  let threadTs = body?.message?.thread_ts || body?.message?.ts || "";
  try {
    const command = JSON.parse(action?.value || "{}");
    if (command.c !== channel || !teamId || (body?.team?.id && body.team.id !== teamId)) throw new Error(STALE);
    threadTs = command.t || threadTs;
    if (!available()) throw new Error(UNAVAILABLE);
    const entry = await getChannelEntry(channel);
    const access = await accessContext(client, userId);
    if ((!access.user.approved && !access.user.isAdmin) || !await access.allows(entry && { ...entry, channelId: channel }, threadTs)) throw new Error(DENIED);
    const next = activityCallPath(channel, threadTs);
    const url = next ? createActivityGrantUrl({ ownerId: userId, teamId, baseUrl, next }) : "";
    if (!url) throw new Error(NO_URL);
    const message = `Your private call link (expires in 10 minutes). The call is logged into this thread.\n<${url}|Call the agent>`;
    await client.chat.postEphemeral({ channel, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}),
      text: message,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: message } },
        { type: "actions", elements: [{ type: "button", action_id: OPEN_ACTION_ID, text: { type: "plain_text", text: "📞 Call the agent" }, url }] },
      ],
    });
  } catch (error) {
    // Never echo API errors: a successful payload carries a private launch credential.
    const text = [STALE, UNAVAILABLE, DENIED, NO_URL].includes(error.message) ? error.message : "Couldn't open the call page. Try again from a newer reply.";
    await client.chat.postEphemeral({ channel, user: userId, text });
  }
}

export function registerReplyCallActions(app, { teamId }) {
  app.action(REPLY_CALL_ACTION_ID, (args) => handleReplyCallAction(args, { teamId }));
  app.action(OPEN_ACTION_ID, async ({ ack }) => { await ack(); });
}
