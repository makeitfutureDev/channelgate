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
| Busy-thread Steer / Cancel choice | A request queued behind busy work gets a shared Cards v2 card with Steer conversation and Cancel request (sender or admitted admin; refusals private; restart-safe from the durable row; never passes another person's work) | `platforms/googlechat/queue-controls.js`, `platforms/queue-choice.js`, `platforms/queued-events.js` |
| Background job status button | The started notice carries Check status (answered privately, Refresh in place); `/jobs` lists the conversation's running jobs privately | `platforms/googlechat/background-controls.js`, `gateway/background-status.js` |
| Settings, files, secrets, help | Cards v2 (requester-only private messages) and private browser forms | `platforms/googlechat/controls.js`, `platforms/googlechat/help.js` |
| Approvals | Native cards in the source conversation; signed browser links | `platforms/approval-delivery.js` |
| Reactions (🤖 start, 🛑 stop, ✅ acknowledge) | Through Workspace Events with the admin-approved app scope | `platforms/googlechat/reactions.js` |
| Edited-message trigger | An edit that adds a mention of this app runs the message once as its sender, through Workspace Events `message.v1.updated` on the reaction subscriptions; already-handled messages, removed mentions, other apps' mentions, app and DM edits do nothing | `platforms/googlechat/edits.js`, `platforms/googlechat/transport.js` |
| Attachments in, voice notes | Direct uploads download; Drive-picker shares are named as unreadable; Whisper transcription | `platforms/googlechat/events.js`, `platforms/ingest.js` |
| File sending | `share_file` / `/sendfile` private controls | `mcp/tools/teams-native.js` |
| Schedules, background results, notices | Shared `postNotice` / `postDirectMessage` | `platforms/notify.js` |
| Conversation history reads | `conversation_history` (current thread or whole space, public messages only) on the admin-approved `chat.app.messages.readonly` app scope | `mcp/tools/conversation-history.js`, `platforms/googlechat/connector.js` |
| Re-download a historical file | `conversation_download_file`: the named message of this space (bot client, then the app scope), its upload fetched by `attachmentDataRef.resourceName` through `media.download` into this thread's `uploads/` under the intake cap; Drive-picker shares refused | `mcp/tools/conversation-history.js`, `platforms/googlechat/connector.js` |
| Thread hydration on a fresh session | A reply that starts a thread's first session gets the last 20 earlier public messages (each shortened, 8,000 characters total, untrusted framing) when the app scope is approved; a refusal, failure or 5 s timeout leaves the turn unchanged | `platforms/thread-hydration.js`, `platforms/ingest.js` |
| Activity dashboard | Listed with completion saved in Activity | `web/activity.js` |
| Composio SDK identities (Enterprise) | An author is `googlechat:<project>:user:users/<id>` (the immutable account resource the transport records, never the e-mail) and a space `googlechat:<project>:channel:spaces/<id>`, the project being the service-account key's `project_id`; both identities in spaces, only the author's in DMs, none for an author whose `users/<id>` is not yet recorded; inventory, admin pages and Activity connections use the same identity | `ee/composio-sessions.js`, `gateway/composio-workspace.js`, `gateway/run-integrations.js` |
| Agent directory | `search_agents` lists Google Chat spaces (never DMs or group chats, never another platform's channels) from `spaces.get` metadata and the complete `spaces.members.list` roster; `users/NNN` maps to the recorded gateway user; a Google Group member or a truncated roster fails closed | `platforms/googlechat/agent-directory.js`, `gateway/agent-directory.js` |
| Agent mail (`send_agent_message`, `continue_agent_conversation`, `ask #space …`) | Chat ↔ Chat only (a person's identity differs per platform, so cross-platform targets are refused); Cards v2 confirmation in the asking thread; the opener opens a new thread in the target space; each hop runs in that thread's ingest lane with the working-message heartbeat; `/stop` there stops it; sends from a space thread or the DM with the app | `gateway/agent-mail.js`, `platforms/answer-delivery.js`, `platforms/ingest.js` |

## Remaining gaps

| Slack feature | Google Chat gap | Next slice |
| --- | --- | --- |
| Tables and headings | Degraded although Google now documents both for Markdown mode | Flip `markdownTables` / `markdownHeadings` after the live probe below shows they render |
| Thread forks, code channels | Slack-only | Out of scope until the shared seams accept non-Slack conversations |
| Dialogs | Unavailable in the Pub/Sub connection mode | Requires the HTTP endpoint mode for every interaction |

## Platform boundaries

- An app sees only messages addressed to it; the history read needs Workspace administrator
  approval of the app scope and never returns private messages.
- Google documents no escape for a literal `<`; the defang inserts a zero-width space, which is
  invisible and unparseable in both syntaxes.
- Drive-picker shares need a Drive scope the app deliberately does not request.
