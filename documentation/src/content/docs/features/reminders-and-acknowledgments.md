---
title: Reminders and acknowledgments
description: Post reminders without an agent run, and follow up until someone acknowledges them.
---

A reminder posts the saved message directly. Use it when the job is to notify people rather than ask an agent to investigate something. Reminder delivery does not start an engine session and has no engine token cost.

## Create a reminder

Ask in the conversation: “Remind us in two hours to check the deployment. Require a check mark acknowledgment.” The agent creates a schedule with `kind: "reminder"`, `in_minutes: 120`, and `ack: true`. A normal scheduled task defaults to `kind: "task"`; state that you want a direct reminder.

Recurring reminders use a five-field cron evaluated in the gateway's local timezone. One-time reminders accept a delay or date. The result includes the schedule ID and time; check the named timezone.

## Acknowledge and escalate

With acknowledgment enabled, a ✅ on the original reminder or an escalation message closes the pending chain. If nobody acknowledges, the default chain posts another notice after **120 minutes**, then sends a DM to the creator **60 minutes later** and closes. An administrator can edit reminders and acknowledgment behavior in **Automations**. Pending chains are stored in SQLite and survive a daemon restart.

By default the reminder notifies the channel. Personal or silent notification must be requested explicitly. A reminder without `ack: true` has no acknowledgment chain.

## Authority and limits

Any authorized participant can create or remove this conversation's schedules. Creating a reminder does not grant new permissions or cross-conversation access. The default ceiling is **20 enabled schedules per conversation**; recurring crons must meet the default **60-minute** minimum interval. Administrators set these in **Settings → Agent defaults → Schedules & nudges**.

Native check mark handling is a Slack workflow. Do not assume the same interactive acknowledgment controls on every Beta chat platform.

## Related guides

- [Schedules](/docs/features/schedules)
- [Automation delivery](/docs/features/automation-delivery)
- [Automation controls](/docs/controls/automation)
