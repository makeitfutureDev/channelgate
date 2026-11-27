import { createActivityGrantUrl } from "../web/activity.js";

// The Home view is private to this viewer. Never place a launch grant in a channel message.
export function activityHomeActions({ ownerId, teamId, baseUrl, approved }) {
  if (!approved) return [];
  const url = createActivityGrantUrl({ ownerId, teamId, baseUrl });
  if (!url) return [];
  return [{ type: "button", action_id: "cg_activity_open",
    text: { type: "plain_text", text: "Open live dashboard" }, style: "primary", url }];
}
