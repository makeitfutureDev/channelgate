---
title: Threads and sessions
description: Continue a task, start fresh, or hand off an eligible engine session.
---

A chat thread maps to an engine session. Replies can resume the agent's earlier reasoning and tool history without mixing them with another thread's session. Files and persistent memory still belong to the conversation.

## Continue or start fresh

Reply in the same thread when refining a task:

```text
@ChannelGate Draft a migration plan for this project.
@ChannelGate Add a rollback step to the plan.
```

Start another thread when the next task needs a separate conversation history. Use the typed in-thread `/clear` control to discard the current session and make the next request start fresh. Clearing a session does not delete project files or channel memory. It also stops active work in that thread so the old run cannot restore the cleared session afterward.

Claude supports `/compact` to reduce accumulated context. Codex does not support that command; use `/clear` or a new thread when you need a fresh Codex session.

## Inspect and choose the session

Open **Settings → Resume Session** or use `/resume` for the current thread's handoff information. An eligible local session can be adopted into a Slack thread only when its working directory belongs to that channel workspace. Session IDs are engine-specific: a Claude session cannot be resumed directly by Codex.

Open **Settings → General** to inspect both the channel defaults and the thread's own engine, model, and effort selections. An explicit thread selection takes precedence. An existing session can keep the engine that created it even after a default changes; the settings view makes that state visible.

## Branch or manage accumulated context

Use [conversation forks](/docs/features/conversation-forks) to branch an eligible completed Claude or Codex container session into another Slack thread. The source history remains intact, while both threads still share the workspace.

Use [context and compaction](/docs/features/context-and-compaction) to inspect the last turn’s context estimate or compact an eligible Claude session. [Thread Clean](/docs/features/lean-context) deliberately starts a bare context boundary and has its own session reset rules.

## Know what carries forward

Changing engines creates an engine-appropriate session rather than reusing the other engine's ID. ChannelGate can replay relevant chat history, but this is not a complete transfer of private engine state. Stop a long turn before making a deliberate handoff.

Related: [models and effort](/docs/features/models-and-effort), [collaboration and steering](/docs/features/collaboration-and-steering), and [memory](/docs/features/memory).
