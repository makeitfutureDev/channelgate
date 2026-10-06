---
title: Notifications and automation
description: Configure schedule limits, reminder preferences, memory notices, and unattended-run delivery.
---

Schedules, quiet-thread nudges, pending-response digests, and memory notices serve different purposes. Configure each deliberately: a reminder preference does not schedule an agent task, and enabling automatic tool approval does not create recurring work.

## Schedule guardrails

Open **Settings → Agent defaults → Schedules & nudges**.

| Setting | Default | Meaning |
| --- | --- | --- |
| Minimum schedule interval | 60 minutes | Recurring schedules firing more often are refused |
| Max enabled schedules per channel | 20 | Caps enabled schedule records in one conversation |
| No-response reminder | 24 hours | Delay before an opted-in user's quiet thread receives one nudge |
| New users start with quiet-thread reminders ON | Off | Initial preference for newly seen users |

Save the limits, then create a schedule by asking the bot in the intended conversation. For example:

```text
Every weekday at 09:00 server time, summarize open issues for this project.
Post the result in this conversation.
```

Inspect the resulting schedule under **Automations**. Check its conversation, prompt, timing, delivery mode, and enabled status before relying on it. Cron scheduling uses the server's local timezone; ask for an explicit timezone when describing requirements and verify the saved result.

## Personal reminder preferences

A user can change quiet-thread reminders in Slack App Home. Administrators can also edit **Users → [person] → Quiet-thread reminders**. Changing the organization default affects newly seen users. **Apply to all…** overwrites existing personal choices with the selected default and cannot be undone.

Pending-response digests are a separate organization feature. Their supported settings are `followupRemindersEnabled`, `followupDigestHours`, `followupTimeZone`, and `followupDoneReactions`. Defaults are enabled, hours `[8, 14]`, timezone `Europe/Bucharest`, and the `white_check_mark` / `heavy_check_mark` reactions. These are advanced settings rather than a visible digest form on the current Settings page; operators can maintain them through the settings API or settings file.

Digests identify participating users' threads awaiting their reply. A configured done reaction clears a thread from follow-ups. They are not a general feed of every message in the organization.

## Memory and delivery notices

Under **Agent defaults → Agent instructions**, **Memory review model** and **Background memory review** control the reviewer. The interval defaults to five turns; `0` disables background review. When review is enabled, recognized corrections and decisions can trigger it before that interval. **Post 🧠 Memory updated** defaults on and makes successful reviewer saves visible.

**Public URL** and **Approval links** under **Connection** enable browser decisions on surfaces without native approval buttons. **How a failover happens → Ask** applies to live Slack turns; unattended schedules, background runs, and API work use automatic recovery when eligible.

Routine saved limits and preferences apply without restarting. Hand-editing startup configuration or service environment may require a restart; inspect the resulting schedule and recipient before testing unattended delivery.

See [Schedules](/docs/features/schedules), [Background jobs](/docs/features/background-jobs), [Approvals](/docs/features/approvals), and [Memory](/docs/features/memory).
