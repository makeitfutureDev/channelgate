// A standalone controls card: no run, usage footer, or session creation.
import { filesButton, secretsButton, settingsButton, buildResumeCommand } from "./footer.js";
import { getSession, getSessionEngine } from "../gateway/sessions.js";
import { effectiveWorkDir } from "../gateway/folders.js";
import { getThreadClean, resolveThreadEngine } from "../gateway/thread-engine.js";
import { resolveRuntime } from "../runtimes/resolve.js";

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
  if (threadTs && await getThreadClean(entry.slug, threadTs)) meta = { ...meta, cleanMode: true };
  const sessionId = threadTs ? await getSession(entry.slug, threadTs) : null;
  let text = threadTs
    ? "No session in this thread yet. Send a message first, then open Resume again."
    : "Open a conversation thread and send `@agent /menu` there to resume its session. In a DM thread, no mention is needed.";
  if (sessionId) {
    const engine = await getSessionEngine(entry.slug, threadTs) || await resolveThreadEngine(entry.slug, threadTs, meta);
    const command = buildResumeCommand(effectiveWorkDir(entry.slug, meta), sessionId, engine, resolveRuntime(entry.slug, meta));
    text = "Run this on the gateway machine to open this thread’s session:\n```" + command + "```";
  }
  return {
    type: "modal",
    title: { type: "plain_text", text: "Resume in terminal" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}
