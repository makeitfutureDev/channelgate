// Voice auto-start is personal: only the authenticated clicking user can change their setting.
import { slackActorId } from "./actor.js";
import { setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";

export const VOICE_AUTO_START_HOME_TOGGLE_ACTION = "cg_home_voice_auto_start_toggle";

export function voiceAutoStartHomeBlocks({ enabled = false } = {}) {
  return [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Start on voice clips in agent threads* — ${enabled ? "on" : "off"}\nWhen you reply with a voice clip in a thread where I answered last, I start without an @mention or 🤖. Never on top-level channel messages, and never when the clip mentions someone.`,
    },
    accessory: {
      type: "button",
      action_id: VOICE_AUTO_START_HOME_TOGGLE_ACTION,
      value: enabled ? "off" : "on",
      text: { type: "plain_text", text: enabled ? "Turn off" : "Turn on", emoji: false },
      ...(enabled ? {} : { style: "primary" }),
    },
  }];
}

export function registerVoiceAutoStartHomeActions(app, { publishHome } = {}) {
  app.action(VOICE_AUTO_START_HOME_TOGGLE_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = slackActorId(body);
    const value = action?.value;
    if (!userId || !["on", "off"].includes(value)) return;
    const enabled = value === "on";
    try {
      await setUser(userId, { voiceAutoStart: enabled });
      await logEvent("user_voice_auto_start_changed", { author: userId, enabled, via: "app_home" });
      if (typeof publishHome === "function") await publishHome(client, userId);
    } catch (error) {
      console.error("[slack] voice auto-start preference error:", error.message);
    }
  });
}
