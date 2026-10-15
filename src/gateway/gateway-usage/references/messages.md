# Sending Slack messages

## Joining or inviting the agent — human approval required

Before adding the gateway bot or a connected agent account to ANY other channel (public or
private), use the structured Composio membership action and wait for its gateway approval card.
The card must name the exact channel, joining identity and connected account. For a route without
that automatic card, call `request_approval` first with those facts and the reason, and wait for
`approved: true`. Deny, comment, timeout or missing approval means do nothing.
Auto/Admin mode and permission approvals for a tool/thread do not approve membership changes.
Posting, sharing a list, or reading a linked thread does not imply permission to join. Channel
creation also changes membership and requires approval. Do not remove an existing membership
while investigating unless asked.

If Slack answers `channel_not_found` / `not_in_channel`, explain the missing access and ask for
the approval card or a human invitation. Never switch sender, borrow another person's connection,
invite the bot through Composio, or use workbench/shell/browser/direct API to work around it.
Keep the requested sender: "from my user" means the requester's connection, and "draft" means
prepare the text without posting unless sending was separately authorized.

Managed Composio structured membership calls have an additional gateway-enforced one-use card.
Use those tools and wait for that card; a separate plan approval cannot bypass it. Both identities
and all runtime types use this check. Opaque workbench/bash/API executors are disabled on managed Composio because their persistent
code can hide membership changes. Use structured actions for reads and writes. Split large
membership batches so every target and account fits on the approval card.

## Replying in the current thread — just output text
The normal way to "send a message" is to **write your reply**. Whatever you output is posted as a
Slack message in the thread you're answering. You do not need a tool for this. Format it per
`references/writing-replies.md` and tag people per `references/mentions.md`.

## Posting elsewhere, scheduling, reacting — choose a Composio account
To do more than reply in-thread — post to **another** channel or a DM, schedule a message for
later, add a reaction — use the Slack toolkit from the requested Composio account, following the
identity rules in `SKILL.md` → “Tool identities”:

- “my Slack” → `composio-user` (`mcp__composio-user__*`), the requester's own account.
- “your Slack” → `composio-agent` (`mcp__composio-agent__*`), YOUR own account.
- Resolve the intended identity and connected Slack account from the request and prior explicit
  choices. Reuse an established choice. If the writing account is still ambiguous, ask which
  account before the send, schedule, reaction or other state change; continue independent
  authorized reads while waiting. Reading through an account does not select it for a write.
- In a DM only `composio-user` exists.

- Find the right Slack action through Composio (e.g. its search/execute tools surface actions like
  "send message", "schedule message", "add reaction", "create channel"). Use the action Composio
  exposes — don't assume a fixed tool name; discover it.
- To schedule a message that **Slack itself** sends at a set time, use Composio's Slack
  "schedule message" action. For "remind me / run a task later" that the **gateway** drives (and
  that runs as you, in this channel), use `create_schedule` instead — see `references/reminders.md`.

## Prerequisite: the selected account has Slack connected
An account exposes Slack actions only if Slack is connected inside it — call that account's
`COMPOSIO_SEARCH_TOOLS` and look for its `slack` entry in `toolkit_connection_statuses[]` with
`has_active_connection` true. Never use `COMPOSIO_MANAGE_CONNECTIONS` (`list`) for that check: on
an account with no Slack connection it starts a pending authorization instead of answering. If the
requested account or action is unavailable, explain that exact prerequisite; do not silently act
as the other account. A requester can connect their personal account from the App Home tab → "Connect my
Composio key" (or `set_my_composio_token` in a DM); YOUR account is set up by an admin
(`references/administration.md`). There is no separate Slack login beyond these paths.

## What always works without Composio (bot tools)
Even with no Composio: replying in-thread, native tables (`slack_post_table`), native charts
(`references/charts.md`), Slack Lists (`references/tables.md`), uploading a table snippet
(`slack_upload_snippet`), and reading THIS channel's history (`references/reading.md`) — those are
gateway bot-token tools, always on. Posting to OTHER channels / scheduling sends / search uses the
intended Composio account for writes; searches may use either or both unless restricted.

## Don't leak secrets
Never post tokens, credentials, or the contents of secret files into a Slack message — Slack keeps
history (and search) readable to everyone in the conversation.
