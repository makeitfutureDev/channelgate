---
title: Chat commands
description: Find the controls for workspace settings, thread sessions, models, queues, and status.
---

Chat controls let you manage an agent conversation without describing every change in a prompt. In Slack, commands can be native slash commands or text typed inside an existing thread. Start with `/help` for the commands supported by your installed version.

## Common controls

| Control | Use |
| --- | --- |
| `/menu` | Open the conversation's Files, Variables, and Settings controls. |
| `/model` | Choose the supported engine, model, and effort using the scope picker. |
| `/context` | Inspect the latest context usage recorded for the thread. |
| `/clear` | Clear the thread's engine session and start fresh on its next turn. |
| `/resume` | Show a terminal resume command, or adopt an eligible local session with an argument. |
| `/fork <task>` | Create a new Slack thread from an eligible completed Claude or Codex container session. |
| `/compact` | Compact a supported Claude session; Codex does not support this control. |
| `/pending` | List your conversations that are waiting for a response. |
| `/next <task>` | Queue a task behind the current work. |
| `stop` | Stop active work in the thread, subject to control authorization. |

Use Slack's native `/status` command for daemon-side activity. A message such as “What is the status?” asks the agent about its work instead.

## Use the correct scope

Type a thread-specific command as a reply in that thread. Mention gating still applies where the chat surface requires it. By default, model changes in a channel require administrator authority. The gateway administrator can allow all authorized channel users through the model-change policy; the picker explains the available scope.

Clearing a session does not delete shared files, memory, or standing instructions. Forking duplicates eligible session history into a new thread; the conversation's working folder remains shared.

## Administrator controls

`/sudo` explicitly selects direct-host execution for an administrator-only thread. `/update` starts the supported administrator update flow. Their availability does not grant an ordinary user administrator authority.

The old `/engine`, `/effort`, and `/files` controls have been replaced by `/model` and the file explorer controls. Commands and rich controls can differ on Microsoft Teams and Google Chat; consult the [platform reference](/docs/platforms).

## Related guides

- [Models and effort](/docs/features/models-and-effort)
- [Resume and recovery](/docs/features/session-recovery)
- [Steer, queue, and stop](/docs/features/collaboration-and-steering)
