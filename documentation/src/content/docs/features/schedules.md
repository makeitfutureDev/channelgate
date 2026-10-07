---
title: Schedules and reminders
description: Run recurring tasks or send one-time reminders with explicit timing, delivery, and notification settings.
---

Schedules run work later in the same conversation, using its workspace and permissions. Use an agent task for research, checks, or summaries; use a plain reminder when you only need a message and no model call.

## Create a schedule from chat

Describe the timing and task in the intended channel:

```text
Every weekday at 09:00, summarize newly opened issues.
Use one thread per day and do not mention the channel.
```

The assistant creates the schedule and reports its ID, timezone, and next run. Times use the **gateway's local timezone**, which can differ from your laptop or the container's UTC clock. Check the reported next run before relying on it.

A plain reminder can be phrased as:

```text
In two hours, remind us to check the deployment. Just post a reminder;
do not run an agent, and require a checkmark acknowledgement.
```

One-time schedules disappear after their run. Recurring tasks support cron timing and fixed intervals of 1–365 days.

## Edit and inspect

Open **Automations** in the admin website to edit title, enabled state, timing, prompt, notifications, and delivery. In Slack, **Settings → Automations** shows work belonging to the current conversation; ask the assistant to list or delete a schedule by its ID.

Ask the assistant to change a task's visibility, result filtering, failure notifications or delivery with `update_schedule`. Use `get_schedule_runs` to inspect this conversation's run history, including completed one-time and deleted schedules. Its engine, task and delivery outcomes are separate; quiet delivery does not erase history. See [Automation controls](/docs/controls/automation) for exact arguments and [Automation delivery](/docs/features/automation-delivery) for quiet checks and fixed-thread reports.

The default minimum recurring interval is **60 minutes**, and the default ceiling is **20 enabled schedules per channel**. Administrators can adjust both in gateway settings.

## Delivery and notifications

By default, a scheduled task announces its run in the conversation and replies beneath that announcement; notification defaults to the channel. Explicitly request no mention or a particular person when that is preferable.

Optional daily-thread delivery groups recurring results into one thread per gateway-local day. Direct-channel delivery posts the result at top level. Match-based delivery can privately notify the creator only when a specified result prefix occurs, then stop the schedule.

Acknowledgement reminders close when someone reacts ✅. Without acknowledgement, the default escalation is a second notice after 120 minutes and a creator DM after 60 more minutes. Scheduled agent runs consume provider tokens and applicable license messages; plain reminders do not run a model.

## Related guides

- [Notifications and automation](/docs/configuration/notifications-and-automation)
- [Background jobs](/docs/features/background-jobs)
- [Usage and costs](/docs/features/usage-and-costs)
- [Licensing](/docs/features/licensing)

- [Reminders and acknowledgments](/docs/features/reminders-and-acknowledgments)
- [Conditional monitoring](/docs/features/conditional-monitoring)
- [Automation delivery](/docs/features/automation-delivery)
