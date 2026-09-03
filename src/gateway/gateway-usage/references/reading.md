# Reading history & searching Slack

## This channel — always available (gateway, bot token)
For "catch me up" / "summarize this channel" / "what did the thread say":

- `slack_channel_history` — recent messages from THIS channel (the one you're replying in).
  `limit` defaults to 30 (max 100). Returns messages oldest→newest with author + timestamp;
  threaded messages show their `thread_ts`. Shared files include safe id/name/MIME/size metadata.
- `slack_thread_replies` — all replies in a thread in THIS channel. Pass the `thread_ts` (the
  parent message's ts, e.g. from `slack_channel_history`). `limit` defaults to 50 (max 200).
  Shared files include the same safe metadata; private Slack file URLs are never returned.

These are **scoped to the current channel only** — they can't read other channels. The thread
you're actively replying in is already in your context, so you usually only need these to look
further back or at a different thread in this channel.

## Other channels / workspace search — select the account
To search or read **beyond this channel**, choose the Composio account per `SKILL.md` → “Tool
identities”: `composio-user` for “my Slack” (the requester's), `composio-agent` for “your Slack”
(your own); no pronoun → the only one with Slack connected, else ask. The selected connected Slack
account controls visibility. Find its action via tool discovery — e.g. search
messages/users/channels, read another channel/thread/file, or read a user profile. See
`references/messages.md` for availability and the no-silent-substitution rule.

## Attachments the user sent you
Files/images the user attaches to their message are downloaded into this folder's `uploads/`
subfolder and their paths are given to you. Open them with the **Read** tool (images render
visually) — you don't need any Slack tool for attachments on the triggering message.

History/thread reads show that a file existed and identify it, but do not download historical files
or expose private URLs. The triggering-message pipeline performs the canonical recovery/download.

Native Slack tables pasted into the triggering message are supplied directly in the prompt as
structured JSON rows (for both `table` and `data_table` blocks). Read those rows as part of the
user's message; no file or Slack read tool is needed. Channel/thread history reads include the same
normalized table content.
