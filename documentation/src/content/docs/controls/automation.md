---
title: Automation controls
description: Create, inspect, and delete conversation schedules with exact timing and delivery arguments.
---

Scheduling is available to authorized conversation participants. These tools are inspectable and reversible, and do not add a separate persistent-control approval click. Execution still checks the creator, conversation access, runtime, and license. Schedules are bound to this conversation.

## create_schedule

**Required:** `prompt` (string). Also provide a valid timing choice below. **Authority:** authorized participant. The schedule executes as its creator; an HTTP API principal has no implicit personal identity.

| Argument | Required or optional | Accepted value/default |
| --- | --- | --- |
| `cron` | Timing choice | Five fields, gateway-local timezone |
| `interval_days` | Alternative timing | Integer 1–365; tasks only |
| `in_minutes` | Alternative timing | Positive delay for one-time execution |
| `run_at` | Alternative timing | Parseable ISO datetime; one-time execution |
| `description` | Optional | Announcement/title; otherwise prompt |
| `notify` | Optional | `channel` (default), `user`, `none` |
| `notify_user` | Optional | User ID; defaults to creator for user notification outside HTTP API runs |
| `delivery` | Optional | `standard` (default), `daily-thread`, `channel`, `dm-on-match` |
| `match_prefix` | Conditional | Required nonempty for `dm-on-match` |
| `kind` | Optional | `task` (default), `reminder` |
| `ack` | Optional | False by default; applies only to reminders |
| `ack_escalate_minutes` | Optional | Reminder escalation delay; default 120 |
| `ack_dm_minutes` | Optional | Delay after escalation before creator DM; default 60 |

Use **one timing form**. `interval_days` cannot combine with cron, one-time timing, reminder kind, or daily-thread delivery. When both one-time fields are present, a positive `in_minutes` is used first; provide only the intended field. Invalid/past dates are refused.

Recurring cron must meet the configured minimum interval (**60 minutes by default**). The conversation has a default ceiling of **20 enabled schedules**. Daily-thread requires recurring tasks. DM-on-match requires a task, creator, and prefix; routine results and errors remain in status, while the first matching answer is privately delivered and disables the schedule.

A reminder posts its saved text without starting an engine. With acknowledgment enabled, a ✅ closes the escalation chain. A task runs an engine with the current resolved creator/conversation settings.

The result returns an ID and next time/notification choice. It is confirmation of creation, not proof of task completion. Quote the gateway's named timezone rather than relabeling it as container UTC.

Example recurring task:

```json
{"cron":"0 9 * * 1-5","prompt":"Summarize the release status using the linked sources","description":"Weekday release status"}
```

Example direct reminder:

```json
{"in_minutes":120,"prompt":"Check the deployment","kind":"reminder","ack":true}
```

## list_schedules

**Arguments:** none. **Authority:** authorized participant.

Lists this conversation's schedules, IDs, enabled state, timing, descriptions, notification, and applicable delivery notes. It does not expose another conversation or constitute a full execution log. The authenticated **Automations** page provides richer operational status.

Example arguments:

```json
{}
```

## delete_schedule

**Required:** `id` (string). **Optional:** none. **Authority:** authorized participant.

Deletes only a schedule belonging to this conversation. A missing or foreign ID returns not found. Deleting a schedule is not a rollback of external actions a prior run already performed.

Example arguments:

```json
{"id":"schedule-id"}
```

## Related guides

- [Schedules](/docs/features/schedules)
- [Automation delivery](/docs/features/automation-delivery)
- [Conditional monitoring](/docs/features/conditional-monitoring)
- [Reminders and acknowledgments](/docs/features/reminders-and-acknowledgments)
