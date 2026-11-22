# Slack-to-Google Chat parity audit

An implementation audit of Google Chat (Beta) against the Slack surface, in the shape of
`docs/TEAMS-PARITY.md`. It is not a release claim: a row marked shared has automated coverage;
live Claude/Codex acceptance lives in `TEST-PLAN.md`. Paths are relative to `src/`.

## Shared or implemented

| Slack feature | Google Chat state | Anchor |
| --- | --- | --- |
| DM, group chat and space conversations, mention gating | Supported; DMs need no mention, spaces need the app mentioned (annotation, not `argumentText`) | `platforms/googlechat/events.js`, `platforms/ingest.js` |
| Authorization, access policy, guest grants | Shared `isAuthorized()`; the Chat identity is the email/`users/…` id | `platforms/ingest.js`, `gateway/modes.js` |
| Engines, models, licenses, failover | Shared runner; `/model`, `/license`, `/effort` answer in Chat | `gateway/run.js`, `platforms/googlechat/events.js` |
| Containers, modes, network, secrets | Shared runtime; secrets via the private browser form | `runtimes/`, `platforms/googlechat/settings.js` |
| Reply formatting | Standard Markdown, sent with `markupSyntax: MARKUP_SYNTAX_MARKDOWN` on every text write (older apps default to Chat syntax); tables and headings degraded | `platforms/format/gchat.js`, `platforms/googlechat/api.js` |
| Mentions and broadcast defang | `@Name` → `<chat-user data-user="users/…">`; model-written `<users/…>` and every `<chat-*>` tag defanged in any case | `platforms/format/gchat.js` |
| Long-run progress | One working placeholder, edited into a ticking heartbeat (1 edit/s/space) | `platforms/conversation-progress.js` |
| Stop, status, queue position | `/stop`, `/cancel`, `/status`; queued requests are told their position | `platforms/googlechat/controls.js`, `platforms/ingest.js` |
| Settings, files, secrets, help | Cards v2 (requester-only private messages) and private browser forms | `platforms/googlechat/controls.js`, `platforms/googlechat/help.js` |
| Approvals | Native cards in the source conversation; signed browser links | `platforms/approval-delivery.js` |
| Reactions (🤖 start, 🛑 stop, ✅ acknowledge) | Through Workspace Events with the admin-approved app scope | `platforms/googlechat/reactions.js` |
| Attachments in, voice notes | Direct uploads download; Drive-picker shares are named as unreadable; Whisper transcription | `platforms/googlechat/events.js`, `platforms/ingest.js` |
| File sending | `share_file` / `/sendfile` private controls | `mcp/tools/teams-native.js` |
| Schedules, background results, notices | Shared `postNotice` / `postDirectMessage` | `platforms/notify.js` |
| Conversation history reads | `conversation_history` (current thread or whole space, public messages only) on the admin-approved `chat.app.messages.readonly` app scope | `mcp/tools/conversation-history.js`, `platforms/googlechat/connector.js` |
| Activity dashboard | Listed with completion saved in Activity | `web/activity.js` |

## Remaining gaps

| Slack feature | Google Chat gap | Next slice |
| --- | --- | --- |
| Thread hydration on a fresh session | Slack's run starts with the thread in context; Chat relies on the agent calling `conversation_history` | Prepend the current thread (bounded) on a fresh session when the scope is approved |
| Busy-thread Steer / Queue / Cancel choice | Chat queues and offers `/stop`; no explicit steer | Reuse the shared queue-choice work being built for Teams once it lands |
| Re-download a historical file | History names earlier files but cannot fetch them | `media.download` by the attachment's resource name, scoped to this space, into the confined sink |
| Edited-message trigger | An edited message that adds a mention is not re-read | Handle `MESSAGE_UPDATED` with duplicate suppression |
| Background job status button | Results post back; no status control | Card button or `/status` listing for the conversation's jobs |
| Tables and headings | Degraded although Google now documents both for Markdown mode | Flip `markdownTables` / `markdownHeadings` after the live probe below shows they render |
| Agent directory, agent mail, thread forks, code channels | Slack-only | Out of scope until the shared seams accept non-Slack conversations |
| Composio SDK identities (Enterprise) | Slack-only | Same as Teams |
| Dialogs | Unavailable in the Pub/Sub connection mode | Requires the HTTP endpoint mode for every interaction |

## Platform boundaries

- An app sees only messages addressed to it; the history read needs Workspace administrator
  approval of the app scope and never returns private messages.
- Google documents no escape for a literal `<`; the defang inserts a zero-width space, which is
  invisible and unparseable in both syntaxes.
- Drive-picker shares need a Drive scope the app deliberately does not request.
