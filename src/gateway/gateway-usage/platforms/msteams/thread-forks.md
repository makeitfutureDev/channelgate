# Fork a Teams channel discussion

When someone asks to split topics into their own threads, call `propose_thread_forks` with
the exact child titles and prompts. The source must be a Teams channel thread with a completed
Claude or Codex container session. A person can start one fork by typing `/fork <request>`.
Personal and group chats explain the channel requirement.

The tool accepts one to ten forks within the card preview limit. On a pending result, tell the
requester that the proposal awaits their approval and end the turn. The requester or a gateway
admin can approve the batch. The gateway waits for the source turn, creates new top-level
channel messages and starts the child sessions as the requester. It posts the links and any
per-child failure in the source thread.
