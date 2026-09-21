// Self-service quiet-thread reminder preference from Slack App Home. This is a personal setting:
// clicking it can only update body.user.id, and the Home view is republished immediately so the
// visible state always matches what the nudge sweep will read.
import { setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";

export const NUDGE_HOME_TOGGLE_ACTION = "cg_home_nudges_toggle";

export function nudgeHomeBlocks({ enabled = false } = {}) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Quiet-thread reminders* — ${enabled ? "on" : "off"}\nWhen I answer you and the thread stays quiet, I can mention you there once after the configured reminder window. This preference follows you across channels and DMs.`,
      },
      accessory: {
        type: "button",
        action_id: NUDGE_HOME_TOGGLE_ACTION,
        value: enabled ? "off" : "on",
        text: { type: "plain_text", text: enabled ? "Turn off" : "Turn on", emoji: false },
        ...(enabled ? {} : { style: "primary" }),
      },
    },
  ];
}

export function registerNudgeHomeActions(app, { publishHome } = {}) {
  app.action(NUDGE_HOME_TOGGLE_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = body?.user?.id;
    const value = action?.value;
    if (!userId || !["on", "off"].includes(value)) return;
    const enabled = value === "on";
    try {
      await setUser(userId, { nudges: enabled });
      await logEvent("user_nudges_changed", { author: userId, enabled, via: "app_home" });
      if (typeof publishHome === "function") await publishHome(client, userId);
    } catch (error) {
      console.error("[slack] nudge preference error:", error.message);
    }
  });
}
