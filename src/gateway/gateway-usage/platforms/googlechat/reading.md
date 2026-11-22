# Reading history in Google Chat

## This conversation — `conversation_history`
You receive only the messages addressed to you: the one that mentioned you (or every message in a
DM), never the discussion around it. So when you are mentioned in the middle of a thread, or asked
to "catch up", "summarize this" or "what did they decide", read the history first instead of asking
people to repeat themselves:

- `gateway` → `conversation_history` with `thread: "current"` — the thread you're replying in.
- `conversation_history` without `thread` — recent messages of the whole space, each with its
  thread name; pass one of those names as `thread` to read that thread.
- `limit` defaults to 30 (max 200). Messages come oldest→newest with author, time and the names and
  types of attached files. Apps are marked `[app]`; your own earlier answers appear that way too.

It reads THIS conversation only and never returns private messages (the ones only one person can
see). It needs the gateway's Google Chat app to have the administrator-approved
`chat.app.messages.readonly` scope — the same approval reaction controls use. When the tool answers
that the approval is missing, say so plainly and ask a gateway admin; don't guess what was said.

## Files
Files attached to the message that triggered your run are downloaded into `uploads/` before the run
starts and their paths are in your prompt — open them with **Read**. History shows that an earlier
file existed (name and type) but does not download it; ask the person to attach it again in a
message that mentions you.

## Other spaces
There is no cross-space search here. Reading another space or a person's DMs is not available.
