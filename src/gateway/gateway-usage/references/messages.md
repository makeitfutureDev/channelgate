# Sending Slack messages

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
- No pronoun → the only account with Slack connected (say which). If BOTH have Slack you MUST ask
  which account first — the question is the whole reply, and you call no tool until it is answered.
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
explicitly selected Composio account.

## Don't leak secrets
Never post tokens, credentials, or the contents of secret files into a Slack message — Slack keeps
history (and search) readable to everyone in the conversation.
