// A standalone controls card: no run, usage footer, or session creation.
import { filesButton, secretsButton, settingsButton } from "./footer.js";
import { resolveResumeSession } from "./resume-session.js";

export const MENU_RESUME_ACTION_ID = "cg_menu_resume";

export function buildMenuCard(channelId, threadTs, authorId) {
  return {
    text: "Channel menu: Resume, Files, Secrets, Settings",
    blocks: [{ type: "actions", elements: [
      {
        type: "button", action_id: MENU_RESUME_ACTION_ID,
        text: { type: "plain_text", text: "💻 Resume", emoji: true },
        accessibility_label: "Resume this thread in a terminal",
        value: JSON.stringify({ c: channelId, t: threadTs || "", u: authorId }),
      },
      filesButton(channelId, threadTs, authorId, "📂 Files"),
      secretsButton(channelId, threadTs, authorId, "🔑 Secrets"),
      settingsButton(channelId, threadTs, authorId, true),
    ] }],
  };
}

// Read the current session on click so an old card cannot resurrect a cleared session or select
// another thread. No container needs to start just to display these controls.
export async function buildMenuResumeView({ entry, meta }, threadTs) {
  const resume = await resolveResumeSession({ entry, meta }, threadTs || "");
  let text = threadTs
    ? "No session in this thread yet. Send a message first, then open Resume again."
    : "Open a conversation thread and send `@agent /menu` there to resume its session. In a DM thread, no mention is needed.";
  if (resume.command) text = "Run this on the gateway machine to open this thread’s session:\n```" + resume.command + "```";
  return {
    type: "modal",
    title: { type: "plain_text", text: "Resume in terminal" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}
