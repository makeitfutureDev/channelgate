---
title: Background jobs and agents
description: Delegate longer work to the gateway and receive its result in the originating conversation.
---

Background work continues after the assistant's foreground reply ends. The gateway owns the job and delivers its result back into the originating thread. This is useful for a long test suite, transcription, research, or a build you do not want to hold open as a chat turn.

## Delegate an agent task

Give a complete brief, including inputs, output, and boundaries:

```text
Run a background agent to review the authentication code in this workspace.
Write a report with file references and proposed fixes; make no code changes.
Post the completed report in this thread.
```

A background agent starts a separate engine session in the same conversation workspace. It follows the conversation's permissions and can be used in any mode. It receives a self-contained task rather than the foreground thread's entire context. Both Claude and Codex are supported.

The launch returns a job ID. The report arrives when the agent finishes; you do not need to keep sending “continue.” A background agent may run for up to a week, subject to its runtime and operational limits.

## Delegate a shell command

A background shell job is appropriate when the command itself needs to outlive the turn, such as a long build. It executes in the conversation's resolved runtime, outside the engine's own tool approval loop.

Shell jobs require Auto, or Admin mode with a current admin author. **Auto still requires an admin to approve the exact command** on the durable Run it card. Admin-authored jobs in Admin mode can start directly. Prefer a confined background agent when the work benefits from ordinary engine permission handling.

## Track completion and recovery

Ask the assistant for the job's status or use `/status` in Slack to inspect running work. Keep the returned ID when discussing an individual job. A shell completion can resume the parent assistant to review output; an agent report is delivered directly.

Job records persist. A surviving detached shell process can be recovered after a restart; an interrupted background agent is reported as interrupted rather than replayed as if its tool effects were known. Persistent records do not guarantee arbitrary external commands survive service teardown.

## Related guides

- [Schedules](/docs/features/schedules)
- [Permissions](/docs/features/permissions)
- [Approvals](/docs/features/approvals)
- [Usage and costs](/docs/features/usage-and-costs)
