// Practical Teams /help copy. Commands are handled before an engine turn; keep the guide
// aligned with the native Teams controls and the shared conversation controls.
export const TEAMS_HELP_TEXT =
  '**How to use me**\n\n' +
  'In a personal chat, just send your request. In a channel or group chat, select the bot mention and write `@agent your request`, including for commands such as `@agent /help`. Keep channel follow-ups in the same thread and mention me again. In group chats, quote the original message or my reply and mention me to continue or control that session; a new unquoted group message starts a new session.\n\n' +
  '• **Act on a message:** Where Teams reaction events are enabled and delivered to the gateway, choose 👽 **Alien** from the Teams reaction picker to ask me to act on that message. Otherwise, mention me with your request.\n\n' +
  '• **Reaction names:**\n\n👽 Alien — `:alien:`\n\nHeart eyes robot — `:hearteyesrobot:`\n\n🛑 Stop sign — `stopsign`\n\n✅ Tick button (Checkmark button) — `2705_whiteheavycheckmark`\n\nChoose these names in the Teams reaction picker. The codes above identify the reactions; typing a code as a message does not add a reaction. Alien and Heart eyes robot ask me to act on a message; 👍 Like (`like`) also starts a request. Stop sign stops the selected session’s active and queued work; only its author or an administrator may stop it. Tick button acknowledges a tracked reminder, including a second notice. Removing a reaction does not reopen an acknowledged reminder. Reaction actions require Teams events to be enabled and delivered to the gateway; `/stop` and `/cancel` also remain available.\n\n' +
  '• **Voice prompts:** Attach a downloadable voice note and mention me in channels/groups; personal chats need no mention. Voice notes require local Whisper to be enabled and installed. Typed text stays as instructions, and raw audio is never sent to Claude or Codex. If transcription is unavailable, send text or ask an administrator to check Whisper.\n\n' +
  '• **Control a live run:** Send `/stop` or `/cancel`, or react 🛑 (**Stop sign**) to a message in that session, to stop its active and queued work. In a channel, mention me in that thread; in a group chat, quote the original message or my reply and mention me. Only the run author or an administrator may stop a request. New requests for the same session queue while I work.\n\n' +
  '• **Open files:** Attach a file/image and ask me to read it. Personal-chat uploads download directly; group/channel files require the configured allowed drives and Microsoft permissions. Use `/files [folder]` to browse this conversation’s workspace privately in your personal chat, download files, edit eligible text, or upload files when you have write access. Browser actions require the gateway Public URL. Use `/sendfile <path>` for a personal file-consent card; accept or decline it there. Native sending supports nonempty files up to 10 MB; larger files use browser download. Open a personal chat with the bot first for private controls.\n\n' +
  '• **Settings and variables:** `/settings` opens General, Variables, MCPs, Skills, Automations and Resume in the current conversation. `/secrets` opens Variables directly. Stored credential values are never shown or prefilled. General manages conversation defaults and session overrides, plus Read-only, Worker, or Admin access. Auto approves tool requests; Lean omits optional skills and connectors. Allow network is separate. Runtime, access and other changes follow your current permissions. This console edits conversation variables; personal and organization variables require authenticated settings, and organization changes are admin-only. Conversation values override personal values, then organization values. Hidden secrets can require admin approval for a new server.\n\n' +
  '• **Add Composio:** Use `/settings` → MCPs for this conversation’s connections. In Personal mode, set your personal Composio token in a personal chat, never a channel/group message. In SDK mode, the admin key creates stable personal/channel identities automatically. An admin can add an HTTPS MCP URL and Bearer token through the admin UI → conversation Connections → Custom MCP servers, or Users → Personal MCP servers for one person’s runs. OAuth connections go through Composio. Say whose account to use when it matters.\n\n' +
  '• **Skills:** Say `list skills` to browse the gateway’s catalog, `add the <skill> skill for me` for your own runs, or (managers) `add the <skill> skill to this channel` / `apply the Development skills template`. Say `use the <skill name> skill` when you want one explicitly. You can also manage conversation skills in `/settings` → Skills, or ask me to create or update a skill. New skills belong to this conversation (personal in a personal chat) unless you request another scope; organization library changes follow admin governance. Unavailable grants warn while available skills still load.\n\n' +
  '• **Approvals:** Permission requests use secure browser links when native controls are unavailable. Open the link and submit your decision; the gateway checks your authority before applying it.\n\n' +
  '• **Memory and rules:** Say `remember that …` for a durable conversation fact, or `always …` for a standing behavior rule. Memory belongs to this conversation; never put secrets in it.\n\n' +
  '• **Gateway skills:** `gateway-usage` is installed automatically and teaches me Teams tools, formatting, reminders, files, video understanding and administration. `channel-memory` is automatic when conversation memory is enabled—there is nothing to install.\n\n' +
  '• **Reminders and schedules:** Ask naturally, for example `remind me in 2 hours to call the client` or `every Monday at 09:00 summarize new messages`. Reminders post a nudge; scheduled tasks wake the agent to do work. Ask `list schedules` or `delete schedule <id>`, or use `/settings` → Automations to see next runs, pause or resume recurring schedules, cancel reminders, and stop loops. Checks can run every fixed number of days and DM you only on a matching result, then stop.\n\n' +
  '• **Long-running work:** Ask me to run it in the background. When the conversation’s mode permits it, the gateway keeps the job alive after the current turn and reports back to this conversation when it finishes.\n\n' +
  '• **SSH access:** When the host is configured for SSH, register your `.pub` key, then ask `enable SSH access for me` and `show my SSH connection instructions`. Users already allowed here can enable or revoke their own access without manager approval. Granting another person access needs a manager; containers with the operator home mounted cannot be opened through SSH.\n\n' +
  '• **Useful checks:** `/status` shows this session’s engine, model, effort and active/queued requests. `/model` and `/effort` show or change session runtime settings for enabled engines, including opt-in Qwen providers. An admin can configure a dedicated ChatGPT or API-key Codex login in the admin UI → Channel Runtime; that conversation then stays on Codex. Use `/settings` → General for conversation defaults and session overrides, and Resume for the available terminal command.\n\n' +
  '**Commands** (this conversation/session; mention the bot in channels/groups)\n\n' +
  '• `/help` — show this guide\n\n' +
  '• `/settings` — open the conversation settings console\n\n' +
  '• `/files [folder]` — privately browse this conversation’s workspace\n\n' +
  '• `/secrets` — open the conversation Variables page\n\n' +
  '• `/sendfile <path>` — send a workspace-relative file through personal-chat consent\n\n' +
  '• `/status` — show runtime settings and active/queued requests for this session\n\n' +
  '• `/model` — show the current selection and open the engine, model and effort picker for this session. Choose a compatible combination and Apply. `/model [engine] [model|default]` also changes it directly, subject to runtime policy\n\n' +
  '• `/effort [level|default]` — show or change this session’s reasoning effort\n\n' +
  '• `/stop` or `/cancel` — stop this session’s active and queued work\n\n' +
  '• `/clear` — stop and clear this session; the next request starts fresh';

// This fixed guide uses only bold and inline code. Native text runs preserve those styles
// without relying on Teams' client-dependent Markdown support or soft line breaks.
export function teamsHelpText(activationReactions) {
  if (!activationReactions) return TEAMS_HELP_TEXT;
  const codes = activationReactions.map(value => `\`${value}\``).join(', ');
  const start = TEAMS_HELP_TEXT.indexOf('• **Act on a message:**');
  const end = TEAMS_HELP_TEXT.indexOf('• **Voice prompts:**');
  return TEAMS_HELP_TEXT.slice(0, start) +
    `• **Act on a message:** Where Teams reaction events are enabled and delivered, react with one of the configured activation emojis: ${codes}. An administrator can change this platform’s selection under Settings → Agent defaults → Message activation reactions. Otherwise, mention me with your request.\n\n` +
    '• **Reaction names:**\n\n🛑 Stop sign — `stopsign`\n\n✅ Tick button (Checkmark button) — `2705_whiteheavycheckmark`\n\n' +
    'Choose activation emojis in the Teams reaction picker; typing a code as a message does not add a reaction. Stop sign stops the selected session’s active and queued work; only its author or an administrator may stop it. Tick button acknowledges a tracked reminder. Removing a reaction does not reopen an acknowledged reminder. Reaction actions require Teams events to be enabled and delivered; `/stop` and `/cancel` also remain available.\n\n' +
    TEAMS_HELP_TEXT.slice(end);
}

function helpParagraph(text) {
  return {
    type: 'RichTextBlock', spacing: 'Small',
    inlines: text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map(part => {
      if (part.startsWith('`')) return { type: 'TextRun', text: part.slice(1, -1), fontType: 'Monospace' };
      if (part.startsWith('**')) return { type: 'TextRun', text: part.slice(2, -2), weight: 'Bolder' };
      return { type: 'TextRun', text: part };
    }),
  };
}

export function createTeamsHelpCard(activationReactions) {
  const body = [];
  for (const paragraph of teamsHelpText(activationReactions).split('\n\n')) {
    const heading = /^(?:• )?\*\*([^*]+)\*\*(?:\s+([\s\S]*))?$/.exec(paragraph);
    if (!heading) { body.push(helpParagraph(paragraph)); continue; }
    body.push({ type: 'TextBlock', text: heading[1].replace(/:$/, ''), weight: 'Bolder',
      size: body.length ? 'Medium' : 'Large', wrap: true,
      spacing: body.length ? 'Medium' : 'None', separator: body.length > 0 });
    if (heading[2]) body.push(helpParagraph(heading[2]));
  }
  return { $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard', version: '1.4', body };
}
