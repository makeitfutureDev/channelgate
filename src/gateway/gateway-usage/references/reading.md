# Reading history & searching Slack

## This channel — always available (gateway, bot token)
For "catch me up" / "summarize this channel" / "what did the thread say":

- `slack_channel_history` — recent messages from THIS channel (the one you're replying in).
  `limit` defaults to 30 (max 100). Returns messages oldest→newest with author + timestamp;
  threaded messages show their `thread_ts`. Shared files include safe id/name/MIME/size metadata.
- `slack_thread_replies` — all replies in a thread in THIS channel. Pass the `thread_ts` (the
  parent message's ts, e.g. from `slack_channel_history`). `limit` defaults to 50 (max 200).
  Shared files include the same safe metadata; private Slack file URLs are never returned.

- `slack_download_file` — fetch a file that was shared in THIS channel into this thread's
  `uploads/` folder and get its LOCAL path back. Use it when a file you can see in history (the
  thread's first message, a file posted before you were mentioned, one refused earlier) was never
  delivered to your run — "download it yourself", "try again with the video". Pass the `file_id`
  (from the metadata above, or a pasted Slack file link). Files up to 500 MB; a file already in the
  folder is reused without a second download. A file not shared in this channel is refused. Read
  the returned path with your Read tool (images render visually; for video, follow the built-in
  `references/video-understanding.md` workflow). Never ask the person to re-upload a file that is already in the
  thread — download it.

These are **scoped to the current channel only** — they can't read other channels. The thread
you're actively replying in is already in your context, so you usually only need these to look
further back or at a different thread in this channel. Files attached to the message that
triggered your run are downloaded for you before the run starts (their paths are in your prompt);
a thread's FIRST-message attachment is retried automatically on a later reply while it is still
missing from the folder.

## Other channels / workspace search — select the account
To search or read **beyond this channel**, choose the Composio account per `SKILL.md` → “Tool
identities”: `composio-user` for “my Slack” (the requester's), `composio-agent` for “your Slack”
(your own); no pronoun → the only one with Slack connected, else ask. The selected connected Slack
account controls visibility. Find its action via tool discovery — e.g. search
messages/users/channels, read another channel/thread/file, or read a user profile. See
`references/messages.md` for availability and the no-silent-substitution rule.

### Narrow reads stay narrow
When the user asks for one exact message and excludes unrelated messages, constrain retrieval,
not just the final answer. Start with the unique quoted text and the known channel name. If only
a channel ID is supplied, resolve its name with channel metadata or use an exact message link;
do not assume a search modifier interprets a channel ID like a channel name.

An empty result can reflect query syntax or indexing delay. Retry the same narrow query after
checking its syntax, or report that the exact message could not be located. Do not replace it
with channel history, a broad time window, or a workspace-wide catch-up to find the missing item.
A general skill's history fallback does not override the user's explicit exclusion. Ask for a
message link or a wider scope only when the permitted lookup cannot proceed.

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
