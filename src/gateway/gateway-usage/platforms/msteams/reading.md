# Reading history in Microsoft Teams

## This conversation — `conversation_history`
You receive only the messages addressed to you: the one that mentioned you (or every message in a
personal chat), never the discussion around it. When you are mentioned in the middle of a channel
thread, or asked to "catch up", "summarize this" or "what did they decide", read the history first
instead of asking people to repeat themselves:

- `gateway` → `conversation_history` with `thread: "current"` — the channel thread you're replying in.
- `conversation_history` without `thread` — recent messages of the whole channel (each with its
  thread id; pass one as `thread` to read that thread) or of the group chat.
- `limit` defaults to 30 (max 200). Messages come oldest→newest with author, time and attached file
  names. Apps are marked `[app]`; your own earlier answers appear that way too.

It reads THIS conversation only, through Microsoft Graph. It exists only where the administrator
turned on Teams all-message events (the same Graph permissions), and only for channels and group
chats the gateway has seen since; personal chats have no readable history. When the tool is
missing or answers that history can't be read, say so plainly and ask a gateway admin; don't guess
what was said.

## Files
Files attached to the message that triggered your run are downloaded into `uploads/` before the run
starts and their paths are in your prompt — open them with **Read**. A file posted on an EARLIER
message shows in `conversation_history` as `[file: name] (message <id>, thread <id>)`. When the
administrator enabled Teams file access, fetch it with `gateway` → `conversation_download_file`
(`message`, the `thread` shown with it, and `file` when the message has several); you get a local
path back. Only canonical SharePoint files inside the drives the administrator allowed can be
downloaded — on a refusal, relay the reason verbatim and ask the person to attach the file again in
a message that mentions you.

## Other conversations
There is no cross-conversation search here. Reading another channel, chat or a person's messages is
not available.
