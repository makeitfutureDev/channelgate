// Practical, user-facing operating guide returned by the typed `/help` command. Keep this separate
// from app.js so its important workflows can be regression-tested without wiring a Slack app.
export const HELP_TEXT =
  "*How to use me*\n" +
  "In a DM, just send your request. In a channel, write `@agent your request`; keep follow-ups in the thread and @mention me again there. For typed commands in a channel, use forms such as `@agent /help`. The registered `/menu`, `/secrets`, `/status`, and `/stop` Slack commands run at conversation top level without a mention.\n\n" +
  "• *Act on a message:* react 🤖 to a new top-level message or a message in one of my threads. In another bot's thread, @mention me instead.\n" +
  "• *Voice prompts:* attach a voice clip. In channels, @mention me or react 🤖 to start; DMs keep their normal behavior. When enabled and installed, audio is transcribed locally with Whisper large-v3-turbo; otherwise I use a completed Slack transcript. If none exists, click *Generate transcript* and trigger me again. Typed text stays as instructions, and raw audio is never sent to Claude or Codex.\n" +
  "• *Control a live run:* in a channel thread send `@agent stop` (a bare `stop` needs no mention only in a DM) or react 🛑 to stop just that run. `/stop` at top level stops every active run in this channel. If you send another message while I work, choose *Steer Conversation*, *Add to Queue*, or *Cancel Request*; the choice card disappears after a valid selection. `/next <message>` queues directly without asking.\n" +
  "• *Open files:* attach a file/image and ask me to read it, or use the 📂 button on a reply to browse this channel's folder, create new files/folders, and upload multiple files or a folder directly through the secured browser flow when configured—without storing the upload in Slack. With a Public URL, an opened file can be downloaded directly. In Worker/Auto mode, valid UTF-8 text files, including `.env`, JSON, configs, and scripts, can be edited regardless of extension; protected managed/credential/key paths stay read-only. You can also preview and share a file into the conversation. The Browse channel files message shortcut also keeps the selected thread.\n" +
  "• *Add Composio:* In Personal mode, DM me `set my Composio token to …`, then delete the token message. In SDK mode, the admin key creates stable personal/channel identities automatically; you can manage your personal connections, while channel managers manage shared connections. Existing tokens remain saved when modes change. Say whose account to use when it matters.\n" +
  "• *Skills:* say `list skills` to browse the gateway's catalog, `add the <skill> skill for me` to carry one in your own runs, or (managers) `add the <skill> skill to this channel` / `apply the Development skills template`. Say `use the <skill name> skill` when you want one explicitly.\n" +
  "• *Memory and rules:* say `remember that …` for a durable channel fact, or `always …` for a standing behavior rule. Memory is channel-scoped; never put secrets in it.\n" +
  "• *Gateway skills:* `gateway-usage` is installed automatically and teaches me chat tools, formatting, reminders, files, video understanding, and administration. `channel-memory` is automatic when channel memory is enabled—there is nothing to install.\n" +
  "• *Reminders and schedules:* ask naturally, for example `remind me in 2 hours to call the client` or `every Monday at 09:00 summarize new messages`. Reminders only post a nudge; scheduled tasks wake the agent to do work. Ask `list schedules` or `delete schedule <id>` to manage them.\n" +
  "• *Long-running work:* ask me to run it in the background. In an Auto/Full-access channel, the gateway keeps the job alive after the current turn and reports back in this thread when it finishes.\n" +
  "• *Useful checks:* `/status` shows active runs, background jobs, and schedules; `/pending` shows threads waiting on your decision; `/model` changes Claude/Codex, model, and effort; `/mode` shows the channel's tool-access mode.\n\n" +
  "*Commands* (this thread/channel)\n" +
  "• `/menu` — show only the Resume, Files, Secrets, and Settings buttons; use `@agent /menu` inside a channel thread\n" +
  "• `/help` — show this guide\n" +
  "• `/clear` — start a fresh session in this thread\n" +
  "• `/delete` — delete this thread's messages (admin; irreversible—everyone's if an admin user token is set in Settings, otherwise mine only)\n" +
  "• `/secrets` — see which environment variables this channel has (name + last 4 only) and add or replace one. Values are never shown again, to anyone: this is how a channel gets its OWN CLI login (its own Supabase or Vercel account) instead of sharing the host's\n" +
  "• `/context` — token usage of the last turn\n" +
  "• `/resume` — terminal command to open this thread's session locally; `/resume <command or session id>` continues an existing session from this channel's folder in this thread\n" +
  "• `/pending` — threads where I'm waiting on your decision (alias `/followups`; bare `pending` / `my followups` work too)\n" +
  "• `/model` — choose channel/thread scope, Claude or Codex, model, and effort (access policy is set in Settings)\n" +
  "• `/compact` — compact this thread's history (Claude; Codex → use `/clear`)\n" +
  "• `/mode [read|bash|auto|admin]` — show or set this channel's mode (admin/manager permission required to change it)\n" +
  "• `/next <message>` — queue after the current run without showing the steer-or-queue choice\n" +
  "• `/status` — show active work and schedules in this conversation (top-level Slack command)\n" +
  "• `/stop` — stop every active run in this conversation (top-level; for one thread use `@agent stop`, `stop` in a DM, or 🛑)\n" +
  "• `/update` — update the gateway to the latest version and restart (admin)";
