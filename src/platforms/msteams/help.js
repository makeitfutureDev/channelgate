// Practical Teams /help copy. Commands are handled before an engine turn; keep the guide
// aligned with the native Teams controls and the shared conversation controls.
export const TEAMS_HELP_TEXT =
  '**How to use me**\n' +
  'In a personal chat, just send your request. In a channel or group chat, select the bot mention and write `@agent your request`, including for commands such as `@agent /help`. Keep channel follow-ups in the same thread and mention me again. In group chats, quote the original message or my reply and mention me to continue or control that session; a new unquoted group message starts a new session.\n\n' +
  '• **Act on a message:** where Teams reaction events are enabled and delivered to the gateway, react 🤖 (**Heart eyes robot**) to ask me to act on that message. Otherwise, mention me with your request.\n' +
  '• **Reaction names:** 🤖 `:robot_face:` — Heart eyes robot; 🛑 `:octagonal_sign:` — Stop sign; ✅ `:white_check_mark:` — Tick button. In Teams, stopping uses `/stop` or `/cancel`; Stop sign and Tick button reactions currently have no gateway action.\n' +
  '• **Voice prompts:** attach a downloadable voice note and mention me in channels/groups; personal chats need no mention. Voice notes require local Whisper to be enabled and installed. Typed text stays as instructions, and raw audio is never sent to Claude or Codex. If transcription is unavailable, send text or ask an administrator to check Whisper.\n' +
  '• **Control a live run:** send `/stop` or `/cancel` to stop the selected session’s active and queued work. In a channel, mention me in that thread; in a group chat, quote the original message or my reply and mention me. Only the run author or an administrator may stop a request. New requests for the same session queue while I work.\n' +
  '• **Open files:** attach a file/image and ask me to read it. Personal-chat uploads download directly; group/channel files require the configured allowed drives and Microsoft permissions. Use `/files [folder]` to browse this conversation’s workspace privately in your personal chat, download files, edit eligible text, or upload files when you have write access. Browser actions require the gateway Public URL. Use `/sendfile <path>` for a personal file-consent card; accept or decline it there. Native sending supports nonempty files up to 10 MB; larger files use browser download. Open a personal chat with the bot first for private controls.\n' +
  '• **Settings and variables:** `/settings` opens General, Variables, MCPs, Skills, Automations and Resume in the current conversation. `/secrets` opens Variables directly. Stored credential values are never shown or prefilled. Runtime, access and other changes follow your current permissions.\n' +
  '• **Add Composio:** use `/settings` → MCPs for this conversation’s connections. In Personal mode, set your personal Composio token in a personal chat, never a channel/group message. In SDK mode, the admin key creates stable personal/channel identities automatically. Say whose account to use when it matters.\n' +
  '• **Skills:** say `list skills` to browse the gateway’s catalog, `add the <skill> skill for me` for your own runs, or (managers) `add the <skill> skill to this channel` / `apply the Development skills template`. Say `use the <skill name> skill` when you want one explicitly. You can also manage conversation skills in `/settings` → Skills.\n' +
  '• **Memory and rules:** say `remember that …` for a durable conversation fact, or `always …` for a standing behavior rule. Memory belongs to this conversation; never put secrets in it.\n' +
  '• **Gateway skills:** `gateway-usage` is installed automatically and teaches me Teams tools, formatting, reminders, files, video understanding and administration. `channel-memory` is automatic when conversation memory is enabled—there is nothing to install.\n' +
  '• **Reminders and schedules:** ask naturally, for example `remind me in 2 hours to call the client` or `every Monday at 09:00 summarize new messages`. Reminders post a nudge; scheduled tasks wake the agent to do work. Ask `list schedules` or `delete schedule <id>`, or use `/settings` → Automations.\n' +
  '• **Long-running work:** ask me to run it in the background. When the conversation’s mode permits it, the gateway keeps the job alive after the current turn and reports back to this conversation when it finishes.\n' +
  '• **Useful checks:** `/status` shows this session’s engine, model, effort and active/queued requests. `/model` and `/effort` show or change session runtime settings. Use `/settings` → General for conversation defaults and session overrides, and Resume for the available terminal command.\n\n' +
  '**Commands** (this conversation/session; mention the bot in channels/groups)\n' +
  '• `/help` — show this guide\n' +
  '• `/settings` — open the conversation settings console\n' +
  '• `/files [folder]` — privately browse this conversation’s workspace\n' +
  '• `/secrets` — open the conversation Variables page\n' +
  '• `/sendfile <path>` — send a workspace-relative file through personal-chat consent\n' +
  '• `/status` — show runtime settings and active/queued requests for this session\n' +
  '• `/model [engine] [model|default]` — show or change this session’s engine/model, subject to runtime policy\n' +
  '• `/effort [level|default]` — show or change this session’s reasoning effort\n' +
  '• `/stop` or `/cancel` — stop this session’s active and queued work\n' +
  '• `/clear` — stop and clear this session; the next request starts fresh';
