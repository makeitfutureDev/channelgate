// Reply mentions are personal: only the authenticated clicking user can change their setting.
import { setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";

export const REPLY_MENTIONS_HOME_TOGGLE_ACTION = "cg_home_reply_mentions_toggle";

export function replyMentionsHomeBlocks({ enabled = false } = {}) {
  return [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Mention me in replies* — ${enabled ? "on" : "off"}\nAutomatically mention you when delivering your replies in channels and group conversations. This preference follows you across conversations; direct messages do not need a mention.`,
    },
    accessory: {
      type: "button",
      action_id: REPLY_MENTIONS_HOME_TOGGLE_ACTION,
      value: enabled ? "off" : "on",
      text: { type: "plain_text", text: enabled ? "Turn off" : "Turn on", emoji: false },
      ...(enabled ? {} : { style: "primary" }),
    },
  }];
}

export function registerReplyMentionsHomeActions(app, { publishHome } = {}) {
  app.action(REPLY_MENTIONS_HOME_TOGGLE_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = body?.user?.id;
    const value = action?.value;
    if (!userId || !["on", "off"].includes(value)) return;
    const enabled = value === "on";
    try {
      await setUser(userId, { replyMentions: enabled });
      await logEvent("user_reply_mentions_changed", { author: userId, enabled, via: "app_home" });
      if (typeof publishHome === "function") await publishHome(client, userId);
    } catch (error) {
      console.error("[slack] reply mention preference error:", error.message);
    }
  });
}
