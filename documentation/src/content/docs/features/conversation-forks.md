---
title: Branch a conversation
description: Fork a completed Claude or Codex session into a new Slack thread.
---

A conversation fork creates another thread from an eligible completed engine session. It is useful when you want to explore an alternative without replacing the source thread's history.

## Create a branch

Inside the source Slack thread, send:

```text
@ChannelGate /fork Explore an alternative using a queue-based import worker.
```

ChannelGate uses the selected engine's native fork command, creates a new top-level Slack message linking to the source, posts the new request in that thread, and runs it with a distinct child session ID. The source thread receives a backlink.

The source retains its own session ID and history. Engine, model, effort, and thread Clean pins carry into the branch. Subsequent requests in either thread continue their respective sessions.

## Meet the admission rules

The source must be a completed Claude or Codex **container** session. An active run must finish or be stopped before it is safe to fork. Direct-host `/sudo` sessions and source-host sessions are refused by this workflow. You must remain authorized in the conversation.

Forking is a Slack thread workflow; do not assume it is available on the Beta Teams or Google Chat surfaces.

## Understand the shared workspace

A new session does **not** duplicate the project's files, persistent memory, connected accounts, or container. Both threads still use the conversation workspace. If both branches will edit a Git repository, request separate Git worktrees and distinct branches for the two implementation paths.

```text
Use a separate Git worktree for this experiment and leave the source
branch's uncommitted files untouched.
```

Starting a new blank thread provides a fresh history instead. Use [session adoption](/docs/features/session-recovery) when the history already exists in an eligible local CLI session.

Related: [threads and sessions](/docs/features/threads-and-sessions), [shared workspace conflicts](/docs/features/shared-folder-conflicts), and [context and compaction](/docs/features/context-and-compaction).
