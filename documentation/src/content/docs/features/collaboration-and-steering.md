---
title: Collaboration and steering
description: Stop, redirect, or queue work while the agent is running.
---

Progress updates show tool activity, elapsed time, and queue status while a turn runs. When another request arrives in a busy Slack thread, ChannelGate offers a choice instead of silently mixing instructions.

## Choose how a follow-up should run

The busy-thread card offers **Steer**, **Add to Queue**, and **Cancel**:

- **Steer** interrupts or redirects the active task with the new request. Warm Claude sessions support live steering; other runtime states may need interruption and a new turn.
- **Add to Queue** runs the new request after the active work finishes.
- **Cancel** discards the new request. It does not cancel the work already underway.

If another person owns the active run, steering queues your message rather than interrupting their work. If the active run changed before you clicked, the message is also queued safely. Only the sender of that follow-up can resolve its Slack card. A pending choice expires after ten minutes. Administrators can also resolve pending decisions through the admin interface.

## Queue a specific next task

Use the typed `/next` shortcut with an instruction:

```text
@ChannelGate /next After the implementation finishes, summarize the changed files.
```

A bare `/next` displays usage guidance. Attachments belonging to the queued request travel with that request, so the next task can use its own input files.

## Stop the correct scope

An in-thread stop control targets that thread. The Slack `/stop` slash command stops all active runs in the channel or DM because Slack does not include thread information in that command. Supported stop reactions and stop messages use the same interruption path. These controls recheck access because stopping a run can affect another person's work.

Stopping cannot undo files already written or external actions already completed. Review the workspace and connected system before retrying an interrupted task. The stopped reply provides session controls so you can continue with a clear next request.

Multiple threads can run independently but share conversation files. Coordinate edits or use Git worktrees for simultaneous coding. Related: [threads and sessions](/docs/features/threads-and-sessions), [shared workspaces](/docs/features/shared-workspaces), and [access and users](/docs/configuration/access-and-users).
