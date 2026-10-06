---
title: Resume and recovery
description: Continue stopped work, adopt an eligible local agent session, and understand recovery after interruption.
---

A thread's session keeps the agent's task history available for the next message. You can continue stopped work or connect an eligible local Claude or Codex session to a Slack thread without treating a different workspace as the same conversation.

## Continue a stopped task

Read the last response and inspect any files that were already written. Then send a concrete continuation:

> Continue from the last completed step. Check what is already in the workspace before repeating any writes.

Stopping a process does not undo work it completed. A continuation uses the thread's available session and workspace; it is not a rollback.

## Open the session in a terminal

1. Send `/resume` in the thread after an engine session exists.
2. Copy the command returned for that thread's engine and runtime.
3. Run it in the eligible environment using your authorized access.

A session created inside a container is stored in that container's engine home. A bare command against a different host home cannot find that history. Use the command the gateway provides rather than constructing one from a session ID alone.

## Adopt a local session

Send `/resume <command or session id>` in the destination thread. Adoption checks the engine and the session's working directory. The eligible session must belong to this conversation's workspace. Stop a running turn before replacing its session.

A Lean thread cannot adopt an ordinary session with tools and connector context that its own runtime excludes. The gateway asks you to turn off the thread's clean selection first when that is required.

## Understand automatic recovery

The gateway keeps durable run records and can recover eligible interactive work after a restart. Certain recoverable process deaths receive a bounded retry or continuation. Authentication failures, unavailable containers, and explicit stops need their own remedy; recovery is not an unlimited retry loop.

If a task involved an external write, verify the target state before repeating it. Use [Activity](/docs/features/usage-and-costs) and the thread's messages to understand what completed.

## Related guides

- [Threads and sessions](/docs/features/threads-and-sessions)
- [Direct-host sudo threads](/docs/features/sudo-threads)
- [SSH access](/docs/features/ssh-access)
