// A standalone controls card: no run, usage footer, or session creation. It is the same fixed reply
// menu every answer ends with (footer.js), so `/menu` and a reply never disagree about its buttons.
import { menuButtons } from "./footer.js";
import { resolveResumeSession } from "./resume-session.js";

// Cards posted before the menu dropped its Resume button still carry this action id; the handler
// stays registered so those older buttons keep working.
export const MENU_RESUME_ACTION_ID = "cg_menu_resume";

export function buildMenuCard(channelId, threadTs, authorId) {
  return {
    text: "Channel menu: Files, Variables, Settings",
    blocks: [{ type: "actions", elements: menuButtons({ channel: channelId, threadTs, authorId }) }],
  };
}

// Read the current session on click so an old card cannot resurrect a cleared session or select
// another thread. No container needs to start just to display these controls.
export async function buildMenuResumeView({ entry, meta, userIsAdmin = false }, threadTs) {
  const resume = await resolveResumeSession({ entry, meta, isAdminAuthor: userIsAdmin }, threadTs || "");
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
