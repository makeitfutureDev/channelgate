import { DEFAULT_TEAMS_ACTIVATION_REACTIONS } from './reactions.js';

// One source for the compact native card and the complete plain-text fallback.
// Help is handled before an engine turn; expanding a topic is entirely client-side.
const TITLE = 'How to use me';
const INTRO = 'Ask a question, share a file, or give me a task.';
const QUICK_START = [
  '**Personal chat** — Just send your request.',
  '**Channel or group** — Select my name from the mention picker, then type your request: `@agent your request`.',
  '**Channel replies** — Stay in the same thread and mention me.',
  '**Group replies** — To continue, quote the original message or my reply and mention me. A new unquoted message starts a new session.',
];
const SHORTCUTS = [
  '`/model` — Choose the engine, model and effort.',
  '`/settings` — Open your settings in a private Teams popup.',
  '`/files` — Browse this workspace in your personal chat.',
  '`/stop` — Stop this session’s active and queued work.',
];
const COMMAND_HINT = 'In channels and groups, mention me before a command: `@agent /help`.';

const REACTION_NAMES = new Map([
  ['alien', '👽 Alien'], ['hearteyesrobot', 'Heart eyes robot'],
  ['like', '👍 Like'], ['smilerobot', 'Smile robot'],
]);
function reactionLabel(value) {
  return REACTION_NAMES.get(value) || value;
}
function helpTopics(activationReactions = DEFAULT_TEAMS_ACTIVATION_REACTIONS) {
  const reactions = activationReactions.map(reactionLabel).join(', ');
  return [
    { id: 'commands', title: 'All commands', sections: [
      { title: 'Explore & configure', rows: [
        '`/help` — Show this guide.',
        '`/settings` — Open General, Variables, MCPs, Skills, Automations and Resume.',
        '`/secrets` — Open Variables. Stored credential values are never shown or prefilled.',
        '`/files [folder]` — Browse, download, edit eligible text, or upload files with write access.',
        '`/sendfile <path>` — Send a workspace-relative file using personal-chat consent.',
      ] },
      { title: 'Your current session', rows: [
        '`/status` — See the engine, model, effort and active/queued requests.',
        '`/model` — Open the engine, model and effort picker. Choose a combination and Apply.',
        '`/model [engine] [model|default]` — Change the runtime directly, subject to policy.',
        '`/effort [level|default]` — Show or change reasoning effort.',
        '`/stop` or `/cancel` — Stop this session’s active and queued work.',
        '`/clear` — Stop and clear this session. Your next request starts fresh.',
        'Only the run author or an administrator may stop a request. New requests for the same session queue while I work.',
      ] },
    ] },
    { id: 'files', title: 'Files & voice notes', sections: [
      { title: 'Share a file', rows: [
        'Attach a file or image and tell me what to do with it.',
        '**Personal chat:** uploads download directly. **Channels/groups:** files need allowed drives and Microsoft permissions.',
      ] },
      { title: 'Browse & download', rows: [
        'Open a personal chat with me first, then use `/files [folder]` from the conversation whose workspace you want.',
        '`/sendfile <path>` sends a consent card to your personal chat. Accept or decline there. Nonempty files up to **10 MB** can be sent this way; use browser download for larger files.',
        'Browser downloads, editing and uploads require the gateway Public URL. Editing and uploading also require write access.',
      ] },
      { title: 'Send a voice note', rows: [
        'Attach a downloadable voice note. Mention me in channels/groups; personal chats need no mention. Any typed text stays as instructions.',
        'Voice notes need local Whisper enabled and installed. Raw audio is never sent to Claude or Codex. If transcription is unavailable, send text or ask an administrator to check Whisper.',
      ] },
    ] },
    { id: 'settings', title: 'Settings, connections & access', sections: [
      { title: 'Make it yours', rows: [
        '`/settings` opens a private popup for this conversation. **General** manages conversation defaults, session overrides, and Read-only, Worker or Admin mode.',
        '**Auto** approves tool requests. **Lean** omits optional skills and connectors. **Allow network** is a separate switch. Changes follow your current permissions.',
        'Use `/model` for enabled engines and providers, including opt-in Qwen. An admin can set a dedicated Codex login in the admin UI → Channel Runtime; that conversation then stays on Codex. **Resume** shows the available terminal command.',
      ] },
      { title: 'Variables & connections', rows: [
        '`/secrets` opens Variables. Conversation values override personal values, then organization values. Organization changes are admin-only; hidden secrets may need admin approval for a new server.',
        'Open **MCPs** in `/settings` to manage connections. In Composio Personal mode, set your personal token in a personal chat, never a channel/group message. SDK mode creates personal/channel identities automatically from the admin key.',
        'Admins can add an HTTPS MCP URL and Bearer token in the admin UI → conversation Connections → Custom MCP servers, or Users → Personal MCP servers. OAuth connections use Composio. Say whose account to use.',
      ] },
      { title: 'Approvals & SSH', rows: [
        'If native approval controls are unavailable, open the secure browser link and submit your decision. Your authority is checked before it is applied.',
        'When the host supports SSH, register your `.pub` key, then ask `enable SSH access for me` and `show my SSH connection instructions`.',
        'Users already allowed here can enable or revoke their own SSH access. A manager must grant access for another person. Containers with the operator home mounted cannot be opened through SSH.',
      ] },
    ] },
    { id: 'skills', title: 'Skills & memory', sections: [
      { title: 'Give me a skill', rows: [
        '`list skills` — Browse the catalog.',
        '`add the <skill> skill for me` — Enable it for your own runs.',
        '`use the <skill name> skill` — Use a skill for this task.',
        'Managers can say `add the <skill> skill to this channel` or `apply the Development skills template`. You can also use `/settings` → Skills.',
        'Ask me to create or update a skill. New skills belong to this conversation (personal in a personal chat) unless you request another scope. Organization changes follow admin governance. Unavailable grants warn; available skills still load.',
      ] },
      { title: 'Remember what matters', rows: [
        '`remember that …` — Save a durable fact for this conversation.',
        '`always …` — Add a standing behavior rule. Never put secrets in memory.',
        '`gateway-usage` is automatic and covers Teams tools, formatting, reminders, files, video and administration. `channel-memory` is automatic when conversation memory is enabled. Neither needs installing.',
      ] },
    ] },
    { id: 'schedules', title: 'Reminders & background work', sections: [
      { title: 'Tell me when', rows: [
        '`remind me in 2 hours to call the client` — Send a reminder.',
        '`every Monday at 09:00 summarize new messages` — Schedule work.',
        'Reminders send a nudge; scheduled tasks wake the agent to do work.',
        'Ask `list schedules` or `delete schedule <id>`. In `/settings` → Automations, see next runs, pause or resume recurring schedules, cancel reminders, or stop loops.',
        'Checks can repeat every fixed number of days, DM you only when a result matches, then stop.',
      ] },
      { title: 'Keep working in the background', rows: [
        'Ask me to `run it in the background`. When this conversation’s mode permits it, the job keeps running after the turn and reports back here when finished.',
      ] },
    ] },
    { id: 'reactions', title: 'Reaction shortcuts', sections: [
      { title: 'Ask me to act on a message', rows: [
        reactions ? `Choose one of these configured activation reactions in the Teams picker: **${reactions}**.`
          : 'No activation reactions are configured. Mention me with your request instead.',
        'Reactions work when Teams reaction events are enabled and delivered. If nothing happens, mention me with your request.',
      ] },
      { title: 'Stop or acknowledge', rows: [
        '**🛑 Stop sign** — Stop the selected session’s active and queued work. Only its author or an administrator may stop it. You can also use `/stop` or `/cancel`.',
        '**✅ Tick button (Checkmark button)** — Acknowledge a tracked reminder, including a second notice. Removing a reaction does not reopen an acknowledged reminder.',
        'Choose reactions in the Teams picker; typing a code as a message does not add a reaction.',
        'Admins can change activation reactions under Settings → Agent defaults → Message activation reactions.',
      ] },
    ] },
  ];
}

export function teamsHelpText(activationReactions) {
  return [
    `**${TITLE}**`, INTRO, '**Get started**', ...QUICK_START,
    '**Useful commands**', ...SHORTCUTS, COMMAND_HINT,
    ...helpTopics(activationReactions).flatMap(topic => [
      `**${topic.title}**`, ...topic.sections.flatMap(section => [
        `**${section.title}**`, ...section.rows,
      ]),
    ]),
  ].join('\n\n');
}
export const TEAMS_HELP_TEXT = teamsHelpText();

function helpParagraph(text) {
  return { type: 'RichTextBlock', spacing: 'Default',
    inlines: text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map(part => {
      if (part.startsWith('`')) return { type: 'TextRun', text: part.slice(1, -1), fontType: 'Monospace' };
      if (part.startsWith('**')) return { type: 'TextRun', text: part.slice(2, -2), weight: 'Bolder' };
      return { type: 'TextRun', text: part };
    }),
  };
}
const heading = text => ({ type: 'TextBlock', text, weight: 'Bolder', wrap: true, spacing: 'Medium' });

export function createTeamsHelpCard(activationReactions) {
  const body = [
    { ...heading(TITLE), size: 'Large', spacing: 'None' },
    { type: 'TextBlock', text: INTRO, wrap: true, spacing: 'Small', isSubtle: true },
    heading('Get started'), ...QUICK_START.map(helpParagraph),
    { type: 'Container', style: 'emphasis', spacing: 'Medium', items: [
      { ...heading('Useful commands'), spacing: 'None' }, ...SHORTCUTS.map(helpParagraph),
    ] },
    helpParagraph(COMMAND_HINT),
    { ...heading('Explore the guide'), separator: true },
    { type: 'TextBlock', text: 'Select a topic to expand or collapse it.', wrap: true, spacing: 'Small', isSubtle: true },
  ];
  for (const topic of helpTopics(activationReactions)) {
    const id = `help-${topic.id}`;
    body.push({ type: 'ActionSet', spacing: 'Small', actions: [
      { type: 'Action.ToggleVisibility', title: topic.title, targetElements: [id] },
    ] });
    body.push({ type: 'Container', id, isVisible: false, spacing: 'Small', items:
      topic.sections.flatMap(section => [heading(section.title), ...section.rows.map(helpParagraph)]),
    });
  }
  return { $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard', version: '1.4', body };
}
