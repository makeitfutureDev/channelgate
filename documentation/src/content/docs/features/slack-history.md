---
title: Read Slack history and earlier attachments
description: Catch up on the current conversation, inspect a thread, and retrieve a previously shared file.
---

The gateway bot can read recent messages and thread replies in the Slack conversation where the request is running. These tools need no personal Composio account and cannot search arbitrary channels.

## Catch up on a conversation

```text
@ChannelGate Summarize recent decisions in this channel. Inspect the relevant
threads and link each action item to its source message.
```

`slack_channel_history` defaults to 30 messages and supports a maximum of 100. It returns messages oldest first with author, timestamp, thread information, and safe attachment metadata. It is a bounded catch-up view, not a full workspace archive.

For a specific thread, `slack_thread_replies` accepts its parent timestamp and defaults to 50 replies, with a maximum of 200. The current thread already supplies ordinary conversation context; an additional read is useful when checking a particular earlier message or attachment.

## Retrieve an earlier file

History includes file ID, name, MIME type, and size without exposing private download URLs. The agent can pass a file ID to `slack_download_file` to fetch a supported attachment into the current thread's uploads folder.

```text
Download the recording from the earlier message in this channel and
compare its walkthrough with the implementation in our workspace.
```

Slack must confirm that the file is shared in this conversation. Files over 500 MB are refused. An already downloaded file can be reused. A missing or inaccessible file must be reported; metadata alone is not evidence that the contents were inspected.

## Search beyond this channel

Cross-channel search or broader Slack actions use the selected connected Slack account, such as an explicitly chosen Composio identity. That route has its own service permissions and account ownership. The bot's membership here does not establish access elsewhere.

Related: [Slack control reference](/docs/controls/slack), [connected accounts](/docs/features/connected-accounts), [attachments](/docs/features/attachments-and-voice), and [video analysis](/docs/features/video-understanding).
