// Compact native Cards v2 help and its complete text fallback share the same content.
// Sections expand in the Chat client and do not submit an action or start an engine.
const TITLE = 'How to use me';
const INTRO = 'Ask a question, share a file, or give me a task.';
const QUICK_START = [
  '**Personal chat** — Just send your request.',
  '**Space or group** — Select my name from the mention picker, then type your request: `@agent your request`.',
  '**Thread replies** — Stay in the same thread and mention me. In a personal chat, new messages continue your main session; replies in a thread use that thread.',
];
const SHORTCUTS = [
  '`/model` — Choose the engine, model and effort.',
  '`/settings` — Open private controls for this conversation.',
  '`/files` — Browse this workspace from the current conversation.',
  '`/stop` — Stop this session’s active and queued work.',
];
const COMMAND_HINT = 'In spaces and groups, mention me before a typed command: `@agent /help`. Registered slash commands selected from the Chat menu address me directly.';
const TOPICS = [
  { title: 'All commands', rows: [
    '`/help` — Show this guide.',
    '`/settings` — Open General, Variables, MCPs, Skills, Automations and Resume.',
    '`/secrets` — Open Variables. Enter credential values only in the protected browser page; stored values are never shown or prefilled.',
    '`/files [folder]` — Browse, download, edit eligible text, or upload files with write access.',
    '`/sendfile <path>` — Open a workspace file for download.',
    '`/status` — See the engine, model, effort and active/queued requests.',
    '`/model` — Open the engine, model and effort picker. Choose a combination and Apply.',
    '`/model [engine] [model|default]` — Change the runtime directly, subject to policy.',
    '`/effort [level|default]` — Show or change reasoning effort.',
    '`/stop` or `/cancel` — Stop this session’s active and queued work.',
    '`/clear` — Stop and clear this session. Your next request starts fresh.',
    'Only the run author or an administrator may stop a request. New requests for the same session queue while I work.',
    'In a threaded space, send `/stop`, `/status` or `/clear` in the request’s thread. In a group chat or a space without threads, quote my reply (or your request) when you send it.',
  ] },
  { title: 'Files & voice notes', rows: [
    'Attach a file or image and tell me what to do with it. Downloadable Chat uploads are saved into this conversation’s workspace.',
    'Files shared through the Drive picker may not be downloadable by the app. If a file cannot be read, upload it directly or provide an accessible copy.',
    'Use `/files [folder]` to browse folders and open files. Browser downloads, editing and uploads require the gateway Public URL. Editing and uploading also require write access.',
    '`/sendfile <path>` opens a protected browser download. It does not upload a copy of the file to Chat.',
    'Attach a downloadable voice note. Mention me in spaces/groups; personal chats need no mention. Any typed text stays as instructions.',
    'Voice notes need local Whisper enabled and installed. Raw audio is never sent to Claude or Codex. If transcription is unavailable, send text or ask an administrator to check Whisper.',
  ] },
  { title: 'Settings, connections & access', rows: [
    '`/settings` opens private controls in this conversation. **General** manages conversation defaults, session overrides, and Read-only, Worker or Admin mode.',
    '**Auto** approves tool requests. **Lean** omits optional skills and connectors. **Allow network** is a separate switch. Changes follow your current permissions.',
    'Use `/model` for enabled engines and providers. An admin can set a dedicated Codex login in the admin UI → Channel Runtime; that conversation then stays on Codex. **Resume** shows the available terminal command.',
    '**Variables** uses a protected browser page for secret entry. Google Chat cannot mask text input, so never paste tokens or passwords into a card or message.',
    'Conversation values override personal values, then organization values. Organization changes are admin-only; hidden secrets may need admin approval for a new server.',
    'Open **MCPs** to manage conversation connections. Use the protected browser page for personal Composio or Toolbox tokens. SDK mode manages its own identities; saved Personal-mode tokens remain inactive there.',
    'Admins can add an HTTPS MCP URL and Bearer token in the admin UI → conversation Connections → Custom MCP servers, or Users → Personal MCP servers. OAuth connections use Composio. Say whose account to use.',
    'Use approval controls here to Approve, Deny or Request changes. Your current authority is checked.',
    'When the host supports SSH, register your `.pub` key, then ask `enable SSH access for me` and `show my SSH connection instructions`. A manager must grant access for another person. Containers with the operator home mounted cannot be opened through SSH.',
  ] },
  { title: 'Skills & memory', rows: [
    '`list skills` — Browse the catalog.',
    '`add the <skill> skill for me` — Enable it for your own runs.',
    '`use the <skill name> skill` — Use a skill for this task.',
    'Managers can say `add the <skill> skill to this channel` or `apply the Development skills template`. You can also use `/settings` → Skills.',
    'Ask me to create or update a skill. New skills belong to this conversation (personal in a personal chat) unless you request another scope. Organization changes follow admin governance.',
    '`remember that …` — Save a durable fact for this conversation. `always …` — Add a standing behavior rule. Never put secrets in memory.',
    '`gateway-usage` is automatic and covers Google Chat tools, formatting, reminders, files, video and administration. `channel-memory` is automatic when conversation memory is enabled. Neither needs installing.',
  ] },
  { title: 'Reminders & background work', rows: [
    '`remind me in 2 hours to call the client` — Send a reminder.',
    '`every Monday at 09:00 summarize new messages` — Schedule work.',
    'Reminders send a nudge; scheduled tasks wake the agent to do work.',
    'Ask `list schedules` or `delete schedule <id>`. In **Automations**, see next runs, pause or resume recurring schedules, cancel reminders, or stop loops.',
    'Ask me to `run it in the background`. When this conversation’s mode permits it, the job keeps running after the turn and reports back here when finished.',
  ] },
  { title: 'Reply controls', rows: [
    'The reply menu opens **Files**, **Variables** and **Settings** for this conversation.',
    'Use `/stop` or `/cancel` to stop work. Reaction shortcuts are not available in Google Chat; mention me with your request.',
  ] },
];

export const GOOGLE_CHAT_HELP_TEXT = [
  `**${TITLE}**`, INTRO, '**Get started**', ...QUICK_START,
  '**Useful commands**', ...SHORTCUTS, COMMAND_HINT,
  ...TOPICS.flatMap(topic => [`**${topic.title}**`, ...topic.rows]),
].join('\n\n');

function paragraph(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { textParagraph: { text: escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<b>$1</b>') } };
}
export function createGoogleChatHelpCard() {
  return { header: { title: TITLE, subtitle: INTRO }, sections: [
    { header: 'Get started', widgets: QUICK_START.map(paragraph) },
    { header: 'Useful commands', widgets: [...SHORTCUTS, COMMAND_HINT].map(paragraph) },
    ...TOPICS.map(topic => ({ header: topic.title, collapsible: true, uncollapsibleWidgetsCount: 0,
      widgets: topic.rows.map(paragraph) })),
  ] };
}
