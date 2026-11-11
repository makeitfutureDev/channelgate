import { getChannelEntry } from "../config/store.js";
import { accessContext } from "./home-threads.js";
import { createActivityGrantUrl } from "../web/activity.js";

export const REPLY_DASHBOARD_ACTION_ID = "cg_reply_dashboard";
const OPEN_ACTION_ID = "cg_reply_dashboard_open";

// Shared replies carry only a control, never a user's bearer grant. Issue a fresh link privately
// for the verified clicker, including when they click somebody else's or an automation's reply.
export async function handleReplyDashboardAction({ ack, body, action, client }, { teamId, baseUrl } = {}) {
  await ack();
  const userId = body?.user?.id;
  const channel = body?.channel?.id || body?.container?.channel_id;
  if (!userId || !channel) return;
  let threadTs = body?.message?.thread_ts || body?.message?.ts || "";
  try {
    const command = JSON.parse(action?.value || "{}");
    if (command.c !== channel || !teamId || (body?.team?.id && body.team.id !== teamId)) {
      throw new Error("This Dashboard button is unavailable. Open Activity from Slack Home.");
    }
    threadTs = command.t || threadTs;
    const entry = await getChannelEntry(channel);
    const access = await accessContext(client, userId);
    if ((!access.user.approved && !access.user.isAdmin) || !await access.allows(entry && { ...entry, channelId: channel }, threadTs)) {
      throw new Error("You are not authorized to open Activity from this conversation.");
    }
    const url = createActivityGrantUrl({ ownerId: userId, teamId, baseUrl });
    if (!url) throw new Error("Activity needs a Public URL. Ask an administrator to configure it, or use Activity in Slack Home.");
    await client.chat.postEphemeral({ channel, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}),
      text: "This link expires in 10 minutes.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "This link expires in 10 minutes." } },
        { type: "actions", elements: [{ type: "button", action_id: OPEN_ACTION_ID,
          text: { type: "plain_text", text: "Open my Activity" }, url }] },
      ],
    });
  } catch (error) {
    // Do not include API errors: the successful payload can contain a private launch credential.
    const text = ["This Dashboard button is unavailable. Open Activity from Slack Home.",
      "You are not authorized to open Activity from this conversation.",
      "Activity needs a Public URL. Ask an administrator to configure it, or use Activity in Slack Home."]
      .includes(error.message) ? error.message : "Couldn't open Activity. Try again from Slack Home.";
    await client.chat.postEphemeral({ channel, user: userId, text });
  }
}

export function registerReplyDashboardActions(app, { teamId }) {
  app.action(REPLY_DASHBOARD_ACTION_ID, (args) => handleReplyDashboardAction(args, { teamId }));
  app.action(OPEN_ACTION_ID, async ({ ack }) => { await ack(); });
}
